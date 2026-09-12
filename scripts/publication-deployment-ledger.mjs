const API_ROOT = "https://api.github.com";
const REPOSITORY = "CrunchyBrunch/lionlog";
export const PUBLICATION_DEPLOYMENT_TASK = "lionlog-pages-release";
export const PUBLICATION_ENVIRONMENT = "github-pages";
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const PAGES_ID = /^[A-Za-z0-9._-]{1,200}$/;
const TERMINAL_PAGES_FAILURES = new Set(["deployment_failed", "deployment_content_failed", "deployment_cancelled", "deployment_lost"]);
const DEPLOYMENT_PAGE_SIZE = 100;
const MAX_DEPLOYMENT_HISTORY_PAGES = 10;
const PROMOTION_WORKFLOW_ID = 347992874;
const PROMOTION_WORKFLOW_PATH = ".github/workflows/deploy-github-pages.yml";
const REVIEWED_PRE_SUBMISSION_INCIDENT = Object.freeze({
  runId: 34_609_219_734,
  runAttempt: 1,
  workflowSha: "3d5181c962486aa25345f4f16fbdd75932e0d831",
  jobId: 103_295_384_726,
  environmentDeploymentId: 6_394_978_446,
  environmentStatusId: 18_228_833_381,
  receiptArtifactId: 10_267_367_634,
  receiptArtifactDigest: "sha256:bf3c1430abf5bf1ebc8707e601b51f3776705cde507997ff3b606fcc88601874",
  receipt: {
    receiptVersion: "lionlog.pages-deployment-receipt.v3",
    recordedAt: "2026-09-11T14:18:57Z",
    operation: "promote",
    releaseId: "7dce94463a4d87541812eda2d500baefead34e4a5394f82d95baa10163d1cec1",
    releaseKind: "live",
    deploymentId: null,
    pageUrl: null,
    previous: {
      knownGoodReleaseId: "NONE_FIRST_DEPLOYMENT",
      knownGoodRepositoryDeploymentId: "NONE_FIRST_DEPLOYMENT",
      knownGoodPagesDeploymentId: "NONE_FIRST_DEPLOYMENT",
    },
    promotion: {
      workflowId: PROMOTION_WORKFLOW_ID,
      workflowSha: "3d5181c962486aa25345f4f16fbdd75932e0d831",
      runId: 34_609_219_734,
      runAttempt: 1,
      approvalExpiresAt: "2026-09-11T16:00:00Z",
    },
    source: {
      artifactId: 10_266_588_499,
      artifactDigest: "sha256:8667efc4e8b7603ec034d60715b4359d8c737b6aedfef2ff29a926b4ba0c30e2",
      manifestSha256: "99858cf98e0330aa2018460051154c5245404a8efdd9e001780d8b7634fbcd4c",
      siteTarSha256: "6d798e96e932ecb5b51cb22fd158bc370dd4e786de2f67e72b16fa4667ab752a",
      recoveryArtifactId: 10_267_140_347,
      recoveryArtifactDigest: "sha256:83a47e669a5542ab86496c20ce39931b0a07b3d261d8fbed0dbbed81a503c5dd",
      recoveryManifestSha256: "eecf7e52423789cd16a1b1a7bb44ffd97fff2c4acca6818cf6928455e8fdcd0e",
    },
    recovery: {
      releaseId: "0c39c8f56df6d0d9b72ff644fd7d7fb98c78af28f4f5e700ec6f639340d53d95",
      manifestSha256: "eecf7e52423789cd16a1b1a7bb44ffd97fff2c4acca6818cf6928455e8fdcd0e",
      artifactId: 10_267_140_347,
      artifactDigest: "sha256:83a47e669a5542ab86496c20ce39931b0a07b3d261d8fbed0dbbed81a503c5dd",
    },
    staged: {
      artifactId: 10_267_282_434,
      artifactDigest: "sha256:bc6a29288377cfb9f46a238a9094185e9fb095077d63addde162402991e80ae0",
      artifactExpiresAt: "2026-12-10T14:17:12Z",
    },
    attemptPhase: "submission-uncertain",
    repositoryDeployment: { id: null, state: "unknown", statusRecorded: false },
    pagesAccepted: false,
    pagesStatus: "ledger-unavailable",
    markerVerified: false,
    publicProductVerified: false,
    reconciliation: { outcome: "submission-uncertain", publicReleaseId: "UNKNOWN" },
    knownGood: false,
    uncertain: true,
  },
});
const REVIEWED_INCIDENT_STEPS = [
  [1, "Set up job", "completed", "success"],
  [2, "Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "completed", "success"],
  [3, "Re-download the exact retained approval summary", "completed", "success"],
  [4, "Download exact source and recovery wrappers after protected approval", "completed", "success"],
  [5, "Re-download and identify the exact staged artifact", "completed", "success"],
  [6, "Re-download current-attempt and rollback-target receipts after approval", "completed", "success"],
  [7, "Perform final provenance, state, deadline, and freshness checks", "completed", "failure"],
  [8, "Deploy exact staged artifact", "completed", "skipped"],
  [9, "Preserve deployment attempt evidence", "completed", "skipped"],
  [18, "Post Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "completed", "success"],
  [19, "Complete job", "completed", "success"],
];

export function publicationLedgerPayload({ promotionRunId, runAttempt, releaseId, sourceArtifactId, stagedArtifactId }) {
  const payload = {
    schemaVersion: "lionlog.repository-deployment.v1",
    promotionRunId,
    runAttempt,
    releaseId,
    sourceArtifactId,
    stagedArtifactId,
  };
  validatePayload(payload);
  return payload;
}

export async function createRepositoryDeploymentLedger({ token, workflowSha, payload, fetchImpl = fetch }) {
  if (!GIT_SHA.test(workflowSha)) throw new Error("Repository deployment ledger SHA is invalid.");
  validatePayload(payload);
  const response = await fetchImpl(`${API_ROOT}/repos/${REPOSITORY}/deployments`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: apiHeaders(token),
    body: JSON.stringify({
      ref: workflowSha,
      task: PUBLICATION_DEPLOYMENT_TASK,
      auto_merge: false,
      required_contexts: [],
      payload,
      environment: PUBLICATION_ENVIRONMENT,
      description: `LionLog release ${payload.releaseId.slice(0, 12)}`,
      transient_environment: false,
      production_environment: true,
    }),
  });
  if (!response.ok || response.redirected || response.status !== 201) {
    throw new Error(`Repository deployment ledger creation outcome is uncertain (HTTP ${response.status}).`);
  }
  const deployment = await response.json();
  validateDeployment(deployment, { workflowSha, payload });
  return deployment.id;
}

export async function recordRepositoryDeploymentStatus({ token, repositoryDeploymentId, state, pagesDeploymentId = null, runId, fetchImpl = fetch }) {
  if (!Number.isSafeInteger(repositoryDeploymentId) || repositoryDeploymentId <= 0) throw new Error("Repository deployment ID is invalid.");
  if (!new Set(["pending", "in_progress", "success", "failure", "error"]).has(state)) throw new Error("Repository deployment state is invalid.");
  if (pagesDeploymentId !== null && !PAGES_ID.test(pagesDeploymentId)) throw new Error("Pages deployment ID is invalid.");
  const logUrl = pagesDeploymentId === null
    ? `https://github.com/${REPOSITORY}/actions/runs/${runId}`
    : `${API_ROOT}/repos/${REPOSITORY}/pages/deployments/${pagesDeploymentId}`;
  const response = await fetchImpl(`${API_ROOT}/repos/${REPOSITORY}/deployments/${repositoryDeploymentId}/statuses`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: apiHeaders(token),
    body: JSON.stringify({
      state,
      log_url: logUrl,
      environment: PUBLICATION_ENVIRONMENT,
      environment_url: state === "success" ? "https://crunchybrunch.github.io/lionlog/" : "",
      description: pagesDeploymentId === null ? "LionLog publication attempt" : `Pages deployment ${pagesDeploymentId}`,
      auto_inactive: state === "success",
    }),
  });
  if (!response.ok || response.redirected || response.status !== 201) throw new Error(`Repository deployment status was not recorded (HTTP ${response.status}).`);
  const status = await response.json();
  if (status?.state !== state || status?.deployment_url !== `${API_ROOT}/repos/${REPOSITORY}/deployments/${repositoryDeploymentId}`) {
    throw new Error("Repository deployment status response is inconsistent.");
  }
  return status;
}

