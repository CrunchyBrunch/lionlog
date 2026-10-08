import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { publicationReleaseMarkerSchema, publicationInventoryEntrySchema } from "../infrastructure/publication/release-contract.ts";
import reviewedGraph from "../infrastructure/publication/published-incident-graph.json" with { type: "json" };
import reviewedInventory from "../infrastructure/publication/published-incident-inventory.json" with { type: "json" };
import reviewedPublicInventory from "../infrastructure/publication/published-incident-public-inventory.json" with { type: "json" };

// This is reviewed policy for one historical attempt, not an effective resolution entry.
export const PUBLISHED_INCIDENT_RUN = 36900859358;
export const PUBLISHED_INCIDENT_SHA = "5be205a42930f69424d0854443b4fa4f35c237bd";
export const PUBLISHED_INCIDENT_RELEASE = "770748e0015df71d0b6a4fc8d7a72086c2432c328cc571214139253db783147e";
export const RECONCILIATION_PM_ACTOR_ID = 296610507;
export const DECISION_OBSERVATION_MAX_AGE_MS = 30 * 60_000;

const SHA = z.string().regex(/^[a-f0-9]{64}$/);
const DIGEST = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const GIT_SHA = z.string().regex(/^[a-f0-9]{40}$/);
const ID = z.number().int().positive().safe();
const UTC_MS = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => new Date(value).toISOString() === value);
const ACTION_TIME = z.literal("2026-10-01T17:45:47.4916331Z");
const TARGET_URL = "https://crunchybrunch.github.io/lionlog/";
const entry = z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative().safe(), sha256: SHA }).strict();
const artifact = z.object({
  id: ID, name: z.string().min(1), wrapperDigest: DIGEST, expiresAt: UTC_MS,
  producerRunId: ID, producerAttempt: z.literal(1), headSha: GIT_SHA,
  entries: z.array(entry).min(1).max(4),
}).strict();
const step = z.object({
  stepNumber: ID, stepName: z.string().min(1), stepStatus: z.literal("completed"),
  stepConclusion: z.enum(["success", "failure", "skipped"]),
}).strict();
const job = z.object({
  jobId: ID, runId: z.literal(PUBLISHED_INCIDENT_RUN), runAttempt: z.literal(1),
  headSha: z.literal(PUBLISHED_INCIDENT_SHA), jobName: z.string(), jobStatus: z.literal("completed"),
  jobConclusion: z.enum(["success", "failure"]), steps: z.array(step),
}).strict();
const graph = z.object({
  workflowId: z.literal(347992874), workflowPath: z.literal(".github/workflows/deploy-github-pages.yml"),
  event: z.literal("workflow_dispatch"), headBranch: z.literal("main"),
  status: z.literal("completed"), conclusion: z.literal("failure"), jobs: z.array(job).length(3),
}).strict();
const publicEntry = entry.extend({ status: z.literal(200) }).strict();

