import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
  workflowId: number;
  workflowPath: string;
  workflowSha: string;
  event: string;
  headBranch: string;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  jobsComplete: boolean;
  finalGateConclusion: string | null;
  submissionBoundaryConclusion: string | null;
  deploymentConclusion: string | null;
  incidentEvidence: IncidentCollectionEvidence | null;
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
  jobStatus: string;
  jobConclusion: string;
  stepNumber: number | null;
  stepName: string | null;
  stepStatus: string;
  stepConclusion: string;
}

export interface LegacyAttemptEvidence {
  validationFailure: LegacyStepEvidence | null;
  deploymentBoundary: LegacyStepEvidence | null;
}

export interface IncidentStepEvidence {
  stepNumber: number;
  stepName: string;
  stepStatus: string;
  stepConclusion: string;
}

export interface IncidentJobEvidence {
  jobId: number;
  runId: number;
  runAttempt: number;
  headSha: string;
  jobName: string;
  jobStatus: string;
  jobConclusion: string;
  steps: IncidentStepEvidence[];
}

export interface IncidentCollectionEvidence {
  workflowId: number;
  workflowPath: string;
  event: string;
  headBranch: string;
  status: string;
  conclusion: string;
  jobs: IncidentJobEvidence[];
}

interface IncidentContract {
  runId: number;
  runAttempt: number;
  workflowSha: string;
  collectorEvidence: IncidentCollectionEvidence;
  legacyEvidence: LegacyAttemptEvidence | null;
}

