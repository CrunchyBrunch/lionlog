import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArtifactZip } from "./artifact-zip.ts";
import { assertArtifactDigest } from "./artifact-digest.ts";
import { LIONLOG_REPOSITORY_ID, PROMOTION_WORKFLOW_ID } from "../infrastructure/publication/release-contract.ts";

const API_ROOT = "https://api.github.com";
const PER_PAGE = 100;
const MAX_PAGES = 10;
const MAX_ATTEMPTS_PER_RUN = 20;
const GIT_SHA = /^[a-f0-9]{40}$/;

export interface CollectedAttemptEvidence {
  runId: number;
  workflowSha: string;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  jobsComplete: boolean;
  finalGateConclusion: string | null;
  submissionBoundaryConclusion: string | null;
  deploymentConclusion: string | null;
  legacyEvidence: LegacyAttemptEvidence;
  receipt: null | {
    artifactId: number;
    artifactDigest: string;
    artifactExpiresAt: string;
    content: Record<string, unknown>;
  };
}

export interface LegacyStepEvidence {
  jobId: number;
  jobName: string;
  jobConclusion: string;
  stepName: string | null;
  stepConclusion: string;
}

export interface LegacyAttemptEvidence {
  validationFailure: LegacyStepEvidence | null;
  deploymentBoundary: LegacyStepEvidence | null;
}

const LEGACY_VALIDATION_STEPS = new Set([
  "Perform final provenance, state, deadline, and freshness checks",
  "Verify current attempt separately from the known-good rollback target",
]);

