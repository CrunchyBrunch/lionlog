import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createRepositoryDeploymentLedger,
  publicationLedgerPayload,
  recordRepositoryDeploymentStatus,
} from "./publication-deployment-ledger.mjs";
import { executeFinalPromotionGate, readFinalPromotionState } from "./final-promotion-gate.mjs";
import { verifyCurrentPublication } from "./verify-current-publication.mjs";
import { readReleaseManifestFromEnvironment } from "./publication-environment-contract.mjs";
import { verifyProtectedAdapterBundle } from "./verify-publication-bundle.ts";

const REPOSITORY = "CrunchyBrunch/lionlog";
const API_ROOT = "https://api.github.com";
const TERMINAL_FAILURES = new Set(["deployment_failed", "deployment_content_failed", "deployment_cancelled", "deployment_lost"]);

export async function deployExactPagesArtifact({
  artifactId,
  buildVersion,
  environment = "github-pages",
  githubToken,
  oidcToken,
  fetchImpl = fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 10 * 60_000,
  approvalExpiresAt,
  minimumFreshUntil = undefined,
  repositoryDeploymentId,
  now = () => Date.now(),
  recordAttempt = async (value) => { void value; },
  recordAccepted = async (value) => { void value; },
}) {
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw new Error("Pages artifact ID is invalid.");
  if (!/^[a-f0-9]{40}$/.test(buildVersion)) throw new Error("Pages build version must be an exact Git SHA.");
  if (environment !== "github-pages") throw new Error("Unexpected Pages environment.");
  if (!Number.isSafeInteger(repositoryDeploymentId) || repositoryDeploymentId <= 0) throw new Error("Repository deployment ledger ID is invalid.");
  const evidence = (value) => ({ ...value, repositoryDeploymentId });
  const assertTemporalAuthorization = () => {
    const current = now();
    if (!Number.isFinite(Date.parse(approvalExpiresAt ?? "")) || Date.parse(approvalExpiresAt) <= current) {
      throw new Error("Pages approval expired before submission.");
    }
    if (minimumFreshUntil && Date.parse(minimumFreshUntil) < current + 15 * 60_000) {
      throw new Error("Live release freshness margin elapsed before submission.");
    }
  };
  const assertBeforeSubmission = async () => {
    try {
      assertTemporalAuthorization();
    } catch (error) {
      await recordAttempt(evidence({
        phase: "submission-rejected",
        artifactId,
        buildVersion,
        deploymentId: null,
        status: "authorization-expired",
        uncertain: false,
        recordedAt: new Date(now()).toISOString(),
      }));
      throw error;
    }
  };
  await assertBeforeSubmission();
  await recordAttempt(evidence({ phase: "submitting", artifactId, buildVersion, deploymentId: null, status: null, uncertain: true, recordedAt: new Date(now()).toISOString() }));
  await assertBeforeSubmission();
  let response;
  try {
    response = await fetchImpl(`${API_ROOT}/repos/${REPOSITORY}/pages/deployments`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: apiHeaders(githubToken),
      body: JSON.stringify({
        artifact_id: artifactId,
        pages_build_version: buildVersion,
        oidc_token: oidcToken,
        environment,
      }),
    });
  } catch (error) {
    await recordAttempt(evidence({ phase: "submission-uncertain", artifactId, buildVersion, deploymentId: null, status: null, uncertain: true, recordedAt: new Date(now()).toISOString() }));
    throw new Error("Pages deployment submission outcome is uncertain; reconcile before any retry.", { cause: error });
  }
  if (!response.ok || response.redirected) {
    const uncertain = response.redirected || response.status >= 500 || new Set([408, 409, 425, 429]).has(response.status);
    await recordAttempt(evidence({
      phase: uncertain ? "submission-uncertain" : "submission-rejected",
      artifactId,
      buildVersion,
      deploymentId: null,
      status: `http-${response.status}`,
      uncertain,
      recordedAt: new Date(now()).toISOString(),
    }));
    throw new Error(uncertain
      ? `Pages deployment submission returned HTTP ${response.status}; its outcome is uncertain and must be reconciled before retrying.`
      : `Pages deployment submission was rejected with HTTP ${response.status}.`);
  }
  let created;
  try { created = await response.json(); } catch (error) {
    await recordAttempt(evidence({ phase: "submission-uncertain", artifactId, buildVersion, deploymentId: null, status: "invalid-response", uncertain: true, recordedAt: new Date(now()).toISOString() }));
    throw new Error("Pages deployment submission response was unreadable; reconcile before retrying.", { cause: error });
  }
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(created?.id ?? "")) {
    await recordAttempt(evidence({ phase: "submission-uncertain", artifactId, buildVersion, deploymentId: null, status: "missing-deployment-id", uncertain: true, recordedAt: new Date(now()).toISOString() }));
    throw new Error("Pages deployment response omitted a safe deployment ID; reconcile before retrying.");
  }
  await recordAttempt(evidence({ phase: "accepted", artifactId, buildVersion, deploymentId: created.id, status: "accepted", uncertain: true, recordedAt: new Date(now()).toISOString() }));
  const statusUrl = new URL(created.status_url ?? "", API_ROOT);
  if (statusUrl.origin !== API_ROOT || statusUrl.pathname !== `/repos/${REPOSITORY}/pages/deployments/${created.id}/status`) {
    throw new Error("Pages deployment returned an unexpected status URL.");
  }
  await recordAccepted({ repositoryDeploymentId, pagesDeploymentId: created.id });
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await wait(5_000);
    let statusResponse;
    try {
      statusResponse = await fetchImpl(statusUrl, { headers: apiHeaders(githubToken), redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      await recordAttempt(evidence({ phase: "status-uncertain", artifactId, buildVersion, deploymentId: created.id, status: "request-failed", uncertain: true, recordedAt: new Date(now()).toISOString() }));
      throw new Error(`Pages deployment ${created.id} status request failed; reconcile before retrying.`, { cause: error });
    }
    if (!statusResponse.ok || statusResponse.redirected) {
      await recordAttempt(evidence({ phase: "status-uncertain", artifactId, buildVersion, deploymentId: created.id, status: `http-${statusResponse.status}`, uncertain: true, recordedAt: new Date(now()).toISOString() }));
      throw new Error(`Pages deployment ${created.id} status became unavailable; reconcile before retrying.`);
    }
    let status;
    try { status = (await statusResponse.json())?.status; } catch (error) {
      await recordAttempt(evidence({ phase: "status-uncertain", artifactId, buildVersion, deploymentId: created.id, status: "invalid-response", uncertain: true, recordedAt: new Date(now()).toISOString() }));
      throw new Error(`Pages deployment ${created.id} status response was unreadable; reconcile before retrying.`, { cause: error });
    }
    if (status === "succeed") {
      await recordAttempt(evidence({ phase: "terminal", artifactId, buildVersion, deploymentId: created.id, status, uncertain: true, recordedAt: new Date(now()).toISOString() }));
      const pageUrl = new URL(created.page_url);
      if (
        pageUrl.origin !== "https://crunchybrunch.github.io"
        || pageUrl.pathname !== "/lionlog/"
        || pageUrl.search !== ""
        || pageUrl.hash !== ""
      ) {
        throw new Error("Pages deployment returned an unexpected public URL.");
      }
      await recordAttempt(evidence({ phase: "terminal", artifactId, buildVersion, deploymentId: created.id, status, uncertain: false, recordedAt: new Date(now()).toISOString() }));
      return { deploymentId: created.id, pageUrl: pageUrl.href, status };
    }
    if (TERMINAL_FAILURES.has(status)) {
      await recordAttempt(evidence({ phase: "terminal", artifactId, buildVersion, deploymentId: created.id, status, uncertain: false, recordedAt: new Date(now()).toISOString() }));
      throw new Error(`Pages deployment ${created.id} failed with status ${status}.`);
    }
  }
  await recordAttempt(evidence({ phase: "status-uncertain", artifactId, buildVersion, deploymentId: created.id, status: "timeout", uncertain: true, recordedAt: new Date(now()).toISOString() }));
  throw new Error(`Pages deployment ${created.id} status timed out; reconcile before retrying.`);
}

