import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LIONLOG_REPOSITORY,
  LIONLOG_REPOSITORY_ID,
  PROMOTION_WORKFLOW_ID,
  TARGET_BASE_PATH,
  TARGET_ORIGIN,
} from "../infrastructure/publication/release-contract.ts";
import type { ValidatedRelease } from "./supported-pages-release.ts";
import { ACTION_HEADROOM_MS } from "./supported-pages-release.ts";
import { assertExpectedPredecessor, validateExpectedPredecessor, type PublicReleaseObservation } from "./public-release-state.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const WORKFLOW_PATH = ".github/workflows/deploy-github-pages.yml";

export type PreapprovalSummary = Omit<ValidatedRelease, "summaryVersion"> & {
  summaryVersion: "lionlog.pages-preapproval.v1";
  staged: {
    artifactId: number;
    artifactName: string;
    artifactDigest: string;
    artifactExpiresAt: string;
    tarSha256: string;
  };
};

export interface Incident {
  runId: number;
  runAttempt: number;
  workflowSha: string;
  candidateArtifactId: number;
  stagedArtifactId: number;
  repositoryDeploymentId: number;
  outcome: "resolved-unknown-no-publication";
  publicReleaseId: "NONE_404";
  checkedAt: string;
  note: string;
}

export interface FinalState {
  repository: { id: number; full_name: string };
  main: { sha: string };
  workflowRun: {
    id: number; workflow_id: number; path: string; event: string; head_sha: string;
    head_branch: string; run_attempt: number; status: string; conclusion: null;
  };
  candidateRun: { id: number; head_sha: string; status: string; conclusion: string; run_attempt: number };
  candidateArtifact: { id: number; digest: string; expired: boolean; expires_at: string };
  stagedArtifacts: Array<{ id: number; name: string; digest: string; expired: boolean; expires_at: string }>;
  ciRun: { id: number; head_sha: string; status: string; conclusion: string; run_attempt: number };
  priorAttempts: PriorAttemptEvidence[];
  publicPredecessor: PublicReleaseObservation;
  rollbackReceiptArtifact: null | { id: number; digest: string; expired: boolean; expires_at: string; workflow_run: { id: number; head_sha: string } };
  rollbackReceiptRun: null | { id: number; head_sha: string; status: string; conclusion: string; run_attempt: number };
}

export interface PriorAttemptEvidence {
  runId: number;
  workflowSha: string;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  jobsComplete: boolean;
  finalGateConclusion: string | null;
  submissionBoundaryConclusion: string | null;
  deploymentConclusion: string | null;
  receipt: null | {
    artifactId: number;
    artifactDigest: string;
    artifactExpiresAt: string;
    content: Record<string, unknown>;
  };
}

export function validatePreapprovalSummary(value: unknown): PreapprovalSummary {
  const summary = value as PreapprovalSummary;
  if (
    summary?.summaryVersion !== "lionlog.pages-preapproval.v1"
    || (summary.operation !== "promote" && summary.operation !== "rollback")
    || !GIT_SHA.test(summary.workflow?.sha ?? "")
    || !positive(summary.workflow?.runId)
    || summary.workflow?.runAttempt !== 1
    || !positive(summary.candidate?.runId)
    || !GIT_SHA.test(summary.candidate?.sourceSha ?? "")
    || !positive(summary.candidate?.artifactId)
    || !summary.candidate?.artifactName?.startsWith("lionlog-live-")
    || !ARTIFACT_DIGEST.test(summary.candidate?.artifactDigest ?? "")
    || !SHA256.test(summary.candidate?.manifestSha256 ?? "")
    || !Number.isFinite(Date.parse(summary.candidate?.artifactExpiresAt ?? ""))
    || !positive(summary.ci?.runId)
    || !SHA256.test(summary.release?.id ?? "")
    || summary.release?.kind !== "live"
    || !/^\d{4}-\d{2}-\d{2}$/.test(summary.release?.serviceDate ?? "")
    || (summary.release?.coverage !== "complete" && summary.release?.coverage !== "partial")
    || !Number.isSafeInteger(summary.release?.omissions?.["invalid-name"])
    || (summary.release?.omissions?.["invalid-name"] ?? -1) < 0
    || !Number.isFinite(Date.parse(summary.release?.earliestFreshUntil ?? ""))
    || !Number.isFinite(Date.parse(summary.release?.earliestRetainUntil ?? ""))
    || !Array.isArray(summary.site?.inventory) || summary.site.inventory.length === 0
    || !positive(summary.staged?.artifactId)
    || summary.staged?.artifactName !== `lionlog-pages-${summary.workflow?.runId}-1`
    || !ARTIFACT_DIGEST.test(summary.staged?.artifactDigest ?? "")
    || !SHA256.test(summary.staged?.tarSha256 ?? "")
    || !Number.isFinite(Date.parse(summary.staged?.artifactExpiresAt ?? ""))
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(summary.authorization?.approvalExpiresAt ?? "")
    || !Number.isFinite(Date.parse(summary.authorization?.approvalExpiresAt ?? ""))
    || (typeof summary.authorization?.predecessorReleaseId !== "string")
    || (summary.operation === "promote" && summary.rollbackReceipt !== null)
    || (summary.operation === "rollback" && summary.rollbackReceipt === null)
  ) throw new Error("Preapproval summary is invalid.");
  if (new Date(summary.authorization.approvalExpiresAt).toISOString() !== summary.authorization.approvalExpiresAt) {
    throw new Error("Preapproval summary approval expiry is not canonical.");
  }
  validateExpectedPredecessor(summary.authorization.predecessorReleaseId);
  return summary;
}

