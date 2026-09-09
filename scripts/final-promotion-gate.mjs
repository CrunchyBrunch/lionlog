import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;

export function validateFinalPromotionState(expected, actual, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Final verification time is invalid.");
  if (
    !GIT_SHA.test(expected?.promotionWorkflowSha ?? "")
    || actual?.checkoutSha !== expected.promotionWorkflowSha
    || actual?.mainSha !== expected.promotionWorkflowSha
  ) throw new Error("Main or checked-out promotion workflow changed after approval.");
  if (!Number.isFinite(Date.parse(expected.approvalExpiresAt ?? "")) || Date.parse(expected.approvalExpiresAt) <= now.getTime()) {
    throw new Error("Protected approval expired before the final gate.");
  }
  if (expected.operation === "promote") {
    if (!Number.isFinite(Date.parse(expected.minimumFreshUntil ?? "")) || Date.parse(expected.minimumFreshUntil) < now.getTime() + 15 * 60_000) {
      throw new Error("Live release freshness margin elapsed before the final gate.");
    }
  }
  validateRun(expected.source, actual.sourceRun);
  validateCi(expected, actual);
  const expectedArtifacts = expected.artifacts;
  const actualArtifacts = actual.artifacts;
  if (!Array.isArray(expectedArtifacts) || !Array.isArray(actualArtifacts) || expectedArtifacts.length !== actualArtifacts.length) {
    throw new Error("Final artifact set differs from the approved set.");
  }
  const actualById = new Map(actualArtifacts.map((artifact) => [artifact.id, artifact]));
  for (const approved of expectedArtifacts) validateArtifact(approved, actualById.get(approved.id));
  return { verifiedAt: now.toISOString(), promotionWorkflowSha: expected.promotionWorkflowSha };
}

export async function executeFinalPromotionGate({ expected, actual, now, requestOidc, submit }) {
  validateFinalPromotionState(expected, actual, now);
  const oidcToken = await requestOidc();
  validateFinalPromotionState(expected, actual, now);
  return submit(oidcToken);
}

function validateRun(expected, actual) {
  if (
    !Number.isSafeInteger(expected?.runId)
    || expected.runId <= 0
    || !GIT_SHA.test(expected.sourceSha ?? "")
    || actual?.id !== expected.runId
    || actual.workflow_id !== 347_085_467
    || actual.path !== ".github/workflows/build-live-menu-artifact.yml"
    || actual.event !== "workflow_dispatch"
    || actual.head_sha !== expected.sourceSha
    || actual.head_branch !== "main"
    || actual.run_attempt !== 1
    || actual.status !== "completed"
    || actual.conclusion !== "success"
  ) throw new Error("Candidate producer state changed after approval.");
}

function validateCi(expected, actual) {
  if (
    actual?.ciRun?.workflow_id !== 346_680_782
    || actual.ciRun.path !== ".github/workflows/ci.yml"
    || actual.ciRun.event !== "push"
    || actual.ciRun.head_sha !== expected.source.sourceSha
    || actual.ciRun.head_branch !== "main"
    || actual.ciRun.run_attempt !== 1
    || actual.ciRun.status !== "completed"
    || actual.ciRun.conclusion !== "success"
    || !Array.isArray(actual.ciJobs)
    || actual.ciJobs.filter((job) => job?.name === "verify" && job.head_sha === expected.source.sourceSha && job.status === "completed" && job.conclusion === "success").length !== 1
  ) throw new Error("Required main-branch CI state changed after approval.");
}

function validateArtifact(expected, actual) {
  if (
    !Number.isSafeInteger(expected?.id)
    || expected.id <= 0
    || !ARTIFACT_DIGEST.test(expected.digest ?? "")
    || actual?.id !== expected.id
    || normalizeDigest(actual.digest) !== expected.digest
    || actual.expired !== false
    || actual.workflow_run?.id !== expected.runId
    || actual.workflow_run?.head_sha !== expected.headSha
    || actual.workflow_run?.head_branch !== "main"
    || actual.workflow_run?.head_repository_id !== 1_346_360_244
  ) throw new Error(`Artifact ${expected?.id ?? "unknown"} changed or expired after approval.`);
}

function normalizeDigest(value) {
  if (typeof value !== "string") return "";
  const normalized = value.startsWith("sha256:") ? value : `sha256:${value}`;
  return SHA256.test(normalized.slice(7)) ? normalized : "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = JSON.parse(await readFile(process.env.PREAPPROVAL_SUMMARY_PATH ?? "", "utf8"));
  const actual = JSON.parse(await readFile(process.env.FINAL_STATE_PATH ?? "", "utf8"));
  console.log(JSON.stringify(validateFinalPromotionState(expected, actual)));
}
