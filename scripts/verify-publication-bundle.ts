import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LIVE_CANDIDATE_WORKFLOW,
  LIVE_CANDIDATE_WORKFLOW_ID,
  LIONLOG_REPOSITORY,
  LIONLOG_REPOSITORY_ID,
  REQUIRED_CI_WORKFLOW,
  REQUIRED_CI_WORKFLOW_ID,
  TARGET_BASE_PATH,
  TARGET_ORIGIN,
  validatePublicationReleaseManifest,
  validatePublicationReleaseMarker,
  type PublicationReleaseManifest,
} from "../infrastructure/publication/release-contract.ts";
import { deriveMenuEvidence } from "../infrastructure/publication/menu-evidence.ts";
import { validatePagesArtifact } from "./prepare-pages-artifact.ts";
import { createPublicationTar, extractPublicationTar, parsePublicationTar } from "./publication-tar.ts";
import { computePublicationReleaseId, sha256 } from "./create-publication-bundle.ts";

const MINIMUM_FRESHNESS_MS = 15 * 60_000;

interface GithubMetadata {
  repository: { id: number; full_name: string };
  main: { sha: string };
  artifact: {
    id: number;
    name: string;
    digest: string;
    size_in_bytes: number;
    expired: boolean;
    expires_at: string;
    workflow_run: { id: number; head_sha: string; head_branch: string; head_repository_id: number };
  };
  run: {
    id: number;
    event: string;
    head_sha: string;
    head_branch: string;
    run_attempt: number;
    status: string;
    conclusion: string;
    path: string;
    workflow_id: number;
  };
  ciRun: {
    id: number;
    workflow_id: number;
    path: string;
    event: string;
    head_sha: string;
    head_branch: string;
    run_attempt: number;
    status: string;
    conclusion: string;
  };
  ciJobs: Array<{ name: string; head_sha: string; status: string; conclusion: string }>;
}

export interface PublicationVerificationOptions {
  bundleDirectory: string;
  extractionDirectory?: string;
  metadata: GithubMetadata;
  operation: "promote" | "rollback" | "first-release-recovery";
  expectedSourceSha: string;
  expectedRunId: number;
  expectedRunAttempt: number;
  expectedArtifactId: number;
  expectedArtifactDigest: string;
  expectedManifestSha256: string;
  expectedServiceDate: string;
  approvalExpiresAt: string;
  partialApproval: string;
  expiredRollbackApproval: string;
  workflowSha: string;
  expectedPromotionWorkflowSha: string;
  expectedRecoveryArtifactId: number;
  expectedRecoveryArtifactDigest: string;
  expectedRecoveryManifestSha256: string;
  expectedRecoveryReleaseId: string;
  now: Date;
}

export type PublicationApprovalOptions = Omit<PublicationVerificationOptions, "bundleDirectory" | "extractionDirectory">;

