import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readRepositoryDeploymentAuthority } from "./publication-deployment-ledger.mjs";

const RELEASE_URL = "https://crunchybrunch.github.io/lionlog/release.json";
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PAGES_ID = /^[A-Za-z0-9._-]{1,200}$/;

/** @param {any} options */
export async function verifyCurrentPublication(options) {
  const {
    operation,
    currentReceipt = null,
    rollbackTargetReceipt = null,
    sourceManifest = null,
    sourceIdentity = null,
    token,
    fetchImpl = fetch,
  } = options;
  if (!new Set(["promote", "rollback", "first-release-recovery"]).has(operation)) throw new Error("Publication operation is invalid.");
  const publicReleaseId = await readPublicReleaseId(fetchImpl);
  const authority = await readRepositoryDeploymentAuthority({ token, receipt: currentReceipt, fetchImpl });
  if (currentReceipt === null) {
    if (rollbackTargetReceipt !== null || sourceManifest === null) throw new Error("First deployment evidence is inconsistent.");
    if (publicReleaseId !== "NONE_404" || authority.deployments.length !== 0) {
      throw new Error("First deployment is not proven by supported repository deployment state.");
    }
    if (operation !== "promote") throw new Error("Recovery cannot use a first-deployment sentinel without a reconciled attempt.");
    return { state: "first-deployment", publicReleaseId };
  }

  validateReceiptShape(currentReceipt);
  validateAuthorityAgainstReceipt(authority, currentReceipt);
  if (rollbackTargetReceipt !== null) {
    validateReceiptShape(rollbackTargetReceipt);
    if (!rollbackTargetReceipt.knownGood) throw new Error("Rollback target is not an exact known-good deployment.");
    const targetAuthority = await readRepositoryDeploymentAuthority({ token, receipt: rollbackTargetReceipt, requireCurrent: false, fetchImpl });
    validateAuthorityAgainstReceipt(targetAuthority, rollbackTargetReceipt);
  }
  if (sourceManifest === null || sourceIdentity === null) throw new Error("Publication source identity is unavailable.");

  const allowedPublicIds = new Set([currentReceipt.releaseId]);
  if (rollbackTargetReceipt !== null) allowedPublicIds.add(rollbackTargetReceipt.releaseId);
  if (currentReceipt.previous.knownGoodReleaseId !== "NONE_FIRST_DEPLOYMENT") allowedPublicIds.add(currentReceipt.previous.knownGoodReleaseId);
  if (operation === "first-release-recovery") allowedPublicIds.add("NONE_404");
  if (!allowedPublicIds.has(publicReleaseId)) throw new Error("Public release marker does not match the reconciled attempt or rollback target.");

  if (operation === "promote") {
    if (!currentReceipt.knownGood || rollbackTargetReceipt === null || !sameDeploymentIdentity(rollbackTargetReceipt, currentReceipt)) {
      throw new Error("A normal successor requires the exact current known-good receipt as rollback target.");
    }
    if (publicReleaseId !== currentReceipt.releaseId || sourceManifest.releaseId === currentReceipt.releaseId) {
      throw new Error("Normal successor state or source identity is inconsistent.");
    }
  } else if (operation === "rollback") {
    if (rollbackTargetReceipt === null || sourceManifest.releaseId !== rollbackTargetReceipt.releaseId) {
      throw new Error("Rollback source bytes do not match the exact known-good target.");
    }
    if (
      sourceManifest.site?.tarSha256 !== rollbackTargetReceipt.source.siteTarSha256
      || sourceManifest.releaseKind !== rollbackTargetReceipt.releaseKind
      || sourceIdentity.artifactId !== rollbackTargetReceipt.source.artifactId
      || sourceIdentity.artifactDigest !== rollbackTargetReceipt.source.artifactDigest
      || sourceIdentity.manifestSha256 !== rollbackTargetReceipt.source.manifestSha256
    ) {
      throw new Error("Rollback target receipt does not bind the exact source site bytes.");
    }
    assertPreviousKnownGood(currentReceipt, rollbackTargetReceipt);
  } else {
    if (rollbackTargetReceipt !== null || currentReceipt.releaseKind !== "live" || sourceManifest.releaseKind !== "first-release-recovery") {
      throw new Error("First-release recovery identities are inconsistent.");
    }
    const recovery = currentReceipt.recovery;
    if (
      recovery === null
      || recovery.releaseId !== sourceManifest.releaseId
      || recovery.manifestSha256 !== sourceIdentity.manifestSha256
      || recovery.artifactId !== sourceIdentity.artifactId
      || recovery.artifactDigest !== sourceIdentity.artifactDigest
    ) throw new Error("First-release recovery is not bound to the failed live attempt's exact recovery bytes.");
    if (!Object.values(currentReceipt.previous).every((value) => value === "NONE_FIRST_DEPLOYMENT")) {
      throw new Error("First-release recovery is only valid for an attempt with no preceding known-good release.");
    }
  }
  return {
    state: currentReceipt.knownGood ? "known-good-current" : "reconciled-current-attempt",
    publicReleaseId,
    repositoryDeploymentId: currentReceipt.repositoryDeployment.id,
  };
}

