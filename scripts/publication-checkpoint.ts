import { createHash } from "node:crypto";
import {
  LIONLOG_REPOSITORY,
  LIONLOG_REPOSITORY_ID,
  TARGET_BASE_PATH,
  TARGET_ORIGIN,
} from "../infrastructure/publication/release-contract.ts";
import { branchFromProductionRef, validateKnownGoodReceipt } from "./supported-pages-release.ts";
import { validatePublicationReleaseManifest, PROMOTION_WORKFLOW_ID } from "../infrastructure/publication/release-contract.ts";
import { collectPagesAttemptHistory } from "./collect-pages-attempt-history.ts";
import { isKnownGoodAttempt, isProvenPreSubmissionFailure, type PriorAttemptEvidence } from "./supported-pages-control.ts";
import { observePublicRelease } from "./public-release-state.ts";
import { verifyPublicSite } from "./verify-public-site.mjs";

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CHECKPOINT_MANIFEST_MAX_BYTES = 512 * 1024;
export const PUBLICATION_STATE_BRANCH = "refs/heads/lionlog-publication-state";

/** A reviewed historical publication may precede a later genuine known-good seed. */
export function isResolvedPublishedPredecessor(attempt: PriorAttemptEvidence): boolean {
  const resolution = attempt.publishedResolution;
  const receipt = attempt.receipt?.content as { knownGood?: unknown; unresolved?: unknown;
    workflow?: { runId?: unknown; runAttempt?: unknown }; public?: { browserVerified?: unknown } } | undefined;
  return resolution !== null && resolution !== undefined && attempt.incidentEvidence !== null
    && attempt.status === "completed" && attempt.conclusion === "failure" && attempt.jobsComplete === true
    && attempt.finalGateConclusion === "success" && attempt.submissionBoundaryConclusion === "success"
    && attempt.deploymentConclusion === "success" && receipt?.knownGood === false && receipt.unresolved === true
    && receipt.workflow?.runId === attempt.runId && receipt.workflow.runAttempt === attempt.runAttempt
    && receipt.public?.browserVerified === false && resolution.runId === attempt.runId
    && resolution.runAttempt === attempt.runAttempt && resolution.workflowSha === attempt.workflowSha
    && resolution.receiptArtifactId === attempt.receipt?.artifactId
    && resolution.receiptArtifactDigest === attempt.receipt?.artifactDigest;
}

export interface PublicationCheckpoint {
  checkpointVersion: "lionlog.pages-publication-checkpoint.v1";
  repository: { id: number; name: string };
  branch: typeof PUBLICATION_STATE_BRANCH;
  writerId: number;
  stateParentSha: string;
  boundary: { runId: number; runAttempt: number; workflowSha: string };
  publication: {
    releaseId: string; sourceSha: string; candidateArtifactId: number; candidateArtifactDigest: string;
    manifestSha256: string; receiptArtifactId: number; receiptArtifactDigest: string; receiptSha256: string;
  };
  history: { sha256: string; coveredReruns: Array<{ runId: number; runAttempt: number }> };
}

const checkpointBrand: unique symbol = Symbol("verified publication checkpoint");
export type VerifiedPublicationCheckpoint = PublicationCheckpoint & { readonly [checkpointBrand]: string };

const publicProofBrand: unique symbol = Symbol("verified checkpoint public inventory");
const issuedPublicProofs = new WeakSet<object>();
const PUBLIC_PROOF_FRESHNESS_MS = 120_000;
export interface CheckpointPublicProof {
  readonly stateCommitSha: string;
  readonly releaseId: string;
  readonly manifestSha256: string;
  readonly observedAtMs: number;
  readonly [publicProofBrand]: true;
}

export function assertCheckpointPublicProof(checkpoint: VerifiedPublicationCheckpoint, value: unknown): asserts value is CheckpointPublicProof {
  assertVerifiedPublicationCheckpoint(checkpoint);
  const proof = value as CheckpointPublicProof;
  const checkedAtMs = Date.now();
  if (!proof || !issuedPublicProofs.has(proof) || !Object.isFrozen(proof)
    || proof.stateCommitSha !== checkpoint[checkpointBrand]
    || proof.releaseId !== checkpoint.publication.releaseId
    || proof.manifestSha256 !== checkpoint.publication.manifestSha256
    || !Number.isFinite(proof.observedAtMs) || proof.observedAtMs > checkedAtMs
    || checkedAtMs - proof.observedAtMs > PUBLIC_PROOF_FRESHNESS_MS) {
    throw new Error("Checkpoint requires a fresh, bound public inventory proof.");
  }
}