export async function verifyPublicationBundle(options: PublicationVerificationOptions): Promise<PublicationReleaseManifest> {
  const manifestBytes = await readFile(path.join(options.bundleDirectory, "release-manifest.json"));
  if (sha256(manifestBytes) !== options.expectedManifestSha256) throw new Error("Release manifest digest mismatch.");
  const manifest = validatePublicationReleaseManifest(JSON.parse(manifestBytes.toString("utf8")));
  const computedReleaseId = computePublicationReleaseId({
    releaseKind: manifest.releaseKind,
    sourceCommitSha: manifest.source.commitSha,
    workflowRunId: manifest.source.workflowRunId,
    workflowRunAttempt: manifest.source.workflowRunAttempt,
    serviceDate: manifest.menu?.serviceDate ?? null,
    catalogSha256: manifest.menu?.catalogSha256 ?? null,
    shellRevision: manifest.shellRevision,
    recoveryReleaseId: manifest.recovery?.releaseId ?? null,
  });
  if (manifest.releaseId !== computedReleaseId) throw new Error("Release identity does not match its manifest provenance.");
  validateApprovalAndProvenance(manifest, options);

  const tarBytes = await readFile(path.join(options.bundleDirectory, manifest.site.tarFile));
  if (tarBytes.byteLength !== manifest.site.bytes || sha256(tarBytes) !== manifest.site.tarSha256) {
    throw new Error("Pages tar identity does not match the release manifest.");
  }
  const entries = parsePublicationTar(tarBytes);
  if (!createPublicationTar(entries).equals(tarBytes)) throw new Error("Pages tar is not in canonical deterministic form.");
  if (manifest.releaseKind === "live") {
    const evidence = deriveMenuEvidence(entries, manifest.source.commitSha, sha256, {
      bundleCreatedAt: manifest.createdAt,
      verificationTime: options.now,
    });
    if (JSON.stringify(evidence.menu) !== JSON.stringify(manifest.menu)) {
      throw new Error("Release manifest menu claims do not match validated catalog and snapshot bytes.");
    }
  }
  const actualInventory = entries.map((entry) => ({
    path: entry.path,
    bytes: entry.data.byteLength,
    sha256: sha256(entry.data),
  }));
  if (JSON.stringify(actualInventory) !== JSON.stringify(manifest.site.inventory)) {
    throw new Error("Pages tar inventory does not match the release manifest.");
  }
  const markerEntry = entries.find((entry) => entry.path === manifest.marker.path);
  if (!markerEntry || sha256(markerEntry.data) !== manifest.marker.sha256) throw new Error("Release marker identity mismatch.");
  const marker = validatePublicationReleaseMarker(JSON.parse(markerEntry.data.toString("utf8")));
  if (
    marker.releaseId !== manifest.releaseId
    || marker.releaseKind !== manifest.releaseKind
    || marker.sourceCommitSha !== manifest.source.commitSha
    || marker.shellRevision !== manifest.shellRevision
    || marker.serviceDate !== (manifest.menu?.serviceDate ?? null)
    || marker.catalogSha256 !== (manifest.menu?.catalogSha256 ?? null)
  ) throw new Error("Release marker does not match its manifest.");

  if (options.extractionDirectory) {
    await rm(options.extractionDirectory, { recursive: true, force: true });
    await extractPublicationTar(tarBytes, options.extractionDirectory);
    const files = await validatePagesArtifact(options.extractionDirectory);
    if (JSON.stringify(files) !== JSON.stringify(actualInventory.map((entry) => entry.path))) {
      throw new Error("Extracted Pages artifact inventory changed.");
    }
  }
  return manifest;
}