export async function collectPagesAttemptHistory(options: {
  repository: string;
  currentRunId: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<CollectedAttemptEvidence[]> {
  if (options.repository !== "CrunchyBrunch/lionlog" || !positive(options.currentRunId) || options.token.length < 1) {
    throw new Error("Attempt-history authority is invalid.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const runs = await paginated(fetchImpl, options.token,
    `/repos/${options.repository}/actions/workflows/${PROMOTION_WORKFLOW_ID}/runs`, "workflow_runs");
  const evidence: CollectedAttemptEvidence[] = [];
  for (const runValue of runs) {
    const run = runValue as Record<string, unknown>;
    const runId = number(run.id, "Workflow run ID");
    const latestAttempt = number(run.run_attempt, "Workflow run attempt");
    if (latestAttempt > MAX_ATTEMPTS_PER_RUN) throw new Error("Workflow run has too many attempts for bounded reconciliation.");
    const artifacts = await paginated(fetchImpl, options.token, `/repos/${options.repository}/actions/runs/${runId}/artifacts`, "artifacts");
    for (let attempt = 1; attempt <= latestAttempt; attempt += 1) {
      const attemptRun = await apiJson(fetchImpl, options.token, `/repos/${options.repository}/actions/runs/${runId}/attempts/${attempt}`) as Record<string, unknown>;
      if (
        number(attemptRun.id, "Attempt run ID") !== runId
        || number(attemptRun.workflow_id, "Attempt workflow ID") !== PROMOTION_WORKFLOW_ID
        || number(attemptRun.run_attempt, "Attempt number") !== attempt
        || attemptRun.path !== ".github/workflows/deploy-github-pages.yml"
        || attemptRun.event !== "workflow_dispatch"
        || attemptRun.head_branch !== "main"
        || typeof attemptRun.head_sha !== "string" || !GIT_SHA.test(attemptRun.head_sha)
      ) throw new Error("Attempt-specific workflow identity is invalid.");
      const jobs = await paginated(fetchImpl, options.token,
        `/repos/${options.repository}/actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs");
      const steps = jobs.flatMap((jobValue) => {
        const job = jobValue as { steps?: unknown };
        if (job.steps === undefined) return [];
        if (!Array.isArray(job.steps)) throw new Error("Attempt-specific job steps are malformed.");
        return job.steps as Array<Record<string, unknown>>;
      });
      const legacyEvidence = collectLegacyEvidence(jobs);
      const jobsComplete = jobs.length > 0 && jobs.every((jobValue) => {
        const job = jobValue as Record<string, unknown>;
        return job.status === "completed" && typeof job.conclusion === "string";
      });
      const receiptName = `lionlog-pages-receipt-${runId}-${attempt}`;
      const receiptArtifacts = artifacts.filter((artifactValue) => (artifactValue as Record<string, unknown>).name === receiptName);
      if (receiptArtifacts.length > 1) throw new Error("Attempt has ambiguous flat receipt artifacts.");
      const receipt = receiptArtifacts.length === 1
        ? await readReceipt(fetchImpl, options.token, options.repository, runId, attemptRun.head_sha, receiptArtifacts[0] as Record<string, unknown>)
        : null;
      evidence.push({
        runId,
        workflowSha: attemptRun.head_sha,
        runAttempt: attempt,
        status: string(attemptRun.status, "Attempt status"),
        conclusion: nullableString(attemptRun.conclusion, "Attempt conclusion"),
        jobsComplete,
        finalGateConclusion: stepConclusion(steps, "Recheck all authority immediately before submission"),
        submissionBoundaryConclusion: stepConclusion(steps, "Record official submission boundary"),
        deploymentConclusion: stepConclusion(steps, "Deploy with official Pages action"),
        legacyEvidence,
        receipt,
      });
    }
  }
  return evidence.sort((left, right) => left.runId - right.runId || left.runAttempt - right.runAttempt);
}

export function collectLegacyEvidence(jobs: unknown[]): LegacyAttemptEvidence {
  const validationMatches: LegacyStepEvidence[] = [];
  const deploymentMatches: LegacyStepEvidence[] = [];
  for (const jobValue of jobs) {
    const job = jobValue as Record<string, unknown>;
    const jobId = number(job.id, "Legacy job ID");
    const jobName = string(job.name, "Legacy job name");
    const jobConclusion = nullableString(job.conclusion, "Legacy job conclusion");
    const steps = job.steps;
    if (!Array.isArray(steps)) throw new Error("Legacy job steps are malformed.");
    for (const stepValue of steps) {
      const step = stepValue as Record<string, unknown>;
      if (typeof step.name !== "string") continue;
      const evidence = (): LegacyStepEvidence => ({
        jobId,
        jobName,
        jobConclusion: jobConclusion ?? "",
        stepName: step.name as string,
        stepConclusion: nullableString(step.conclusion, "Legacy step conclusion") ?? "",
      });
      if (LEGACY_VALIDATION_STEPS.has(step.name)) validationMatches.push(evidence());
      if (step.name === "Deploy exact staged artifact") deploymentMatches.push(evidence());
    }
  }
  if (validationMatches.length > 1 || deploymentMatches.length > 1) {
    throw new Error("Legacy attempt evidence is ambiguous.");
  }
  if (deploymentMatches.length === 0) {
    const skippedDeployJobs = jobs.filter((jobValue) => {
      const job = jobValue as Record<string, unknown>;
      return job.name === "deploy" && job.status === "completed" && job.conclusion === "skipped"
        && Array.isArray(job.steps) && job.steps.length === 0;
    });
    if (skippedDeployJobs.length > 1) throw new Error("Legacy skipped-deploy evidence is ambiguous.");
    if (skippedDeployJobs.length === 1) {
      const job = skippedDeployJobs[0] as Record<string, unknown>;
      deploymentMatches.push({
        jobId: number(job.id, "Legacy skipped-deploy job ID"),
        jobName: "deploy",
        jobConclusion: "skipped",
        stepName: null,
        stepConclusion: "skipped",
      });
    }
  }
  return {
    validationFailure: validationMatches[0] ?? null,
    deploymentBoundary: deploymentMatches[0] ?? null,
  };
}

async function readReceipt(
  fetchImpl: typeof fetch,
  token: string,
  repository: string,
  runId: number,
  workflowSha: string,
  artifact: Record<string, unknown>,
): Promise<CollectedAttemptEvidence["receipt"]> {
  const artifactId = number(artifact.id, "Receipt artifact ID");
  const digest = string(artifact.digest, "Receipt artifact digest");
  const expiresAt = string(artifact.expires_at, "Receipt artifact expiry");
  const workflowRun = artifact.workflow_run as Record<string, unknown> | undefined;
  if (
    artifact.expired !== false || Date.parse(expiresAt) <= Date.now()
    || number(workflowRun?.id, "Receipt workflow run ID") !== runId
    || workflowRun?.head_sha !== workflowSha
    || number(workflowRun?.head_repository_id, "Receipt repository ID") !== LIONLOG_REPOSITORY_ID
  ) throw new Error("Receipt artifact provenance is invalid or expired.");
  const response = await api(fetchImpl, token, `/repos/${repository}/actions/artifacts/${artifactId}/zip`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assertArtifactDigest(digest, createHash("sha256").update(bytes).digest("hex"));
  const entries = parseArtifactZip(bytes, ["pages-receipt.json"]);
  const content = JSON.parse(entries[0].data.toString("utf8")) as Record<string, unknown>;
  return { artifactId, artifactDigest: assertArtifactDigest(digest, digest), artifactExpiresAt: expiresAt, content };
}

async function paginated(fetchImpl: typeof fetch, token: string, endpoint: string, key: string): Promise<unknown[]> {
  const collected: unknown[] = [];
  let total: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const body = await apiJson(fetchImpl, token, `${endpoint}${separator}per_page=${PER_PAGE}&page=${page}`) as Record<string, unknown>;
    const values = body[key];
    if (!Array.isArray(values)) throw new Error(`Paginated ${key} response is malformed.`);
    const reported = nonnegative(body.total_count, `${key} total count`);
    if (total === null) total = reported;
    if (reported !== total || collected.length + values.length > total) throw new Error(`Paginated ${key} response changed while reading.`);
    collected.push(...values);
    if (collected.length === total) return collected;
    if (values.length !== PER_PAGE) throw new Error(`Paginated ${key} response ended before its reported total.`);
  }
  throw new Error(`Paginated ${key} history exceeds the bounded ${PER_PAGE * MAX_PAGES}-entry limit.`);
}

async function apiJson(fetchImpl: typeof fetch, token: string, endpoint: string): Promise<unknown> {
  const response = await api(fetchImpl, token, endpoint);
  return response.json();
}

async function api(fetchImpl: typeof fetch, token: string, endpoint: string): Promise<Response> {
  const url = endpoint.startsWith("https://") ? endpoint : `${API_ROOT}${endpoint}`;
  if (!url.startsWith(`${API_ROOT}/`)) throw new Error("Attempt-history API URL escaped GitHub.");
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub attempt-history request failed (${response.status}).`);
  return response;
}

function stepConclusion(steps: Array<Record<string, unknown>>, name: string): string | null {
  const matches = steps.filter((step) => step.name === name);
  if (matches.length > 1) throw new Error(`Attempt has ambiguous step evidence: ${name}`);
  if (matches.length === 0) return null;
  return nullableString(matches[0].conclusion, `${name} conclusion`);
}

function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function number(value: unknown, label: string): number {
  if (!positive(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function nonnegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid.`);
  return value as number;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid.`);
  return value;
}
function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length);
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GH_TOKEN ?? "";
  const currentRunId = Number(process.env.GITHUB_RUN_ID);
  if (!output) throw new Error("Attempt-history output path is missing.");
  const evidence = await collectPagesAttemptHistory({ repository, currentRunId, token });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
}