export function verifyFinalState(options: {
  summary: unknown;
  state: FinalState;
  incidents: { historyVersion: string; incidents: Incident[] };
  now: Date;
}): PreapprovalSummary {
  const summary = validatePreapprovalSummary(options.summary);
  const { state } = options;
  if (!Number.isFinite(options.now.getTime())) throw new Error("Final verification time is invalid.");
  if (state.repository.id !== LIONLOG_REPOSITORY_ID || state.repository.full_name !== LIONLOG_REPOSITORY) throw new Error("Repository identity drifted.");
  if (state.main.sha !== summary.workflow.sha) throw new Error("Authoritative main drifted after staging.");
  const run = state.workflowRun;
  if (
    run.id !== summary.workflow.runId || run.workflow_id !== PROMOTION_WORKFLOW_ID || run.path !== WORKFLOW_PATH
    || run.event !== "workflow_dispatch" || run.head_sha !== summary.workflow.sha || run.head_branch !== "main"
    || run.run_attempt !== 1 || run.status !== "in_progress" || run.conclusion !== null
  ) throw new Error("Promotion workflow identity drifted.");
  if (
    state.candidateRun.id !== summary.candidate.runId || state.candidateRun.head_sha !== summary.candidate.sourceSha
    || state.candidateRun.run_attempt !== 1 || state.candidateRun.status !== "completed" || state.candidateRun.conclusion !== "success"
  ) throw new Error("Candidate producer state drifted.");
  if (
    state.candidateArtifact.id !== summary.candidate.artifactId || state.candidateArtifact.digest !== summary.candidate.artifactDigest
    || state.candidateArtifact.expired || state.candidateArtifact.expires_at !== summary.candidate.artifactExpiresAt
    || Date.parse(state.candidateArtifact.expires_at) < options.now.getTime() + ACTION_HEADROOM_MS
  ) throw new Error("Candidate artifact state drifted.");
  const staged = state.stagedArtifacts.filter((artifact) => artifact.name === summary.staged.artifactName);
  if (
    staged.length !== 1 || staged[0].id !== summary.staged.artifactId || staged[0].digest !== summary.staged.artifactDigest
    || staged[0].expired || staged[0].expires_at !== summary.staged.artifactExpiresAt
    || Date.parse(staged[0].expires_at) < options.now.getTime() + ACTION_HEADROOM_MS
  ) throw new Error("Staged Pages artifact identity drifted or is not unique.");
  if (
    state.ciRun.id !== summary.ci.runId || state.ciRun.head_sha !== summary.candidate.sourceSha
    || state.ciRun.run_attempt !== 1 || state.ciRun.status !== "completed" || state.ciRun.conclusion !== "success"
  ) throw new Error("Exact-source CI state drifted.");
  if (Date.parse(summary.authorization.approvalExpiresAt) < options.now.getTime() + ACTION_HEADROOM_MS) {
    throw new Error("Project Manager approval expired or lacks supported-action headroom.");
  }
  if (Date.parse(summary.release.earliestRetainUntil) < options.now.getTime() + ACTION_HEADROOM_MS) throw new Error("Candidate retention lacks supported-action headroom.");
  if (summary.operation === "promote" && Date.parse(summary.release.earliestFreshUntil) < options.now.getTime() + ACTION_HEADROOM_MS) {
    throw new Error("Candidate freshness fell below the promotion floor while awaiting approval.");
  }
  assertExpectedPredecessor(summary.authorization.predecessorReleaseId, state.publicPredecessor);
  if (summary.operation === "rollback") {
    const approved = summary.rollbackReceipt;
    if (
      approved === null
      || state.rollbackReceiptArtifact?.id !== approved.artifactId
      || state.rollbackReceiptArtifact.digest !== approved.artifactDigest
      || state.rollbackReceiptArtifact.expires_at !== approved.artifactExpiresAt
      || state.rollbackReceiptArtifact.expired
      || Date.parse(state.rollbackReceiptArtifact.expires_at) < options.now.getTime() + ACTION_HEADROOM_MS
      || state.rollbackReceiptArtifact.workflow_run.id !== approved.runId
      || state.rollbackReceiptArtifact.workflow_run.head_sha !== approved.sourceWorkflowSha
      || state.rollbackReceiptRun?.id !== approved.runId
      || state.rollbackReceiptRun.head_sha !== approved.sourceWorkflowSha
      || state.rollbackReceiptRun.run_attempt !== 1
      || state.rollbackReceiptRun.status !== "completed"
      || state.rollbackReceiptRun.conclusion !== "success"
    ) throw new Error("Rollback receipt authority drifted.");
  } else if (summary.rollbackReceipt !== null || state.rollbackReceiptArtifact !== null || state.rollbackReceiptRun !== null) {
    throw new Error("Promotion unexpectedly carries rollback authority.");
  }

  if (options.incidents.historyVersion !== "lionlog.pages-incident-history.v1" || !Array.isArray(options.incidents.incidents)) {
    throw new Error("Pages incident history is invalid.");
  }
  const incidentMap = new Map<string, Incident>();
  for (const incident of options.incidents.incidents) {
    if (
      !positive(incident.runId) || !positive(incident.runAttempt) || !GIT_SHA.test(incident.workflowSha)
      || !positive(incident.candidateArtifactId) || !positive(incident.stagedArtifactId) || !positive(incident.repositoryDeploymentId)
      || incident.outcome !== "resolved-unknown-no-publication" || incident.publicReleaseId !== "NONE_404"
      || !Number.isFinite(Date.parse(incident.checkedAt)) || Date.parse(incident.checkedAt) > options.now.getTime()
      || typeof incident.note !== "string" || incident.note.length < 20
      || incidentMap.has(`${incident.runId}/${incident.runAttempt}`)
    ) throw new Error("Pages incident history contains an invalid or duplicate record.");
    incidentMap.set(`${incident.runId}/${incident.runAttempt}`, incident);
  }
  for (const prior of state.priorAttempts) {
    if (prior.runId === summary.workflow.runId) continue;
    if (!positive(prior.runId) || !GIT_SHA.test(prior.workflowSha) || !positive(prior.runAttempt) || prior.jobsComplete !== true) {
      throw new Error("Earlier Pages attempt history is incomplete or invalid.");
    }
    if (isKnownGoodAttempt(prior) || isProvenPreSubmissionFailure(prior)) continue;
    const incident = incidentMap.get(`${prior.runId}/${prior.runAttempt}`);
    if (!incident || incident.runAttempt !== prior.runAttempt || incident.workflowSha !== prior.workflowSha) {
      throw new Error(`Earlier Pages submission attempt ${prior.runId}/${prior.runAttempt} is unknown or unresolved.`);
    }
  }
  return summary;
}