export function validateApprovalAndProvenance(
  manifest: PublicationReleaseManifest,
  options: PublicationApprovalOptions,
): void {
  const metadata = options.metadata;
  const now = options.now.getTime();
  const approvalExpiresAt = Date.parse(options.approvalExpiresAt);
  const artifactExpiresAt = Date.parse(metadata.artifact.expires_at);
  if (!Number.isFinite(now) || !Number.isFinite(approvalExpiresAt) || approvalExpiresAt <= now) {
    throw new Error("Publication approval has expired or is invalid.");
  }
  if (metadata.repository.id !== LIONLOG_REPOSITORY_ID || metadata.repository.full_name !== LIONLOG_REPOSITORY) {
    throw new Error("Publication repository identity mismatch.");
  }
  if (metadata.main.sha !== options.workflowSha) throw new Error("Main moved after this promotion workflow started.");
  if (
    metadata.run.id !== options.expectedRunId
    || metadata.run.event !== "workflow_dispatch"
    || metadata.run.head_sha !== options.expectedSourceSha
    || metadata.run.head_branch !== "main"
    || metadata.run.run_attempt !== 1
    || metadata.run.run_attempt !== options.expectedRunAttempt
    || metadata.run.status !== "completed"
    || metadata.run.conclusion !== "success"
    || metadata.run.path !== LIVE_CANDIDATE_WORKFLOW
    || metadata.run.workflow_id !== LIVE_CANDIDATE_WORKFLOW_ID
  ) throw new Error("Candidate producer run provenance mismatch.");
  if (
    metadata.artifact.id !== options.expectedArtifactId
    || metadata.artifact.digest !== options.expectedArtifactDigest
    || !Number.isSafeInteger(metadata.artifact.size_in_bytes)
    || metadata.artifact.size_in_bytes <= 0
    || metadata.artifact.size_in_bytes > 110 * 1024 * 1024
    || metadata.artifact.expired
    || !Number.isFinite(artifactExpiresAt)
    || artifactExpiresAt <= now
    || metadata.artifact.workflow_run.id !== options.expectedRunId
    || metadata.artifact.workflow_run.head_sha !== options.expectedSourceSha
    || metadata.artifact.workflow_run.head_branch !== "main"
    || metadata.artifact.workflow_run.head_repository_id !== LIONLOG_REPOSITORY_ID
  ) throw new Error("Candidate artifact provenance mismatch.");
  if (
    manifest.source.commitSha !== options.expectedSourceSha
    || manifest.source.workflowRunId !== options.expectedRunId
    || manifest.source.workflowRunAttempt !== options.expectedRunAttempt
    || manifest.source.workflowId !== LIVE_CANDIDATE_WORKFLOW_ID
  ) throw new Error("Release manifest source provenance mismatch.");
  const expectedNamePrefix = manifest.releaseKind === "live" ? "lionlog-live-" : "lionlog-first-release-recovery-";
  if (!metadata.artifact.name.startsWith(expectedNamePrefix)) throw new Error("Candidate artifact name does not match its release kind.");
  if (
    options.expectedPromotionWorkflowSha !== options.workflowSha
    || metadata.ciRun.workflow_id !== REQUIRED_CI_WORKFLOW_ID
    || metadata.ciRun.path !== REQUIRED_CI_WORKFLOW
    || metadata.ciRun.event !== "push"
    || metadata.ciRun.head_sha !== options.expectedSourceSha
    || metadata.ciRun.head_branch !== "main"
    || metadata.ciRun.run_attempt !== 1
    || metadata.ciRun.status !== "completed"
    || metadata.ciRun.conclusion !== "success"
    || !metadata.ciJobs.some((job) => job.name === "verify" && job.head_sha === options.expectedSourceSha && job.status === "completed" && job.conclusion === "success")
  ) throw new Error("Required CI workflow identity did not pass on the candidate source commit.");
  if (manifest.target.origin !== TARGET_ORIGIN || manifest.target.basePath !== TARGET_BASE_PATH) {
    throw new Error("Candidate target identity mismatch.");
  }

  if (options.operation === "first-release-recovery") {
    if (manifest.releaseKind !== "first-release-recovery" || options.expectedServiceDate !== "NONE") {
      throw new Error("First-release recovery approval does not match the candidate.");
    }
    if (options.partialApproval !== "COMPLETE_ONLY" || options.expiredRollbackApproval !== "NONE") {
      throw new Error("First-release recovery approval fields are inconsistent.");
    }
    if (
      options.expectedRecoveryArtifactId !== options.expectedArtifactId
      || options.expectedRecoveryArtifactDigest !== options.expectedArtifactDigest
      || options.expectedRecoveryManifestSha256 !== options.expectedManifestSha256
      || options.expectedRecoveryReleaseId !== manifest.releaseId
    ) throw new Error("First-release recovery approval is not bound to the exact recovery bytes.");
    return;
  }
  if (options.operation === "rollback" && manifest.releaseKind === "first-release-recovery") {
    if (options.expectedServiceDate !== "NONE") throw new Error("App-only rollback must use the NONE service-date sentinel.");
    if (options.partialApproval !== "COMPLETE_ONLY" || options.expiredRollbackApproval !== "NONE") {
      throw new Error("App-only rollback cannot carry menu-coverage or expiry waivers.");
    }
    if (
      options.expectedRecoveryArtifactId !== options.expectedArtifactId
      || options.expectedRecoveryArtifactDigest !== options.expectedArtifactDigest
      || options.expectedRecoveryManifestSha256 !== options.expectedManifestSha256
      || options.expectedRecoveryReleaseId !== manifest.releaseId
    ) throw new Error("App-only rollback is not bound to the exact recovery bytes.");
    return;
  }
  if (manifest.releaseKind !== "live" || manifest.menu === null || manifest.menu.serviceDate !== options.expectedServiceDate) {
    throw new Error("Live publication approval does not match the candidate service date.");
  }
  if (
    manifest.recovery === null
    || manifest.recovery.artifactId !== options.expectedRecoveryArtifactId
    || manifest.recovery.artifactDigest !== options.expectedRecoveryArtifactDigest
    || manifest.recovery.manifestSha256 !== options.expectedRecoveryManifestSha256
    || manifest.recovery.releaseId !== options.expectedRecoveryReleaseId
  ) throw new Error("Live publication approval does not match its exact recovery artifact.");
  if (manifest.menu.coverage === "partial") {
    const expected = `APPROVE_PARTIAL:${options.expectedManifestSha256}:${manifest.menu.omissions["invalid-name"]}`;
    if (options.partialApproval !== expected) throw new Error("Partial coverage lacks exact Project Manager approval.");
  } else if (options.partialApproval !== "COMPLETE_ONLY") {
    throw new Error("Complete coverage must use the complete-only approval value.");
  }
  if (options.operation === "promote") {
    if (Date.parse(manifest.menu.earliestFreshUntil) < now + MINIMUM_FRESHNESS_MS) {
      throw new Error("Live candidate lacks the required freshness margin.");
    }
    if (options.expiredRollbackApproval !== "NONE") throw new Error("Promotion cannot use rollback expiry approval.");
  } else {
    const expired = Date.parse(manifest.menu.earliestRetainUntil) < now;
    if (expired) {
      const expected = `ALLOW_EXPIRED_ROLLBACK:${options.expectedManifestSha256}`;
      if (options.expiredRollbackApproval !== expected) throw new Error("Expired rollback requires exact Project Manager approval.");
    } else if (options.expiredRollbackApproval !== "NONE") {
      throw new Error("Unexpired rollback must not carry an expiry waiver.");
    }
  }
}

