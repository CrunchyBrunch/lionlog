import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PAGES_ID = /^[A-Za-z0-9._-]{1,200}$/;
const REPOSITORY_STATES = new Set(["pending", "in_progress", "success", "failure", "error", "unknown"]);
const ATTEMPT_PHASES = new Set(["submitting", "submission-uncertain", "submission-rejected", "accepted", "status-uncertain", "terminal"]);

export function createDeploymentReceipt(input) {
  const attempt = input.attempt ?? {};
  if (!ATTEMPT_PHASES.has(attempt.phase)) throw new Error("Deployment receipt attempt phase is invalid.");
  const deploymentId = PAGES_ID.test(attempt.deploymentId ?? "") ? attempt.deploymentId : null;
  const repositoryDeploymentId = Number.isSafeInteger(attempt.repositoryDeploymentId) && attempt.repositoryDeploymentId > 0
    ? attempt.repositoryDeploymentId
    : null;
  const pagesAccepted = deploymentId !== null;
  const pagesStatus = typeof attempt.status === "string" && attempt.status.length <= 100 ? attempt.status : null;
  const markerVerified = input.markerVerified === true;
  const publicProductVerified = input.publicProductVerified === true;
  const repositoryState = REPOSITORY_STATES.has(input.repositoryState) ? input.repositoryState : "unknown";
  const repositoryStatusRecorded = input.repositoryStatusRecorded === true;
  const knownGood = attempt.phase === "terminal"
    && repositoryDeploymentId !== null
    && repositoryState === "success"
    && repositoryStatusRecorded
    && pagesAccepted
    && pagesStatus === "succeed"
    && markerVerified
    && publicProductVerified
    && attempt.uncertain === false;
  const publicReleaseId = SHA256.test(input.publicReleaseId ?? "") || input.publicReleaseId === "NONE_404"
    ? input.publicReleaseId
    : markerVerified ? input.releaseId : "UNKNOWN";
  const outcome = knownGood
    ? "known-good"
    : pagesStatus === "succeed" && (markerVerified || publicReleaseId === input.releaseId)
      ? "served-unverified"
      : attempt.uncertain !== false
        ? "submission-uncertain"
        : attempt.phase === "submission-rejected"
          ? "not-submitted"
          : attempt.phase === "terminal"
            ? "terminal-failure"
            : "evidence-incomplete";
  const receipt = {
    receiptVersion: "lionlog.pages-deployment-receipt.v3",
    recordedAt: input.recordedAt,
    operation: input.operation,
    releaseId: input.releaseId,
    releaseKind: input.releaseKind,
    deploymentId,
    pageUrl: knownGood ? "https://crunchybrunch.github.io/lionlog/" : null,
    previous: {
      knownGoodReleaseId: input.previousKnownGoodReleaseId,
      knownGoodRepositoryDeploymentId: input.previousKnownGoodRepositoryDeploymentId,
      knownGoodPagesDeploymentId: input.previousKnownGoodPagesDeploymentId,
    },
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
      siteTarSha256: input.sourceSiteTarSha256,
      recoveryArtifactId: input.recovery?.artifactId ?? null,
      recoveryArtifactDigest: input.recovery?.artifactDigest ?? null,
      recoveryManifestSha256: input.recovery?.manifestSha256 ?? null,
    },
    recovery: input.recovery ?? null,
    staged: {
      artifactId: input.stagedArtifactId,
      artifactDigest: input.stagedArtifactDigest,
      artifactExpiresAt: input.stagedArtifactExpiresAt,
    },
    attemptPhase: attempt.phase,
    repositoryDeployment: {
      id: repositoryDeploymentId,
      state: repositoryState,
      statusRecorded: repositoryStatusRecorded,
    },
    pagesAccepted,
    pagesStatus,
    markerVerified,
    publicProductVerified,
    reconciliation: { outcome, publicReleaseId },
    knownGood,
    uncertain: attempt.uncertain !== false || !repositoryStatusRecorded,
  };
  validateReceipt(receipt);
  return receipt;
}