export async function requestOidcToken({ requestUrl, requestToken, fetchImpl = fetch }) {
  const url = new URL(requestUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".actions.githubusercontent.com")) {
    throw new Error("OIDC request URL is not a GitHub Actions endpoint.");
  }
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${requestToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.redirected) throw new Error("GitHub OIDC token request failed.");
  const value = (await response.json())?.value;
  if (typeof value !== "string" || value.length < 20) throw new Error("GitHub OIDC token response was invalid.");
  return value;
}

function apiHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

function assertReceiptMatchesApprovalSummary(summary, receipt, artifactId, artifactDigest, label) {
  if (summary?.releaseId === "NONE_FIRST_DEPLOYMENT") {
    if (receipt !== null || artifactId !== "NONE_FIRST_DEPLOYMENT" || artifactDigest !== "NONE_FIRST_DEPLOYMENT") {
      throw new Error(`${label} first-deployment sentinel is inconsistent.`);
    }
    return;
  }
  if (receipt === null) throw new Error(`${label} receipt is unavailable.`);
  const expected = {
    releaseId: receipt.releaseId,
    repositoryDeploymentId: receipt.repositoryDeployment.id,
    pagesDeploymentId: receipt.deploymentId,
    attemptPhase: receipt.attemptPhase,
    repositoryState: receipt.repositoryDeployment.state,
    repositoryStatusRecorded: receipt.repositoryDeployment.statusRecorded,
    pagesStatus: receipt.pagesStatus,
    markerVerified: receipt.markerVerified,
    publicProductVerified: receipt.publicProductVerified,
    reconciliation: receipt.reconciliation,
    knownGood: receipt.knownGood,
    uncertain: receipt.uncertain,
    receipt: {
      id: Number(artifactId),
      digest: artifactDigest,
      runId: receipt.promotion.runId,
      headSha: receipt.promotion.workflowSha,
      role: label === "Current-attempt" ? "current-attempt-receipt" : "rollback-target-receipt",
    },
  };
  if (JSON.stringify(summary) !== JSON.stringify(expected)) {
    throw new Error(`${label} receipt differs from the retained approval summary.`);
  }
}