const schema = z.object({
  outcome: z.literal("resolved-published-browser-unverified"),
  evidenceVersion: z.literal("lionlog.pages-published-browser-incident.v1"),
  runId: z.literal(PUBLISHED_INCIDENT_RUN), runAttempt: z.literal(1), workflowSha: z.literal(PUBLISHED_INCIDENT_SHA),
  collectorEvidence: graph, checkedAt: UTC_MS,
  evidence: z.object({
    repository: z.object({ id: z.literal(1346360244), fullName: z.literal("CrunchyBrunch/lionlog") }).strict(),
    release: z.object({
      id: z.literal(PUBLISHED_INCIDENT_RELEASE), kind: z.literal("live"), sourceSha: z.literal(PUBLISHED_INCIDENT_SHA),
      candidateProducerRunId: z.literal(36860769514), candidateProducerAttempt: z.literal(1),
      exactSourceCiRunId: z.literal(36627487837),
      manifestSha256: z.literal("7d6aec0aa52660ce9eabe65745a179afba481692967b1706e073ac613061da99"),
      stagedTarSha256: z.literal("b8c6c724b41373d6c34da4f702082380b2b4a6822bd4529a48139d9103d2e2ff"),
      inventory: z.array(publicationInventoryEntrySchema).length(51),
    }).strict(),
    artifacts: z.object({ candidate: artifact, staged: artifact, preapproval: artifact, receipt: artifact }).strict(),
    officialPages: z.object({
      deploymentId: z.literal(PUBLISHED_INCIDENT_SHA), createdAt: ACTION_TIME, status: z.literal("succeed"),
      submittedArtifactId: z.literal(11181496634), pagesBuildVersion: z.literal(PUBLISHED_INCIDENT_SHA),
      targetUrl: z.literal(TARGET_URL), sourceJobId: z.literal(110499484593), sourceStepNumber: z.literal(8),
    }).strict(),
    repositoryEnvironment: z.object({
      deploymentId: z.literal(6791068003), createdAt: z.literal("2026-10-01T17:38:44.000Z"),
      successStatusId: z.literal(19129965701), successAt: z.literal("2026-10-01T17:45:57.000Z"),
      environment: z.literal("github-pages"), task: z.literal("deploy"), sha: z.literal(PUBLISHED_INCIDENT_SHA),
      sourceJobId: z.literal(110499484593),
      statusLogUrl: z.literal("https://github.com/CrunchyBrunch/lionlog/actions/runs/36900859358/job/110499484593"),
      targetUrl: z.literal(TARGET_URL),
    }).strict(),
    predecessor: z.object({
      originalAuthorized: z.literal("NONE_FIRST_PUBLICATION"),
      incidentPublishedReleaseId: z.literal(PUBLISHED_INCIDENT_RELEASE),
      currentAtDecision: z.literal(PUBLISHED_INCIDENT_RELEASE),
      observedAt: UTC_MS, completedAt: UTC_MS,
      marker: publicationReleaseMarkerSchema,
      publicInventory: z.array(publicEntry).length(51),
    }).strict(),
    browserFailure: z.object({
      jobId: z.literal(110502480790), stepNumber: z.literal(6),
      error: z.literal("LionLog shell asset was unavailable: https://crunchybrunch.github.io/lionlog"),
    }).strict(),
  }).strict(),
  decision: z.object({
    kind: z.literal("factual-reconciliation-only"), evidenceDigest: DIGEST,
    repositoryId: z.literal(1346360244), pullRequestNumber: ID, commentId: ID,
    actorId: z.literal(RECONCILIATION_PM_ACTOR_ID), decidedAt: UTC_MS,
  }).strict(),
  note: z.string().regex(/^[\x20-\x7e]{20,1000}$/),
}).strict();

export type PublishedIncident = z.infer<typeof schema>;

const expectedArtifacts = {
  candidate: { id: 11162276195, name: "lionlog-live-2026-10-01-5be205a42930f69424d0854443b4fa4f35c237bd-36860769514-1", digest: "sha256:01c10298db0b2d44b32bc367f2378a57a77cb4a697b975af7f969e1b754f85f4", runId: 36860769514, expiresAt: "2026-12-30T12:17:25.000Z", paths: ["release-manifest.json", "site.tar"], hashes: ["7d6aec0aa52660ce9eabe65745a179afba481692967b1706e073ac613061da99", "b9613a8f97ae7b5d7fa20d9f1aa22b0656bef46bb1af5feb94a280c798e9eb4e"] },
  staged: { id: 11181496634, name: "lionlog-pages-36900859358-1", digest: "sha256:28e9db5d96b42f7337460dca8aae5bd59d8629a276ebf399deb5ebdbe4953f82", runId: PUBLISHED_INCIDENT_RUN, expiresAt: "2026-12-30T17:38:26.000Z", paths: ["artifact.tar"], hashes: ["b8c6c724b41373d6c34da4f702082380b2b4a6822bd4529a48139d9103d2e2ff"] },
  preapproval: { id: 11181471636, name: "lionlog-pages-preapproval-36900859358-1", digest: "sha256:7e9457481b66a7c0cf3346cf5f753405c1019c231b5e898cf13c0242ce136060", runId: PUBLISHED_INCIDENT_RUN, expiresAt: "2026-12-30T17:38:26.000Z", paths: ["preapproval.json"], hashes: ["54a0d40d11efda0efa2bd55daa486048b425083167ddf8104e723961d87f6eac"] },
  receipt: { id: 11182640706, name: "lionlog-pages-receipt-36900859358-1", digest: "sha256:0d5ae97c7fc205b6c5348a80077b113031c1dfb027a6b8dc0843a5a5713674f7", runId: PUBLISHED_INCIDENT_RUN, expiresAt: "2026-12-30T17:38:26.000Z", paths: ["pages-receipt.json"], hashes: ["9c008af6f4e74c02673ac9f9c9c9174782f96e435c596e4a31ee91fabd25b1fe"] },
} as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonicalize(item)]));
}

