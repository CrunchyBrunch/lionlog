import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { publicationDeploymentReceiptSchema, publicationReleaseManifestSchema, type PublicationDeploymentReceipt, type PublicationReleaseManifest } from "../infrastructure/publication/release-contract.ts";
import { PSU_CATALOG_VERSION, catalogEntryForSnapshot, validatePsuPublicationCatalog, type PsuPublicationCatalog } from "../infrastructure/psu/publication-catalog.ts";
import { getPsuHall, getPsuMealPeriod, PSU_PARSER_VERSION, PSU_SNAPSHOT_VERSION, sourceDateFromIso } from "../infrastructure/psu/constants.ts";
import { PSU_RELEASE_HALL_IDS } from "../infrastructure/psu/release-plan.ts";
import { buildPsuSnapshot, validatePsuSnapshot, type PsuMenuSnapshot } from "../infrastructure/psu/snapshot-schema.ts";
import { assertArtifactDigest, normalizeArtifactDigest } from "../scripts/artifact-digest.ts";
import { parseArtifactZip } from "../scripts/artifact-zip.ts";
import { computePublicationReleaseId, createPublicationBundle, sha256 } from "../scripts/create-publication-bundle.ts";
import { deployExactPagesArtifact, executeProtectedAdapterGate } from "../scripts/deploy-exact-pages-artifact.mjs";
import { createDeploymentReceipt } from "../scripts/create-deployment-receipt.mjs";
import { executeFinalPromotionGate, readFinalPromotionState } from "../scripts/final-promotion-gate.mjs";
import {
  createRepositoryDeploymentLedger,
  publicationLedgerPayload,
  readRepositoryDeploymentHistory,
  recoverRepositoryDeploymentAttempt,
} from "../scripts/publication-deployment-ledger.mjs";
import { createPublicationTar, parsePublicationTar } from "../scripts/publication-tar.ts";
import { verifyCurrentPublication, verifyCurrentPublicationFromEnvironment } from "../scripts/verify-current-publication.mjs";
import { verifyPublicSite } from "../scripts/verify-public-site.mjs";
import { validateApprovalAndProvenance, verifyPublicationBundle } from "../scripts/verify-publication-bundle.ts";

const sourceSha = "a".repeat(40);
const artifactDigest = `sha256:${"b".repeat(64)}`;
const now = new Date("2026-09-07T12:00:00.000Z");
const executeFile = promisify(execFile);

test("artifact digest comparison normalizes upload-action and API representations and fails closed", () => {
  const bare = "b".repeat(64);
  assert.equal(normalizeArtifactDigest(bare), `sha256:${bare}`);
  assert.equal(assertArtifactDigest(bare, `sha256:${bare}`), `sha256:${bare}`);
  assert.equal(assertArtifactDigest(`sha256:${bare}`, bare), `sha256:${bare}`);
  assert.throws(() => assertArtifactDigest(bare, `sha256:${"c".repeat(64)}`), /mismatch/);
});

test("artifact ZIP wrappers reject aliases, non-files, header disagreement, and extras before extraction", () => {
  const valid = createStoredZip([
    { path: "release-manifest.json", data: Buffer.from("{}") },
    { path: "site.tar", data: Buffer.from("tar") },
  ]);
  assert.deepEqual(parseArtifactZip(valid, ["release-manifest.json", "site.tar"]).map((entry) => entry.path).sort(), ["release-manifest.json", "site.tar"]);
  assert.throws(() => parseArtifactZip(createStoredZip([
    { path: "A.json", data: Buffer.from("a") },
    { path: "a.json", data: Buffer.from("b") },
  ]), ["A.json", "a.json"]), /case-colliding/);
  assert.throws(() => parseArtifactZip(createStoredZip([{ path: "site.tar", data: Buffer.from("tar"), mode: 0o120777 }]), ["site.tar"]), /regular files/);
  assert.throws(() => parseArtifactZip(createStoredZip([
    { path: "release-manifest.json", data: Buffer.from("{}") },
    { path: "site.tar", data: Buffer.from("tar") },
    { path: "extra.txt", data: Buffer.from("x") },
  ]), ["release-manifest.json", "site.tar"]), /file set/);
  const disagreement = Buffer.from(valid);
  disagreement.write("X", 30, 1, "ascii");
  assert.throws(() => parseArtifactZip(disagreement, ["release-manifest.json", "site.tar"]), /headers disagree/);
});

test("the deployed post-approval shell policy accepts only the exact partial approval", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-partial-shell-"));
  const manifestPath = path.join(root, "release-manifest.json");
  const digest = "d".repeat(64);
  await writeFile(manifestPath, JSON.stringify({
    releaseKind: "live",
    menu: {
      coverage: "partial",
      earliestFreshUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
      earliestRetainUntil: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
      omissions: { "invalid-name": 2 },
    },
  }));
  const baseEnvironment = {
    ...process.env,
    RELEASE_MANIFEST_PATH: manifestPath,
    OPERATION: "promote",
    SOURCE_MANIFEST_DIGEST: digest,
    PARTIAL_APPROVAL: `APPROVE_PARTIAL:${digest}:2`,
    EXPIRED_ROLLBACK_APPROVAL: "NONE",
  };
  await executeFile("bash", ["scripts/verify-post-approval-policy.sh"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnvironment });
  await assert.rejects(executeFile("bash", ["scripts/verify-post-approval-policy.sh"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...baseEnvironment, PARTIAL_APPROVAL: `APPROVE_PARTIAL:${"e".repeat(64)}:2` },
  }));
  await writeFile(manifestPath, JSON.stringify({ releaseKind: "first-release-recovery", menu: null }));
  await executeFile("bash", ["scripts/verify-post-approval-policy.sh"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...baseEnvironment, OPERATION: "rollback", PARTIAL_APPROVAL: "COMPLETE_ONLY", EXPIRED_ROLLBACK_APPROVAL: "NONE" },
  });
  await assert.rejects(executeFile("bash", ["scripts/verify-post-approval-policy.sh"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...baseEnvironment, PARTIAL_APPROVAL: `APPROVE_PARTIAL:${digest}:1` },
  }));
});

test("the current-publication CLI requires the canonical manifest environment before any network boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-manifest-contract-"));
  const manifestPath = path.join(root, "release-manifest.json");
  await writeFile(manifestPath, JSON.stringify({ releaseId: "e".repeat(64) }));
  const script = path.resolve(import.meta.dirname, "../scripts/verify-current-publication.mjs");
  const baseEnvironment = { ...process.env, OPERATION: "invalid-offline-test" };

  await assert.rejects(executeFile(process.execPath, [script], {
    env: { ...baseEnvironment, RELEASE_MANIFEST_PATH: "" },
  }), /RELEASE_MANIFEST_PATH is required/);
  await assert.rejects(executeFile(process.execPath, [script], {
    env: { ...baseEnvironment, MANIFEST_PATH: manifestPath, RELEASE_MANIFEST_PATH: undefined },
  }), /MANIFEST_PATH is not supported/);
  await assert.rejects(executeFile(process.execPath, [script], {
    env: { ...baseEnvironment, RELEASE_MANIFEST_PATH: manifestPath },
  }), /Publication operation is invalid/);

  let fetches = 0;
  await assert.rejects(verifyCurrentPublicationFromEnvironment({
    ...baseEnvironment,
    RELEASE_MANIFEST_PATH: path.join(root, "missing.json"),
  }, {
    fetchImpl: async () => { fetches += 1; return new Response(null, { status: 500 }); },
  }), /readable JSON manifest/);
  const wrongManifestPath = path.join(root, "wrong-manifest.json");
  await writeFile(wrongManifestPath, "[]");
  await assert.rejects(verifyCurrentPublicationFromEnvironment({
    ...baseEnvironment,
    RELEASE_MANIFEST_PATH: wrongManifestPath,
  }, {
    fetchImpl: async () => { fetches += 1; return new Response(null, { status: 500 }); },
  }), /manifest object/);
  assert.equal(fetches, 0);
});

test("the protected workflow passes the canonical manifest into verification before OIDC-capable submission", async () => {
  const workflow = await readFile(path.resolve(import.meta.dirname, "../.github/workflows/deploy-github-pages.yml"), "utf8");
  assert.doesNotMatch(workflow, /^\s+MANIFEST_PATH:/m);
  const finalStep = workflow.indexOf("- name: Perform final provenance, state, deadline, and freshness checks");
  const canonicalEnvironment = workflow.indexOf("RELEASE_MANIFEST_PATH: work/pages-deployment/source-bundle/release-manifest.json", finalStep);
  const verifier = workflow.indexOf("node scripts/verify-current-publication.mjs", finalStep);
  const deployment = workflow.indexOf("- name: Deploy exact staged artifact", finalStep);
  assert.ok(finalStep >= 0 && canonicalEnvironment > finalStep && verifier > canonicalEnvironment && deployment > verifier);
  assert.match(workflow, /PRE_SUBMISSION_FAILURE_APPROVAL: \$\{\{ inputs\.pre_submission_failure_approval \}\}/);
  assert.match(workflow, /authorization:\{partialApproval:\$partialApproval,expiredRollbackApproval:\$expiredRollbackApproval,preSubmissionFailureApproval:\$preSubmissionFailureApproval\}/);
});

test("recovery release bundle round-trips and rejects identity tampering", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-publication-"));
  const site = path.join(root, "site");
  const bundle = path.join(root, "bundle");
  await writeRecoverySite(site);
  const manifest = await createPublicationBundle({
    site,
    output: bundle,
    releaseKind: "first-release-recovery",
    commitSha: sourceSha,
    runId: 123,
    runAttempt: 1,
    createdAt: now.toISOString(),
  });
  const manifestBytes = await readFile(path.join(bundle, "release-manifest.json"));
  const metadata = githubMetadata(manifest, now);
  const verified = await verifyPublicationBundle({
    bundleDirectory: bundle,
    extractionDirectory: path.join(root, "extracted"),
    metadata,
    operation: "first-release-recovery",
    expectedSourceSha: sourceSha,
    expectedRunId: 123,
    expectedRunAttempt: 1,
    expectedArtifactId: 456,
    expectedArtifactDigest: artifactDigest,
    expectedManifestSha256: sha256(manifestBytes),
    expectedServiceDate: "NONE",
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    partialApproval: "COMPLETE_ONLY",
    expiredRollbackApproval: "NONE",
    workflowSha: sourceSha,
    expectedPromotionWorkflowSha: sourceSha,
    expectedRecoveryArtifactId: 456,
    expectedRecoveryArtifactDigest: artifactDigest,
    expectedRecoveryManifestSha256: sha256(manifestBytes),
    expectedRecoveryReleaseId: manifest.releaseId,
    now,
  });
  assert.equal(verified.releaseId, manifest.releaseId);
  await assert.doesNotReject(verifyPublicationBundle({
    bundleDirectory: bundle,
    metadata,
    operation: "rollback",
    expectedSourceSha: sourceSha,
    expectedRunId: 123,
    expectedRunAttempt: 1,
    expectedArtifactId: 456,
    expectedArtifactDigest: artifactDigest,
    expectedManifestSha256: sha256(manifestBytes),
    expectedServiceDate: "NONE",
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    partialApproval: "COMPLETE_ONLY",
    expiredRollbackApproval: "NONE",
    workflowSha: sourceSha,
    expectedPromotionWorkflowSha: sourceSha,
    expectedRecoveryArtifactId: 456,
    expectedRecoveryArtifactDigest: artifactDigest,
    expectedRecoveryManifestSha256: sha256(manifestBytes),
    expectedRecoveryReleaseId: manifest.releaseId,
    now,
  }));
  assert.equal(publicationReleaseManifestSchema.safeParse({ ...manifest, manifestVersion: "lionlog.pages-release.v1" }).success, false);
  const manifestPath = path.join(bundle, "release-manifest.json");
  const changedIdentity = JSON.parse(manifestBytes.toString("utf8"));
  changedIdentity.releaseId = "0".repeat(64);
  const changedManifestBytes = Buffer.from(`${JSON.stringify(changedIdentity, null, 2)}\n`);
  await writeFile(manifestPath, changedManifestBytes);
  await assert.rejects(verifyPublicationBundle({
    bundleDirectory: bundle,
    metadata,
    operation: "first-release-recovery",
    expectedSourceSha: sourceSha,
    expectedRunId: 123,
    expectedRunAttempt: 1,
    expectedArtifactId: 456,
    expectedArtifactDigest: artifactDigest,
    expectedManifestSha256: sha256(changedManifestBytes),
    expectedServiceDate: "NONE",
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    partialApproval: "COMPLETE_ONLY",
    expiredRollbackApproval: "NONE",
    workflowSha: sourceSha,
    expectedPromotionWorkflowSha: sourceSha,
    expectedRecoveryArtifactId: 456,
    expectedRecoveryArtifactDigest: artifactDigest,
    expectedRecoveryManifestSha256: sha256(changedManifestBytes),
    expectedRecoveryReleaseId: manifest.releaseId,
    now,
  }), /Release identity/);
  await writeFile(manifestPath, manifestBytes);
  const tarPath = path.join(bundle, "site.tar");
  const tampered = Buffer.from(await readFile(tarPath));
  tampered[600] ^= 1;
  await writeFile(tarPath, tampered);
  await assert.rejects(verifyPublicationBundle({
    bundleDirectory: bundle,
    metadata,
    operation: "first-release-recovery",
    expectedSourceSha: sourceSha,
    expectedRunId: 123,
    expectedRunAttempt: 1,
    expectedArtifactId: 456,
    expectedArtifactDigest: artifactDigest,
    expectedManifestSha256: sha256(manifestBytes),
    expectedServiceDate: "NONE",
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    partialApproval: "COMPLETE_ONLY",
    expiredRollbackApproval: "NONE",
    workflowSha: sourceSha,
    expectedPromotionWorkflowSha: sourceSha,
    expectedRecoveryArtifactId: 456,
    expectedRecoveryArtifactDigest: artifactDigest,
    expectedRecoveryManifestSha256: sha256(manifestBytes),
    expectedRecoveryReleaseId: manifest.releaseId,
    now,
  }), /tar identity/);
});