export async function readRepositoryDeploymentAuthority({ token, receipt, requireCurrent = true, fetchImpl = fetch }) {
  const deployments = await readRepositoryDeploymentHistory({ token, fetchImpl });
  if (receipt === null) return { deployments, current: null, status: null, pagesStatus: null };
  const expectedPayload = publicationLedgerPayload({
    promotionRunId: receipt.promotion.runId,
    runAttempt: receipt.promotion.runAttempt,
    releaseId: receipt.releaseId,
    sourceArtifactId: receipt.source.artifactId,
    stagedArtifactId: receipt.staged.artifactId,
  });
  let expectedId = receipt.repositoryDeployment?.id;
  if (expectedId === null) {
    const candidates = deployments.filter((deployment) => samePayload(deployment?.payload, expectedPayload));
    if (candidates.length > 1) throw new Error("Current attempt has ambiguous repository deployment ledger entries.");
    if (candidates.length === 0) throw new Error("Current attempt has no exact repository deployment ledger match.");
    expectedId = candidates[0].id;
  }
  if (!Number.isSafeInteger(expectedId) || expectedId <= 0) throw new Error("Current attempt lacks a repository deployment identity.");
  const latestDeploymentId = deployments.reduce((latest, deployment) => Math.max(latest, deployment.id), 0);
  if (requireCurrent && latestDeploymentId !== expectedId) throw new Error("Expected repository deployment is historical rather than current.");
  const deployment = await readJson(`${API_ROOT}/repos/${REPOSITORY}/deployments/${expectedId}`, token, fetchImpl, "Repository deployment");
  validateDeployment(deployment, {
    workflowSha: receipt.promotion.workflowSha,
    payload: expectedPayload,
  });
  const statuses = await readJson(`${API_ROOT}/repos/${REPOSITORY}/deployments/${expectedId}/statuses?per_page=100`, token, fetchImpl, "Repository deployment statuses");
  if (!Array.isArray(statuses)) throw new Error("Repository deployment status collection is invalid.");
  const latest = statuses[0] ?? null;
  if (latest !== null && !new Set(["pending", "in_progress", "success", "failure", "error"]).has(latest?.state)) throw new Error("Repository deployment status is invalid.");
  const ledgerPagesDeploymentId = statuses.map((status) => pagesDeploymentIdFromLedgerStatus(status, deployment.id)).find((value) => value !== null) ?? null;
  if (receipt.deploymentId !== null && ledgerPagesDeploymentId !== null && receipt.deploymentId !== ledgerPagesDeploymentId) {
    throw new Error("Receipt and repository ledger disagree on the Pages deployment ID.");
  }
  const pagesDeploymentId = receipt.deploymentId ?? ledgerPagesDeploymentId;
  let pagesStatus = null;
  if (pagesDeploymentId !== null) {
    pagesStatus = await readJson(`${API_ROOT}/repos/${REPOSITORY}/pages/deployments/${pagesDeploymentId}`, token, fetchImpl, "Pages deployment status");
    if (typeof pagesStatus?.status !== "string") throw new Error("Pages deployment status is invalid.");
  }
  return { deployments, current: deployment, status: latest, pagesStatus, pagesDeploymentId };
}