export function canonicalEvidenceDigest(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Evidence digest input must be an object.");
  const { decision: _decision, ...evidence } = value as Record<string, unknown>;
  void _decision;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(evidence)), "utf8").digest("hex")}`;
}

export function validatePublishedIncidentRecord(value: unknown, now: Date): PublishedIncident {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid incident validation time.");
  const record = schema.parse(value);
  if (!isDeepStrictEqual(record.collectorEvidence, reviewedGraph)) throw new Error("Published incident graph differs from reviewed exact attempt.");
  for (const kind of Object.keys(expectedArtifacts) as Array<keyof typeof expectedArtifacts>) {
    const actual = record.evidence.artifacts[kind];
    const expected = expectedArtifacts[kind];
    if (actual.id !== expected.id || actual.name !== expected.name || actual.wrapperDigest !== expected.digest
      || actual.producerRunId !== expected.runId || actual.expiresAt !== expected.expiresAt
      || actual.headSha !== PUBLISHED_INCIDENT_SHA || actual.entries.length !== expected.paths.length
      || actual.entries.some((item, index) => item.path !== expected.paths[index] || item.sha256 !== expected.hashes[index])) {
      throw new Error(`Published incident ${kind} artifact differs from reviewed evidence.`);
    }
  }
  const release = record.evidence.release;
  const predecessor = record.evidence.predecessor;
  const publicInventory = predecessor.publicInventory;
  const sortedPublicInventory = publicInventory.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (release.inventory.some((item, index) => index > 0 && release.inventory[index - 1].path >= item.path)
    || !isDeepStrictEqual(release.inventory, reviewedInventory)
    || !isDeepStrictEqual(release.inventory, sortedPublicInventory)
    || !isDeepStrictEqual(publicInventory, reviewedPublicInventory)
    || predecessor.marker.releaseId !== PUBLISHED_INCIDENT_RELEASE
    || predecessor.marker.sourceCommitSha !== PUBLISHED_INCIDENT_SHA
    || predecessor.marker.releaseKind !== "live"
    || !isDeepStrictEqual(predecessor.marker, {
      markerVersion: "lionlog.pages-release-marker.v1",
      releaseId: PUBLISHED_INCIDENT_RELEASE,
      releaseKind: "live",
      sourceCommitSha: PUBLISHED_INCIDENT_SHA,
      serviceDate: "2026-10-01",
      catalogSha256: "b2c003d5accf17703e12eba78cfc38e4033b0a3e88aca2711f07fb08e1dfaa81",
      shellRevision: PUBLISHED_INCIDENT_SHA,
      generatedAt: "2026-10-01T12:34:58.648Z",
    })
    || record.checkedAt !== predecessor.observedAt) throw new Error("Published incident release or public inventory differs from reviewed evidence.");
  const observed = Date.parse(predecessor.observedAt);
  const finished = Date.parse(predecessor.completedAt);
  const decided = Date.parse(record.decision.decidedAt);
  if (observed > finished || finished > decided || decided > now.getTime()
    || decided - observed > DECISION_OBSERVATION_MAX_AGE_MS) throw new Error("Published incident observation or decision time is invalid.");
  if (record.decision.evidenceDigest !== canonicalEvidenceDigest(record)) throw new Error("Published incident decision digest differs from the evidence.");
  return record;
}

const API_ORIGIN = "https://api.github.com";
const DECISION_PREFIX = "Approve factual reconciliation only for CrunchyBrunch/lionlog 36900859358/1, evidence ";

async function publicJson(fetchImpl: typeof fetch, route: string): Promise<unknown> {
  const url = `${API_ORIGIN}${route}`;
  const response = await fetchImpl(url, {
    redirect: "error", cache: "no-store",
    headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok || response.redirected || (response.url !== "" && response.url !== url)) {
    throw new Error(`Published incident public GitHub evidence unavailable (${response.status}).`);
  }
  return response.json();
}

async function publicArrayPages(fetchImpl: typeof fetch, route: string): Promise<unknown[]> {
  const collected: unknown[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const values = await publicJson(fetchImpl, `${route}?per_page=100&page=${page}`);
    if (!Array.isArray(values) || values.length > 100) throw new Error("Published incident PR listing is malformed.");
    if (values.length === 0) return collected;
    collected.push(...values);
  }
  throw new Error("Published incident PR listing exceeds its pagination bound.");
}

function utcSecondsToMs(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error("Decision time is not canonical GitHub UTC.");
  }
  const normalized = value.replace(/Z$/, ".000Z");
  if (new Date(normalized).toISOString() !== normalized) throw new Error("Decision time is invalid.");
  return normalized;
}

export interface VerifiedPublishedDecision {
  commentId: number;
  evidenceDigest: string;
  actorId: number;
  decidedAt: string;
  pullRequestNumber: number;
  mergedCommitSha: string;
}

export async function verifyPublishedDecision(record: PublishedIncident, fetchImpl: typeof fetch = fetch): Promise<VerifiedPublishedDecision> {
  const pr = record.decision.pullRequestNumber;
  const route = `/repos/CrunchyBrunch/lionlog`;
  const prValue = await publicJson(fetchImpl, `${route}/pulls/${pr}`) as Record<string, unknown>;
  const base = prValue.base as { ref?: unknown; repo?: { id?: unknown } } | undefined;
  const head = prValue.head as { sha?: unknown; repo?: { id?: unknown } } | undefined;
  if (prValue.number !== pr || typeof prValue.merged_at !== "string" || !Number.isFinite(Date.parse(prValue.merged_at))
    || typeof prValue.merge_commit_sha !== "string" || !/^[a-f0-9]{40}$/.test(prValue.merge_commit_sha)
    || base?.ref !== "main" || base.repo?.id !== 1346360244 || head?.repo?.id !== 1346360244
    || typeof head.sha !== "string" || !/^[a-f0-9]{40}$/.test(head.sha)) {
    throw new Error("Published incident source-review PR is not the merged repository/main PR.");
  }
  const files = await publicArrayPages(fetchImpl, `${route}/pulls/${pr}/files`);
  if (files.length === 0 || !files.some((file) => (file as { filename?: unknown }).filename === "infrastructure/publication/pages-incident-history.json")) {
    throw new Error("Published incident source-review PR does not include the history record.");
  }
  const comparison = await publicJson(fetchImpl, `${route}/compare/${prValue.merge_commit_sha}...main`) as Record<string, unknown>;
  if (comparison.status !== "ahead" && comparison.status !== "identical") {
    throw new Error("Published incident source-review merge is not an ancestor of main.");
  }
  for (const ref of [prValue.merge_commit_sha, "main"]) {
    const content = await publicJson(fetchImpl,
      `${route}/contents/infrastructure/publication/pages-incident-history.json?ref=${ref}`) as Record<string, unknown>;
    if (content.encoding !== "base64" || typeof content.content !== "string") {
      throw new Error("Published incident record is not present on merged review and main.");
    }
    const history = JSON.parse(Buffer.from(content.content.replace(/\s/g, ""), "base64").toString("utf8")) as { incidents?: unknown[] };
    if (!Array.isArray(history.incidents)
      || history.incidents.filter((item) => isDeepStrictEqual(item, record)).length !== 1) {
      throw new Error("Published incident exact record is absent or duplicate on merged review/main.");
    }
  }
  const selected = await publicJson(fetchImpl, `${route}/issues/comments/${record.decision.commentId}`) as Record<string, unknown>;
  const expectedBody = `${DECISION_PREFIX}${record.decision.evidenceDigest}; no release authorization.`;
  const actor = selected.user as { id?: unknown } | undefined;
  if (selected.id !== record.decision.commentId || actor?.id !== RECONCILIATION_PM_ACTOR_ID
    || selected.issue_url !== `${API_ORIGIN}${route}/issues/${pr}`
    || selected.body !== expectedBody || utcSecondsToMs(selected.created_at) !== record.decision.decidedAt
    || selected.updated_at !== selected.created_at) throw new Error("Published incident decision comment is wrong, edited or changed.");
  if (Date.parse(record.decision.decidedAt) > Date.parse(prValue.merged_at)) {
    throw new Error("Published incident decision occurred after source review merged.");
  }
  let seenSelected = 0;
  const seenIds = new Set<number>();
  let completed = false;
  for (let page = 1; page <= 10; page += 1) {
    const values = await publicJson(fetchImpl, `${route}/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(values) || values.length > 100) throw new Error("Published incident decision comment page is malformed.");
    if (values.length === 0) { completed = true; break; }
    for (const raw of values) {
      const comment = raw as Record<string, unknown>;
      if (!Number.isSafeInteger(comment.id) || seenIds.has(comment.id as number)) throw new Error("Published incident decision comment listing is duplicate.");
      seenIds.add(comment.id as number);
      if (comment.id === selected.id) {
        if (!isDeepStrictEqual(comment, selected)) throw new Error("Published incident selected comment conflicts with listing.");
        seenSelected += 1;
      }
      const user = comment.user as { id?: unknown } | undefined;
      if (user?.id === RECONCILIATION_PM_ACTOR_ID && typeof comment.body === "string"
        && comment.body.startsWith(DECISION_PREFIX) && comment.id !== selected.id) {
        throw new Error("Published incident has duplicate or conflicting PM decisions.");
      }
    }
  }
  if (!completed || seenSelected !== 1) throw new Error("Published incident decision comment listing is incomplete.");
  return {
    commentId: record.decision.commentId, evidenceDigest: record.decision.evidenceDigest,
    actorId: RECONCILIATION_PM_ACTOR_ID, decidedAt: record.decision.decidedAt,
    pullRequestNumber: pr, mergedCommitSha: prValue.merge_commit_sha,
  };
}