test("the real protected adapter gate fully validates manifest semantics before OIDC or submission", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-adapter-boundary-"));
  const site = path.join(root, "site");
  const bundle = path.join(root, "bundle");
  await writeRecoverySite(site);
  const manifest = await createPublicationBundle({
    site,
    output: bundle,
    releaseKind: "first-release-recovery",
    commitSha: sourceSha,
    runId: 123,
    runAttempt: 1,
    createdAt: now.toISOString(),
  });
  const manifestPath = path.join(bundle, "release-manifest.json");
  const originalBytes = await readFile(manifestPath);
  const metadata = githubMetadata(manifest, now);
  const stagedDigest = `sha256:${"e".repeat(64)}`;
  const expectedBase = {
    operation: "rollback",
    promotionWorkflowSha: sourceSha,
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    minimumFreshUntil: "NONE",
    releaseId: manifest.releaseId,
    source: { runId: 123, sourceSha, artifactId: 456, artifactDigest, manifestSha256: sha256(originalBytes) },
    ci: { runId: 999 },
    recovery: { artifactId: 456, artifactDigest, manifestSha256: sha256(originalBytes), releaseId: manifest.releaseId },
    staged: { artifactId: 789, digest: stagedDigest, artifactExpiresAt: "2026-12-01T00:00:00.000Z" },
    currentAttempt: { releaseId: "NONE_FIRST_DEPLOYMENT" },
    rollbackTarget: { releaseId: "NONE_FIRST_DEPLOYMENT" },
    authorization: { partialApproval: "COMPLETE_ONLY", expiredRollbackApproval: "NONE", preSubmissionFailureApproval: "NONE" },
    menu: null,
    site: manifest.site,
    artifacts: [
      { id: 456, digest: artifactDigest, runId: 123, headSha: sourceSha, role: "source" },
      { id: 456, digest: artifactDigest, runId: 123, headSha: sourceSha, role: "recovery" },
      { id: 789, digest: stagedDigest, runId: 321, headSha: sourceSha, role: "staged" },
    ],
  };
  const actual = {
    checkoutSha: sourceSha,
    mainSha: sourceSha,
    sourceRun: metadata.run,
    ciRun: metadata.ciRun,
    ciJobs: metadata.ciJobs,
    artifacts: [
      metadata.artifact,
      metadata.artifact,
      { id: 789, digest: stagedDigest, expired: false, workflow_run: { id: 321, head_sha: sourceSha, head_branch: "main", head_repository_id: 1_346_360_244 } },
    ],
  };
  const environmentFor = (expected: typeof expectedBase) => ({
    OPERATION: expected.operation,
    EXPECTED_PROMOTION_WORKFLOW_SHA: expected.promotionWorkflowSha,
    RELEASE_ID: expected.releaseId,
    SOURCE_ARTIFACT_ID: String(expected.source.artifactId),
    SOURCE_ARTIFACT_DIGEST: expected.source.artifactDigest,
    SOURCE_MANIFEST_DIGEST: expected.source.manifestSha256,
    RECOVERY_ARTIFACT_ID: String(expected.recovery.artifactId),
    RECOVERY_ARTIFACT_DIGEST: expected.recovery.artifactDigest,
    RECOVERY_MANIFEST_DIGEST: expected.recovery.manifestSha256,
    RECOVERY_RELEASE_ID: expected.recovery.releaseId,
    STAGED_ARTIFACT_ID: String(expected.staged.artifactId),
    SERVICE_DATE: "NONE",
    PARTIAL_APPROVAL: "COMPLETE_ONLY",
    EXPIRED_ROLLBACK_APPROVAL: "NONE",
    PRE_SUBMISSION_FAILURE_APPROVAL: "NONE",
    CURRENT_RELEASE_ID: "NONE_FIRST_DEPLOYMENT",
    TARGET_RELEASE_ID: "NONE_FIRST_DEPLOYMENT",
  });
  const invalidManifests = [
    {},
    { ...manifest, releaseId: "0".repeat(64) },
    { ...manifest, releaseKind: "live", menu: null },
    { ...manifest, menu: { serviceDate: "2026-09-07" } },
  ];
  for (const invalid of invalidManifests) {
    const bytes = Buffer.from(`${JSON.stringify(invalid, null, 2)}\n`);
    await writeFile(manifestPath, bytes);
    const expected = structuredClone(expectedBase);
    expected.source.manifestSha256 = sha256(bytes);
    expected.recovery.manifestSha256 = sha256(bytes);
    const calls = { oidc: 0, submissions: 0 };
    await assert.rejects(executeProtectedAdapterGate({
      expected,
      bundleDirectory: bundle,
      stagedTarPath: path.join(bundle, "site.tar"),
      environment: environmentFor(expected),
      readActual: async () => actual,
      verifyCurrentState: async () => {},
      clock: () => now.getTime(),
      requestOidc: async () => { calls.oidc += 1; return "oidc"; },
      submit: async () => { calls.submissions += 1; return "submitted"; },
    }));
    assert.deepEqual(calls, { oidc: 0, submissions: 0 });
  }
  await writeFile(manifestPath, originalBytes);
});

test("full live verification derives field-release policy from catalog and snapshot bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-live-semantic-"));
  const recoverySite = path.join(root, "recovery-site");
  const recoveryBundle = path.join(root, "recovery-bundle");
  await writeRecoverySite(recoverySite);
  const recovery = await createPublicationBundle({
    site: recoverySite,
    output: recoveryBundle,
    releaseKind: "first-release-recovery",
    commitSha: sourceSha,
    runId: 123,
    runAttempt: 1,
    createdAt: now.toISOString(),
  });
  const recoveryManifest = path.join(recoveryBundle, "release-manifest.json");
  const recoveryDigest = `sha256:${"7".repeat(64)}`;
  const site = path.join(root, "site");
  await writeFieldReleaseSite(site, { freshForMs: 18 * 60 * 60_000, retainForMs: 48 * 60 * 60_000 });
  const bundle = path.join(root, "bundle");
  const manifest = await createPublicationBundle({
    site,
    output: bundle,
    releaseKind: "live",
    commitSha: sourceSha,
    runId: 123,
    runAttempt: 1,
    createdAt: now.toISOString(),
    recoveryManifest,
    recoveryArtifactId: 789,
    recoveryArtifactDigest: recoveryDigest,
  });
  const options = {
    ...liveVerificationOptions(bundle, manifest, recovery, recoveryDigest),
    expectedManifestSha256: sha256(await readFile(path.join(bundle, "release-manifest.json"))),
  };
  await assert.doesNotReject(verifyPublicationBundle(options));

  await rewriteLiveBundle(bundle, (catalog) => ({
    ...catalog,
    publication: { ...catalog.publication, mode: "manual-export" },
  }));
  const changedManifestBytes = await readFile(path.join(bundle, "release-manifest.json"));
  await assert.rejects(verifyPublicationBundle({ ...options, expectedManifestSha256: sha256(changedManifestBytes) }), /field-release provenance/);

  const retimedBundle = path.join(root, "retimed-bundle");
  const retimedSite = path.join(root, "retimed-site");
  await writeFieldReleaseSite(retimedSite, { freshForMs: 18 * 60 * 60_000, retainForMs: 48 * 60 * 60_000 });
  const retimedManifest = await createPublicationBundle({
    site: retimedSite,
    output: retimedBundle,
    releaseKind: "live",
    commitSha: sourceSha,
    runId: 123,
    runAttempt: 1,
    createdAt: now.toISOString(),
    recoveryManifest,
    recoveryArtifactId: 789,
    recoveryArtifactDigest: recoveryDigest,
  });
  await rewriteLiveBundle(retimedBundle, (catalog) => catalog, (snapshot) => ({
    ...snapshot,
    cachedAt: "2099-01-01T12:00:00.000Z",
    freshUntil: "2099-01-02T06:00:00.000Z",
    retainUntil: "2099-01-03T12:00:00.000Z",
  }));
  await assert.rejects(verifyPublicationBundle({
    ...liveVerificationOptions(retimedBundle, retimedManifest, recovery, recoveryDigest),
    expectedManifestSha256: sha256(await readFile(path.join(retimedBundle, "release-manifest.json"))),
  }), /retrieval\/cache time/);

  const extendedSite = path.join(root, "extended-site");
  await writeFieldReleaseSite(extendedSite, { freshForMs: 365 * 24 * 60 * 60_000, retainForMs: 366 * 24 * 60 * 60_000 });
  await assert.rejects(createPublicationBundle({
    site: extendedSite,
    output: path.join(root, "extended-bundle"),
    releaseKind: "live",
    commitSha: sourceSha,
    runId: 123,
    runAttempt: 1,
    createdAt: now.toISOString(),
    recoveryManifest,
    recoveryArtifactId: 789,
    recoveryArtifactDigest: recoveryDigest,
  }), /18-hour\/48-hour/);
});

test("publication tar rejects traversal, duplicate entries, links, and corrupt headers", () => {
  assert.throws(() => createPublicationTar([{ path: "../escape", data: Buffer.from("x") }]), /Unsafe publication path/);
  assert.throws(() => createPublicationTar([
    { path: "index.html", data: Buffer.from("a") },
    { path: "index.html", data: Buffer.from("b") },
  ]), /Duplicate/);
  assert.throws(() => createPublicationTar([
    { path: "assets/A.js", data: Buffer.from("a") },
    { path: "assets/a.js", data: Buffer.from("b") },
  ]), /Case-colliding/);
  const archive = createPublicationTar([{ path: "index.html", data: Buffer.from("a") }]);
  const link = Buffer.from(archive);
  link[156] = "2".charCodeAt(0);
  rewriteTarChecksum(link);
  assert.throws(() => parsePublicationTar(link), /only regular files/);
  const corrupt = Buffer.from(archive);
  corrupt[0] ^= 1;
  assert.throws(() => parsePublicationTar(corrupt), /checksum/);
  const hiddenPadding = Buffer.from(archive);
  hiddenPadding[513] = 1;
  assert.throws(() => parsePublicationTar(hiddenPadding), /non-zero padding/);
});