function parseArguments(): PublicationVerificationOptions {
  const args = new Map(process.argv.slice(2).map((argument) => {
    const [name, ...value] = argument.split("=");
    return [name, value.join("=")] as const;
  }));
  const operation = args.get("--operation");
  if (operation !== "promote" && operation !== "rollback" && operation !== "first-release-recovery") {
    throw new Error("Publication operation is invalid.");
  }
  const required = (name: string): string => {
    const value = args.get(name);
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  return {
    bundleDirectory: required("--bundle"),
    extractionDirectory: args.get("--extract"),
    metadata: JSON.parse(readFileSync(required("--metadata"), "utf8")),
    operation,
    expectedSourceSha: required("--source-sha"),
    expectedRunId: Number(required("--run-id")),
    expectedRunAttempt: Number(required("--run-attempt")),
    expectedArtifactId: Number(required("--artifact-id")),
    expectedArtifactDigest: required("--artifact-digest"),
    expectedManifestSha256: required("--manifest-digest"),
    expectedServiceDate: required("--service-date"),
    approvalExpiresAt: required("--approval-expires-at"),
    partialApproval: required("--partial-approval"),
    expiredRollbackApproval: required("--expired-rollback-approval"),
    workflowSha: required("--workflow-sha"),
    expectedPromotionWorkflowSha: required("--expected-promotion-workflow-sha"),
    expectedRecoveryArtifactId: Number(required("--recovery-artifact-id")),
    expectedRecoveryArtifactDigest: required("--recovery-artifact-digest"),
    expectedRecoveryManifestSha256: required("--recovery-manifest-digest"),
    expectedRecoveryReleaseId: required("--recovery-release-id"),
    now: new Date(args.get("--now") ?? Date.now()),
  };
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) {
  const manifest = await verifyPublicationBundle(parseArguments());
  console.log(JSON.stringify({ releaseId: manifest.releaseId, releaseKind: manifest.releaseKind }));
}
