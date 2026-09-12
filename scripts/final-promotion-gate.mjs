import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const API_ROOT = "https://api.github.com";
const REPOSITORY = "CrunchyBrunch/lionlog";

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
  validateApprovedInventory(expected.site);
  const expectedArtifacts = expected.artifacts;
  const actualArtifacts = actual.artifacts;
  if (!Array.isArray(expectedArtifacts) || !Array.isArray(actualArtifacts) || expectedArtifacts.length !== actualArtifacts.length) {
    throw new Error("Final artifact set differs from the approved set.");
  }
  const actualById = new Map(actualArtifacts.map((artifact) => [artifact.id, artifact]));
  for (const approved of expectedArtifacts) validateArtifact(approved, actualById.get(approved.id));
  return { verifiedAt: now.toISOString(), promotionWorkflowSha: expected.promotionWorkflowSha };
}

export async function executeFinalPromotionGate({ expected, readActual, verifyApprovedBundle = async () => {}, verifyCurrentState, clock = () => Date.now(), requestOidc, submit }) {
  const checkpoint = async () => {
    const actual = await readActual();
    const now = new Date(clock());
    validateFinalPromotionState(expected, actual, now);
    await verifyApprovedBundle(actual, now);
    await verifyCurrentState();
  };
  await checkpoint();
  const oidcToken = await requestOidc();
  await checkpoint();
  return submit(oidcToken);
}

export async function readFinalPromotionState({ expected, githubToken, checkoutSha, fetchImpl = fetch }) {
  if (!GIT_SHA.test(checkoutSha ?? "")) throw new Error("Checked-out promotion SHA is invalid.");
  if (!Number.isSafeInteger(expected?.ci?.runId) || expected.ci.runId <= 0) {
    throw new Error("Approved CI run identity is unavailable.");
  }
  const [main, sourceRun, ciRun, ciJobs, ...artifacts] = await Promise.all([
    readJson(`${API_ROOT}/repos/${REPOSITORY}/commits/main`, githubToken, fetchImpl, "Main commit"),
    readJson(`${API_ROOT}/repos/${REPOSITORY}/actions/runs/${expected.source.runId}`, githubToken, fetchImpl, "Candidate producer run"),
    readJson(`${API_ROOT}/repos/${REPOSITORY}/actions/runs/${expected.ci.runId}`, githubToken, fetchImpl, "Required CI run"),
    readJson(`${API_ROOT}/repos/${REPOSITORY}/actions/runs/${expected.ci.runId}/jobs?per_page=100`, githubToken, fetchImpl, "Required CI jobs"),
    ...expected.artifacts.map((artifact) => readJson(
      `${API_ROOT}/repos/${REPOSITORY}/actions/artifacts/${artifact.id}`,
      githubToken,
      fetchImpl,
      `Artifact ${artifact.id}`,
    )),
  ]);
  return {
    checkoutSha,
    mainSha: main?.sha,
    sourceRun,
    ciRun,
    ciJobs: ciJobs?.jobs,
    artifacts,
  };
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
    !Number.isSafeInteger(expected?.ci?.runId)
    || expected.ci.runId <= 0
    || actual?.ciRun?.id !== expected.ci.runId
    || actual.ciRun.workflow_id !== 346_680_782
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

function validateApprovedInventory(site) {
  if (
    site === null
    || typeof site !== "object"
    || !SHA256.test(site.tarSha256 ?? "")
    || !Number.isSafeInteger(site.bytes)
    || site.bytes <= 0
    || !Array.isArray(site.inventory)
    || site.inventory.length === 0
  ) throw new Error("Approved site inventory is unavailable.");
  const paths = new Set();
  for (const entry of site.inventory) {
    if (
      typeof entry?.path !== "string"
      || entry.path.length === 0
      || entry.path.startsWith("/")
      || entry.path.split("/").some((part) => part === "" || part === "." || part === "..")
      || paths.has(entry.path.toLowerCase())
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || !SHA256.test(entry.sha256 ?? "")
    ) throw new Error("Approved site inventory is invalid.");
    paths.add(entry.path.toLowerCase());
  }
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

async function readJson(url, token, fetchImpl, label) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.redirected) throw new Error(`${label} is unavailable (HTTP ${response.status}).`);
  try { return await response.json(); } catch (error) { throw new Error(`${label} response is invalid.`, { cause: error }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = JSON.parse(await readFile(process.env.PREAPPROVAL_SUMMARY_PATH ?? "", "utf8"));
  const actual = JSON.parse(await readFile(process.env.FINAL_STATE_PATH ?? "", "utf8"));
  console.log(JSON.stringify(validateFinalPromotionState(expected, actual)));
}