function sameDeploymentIdentity(left, right) {
  return left.releaseId === right.releaseId
    && left.repositoryDeployment.id === right.repositoryDeployment.id
    && left.deploymentId === right.deploymentId
    && left.promotion.runId === right.promotion.runId
    && left.source.artifactId === right.source.artifactId
    && left.source.artifactDigest === right.source.artifactDigest
    && left.source.manifestSha256 === right.source.manifestSha256;
}

function assertPreviousKnownGood(current, target) {
  if (
    current.previous.knownGoodReleaseId !== target.releaseId
    || current.previous.knownGoodRepositoryDeploymentId !== target.repositoryDeployment.id
    || current.previous.knownGoodPagesDeploymentId !== target.deploymentId
  ) throw new Error("Current attempt is not chained to the exact known-good rollback target.");
}

function validateAuthorityAgainstReceipt(authority, receipt) {
  if (authority.current === null) {
    if (
      receipt.repositoryDeployment.id !== null
      || receipt.repositoryDeployment.statusRecorded
      || receipt.deploymentId !== null
      || !receipt.uncertain
    ) throw new Error("Current attempt lacks its required repository deployment authority.");
    return;
  }
  const repositoryState = authority.status?.state;
  if (receipt.repositoryDeployment.statusRecorded && repositoryState !== receipt.repositoryDeployment.state) {
    throw new Error("Repository deployment status changed after the receipt was recorded.");
  }
  if (receipt.knownGood && repositoryState !== "success") throw new Error("Known-good repository deployment is not successful.");
  if (receipt.deploymentId !== null) {
    if (typeof authority.pagesStatus?.status !== "string") throw new Error("Pages deployment status is unavailable.");
    if (receipt.knownGood && authority.pagesStatus.status !== "succeed") throw new Error("Known-good Pages deployment is not successful.");
    if (!receipt.uncertain && receipt.pagesStatus !== authority.pagesStatus.status) throw new Error("Pages deployment status changed after terminal evidence.");
  }
}

async function readPublicReleaseId(fetchImpl) {
  const response = await fetchImpl(RELEASE_URL, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status === 404 && !response.redirected) return "NONE_404";
  if (!response.ok || response.redirected) throw new Error(`Current public release marker is unavailable (HTTP ${response.status}).`);
  let marker;
  try { marker = await response.json(); } catch (error) { throw new Error("Current public release marker is invalid.", { cause: error }); }
  if (!SHA256.test(marker?.releaseId ?? "")) throw new Error("Current public release marker has no valid release identity.");
  return marker.releaseId;
}