test("partial live approval is bound to the exact manifest and omission count", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-approval-"));
  const site = path.join(root, "site");
  await writeRecoverySite(site);
  const recovery = await createPublicationBundle({
    site,
    output: path.join(root, "bundle"),
    releaseKind: "first-release-recovery",
    commitSha: sourceSha,
    runId: 123,
    runAttempt: 1,
    createdAt: now.toISOString(),
  });
  const catalogEntry = { path: "menu-data/v2/catalog.json", bytes: 2, sha256: "c".repeat(64) };
  const live = publicationReleaseManifestSchema.parse({
    ...recovery,
    releaseKind: "live",
    recovery: {
      releaseId: recovery.releaseId,
      manifestSha256: "e".repeat(64),
      artifactId: 789,
      artifactDigest: `sha256:${"f".repeat(64)}`,
    },
    menu: {
      serviceDate: "2026-09-07",
      catalogPath: "menu-data/v2/catalog.json",
      catalogSha256: "c".repeat(64),
      catalogVersion: "lionlog.psu-catalog.v3",
      snapshotSchemaVersion: "lionlog.psu-menu.v2",
      parserVersion: "psu-html.v2",
      generatedAt: "2026-09-07T12:00:00.000Z",
      retrievalStartedAt: "2026-09-07T11:00:00.000Z",
      retrievalCompletedAt: "2026-09-07T11:30:00.000Z",
      earliestFreshUntil: "2026-09-07T14:00:00.000Z",
      earliestRetainUntil: "2026-09-09T12:00:00.000Z",
      coverage: "partial",
      sourceObservationCount: 101,
      publishedObservationCount: 100,
      omissions: { "invalid-name": 1 },
      snapshotCount: 5,
    },
    site: {
      ...recovery.site,
      inventory: [...recovery.site.inventory, catalogEntry].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    },
  });
  const metadata = githubMetadata(live, now);
  const base = {
    metadata,
    operation: "promote" as const,
    expectedSourceSha: sourceSha,
    expectedRunId: 123,
    expectedRunAttempt: 1,
    expectedArtifactId: 456,
    expectedArtifactDigest: artifactDigest,
    expectedManifestSha256: "d".repeat(64),
    expectedServiceDate: "2026-09-07",
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    partialApproval: "COMPLETE_ONLY",
    expiredRollbackApproval: "NONE",
    workflowSha: sourceSha,
    expectedPromotionWorkflowSha: sourceSha,
    expectedRecoveryArtifactId: 789,
    expectedRecoveryArtifactDigest: `sha256:${"f".repeat(64)}`,
    expectedRecoveryManifestSha256: "e".repeat(64),
    expectedRecoveryReleaseId: recovery.releaseId,
    now,
  };
  assert.throws(() => validateApprovalAndProvenance(live, base), /Partial coverage/);
  assert.doesNotThrow(() => validateApprovalAndProvenance(live, {
    ...base,
    partialApproval: `APPROVE_PARTIAL:${"d".repeat(64)}:1`,
  }));
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    partialApproval: `APPROVE_PARTIAL:${"e".repeat(64)}:1`,
  }), /Partial coverage/);
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    partialApproval: `APPROVE_PARTIAL:${"d".repeat(64)}:1`,
    approvalExpiresAt: "2026-09-07T11:59:59.000Z",
  }), /expired/);
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    partialApproval: `APPROVE_PARTIAL:${"d".repeat(64)}:1`,
    approvalExpiresAt: "not-a-date",
  }), /invalid/);

  const exactPartialApproval = `APPROVE_PARTIAL:${"d".repeat(64)}:1`;
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    expectedArtifactId: 457,
    partialApproval: exactPartialApproval,
  }), /artifact provenance/);
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    expectedArtifactDigest: `sha256:${"e".repeat(64)}`,
    partialApproval: exactPartialApproval,
  }), /artifact provenance/);
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    expectedSourceSha: "e".repeat(40),
    partialApproval: exactPartialApproval,
  }), /producer run provenance/);

  const expiredMetadata = structuredClone(metadata);
  expiredMetadata.artifact.expired = true;
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    metadata: expiredMetadata,
    partialApproval: exactPartialApproval,
  }), /artifact provenance/);

  const rerunMetadata = structuredClone(metadata);
  rerunMetadata.run.run_attempt = 2;
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    metadata: rerunMetadata,
    partialApproval: exactPartialApproval,
  }), /producer run provenance/);

  const wrongProducerWorkflow = structuredClone(metadata);
  wrongProducerWorkflow.run.workflow_id = 123;
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    metadata: wrongProducerWorkflow,
    partialApproval: exactPartialApproval,
  }), /producer run provenance/);

  const wrongCiWorkflow = structuredClone(metadata);
  wrongCiWorkflow.ciRun.workflow_id = 123;
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    metadata: wrongCiWorkflow,
    partialApproval: exactPartialApproval,
  }), /CI workflow identity/);

  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    expectedPromotionWorkflowSha: "f".repeat(40),
    partialApproval: exactPartialApproval,
  }), /CI workflow identity/);

  const movedMainMetadata = structuredClone(metadata);
  movedMainMetadata.main.sha = "e".repeat(40);
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    metadata: movedMainMetadata,
    partialApproval: exactPartialApproval,
  }), /Main moved/);

  const stale = publicationReleaseManifestSchema.parse({
    ...live,
    menu: { ...live.menu!, earliestFreshUntil: "2026-09-07T12:14:59.000Z" },
  });
  assert.throws(() => validateApprovalAndProvenance(stale, {
    ...base,
    partialApproval: exactPartialApproval,
  }), /freshness margin/);
  assert.doesNotThrow(() => validateApprovalAndProvenance(stale, {
    ...base,
    operation: "rollback",
    partialApproval: exactPartialApproval,
  }));

  const expiredRollback = publicationReleaseManifestSchema.parse({
    ...stale,
    menu: { ...stale.menu!, earliestRetainUntil: "2026-09-07T11:59:59.000Z" },
  });
  assert.throws(() => validateApprovalAndProvenance(expiredRollback, {
    ...base,
    operation: "rollback",
    partialApproval: exactPartialApproval,
  }), /Expired rollback/);
  assert.doesNotThrow(() => validateApprovalAndProvenance(expiredRollback, {
    ...base,
    operation: "rollback",
    partialApproval: exactPartialApproval,
    expiredRollbackApproval: `ALLOW_EXPIRED_ROLLBACK:${"d".repeat(64)}`,
  }));
});

test("supported deployment authority covers first publication, successors, rollback, and unresolved attempts", async () => {
  const requested: string[] = [];
  const first = await verifyCurrentPublication({
    operation: "promote",
    sourceManifest: { releaseId: "e".repeat(64) },
    sourceIdentity: { artifactId: 999, artifactDigest, manifestSha256: "1".repeat(64) },
    token: "token",
    fetchImpl: deploymentApiFixture({ publicReleaseId: "NONE_404", deployments: [] }, requested),
  });
  assert.equal(first.state, "first-deployment");
  assert.equal(requested.some((url) => /\/pages\/deployments(?:\?|$)/.test(url)), false);

  const releaseA = "a".repeat(64);
  const releaseB = "b".repeat(64);
  const knownA = deploymentReceipt({ releaseId: releaseA, repositoryDeploymentId: 101, deploymentId: "pages-a", sourceArtifactId: 456 });
  const successor = await verifyCurrentPublication({
    operation: "promote",
    token: "token",
    currentReceipt: knownA,
    rollbackTargetReceipt: structuredClone(knownA),
    sourceManifest: { releaseId: releaseB },
    sourceIdentity: { artifactId: 999, artifactDigest, manifestSha256: "1".repeat(64) },
    fetchImpl: deploymentApiFixture({ publicReleaseId: releaseA, receipts: [knownA] }),
  });
  assert.equal(successor.state, "known-good-current");

  const failedB = deploymentReceipt({
    releaseId: releaseB,
    repositoryDeploymentId: 202,
    deploymentId: "pages-b",
    knownGood: false,
    repositoryState: "failure",
    publicProductVerified: false,
    previous: knownA,
    sourceArtifactId: 999,
  });
  const rolledBack = await verifyCurrentPublication({
    operation: "rollback",
    token: "token",
    currentReceipt: failedB,
    rollbackTargetReceipt: knownA,
    sourceManifest: { releaseId: releaseA, releaseKind: "live", site: { tarSha256: knownA.source.siteTarSha256 } },
    sourceIdentity: { artifactId: knownA.source.artifactId, artifactDigest: knownA.source.artifactDigest, manifestSha256: knownA.source.manifestSha256 },
    fetchImpl: deploymentApiFixture({ publicReleaseId: releaseB, receipts: [failedB, knownA] }),
  });
  assert.equal(rolledBack.state, "reconciled-current-attempt");

  const knownA2 = deploymentReceipt({ releaseId: releaseA, repositoryDeploymentId: 404, deploymentId: "pages-a-rollback", sourceArtifactId: 456, previous: knownA });
  await assert.doesNotReject(verifyCurrentPublication({
    operation: "promote",
    token: "token",
    currentReceipt: knownA2,
    rollbackTargetReceipt: structuredClone(knownA2),
    sourceManifest: { releaseId: "e".repeat(64) },
    sourceIdentity: { artifactId: 999, artifactDigest, manifestSha256: "1".repeat(64) },
    fetchImpl: deploymentApiFixture({ publicReleaseId: releaseA, receipts: [knownA2, failedB, knownA] }),
  }));
  assert.notEqual(knownA.deploymentId, knownA2.deploymentId);

  const unresolvedB = deploymentReceipt({
    releaseId: releaseB,
    repositoryDeploymentId: 303,
    deploymentId: null,
    knownGood: false,
    repositoryState: "in_progress",
    repositoryStatusRecorded: true,
    attemptPhase: "submission-uncertain",
    uncertain: true,
    previous: knownA,
    sourceArtifactId: 999,
  });
  await assert.rejects(verifyCurrentPublication({
    operation: "rollback",
    token: "token",
    currentReceipt: unresolvedB,
    rollbackTargetReceipt: knownA,
    sourceManifest: { releaseId: releaseA, releaseKind: "live", site: { tarSha256: knownA.source.siteTarSha256 } },
    sourceIdentity: { artifactId: knownA.source.artifactId, artifactDigest: knownA.source.artifactDigest, manifestSha256: knownA.source.manifestSha256 },
    fetchImpl: deploymentApiFixture({ publicReleaseId: releaseA, receipts: [unresolvedB, knownA] }),
  }), /unresolved|non-submission/);

  const statuslessB = deploymentReceipt({
    releaseId: releaseB,
    repositoryDeploymentId: 307,
    deploymentId: null,
    knownGood: false,
    repositoryState: "pending",
    repositoryStatusRecorded: false,
    attemptPhase: "submission-uncertain",
    uncertain: true,
    previous: knownA,
    sourceArtifactId: 999,
  });
  await assert.rejects(verifyCurrentPublication({
    operation: "rollback",
    token: "token",
    currentReceipt: statuslessB,
    rollbackTargetReceipt: knownA,
    sourceManifest: { releaseId: releaseA, releaseKind: "live", site: { tarSha256: knownA.source.siteTarSha256 } },
    sourceIdentity: { artifactId: knownA.source.artifactId, artifactDigest: knownA.source.artifactDigest, manifestSha256: knownA.source.manifestSha256 },
    fetchImpl: deploymentApiFixture({ publicReleaseId: releaseA, receipts: [statuslessB, knownA] }),
  }), /unresolved|non-submission/);

  const queuedB = deploymentReceipt({
    releaseId: releaseB,
    repositoryDeploymentId: 304,
    deploymentId: "pages-b-queued",
    pagesStatus: "queued",
    knownGood: false,
    repositoryState: "failure",
    attemptPhase: "status-uncertain",
    uncertain: true,
    previous: knownA,
    sourceArtifactId: 999,
  });
  await assert.rejects(verifyCurrentPublication({
    operation: "rollback",
    token: "token",
    currentReceipt: queuedB,
    rollbackTargetReceipt: knownA,
    sourceManifest: { releaseId: releaseA, releaseKind: "live", site: { tarSha256: knownA.source.siteTarSha256 } },
    sourceIdentity: { artifactId: knownA.source.artifactId, artifactDigest: knownA.source.artifactDigest, manifestSha256: knownA.source.manifestSha256 },
    fetchImpl: deploymentApiFixture({ publicReleaseId: releaseA, receipts: [queuedB, knownA] }),
  }), /not reached a recognized terminal state/);

  for (const [index, pagesStatus] of ["in_progress", "unknown", "error"].entries()) {
    const nonterminal = deploymentReceipt({
      releaseId: releaseB,
      repositoryDeploymentId: 310 + index,
      deploymentId: `pages-b-${pagesStatus}`,
      pagesStatus,
      knownGood: false,
      repositoryState: "failure",
      attemptPhase: "status-uncertain",
      uncertain: true,
      previous: knownA,
      sourceArtifactId: 999,
    });
    await assert.rejects(verifyCurrentPublication({
      operation: "rollback",
      token: "token",
      currentReceipt: nonterminal,
      rollbackTargetReceipt: knownA,
      sourceManifest: { releaseId: releaseA, releaseKind: "live", site: { tarSha256: knownA.source.siteTarSha256 } },
      sourceIdentity: { artifactId: knownA.source.artifactId, artifactDigest: knownA.source.artifactDigest, manifestSha256: knownA.source.manifestSha256 },
      fetchImpl: deploymentApiFixture({ publicReleaseId: releaseA, receipts: [nonterminal, knownA] }),
    }), /recognized terminal state/);
  }

  const unknownB = deploymentReceipt({
    releaseId: releaseB,
    repositoryDeploymentId: 305,
    deploymentId: "pages-b-unknown",
    pagesStatus: "future-status",
    knownGood: false,
    repositoryState: "failure",
    attemptPhase: "status-uncertain",
    uncertain: true,
    previous: knownA,
    sourceArtifactId: 999,
  });
  await assert.rejects(verifyCurrentPublication({
    operation: "rollback",
    token: "token",
    currentReceipt: unknownB,
    rollbackTargetReceipt: knownA,
    sourceManifest: { releaseId: releaseA, releaseKind: "live", site: { tarSha256: knownA.source.siteTarSha256 } },
    sourceIdentity: { artifactId: knownA.source.artifactId, artifactDigest: knownA.source.artifactDigest, manifestSha256: knownA.source.manifestSha256 },
    fetchImpl: deploymentApiFixture({ publicReleaseId: releaseA, receipts: [unknownB, knownA] }),
  }), /recognized terminal state/);

  const rejectedB = deploymentReceipt({
    releaseId: releaseB,
    repositoryDeploymentId: 306,
    deploymentId: null,
    knownGood: false,
    repositoryState: "failure",
    attemptPhase: "submission-rejected",
    uncertain: false,
    previous: knownA,
    sourceArtifactId: 999,
  });
  await assert.doesNotReject(verifyCurrentPublication({
    operation: "rollback",
    token: "token",
    currentReceipt: rejectedB,
    rollbackTargetReceipt: knownA,
    sourceManifest: { releaseId: releaseA, releaseKind: "live", site: { tarSha256: knownA.source.siteTarSha256 } },
    sourceIdentity: { artifactId: knownA.source.artifactId, artifactDigest: knownA.source.artifactDigest, manifestSha256: knownA.source.manifestSha256 },
    fetchImpl: deploymentApiFixture({ publicReleaseId: releaseA, receipts: [rejectedB, knownA] }),
  }));

  await assert.rejects(verifyCurrentPublication({
    operation: "promote",
    sourceManifest: { releaseId: releaseB },
    sourceIdentity: { artifactId: 999, artifactDigest, manifestSha256: "1".repeat(64) },
    token: "token",
    fetchImpl: async (input: URL | RequestInfo) => String(input).includes("release.json")
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 404 }),
  }), /unavailable/);
});