const TERMINAL_CONCLUSIONS = new Set(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"]);

export async function collectPagesAttemptHistory(options: {
  repository: string;
  currentRunId: number;
  token: string;
  incidentHistory: unknown;
  fetchImpl?: typeof fetch;
}): Promise<CollectedAttemptEvidence[]> {
  if (options.repository !== "CrunchyBrunch/lionlog" || !positive(options.currentRunId) || options.token.length < 1) {
    throw new Error("Attempt-history authority is invalid.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const incidentContracts = parseIncidentContracts(options.incidentHistory);
  const runs = await paginated(fetchImpl, options.token,
    `/repos/${options.repository}/actions/workflows/${PROMOTION_WORKFLOW_ID}/runs`, "workflow_runs");
  assertUniqueRecords(runs, "id", "Workflow-run history");
  const evidence: CollectedAttemptEvidence[] = [];
  const evidenceKeys = new Set<string>();
  for (const runValue of runs) {
    const run = runValue as Record<string, unknown>;
    const runId = number(run.id, "Workflow run ID");
    if (runId === options.currentRunId) continue;
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
      if (attemptRun.status !== "completed" || !terminalConclusion(attemptRun.conclusion)) {
        throw new Error("Earlier workflow attempt is not terminal.");
      }
      const jobs = await paginated(fetchImpl, options.token,
        `/repos/${options.repository}/actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs");
      assertUniqueRecords(jobs, "id", "Attempt-specific job history");
      validateAttemptJobs(jobs, runId, attempt, attemptRun.head_sha);
      const key = `${runId}/${attempt}`;
      const contract = incidentContracts.get(key) ?? null;
      const steps = jobs.flatMap((jobValue) => {
        const job = jobValue as { steps?: unknown };
        if (job.steps === undefined) return [];
        if (!Array.isArray(job.steps)) throw new Error("Attempt-specific job steps are malformed.");
        return job.steps as Array<Record<string, unknown>>;
      });
      if (evidenceKeys.has(key)) throw new Error("Attempt history contains duplicate run/attempt evidence.");
      evidenceKeys.add(key);
      if (contract && contract.workflowSha !== attemptRun.head_sha) throw new Error("Incident-bound workflow SHA does not match the requested attempt.");
      const incidentEvidence = contract ? collectIncidentEvidence(attemptRun, jobs, contract.collectorEvidence) : null;
      const legacyEvidence = collectLegacyEvidence(jobs, contract?.legacyEvidence ?? null);
      const receiptName = `lionlog-pages-receipt-${runId}-${attempt}`;
      const receiptArtifacts = artifacts.filter((artifactValue) => (artifactValue as Record<string, unknown>).name === receiptName);
      if (receiptArtifacts.length > 1) throw new Error("Attempt has ambiguous flat receipt artifacts.");
      const receipt = receiptArtifacts.length === 1
        ? await readReceipt(fetchImpl, options.token, options.repository, runId, attemptRun.head_sha, receiptArtifacts[0] as Record<string, unknown>)
        : null;
      evidence.push({
        runId,
        workflowId: number(attemptRun.workflow_id, "Attempt workflow ID"),
        workflowPath: string(attemptRun.path, "Attempt workflow path"),
        workflowSha: attemptRun.head_sha,
        event: string(attemptRun.event, "Attempt event"),
        headBranch: string(attemptRun.head_branch, "Attempt head branch"),
        runAttempt: attempt,
        status: string(attemptRun.status, "Attempt status"),
        conclusion: nullableString(attemptRun.conclusion, "Attempt conclusion"),
        jobsComplete: true,
        finalGateConclusion: stepConclusion(steps, "Recheck all authority immediately before submission"),
        submissionBoundaryConclusion: stepConclusion(steps, "Record official submission boundary"),
        deploymentConclusion: stepConclusion(steps, "Deploy with official Pages action"),
        incidentEvidence,
        legacyEvidence,
        receipt,
      });
    }
  }
  return evidence.sort((left, right) => left.runId - right.runId || left.runAttempt - right.runAttempt);
}

export function collectLegacyEvidence(jobs: unknown[], expected: LegacyAttemptEvidence | null): LegacyAttemptEvidence {
  if (expected === null) return { validationFailure: null, deploymentBoundary: null };
  return {
    validationFailure: expected.validationFailure === null ? null : collectExactLegacyStep(jobs, expected.validationFailure),
    deploymentBoundary: expected.deploymentBoundary === null ? null : collectExactLegacyStep(jobs, expected.deploymentBoundary),
  };
}

function collectExactLegacyStep(jobs: unknown[], expected: LegacyStepEvidence): LegacyStepEvidence {
  const matchingJobs = jobs.filter((value) => {
    const job = value as Record<string, unknown>;
    return job.id === expected.jobId || job.name === expected.jobName;
  });
  if (matchingJobs.length !== 1) throw new Error("Legacy incident job evidence is missing or ambiguous.");
  const job = matchingJobs[0] as Record<string, unknown>;
  if (job.id !== expected.jobId || job.name !== expected.jobName || job.status !== expected.jobStatus || job.conclusion !== expected.jobConclusion) {
    throw new Error("Legacy incident job evidence does not match its exact contract.");
  }
  if (!Array.isArray(job.steps)) throw new Error("Legacy incident job steps are malformed.");
  if (expected.stepNumber === null || expected.stepName === null) {
    if (expected.stepNumber !== null || expected.stepName !== null || job.steps.length !== 0) {
      throw new Error("Legacy skipped-job evidence does not match its exact contract.");
    }
    if (expected.stepStatus !== expected.jobStatus || expected.stepConclusion !== expected.jobConclusion) {
      throw new Error("Legacy skipped-job outcome does not match its exact contract.");
    }
    return { ...expected };
  }
  const matchingSteps = job.steps.filter((value) => {
    const step = value as Record<string, unknown>;
    return step.number === expected.stepNumber || step.name === expected.stepName;
  });
  if (matchingSteps.length !== 1) throw new Error("Legacy incident step evidence is missing or ambiguous.");
  const step = matchingSteps[0] as Record<string, unknown>;
  if (step.number !== expected.stepNumber || step.name !== expected.stepName || step.status !== expected.stepStatus || step.conclusion !== expected.stepConclusion) {
    throw new Error("Legacy incident step evidence does not match its exact contract.");
  }
  return { ...expected };
}

function collectIncidentEvidence(attempt: Record<string, unknown>, jobs: unknown[], expected: IncidentCollectionEvidence): IncidentCollectionEvidence {
  if (
    attempt.workflow_id !== expected.workflowId || attempt.path !== expected.workflowPath || attempt.event !== expected.event
    || attempt.head_branch !== expected.headBranch || attempt.status !== expected.status || attempt.conclusion !== expected.conclusion
  ) throw new Error("Incident workflow evidence does not match its exact contract.");
  if (jobs.length !== expected.jobs.length) throw new Error("Incident job graph does not match its exact contract.");
  const selectedJobs = expected.jobs.map((expectedJob, jobIndex) => {
    const job = jobs[jobIndex] as Record<string, unknown>;
    const jobSteps = job.steps;
    if (
      job.id !== expectedJob.jobId || job.run_id !== expectedJob.runId || job.run_attempt !== expectedJob.runAttempt
      || job.head_sha !== expectedJob.headSha || job.name !== expectedJob.jobName || job.status !== expectedJob.jobStatus
      || job.conclusion !== expectedJob.jobConclusion || !Array.isArray(jobSteps)
    ) throw new Error("Incident job evidence does not match its exact contract.");
    if (jobSteps.length !== expectedJob.steps.length) throw new Error("Incident step graph does not match its exact contract.");
    const selectedSteps = expectedJob.steps.map((expectedStep, stepIndex) => {
      const step = jobSteps[stepIndex] as Record<string, unknown>;
      if (
        step.number !== expectedStep.stepNumber || step.name !== expectedStep.stepName
        || step.status !== expectedStep.stepStatus || step.conclusion !== expectedStep.stepConclusion
      ) throw new Error("Incident step evidence does not match its exact contract.");
      return { ...expectedStep };
    });
    return { ...expectedJob, steps: selectedSteps };
  });
  return { ...expected, jobs: selectedJobs };
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

function parseIncidentContracts(value: unknown): Map<string, IncidentContract> {
  const history = value as { historyVersion?: unknown; incidents?: unknown };
  if (history?.historyVersion !== "lionlog.pages-incident-history.v1" || !Array.isArray(history.incidents)) {
    throw new Error("Pages incident history is invalid for attempt collection.");
  }
  const contracts = new Map<string, IncidentContract>();
  for (const value of history.incidents) {
    const incident = value as Record<string, unknown>;
    const runId = number(incident.runId, "Incident run ID");
    const runAttempt = number(incident.runAttempt, "Incident run attempt");
    const workflowSha = string(incident.workflowSha, "Incident workflow SHA");
    if (!GIT_SHA.test(workflowSha)) throw new Error("Incident workflow SHA is invalid.");
    const collectorEvidence = validateIncidentCollectionEvidence(incident.collectorEvidence, runId, runAttempt, workflowSha);
    const legacyEvidence = incident.outcome === "resolved-legacy-pre-submission-failure"
      ? validateLegacyEvidenceContract(incident.legacyEvidence)
      : null;
    if (legacyEvidence !== null && !legacyEvidenceMatchesCollection(legacyEvidence, collectorEvidence)) {
      throw new Error("Legacy incident evidence is not bound to its collector contract.");
    }
    const key = `${runId}/${runAttempt}`;
    if (contracts.has(key)) throw new Error("Pages incident history contains duplicate run/attempt contracts.");
    contracts.set(key, { runId, runAttempt, workflowSha, collectorEvidence, legacyEvidence });
  }
  return contracts;
}

function validateIncidentCollectionEvidence(value: unknown, runId: number, runAttempt: number, workflowSha: string): IncidentCollectionEvidence {
  const evidence = value as IncidentCollectionEvidence;
  if (
    !hasExactKeys(value, ["conclusion", "event", "headBranch", "jobs", "status", "workflowId", "workflowPath"])
    || evidence.workflowId !== PROMOTION_WORKFLOW_ID || evidence.workflowPath !== ".github/workflows/deploy-github-pages.yml"
    || evidence.event !== "workflow_dispatch" || evidence.headBranch !== "main" || evidence.status !== "completed"
    || !terminalConclusion(evidence.conclusion) || !Array.isArray(evidence.jobs) || evidence.jobs.length < 1
  ) throw new Error("Incident collection evidence is invalid.");
  const jobIds = new Set<number>();
  const jobNames = new Set<string>();
  for (const job of evidence.jobs) {
    if (
      !hasExactKeys(job, ["headSha", "jobConclusion", "jobId", "jobName", "jobStatus", "runAttempt", "runId", "steps"])
      || !positive(job.jobId) || job.runId !== runId || job.runAttempt !== runAttempt || job.headSha !== workflowSha
      || typeof job.jobName !== "string" || job.jobName.length < 1 || job.jobStatus !== "completed"
      || !terminalConclusion(job.jobConclusion) || !Array.isArray(job.steps)
      || jobIds.has(job.jobId) || jobNames.has(job.jobName)
    ) throw new Error("Incident job collection evidence is invalid or duplicate.");
    jobIds.add(job.jobId);
    jobNames.add(job.jobName);
    const stepNumbers = new Set<number>();
    const stepNames = new Set<string>();
    for (const step of job.steps) {
      if (
        !hasExactKeys(step, ["stepConclusion", "stepName", "stepNumber", "stepStatus"])
        || !positive(step.stepNumber) || typeof step.stepName !== "string" || step.stepName.length < 1
        || step.stepStatus !== "completed" || !terminalConclusion(step.stepConclusion)
        || stepNumbers.has(step.stepNumber) || stepNames.has(step.stepName)
      ) throw new Error("Incident step collection evidence is invalid or duplicate.");
      stepNumbers.add(step.stepNumber);
      stepNames.add(step.stepName);
    }
  }
  return evidence;
}

function validateLegacyEvidenceContract(value: unknown): LegacyAttemptEvidence {
  const evidence = value as LegacyAttemptEvidence;
  if (!hasExactKeys(value, ["deploymentBoundary", "validationFailure"])) throw new Error("Legacy incident evidence contract is invalid.");
  for (const step of [evidence.validationFailure, evidence.deploymentBoundary]) {
    if (step === null) continue;
    if (
      !hasExactKeys(step, ["jobConclusion", "jobId", "jobName", "jobStatus", "stepConclusion", "stepName", "stepNumber", "stepStatus"])
      || !positive(step.jobId) || typeof step.jobName !== "string" || step.jobName.length < 1 || step.jobStatus !== "completed"
      || !terminalConclusion(step.jobConclusion) || (step.stepNumber !== null && !positive(step.stepNumber))
      || (step.stepName !== null && (typeof step.stepName !== "string" || step.stepName.length < 1))
      || step.stepStatus !== "completed" || !terminalConclusion(step.stepConclusion)
    ) throw new Error("Legacy incident evidence contract is invalid.");
  }
  return evidence;
}

function legacyEvidenceMatchesCollection(legacy: LegacyAttemptEvidence, collection: IncidentCollectionEvidence): boolean {
  return [legacy.validationFailure, legacy.deploymentBoundary].every((step) => {
    if (step === null) return true;
    const job = collection.jobs.find((candidate) => candidate.jobId === step.jobId && candidate.jobName === step.jobName);
    if (!job || job.jobStatus !== step.jobStatus || job.jobConclusion !== step.jobConclusion) return false;
    if (step.stepNumber === null || step.stepName === null) {
      return step.stepNumber === null && step.stepName === null && job.steps.length === 0
        && step.stepStatus === job.jobStatus && step.stepConclusion === job.jobConclusion;
    }
    return job.steps.some((candidate) => candidate.stepNumber === step.stepNumber && candidate.stepName === step.stepName
      && candidate.stepStatus === step.stepStatus && candidate.stepConclusion === step.stepConclusion);
  });
}

function validateAttemptJobs(jobs: unknown[], runId: number, runAttempt: number, headSha: unknown): void {
  if (jobs.length < 1 || typeof headSha !== "string" || !GIT_SHA.test(headSha)) throw new Error("Attempt-specific job history is incomplete.");
  for (const value of jobs) {
    const job = value as Record<string, unknown>;
    if (
      number(job.run_id, "Job run ID") !== runId || number(job.run_attempt, "Job run attempt") !== runAttempt
      || job.head_sha !== headSha || job.status !== "completed" || !terminalConclusion(job.conclusion)
      || !Array.isArray(job.steps)
    ) throw new Error("Attempt-specific job identity or terminal state is invalid.");
    const stepNumbers = new Set<number>();
    for (const value of job.steps) {
      const step = value as Record<string, unknown>;
      const stepNumber = number(step.number, "Job step number");
      if (
        stepNumbers.has(stepNumber) || typeof step.name !== "string" || step.name.length < 1
        || step.status !== "completed" || !terminalConclusion(step.conclusion)
      ) throw new Error("Attempt-specific job step evidence is incomplete, duplicate, or nonterminal.");
      stepNumbers.add(stepNumber);
    }
  }
}

function assertUniqueRecords(values: unknown[], property: string, label: string): void {
  const seen = new Set<number>();
  for (const value of values) {
    const id = number((value as Record<string, unknown>)[property], `${label} identity`);
    if (seen.has(id)) throw new Error(`${label} contains duplicate evidence.`);
    seen.add(id);
  }
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
  if (matches[0].status !== "completed" || !terminalConclusion(matches[0].conclusion)) {
    throw new Error(`Attempt step evidence is nonterminal: ${name}`);
  }
  return matches[0].conclusion as string;
}

function terminalConclusion(value: unknown): value is string {
  return typeof value === "string" && TERMINAL_CONCLUSIONS.has(value);
}

function hasExactKeys(value: unknown, expected: string[]): boolean {
  return typeof value === "object" && value !== null
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
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
  const incidentPath = process.argv.find((argument) => argument.startsWith("--incidents="))?.slice("--incidents=".length);
  if (!output || !incidentPath) throw new Error("Attempt-history output or incident-history path is missing.");
  const incidentHistory = JSON.parse(await readFile(incidentPath, "utf8"));
  const evidence = await collectPagesAttemptHistory({ repository, currentRunId, token, incidentHistory });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
}