export function validateReceiptShape(receipt) {
  assertExactKeys(receipt, ["attemptPhase", "deploymentId", "knownGood", "markerVerified", "operation", "pageUrl", "pagesAccepted", "pagesStatus", "previous", "promotion", "publicProductVerified", "receiptVersion", "reconciliation", "recordedAt", "recovery", "releaseId", "releaseKind", "repositoryDeployment", "source", "staged", "uncertain"], "Deployment receipt");
  assertExactKeys(receipt.previous, ["knownGoodPagesDeploymentId", "knownGoodReleaseId", "knownGoodRepositoryDeploymentId"], "Previous known-good identity");
  assertExactKeys(receipt.promotion, ["approvalExpiresAt", "runAttempt", "runId", "workflowId", "workflowSha"], "Promotion identity");
  assertExactKeys(receipt.source, ["artifactDigest", "artifactId", "manifestSha256", "recoveryArtifactDigest", "recoveryArtifactId", "recoveryManifestSha256", "siteTarSha256"], "Source identity");
  assertExactKeys(receipt.staged, ["artifactDigest", "artifactExpiresAt", "artifactId"], "Staged identity");
  assertExactKeys(receipt.repositoryDeployment, ["id", "state", "statusRecorded"], "Repository deployment identity");
  assertExactKeys(receipt.reconciliation, ["outcome", "publicReleaseId"], "Reconciliation evidence");
  if (receipt.recovery !== null) assertExactKeys(receipt.recovery, ["artifactDigest", "artifactId", "manifestSha256", "releaseId"], "Recovery identity");
  if (
    receipt?.receiptVersion !== "lionlog.pages-deployment-receipt.v3"
    || !SHA256.test(receipt.releaseId ?? "")
    || !Number.isFinite(Date.parse(receipt.recordedAt ?? ""))
    || !new Set(["promote", "rollback", "first-release-recovery"]).has(receipt.operation)
    || !new Set(["live", "first-release-recovery"]).has(receipt.releaseKind)
    || receipt.promotion?.workflowId !== 347992874
    || !/^[a-f0-9]{40}$/.test(receipt.promotion?.workflowSha ?? "")
    || !Number.isSafeInteger(receipt.promotion?.runId)
    || receipt.promotion?.runAttempt !== 1
    || !Number.isFinite(Date.parse(receipt.promotion?.approvalExpiresAt ?? ""))
    || !Number.isSafeInteger(receipt.source?.artifactId)
    || !ARTIFACT_DIGEST.test(receipt.source?.artifactDigest ?? "")
    || !SHA256.test(receipt.source?.manifestSha256 ?? "")
    || !SHA256.test(receipt.source?.siteTarSha256 ?? "")
    || !Number.isSafeInteger(receipt.staged?.artifactId)
    || !ARTIFACT_DIGEST.test(receipt.staged?.artifactDigest ?? "")
    || !Number.isFinite(Date.parse(receipt.staged?.artifactExpiresAt ?? ""))
    || (!(Number.isSafeInteger(receipt.repositoryDeployment?.id) && receipt.repositoryDeployment.id > 0) && receipt.repositoryDeployment?.id !== null)
    || !new Set(["pending", "in_progress", "success", "failure", "error", "unknown"]).has(receipt.repositoryDeployment?.state)
    || typeof receipt.repositoryDeployment?.statusRecorded !== "boolean"
    || (receipt.deploymentId !== null && !PAGES_ID.test(receipt.deploymentId ?? ""))
    || receipt.pagesAccepted !== (receipt.deploymentId !== null)
    || !new Set(["submitting", "submission-uncertain", "submission-rejected", "accepted", "status-uncertain", "terminal"]).has(receipt.attemptPhase)
    || !new Set(["known-good", "served-unverified", "submission-uncertain", "terminal-failure", "not-submitted", "evidence-incomplete"]).has(receipt.reconciliation?.outcome)
    || !(SHA256.test(receipt.reconciliation?.publicReleaseId ?? "") || new Set(["NONE_404", "UNKNOWN"]).has(receipt.reconciliation?.publicReleaseId))
  ) throw new Error("Deployment receipt is structurally invalid.");
  if (receipt.repositoryDeployment.id === null && (
    receipt.repositoryDeployment.statusRecorded
    || receipt.deploymentId !== null
    || !receipt.uncertain
  )) throw new Error("Deployment receipt has incomplete repository authority.");
  const previous = Object.values(receipt.previous);
  if (
    previous.some((value) => value === "NONE_FIRST_DEPLOYMENT") !== previous.every((value) => value === "NONE_FIRST_DEPLOYMENT")
    || (receipt.previous.knownGoodReleaseId !== "NONE_FIRST_DEPLOYMENT" && !SHA256.test(receipt.previous.knownGoodReleaseId))
    || (receipt.previous.knownGoodRepositoryDeploymentId !== "NONE_FIRST_DEPLOYMENT" && !(Number.isSafeInteger(receipt.previous.knownGoodRepositoryDeploymentId) && receipt.previous.knownGoodRepositoryDeploymentId > 0))
    || (receipt.previous.knownGoodPagesDeploymentId !== "NONE_FIRST_DEPLOYMENT" && !PAGES_ID.test(receipt.previous.knownGoodPagesDeploymentId))
  ) throw new Error("Deployment receipt has an invalid previous known-good identity.");
  const sourceRecovery = [receipt.source.recoveryArtifactId, receipt.source.recoveryArtifactDigest, receipt.source.recoveryManifestSha256];
  if ((receipt.releaseKind === "live") !== (receipt.recovery !== null)) throw new Error("Deployment receipt inconsistently binds recovery bytes.");
  if (receipt.recovery === null) {
    if (sourceRecovery.some((value) => value !== null)) throw new Error("Deployment receipt has unbound recovery source fields.");
  } else if (
    !SHA256.test(receipt.recovery.releaseId)
    || !SHA256.test(receipt.recovery.manifestSha256)
    || !(Number.isSafeInteger(receipt.recovery.artifactId) && receipt.recovery.artifactId > 0)
    || !ARTIFACT_DIGEST.test(receipt.recovery.artifactDigest)
    || receipt.source.recoveryArtifactId !== receipt.recovery.artifactId
    || receipt.source.recoveryArtifactDigest !== receipt.recovery.artifactDigest
    || receipt.source.recoveryManifestSha256 !== receipt.recovery.manifestSha256
  ) throw new Error("Deployment receipt recovery identity is invalid.");
  if (receipt.pagesAccepted !== (receipt.deploymentId !== null)) throw new Error("Deployment receipt Pages acceptance identity is inconsistent.");
  if (receipt.knownGood && !(
    receipt.attemptPhase === "terminal"
    && receipt.repositoryDeployment.state === "success"
    && receipt.repositoryDeployment.statusRecorded === true
    && receipt.deploymentId !== null
    && receipt.pagesStatus === "succeed"
    && receipt.markerVerified === true
    && receipt.publicProductVerified === true
    && receipt.reconciliation?.outcome === "known-good"
    && receipt.reconciliation?.publicReleaseId === receipt.releaseId
    && receipt.uncertain === false
  )) throw new Error("Deployment receipt weakens the known-good contract.");
}

function assertExactKeys(value, keys, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) throw new Error(`${label} has unexpected fields.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const currentPath = process.env.EXPECTED_CURRENT_RECEIPT_PATH;
  const targetPath = process.env.ROLLBACK_TARGET_RECEIPT_PATH;
  const sourcePath = process.env.RELEASE_MANIFEST_PATH;
  const result = await verifyCurrentPublication({
    operation: process.env.OPERATION ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
    currentReceipt: currentPath && currentPath !== "NONE_FIRST_DEPLOYMENT" ? JSON.parse(await readFile(currentPath, "utf8")) : null,
    rollbackTargetReceipt: targetPath && targetPath !== "NONE_FIRST_DEPLOYMENT" ? JSON.parse(await readFile(targetPath, "utf8")) : null,
    sourceManifest: sourcePath ? JSON.parse(await readFile(sourcePath, "utf8")) : null,
    sourceIdentity: {
      artifactId: Number(process.env.SOURCE_ARTIFACT_ID),
      artifactDigest: process.env.SOURCE_ARTIFACT_DIGEST ?? "",
      manifestSha256: process.env.SOURCE_MANIFEST_DIGEST ?? "",
    },
  });
  console.log(JSON.stringify(result));
}