test("the exact failed first promotion can be reconciled only by its immutable receipt and latest failed environment deployment", async () => {
  const receipt = failedPreSubmissionReceipt();
  const receiptDigest = "sha256:bf3c1430abf5bf1ebc8707e601b51f3776705cde507997ff3b606fcc88601874";
  const exactApproval = `RECONCILE_PRE_SUBMISSION:${receiptDigest}:6394978446`;
  const sourceManifest = { releaseId: "e".repeat(64) };
  const sourceIdentity = { artifactId: 999, artifactDigest, manifestSha256: "1".repeat(64) };
  const result = await verifyCurrentPublication({
    operation: "promote",
    token: "token",
    currentReceipt: receipt,
    sourceManifest,
    sourceIdentity,
    currentReceiptArtifactId: 10_267_367_634,
    currentReceiptArtifactDigest: receiptDigest,
    preSubmissionFailureApproval: exactApproval,
    fetchImpl: failedPreSubmissionApiFixture(),
  });
  assert.deepEqual(result, {
    state: "reconciled-pre-submission-failure",
    publicReleaseId: "NONE_404",
    environmentDeploymentId: 6_394_978_446,
  });

  await assert.rejects(verifyCurrentPublication({
    operation: "promote",
    token: "token",
    currentReceipt: receipt,
    sourceManifest,
    sourceIdentity,
    currentReceiptArtifactId: 10_267_367_634,
    currentReceiptArtifactDigest: receiptDigest,
    preSubmissionFailureApproval: `RECONCILE_PRE_SUBMISSION:${receiptDigest}:6394978447`,
    fetchImpl: failedPreSubmissionApiFixture(),
  }), /exact Project Manager reconciliation approval/);

  await assert.rejects(verifyCurrentPublication({
    operation: "promote",
    token: "token",
    currentReceipt: receipt,
    sourceManifest,
    sourceIdentity,
    currentReceiptArtifactId: 10_267_367_634,
    currentReceiptArtifactDigest: receiptDigest,
    preSubmissionFailureApproval: exactApproval,
    fetchImpl: failedPreSubmissionApiFixture({ newerEnvironmentDeployment: true }),
  }), /unbound newer environment deployment/);

  const currentPromotion = { runId: 999_000, runAttempt: 1, workflowSha: "f".repeat(40), job: "deploy" };
  await assert.doesNotReject(verifyCurrentPublication({
    operation: "promote",
    token: "token",
    currentReceipt: receipt,
    sourceManifest,
    sourceIdentity,
    currentReceiptArtifactId: 10_267_367_634,
    currentReceiptArtifactDigest: receiptDigest,
    preSubmissionFailureApproval: exactApproval,
    currentPromotion,
    fetchImpl: failedPreSubmissionApiFixture({ currentPromotion: true }),
  }));
  await assert.rejects(verifyCurrentPublication({
    operation: "promote",
    token: "token",
    currentReceipt: receipt,
    sourceManifest,
    sourceIdentity,
    currentReceiptArtifactId: 10_267_367_634,
    currentReceiptArtifactDigest: receiptDigest,
    preSubmissionFailureApproval: exactApproval,
    currentPromotion,
    fetchImpl: failedPreSubmissionApiFixture({ currentPromotion: true, duplicateCurrent: true }),
  }), /one exact newer environment deployment/);
  for (const [fixture, useCurrentPromotion, message] of [
    [failedPreSubmissionApiFixture({ tamperReceiptArtifact: true }), false, /artifact provenance/],
    [failedPreSubmissionApiFixture({ tamperSubmissionStep: true }), false, /submission step was skipped/],
    [failedPreSubmissionApiFixture({ currentPromotion: true, currentStatus: "queued" }), true, /not bound to its protected job/],
    [failedPreSubmissionApiFixture({ currentPromotion: true, incompleteCurrentJobs: true }), true, /collection is incomplete/],
  ] as const) {
    await assert.rejects(verifyCurrentPublication({
      operation: "promote",
      token: "token",
      currentReceipt: receipt,
      sourceManifest,
      sourceIdentity,
      currentReceiptArtifactId: 10_267_367_634,
      currentReceiptArtifactDigest: receiptDigest,
      preSubmissionFailureApproval: exactApproval,
      currentPromotion: useCurrentPromotion ? currentPromotion : null,
      fetchImpl: fixture,
    }), message);
  }

  const alteredReceipt = structuredClone(receipt);
  alteredReceipt.source.artifactId += 1;
  await assert.rejects(verifyCurrentPublication({
    operation: "promote",
    token: "token",
    currentReceipt: alteredReceipt,
    sourceManifest,
    sourceIdentity,
    currentReceiptArtifactId: 10_267_367_634,
    currentReceiptArtifactDigest: receiptDigest,
    preSubmissionFailureApproval: exactApproval,
    fetchImpl: failedPreSubmissionApiFixture(),
  }), /exactly match the reviewed/);
});

test("new final-gate failures remain definitive non-submissions without weakening ordinary missing-ID failures", async () => {
  const prior = failedPreSubmissionReceipt();
  const receipt = publicationDeploymentReceiptSchema.parse({
    ...prior,
    attemptPhase: "pre-submission",
    pagesStatus: "final-gate",
    reconciliation: { outcome: "not-submitted", publicReleaseId: "NONE_404" },
    uncertain: false,
  });
  const result = await verifyCurrentPublication({
    operation: "promote",
    token: "token",
    currentReceipt: receipt,
    sourceManifest: { releaseId: "e".repeat(64) },
    sourceIdentity: { artifactId: 999, artifactDigest, manifestSha256: "1".repeat(64) },
    fetchImpl: deploymentApiFixture({ publicReleaseId: "NONE_404", deployments: [] }),
  });
  assert.deepEqual(result, { state: "definitive-pre-submission", publicReleaseId: "NONE_404" });
});

test("first-release recovery is authorized from the exact failed current attempt", async () => {
  const failedLive = deploymentReceipt({
    releaseId: "b".repeat(64),
    repositoryDeploymentId: 606,
    deploymentId: "pages-failed-smoke",
    sourceArtifactId: 900,
    knownGood: false,
    repositoryState: "failure",
    publicProductVerified: false,
  });
  const recovery = failedLive.recovery!;
  const result = await verifyCurrentPublication({
    operation: "first-release-recovery",
    token: "token",
    currentReceipt: failedLive,
    rollbackTargetReceipt: null,
    sourceManifest: { releaseId: recovery.releaseId, releaseKind: "first-release-recovery" },
    sourceIdentity: { artifactId: recovery.artifactId, artifactDigest: recovery.artifactDigest, manifestSha256: recovery.manifestSha256 },
    fetchImpl: deploymentApiFixture({ publicReleaseId: failedLive.releaseId, receipts: [failedLive] }),
  });
  assert.equal(result.state, "reconciled-current-attempt");

  const ledgerlessFailure = publicationDeploymentReceiptSchema.parse({
    ...failedLive,
    deploymentId: null,
    pageUrl: null,
    attemptPhase: "submission-uncertain",
    repositoryDeployment: { id: null, state: "unknown", statusRecorded: false },
    pagesAccepted: false,
    pagesStatus: null,
    markerVerified: false,
    publicProductVerified: false,
    reconciliation: { outcome: "submission-uncertain", publicReleaseId: "NONE_404" },
    knownGood: false,
    uncertain: true,
  });
  await assert.rejects(verifyCurrentPublication({
    operation: "first-release-recovery",
    token: "token",
    currentReceipt: ledgerlessFailure,
    rollbackTargetReceipt: null,
    sourceManifest: { releaseId: recovery.releaseId, releaseKind: "first-release-recovery" },
    sourceIdentity: { artifactId: recovery.artifactId, artifactDigest: recovery.artifactDigest, manifestSha256: recovery.manifestSha256 },
    fetchImpl: deploymentApiFixture({ publicReleaseId: "NONE_404", deployments: [] }),
  }), /no exact repository deployment ledger match/);

  const newerAttempt = deploymentReceipt({
    releaseId: "c".repeat(64),
    repositoryDeploymentId: 607,
    deploymentId: "pages-newer-c",
    sourceArtifactId: 901,
    knownGood: false,
    repositoryState: "failure",
    publicProductVerified: false,
  });
  await assert.rejects(verifyCurrentPublication({
    operation: "first-release-recovery",
    token: "token",
    currentReceipt: ledgerlessFailure,
    rollbackTargetReceipt: null,
    sourceManifest: { releaseId: recovery.releaseId, releaseKind: "first-release-recovery" },
    sourceIdentity: { artifactId: recovery.artifactId, artifactDigest: recovery.artifactDigest, manifestSha256: recovery.manifestSha256 },
    fetchImpl: deploymentApiFixture({
      publicReleaseId: "NONE_404",
      receipts: [newerAttempt, failedLive],
      deployments: [repositoryDeploymentForReceipt(newerAttempt), repositoryDeploymentForReceipt(failedLive)],
    }),
  }), /historical rather than current/);
});

