import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validatePublicationReleaseManifest } from "../infrastructure/publication/release-contract.ts";
import { parseArtifactZip } from "./artifact-zip.ts";
import { parsePublicationTar } from "./publication-tar.ts";
import { inspectPagesActionTar } from "./supported-pages-release.ts";
import { validatePreapprovalSummary } from "./supported-pages-control.ts";
import { verifyPublishedJobLogEvidence, type PublishedJobLogEvidence } from "./published-incident-job-logs.ts";
import { verifyPublishedDecision, type PublishedIncident, type VerifiedPublishedDecision } from "./published-incident.ts";

type Binding = PublishedIncident["evidence"]["artifacts"]["candidate"];
const REPOSITORY = "CrunchyBrunch/lionlog";

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedUtc(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Artifact expiry is invalid.");
  return new Date(value).toISOString();
}

export async function readBoundArtifact(
  binding: Binding,
  metadata: Record<string, unknown>,
  token: string,
  fetchImpl: typeof fetch,
  now: Date,
): Promise<Map<string, Buffer>> {
  const workflow = metadata.workflow_run as Record<string, unknown> | undefined;
  if (!Number.isFinite(now.getTime()) || token.length === 0 || metadata.id !== binding.id
    || metadata.name !== binding.name || metadata.digest !== binding.wrapperDigest
    || metadata.expired !== false || normalizedUtc(metadata.expires_at) !== binding.expiresAt
    || Date.parse(binding.expiresAt) <= now.getTime()
    || workflow?.id !== binding.producerRunId || workflow?.head_sha !== binding.headSha
    || workflow?.head_repository_id !== 1346360244 || workflow?.head_branch !== "main") {
    throw new Error("Published incident artifact metadata is missing, expired or mismatched.");
  }
  const url = `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${binding.id}/zip`;
  const response = await fetchImpl(url, {
    redirect: "follow", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Published incident artifact download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (`sha256:${sha(bytes)}` !== binding.wrapperDigest) throw new Error("Published incident artifact wrapper digest differs.");
  const entries = parseArtifactZip(bytes, binding.entries.map((item) => item.path));
  const result = new Map<string, Buffer>();
  for (const entry of entries) {
    const expected = binding.entries.find((item) => item.path === entry.path);
    if (!expected || entry.data.length !== expected.bytes || sha(entry.data) !== expected.sha256) {
      throw new Error("Published incident artifact member bytes differ.");
    }
    result.set(entry.path, entry.data);
  }
  return result;
}

type Inventory = Array<{ path: string; bytes: number; sha256: string }>;

function exactKeys(value: unknown, keys: string[]): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

export function verifyParsedPublishedArtifacts(
  incident: PublishedIncident,
  parsed: { manifest: unknown; preapproval: unknown; receipt: unknown },
  candidateInventory: Inventory,
  stagedInventory: Inventory,
): void {
  const manifest = validatePublicationReleaseManifest(parsed.manifest);
  // The immutable historical artifact uses the canonical millisecond spelling.
  const rawPreapproval = parsed.preapproval as { authorization?: { approvalExpiresAt?: unknown } };
  if (rawPreapproval?.authorization?.approvalExpiresAt !== "2026-10-01T22:00:00.000Z") {
    throw new Error("Published incident historical approval expiry differs.");
  }
  const preapproval = validatePreapprovalSummary(parsed.preapproval);
  const receipt = parsed.receipt as Record<string, unknown>;
  if (!exactKeys(receipt, ["receiptVersion", "recordedAt", "operation", "workflow", "candidate", "ci", "release", "staged", "rollbackSource", "official", "public", "knownGood", "unresolved"])
    || receipt.receiptVersion !== "lionlog.pages-flat-receipt.v1" || receipt.operation !== "promote"
    || receipt.rollbackSource !== null || receipt.knownGood !== false || receipt.unresolved !== true
    || !exactKeys(receipt.official, ["submissionStarted", "result", "pageUrl", "deploymentId"])
    || !exactKeys(receipt.public, ["markerVerified", "inventoryVerified", "browserVerified"])) {
    throw new Error("Published incident original flat receipt flags or shape differ.");
  }
  const official = receipt.official as Record<string, unknown>;
  const publicChecks = receipt.public as Record<string, unknown>;
  if (official.submissionStarted !== true || official.result !== "success"
    || official.pageUrl !== incident.evidence.officialPages.targetUrl || official.deploymentId !== null
    || publicChecks.markerVerified !== true || publicChecks.inventoryVerified !== true
    || publicChecks.browserVerified !== false) throw new Error("Published incident original receipt outcome differs.");
  if (preapproval.operation !== "promote" || preapproval.rollbackReceipt !== null
    || preapproval.authorization.predecessorReleaseId !== "NONE_FIRST_PUBLICATION"
    || preapproval.authorization.approvalExpiresAt !== "2026-10-01T22:00:00.000Z"
    || manifest.releaseId !== incident.evidence.release.id || manifest.source.commitSha !== incident.workflowSha
    || manifest.source.workflowRunId !== incident.evidence.release.candidateProducerRunId
    || manifest.source.workflowRunAttempt !== 1
    || manifest.marker.sha256 !== "cbbb69b867c8d068f91364edb6a246eb1bb5aaeaff7108993c4577c562fa4cc4"
    || manifest.site.tarSha256 !== incident.evidence.artifacts.candidate.entries[1].sha256
    || preapproval.staged.tarSha256 !== incident.evidence.release.stagedTarSha256) {
    throw new Error("Published incident manifest or original authorization differs.");
  }
  for (const key of ["workflow", "candidate", "ci", "release", "staged"] as const) {
    if (!isDeepStrictEqual(receipt[key], preapproval[key])) throw new Error(`Published incident ${key} cross-reference differs.`);
  }
  if (preapproval.workflow.runId !== incident.runId || preapproval.workflow.runAttempt !== incident.runAttempt
    || preapproval.workflow.sha !== incident.workflowSha
    || preapproval.candidate.artifactId !== incident.evidence.artifacts.candidate.id
    || preapproval.candidate.artifactDigest !== incident.evidence.artifacts.candidate.wrapperDigest
    || preapproval.candidate.manifestSha256 !== incident.evidence.release.manifestSha256
    || preapproval.ci.runId !== incident.evidence.release.exactSourceCiRunId
    || preapproval.staged.artifactId !== incident.evidence.artifacts.staged.id
    || preapproval.staged.artifactDigest !== incident.evidence.artifacts.staged.wrapperDigest
    || preapproval.release.id !== incident.evidence.release.id) {
    throw new Error("Published incident parsed artifact identities differ.");
  }
  for (const inventory of [manifest.site.inventory, preapproval.site.inventory, candidateInventory, stagedInventory]) {
    if (!isDeepStrictEqual(inventory, incident.evidence.release.inventory)) throw new Error("Published incident tar inventory differs.");
  }
}

const API = `https://api.github.com/repos/${REPOSITORY}`;

async function githubJson(fetchImpl: typeof fetch, route: string, token?: string): Promise<unknown> {
  const response = await fetchImpl(`${API}${route}`, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok || response.redirected) throw new Error(`Published incident API evidence unavailable (${response.status}).`);
  return response.json();
}

export async function readPublishedJobLog(fetchImpl: typeof fetch, route: string, token: string): Promise<string> {
  if (!/^\/actions\/jobs\/[0-9]+\/logs$/.test(route) || token.length === 0) {
    throw new Error("Published incident job log route is invalid.");
  }
  const initial = await fetchImpl(`${API}${route}`, {
    redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
  });
  let response = initial;
  if (initial.status >= 300 && initial.status < 400) {
    const location = initial.headers.get("location");
    const target = location ? new URL(location) : null;
    if (!target || target.protocol !== "https:" || target.username || target.password
      || target.hostname === "api.github.com" || target.hash) {
      throw new Error("Published incident job log redirect is invalid.");
    }
    response = await fetchImpl(target, {
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
      headers: { accept: "text/plain" },
    });
  }
  if (!response.ok || response.redirected || !response.body) {
    throw new Error(`Published incident job log unavailable (${response.status}).`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) throw new Error("Published incident job log has invalid size.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size === 0) throw new Error("Published incident job log has invalid size.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

function exactUtcSeconds(value: unknown, expected: string): boolean {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
    && value.replace(/Z$/, ".000Z") === expected;
}

export interface PublishedResolution {
  evidenceDigest: string;
  runId: number;
  runAttempt: number;
  workflowSha: string;
  releaseId: string;
  receiptArtifactId: number;
  receiptArtifactDigest: string;
  logEvidence: PublishedJobLogEvidence;
  decision: VerifiedPublishedDecision;
}

export async function collectPublishedResolution(options: {
  record: PublishedIncident;
  token: string;
  artifactMetadata: unknown[];
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<{ resolution: PublishedResolution; receipt: Record<string, unknown> }> {
  const { record, token, artifactMetadata } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || !Array.isArray(artifactMetadata) || token.length === 0) {
    throw new Error("Published incident collection inputs are invalid.");
  }
  const bindings = record.evidence.artifacts;
  const contents = {} as Record<keyof typeof bindings, Map<string, Buffer>>;
  for (const kind of Object.keys(bindings) as Array<keyof typeof bindings>) {
    const matching = artifactMetadata.filter((value) => (value as { id?: unknown }).id === bindings[kind].id);
    if (matching.length !== 1) throw new Error(`Published incident ${kind} artifact is missing or duplicate.`);
    contents[kind] = await readBoundArtifact(bindings[kind], matching[0] as Record<string, unknown>, token, fetchImpl, now);
  }
  const parsed = {
    manifest: JSON.parse(contents.candidate.get("release-manifest.json")!.toString("utf8")),
    preapproval: JSON.parse(contents.preapproval.get("preapproval.json")!.toString("utf8")),
    receipt: JSON.parse(contents.receipt.get("pages-receipt.json")!.toString("utf8")),
  };
  const candidateInventory = parsePublicationTar(contents.candidate.get("site.tar")!).map((item) => ({
    path: item.path, bytes: item.data.length, sha256: sha(item.data),
  }));
  const stagedInventory = inspectPagesActionTar(contents.staged.get("artifact.tar")!);
  verifyParsedPublishedArtifacts(record, parsed, candidateInventory, stagedInventory);

  const [candidateRun, ciRun, pagesStatus, deployment, statuses, statusesNext, deployJob, verifyJob, deployLog, verifyLog, decision] = await Promise.all([
    githubJson(fetchImpl, `/actions/runs/${record.evidence.release.candidateProducerRunId}`, token),
    githubJson(fetchImpl, `/actions/runs/${record.evidence.release.exactSourceCiRunId}`, token),
    githubJson(fetchImpl, `/pages/deployments/${record.evidence.officialPages.deploymentId}`, token),
    githubJson(fetchImpl, `/deployments/${record.evidence.repositoryEnvironment.deploymentId}`),
    githubJson(fetchImpl, `/deployments/${record.evidence.repositoryEnvironment.deploymentId}/statuses?per_page=100&page=1`),
    githubJson(fetchImpl, `/deployments/${record.evidence.repositoryEnvironment.deploymentId}/statuses?per_page=100&page=2`),
    githubJson(fetchImpl, `/actions/jobs/${record.evidence.officialPages.sourceJobId}`, token),
    githubJson(fetchImpl, `/actions/jobs/${record.evidence.browserFailure.jobId}`, token),
    readPublishedJobLog(fetchImpl, `/actions/jobs/${record.evidence.officialPages.sourceJobId}/logs`, token),
    readPublishedJobLog(fetchImpl, `/actions/jobs/${record.evidence.browserFailure.jobId}/logs`, token),
    verifyPublishedDecision(record, fetchImpl),
  ]);
  const logEvidence = verifyExternalPublishedEvidence(record, {
    candidateRun, ciRun, pagesStatus, deployment, statuses, statusesNext, deployJob, verifyJob, deployLog, verifyLog,
  });
  return {
    resolution: {
      evidenceDigest: record.decision.evidenceDigest, runId: record.runId, runAttempt: record.runAttempt,
      workflowSha: record.workflowSha, releaseId: record.evidence.release.id,
      receiptArtifactId: bindings.receipt.id, receiptArtifactDigest: bindings.receipt.wrapperDigest,
      logEvidence, decision,
    },
    receipt: parsed.receipt,
  };
}

export function verifyExternalPublishedEvidence(record: PublishedIncident, value: {
  candidateRun: unknown; ciRun: unknown; pagesStatus: unknown; deployment: unknown; statuses: unknown;
  statusesNext: unknown; deployJob: unknown; verifyJob: unknown; deployLog: string; verifyLog: string;
}): PublishedJobLogEvidence {
  const source = record.evidence.release;
  for (const [run, id] of [[value.candidateRun, source.candidateProducerRunId], [value.ciRun, source.exactSourceCiRunId]] as const) {
    const item = run as Record<string, unknown>;
    if (item.id !== id || item.head_sha !== record.workflowSha || item.run_attempt !== 1
      || item.status !== "completed" || item.conclusion !== "success") {
      throw new Error("Published incident source producer or CI run differs.");
    }
  }
  const pages = value.pagesStatus as Record<string, unknown>;
  if (pages.status !== "succeed") throw new Error("Published incident official Pages deployment status differs.");
  const environment = value.deployment as Record<string, unknown>;
  const expected = record.evidence.repositoryEnvironment;
  if (environment.id !== expected.deploymentId || environment.task !== expected.task
    || environment.environment !== expected.environment || environment.sha !== expected.sha
    || environment.ref !== "main" || !exactUtcSeconds(environment.created_at, expected.createdAt)
    || environment.repository_url !== API) throw new Error("Published incident repository environment differs.");
  if (!Array.isArray(value.statuses) || value.statuses.length === 0 || value.statuses.length > 100
    || !Array.isArray(value.statusesNext) || value.statusesNext.length !== 0
    || new Set(value.statuses.map((item) => (item as { id?: unknown }).id)).size !== value.statuses.length) {
    throw new Error("Published incident environment statuses are incomplete.");
  }
  const success = value.statuses.filter((item) => (item as { id?: unknown }).id === expected.successStatusId);
  const status = success[0] as Record<string, unknown> | undefined;
  if (success.length !== 1 || (value.statuses[0] as { id?: unknown }).id !== expected.successStatusId
    || status?.state !== "success" || status.environment !== expected.environment
    || status.log_url !== expected.statusLogUrl || status.target_url !== expected.statusLogUrl
    || status.environment_url !== expected.targetUrl || !exactUtcSeconds(status.created_at, expected.successAt)
    || Date.parse(expected.successAt) < Date.parse(expected.createdAt)) {
    throw new Error("Published incident environment success status differs.");
  }
  return verifyPublishedJobLogEvidence(record, value);
}