export async function observeCheckpointPublicProof(options: {
  checkpoint: VerifiedPublicationCheckpoint;
  manifestBytes: Buffer;
  token: string;
  authorizedWriterId: number;
  fetchImpl?: typeof fetch;
}): Promise<CheckpointPublicProof> {
  assertVerifiedPublicationCheckpoint(options.checkpoint);
  const observedAtMs = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const current = await loadPublicationCheckpoint({ token: options.token,
    authorizedWriterId: options.authorizedWriterId, fetchImpl });
  if (current.commitSha !== options.checkpoint[checkpointBrand]
    || JSON.stringify(current.checkpoint) !== JSON.stringify(options.checkpoint)) {
    throw new Error("Checkpoint state commit drifted before public inventory verification.");
  }
  await verifyCheckpointPublic(current.checkpoint, options.manifestBytes, fetchImpl);
  const after = await loadPublicationCheckpoint({ token: options.token,
    authorizedWriterId: options.authorizedWriterId, fetchImpl });
  if (after.commitSha !== current.commitSha
    || JSON.stringify(after.checkpoint) !== JSON.stringify(current.checkpoint)) {
    throw new Error("Checkpoint state commit drifted during public inventory verification.");
  }
  const completedAtMs = Date.now();
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(completedAtMs)
    || completedAtMs < observedAtMs || completedAtMs - observedAtMs > PUBLIC_PROOF_FRESHNESS_MS) {
    throw new Error("Checkpoint public inventory proof expired during observation.");
  }
  const proof = { stateCommitSha: current.commitSha,
    releaseId: current.checkpoint.publication.releaseId,
    manifestSha256: current.checkpoint.publication.manifestSha256,
    observedAtMs } as CheckpointPublicProof;
  Object.freeze(proof);
  issuedPublicProofs.add(proof);
  return proof;
}

export function assertVerifiedPublicationCheckpoint(value: unknown): asserts value is VerifiedPublicationCheckpoint {
  const checkpoint = value as VerifiedPublicationCheckpoint;
  if (typeof checkpoint !== "object" || checkpoint === null || !SHA.test(checkpoint[checkpointBrand] ?? "")
    || !Object.isFrozen(checkpoint) || !Object.isFrozen(checkpoint.boundary)
    || !Object.isFrozen(checkpoint.publication) || !Object.isFrozen(checkpoint.history)) {
    throw new Error("Checkpoint has not been independently validated.");
  }
}

export function validatePublicationCheckpoint(options: {
  checkpoint: unknown;
  receiptBytes: Buffer;
  state: { commitSha: string; parentSha: string; writerId: number; verified: boolean };
  authorizedWriterId: number;
}): VerifiedPublicationCheckpoint {
  const checkpoint = options.checkpoint as PublicationCheckpoint;
  const { state } = options;
  if (!positive(options.authorizedWriterId) || !SHA.test(state.commitSha) || !SHA.test(state.parentSha)
    || state.verified !== true || state.writerId !== options.authorizedWriterId
    || checkpoint?.writerId !== options.authorizedWriterId) throw new Error("Checkpoint writer authority is invalid.");
  if (!exact(checkpoint, ["boundary", "branch", "checkpointVersion", "history", "publication", "repository", "stateParentSha", "writerId"])
    || checkpoint.checkpointVersion !== "lionlog.pages-publication-checkpoint.v1"
    || !exact(checkpoint.repository, ["id", "name"])
    || checkpoint.repository.id !== LIONLOG_REPOSITORY_ID || checkpoint.repository.name !== LIONLOG_REPOSITORY
    || checkpoint.branch !== PUBLICATION_STATE_BRANCH) throw new Error("Checkpoint repository or schema is invalid.");
  if (checkpoint.stateParentSha !== state.parentSha) throw new Error("Checkpoint expected parent differs from the state commit.");
  const boundary = checkpoint.boundary;
  const publication = checkpoint.publication;
  const history = checkpoint.history;
  if (!exact(boundary, ["runId", "runAttempt", "workflowSha"])
    || !positive(boundary.runId) || !positive(boundary.runAttempt) || !SHA.test(boundary.workflowSha)
    || !exact(publication, ["candidateArtifactDigest", "candidateArtifactId", "manifestSha256", "receiptArtifactDigest", "receiptArtifactId", "receiptSha256", "releaseId", "sourceSha"])
    || !HASH.test(publication.releaseId) || !SHA.test(publication.sourceSha)
    || !positive(publication.candidateArtifactId) || !DIGEST.test(publication.candidateArtifactDigest)
    || !HASH.test(publication.manifestSha256) || !positive(publication.receiptArtifactId)
    || !DIGEST.test(publication.receiptArtifactDigest) || !HASH.test(publication.receiptSha256)
    || !exact(history, ["coveredReruns", "sha256"]) || !HASH.test(history.sha256)
    || !Array.isArray(history.coveredReruns) || history.coveredReruns.length > 1_000) {
    throw new Error("Checkpoint boundary or publication identity is invalid.");
  }
  let previous = 0;
  for (const rerun of history.coveredReruns) {
    if (!exact(rerun, ["runAttempt", "runId"]) || !positive(rerun.runId)
      || rerun.runId <= previous || rerun.runId > boundary.runId || !positive(rerun.runAttempt)
      || rerun.runAttempt < 2 || (rerun.runId === boundary.runId && rerun.runAttempt !== boundary.runAttempt)) {
      throw new Error("Checkpoint covered rerun map is invalid.");
    }
    previous = rerun.runId;
  }
  if (!Buffer.isBuffer(options.receiptBytes) || options.receiptBytes.length === 0 || options.receiptBytes.length > 256 * 1024
    || createHash("sha256").update(options.receiptBytes).digest("hex") !== publication.receiptSha256) {
    throw new Error("Checkpoint receipt bytes differ from the bound digest.");
  }
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse(options.receiptBytes.toString("utf8")) as Record<string, unknown>; }
  catch { throw new Error("Checkpoint receipt JSON is invalid."); }
  validateKnownGoodReceipt(receipt);
  const workflow = receipt.workflow as Record<string, unknown> | undefined;
  const candidate = receipt.candidate as Record<string, unknown> | undefined;
  const release = receipt.release as Record<string, unknown> | undefined;
  const official = receipt.official as Record<string, unknown> | undefined;
  const publicChecks = receipt.public as Record<string, unknown> | undefined;
  if (receipt.receiptVersion !== "lionlog.pages-flat-receipt.v1" || receipt.knownGood !== true || receipt.unresolved !== false
    || workflow?.runId !== boundary.runId || workflow.runAttempt !== boundary.runAttempt || workflow.sha !== boundary.workflowSha
    || candidate?.sourceSha !== publication.sourceSha || candidate.artifactId !== publication.candidateArtifactId
    || candidate.artifactDigest !== publication.candidateArtifactDigest || candidate.manifestSha256 !== publication.manifestSha256
    || release?.id !== publication.releaseId || official?.submissionStarted !== true || official.result !== "success"
    || official.pageUrl !== `${TARGET_ORIGIN}${TARGET_BASE_PATH}` || publicChecks?.markerVerified !== true
    || publicChecks.inventoryVerified !== true || publicChecks.browserVerified !== true) {
    throw new Error("Checkpoint receipt does not prove the exact known-good publication.");
  }
  const immutable = structuredClone(checkpoint);
  Object.defineProperty(immutable, checkpointBrand, { value: state.commitSha, enumerable: false });
  return deepFreeze(immutable) as VerifiedPublicationCheckpoint;
}