function isKnownGoodAttempt(attempt: PriorAttemptEvidence): boolean {
  const receipt = attempt.receipt?.content as AttemptReceipt | undefined;
  return attempt.status === "completed" && attempt.conclusion === "success"
    && attempt.finalGateConclusion === "success"
    && attempt.deploymentConclusion === "success" && attempt.submissionBoundaryConclusion === "success"
    && receipt?.receiptVersion === "lionlog.pages-flat-receipt.v1"
    && receipt.workflow?.runId === attempt.runId && receipt.workflow?.runAttempt === attempt.runAttempt
    && receipt.official?.submissionStarted === true && receipt.official?.result === "success"
    && receipt.public?.markerVerified === true && receipt.public?.inventoryVerified === true && receipt.public?.browserVerified === true
    && receipt.knownGood === true && receipt.unresolved === false;
}

function isProvenPreSubmissionFailure(attempt: PriorAttemptEvidence): boolean {
  const receipt = attempt.receipt?.content as AttemptReceipt | undefined;
  return attempt.status === "completed" && attempt.conclusion === "failure"
    && attempt.finalGateConclusion === "failure"
    && attempt.submissionBoundaryConclusion === "skipped" && attempt.deploymentConclusion === "skipped"
    && receipt?.receiptVersion === "lionlog.pages-flat-receipt.v1"
    && receipt.workflow?.runId === attempt.runId && receipt.workflow?.runAttempt === attempt.runAttempt
    && receipt.official?.submissionStarted === false && receipt.official?.result === "failure"
    && receipt.public?.markerVerified === false && receipt.public?.inventoryVerified === false && receipt.public?.browserVerified === false
    && receipt.knownGood === false && receipt.unresolved === false;
}