test("repository deployment ledger uses supported contracts and recovers an accepted Pages ID", async () => {
  const payload = publicationLedgerPayload({ promotionRunId: 700, runAttempt: 1, releaseId: "f".repeat(64), sourceArtifactId: 701, stagedArtifactId: 702 });
  const requests: Array<{ url: string; method: string }> = [];
  const deployment = { id: 703, sha: sourceSha, task: "lionlog-pages-release", environment: "github-pages", transient_environment: false, production_environment: true, payload: { ...payload } };
  const createdId = await createRepositoryDeploymentLedger({
    token: "token",
    workflowSha: sourceSha,
    payload,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return Response.json(deployment, { status: 201 });
    },
  });
  assert.equal(createdId, 703);
  assert.deepEqual(requests, [{ url: "https://api.github.com/repos/CrunchyBrunch/lionlog/deployments", method: "POST" }]);

  const recovered = await recoverRepositoryDeploymentAttempt({
    token: "token",
    expectedPayload: payload,
    expectedWorkflowSha: sourceSha,
    now: () => Date.parse("2026-09-07T12:00:00.000Z"),
    fetchImpl: async (input) => {
      const url = String(input);
      if (/\/deployments\?task=/.test(url)) return Response.json([deployment]);
      if (url.endsWith("/deployments/703")) return Response.json(deployment);
      if (url.includes("/deployments/703/statuses")) return Response.json([{
        state: "in_progress",
        deployment_url: "https://api.github.com/repos/CrunchyBrunch/lionlog/deployments/703",
        log_url: "https://api.github.com/repos/CrunchyBrunch/lionlog/pages/deployments/pages-accepted",
      }]);
      if (url.endsWith("/pages/deployments/pages-accepted")) return Response.json({ id: "pages-accepted", status: "succeed" });
      return new Response(null, { status: 404 });
    },
  });
  assert.equal(recovered.attempt.repositoryDeploymentId, 703);
  assert.equal(recovered.attempt.deploymentId, "pages-accepted");
  assert.equal(recovered.attempt.phase, "terminal");
  assert.equal(recovered.attempt.uncertain, false);

  const createdWithoutStatus = await recoverRepositoryDeploymentAttempt({
    token: "token",
    expectedPayload: payload,
    expectedWorkflowSha: sourceSha,
    fetchImpl: async (input) => {
      const url = String(input);
      if (/\/deployments\?task=/.test(url)) return Response.json([deployment]);
      if (/\/deployments\/703$/.test(url)) return Response.json(deployment);
      if (/\/deployments\/703\/statuses\?/.test(url)) return Response.json([]);
      return new Response(null, { status: 404 });
    },
  });
  assert.equal(createdWithoutStatus.attempt.repositoryDeploymentId, 703);
  assert.equal(createdWithoutStatus.attempt.phase, "submission-uncertain");
  assert.equal(createdWithoutStatus.repositoryState, "pending");
  assert.equal(createdWithoutStatus.repositoryStatusRecorded, false);
});

test("repository deployment history is complete within a fixed bound and fails closed when truncated", async () => {
  const deployment = (id: number) => ({ id });
  const pages = [
    Array.from({ length: 100 }, (_, index) => deployment(1_000 - index)),
    [deployment(900)],
  ];
  const requested: string[] = [];
  const history = await readRepositoryDeploymentHistory({
    token: "token",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requested.push(url.href);
      return Response.json(pages[Number(url.searchParams.get("page")) - 1] ?? []);
    },
  });
  assert.equal(history.length, 101);
  assert.deepEqual(requested.map((url) => new URL(url).searchParams.get("page")), ["1", "2"]);

  await assert.rejects(readRepositoryDeploymentHistory({
    token: "token",
    fetchImpl: async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return Response.json(Array.from({ length: 100 }, (_, index) => deployment(page * 1_000 + index)));
    },
  }), /exceeds the 1000-entry verification bound/);
  await assert.rejects(readRepositoryDeploymentHistory({
    token: "token",
    fetchImpl: async () => new Response(null, { status: 500 }),
  }), /unavailable/);
});

test("ordinary rollback can restore an exact known-good app-only recovery after a later live failure", async () => {
  const appOnly = deploymentReceipt({
    releaseId: "9".repeat(64),
    releaseKind: "first-release-recovery",
    operation: "first-release-recovery",
    repositoryDeploymentId: 801,
    deploymentId: "pages-app-only-a",
    sourceArtifactId: 455,
    sourceArtifactDigest: `sha256:${"7".repeat(64)}`,
    sourceManifestSha256: "8".repeat(64),
  });
  const failedLive = deploymentReceipt({
    releaseId: "c".repeat(64),
    repositoryDeploymentId: 802,
    deploymentId: "pages-live-c",
    sourceArtifactId: 901,
    knownGood: false,
    repositoryState: "failure",
    publicProductVerified: false,
    previous: appOnly,
  });
  const result = await verifyCurrentPublication({
    operation: "rollback",
    token: "token",
    currentReceipt: failedLive,
    rollbackTargetReceipt: appOnly,
    sourceManifest: { releaseId: appOnly.releaseId, releaseKind: "first-release-recovery", site: { tarSha256: appOnly.source.siteTarSha256 } },
    sourceIdentity: { artifactId: appOnly.source.artifactId, artifactDigest: appOnly.source.artifactDigest, manifestSha256: appOnly.source.manifestSha256 },
    fetchImpl: deploymentApiFixture({ publicReleaseId: failedLive.releaseId, receipts: [failedLive, appOnly] }),
  });
  assert.equal(result.state, "reconciled-current-attempt");
});

test("exact Pages adapter submits once, returns the deployment ID, and never retries uncertainty", async () => {
  const requests: string[] = [];
  const accepted: unknown[] = [];
  const result = await deployExactPagesArtifact({
    artifactId: 456,
    buildVersion: sourceSha,
    repositoryDeploymentId: 77,
    githubToken: "token",
    oidcToken: "oidc",
    approvalExpiresAt: "2099-01-01T00:00:00.000Z",
    wait: async () => {},
    recordAccepted: async (value: unknown) => { accepted.push(value); },
    fetchImpl: async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return init?.method === "POST"
        ? Response.json({
          id: "deployment-1",
          status_url: "https://api.github.com/repos/CrunchyBrunch/lionlog/pages/deployments/deployment-1/status",
          page_url: "https://crunchybrunch.github.io/lionlog/",
        })
        : Response.json({ status: "succeed" });
    },
  });
  assert.equal(result.deploymentId, "deployment-1");
  assert.deepEqual(accepted, [{ repositoryDeploymentId: 77, pagesDeploymentId: "deployment-1" }]);
  assert.equal(requests.filter((request) => request.startsWith("POST ")).length, 1);
  let attempts = 0;
  await assert.rejects(deployExactPagesArtifact({
    artifactId: 456,
    buildVersion: sourceSha,
    repositoryDeploymentId: 77,
    githubToken: "token",
    oidcToken: "oidc",
    approvalExpiresAt: "2099-01-01T00:00:00.000Z",
    fetchImpl: async () => { attempts += 1; throw new Error("connection reset"); },
  }), /uncertain/);
  assert.equal(attempts, 1);
  const submissionEvidence: unknown[] = [];
  await assert.rejects(deployExactPagesArtifact({
    artifactId: 456,
    buildVersion: sourceSha,
    repositoryDeploymentId: 77,
    githubToken: "token",
    oidcToken: "oidc",
    approvalExpiresAt: "2099-01-01T00:00:00.000Z",
    recordAttempt: async (value: unknown) => { submissionEvidence.push(value); },
    fetchImpl: async () => new Response(null, { status: 503 }),
  }), /outcome is uncertain/);
  assert.deepEqual(
    Object.fromEntries(Object.entries(submissionEvidence.at(-1) as Record<string, unknown>).filter(([key]) => ["phase", "status", "uncertain", "deploymentId"].includes(key))),
    { phase: "submission-uncertain", deploymentId: null, status: "http-503", uncertain: true },
  );
  await assert.rejects(deployExactPagesArtifact({
    artifactId: 456,
    buildVersion: sourceSha,
    repositoryDeploymentId: 77,
    githubToken: "token",
    oidcToken: "oidc",
    approvalExpiresAt: "2099-01-01T00:00:00.000Z",
    wait: async () => {},
    fetchImpl: async (_input, init) => init?.method === "POST"
      ? Response.json({
        id: "deployment-2",
        status_url: "https://api.github.com/repos/CrunchyBrunch/lionlog/pages/deployments/deployment-2/status",
        page_url: "https://crunchybrunch.github.io/lionlog-lookalike/",
      })
      : Response.json({ status: "succeed" }),
  }), /unexpected public URL/);
  const evidence: unknown[] = [];
  await assert.rejects(deployExactPagesArtifact({
    artifactId: 456,
    buildVersion: sourceSha,
    repositoryDeploymentId: 77,
    githubToken: "token",
    oidcToken: "oidc",
    approvalExpiresAt: "2099-01-01T00:00:00.000Z",
    wait: async () => {},
    recordAttempt: async (value: unknown) => { evidence.push(value); },
    fetchImpl: async (_input, init) => init?.method === "POST"
      ? Response.json({
        id: "deployment-evidence",
        status_url: "https://api.github.com/repos/CrunchyBrunch/lionlog/pages/deployments/deployment-evidence/status",
        page_url: "https://crunchybrunch.github.io/lionlog/",
      })
      : new Response(null, { status: 503 }),
  }), /deployment-evidence/);
  assert.equal((evidence.at(-1) as { deploymentId: string }).deploymentId, "deployment-evidence");
  const timeoutEvidence: unknown[] = [];
  await assert.rejects(deployExactPagesArtifact({
    artifactId: 456,
    buildVersion: sourceSha,
    repositoryDeploymentId: 77,
    githubToken: "token",
    oidcToken: "oidc",
    approvalExpiresAt: "2099-01-01T00:00:00.000Z",
    timeoutMs: 0,
    recordAttempt: async (value: unknown) => { timeoutEvidence.push(value); },
    fetchImpl: async () => Response.json({
      id: "deployment-timeout",
      status_url: "https://api.github.com/repos/CrunchyBrunch/lionlog/pages/deployments/deployment-timeout/status",
      page_url: "https://crunchybrunch.github.io/lionlog/",
    }),
  }), /timed out/);
  assert.equal((timeoutEvidence.at(-1) as { deploymentId: string }).deploymentId, "deployment-timeout");
  let clockReads = 0;
  let submissions = 0;
  const temporalEvidence: unknown[] = [];
  await assert.rejects(deployExactPagesArtifact({
    artifactId: 456,
    buildVersion: sourceSha,
    repositoryDeploymentId: 77,
    githubToken: "token",
    oidcToken: "oidc",
    approvalExpiresAt: "2026-09-07T12:00:01.000Z",
    now: () => new Date("2026-09-07T12:00:00.000Z").getTime() + (clockReads++ * 2_000),
    recordAttempt: async (value: unknown) => { temporalEvidence.push(value); },
    fetchImpl: async () => { submissions += 1; return Response.json({}); },
  }), /expired before submission/);
  assert.equal(submissions, 0);
  assert.equal((temporalEvidence.at(-1) as { phase: string } | undefined)?.phase, "submission-rejected");
});