export function assertCheckpointRunBoundary(
  checkpoint: VerifiedPublicationCheckpoint,
  runs: Array<{ id: number; run_attempt: number }>,
): void {
  assertVerifiedPublicationCheckpoint(checkpoint);
  const coveredReruns = new Map(checkpoint.history.coveredReruns.map((value) => [value.runId, value.runAttempt]));
  let foundBoundary = false;
  const seen = new Set<number>();
  for (const run of runs) {
    if (!positive(run.id) || !positive(run.run_attempt) || seen.has(run.id)) throw new Error("Checkpoint run listing is invalid or duplicate.");
    seen.add(run.id);
    if (run.id === checkpoint.boundary.runId) foundBoundary = true;
    if (run.id <= checkpoint.boundary.runId && run.run_attempt !== (coveredReruns.get(run.id) ?? 1)) {
      throw new Error("Covered workflow run has a later rerun than the checkpoint boundary.");
    }
  }
  if (!foundBoundary) throw new Error("Checkpoint boundary run is absent from complete workflow history.");
  for (const runId of coveredReruns.keys()) if (!seen.has(runId)) throw new Error("Checkpoint covered rerun is absent from workflow history.");
}

function exact(value: unknown, keys: string[]): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const API = "https://api.github.com";
const REPO_API = `${API}/repos/${LIONLOG_REPOSITORY}`;
const STATE_REF_API = `${REPO_API}/git/ref/heads/lionlog-publication-state`;