interface AttemptReceipt {
  receiptVersion?: unknown;
  workflow?: { runId?: unknown; runAttempt?: unknown };
  official?: { submissionStarted?: unknown; result?: unknown };
  public?: { markerVerified?: unknown; inventoryVerified?: unknown; browserVerified?: unknown };
  knownGood?: unknown;
  unresolved?: unknown;
}

export function createFlatReceipt(options: {
  summary: unknown;
  recordedAt: string;
  official: { submissionStarted: boolean; result: string; pageUrl: string | null; deploymentId: string | null };
  publicChecks: { markerVerified: boolean; inventoryVerified: boolean; browserVerified: boolean };
}): Record<string, unknown> {
  const summary = validatePreapprovalSummary(options.summary);
  const recordedAt = new Date(options.recordedAt);
  if (!Number.isFinite(recordedAt.getTime())) throw new Error("Receipt timestamp is invalid.");
  const exactPageUrl = `${TARGET_ORIGIN}${TARGET_BASE_PATH}`;
  const knownGood = options.official.submissionStarted
    && options.official.result === "success"
    && options.official.pageUrl === exactPageUrl
    && options.publicChecks.markerVerified
    && options.publicChecks.inventoryVerified
    && options.publicChecks.browserVerified;
  return {
    receiptVersion: "lionlog.pages-flat-receipt.v1",
    recordedAt: recordedAt.toISOString(),
    operation: summary.operation,
    workflow: summary.workflow,
    candidate: summary.candidate,
    ci: summary.ci,
    release: summary.release,
    staged: summary.staged,
    rollbackSource: summary.rollbackReceipt,
    official: options.official,
    public: options.publicChecks,
    knownGood,
    unresolved: options.official.submissionStarted && !knownGood,
  };
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function args(): Map<string, string> {
  return new Map(process.argv.slice(3).map((argument) => {
    const [name, ...value] = argument.split("=");
    return [name, value.join("=")];
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  const values = args();
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  if (mode === "verify") {
    const verified = verifyFinalState({
      summary: JSON.parse(await readFile(required("--summary"), "utf8")),
      state: JSON.parse(await readFile(required("--state"), "utf8")),
      incidents: JSON.parse(await readFile(required("--incidents"), "utf8")),
      now: new Date(values.get("--now") ?? Date.now()),
    });
    process.stdout.write(`${JSON.stringify(verified, null, 2)}\n`);
  } else if (mode === "receipt") {
    const result = JSON.parse(await readFile(required("--result"), "utf8"));
    const receipt = createFlatReceipt({
      summary: JSON.parse(await readFile(required("--summary"), "utf8")),
      recordedAt: values.get("--recorded-at") ?? new Date().toISOString(),
      official: result.official,
      publicChecks: result.public,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else throw new Error("Supported Pages control mode is invalid.");
}