function validateReceipt(value) {
  const previous = Object.values(value.previous);
  if (!Number.isFinite(Date.parse(value.recordedAt)) || !Number.isFinite(Date.parse(value.promotion.approvalExpiresAt)) || !Number.isFinite(Date.parse(value.staged.artifactExpiresAt))) throw new Error("Deployment receipt timestamps are invalid.");
  if (!SHA256.test(value.releaseId) || !SHA256.test(value.source.manifestSha256) || !SHA256.test(value.source.siteTarSha256) || !/^[a-f0-9]{40}$/.test(value.promotion.workflowSha)) throw new Error("Deployment receipt hashes are invalid.");
  if (!ARTIFACT_DIGEST.test(value.source.artifactDigest) || !ARTIFACT_DIGEST.test(value.staged.artifactDigest)) throw new Error("Deployment receipt artifact digests are invalid.");
  if (!Number.isSafeInteger(value.promotion.runId) || value.promotion.runId <= 0 || value.promotion.runAttempt !== 1 || !Number.isSafeInteger(value.source.artifactId) || !Number.isSafeInteger(value.staged.artifactId)) throw new Error("Deployment receipt identifiers are invalid.");
  if (!new Set(["promote", "rollback", "first-release-recovery"]).has(value.operation) || !new Set(["live", "first-release-recovery"]).has(value.releaseKind)) throw new Error("Deployment receipt operation is invalid.");
  if (!ATTEMPT_PHASES.has(value.attemptPhase) || !REPOSITORY_STATES.has(value.repositoryDeployment.state)) throw new Error("Deployment receipt attempt state is invalid.");
  if (!(Number.isSafeInteger(value.repositoryDeployment.id) && value.repositoryDeployment.id > 0) && value.repositoryDeployment.id !== null) throw new Error("Deployment receipt repository deployment ID is invalid.");
  if (value.previous.knownGoodRepositoryDeploymentId !== "NONE_FIRST_DEPLOYMENT" && !(Number.isSafeInteger(value.previous.knownGoodRepositoryDeploymentId) && value.previous.knownGoodRepositoryDeploymentId > 0)) throw new Error("Previous repository deployment ID is invalid.");
  if (value.previous.knownGoodPagesDeploymentId !== "NONE_FIRST_DEPLOYMENT" && !PAGES_ID.test(value.previous.knownGoodPagesDeploymentId)) throw new Error("Previous Pages deployment ID is invalid.");
  if (previous.some((entry) => entry === "NONE_FIRST_DEPLOYMENT") && !previous.every((entry) => entry === "NONE_FIRST_DEPLOYMENT")) throw new Error("Previous known-good identity is incomplete.");
  if ((value.releaseKind === "live") !== (value.recovery !== null)) throw new Error("Deployment receipt recovery identity is inconsistent.");
  if (value.recovery !== null && (
    !SHA256.test(value.recovery.releaseId)
    || !SHA256.test(value.recovery.manifestSha256)
    || !Number.isSafeInteger(value.recovery.artifactId)
    || value.recovery.artifactId <= 0
    || !ARTIFACT_DIGEST.test(value.recovery.artifactDigest)
  )) throw new Error("Deployment receipt recovery identity is invalid.");
  if (value.knownGood && !(value.repositoryDeployment.id !== null && value.repositoryDeployment.state === "success" && value.repositoryDeployment.statusRecorded && value.pagesAccepted && value.pagesStatus === "succeed" && value.markerVerified && value.publicProductVerified && value.reconciliation.outcome === "known-good" && value.reconciliation.publicReleaseId === value.releaseId && !value.uncertain)) throw new Error("Deployment receipt cannot claim known-good without complete authoritative verification.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidence = JSON.parse(await readFile(process.env.DEPLOYMENT_ATTEMPT_PATH ?? "", "utf8"));
  const attempt = evidence.attempt ?? evidence;
  const input = JSON.parse(process.env.DEPLOYMENT_RECEIPT_INPUT ?? "{}");
  const receipt = createDeploymentReceipt({
    ...input,
    attempt,
    repositoryState: evidence.repositoryState ?? input.repositoryState,
    repositoryStatusRecorded: evidence.repositoryStatusRecorded ?? input.repositoryStatusRecorded,
  });
  await writeFile(process.env.DEPLOYMENT_RECEIPT_PATH ?? "deployment-receipt.json", `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}