/** Read only. A missing branch is an error; bootstrap requires a separately authorized seed. */
export async function loadPublicationCheckpoint(options: {
  token: string; authorizedWriterId: number; fetchImpl?: typeof fetch;
}): Promise<{ checkpoint: VerifiedPublicationCheckpoint; receiptBytes: Buffer; manifestBytes?: Buffer; commitSha: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const repository = await githubJson(fetchImpl, options.token, REPO_API) as Record<string, unknown>;
  if (repository.id !== LIONLOG_REPOSITORY_ID || repository.full_name !== LIONLOG_REPOSITORY) {
    throw new Error("Checkpoint repository identity drifted.");
  }
  const ref = await githubJson(fetchImpl, options.token, STATE_REF_API) as Record<string, unknown>;
  const refObject = ref.object as Record<string, unknown> | undefined;
  const commitSha = refObject?.sha;
  if (ref.ref !== PUBLICATION_STATE_BRANCH || refObject?.type !== "commit" || typeof commitSha !== "string" || !SHA.test(commitSha)) {
    throw new Error("Checkpoint state branch identity is invalid or absent.");
  }
  const commit = await githubJson(fetchImpl, options.token, `${REPO_API}/commits/${commitSha}`) as Record<string, unknown>;
  const commitInfo = commit.commit as Record<string, unknown> | undefined;
  const verification = commitInfo?.verification as Record<string, unknown> | undefined;
  const author = commit.author as Record<string, unknown> | undefined;
  const committer = commit.committer as Record<string, unknown> | undefined;
  const parents = commit.parents as Array<{ sha: string }> | undefined;
  const tree = commitInfo?.tree as Record<string, unknown> | undefined;
  if (commit.sha !== commitSha || !Array.isArray(parents) || parents.length !== 1 || !SHA.test(parents[0]?.sha)
    || author?.id !== options.authorizedWriterId || !positive(committer?.id)
    || verification?.verified !== true || typeof tree?.sha !== "string" || !SHA.test(tree.sha)) {
    throw new Error("Checkpoint commit lacks the authorized verified writer and exact parent.");
  }
  const treeRecord = await githubJson(fetchImpl, options.token, `${REPO_API}/git/trees/${tree.sha}`) as Record<string, unknown>;
  const entries = treeRecord.tree as Array<Record<string, unknown>> | undefined;
  if (treeRecord.sha !== tree.sha || treeRecord.truncated !== false || !Array.isArray(entries)
    || ![2, 3].includes(entries.length) || entries.some((entry) => entry.type !== "blob" || entry.mode !== "100644"
      || !["checkpoint.json", "receipt.json", "manifest.json"].includes(String(entry.path)))) {
    throw new Error("Checkpoint state tree has unexpected files.");
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  if (byPath.size !== entries.length || !byPath.has("checkpoint.json") || !byPath.has("receipt.json")) {
    throw new Error("Checkpoint state tree paths are invalid.");
  }
  const [checkpointBytes, receiptBytes] = await Promise.all([
    readCommittedFile(fetchImpl, options.token, commitSha, "checkpoint.json", String(byPath.get("checkpoint.json")!.sha)),
    readCommittedFile(fetchImpl, options.token, commitSha, "receipt.json", String(byPath.get("receipt.json")!.sha)),
  ]);
  let checkpointValue: unknown;
  try { checkpointValue = JSON.parse(checkpointBytes.toString("utf8")); }
  catch { throw new Error("Checkpoint state JSON is invalid."); }
  const checkpoint = validatePublicationCheckpoint({
    checkpoint: checkpointValue, receiptBytes,
    state: { commitSha, parentSha: parents[0].sha, writerId: Number(author.id), verified: true },
    authorizedWriterId: options.authorizedWriterId,
  });
  const manifestBytes = byPath.has("manifest.json")
    ? await readCommittedFile(fetchImpl, options.token, commitSha, "manifest.json", String(byPath.get("manifest.json")!.sha), CHECKPOINT_MANIFEST_MAX_BYTES)
    : undefined;
  if (manifestBytes) assertCheckpointManifestBytes(checkpoint, manifestBytes);
  const refAfter = await githubJson(fetchImpl, options.token, STATE_REF_API) as Record<string, unknown>;
  if ((refAfter.object as Record<string, unknown> | undefined)?.sha !== commitSha) {
    throw new Error("Checkpoint state branch moved during read.");
  }
  return { checkpoint, receiptBytes, manifestBytes, commitSha };
}

/** Installation-token preflight. The state ruleset must separately allow only this App to update. */
export async function assertAuthorizedWriterInstallation(options: {
  token: string; authorizedWriterId: number; authorizedAppSlug: string; fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!positive(options.authorizedWriterId)
    || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(options.authorizedAppSlug)) {
    throw new Error("Checkpoint App writer identity is invalid.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const installation = await githubJson(fetchImpl, options.token,
    `${API}/installation/repositories?per_page=100`) as Record<string, unknown>;
  const repositories = installation.repositories as Array<Record<string, unknown>> | undefined;
  if (installation.total_count !== 1 || !Array.isArray(repositories) || repositories.length !== 1
    || repositories[0].id !== LIONLOG_REPOSITORY_ID || repositories[0].full_name !== LIONLOG_REPOSITORY) {
    throw new Error("Checkpoint App installation is not limited to the approved repository.");
  }
  const login = `${options.authorizedAppSlug}[bot]`;
  const bot = await githubJson(fetchImpl, options.token,
    `${API}/users/${encodeURIComponent(login)}`) as Record<string, unknown>;
  if (bot.id !== options.authorizedWriterId || bot.login !== login || bot.type !== "Bot") {
    throw new Error("Checkpoint App bot identity differs from the approved writer.");
  }
}

/** One-time, preactivation seed on a separately approved zero-parent empty state root. */
export async function bootstrapPublicationCheckpoint(options: {
  token: string; authorizedWriterId: number; authorizedAppSlug: string;
  expectedRootSha: string; expectedRunId: number; expectedSourceSha: string;
  manifestBytes: Buffer; incidentHistory: unknown; productionRef: string;
  fetchImpl?: typeof fetch; now?: Date;
}): Promise<string> {
  const token = options.token;
  const authorizedWriterId = options.authorizedWriterId;
  const authorizedAppSlug = options.authorizedAppSlug;
  const expectedRootSha = options.expectedRootSha;
  const expectedRunId = options.expectedRunId;
  const expectedSourceSha = options.expectedSourceSha;
  const productionRef = options.productionRef;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!SHA.test(expectedRootSha) || !SHA.test(expectedSourceSha)
    || !positive(expectedRunId) || !Buffer.isBuffer(options.manifestBytes)
    || options.manifestBytes.length === 0 || options.manifestBytes.length > CHECKPOINT_MANIFEST_MAX_BYTES) {
    throw new Error("Checkpoint bootstrap authority or manifest is invalid.");
  }
  const manifestBytes = Buffer.from(options.manifestBytes);
  const incidentHistory = structuredClone(options.incidentHistory);
  const now = options.now === undefined ? undefined : new Date(options.now.getTime());
  branchFromProductionRef(productionRef);
  await assertAuthorizedWriterInstallation({ token,
    authorizedWriterId, authorizedAppSlug, fetchImpl });
  const assertRoot = async (): Promise<void> => {
    const ref = await githubJson(fetchImpl, token, STATE_REF_API) as Record<string, unknown>;
    if (ref.ref !== PUBLICATION_STATE_BRANCH
      || (ref.object as Record<string, unknown> | undefined)?.type !== "commit"
      || (ref.object as Record<string, unknown> | undefined)?.sha !== expectedRootSha) {
      throw new Error("Checkpoint bootstrap state ref is not the approved root.");
    }
  };
  await assertRoot();
  const root = await githubJson(fetchImpl, token,
    `${REPO_API}/commits/${expectedRootSha}`) as Record<string, unknown>;
  const rootTreeSha = (root.commit as Record<string, unknown> | undefined)?.tree as Record<string, unknown> | undefined;
  if (root.sha !== expectedRootSha || !Array.isArray(root.parents) || root.parents.length !== 0
    || typeof rootTreeSha?.sha !== "string" || !SHA.test(rootTreeSha.sha)) {
    throw new Error("Checkpoint bootstrap parent is not a zero-parent root.");
  }
  const rootTree = await githubJson(fetchImpl, token,
    `${REPO_API}/git/trees/${rootTreeSha.sha}`) as Record<string, unknown>;
  if (rootTree.sha !== rootTreeSha.sha || rootTree.truncated !== false
    || !Array.isArray(rootTree.tree) || rootTree.tree.length !== 0) {
    throw new Error("Checkpoint bootstrap root tree is not empty.");
  }
  const prepared = await preparePublicationCheckpoint({ token,
    authorizedWriterId, expectedParentSha: expectedRootSha,
    manifestBytes, incidentHistory,
    productionRef, fetchImpl, now });
  if (prepared.checkpoint.boundary.runId !== expectedRunId
    || prepared.checkpoint.boundary.runAttempt !== 1
    || prepared.checkpoint.boundary.workflowSha !== expectedSourceSha
    || prepared.checkpoint.publication.sourceSha !== expectedSourceSha
    || prepared.checkpoint.stateParentSha !== expectedRootSha
    || prepared.checkpoint.writerId !== authorizedWriterId) {
    throw new Error("Checkpoint bootstrap differs from the exact approved publication.");
  }
  await assertRoot();
  const query = `mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }`;
  const variables = { input: {
    branch: { repositoryNameWithOwner: LIONLOG_REPOSITORY, refName: PUBLICATION_STATE_BRANCH },
    expectedHeadOid: expectedRootSha,
    message: { headline: `Seed verified Pages checkpoint ${expectedRunId}/1` },
    fileChanges: { additions: [
      { path: "checkpoint.json", contents: Buffer.from(`${JSON.stringify(prepared.checkpoint, null, 2)}\n`).toString("base64") },
      { path: "receipt.json", contents: prepared.receiptBytes.toString("base64") },
      { path: "manifest.json", contents: manifestBytes.toString("base64") },
    ] },
  } };
  const result = await githubJson(fetchImpl, token, `${API}/graphql`, { query, variables }) as Record<string, unknown>;
  const mutation = (result.data as Record<string, unknown> | undefined)?.createCommitOnBranch as Record<string, unknown> | undefined;
  const commit = mutation?.commit as Record<string, unknown> | undefined;
  if (result.errors || typeof commit?.oid !== "string" || !SHA.test(commit.oid)) {
    throw new Error("Checkpoint bootstrap expected-parent state update failed.");
  }
  const loaded = await loadPublicationCheckpoint({ token,
    authorizedWriterId, fetchImpl });
  if (loaded.commitSha !== commit.oid
    || JSON.stringify(loaded.checkpoint) !== JSON.stringify(prepared.checkpoint)
    || !loaded.receiptBytes.equals(prepared.receiptBytes)
    || !loaded.manifestBytes?.equals(manifestBytes)) {
    throw new Error("Checkpoint bootstrap state moved or changed immediately after update.");
  }
  await observeCheckpointPublicProof({ checkpoint: loaded.checkpoint, manifestBytes,
    token, authorizedWriterId, fetchImpl });
  return loaded.commitSha;
}

/** The caller must hold the github-pages-production serialization group. This path never creates the state branch. */
export async function appendPublicationCheckpoint(options: {
  manifestBytes: Buffer; incidentHistory: unknown; expectedParentSha: string;
  token: string; authorizedWriterId: number; authorizedAppSlug: string; fetchImpl?: typeof fetch; now?: Date;
  productionRef?: string;
  expectedPublication?: { runId: number; runAttempt: number; workflowSha: string; sourceSha: string;
    manifestSha256: string; releaseId: string; candidateArtifactId: number; candidateArtifactDigest: string };
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if ("checkpoint" in options || "receiptBytes" in options || "previous" in options) {
    throw new Error("Checkpoint append rejects caller-supplied proposal or receipt authority.");
  }
  const expectedParentSha = options.expectedParentSha;
  const authorizedWriterId = options.authorizedWriterId;
  const token = options.token;
  const now = options.now === undefined ? undefined : new Date(options.now.getTime());
  const incidentHistory = structuredClone(options.incidentHistory);
  const expectedPublication = options.expectedPublication === undefined
    ? undefined : structuredClone(options.expectedPublication);
  if (!Buffer.isBuffer(options.manifestBytes) || options.manifestBytes.length === 0
    || options.manifestBytes.length > CHECKPOINT_MANIFEST_MAX_BYTES) throw new Error("Checkpoint manifest bytes are invalid.");
  const manifestBytes = Buffer.from(options.manifestBytes);
  if (!SHA.test(expectedParentSha) || !positive(authorizedWriterId)) {
    throw new Error("Checkpoint expected parent or writer is invalid.");
  }
  if (expectedPublication && (!positive(expectedPublication.runId) || expectedPublication.runAttempt !== 1
    || !SHA.test(expectedPublication.workflowSha) || !SHA.test(expectedPublication.sourceSha)
    || !HASH.test(expectedPublication.manifestSha256) || !HASH.test(expectedPublication.releaseId)
    || !positive(expectedPublication.candidateArtifactId) || !DIGEST.test(expectedPublication.candidateArtifactDigest))) {
    throw new Error("Checkpoint expected publication identity is invalid.");
  }
  await assertAuthorizedWriterInstallation({ token, authorizedWriterId,
    authorizedAppSlug: options.authorizedAppSlug, fetchImpl });
  // A first checkpoint needs a separately reviewed bootstrap authority. This append path only advances an authenticated one.
  const current = await loadPublicationCheckpoint({ token, authorizedWriterId, fetchImpl });
  if (current.commitSha !== expectedParentSha) throw new Error("Checkpoint expected parent is stale.");
  const prepared = await preparePublicationCheckpoint({ token, authorizedWriterId, expectedParentSha,
    manifestBytes, incidentHistory, now, previous: current.checkpoint, fetchImpl,
    productionRef: options.productionRef });
  if (prepared.checkpoint.stateParentSha !== expectedParentSha || prepared.checkpoint.writerId !== authorizedWriterId) {
    throw new Error("Checkpoint prepared authority differs from the authenticated parent.");
  }
  if (expectedPublication && (prepared.checkpoint.boundary.runId !== expectedPublication.runId
    || prepared.checkpoint.boundary.runAttempt !== expectedPublication.runAttempt
    || prepared.checkpoint.boundary.workflowSha !== expectedPublication.workflowSha
    || prepared.checkpoint.publication.sourceSha !== expectedPublication.sourceSha
    || prepared.checkpoint.publication.manifestSha256 !== expectedPublication.manifestSha256
    || prepared.checkpoint.publication.releaseId !== expectedPublication.releaseId
    || prepared.checkpoint.publication.candidateArtifactId !== expectedPublication.candidateArtifactId
    || prepared.checkpoint.publication.candidateArtifactDigest !== expectedPublication.candidateArtifactDigest)) {
    throw new Error("Checkpoint recollected publication differs from the expected terminal run.");
  }
  const ref = await githubJson(fetchImpl, token, STATE_REF_API) as Record<string, unknown>;
  if (ref.ref !== PUBLICATION_STATE_BRANCH || (ref.object as Record<string, unknown> | undefined)?.sha !== expectedParentSha) {
    throw new Error("Checkpoint expected parent is stale or state branch is absent.");
  }
  const query = `mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }`;
  const variables = { input: {
    branch: { repositoryNameWithOwner: LIONLOG_REPOSITORY, refName: PUBLICATION_STATE_BRANCH },
    expectedHeadOid: expectedParentSha,
    message: { headline: `Record verified Pages checkpoint ${prepared.checkpoint.boundary.runId}/${prepared.checkpoint.boundary.runAttempt}` },
    fileChanges: { additions: [
      { path: "checkpoint.json", contents: Buffer.from(`${JSON.stringify(prepared.checkpoint, null, 2)}\n`).toString("base64") },
      { path: "receipt.json", contents: prepared.receiptBytes.toString("base64") },
      { path: "manifest.json", contents: manifestBytes.toString("base64") },
    ] },
  } };
  const result = await githubJson(fetchImpl, token, `${API}/graphql`, { query, variables }) as Record<string, unknown>;
  const data = result.data as Record<string, unknown> | undefined;
  const mutation = data?.createCommitOnBranch as Record<string, unknown> | undefined;
  const commit = mutation?.commit as Record<string, unknown> | undefined;
  if (result.errors || typeof commit?.oid !== "string" || !SHA.test(commit.oid)) {
    throw new Error("Checkpoint expected-parent state update failed.");
  }
  const loaded = await loadPublicationCheckpoint({ token, authorizedWriterId, fetchImpl });
  if (loaded.commitSha !== commit.oid
    || JSON.stringify(loaded.checkpoint) !== JSON.stringify(prepared.checkpoint)
    || !loaded.receiptBytes.equals(prepared.receiptBytes)
    || !loaded.manifestBytes?.equals(manifestBytes)) {
    throw new Error("Checkpoint state moved or changed immediately after update.");
  }
  return loaded.commitSha;
}

async function readCommittedFile(fetchImpl: typeof fetch, token: string, commitSha: string, name: string, expectedBlobSha: string,
  maxBytes = 256 * 1024): Promise<Buffer> {
  if (!SHA.test(expectedBlobSha)) throw new Error("Checkpoint blob identity is invalid.");
  const value = await githubJson(fetchImpl, token, `${REPO_API}/contents/${name}?ref=${commitSha}`, undefined,
    Math.ceil(maxBytes * 1.5) + 16_384) as Record<string, unknown>;
  if (value.path !== name || value.type !== "file" || value.encoding !== "base64" || value.sha !== expectedBlobSha
    || typeof value.content !== "string" || /[^A-Za-z0-9+/=\r\n]/.test(value.content)) {
    throw new Error("Checkpoint committed file metadata is invalid.");
  }
  const encoded = value.content.replace(/[\r\n]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("Checkpoint committed file base64 is invalid.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || value.size !== bytes.length
    || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== expectedBlobSha) {
    throw new Error("Checkpoint committed file bytes differ from the Git tree.");
  }
  return bytes;
}

async function githubJson(fetchImpl: typeof fetch, token: string, url: string, body?: unknown, maxBytes = 1024 * 1024): Promise<unknown> {
  if (!token) throw new Error("Checkpoint GitHub token is missing.");
  const response = await fetchImpl(url, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok || response.redirected || (response.url && response.url !== url)) {
    throw new Error(`Checkpoint GitHub evidence is unavailable (HTTP ${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error("Checkpoint GitHub response size is invalid.");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

/** Offline proposal only. Call after the official workflow has reached a terminal state. */
export async function preparePublicationCheckpoint(options: {
  token: string; authorizedWriterId: number; expectedParentSha: string;
  manifestBytes: Buffer; incidentHistory: unknown; previous?: VerifiedPublicationCheckpoint;
  fetchImpl?: typeof fetch; now?: Date;
  productionRef?: string;
}): Promise<{ checkpoint: PublicationCheckpoint; receiptBytes: Buffer }> {
  const productionBranch = options.productionRef ? branchFromProductionRef(options.productionRef) : "main";
  if (!positive(options.authorizedWriterId) || !SHA.test(options.expectedParentSha)
    || !Buffer.isBuffer(options.manifestBytes) || options.manifestBytes.length === 0
    || options.manifestBytes.length > CHECKPOINT_MANIFEST_MAX_BYTES) throw new Error("Checkpoint proposal authority or manifest bytes are invalid.");
  if (options.previous) {
    assertVerifiedPublicationCheckpoint(options.previous);
    if (options.previous[checkpointBrand] !== options.expectedParentSha) {
      throw new Error("Checkpoint migration parent is not the validated state commit.");
    }
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = await collectPagesAttemptHistory({
    repository: LIONLOG_REPOSITORY, currentRunId: Number.MAX_SAFE_INTEGER,
    token: options.token, incidentHistory: options.incidentHistory,
    checkpoint: options.previous, strictCheckpointEvidence: true, fetchImpl, now: options.now,
    productionRef: options.productionRef,
  });
  if (attempts.length === 0) throw new Error("Checkpoint proposal has no completed publication attempt.");
  for (const attempt of attempts) {
    if (attempt.workflowId !== PROMOTION_WORKFLOW_ID
      || attempt.workflowPath !== ".github/workflows/deploy-github-pages.yml"
      || attempt.event !== "workflow_dispatch" || (attempt.headBranch !== "main" && attempt.headBranch !== productionBranch)
      || !SHA.test(attempt.workflowSha) || attempt.status !== "completed" || attempt.jobsComplete !== true
      || ((attempt.incidentEvidence !== null
        || (attempt.publishedResolution !== null && attempt.publishedResolution !== undefined))
        && !isResolvedPublishedPredecessor(attempt))) {
      throw new Error("Checkpoint proposal includes an unresolved or nonstandard attempt.");
    }
    if (!isKnownGoodAttempt(attempt) && !isProvenPreSubmissionFailure(attempt)
      && !isResolvedPublishedPredecessor(attempt)) {
      throw new Error("Checkpoint proposal includes an unknown submission outcome.");
    }
  }
  const boundary = attempts[attempts.length - 1];
  if (!isKnownGoodAttempt(boundary) || !boundary.receipt) {
    throw new Error("Checkpoint boundary is not a completed known-good publication.");
  }
  const receipt = validateKnownGoodReceipt(boundary.receipt.content);
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(options.manifestBytes.toString("utf8")); }
  catch { throw new Error("Checkpoint manifest JSON is invalid."); }
  const manifest = validatePublicationReleaseManifest(manifestValue);
  const manifestSha256 = createHash("sha256").update(options.manifestBytes).digest("hex");
  const candidate = receipt.candidate as typeof receipt.candidate & { sourceSha?: unknown };
  if (candidate.manifestSha256 !== manifestSha256 || candidate.sourceSha !== manifest.source.commitSha
    || receipt.release.id !== manifest.releaseId || boundary.workflowSha !== receipt.workflow.sha) {
    throw new Error("Checkpoint release/source/manifest identity does not match the flat receipt.");
  }
  if (options.previous && (boundary.runId <= options.previous.boundary.runId
    || manifest.releaseId === options.previous.publication.releaseId)) {
    throw new Error("Checkpoint migration has no newer distinct publication boundary.");
  }
  const receiptBytes = Buffer.from(`${JSON.stringify(boundary.receipt.content)}\n`);
  const reruns = new Map<number, number>(options.previous?.history.coveredReruns.map((item) => [item.runId, item.runAttempt]));
  const attemptsByRun = new Map<number, number[]>();
  for (const attempt of attempts) {
    const values = attemptsByRun.get(attempt.runId) ?? [];
    values.push(attempt.runAttempt);
    attemptsByRun.set(attempt.runId, values);
  }
  for (const [runId, values] of attemptsByRun) {
    const maximum = Math.max(...values);
    if (values.length !== maximum || values.some((value, index) => value !== index + 1)) {
      throw new Error("Checkpoint proposal lacks complete run-attempt history.");
    }
    if (maximum > 1) reruns.set(runId, maximum);
  }
  const historySha256 = createHash("sha256")
    .update(options.previous?.history.sha256 ?? "lionlog.pages-publication-history.v1")
    .update(JSON.stringify(attempts)).digest("hex");
  const checkpoint: PublicationCheckpoint = {
    checkpointVersion: "lionlog.pages-publication-checkpoint.v1",
    repository: { id: LIONLOG_REPOSITORY_ID, name: LIONLOG_REPOSITORY }, branch: PUBLICATION_STATE_BRANCH,
    writerId: options.authorizedWriterId, stateParentSha: options.expectedParentSha,
    boundary: { runId: boundary.runId, runAttempt: boundary.runAttempt, workflowSha: boundary.workflowSha },
    publication: {
      releaseId: manifest.releaseId, sourceSha: manifest.source.commitSha,
      candidateArtifactId: candidate.artifactId, candidateArtifactDigest: candidate.artifactDigest,
      manifestSha256, receiptArtifactId: boundary.receipt.artifactId,
      receiptArtifactDigest: boundary.receipt.artifactDigest,
      receiptSha256: createHash("sha256").update(receiptBytes).digest("hex"),
    },
    history: { sha256: historySha256,
      coveredReruns: [...reruns].sort(([left], [right]) => left - right)
        .map(([runId, runAttempt]) => ({ runId, runAttempt })) },
  };
  validatePublicationCheckpoint({ checkpoint: structuredClone(checkpoint), receiptBytes,
    state: { commitSha: options.expectedParentSha, parentSha: options.expectedParentSha,
      writerId: options.authorizedWriterId, verified: true }, authorizedWriterId: options.authorizedWriterId });
  await verifyCheckpointPublic(checkpoint, options.manifestBytes, fetchImpl);
  return { checkpoint, receiptBytes };
}

async function verifyCheckpointPublic(checkpoint: PublicationCheckpoint, manifestBytes: Buffer, fetchImpl: typeof fetch): Promise<void> {
  const manifest = assertCheckpointManifestBytes(checkpoint, manifestBytes);
  const before = await observePublicRelease(fetchImpl);
  if (before.state !== "present" || before.releaseId !== manifest.releaseId) {
    throw new Error("Checkpoint public marker drifted before inventory verification.");
  }
  await verifyPublicSite({ manifest, fetchImpl });
  const after = await observePublicRelease(fetchImpl);
  if (after.state !== "present" || after.releaseId !== manifest.releaseId) {
    throw new Error("Checkpoint public marker drifted during inventory verification.");
  }
}

function assertCheckpointManifestBytes(checkpoint: PublicationCheckpoint, manifestBytes: Buffer) {
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length === 0 || manifestBytes.length > CHECKPOINT_MANIFEST_MAX_BYTES
    || createHash("sha256").update(manifestBytes).digest("hex") !== checkpoint.publication.manifestSha256) {
    throw new Error("Checkpoint manifest bytes differ from the bound digest.");
  }
  let value: unknown;
  try { value = JSON.parse(manifestBytes.toString("utf8")); }
  catch { throw new Error("Checkpoint public manifest JSON is invalid."); }
  const manifest = validatePublicationReleaseManifest(value);
  if (manifest.releaseId !== checkpoint.publication.releaseId
    || manifest.source.commitSha !== checkpoint.publication.sourceSha) {
    throw new Error("Checkpoint manifest release or source differs from the receipt.");
  }
  return manifest;
}