export async function verifyPreSubmissionFailure({
  token,
  receipt,
  receiptArtifactId,
  receiptArtifactDigest,
  approval,
  publicationDeployments,
  currentPromotion = null,
  fetchImpl = fetch,
}) {
  const incident = REVIEWED_PRE_SUBMISSION_INCIDENT;
  if (receiptArtifactId !== incident.receiptArtifactId || receiptArtifactDigest !== incident.receiptArtifactDigest) {
    throw new Error("Pre-submission receipt artifact is not the reviewed incident artifact.");
  }
  if (!Array.isArray(publicationDeployments) || publicationDeployments.length !== 0) {
    throw new Error("Pre-submission reconciliation is invalid after a publication ledger was created.");
  }
  if (canonicalJson(receipt) !== canonicalJson(incident.receipt)) {
    throw new Error("Receipt does not exactly match the reviewed pre-submission incident.");
  }

  const artifact = await readJson(`${API_ROOT}/repos/${REPOSITORY}/actions/artifacts/${incident.receiptArtifactId}`, token, fetchImpl, "Reviewed incident receipt artifact");
  if (
    artifact.id !== incident.receiptArtifactId
    || artifact.name !== `lionlog-deployment-receipt-${incident.runId}-${incident.runAttempt}`
    || artifact.digest !== incident.receiptArtifactDigest
    || artifact.expired !== false
    || artifact.workflow_run?.id !== incident.runId
    || artifact.workflow_run?.head_sha !== incident.workflowSha
    || artifact.workflow_run?.head_branch !== "main"
    || artifact.workflow_run?.head_repository_id !== 1_346_360_244
  ) throw new Error("Reviewed incident receipt artifact provenance is inconsistent.");

  const run = await readJson(`${API_ROOT}/repos/${REPOSITORY}/actions/runs/${incident.runId}`, token, fetchImpl, "Reviewed failed promotion run");
  if (
    run.id !== incident.runId
    || run.workflow_id !== PROMOTION_WORKFLOW_ID
    || run.path !== PROMOTION_WORKFLOW_PATH
    || run.event !== "workflow_dispatch"
    || run.head_sha !== incident.workflowSha
    || run.head_branch !== "main"
    || run.run_attempt !== incident.runAttempt
    || run.status !== "completed"
    || run.conclusion !== "failure"
  ) throw new Error("Reviewed failed promotion run provenance is inconsistent.");

  const failedJob = await readJson(`${API_ROOT}/repos/${REPOSITORY}/actions/jobs/${incident.jobId}`, token, fetchImpl, "Reviewed failed protected deployment job");
  validateReviewedIncidentJob(failedJob, incident);

  const environmentDeployments = await readDeploymentHistory({ token, task: "deploy", fetchImpl });
  const incidentMatches = environmentDeployments.filter((deployment) => deployment.id === incident.environmentDeploymentId);
  if (incidentMatches.length !== 1) throw new Error("Reviewed incident environment deployment is missing or ambiguous.");
  const incidentDeployment = await readJson(`${API_ROOT}/repos/${REPOSITORY}/deployments/${incident.environmentDeploymentId}`, token, fetchImpl, "Reviewed incident environment deployment");
  validateAutomaticEnvironmentDeployment(incidentDeployment, incident.workflowSha);
  const incidentStatuses = await readBoundedStatuses(incident.environmentDeploymentId, token, fetchImpl);
  const incidentJobUrl = `https://github.com/${REPOSITORY}/actions/runs/${incident.runId}/job/${incident.jobId}`;
  const incidentStatus = incidentStatuses[0];
  if (
    incidentStatus?.id !== incident.environmentStatusId
    || incidentStatus.state !== "failure"
    || incidentStatus.environment !== PUBLICATION_ENVIRONMENT
    || incidentStatus.deployment_url !== `${API_ROOT}/repos/${REPOSITORY}/deployments/${incident.environmentDeploymentId}`
    || incidentStatus.log_url !== incidentJobUrl
    || incidentStatus.target_url !== incidentJobUrl
  ) throw new Error("Reviewed incident environment deployment status is inconsistent.");

  const newer = environmentDeployments.filter((deployment) => deployment.id > incident.environmentDeploymentId);
  if (currentPromotion === null) {
    if (newer.length !== 0) throw new Error("Reviewed incident has an unbound newer environment deployment.");
  } else {
    if (newer.length !== 1) throw new Error("Current promotion does not have one exact newer environment deployment.");
    await validateCurrentPromotionEnvironment({ token, currentPromotion, deployment: newer[0], fetchImpl });
  }
  const expectedApproval = `RECONCILE_PRE_SUBMISSION:${incident.receiptArtifactDigest}:${incident.environmentDeploymentId}`;
  if (approval !== expectedApproval) throw new Error("Pre-submission failure lacks exact Project Manager reconciliation approval.");
  return { environmentDeploymentId: incident.environmentDeploymentId };
}

