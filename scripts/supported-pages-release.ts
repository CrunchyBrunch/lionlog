import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LIVE_CANDIDATE_WORKFLOW,
  LIVE_CANDIDATE_WORKFLOW_ID,
  LIONLOG_REPOSITORY,
  LIONLOG_REPOSITORY_ID,
  PROMOTION_WORKFLOW_ID,
  REQUIRED_CI_WORKFLOW,
  REQUIRED_CI_WORKFLOW_ID,
  TARGET_BASE_PATH,
  TARGET_ORIGIN,
  validatePublicationReleaseManifest,
  validatePublicationReleaseMarker,
  type PublicationReleaseManifest,
} from "../infrastructure/publication/release-contract.ts";
import { deriveMenuEvidence } from "../infrastructure/publication/menu-evidence.ts";
import { computePublicationReleaseId, sha256 } from "./create-publication-bundle.ts";
import { extractPublicationTar, parsePublicationTar } from "./publication-tar.ts";
import { validatePagesArtifact, validatePublicationEntryPath } from "./prepare-pages-artifact.ts";
import { assertExpectedPredecessor, validateExpectedPredecessor, type PublicReleaseObservation } from "./public-release-state.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
export const PREAPPROVAL_HEADROOM_MS = 30 * 60_000;
export const ACTION_HEADROOM_MS = 15 * 60_000;
const MAX_ARTIFACT_BYTES = 110 * 1024 * 1024;
const PROMOTION_WORKFLOW = ".github/workflows/deploy-github-pages.yml";

export interface Metadata {
  repository: { id: number; full_name: string };
  main: { sha: string };
  workflowRun: GithubRun;
  candidateRun: GithubRun;
  candidateArtifact: GithubArtifact;
  ciRun: GithubRun;
  ciJobs: Array<{ name: string; head_sha: string; status: string; conclusion: string }>;
}

export interface GithubRun {
  id: number;
  workflow_id: number;
  path: string;
  event: string;
  head_sha: string;
  head_branch: string;
  run_attempt: number;
  status: string;
  conclusion: string | null;
}

export interface GithubArtifact {
  id: number;
  name: string;
  digest: string;
  size_in_bytes: number;
  expired: boolean;
  expires_at: string;
  workflow_run: { id: number; head_sha: string; head_branch: string; head_repository_id: number };
}

export interface ValidatedRelease {
  summaryVersion: "lionlog.pages-validated-release.v1";
  operation: "promote" | "rollback";
  workflow: { sha: string; runId: number; runAttempt: 1 };
  candidate: {
    runId: number;
    sourceSha: string;
    artifactId: number;
    artifactName: string;
    artifactDigest: string;
    artifactExpiresAt: string;
    manifestSha256: string;
  };
  ci: { runId: number };
  release: {
    id: string;
    kind: "live";
    serviceDate: string;
    coverage: "complete" | "partial";
    omissions: { "invalid-name": number };
    earliestFreshUntil: string;
    earliestRetainUntil: string;
  };
  site: PublicationReleaseManifest["site"];
  rollbackReceipt: null | {
    artifactId: number; artifactDigest: string; artifactExpiresAt: string; runId: number;
    releaseId: string; sourceWorkflowSha: string;
  };
  authorization: { approvalExpiresAt: string; predecessorReleaseId: string };
}