test("final promotion gate blocks state and time mutations before OIDC and submission", async () => {
  const expected = {
    operation: "promote",
    promotionWorkflowSha: sourceSha,
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    minimumFreshUntil: "2026-09-07T13:00:00.000Z",
    source: { runId: 123, sourceSha },
    ci: { runId: 999 },
    site: { tarSha256: "c".repeat(64), bytes: 10, inventory: [{ path: "index.html", bytes: 10, sha256: "d".repeat(64) }] },
    artifacts: [
      { id: 456, digest: artifactDigest, runId: 123, headSha: sourceSha, role: "source" },
      { id: 789, digest: `sha256:${"e".repeat(64)}`, runId: 321, headSha: sourceSha, role: "staged" },
    ],
  };
  const actual = {
    checkoutSha: sourceSha,
    mainSha: sourceSha,
    sourceRun: { id: 123, workflow_id: 347_085_467, path: ".github/workflows/build-live-menu-artifact.yml", event: "workflow_dispatch", head_sha: sourceSha, head_branch: "main", run_attempt: 1, status: "completed", conclusion: "success" },
    ciRun: { id: 999, workflow_id: 346_680_782, path: ".github/workflows/ci.yml", event: "push", head_sha: sourceSha, head_branch: "main", run_attempt: 1, status: "completed", conclusion: "success" },
    ciJobs: [{ name: "verify", head_sha: sourceSha, status: "completed", conclusion: "success" }],
    artifacts: [
      { id: 456, digest: artifactDigest, expired: false, workflow_run: { id: 123, head_sha: sourceSha, head_branch: "main", head_repository_id: 1_346_360_244 } },
      { id: 789, digest: "e".repeat(64), expired: false, workflow_run: { id: 321, head_sha: sourceSha, head_branch: "main", head_repository_id: 1_346_360_244 } },
    ],
  };
  const run = (states: typeof actual[], times = [Date.parse("2026-09-07T12:00:00.000Z"), Date.parse("2026-09-07T12:00:01.000Z")], currentChecks: Array<Error | null> = [null, null]) => {
    let stateRead = 0;
    let timeRead = 0;
    let currentRead = 0;
    const calls = { oidc: 0, submissions: 0 };
    const result = executeFinalPromotionGate({
      expected,
      readActual: async () => states[Math.min(stateRead++, states.length - 1)],
      verifyCurrentState: async () => {
        const error = currentChecks[Math.min(currentRead++, currentChecks.length - 1)];
        if (error) throw error;
      },
      clock: () => times[Math.min(timeRead++, times.length - 1)],
      requestOidc: async () => { calls.oidc += 1; return "oidc"; },
      submit: async () => { calls.submissions += 1; return "submitted"; },
    });
    return { result, calls };
  };
  const preOidcMutations: Array<{ state: typeof actual; message: RegExp }> = [
    { state: { ...actual, mainSha: "0".repeat(40) }, message: /Main/ },
    { state: { ...actual, sourceRun: { ...actual.sourceRun, conclusion: "failure" } }, message: /producer/ },
    { state: { ...actual, ciRun: { ...actual.ciRun, conclusion: "failure" } }, message: /CI/ },
    { state: { ...actual, artifacts: [{ ...actual.artifacts[0], expired: true }, actual.artifacts[1]] }, message: /Artifact/ },
  ];
  for (const mutation of preOidcMutations) {
    const blocked = run([mutation.state]);
    await assert.rejects(blocked.result, mutation.message);
    assert.deepEqual(blocked.calls, { oidc: 0, submissions: 0 });
  }
  const changedAfterOidc = run([actual, { ...actual, artifacts: [{ ...actual.artifacts[0], digest: `sha256:${"0".repeat(64)}` }, actual.artifacts[1]] }]);
  await assert.rejects(changedAfterOidc.result, /Artifact/);
  assert.deepEqual(changedAfterOidc.calls, { oidc: 1, submissions: 0 });
  const currentChangedAfterOidc = run([actual, actual], undefined, [null, new Error("Current deployment authority changed.")]);
  await assert.rejects(currentChangedAfterOidc.result, /Current deployment authority/);
  assert.deepEqual(currentChangedAfterOidc.calls, { oidc: 1, submissions: 0 });
  const freshnessExpiredAfterOidc = run([actual, actual], [Date.parse("2026-09-07T12:00:00.000Z"), Date.parse("2026-09-07T12:45:01.000Z")]);
  await assert.rejects(freshnessExpiredAfterOidc.result, /freshness/);
  assert.deepEqual(freshnessExpiredAfterOidc.calls, { oidc: 1, submissions: 0 });
  const approvalExpiredBeforeOidc = run([actual], [Date.parse("2026-09-07T13:00:01.000Z")]);
  await assert.rejects(approvalExpiredBeforeOidc.result, /approval expired/);
  assert.deepEqual(approvalExpiredBeforeOidc.calls, { oidc: 0, submissions: 0 });
  const accepted = run([actual, actual]);
  assert.equal(await accepted.result, "submitted");
  assert.deepEqual(accepted.calls, { oidc: 1, submissions: 1 });
});

test("final promotion state reader uses only exact approved run and artifact identities", async () => {
  const expected = {
    source: { runId: 123 },
    ci: { runId: 999 },
    artifacts: [{ id: 456 }, { id: 789 }],
  };
  const requested: string[] = [];
  const state = await readFinalPromotionState({
    expected,
    githubToken: "token",
    checkoutSha: sourceSha,
    fetchImpl: async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/commits/main")) return Response.json({ sha: sourceSha });
      if (url.endsWith("/actions/runs/123")) return Response.json({ id: 123 });
      if (url.endsWith("/actions/runs/999")) return Response.json({ id: 999 });
      if (url.endsWith("/actions/runs/999/jobs?per_page=100")) return Response.json({ jobs: [{ name: "verify" }] });
      const artifact = url.match(/\/actions\/artifacts\/(\d+)$/);
      if (artifact) return Response.json({ id: Number(artifact[1]) });
      return new Response(null, { status: 404 });
    },
  });
  assert.equal(state.ciRun.id, 999);
  assert.equal(requested.some((url) => url.includes("workflows/") || url.includes("head_sha=")), false);
  assert.deepEqual(requested.filter((url) => url.includes("/actions/artifacts/")).sort(), [
    "https://api.github.com/repos/CrunchyBrunch/lionlog/actions/artifacts/456",
    "https://api.github.com/repos/CrunchyBrunch/lionlog/actions/artifacts/789",
  ]);
});

test("known-good receipts require the complete served inventory, not only the marker", async () => {
  const marker = Buffer.from("marker");
  const index = Buffer.from("index");
  const manifest = {
    releaseId: "f".repeat(64),
    target: { origin: "https://crunchybrunch.github.io", basePath: "/lionlog/" },
    site: { inventory: [
      { path: "index.html", bytes: index.byteLength, sha256: sha256(index) },
      { path: "release.json", bytes: marker.byteLength, sha256: sha256(marker) },
    ] },
  };
  await assert.rejects(verifyPublicSite({
    manifest,
    fetchImpl: async (input: URL | RequestInfo) => String(input).endsWith("release.json")
      ? new Response(marker)
      : new Response("broken"),
  }), /index.html/);
  const input = {
    recordedAt: "2026-09-07T12:30:00.000Z",
    operation: "promote",
    releaseId: manifest.releaseId,
    releaseKind: "live",
    previousKnownGoodReleaseId: "NONE_FIRST_DEPLOYMENT",
    previousKnownGoodRepositoryDeploymentId: "NONE_FIRST_DEPLOYMENT",
    previousKnownGoodPagesDeploymentId: "NONE_FIRST_DEPLOYMENT",
    workflowSha: sourceSha,
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    sourceArtifactId: 456,
    sourceArtifactDigest: artifactDigest,
    sourceManifestSha256: "d".repeat(64),
    sourceSiteTarSha256: "c".repeat(64),
    recovery: { releaseId: "9".repeat(64), manifestSha256: "8".repeat(64), artifactId: 455, artifactDigest: `sha256:${"7".repeat(64)}` },
    stagedArtifactId: 789,
    stagedArtifactDigest: `sha256:${"e".repeat(64)}`,
    stagedArtifactExpiresAt: "2026-12-01T00:00:00.000Z",
    runId: 321,
    runAttempt: 1,
    publicProductVerified: false,
    markerVerified: true,
    publicReleaseId: manifest.releaseId,
    repositoryState: "success",
    repositoryStatusRecorded: true,
    attempt: { phase: "terminal", repositoryDeploymentId: 1234, deploymentId: "deployment-1", status: "succeed", uncertain: false },
  };
  assert.equal(createDeploymentReceipt(input).knownGood, false);
  const completeReceipt = createDeploymentReceipt({ ...input, publicProductVerified: true });
  assert.equal(completeReceipt.knownGood, true);
  assert.equal(publicationDeploymentReceiptSchema.safeParse(completeReceipt).success, true);
  const collectorDependencyFailure = createDeploymentReceipt({
    ...input,
    markerVerified: false,
    publicProductVerified: false,
    repositoryState: "unknown",
    repositoryStatusRecorded: false,
    attempt: { phase: "status-uncertain", repositoryDeploymentId: 1234, deploymentId: "deployment-1", status: "collector-unavailable", uncertain: true },
  });
  assert.equal(collectorDependencyFailure.knownGood, false);
  assert.equal(collectorDependencyFailure.uncertain, true);
  assert.equal(publicationDeploymentReceiptSchema.safeParse(collectorDependencyFailure).success, true);
  const preSubmissionFailure = createDeploymentReceipt({
    ...input,
    markerVerified: false,
    publicProductVerified: false,
    publicReleaseId: "NONE_404",
    repositoryState: "unknown",
    repositoryStatusRecorded: false,
    attempt: { phase: "pre-submission", repositoryDeploymentId: null, deploymentId: null, status: "final-gate", uncertain: false },
  });
  assert.equal(preSubmissionFailure.attemptPhase, "pre-submission");
  assert.equal(preSubmissionFailure.reconciliation.outcome, "not-submitted");
  assert.equal(preSubmissionFailure.knownGood, false);
  assert.equal(preSubmissionFailure.uncertain, false);
  assert.equal(publicationDeploymentReceiptSchema.safeParse(preSubmissionFailure).success, true);
  assert.equal(createDeploymentReceipt({
    ...input,
    publicProductVerified: true,
    attempt: { ...input.attempt, phase: "accepted" },
  }).knownGood, false);
  assert.throws(() => createDeploymentReceipt({
    ...input,
    attempt: { ...input.attempt, phase: "invented" },
  }), /phase is invalid/);
});