function validateReviewedIncidentJob(job, incident) {
  if (
    job.id !== incident.jobId
    || job.name !== "deploy"
    || job.run_id !== incident.runId
    || job.run_attempt !== incident.runAttempt
    || job.workflow_name !== "Promote exact LionLog release to GitHub Pages"
    || job.head_sha !== incident.workflowSha
    || job.status !== "completed"
    || job.conclusion !== "failure"
    || !Array.isArray(job.steps)
    || job.steps.length !== REVIEWED_INCIDENT_STEPS.length
  ) throw new Error("Reviewed failed protected deployment job provenance is inconsistent.");
  const actual = job.steps.map((step) => [step.number, step.name, step.status, step.conclusion]);
  if (canonicalJson(actual) !== canonicalJson(REVIEWED_INCIDENT_STEPS)) {
    throw new Error("Reviewed failed job no longer proves the Pages submission step was skipped.");
  }
}

async function validateCurrentPromotionEnvironment({ token, currentPromotion, deployment, fetchImpl }) {
  if (
    !Number.isSafeInteger(currentPromotion.runId)
    || currentPromotion.runId <= 0
    || currentPromotion.runAttempt !== 1
    || !GIT_SHA.test(currentPromotion.workflowSha ?? "")
    || currentPromotion.job !== "deploy"
  ) throw new Error("Current promotion job identity is invalid.");
  const run = await readJson(`${API_ROOT}/repos/${REPOSITORY}/actions/runs/${currentPromotion.runId}`, token, fetchImpl, "Current promotion run");
  if (
    run.id !== currentPromotion.runId
    || run.workflow_id !== PROMOTION_WORKFLOW_ID
    || run.path !== PROMOTION_WORKFLOW_PATH
    || run.event !== "workflow_dispatch"
    || run.head_sha !== currentPromotion.workflowSha
    || run.head_branch !== "main"
    || run.run_attempt !== 1
    || run.status !== "in_progress"
    || run.conclusion !== null
  ) throw new Error("Current promotion run provenance is inconsistent.");
  const jobsResult = await readJson(`${API_ROOT}/repos/${REPOSITORY}/actions/runs/${currentPromotion.runId}/jobs?filter=all&per_page=100`, token, fetchImpl, "Current promotion jobs");
  if (!Number.isSafeInteger(jobsResult?.total_count) || !Array.isArray(jobsResult.jobs) || jobsResult.total_count !== jobsResult.jobs.length || jobsResult.jobs.length >= 100) {
    throw new Error("Current promotion job collection is incomplete or invalid.");
  }
  const jobs = jobsResult.jobs.filter((job) => job.name === "deploy" && job.run_id === currentPromotion.runId && job.run_attempt === 1);
  if (jobs.length !== 1) throw new Error("Current promotion protected job is missing or ambiguous.");
  const job = jobs[0];
  if (job.head_sha !== currentPromotion.workflowSha || job.status !== "in_progress" || job.conclusion !== null) {
    throw new Error("Current promotion protected job state is inconsistent.");
  }
  const exactDeployment = await readJson(`${API_ROOT}/repos/${REPOSITORY}/deployments/${deployment.id}`, token, fetchImpl, "Current promotion environment deployment");
  validateAutomaticEnvironmentDeployment(exactDeployment, currentPromotion.workflowSha);
  const statuses = await readBoundedStatuses(deployment.id, token, fetchImpl);
  const jobUrl = `https://github.com/${REPOSITORY}/actions/runs/${currentPromotion.runId}/job/${job.id}`;
  const latest = statuses[0];
  if (
    latest?.state !== "in_progress"
    || latest.environment !== PUBLICATION_ENVIRONMENT
    || latest.deployment_url !== `${API_ROOT}/repos/${REPOSITORY}/deployments/${deployment.id}`
    || latest.log_url !== jobUrl
    || latest.target_url !== jobUrl
  ) throw new Error("Current promotion environment deployment is not bound to its protected job.");
}

