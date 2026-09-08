import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REPOSITORY = "CrunchyBrunch/lionlog";
const RELEASE_URL = "https://crunchybrunch.github.io/lionlog/release.json";
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * @param {{ expectedReleaseId: string, expectedDeploymentId: string, currentReceipt?: any, token: string, fetchImpl?: typeof fetch }} options
 */
export async function verifyCurrentPublication({
  expectedReleaseId,
  expectedDeploymentId,
  currentReceipt = null,
  token,
  fetchImpl = fetch,
}) {
  if (expectedReleaseId === "NONE_FIRST_DEPLOYMENT") {
    if (expectedDeploymentId !== "NONE_FIRST_DEPLOYMENT") throw new Error("First deployment identifiers are inconsistent.");
    const response = await fetchImpl(RELEASE_URL, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.status !== 404) throw new Error("A publication already exists at the target URL.");
    const deployments = await readDeployments(token, fetchImpl);
    if (deployments.length !== 0) throw new Error("First deployment is uncertain because Pages has deployment history.");
    return { state: "first-deployment" };
  }
  if (!SHA256.test(expectedReleaseId) || !/^[A-Za-z0-9._-]{1,200}$/.test(expectedDeploymentId)) {
    throw new Error("Expected current publication identity is invalid.");
  }
  if (
    currentReceipt?.receiptVersion !== "lionlog.pages-deployment-receipt.v2"
    || currentReceipt.releaseId !== expectedReleaseId
    || currentReceipt.deploymentId !== expectedDeploymentId
    || currentReceipt.pagesStatus !== "succeed"
    || currentReceipt.markerVerified !== true
    || currentReceipt.publicProductVerified !== true
    || currentReceipt.knownGood !== true
  ) throw new Error("Expected current publication lacks an exact known-good deployment receipt.");
  validateReceiptShape(currentReceipt);
  const response = await fetchImpl(RELEASE_URL, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok || response.redirected) throw new Error("Current publication marker is unavailable.");
  const marker = await response.json();
  if (marker?.releaseId !== expectedReleaseId) throw new Error("Current public release changed.");
  const deployment = await fetchImpl(
    `https://api.github.com/repos/${REPOSITORY}/pages/deployments/${expectedDeploymentId}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!deployment.ok || deployment.redirected || (await deployment.json())?.status !== "succeed") {
    throw new Error("Expected current Pages deployment is not successful.");
  }
  const deployments = await readDeployments(token, fetchImpl);
  if (String(deployments[0]?.id ?? "") !== expectedDeploymentId || deployments[0]?.status !== "succeed") {
    throw new Error("Expected deployment is historical rather than current production.");
  }
  return { state: "matched", releaseId: expectedReleaseId, deploymentId: expectedDeploymentId };
}

async function readDeployments(token, fetchImpl) {
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/pages/deployments`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || response.redirected) throw new Error("Pages deployment collection is unavailable.");
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("Pages deployment collection is invalid.");
  return value;
}

function validateReceiptShape(receipt) {
  const expectedKeys = ["attemptPhase", "deploymentId", "knownGood", "markerVerified", "operation", "pageUrl", "pagesAccepted", "pagesStatus", "previous", "promotion", "publicProductVerified", "receiptVersion", "recordedAt", "releaseId", "releaseKind", "source", "staged", "uncertain"].sort();
  if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys)) throw new Error("Current deployment receipt has unexpected fields.");
  if (
    !Number.isFinite(Date.parse(receipt.recordedAt))
    || receipt.pageUrl !== "https://crunchybrunch.github.io/lionlog/"
    || receipt.pagesAccepted !== true
    || receipt.attemptPhase !== "terminal"
    || receipt.uncertain !== false
    || !new Set(["promote", "rollback", "first-release-recovery"]).has(receipt.operation)
    || !new Set(["live", "first-release-recovery"]).has(receipt.releaseKind)
    || receipt.promotion?.workflowId !== 347992874
    || !/^[a-f0-9]{40}$/.test(receipt.promotion?.workflowSha ?? "")
    || !Number.isSafeInteger(receipt.promotion?.runId)
    || receipt.promotion?.runAttempt !== 1
    || !Number.isFinite(Date.parse(receipt.promotion?.approvalExpiresAt ?? ""))
    || !Number.isSafeInteger(receipt.source?.artifactId)
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.source?.artifactDigest ?? "")
    || !SHA256.test(receipt.source?.manifestSha256 ?? "")
    || !Number.isSafeInteger(receipt.staged?.artifactId)
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.staged?.artifactDigest ?? "")
    || !Number.isFinite(Date.parse(receipt.staged?.artifactExpiresAt ?? ""))
  ) throw new Error("Current deployment receipt is structurally invalid.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receiptPath = process.env.EXPECTED_CURRENT_RECEIPT_PATH;
  const result = await verifyCurrentPublication({
    expectedReleaseId: process.env.EXPECTED_CURRENT_RELEASE_ID ?? "",
    expectedDeploymentId: process.env.EXPECTED_CURRENT_DEPLOYMENT_ID ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
    currentReceipt: receiptPath && receiptPath !== "NONE_FIRST_DEPLOYMENT"
      ? JSON.parse(await readFile(receiptPath, "utf8"))
      : null,
  });
  console.log(JSON.stringify(result));
}