export async function verifySupportedCandidate(options: {
  operation: "promote" | "rollback";
  bundleDirectory: string;
  extractionDirectory: string;
  metadata: Metadata;
  workflowSha: string;
  workflowRunId: number;
  candidateRunId: number;
  candidateArtifactId: number;
  candidateArtifactDigest: string;
  candidateManifestSha256: string;
  expectedReleaseId: string;
  expectedSourceSha: string;
  expectedServiceDate: string;
  rollbackReceipt?: unknown;
  rollbackReceiptArtifactId?: number;
  rollbackReceiptArtifactDigest?: string;
  rollbackReceiptArtifact?: GithubArtifact;
  rollbackReceiptRun?: GithubRun;
  approvalExpiresAt: string;
  expectedPredecessorReleaseId: string;
  publicPredecessor: PublicReleaseObservation;
  now: Date;
}): Promise<ValidatedRelease> {
  const { metadata } = options;
  assertSha(options.workflowSha, "Workflow SHA");
  assertSha(options.expectedSourceSha, "Source SHA");
  assertHash(options.candidateManifestSha256, "Manifest digest");
  assertHash(options.expectedReleaseId, "Release ID");
  assertArtifactDigest(options.candidateArtifactDigest, "Candidate artifact digest");
  assertPositive(options.workflowRunId, "Workflow run ID");
  assertPositive(options.candidateRunId, "Candidate run ID");
  assertPositive(options.candidateArtifactId, "Candidate artifact ID");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.expectedServiceDate)) throw new Error("Expected service date is invalid.");
  if (!Number.isFinite(options.now.getTime())) throw new Error("Verification time is invalid.");
  const approvalExpiresAt = parseStrictTimestamp(options.approvalExpiresAt, "Approval expiry");
  if (approvalExpiresAt < options.now.getTime() + PREAPPROVAL_HEADROOM_MS) throw new Error("Approval expiry lacks preapproval headroom.");
  const predecessorReleaseId = validateExpectedPredecessor(options.expectedPredecessorReleaseId);
  assertExpectedPredecessor(predecessorReleaseId, options.publicPredecessor);

  validateTrustedMetadata(metadata, options);
  const manifestPath = path.join(options.bundleDirectory, "release-manifest.json");
  const [manifestInfo, manifestRealPath, bundleRealPath, manifestBytes] = await Promise.all([
    lstat(manifestPath),
    realpath(manifestPath),
    realpath(options.bundleDirectory),
    readFile(manifestPath),
  ]);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || manifestRealPath !== path.join(bundleRealPath, "release-manifest.json")) {
    throw new Error("Candidate manifest is not one canonical regular file.");
  }
  if (sha256(manifestBytes) !== options.candidateManifestSha256) throw new Error("Candidate manifest digest mismatch.");
  const manifest = validatePublicationReleaseManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.releaseId !== options.expectedReleaseId) throw new Error("Candidate release ID mismatch.");
  if (manifest.releaseKind !== "live" || manifest.menu === null) throw new Error("Production promotion accepts only a validated live release; first-release recovery is separate.");
  if (manifest.menu.serviceDate !== options.expectedServiceDate) throw new Error("Candidate service date mismatch.");
  if (manifest.source.commitSha !== options.expectedSourceSha || manifest.source.workflowRunId !== options.candidateRunId) {
    throw new Error("Candidate manifest source identity mismatch.");
  }
  const computedReleaseId = computePublicationReleaseId({
    releaseKind: manifest.releaseKind,
    sourceCommitSha: manifest.source.commitSha,
    workflowRunId: manifest.source.workflowRunId,
    workflowRunAttempt: manifest.source.workflowRunAttempt,
    serviceDate: manifest.menu.serviceDate,
    catalogSha256: manifest.menu.catalogSha256,
    shellRevision: manifest.shellRevision,
    recoveryReleaseId: manifest.recovery?.releaseId ?? null,
  });
  if (computedReleaseId !== manifest.releaseId) throw new Error("Candidate release identity does not match its provenance.");

  const tarBytes = await readFile(path.join(options.bundleDirectory, manifest.site.tarFile));
  if (tarBytes.byteLength !== manifest.site.bytes || sha256(tarBytes) !== manifest.site.tarSha256) {
    throw new Error("Candidate site tar identity mismatch.");
  }
  const entries = parsePublicationTar(tarBytes);
  const inventory = entries.map((entry) => ({ path: entry.path, bytes: entry.data.byteLength, sha256: sha256(entry.data) }));
  if (JSON.stringify(inventory) !== JSON.stringify(manifest.site.inventory)) throw new Error("Candidate inventory mismatch.");
  const menu = deriveMenuEvidence(entries, manifest.source.commitSha, sha256, { bundleCreatedAt: manifest.createdAt, verificationTime: options.now }).menu;
  if (JSON.stringify(menu) !== JSON.stringify(manifest.menu)) throw new Error("Candidate menu claims differ from the validated bytes.");
  const markerEntry = entries.find((entry) => entry.path === manifest.marker.path);
  if (!markerEntry || sha256(markerEntry.data) !== manifest.marker.sha256) throw new Error("Candidate release marker identity mismatch.");
  const marker = validatePublicationReleaseMarker(JSON.parse(markerEntry.data.toString("utf8")));
  if (marker.releaseId !== manifest.releaseId || marker.sourceCommitSha !== manifest.source.commitSha || marker.serviceDate !== manifest.menu.serviceDate) {
    throw new Error("Candidate release marker does not match the manifest.");
  }

  await rm(options.extractionDirectory, { recursive: true, force: true });
  await extractPublicationTar(tarBytes, options.extractionDirectory);
  const extractedFiles = await validatePagesArtifact(options.extractionDirectory);
  if (JSON.stringify(extractedFiles) !== JSON.stringify(inventory.map((entry) => entry.path))) throw new Error("Extracted candidate inventory changed.");

  const freshUntil = Date.parse(manifest.menu.earliestFreshUntil);
  const retainUntil = Date.parse(manifest.menu.earliestRetainUntil);
  if (options.operation === "promote" && freshUntil < options.now.getTime() + PREAPPROVAL_HEADROOM_MS) {
    throw new Error("Candidate lacks the required preapproval freshness headroom.");
  }
  if (retainUntil < options.now.getTime() + PREAPPROVAL_HEADROOM_MS) throw new Error("Candidate lacks the required preapproval retention headroom.");
  if (Date.parse(metadata.candidateArtifact.expires_at) < options.now.getTime() + PREAPPROVAL_HEADROOM_MS) {
    throw new Error("Candidate artifact lacks the required preapproval availability headroom.");
  }

  let rollbackReceipt: ValidatedRelease["rollbackReceipt"] = null;
  if (options.operation === "rollback") {
    const receipt = validateKnownGoodReceipt(options.rollbackReceipt);
    assertPositive(options.rollbackReceiptArtifactId, "Rollback receipt artifact ID");
    assertArtifactDigest(options.rollbackReceiptArtifactDigest, "Rollback receipt artifact digest");
    const receiptArtifact = options.rollbackReceiptArtifact;
    const receiptRun = options.rollbackReceiptRun;
    if (
      receiptArtifact?.id !== options.rollbackReceiptArtifactId
      || receiptArtifact.digest !== options.rollbackReceiptArtifactDigest
      || !/^lionlog-pages-receipt-[1-9][0-9]*-1$/.test(receiptArtifact.name)
      || receiptArtifact.expired || Date.parse(receiptArtifact.expires_at) <= options.now.getTime()
      || receiptArtifact.workflow_run.head_repository_id !== LIONLOG_REPOSITORY_ID
      || receiptArtifact.workflow_run.id !== receiptRun?.id
      || receiptArtifact.workflow_run.head_sha !== receipt.workflow.sha
      || receiptRun.workflow_id !== PROMOTION_WORKFLOW_ID || receiptRun.path !== PROMOTION_WORKFLOW
      || receiptRun.event !== "workflow_dispatch" || receiptRun.head_sha !== receipt.workflow.sha
      || receiptRun.head_branch !== "main" || receiptRun.run_attempt !== 1
      || receiptRun.status !== "completed" || receiptRun.conclusion !== "success"
    ) throw new Error("Rollback receipt artifact provenance is invalid or expired.");
    if (
      receipt.release.id !== manifest.releaseId
      || receipt.candidate.artifactId !== options.candidateArtifactId
      || receipt.candidate.artifactDigest !== options.candidateArtifactDigest
      || receipt.candidate.manifestSha256 !== options.candidateManifestSha256
    ) throw new Error("Rollback receipt does not bind the exact retained candidate bytes.");
    rollbackReceipt = {
      artifactId: options.rollbackReceiptArtifactId!,
      artifactDigest: options.rollbackReceiptArtifactDigest!,
      artifactExpiresAt: receiptArtifact.expires_at,
      runId: receiptRun.id,
      releaseId: receipt.release.id,
      sourceWorkflowSha: receipt.workflow.sha,
    };
  } else if (options.rollbackReceipt !== undefined) {
    throw new Error("Promotion cannot carry a rollback receipt.");
  }

  return {
    summaryVersion: "lionlog.pages-validated-release.v1",
    operation: options.operation,
    workflow: { sha: options.workflowSha, runId: options.workflowRunId, runAttempt: 1 },
    candidate: {
      runId: options.candidateRunId,
      sourceSha: options.expectedSourceSha,
      artifactId: options.candidateArtifactId,
      artifactName: metadata.candidateArtifact.name,
      artifactDigest: options.candidateArtifactDigest,
      artifactExpiresAt: metadata.candidateArtifact.expires_at,
      manifestSha256: options.candidateManifestSha256,
    },
    ci: { runId: metadata.ciRun.id },
    release: {
      id: manifest.releaseId,
      kind: "live",
      serviceDate: manifest.menu.serviceDate,
      coverage: manifest.menu.coverage,
      omissions: manifest.menu.omissions,
      earliestFreshUntil: manifest.menu.earliestFreshUntil,
      earliestRetainUntil: manifest.menu.earliestRetainUntil,
    },
    site: manifest.site,
    rollbackReceipt,
    authorization: { approvalExpiresAt: options.approvalExpiresAt, predecessorReleaseId },
  };
}