function validateAutomaticEnvironmentDeployment(deployment, workflowSha) {
  if (
    !Number.isSafeInteger(deployment?.id)
    || deployment.id <= 0
    || deployment.task !== "deploy"
    || deployment.environment !== PUBLICATION_ENVIRONMENT
    || deployment.original_environment !== PUBLICATION_ENVIRONMENT
    || deployment.sha !== workflowSha
    || deployment.ref !== "main"
    || canonicalJson(deployment.payload) !== "{}"
    || deployment.transient_environment !== false
    || deployment.production_environment !== false
    || deployment.performed_via_github_app?.id !== 15_368
    || deployment.performed_via_github_app?.slug !== "github-actions"
  ) throw new Error("Automatic environment deployment identity is inconsistent.");
}

async function readBoundedStatuses(deploymentId, token, fetchImpl) {
  const statuses = await readJson(`${API_ROOT}/repos/${REPOSITORY}/deployments/${deploymentId}/statuses?per_page=100`, token, fetchImpl, "Environment deployment statuses");
  if (!Array.isArray(statuses) || statuses.length === 0 || statuses.length >= 100) throw new Error("Environment deployment status collection is incomplete or invalid.");
  const ids = statuses.map((status) => status?.id);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new Error("Environment deployment status collection contains invalid or duplicate identities.");
  }
  return statuses;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function pagesDeploymentIdFromLedgerStatus(status, repositoryDeploymentId) {
  const expectedPrefix = `${API_ROOT}/repos/${REPOSITORY}/pages/deployments/`;
  if (status?.deployment_url !== `${API_ROOT}/repos/${REPOSITORY}/deployments/${repositoryDeploymentId}`) return null;
  if (typeof status.log_url !== "string" || !status.log_url.startsWith(expectedPrefix)) return null;
  const id = status.log_url.slice(expectedPrefix.length);
  return PAGES_ID.test(id) ? id : null;
}

