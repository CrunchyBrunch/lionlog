import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,200}$/;

export function createDeploymentReceipt(input) {
  const attempt = input.attempt;
  const deploymentId = IDENTIFIER.test(attempt?.deploymentId ?? "") ? attempt.deploymentId : null;
  const pagesAccepted = deploymentId !== null;
  const pagesStatus = typeof attempt?.status === "string" && attempt.status.length <= 100 ? attempt.status : null;
  const markerVerified = input.markerVerified === true;
  const knownGood = attempt?.phase === "terminal" && pagesAccepted && pagesStatus === "succeed" && markerVerified && input.publicProductVerified === true && attempt.uncertain === false;
  const receipt = {
    receiptVersion: "lionlog.pages-deployment-receipt.v2",
    recordedAt: input.recordedAt,
    operation: input.operation,
    releaseId: input.releaseId,
    releaseKind: input.releaseKind,
    deploymentId,
    pageUrl: knownGood ? "https://crunchybrunch.github.io/lionlog/" : null,
    previous: { releaseId: input.previousReleaseId, deploymentId: input.previousDeploymentId },
    promotion: {
      workflowId: 347992874,
      workflowSha: input.workflowSha,
      runId: input.runId,
      runAttempt: input.runAttempt,
      approvalExpiresAt: input.approvalExpiresAt,
    },
    source: {
      artifactId: input.sourceArtifactId,
      artifactDigest: input.sourceArtifactDigest,
      manifestSha256: input.sourceManifestSha256,
    },
    staged: {
      artifactId: input.stagedArtifactId,
      artifactDigest: input.stagedArtifactDigest,
      artifactExpiresAt: input.stagedArtifactExpiresAt,
    },
    attemptPhase: attempt?.phase ?? "submitting",
    pagesAccepted,
    pagesStatus,
    markerVerified,
    publicProductVerified: input.publicProductVerified === true,
    knownGood,
    uncertain: attempt?.uncertain !== false,
  };
  validateReceipt(receipt);
  return receipt;
}

function validateReceipt(value) {
  if (!Number.isFinite(Date.parse(value.recordedAt)) || !Number.isFinite(Date.parse(value.promotion.approvalExpiresAt)) || !Number.isFinite(Date.parse(value.staged.artifactExpiresAt))) throw new Error("Deployment receipt timestamps are invalid.");
  if (!SHA256.test(value.releaseId) || !SHA256.test(value.source.manifestSha256) || !/^[a-f0-9]{40}$/.test(value.promotion.workflowSha)) throw new Error("Deployment receipt hashes are invalid.");
  if (!ARTIFACT_DIGEST.test(value.source.artifactDigest) || !ARTIFACT_DIGEST.test(value.staged.artifactDigest)) throw new Error("Deployment receipt artifact digests are invalid.");
  if (!Number.isSafeInteger(value.promotion.runId) || value.promotion.runId <= 0 || value.promotion.runAttempt !== 1 || !Number.isSafeInteger(value.source.artifactId) || !Number.isSafeInteger(value.staged.artifactId)) throw new Error("Deployment receipt identifiers are invalid.");
  if (!new Set(["promote", "rollback", "first-release-recovery"]).has(value.operation) || !new Set(["live", "first-release-recovery"]).has(value.releaseKind)) throw new Error("Deployment receipt operation is invalid.");
  if (!new Set(["submitting", "submission-uncertain", "submission-rejected", "accepted", "status-uncertain", "terminal"]).has(value.attemptPhase)) throw new Error("Deployment receipt attempt phase is invalid.");
  if (value.knownGood && !(value.pagesAccepted && value.pagesStatus === "succeed" && value.markerVerified && value.publicProductVerified && !value.uncertain)) throw new Error("Deployment receipt cannot claim known-good without full verification.");
  if (value.knownGood && value.attemptPhase !== "terminal") throw new Error("Known-good receipt requires a terminal deployment attempt.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const attempt = JSON.parse(await readFile(process.env.DEPLOYMENT_ATTEMPT_PATH ?? "", "utf8"));
  const input = JSON.parse(process.env.DEPLOYMENT_RECEIPT_INPUT ?? "{}");
  const receipt = createDeploymentReceipt({ ...input, attempt });
  await writeFile(process.env.DEPLOYMENT_RECEIPT_PATH ?? "deployment-receipt.json", `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}