async function writeFieldReleaseSite(root: string, policy: { freshForMs: number; retainForMs: number }): Promise<void> {
  await writeRecoverySite(root);
  const retrievedAt = new Date("2026-09-07T11:30:00.000Z");
  const cachedAt = new Date("2026-09-07T12:00:00.000Z");
  const snapshots = PSU_RELEASE_HALL_IDS.map((hallId) => {
    const hall = getPsuHall(hallId);
    const period = getPsuMealPeriod("lunch");
    return buildPsuSnapshot(
      { serviceDate: "2026-09-07", hallId, mealPeriodId: period.id, venueIds: [] },
      { context: { sourceCampusId: hall.sourceCampusId, sourceDate: sourceDateFromIso("2026-09-07"), sourceMeal: period.sourceValue }, stations: [], empty: true },
      new Map(),
      { retrievedAt, cachedAt, ...policy },
    );
  });
  const entries = snapshots.map((snapshot) => catalogEntryForSnapshot(
    snapshot,
    `./snapshots/${snapshot.query.serviceDate}/${snapshot.query.sourceCampusId}/${snapshot.query.mealPeriodId}.json`,
  ));
  const catalog = validatePsuPublicationCatalog({
    catalogVersion: PSU_CATALOG_VERSION,
    snapshotSchemaVersion: PSU_SNAPSHOT_VERSION,
    parserVersion: PSU_PARSER_VERSION,
    generatedAt: cachedAt.toISOString(),
    publication: {
      mode: "field-release",
      sourceKind: "psu-public-menu-html",
      commitSha: sourceSha,
      serviceDate: "2026-09-07",
      hallIds: [...PSU_RELEASE_HALL_IDS],
      retrievalStartedAt: "2026-09-07T11:00:00.000Z",
      retrievalCompletedAt: "2026-09-07T12:00:00.000Z",
      expectedSnapshotCount: 5,
      publishedSnapshotCount: 5,
      recognizedEmptySnapshotCount: 5,
      itemCount: 0,
      coverage: "complete",
      sourceObservationCount: 0,
      publishedObservationCount: 0,
      omissions: { "invalid-name": 0 },
      requestCount: 10,
      nutritionRequests: 0,
      nutritionCacheHits: 0,
    },
    serviceDates: ["2026-09-07"],
    halls: PSU_RELEASE_HALL_IDS.map((id) => ({ id, displayName: getPsuHall(id).displayName })),
    mealPeriods: [{ id: "lunch", displayName: getPsuMealPeriod("lunch").displayName }],
    snapshots: entries,
  });
  for (const snapshot of snapshots) {
    const file = path.join(root, "menu-data", "v2", "snapshots", snapshot.query.serviceDate, snapshot.query.sourceCampusId, `${snapshot.query.mealPeriodId}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  await mkdir(path.join(root, "menu-data", "v2"), { recursive: true });
  await writeFile(path.join(root, "menu-data", "v2", "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
}

function liveVerificationOptions(bundle: string, manifest: PublicationReleaseManifest, recovery: PublicationReleaseManifest, recoveryDigest: string) {
  if (manifest.menu === null || manifest.recovery === null) throw new Error("Expected a live publication manifest.");
  return {
    bundleDirectory: bundle,
    metadata: githubMetadata(manifest, now),
    operation: "promote" as const,
    expectedSourceSha: sourceSha,
    expectedRunId: 123,
    expectedRunAttempt: 1,
    expectedArtifactId: 456,
    expectedArtifactDigest: artifactDigest,
    expectedManifestSha256: "",
    expectedServiceDate: "2026-09-07",
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    partialApproval: "COMPLETE_ONLY",
    expiredRollbackApproval: "NONE",
    workflowSha: sourceSha,
    expectedPromotionWorkflowSha: sourceSha,
    expectedRecoveryArtifactId: 789,
    expectedRecoveryArtifactDigest: recoveryDigest,
    expectedRecoveryManifestSha256: manifest.recovery.manifestSha256,
    expectedRecoveryReleaseId: recovery.releaseId,
    now,
  };
}

async function rewriteLiveBundle(
  bundle: string,
  mutateCatalog: (catalog: PsuPublicationCatalog) => PsuPublicationCatalog,
  mutateSnapshot?: (snapshot: PsuMenuSnapshot) => PsuMenuSnapshot,
): Promise<void> {
  const manifestPath = path.join(bundle, "release-manifest.json");
  const manifest = publicationReleaseManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (manifest.menu === null || manifest.recovery === null) throw new Error("Expected a live publication manifest.");
  let entries = parsePublicationTar(await readFile(path.join(bundle, "site.tar")));
  const catalogEntry = entries.find((entry) => entry.path === "menu-data/v2/catalog.json")!;
  let catalog = validatePsuPublicationCatalog(JSON.parse(catalogEntry.data.toString("utf8")));
  if (mutateSnapshot) {
    const changed = new Map<string, PsuMenuSnapshot>();
    entries = entries.map((entry) => {
      if (!entry.path.startsWith("menu-data/v2/snapshots/")) return entry;
      const snapshot = mutateSnapshot(buildPsuSnapshotFromBytes(entry.data));
      changed.set(entry.path, snapshot);
      return { ...entry, data: Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`) };
    });
    catalog = validatePsuPublicationCatalog({
      ...catalog,
      snapshots: catalog.snapshots.map((entry) => {
        const snapshot = changed.get(`menu-data/v2/${entry.snapshotUrl.slice(2)}`);
        return snapshot ? catalogEntryForSnapshot(snapshot, entry.snapshotUrl) : entry;
      }),
    });
  }
  const catalogBytes = Buffer.from(`${JSON.stringify(mutateCatalog(catalog), null, 2)}\n`);
  entries = entries.map((entry) => entry.path === catalogEntry.path ? { ...entry, data: catalogBytes } : entry);
  manifest.menu.catalogSha256 = sha256(catalogBytes);
  manifest.releaseId = computePublicationReleaseId({
    releaseKind: "live",
    sourceCommitSha: manifest.source.commitSha,
    workflowRunId: manifest.source.workflowRunId,
    workflowRunAttempt: manifest.source.workflowRunAttempt,
    serviceDate: manifest.menu.serviceDate,
    catalogSha256: manifest.menu.catalogSha256,
    shellRevision: manifest.shellRevision,
    recoveryReleaseId: manifest.recovery.releaseId,
  });
  const markerIndex = entries.findIndex((entry) => entry.path === "release.json");
  const marker = JSON.parse(entries[markerIndex].data.toString("utf8"));
  marker.releaseId = manifest.releaseId;
  marker.catalogSha256 = manifest.menu.catalogSha256;
  const markerBytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`);
  entries[markerIndex] = { ...entries[markerIndex], data: markerBytes };
  const tar = createPublicationTar(entries);
  manifest.marker.sha256 = sha256(markerBytes);
  manifest.site.tarSha256 = sha256(tar);
  manifest.site.bytes = tar.byteLength;
  manifest.site.inventory = parsePublicationTar(tar).map((entry) => ({ path: entry.path, bytes: entry.data.byteLength, sha256: sha256(entry.data) }));
  await writeFile(path.join(bundle, "site.tar"), tar);
  await writeFile(manifestPath, `${JSON.stringify(publicationReleaseManifestSchema.parse(manifest), null, 2)}\n`);
}

function buildPsuSnapshotFromBytes(bytes: Buffer): PsuMenuSnapshot {
  return validatePsuSnapshot(JSON.parse(bytes.toString("utf8")));
}

async function writeRecoverySite(root: string): Promise<void> {
  await mkdir(path.join(root, "_next", "static"), { recursive: true });
  await mkdir(path.join(root, "icons"), { recursive: true });
  await writeFile(path.join(root, ".nojekyll"), "\n");
  await writeFile(path.join(root, "index.html"), `<html data-lionlog-shell="${sourceSha}"><link href="/lionlog/_next/static/app.js"><link href="./manifest.webmanifest"></html>`);
  await writeFile(path.join(root, "_next", "static", "app.js"), "console.log('shell');");
  await writeFile(path.join(root, "icons", "icon-192.png"), "icon");
  await writeFile(path.join(root, "manifest.webmanifest"), JSON.stringify({
    id: "./", start_url: "./", scope: "./", icons: [{ src: "./icons/icon-192.png" }],
  }));
  await writeFile(path.join(root, "sw.js"), `const SHELL_REVISION = "${sourceSha}"; const CACHE='lionlog-shell-${sourceSha}'; const EXCLUDED='menu-data';`);
}

function githubMetadata(manifest: { releaseKind: "live" | "first-release-recovery" }, current: Date) {
  return {
    repository: { id: 1_346_360_244, full_name: "CrunchyBrunch/lionlog" },
    main: { sha: sourceSha },
    artifact: {
      id: 456,
      name: manifest.releaseKind === "live" ? "lionlog-live-fixture" : "lionlog-first-release-recovery-fixture",
      digest: artifactDigest,
      size_in_bytes: 1_024,
      expired: false,
      expires_at: new Date(current.getTime() + 60_000).toISOString(),
      workflow_run: { id: 123, head_sha: sourceSha, head_branch: "main", head_repository_id: 1_346_360_244 },
    },
    run: {
      id: 123,
      event: "workflow_dispatch",
      head_sha: sourceSha,
      head_branch: "main",
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/build-live-menu-artifact.yml",
      workflow_id: 347_085_467,
    },
    ciRun: {
      id: 999,
      workflow_id: 346_680_782,
      path: ".github/workflows/ci.yml",
      event: "push",
      head_sha: sourceSha,
      head_branch: "main",
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
    },
    ciJobs: [{ name: "verify", head_sha: sourceSha, status: "completed", conclusion: "success" }],
  };
}

function rewriteTarChecksum(archive: Buffer): void {
  archive.fill(0x20, 148, 156);
  const checksum = archive.subarray(0, 512).reduce((total, value) => total + value, 0);
  archive.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  archive[154] = 0;
  archive[155] = 0x20;
}

function deploymentReceipt(options: {
  releaseId: string;
  repositoryDeploymentId: number;
  deploymentId: string | null;
  sourceArtifactId: number;
  sourceArtifactDigest?: string;
  sourceManifestSha256?: string;
  releaseKind?: "live" | "first-release-recovery";
  operation?: "promote" | "rollback" | "first-release-recovery";
  knownGood?: boolean;
  repositoryState?: "pending" | "in_progress" | "success" | "failure";
  repositoryStatusRecorded?: boolean;
  publicProductVerified?: boolean;
  pagesStatus?: string;
  attemptPhase?: "pre-submission" | "submission-uncertain" | "submission-rejected" | "status-uncertain" | "terminal";
  uncertain?: boolean;
  previous?: PublicationDeploymentReceipt;
}): PublicationDeploymentReceipt {
  const knownGood = options.knownGood ?? true;
  const repositoryState = options.repositoryState ?? (knownGood ? "success" : "failure");
  const statusRecorded = options.repositoryStatusRecorded ?? true;
  const publicProductVerified = options.publicProductVerified ?? knownGood;
  const previous = options.previous;
  const releaseKind = options.releaseKind ?? "live";
  const recovery = releaseKind === "live" ? { releaseId: "9".repeat(64), manifestSha256: "8".repeat(64), artifactId: 455, artifactDigest: `sha256:${"7".repeat(64)}` } : null;
  return publicationDeploymentReceiptSchema.parse({
    receiptVersion: "lionlog.pages-deployment-receipt.v3",
    recordedAt: "2026-09-07T11:00:00.000Z",
    operation: options.operation ?? "promote",
    releaseId: options.releaseId,
    releaseKind,
    deploymentId: options.deploymentId,
    pageUrl: knownGood ? "https://crunchybrunch.github.io/lionlog/" : null,
    previous: previous ? {
      knownGoodReleaseId: previous.releaseId,
      knownGoodRepositoryDeploymentId: previous.repositoryDeployment.id,
      knownGoodPagesDeploymentId: previous.deploymentId,
    } : {
      knownGoodReleaseId: "NONE_FIRST_DEPLOYMENT",
      knownGoodRepositoryDeploymentId: "NONE_FIRST_DEPLOYMENT",
      knownGoodPagesDeploymentId: "NONE_FIRST_DEPLOYMENT",
    },
    promotion: { workflowId: 347_992_874, workflowSha: sourceSha, runId: options.repositoryDeploymentId + 1_000, runAttempt: 1, approvalExpiresAt: "2026-09-07T13:00:00.000Z" },
    source: {
      artifactId: options.sourceArtifactId,
      artifactDigest: options.sourceArtifactDigest ?? artifactDigest,
      manifestSha256: options.sourceManifestSha256 ?? "d".repeat(64),
      siteTarSha256: "c".repeat(64),
      recoveryArtifactId: recovery?.artifactId ?? null,
      recoveryArtifactDigest: recovery?.artifactDigest ?? null,
      recoveryManifestSha256: recovery?.manifestSha256 ?? null,
    },
    recovery,
    staged: { artifactId: 789, artifactDigest: `sha256:${"e".repeat(64)}`, artifactExpiresAt: "2026-12-01T00:00:00.000Z" },
    attemptPhase: options.attemptPhase ?? "terminal",
    repositoryDeployment: { id: options.repositoryDeploymentId, state: repositoryState, statusRecorded },
    pagesAccepted: options.deploymentId !== null,
    pagesStatus: options.deploymentId === null ? null : (options.pagesStatus ?? "succeed"),
    markerVerified: true,
    publicProductVerified,
    reconciliation: { outcome: knownGood ? "known-good" : options.uncertain ? "submission-uncertain" : "served-unverified", publicReleaseId: options.releaseId },
    knownGood,
    uncertain: options.uncertain ?? !statusRecorded,
  });
}

function failedPreSubmissionReceipt(): PublicationDeploymentReceipt {
  return publicationDeploymentReceiptSchema.parse({
    receiptVersion: "lionlog.pages-deployment-receipt.v3",
    recordedAt: "2026-09-11T14:18:57Z",
    operation: "promote",
    releaseId: "7dce94463a4d87541812eda2d500baefead34e4a5394f82d95baa10163d1cec1",
    releaseKind: "live",
    deploymentId: null,
    pageUrl: null,
    previous: {
      knownGoodReleaseId: "NONE_FIRST_DEPLOYMENT",
      knownGoodRepositoryDeploymentId: "NONE_FIRST_DEPLOYMENT",
      knownGoodPagesDeploymentId: "NONE_FIRST_DEPLOYMENT",
    },
    promotion: {
      workflowId: 347_992_874,
      workflowSha: "3d5181c962486aa25345f4f16fbdd75932e0d831",
      runId: 34_609_219_734,
      runAttempt: 1,
      approvalExpiresAt: "2026-09-11T16:00:00Z",
    },
    source: {
      artifactId: 10_266_588_499,
      artifactDigest: "sha256:8667efc4e8b7603ec034d60715b4359d8c737b6aedfef2ff29a926b4ba0c30e2",
      manifestSha256: "99858cf98e0330aa2018460051154c5245404a8efdd9e001780d8b7634fbcd4c",
      siteTarSha256: "6d798e96e932ecb5b51cb22fd158bc370dd4e786de2f67e72b16fa4667ab752a",
      recoveryArtifactId: 10_267_140_347,
      recoveryArtifactDigest: "sha256:83a47e669a5542ab86496c20ce39931b0a07b3d261d8fbed0dbbed81a503c5dd",
      recoveryManifestSha256: "eecf7e52423789cd16a1b1a7bb44ffd97fff2c4acca6818cf6928455e8fdcd0e",
    },
    recovery: {
      releaseId: "0c39c8f56df6d0d9b72ff644fd7d7fb98c78af28f4f5e700ec6f639340d53d95",
      manifestSha256: "eecf7e52423789cd16a1b1a7bb44ffd97fff2c4acca6818cf6928455e8fdcd0e",
      artifactId: 10_267_140_347,
      artifactDigest: "sha256:83a47e669a5542ab86496c20ce39931b0a07b3d261d8fbed0dbbed81a503c5dd",
    },
    staged: {
      artifactId: 10_267_282_434,
      artifactDigest: "sha256:bc6a29288377cfb9f46a238a9094185e9fb095077d63addde162402991e80ae0",
      artifactExpiresAt: "2026-12-10T14:17:12Z",
    },
    attemptPhase: "submission-uncertain",
    repositoryDeployment: { id: null, state: "unknown", statusRecorded: false },
    pagesAccepted: false,
    pagesStatus: "ledger-unavailable",
    markerVerified: false,
    publicProductVerified: false,
    reconciliation: { outcome: "submission-uncertain", publicReleaseId: "UNKNOWN" },
    knownGood: false,
    uncertain: true,
  });
}

function failedPreSubmissionApiFixture({
  newerEnvironmentDeployment = false,
  currentPromotion = false,
  duplicateCurrent = false,
  tamperReceiptArtifact = false,
  tamperSubmissionStep = false,
  currentStatus = "in_progress",
  incompleteCurrentJobs = false,
} = {}) {
  const workflowSha = "3d5181c962486aa25345f4f16fbdd75932e0d831";
  const matchingDeployment = {
    id: 6_394_978_446,
    task: "deploy",
    environment: "github-pages",
    sha: workflowSha,
    ref: "main",
    payload: {},
    original_environment: "github-pages",
    transient_environment: false,
    production_environment: false,
    performed_via_github_app: { id: 15_368, slug: "github-actions" },
  };
  const currentDeployment = { ...matchingDeployment, id: matchingDeployment.id + 100, sha: "f".repeat(40) };
  const environmentDeployments = currentPromotion
    ? [currentDeployment, ...(duplicateCurrent ? [{ ...currentDeployment, id: currentDeployment.id + 1 }] : []), matchingDeployment]
    : newerEnvironmentDeployment
      ? [{ ...matchingDeployment, id: matchingDeployment.id + 1, sha: "0".repeat(40) }, matchingDeployment]
      : [matchingDeployment];
  return async (input: URL | RequestInfo): Promise<Response> => {
    const url = String(input);
    if (url.includes("crunchybrunch.github.io/lionlog/release.json")) return new Response(null, { status: 404 });
    if (url.includes("deployments?task=lionlog-pages-release")) return Response.json([]);
    if (url.includes("deployments?task=deploy")) return Response.json(environmentDeployments);
    if (url.endsWith("/actions/artifacts/10267367634")) return Response.json({
      id: 10_267_367_634,
      name: "lionlog-deployment-receipt-34609219734-1",
      digest: tamperReceiptArtifact ? `sha256:${"0".repeat(64)}` : "sha256:bf3c1430abf5bf1ebc8707e601b51f3776705cde507997ff3b606fcc88601874",
      expired: false,
      workflow_run: { id: 34_609_219_734, head_sha: workflowSha, head_branch: "main", head_repository_id: 1_346_360_244 },
    });
    if (url.endsWith("/actions/runs/34609219734")) return Response.json({
      id: 34_609_219_734,
      workflow_id: 347_992_874,
      path: ".github/workflows/deploy-github-pages.yml",
      event: "workflow_dispatch",
      head_sha: workflowSha,
      head_branch: "main",
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
    });
    if (url.endsWith("/deployments/6394978446")) return Response.json(matchingDeployment);
    if (url.includes("/deployments/6394978446/statuses?")) return Response.json([{
      id: 18_228_833_381,
      state: "failure",
      environment: "github-pages",
      deployment_url: "https://api.github.com/repos/CrunchyBrunch/lionlog/deployments/6394978446",
      log_url: "https://github.com/CrunchyBrunch/lionlog/actions/runs/34609219734/job/103295384726",
      target_url: "https://github.com/CrunchyBrunch/lionlog/actions/runs/34609219734/job/103295384726",
    }]);
    if (url.endsWith("/actions/jobs/103295384726")) return Response.json({
      id: 103_295_384_726,
      name: "deploy",
      workflow_name: "Promote exact LionLog release to GitHub Pages",
      run_id: 34_609_219_734,
      run_attempt: 1,
      head_sha: workflowSha,
      status: "completed",
      conclusion: "failure",
      steps: reviewedIncidentSteps(tamperSubmissionStep),
    });
    if (currentPromotion && url.endsWith("/actions/runs/999000")) return Response.json({
      id: 999_000,
      workflow_id: 347_992_874,
      path: ".github/workflows/deploy-github-pages.yml",
      event: "workflow_dispatch",
      head_sha: "f".repeat(40),
      head_branch: "main",
      run_attempt: 1,
      status: "in_progress",
      conclusion: null,
    });
    if (currentPromotion && url.includes("/actions/runs/999000/jobs?")) return Response.json({
      total_count: incompleteCurrentJobs ? 3 : 2,
      jobs: [
        { id: 555_000, name: "verify-and-stage", run_id: 999_000, run_attempt: 1, head_sha: "f".repeat(40), status: "completed", conclusion: "success" },
        { id: 555_001, name: "deploy", run_id: 999_000, run_attempt: 1, head_sha: "f".repeat(40), status: "in_progress", conclusion: null },
      ],
    });
    if (currentPromotion && url.includes(`/deployments/${currentDeployment.id}/statuses?`)) return Response.json([{
      id: 18_300_000_001,
      state: currentStatus,
      environment: "github-pages",
      deployment_url: `https://api.github.com/repos/CrunchyBrunch/lionlog/deployments/${currentDeployment.id}`,
      log_url: "https://github.com/CrunchyBrunch/lionlog/actions/runs/999000/job/555001",
      target_url: "https://github.com/CrunchyBrunch/lionlog/actions/runs/999000/job/555001",
    }]);
    if (currentPromotion && url.endsWith(`/deployments/${currentDeployment.id}`)) return Response.json(currentDeployment);
    return new Response(null, { status: 404 });
  };
}