export async function recoverRepositoryDeploymentAttempt({ token, expectedPayload, expectedWorkflowSha, fetchImpl = fetch, now = () => Date.now() }) {
  validatePayload(expectedPayload);
  if (!GIT_SHA.test(expectedWorkflowSha)) throw new Error("Expected promotion workflow SHA is invalid.");
  const deployments = await readRepositoryDeploymentHistory({ token, fetchImpl });
  const candidates = deployments.filter((deployment) => samePayload(deployment?.payload, expectedPayload));
  if (candidates.length !== 1) throw new Error("Publication attempt does not have one exact repository deployment ledger entry.");
  const summary = candidates[0];
  const deployment = await readJson(`${API_ROOT}/repos/${REPOSITORY}/deployments/${summary.id}`, token, fetchImpl, "Repository deployment");
  validateDeployment(deployment, { workflowSha: expectedWorkflowSha, payload: expectedPayload });
  const statuses = await readJson(`${API_ROOT}/repos/${REPOSITORY}/deployments/${deployment.id}/statuses?per_page=100`, token, fetchImpl, "Repository deployment statuses");
  if (!Array.isArray(statuses)) throw new Error("Repository deployment status collection is invalid.");
  const latest = statuses[0] ?? null;
  if (latest !== null && !new Set(["pending", "in_progress", "success", "failure", "error"]).has(latest?.state)) throw new Error("Repository deployment status is invalid.");
  const pagesDeploymentId = statuses.map((status) => pagesDeploymentIdFromLedgerStatus(status, deployment.id)).find((value) => value !== null) ?? null;
  let pagesStatus = null;
  if (pagesDeploymentId !== null) {
    const pages = await readJson(`${API_ROOT}/repos/${REPOSITORY}/pages/deployments/${pagesDeploymentId}`, token, fetchImpl, "Pages deployment status");
    if (typeof pages?.status !== "string") throw new Error("Pages deployment status is invalid.");
    pagesStatus = pages.status;
  }
  const terminal = pagesStatus === "succeed" || TERMINAL_PAGES_FAILURES.has(pagesStatus);
  return {
    attempt: {
      phase: terminal ? "terminal" : pagesDeploymentId === null ? "submission-uncertain" : "status-uncertain",
      artifactId: expectedPayload.stagedArtifactId,
      buildVersion: deployment.sha,
      repositoryDeploymentId: deployment.id,
      deploymentId: pagesDeploymentId,
      status: pagesStatus ?? latest?.state ?? "ledger-created",
      uncertain: !terminal,
      recordedAt: new Date(now()).toISOString(),
    },
    repositoryState: latest?.state ?? "pending",
    repositoryStatusRecorded: latest !== null,
  };
}

