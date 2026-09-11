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
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PROMOTION_WORKFLOW_ID = 347992874;
const PROMOTION_WORKFLOW_PATH = ".github/workflows/deploy-github-pages.yml";

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
  receiptArtifactDigest,
  approval,
  publicationDeployments,
  fetchImpl = fetch,
}) {
  if (!ARTIFACT_DIGEST.test(receiptArtifactDigest ?? "")) throw new Error("Pre-submission receipt digest is invalid.");
  if (!Array.isArray(publicationDeployments) || publicationDeployments.length !== 0) {
    throw new Error("Pre-submission reconciliation is invalid after a publication ledger was created.");
  }
  if (
    receipt.promotion?.workflowId !== PROMOTION_WORKFLOW_ID
    || receipt.promotion?.runAttempt !== 1
    || receipt.operation !== "promote"
    || receipt.releaseKind !== "live"
    || receipt.deploymentId !== null
    || receipt.pageUrl !== null
    || receipt.pagesAccepted !== false
    || receipt.pagesStatus !== "ledger-unavailable"
    || receipt.knownGood !== false
    || receipt.uncertain !== true
    || receipt.attemptPhase !== "submission-uncertain"
    || receipt.repositoryDeployment?.id !== null
    || receipt.repositoryDeployment?.state !== "unknown"
    || receipt.repositoryDeployment?.statusRecorded !== false
    || receipt.markerVerified !== false
    || receipt.publicProductVerified !== false
    || receipt.reconciliation?.outcome !== "submission-uncertain"
    || receipt.reconciliation?.publicReleaseId !== "NONE_404"
    || !Object.values(receipt.previous ?? {}).every((value) => value === "NONE_FIRST_DEPLOYMENT")
  ) throw new Error("Receipt is not the conservative pre-submission failure shape.");

  const run = await readJson(`${API_ROOT}/repos/${REPOSITORY}/actions/runs/${receipt.promotion.runId}`, token, fetchImpl, "Failed promotion run");
  if (
    run.id !== receipt.promotion.runId
    || run.workflow_id !== PROMOTION_WORKFLOW_ID
    || run.path !== PROMOTION_WORKFLOW_PATH
    || run.event !== "workflow_dispatch"
    || run.head_sha !== receipt.promotion.workflowSha
    || run.head_branch !== "main"
    || run.run_attempt !== 1
    || run.status !== "completed"
    || run.conclusion !== "failure"
  ) throw new Error("Failed promotion run provenance is inconsistent.");

  const environmentDeployments = await readDeploymentHistory({ token, task: "deploy", fetchImpl });
  const candidates = [];
  for (const deployment of environmentDeployments) {
    if (
      deployment.task !== "deploy"
      || deployment.environment !== PUBLICATION_ENVIRONMENT
      || deployment.sha !== receipt.promotion.workflowSha
      || deployment.ref !== "main"
      || deployment.payload === null
      || typeof deployment.payload !== "object"
      || Array.isArray(deployment.payload)
      || Object.keys(deployment.payload).length !== 0
    ) continue;
    const statuses = await readJson(`${API_ROOT}/repos/${REPOSITORY}/deployments/${deployment.id}/statuses?per_page=100`, token, fetchImpl, "Environment deployment statuses");
    if (!Array.isArray(statuses)) throw new Error("Environment deployment status collection is invalid.");
    const latest = statuses[0];
    const jobMatch = latest?.log_url?.match(new RegExp(`^https://github\\.com/${REPOSITORY}/actions/runs/${receipt.promotion.runId}/job/([1-9][0-9]*)$`));
    if (latest?.state !== "failure" || !jobMatch || pagesDeploymentIdFromLedgerStatus(latest, deployment.id) !== null) continue;
    const job = await readJson(`${API_ROOT}/repos/${REPOSITORY}/actions/jobs/${jobMatch[1]}`, token, fetchImpl, "Failed protected deployment job");
    if (
      job.id !== Number(jobMatch[1])
      || job.name !== "deploy"
      || job.run_id !== receipt.promotion.runId
      || job.head_sha !== receipt.promotion.workflowSha
      || job.status !== "completed"
      || job.conclusion !== "failure"
    ) throw new Error("Failed protected deployment job provenance is inconsistent.");
    candidates.push(deployment);
  }
  if (candidates.length !== 1) throw new Error("Pre-submission failure does not have one exact failed environment deployment.");
  const environmentDeployment = candidates[0];
  const latestEnvironmentId = environmentDeployments.reduce((latest, deployment) => Math.max(latest, deployment.id), 0);
  if (environmentDeployment.id !== latestEnvironmentId) throw new Error("Pre-submission failure is historical rather than current.");
  const expectedApproval = `RECONCILE_PRE_SUBMISSION:${receiptArtifactDigest}:${environmentDeployment.id}`;
  if (approval !== expectedApproval) throw new Error("Pre-submission failure lacks exact Project Manager reconciliation approval.");
  return { environmentDeploymentId: environmentDeployment.id };
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