function reviewedIncidentSteps(tamperSubmissionStep = false) {
  const steps = [
    [1, "Set up job", "success"],
    [2, "Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "success"],
    [3, "Re-download the exact retained approval summary", "success"],
    [4, "Download exact source and recovery wrappers after protected approval", "success"],
    [5, "Re-download and identify the exact staged artifact", "success"],
    [6, "Re-download current-attempt and rollback-target receipts after approval", "success"],
    [7, "Perform final provenance, state, deadline, and freshness checks", "failure"],
    [8, "Deploy exact staged artifact", "skipped"],
    [9, "Preserve deployment attempt evidence", "skipped"],
    [18, "Post Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "success"],
    [19, "Complete job", "success"],
  ].map(([number, name, conclusion]) => ({ number, name, status: "completed", conclusion }));
  if (tamperSubmissionStep) steps[7] = { ...steps[7], conclusion: "success" };
  return steps;
}

function deploymentApiFixture(
  state: { publicReleaseId: string; receipts?: PublicationDeploymentReceipt[]; deployments?: unknown[] },
  requested: string[] = [],
) {
  const receipts = state.receipts ?? [];
  const deployments = state.deployments ?? receipts.map(repositoryDeploymentForReceipt);
  return async (input: URL | RequestInfo): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    if (url.includes("crunchybrunch.github.io/lionlog/release.json")) {
      return state.publicReleaseId === "NONE_404" ? new Response(null, { status: 404 }) : Response.json({ releaseId: state.publicReleaseId });
    }
    if (/\/deployments\?task=/.test(url)) return Response.json(deployments);
    const statusMatch = /\/deployments\/(\d+)\/statuses\?/.exec(url);
    if (statusMatch) {
      const receipt = receipts.find((value) => value.repositoryDeployment.id === Number(statusMatch[1]));
      if (!receipt) return new Response(null, { status: 404 });
      if (!receipt.repositoryDeployment.statusRecorded) return Response.json([]);
      return Response.json([{
        state: receipt.repositoryDeployment.state,
        deployment_url: `https://api.github.com/repos/CrunchyBrunch/lionlog/deployments/${receipt.repositoryDeployment.id}`,
        log_url: receipt.deploymentId === null
          ? `https://github.com/CrunchyBrunch/lionlog/actions/runs/${receipt.promotion.runId}`
          : `https://api.github.com/repos/CrunchyBrunch/lionlog/pages/deployments/${receipt.deploymentId}`,
      }]);
    }
    const repositoryMatch = /\/deployments\/(\d+)$/.exec(url);
    if (repositoryMatch) {
      const receipt = receipts.find((value) => value.repositoryDeployment.id === Number(repositoryMatch[1]));
      return receipt ? Response.json(repositoryDeploymentForReceipt(receipt)) : new Response(null, { status: 404 });
    }
    const pagesMatch = /\/pages\/deployments\/([A-Za-z0-9._-]+)$/.exec(url);
    if (pagesMatch) {
      const receipt = receipts.find((value) => value.deploymentId === pagesMatch[1]);
      return receipt ? Response.json({ id: receipt.deploymentId, status: receipt.pagesStatus }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  };
}

function repositoryDeploymentForReceipt(receipt: PublicationDeploymentReceipt) {
  return {
    id: receipt.repositoryDeployment.id,
    sha: receipt.promotion.workflowSha,
    task: "lionlog-pages-release",
    environment: "github-pages",
    transient_environment: false,
    production_environment: true,
    payload: publicationLedgerPayload({
      promotionRunId: receipt.promotion.runId,
      runAttempt: receipt.promotion.runAttempt,
      releaseId: receipt.releaseId,
      sourceArtifactId: receipt.source.artifactId,
      stagedArtifactId: receipt.staged.artifactId,
    }),
  };
}

function createStoredZip(entries: Array<{ path: string; data: Buffer; mode?: number }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const crc = testCrc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + entry.data.byteLength;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

function testCrc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