export async function readRepositoryDeploymentHistory({ token, fetchImpl = fetch }) {
  return readDeploymentHistory({ token, task: PUBLICATION_DEPLOYMENT_TASK, fetchImpl });
}

async function readDeploymentHistory({ token, task, fetchImpl }) {
  const deployments = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_DEPLOYMENT_HISTORY_PAGES; page += 1) {
    const values = await readJson(
      `${API_ROOT}/repos/${REPOSITORY}/deployments?task=${encodeURIComponent(task)}&environment=${encodeURIComponent(PUBLICATION_ENVIRONMENT)}&per_page=${DEPLOYMENT_PAGE_SIZE}&page=${page}`,
      token,
      fetchImpl,
      `Repository deployment collection page ${page}`,
    );
    if (!Array.isArray(values)) throw new Error("Repository deployment collection is invalid.");
    for (const deployment of values) {
      if (!Number.isSafeInteger(deployment?.id) || deployment.id <= 0 || seen.has(deployment.id)) {
        throw new Error("Repository deployment history contains an invalid or duplicate identity.");
      }
      seen.add(deployment.id);
      deployments.push(deployment);
    }
    if (values.length < DEPLOYMENT_PAGE_SIZE) return deployments;
  }
  throw new Error(`Repository deployment history exceeds the ${MAX_DEPLOYMENT_HISTORY_PAGES * DEPLOYMENT_PAGE_SIZE}-entry verification bound.`);
}

function validateDeployment(value, { workflowSha, payload }) {
  if (
    !Number.isSafeInteger(value?.id)
    || value.id <= 0
    || value.sha !== workflowSha
    || value.task !== PUBLICATION_DEPLOYMENT_TASK
    || value.environment !== PUBLICATION_ENVIRONMENT
    || value.transient_environment !== false
    || value.production_environment !== true
    || !samePayload(value.payload, payload)
  ) throw new Error("Repository deployment identity is inconsistent.");
}

function samePayload(actual, expected) {
  return actual !== null
    && typeof actual === "object"
    && !Array.isArray(actual)
    && Object.keys(actual).sort().join("\0") === Object.keys(expected).sort().join("\0")
    && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function validatePayload(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== ["promotionRunId", "releaseId", "runAttempt", "schemaVersion", "sourceArtifactId", "stagedArtifactId"].sort().join("\0")
    || value.schemaVersion !== "lionlog.repository-deployment.v1"
    || !Number.isSafeInteger(value.promotionRunId)
    || value.promotionRunId <= 0
    || value.runAttempt !== 1
    || !SHA256.test(value.releaseId)
    || !Number.isSafeInteger(value.sourceArtifactId)
    || value.sourceArtifactId <= 0
    || !Number.isSafeInteger(value.stagedArtifactId)
    || value.stagedArtifactId <= 0
  ) throw new Error("Repository deployment payload is invalid.");
}

async function readJson(url, token, fetchImpl, label) {
  const response = await fetchImpl(url, { headers: apiHeaders(token), redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || response.redirected) throw new Error(`${label} is unavailable (HTTP ${response.status}).`);
  try { return await response.json(); } catch (error) { throw new Error(`${label} response is invalid.`, { cause: error }); }
}

function apiHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}