export function inspectPagesActionTar(archive: Buffer): Array<{ path: string; bytes: number; sha256: string }> {
  if (archive.byteLength === 0 || archive.byteLength > 100 * 1024 * 1024 || archive.byteLength % 512 !== 0) throw new Error("Staged Pages tar size is invalid.");
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const seen = new Set<string>();
  let offset = 0;
  let terminators = 0;
  while (offset < archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((value) => value === 0)) {
      terminators += 1;
      if (terminators >= 2) {
        if (!archive.subarray(offset).every((value) => value === 0)) throw new Error("Staged Pages tar has data after its terminator.");
        break;
      }
      continue;
    }
    if (terminators > 0) throw new Error("Staged Pages tar has an invalid terminator.");
    const storedChecksum = readOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    if (storedChecksum !== checksumHeader.reduce((sum, value) => sum + value, 0)) throw new Error("Staged Pages tar checksum is invalid.");
    const prefix = readString(header, 345, 155);
    const name = `${prefix}${prefix ? "/" : ""}${readString(header, 0, 100)}`;
    const size = readOctal(header, 124, 12);
    if (size > 10 * 1024 * 1024 || offset + size > archive.byteLength) throw new Error("Staged Pages tar entry size is invalid.");
    const type = header[156];
    const normalized = normalizeActionTarPath(name, type === "5".charCodeAt(0));
    if (type === "5".charCodeAt(0)) {
      if (size !== 0) throw new Error("Staged Pages directory contains data.");
    } else if (type === 0 || type === "0".charCodeAt(0)) {
      if (normalized === "") throw new Error("Staged Pages tar contains an unnamed file.");
      if (seen.has(normalized)) throw new Error(`Staged Pages tar contains a duplicate file: ${normalized}`);
      seen.add(normalized);
      const data = archive.subarray(offset, offset + size);
      files.push({ path: normalized, bytes: size, sha256: createHash("sha256").update(data).digest("hex") });
    } else {
      throw new Error(`Staged Pages tar contains a prohibited entry type: ${String.fromCharCode(type)}.`);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (terminators < 2 || files.length === 0) throw new Error("Staged Pages tar is incomplete.");
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export async function createPreapprovalSummary(options: {
  validated: ValidatedRelease;
  stagedArtifact: GithubArtifact;
  stagedArtifactName: string;
  stagedTarPath: string;
  now: Date;
}): Promise<Record<string, unknown>> {
  const expectedName = `lionlog-pages-${options.validated.workflow.runId}-${options.validated.workflow.runAttempt}`;
  if (options.stagedArtifactName !== expectedName || options.stagedArtifact.name !== expectedName) throw new Error("Staged Pages artifact name is not unique to this run attempt.");
  if (
    !Number.isSafeInteger(options.stagedArtifact.id)
    || options.stagedArtifact.id <= 0
    || !ARTIFACT_DIGEST.test(options.stagedArtifact.digest)
    || options.stagedArtifact.expired
    || options.stagedArtifact.workflow_run.id !== options.validated.workflow.runId
    || options.stagedArtifact.workflow_run.head_sha !== options.validated.workflow.sha
    || options.stagedArtifact.workflow_run.head_branch !== "main"
    || options.stagedArtifact.workflow_run.head_repository_id !== LIONLOG_REPOSITORY_ID
  ) throw new Error("Staged Pages artifact provenance mismatch.");
  if (!Number.isFinite(options.now.getTime()) || Date.parse(options.stagedArtifact.expires_at) < options.now.getTime() + PREAPPROVAL_HEADROOM_MS) {
    throw new Error("Staged Pages artifact lacks the required preapproval availability headroom.");
  }
  const stagedTar = await readFile(options.stagedTarPath);
  const inventory = inspectPagesActionTar(stagedTar);
  if (JSON.stringify(inventory) !== JSON.stringify(options.validated.site.inventory)) throw new Error("Staged Pages artifact inventory differs from the approved candidate.");
  return {
    ...options.validated,
    summaryVersion: "lionlog.pages-preapproval.v1",
    staged: {
      artifactId: options.stagedArtifact.id,
      artifactName: options.stagedArtifact.name,
      artifactDigest: options.stagedArtifact.digest,
      artifactExpiresAt: options.stagedArtifact.expires_at,
      tarSha256: sha256(stagedTar),
    },
  };
}

function validateTrustedMetadata(metadata: Metadata, options: Parameters<typeof verifySupportedCandidate>[0]): void {
  if (metadata.repository.id !== LIONLOG_REPOSITORY_ID || metadata.repository.full_name !== LIONLOG_REPOSITORY) throw new Error("Repository identity mismatch.");
  if (metadata.main.sha !== options.workflowSha) throw new Error("Authoritative main differs from the workflow SHA.");
  const workflow = metadata.workflowRun;
  if (
    workflow.id !== options.workflowRunId || workflow.workflow_id !== PROMOTION_WORKFLOW_ID || workflow.path !== PROMOTION_WORKFLOW
    || workflow.event !== "workflow_dispatch" || workflow.head_sha !== options.workflowSha || workflow.head_branch !== "main"
    || workflow.run_attempt !== 1 || workflow.status !== "in_progress" || workflow.conclusion !== null
  ) throw new Error("Production workflow identity mismatch.");
  const run = metadata.candidateRun;
  if (
    run.id !== options.candidateRunId || run.workflow_id !== LIVE_CANDIDATE_WORKFLOW_ID || run.path !== LIVE_CANDIDATE_WORKFLOW
    || run.event !== "workflow_dispatch" || run.head_sha !== options.expectedSourceSha || run.head_branch !== "main"
    || run.run_attempt !== 1 || run.status !== "completed" || run.conclusion !== "success"
  ) throw new Error("Candidate producer provenance mismatch.");
  const artifact = metadata.candidateArtifact;
  const expiresAt = Date.parse(artifact.expires_at);
  if (
    artifact.id !== options.candidateArtifactId || artifact.digest !== options.candidateArtifactDigest
    || !artifact.name.startsWith("lionlog-live-") || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > MAX_ARTIFACT_BYTES
    || artifact.expired || !Number.isFinite(expiresAt) || expiresAt <= options.now.getTime()
    || artifact.workflow_run.id !== options.candidateRunId || artifact.workflow_run.head_sha !== options.expectedSourceSha
    || artifact.workflow_run.head_branch !== "main" || artifact.workflow_run.head_repository_id !== LIONLOG_REPOSITORY_ID
  ) throw new Error("Candidate artifact provenance mismatch.");
  const ci = metadata.ciRun;
  if (
    ci.workflow_id !== REQUIRED_CI_WORKFLOW_ID || ci.path !== REQUIRED_CI_WORKFLOW || ci.event !== "push"
    || ci.head_sha !== options.expectedSourceSha || ci.head_branch !== "main" || ci.run_attempt !== 1
    || ci.status !== "completed" || ci.conclusion !== "success"
    || !metadata.ciJobs.some((job) => job.name === "verify" && job.head_sha === options.expectedSourceSha && job.status === "completed" && job.conclusion === "success")
  ) throw new Error("Exact source commit lacks a successful CI verification job.");
}

interface KnownGoodReceipt {
  receiptVersion: "lionlog.pages-flat-receipt.v1";
  knownGood: true;
  unresolved: false;
  workflow: { sha: string };
  candidate: { artifactId: number; artifactDigest: string; manifestSha256: string };
  release: { id: string };
  official: { submissionStarted: true; result: "success"; pageUrl: string };
  public: { markerVerified: true; inventoryVerified: true; browserVerified: true };
}

function validateKnownGoodReceipt(value: unknown): KnownGoodReceipt {
  const receipt = value as Partial<KnownGoodReceipt>;
  if (
    receipt?.receiptVersion !== "lionlog.pages-flat-receipt.v1"
    || receipt.knownGood !== true
    || receipt.unresolved !== false
    || receipt.official?.submissionStarted !== true
    || receipt.official?.result !== "success"
    || receipt.official?.pageUrl !== `${TARGET_ORIGIN}${TARGET_BASE_PATH}`
    || receipt.public?.markerVerified !== true
    || receipt.public?.inventoryVerified !== true
    || receipt.public?.browserVerified !== true
    || !SHA256.test(receipt.release?.id ?? "")
    || !Number.isSafeInteger(receipt.candidate?.artifactId)
    || !ARTIFACT_DIGEST.test(receipt.candidate?.artifactDigest ?? "")
    || !SHA256.test(receipt.candidate?.manifestSha256 ?? "")
    || !GIT_SHA.test(receipt.workflow?.sha ?? "")
  ) throw new Error("Rollback receipt is not a complete known-good flat receipt.");
  return receipt as KnownGoodReceipt;
}

function normalizeActionTarPath(value: string, directory: boolean): string {
  let normalized = value.replace(/^\.\//, "");
  if (directory) normalized = normalized.replace(/\/$/, "");
  if (normalized === "") return "";
  validatePublicationEntryPath(normalized);
  return normalized;
}

function readString(buffer: Buffer, offset: number, length: number): string {
  const value = buffer.subarray(offset, offset + length);
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8");
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const text = readString(buffer, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error("Staged Pages tar numeric field is invalid.");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Staged Pages tar numeric field is out of range.");
  return value;
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) throw new Error(`${label} is invalid.`);
}
function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is invalid.`);
}
function assertArtifactDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ARTIFACT_DIGEST.test(value)) throw new Error(`${label} is invalid.`);
}
function assertPositive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} is invalid.`);
}

function argumentsMap(): Map<string, string> {
  return new Map(process.argv.slice(3).map((argument) => {
    const [name, ...rest] = argument.split("=");
    return [name, rest.join("=")];
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  const args = argumentsMap();
  const required = (name: string): string => {
    const value = args.get(name);
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  if (mode === "candidate") {
    const operation = required("--operation");
    if (operation !== "promote" && operation !== "rollback") throw new Error("Operation is invalid.");
    const rollbackPath = args.get("--rollback-receipt");
    const validated = await verifySupportedCandidate({
      operation,
      bundleDirectory: required("--bundle"),
      extractionDirectory: required("--extract"),
      metadata: JSON.parse(await readFile(required("--metadata"), "utf8")),
      workflowSha: required("--workflow-sha"),
      workflowRunId: Number(required("--workflow-run-id")),
      candidateRunId: Number(required("--candidate-run-id")),
      candidateArtifactId: Number(required("--candidate-artifact-id")),
      candidateArtifactDigest: required("--candidate-artifact-digest"),
      candidateManifestSha256: required("--candidate-manifest-sha256"),
      expectedReleaseId: required("--release-id"),
      expectedSourceSha: required("--source-sha"),
      expectedServiceDate: required("--service-date"),
      rollbackReceipt: rollbackPath ? JSON.parse(await readFile(rollbackPath, "utf8")) : undefined,
      rollbackReceiptArtifactId: args.has("--rollback-receipt-artifact-id") ? Number(required("--rollback-receipt-artifact-id")) : undefined,
      rollbackReceiptArtifactDigest: args.get("--rollback-receipt-artifact-digest"),
      rollbackReceiptArtifact: args.has("--rollback-receipt-artifact-metadata")
        ? JSON.parse(await readFile(required("--rollback-receipt-artifact-metadata"), "utf8")) : undefined,
      rollbackReceiptRun: args.has("--rollback-receipt-run-metadata")
        ? JSON.parse(await readFile(required("--rollback-receipt-run-metadata"), "utf8")) : undefined,
      now: new Date(args.get("--now") ?? Date.now()),
      approvalExpiresAt: required("--approval-expires-at"),
      expectedPredecessorReleaseId: required("--predecessor-release-id"),
      publicPredecessor: JSON.parse(await readFile(required("--public-predecessor"), "utf8")),
    });
    process.stdout.write(`${JSON.stringify(validated, null, 2)}\n`);
  } else if (mode === "stage") {
    const summary = await createPreapprovalSummary({
      validated: JSON.parse(await readFile(required("--validated"), "utf8")),
      stagedArtifact: JSON.parse(await readFile(required("--staged-metadata"), "utf8")),
      stagedArtifactName: required("--staged-name"),
      stagedTarPath: required("--staged-tar"),
      now: new Date(args.get("--now") ?? Date.now()),
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    throw new Error("Supported Pages release mode is invalid.");
  }
}

function parseStrictTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${label} is invalid.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} is invalid.`);
  return parsed;
}