export function executeProtectedAdapterGate({
  expected,
  bundleDirectory,
  stagedTarPath,
  environment,
  readActual,
  verifyCurrentState,
  clock = () => Date.now(),
  requestOidc,
  submit,
}) {
  return executeFinalPromotionGate({
    expected,
    readActual,
    verifyApprovedBundle: (actual, verificationTime) => verifyProtectedAdapterBundle({
      bundleDirectory,
      stagedTarPath,
      expected,
      actual,
      environment,
      now: verificationTime,
    }),
    verifyCurrentState,
    clock,
    requestOidc,
    submit,
  });
}

export async function main() {
  if (
    process.env.GITHUB_REPOSITORY !== REPOSITORY
    || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || process.env.GITHUB_REF !== "refs/heads/main"
    || process.env.GITHUB_RUN_ATTEMPT !== "1"
  ) throw new Error("Pages deployment is restricted to a first-attempt manual run on LionLog main.");
  if (process.env.EXPECTED_PROMOTION_WORKFLOW_SHA !== process.env.GITHUB_SHA) {
    throw new Error("Promotion workflow SHA is not the explicitly approved SHA.");
  }
  const approvalExpiresAt = process.env.APPROVAL_EXPIRES_AT ?? "";
  const minimumFreshUntil = process.env.MINIMUM_FRESH_UNTIL || undefined;
  const attemptPath = process.env.DEPLOYMENT_ATTEMPT_PATH;
  if (!attemptPath) throw new Error("DEPLOYMENT_ATTEMPT_PATH is unavailable.");
  const summaryPath = process.env.PREAPPROVAL_SUMMARY_PATH;
  if (!summaryPath) throw new Error("Final promotion evidence paths are unavailable.");
  const expected = JSON.parse(await readFile(summaryPath, "utf8"));
  const sourceManifest = await readReleaseManifestFromEnvironment(process.env);
  if (expected?.authorization?.preSubmissionFailureApproval !== (process.env.PRE_SUBMISSION_FAILURE_APPROVAL ?? "NONE")) {
    throw new Error("Pre-submission reconciliation approval differs from the retained approval summary.");
  }
  const readReceipt = async (releaseId, relativePath) => releaseId === "NONE_FIRST_DEPLOYMENT"
    ? null
    : JSON.parse(await readFile(relativePath, "utf8"));
  const currentReceipt = await readReceipt(process.env.CURRENT_RELEASE_ID, "work/pages-deployment/current/deployment-receipt.json");
  const rollbackTargetReceipt = await readReceipt(process.env.TARGET_RELEASE_ID, "work/pages-deployment/target/deployment-receipt.json");
  assertReceiptMatchesApprovalSummary(
    expected.currentAttempt,
    currentReceipt,
    process.env.CURRENT_RECEIPT_ARTIFACT_ID ?? "",
    process.env.CURRENT_RECEIPT_ARTIFACT_DIGEST ?? "",
    "Current-attempt",
  );
  assertReceiptMatchesApprovalSummary(
    expected.rollbackTarget,
    rollbackTargetReceipt,
    process.env.TARGET_RECEIPT_ARTIFACT_ID ?? "",
    process.env.TARGET_RECEIPT_ARTIFACT_DIGEST ?? "",
    "Rollback-target",
  );
  const { rename, writeFile } = await import("node:fs/promises");
  const recordAttempt = async (value) => {
    const temporary = `${attemptPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, attemptPath);
  };
  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const result = await executeProtectedAdapterGate({
    expected,
    bundleDirectory: path.dirname(process.env.RELEASE_MANIFEST_PATH ?? ""),
    stagedTarPath: "work/pages-deployment/staged/site.tar",
    environment: process.env,
    readActual: () => readFinalPromotionState({ expected, githubToken, checkoutSha: process.env.GITHUB_SHA, fetchImpl: fetch }),
    verifyCurrentState: () => verifyCurrentPublication({
      operation: process.env.OPERATION ?? "",
      currentReceipt,
      rollbackTargetReceipt,
      sourceManifest,
      sourceIdentity: {
        artifactId: Number(process.env.SOURCE_ARTIFACT_ID),
        artifactDigest: process.env.SOURCE_ARTIFACT_DIGEST ?? "",
        manifestSha256: process.env.SOURCE_MANIFEST_DIGEST ?? "",
      },
      currentReceiptArtifactDigest: process.env.CURRENT_RECEIPT_ARTIFACT_DIGEST ?? "NONE_FIRST_DEPLOYMENT",
      currentReceiptArtifactId: process.env.CURRENT_RECEIPT_ARTIFACT_ID === "NONE_FIRST_DEPLOYMENT" ? "NONE_FIRST_DEPLOYMENT" : Number(process.env.CURRENT_RECEIPT_ARTIFACT_ID),
      preSubmissionFailureApproval: process.env.PRE_SUBMISSION_FAILURE_APPROVAL ?? "NONE",
      currentPromotion: {
        runId: Number(process.env.GITHUB_RUN_ID),
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        workflowSha: process.env.GITHUB_SHA ?? "",
        job: process.env.GITHUB_JOB ?? "",
      },
      token: githubToken,
      fetchImpl: fetch,
    }),
    clock: () => Date.now(),
    requestOidc: () => requestOidcToken({
      requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "",
      requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "",
    }),
    submit: async (oidcToken) => {
      const payload = publicationLedgerPayload({
        promotionRunId: Number(process.env.GITHUB_RUN_ID),
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        releaseId: process.env.RELEASE_ID ?? "",
        sourceArtifactId: Number(process.env.SOURCE_ARTIFACT_ID),
        stagedArtifactId: Number(process.env.STAGED_ARTIFACT_ID),
      });
      const repositoryDeploymentId = await createRepositoryDeploymentLedger({
        token: githubToken,
        workflowSha: process.env.GITHUB_SHA ?? "",
        payload,
      });
      await recordRepositoryDeploymentStatus({
        token: githubToken,
        repositoryDeploymentId,
        state: "in_progress",
        runId: Number(process.env.GITHUB_RUN_ID),
      });
      const recordAccepted = async ({ pagesDeploymentId }) => recordRepositoryDeploymentStatus({
        token: githubToken,
        repositoryDeploymentId,
        state: "in_progress",
        pagesDeploymentId,
        runId: Number(process.env.GITHUB_RUN_ID),
      });
      const deployment = await deployExactPagesArtifact({
        artifactId: Number(process.env.STAGED_ARTIFACT_ID),
        buildVersion: process.env.GITHUB_SHA ?? "",
        githubToken,
        oidcToken,
        approvalExpiresAt,
        minimumFreshUntil,
        repositoryDeploymentId,
        recordAttempt,
        recordAccepted,
        now: () => Date.now(),
      });
      return { ...deployment, repositoryDeploymentId };
    },
  });
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is unavailable.");
  const { appendFile } = await import("node:fs/promises");
  await appendFile(output, `repository_deployment_id=${result.repositoryDeploymentId}\ndeployment_id=${result.deploymentId}\npage_url=${result.pageUrl}\nstatus=${result.status}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
