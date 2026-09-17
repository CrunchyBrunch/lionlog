import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArtifactZip } from "../scripts/artifact-zip.ts";
import { createPublicationTar } from "../scripts/publication-tar.ts";
import { createPublicationBundle, sha256 } from "../scripts/create-publication-bundle.ts";
import { getPsuHall, getPsuMealPeriod, PSU_PARSER_VERSION, PSU_SNAPSHOT_VERSION, sourceDateFromIso } from "../infrastructure/psu/constants.ts";
import { catalogEntryForSnapshot, PSU_CATALOG_VERSION, validatePsuPublicationCatalog } from "../infrastructure/psu/publication-catalog.ts";
import { PSU_RELEASE_HALL_IDS } from "../infrastructure/psu/release-plan.ts";
import { buildPsuSnapshot } from "../infrastructure/psu/snapshot-schema.ts";
import {
  createPreapprovalSummary,
  inspectPagesActionTar,
  verifySupportedCandidate,
  type GithubArtifact,
  type ValidatedRelease,
} from "../scripts/supported-pages-release.ts";
import { createFlatReceipt, verifyFinalState, type PreapprovalSummary } from "../scripts/supported-pages-control.ts";
import { assertNoBrowserDiagnostics, assertPageState } from "../scripts/verify-public-pwa.mjs";

const workflowSha = "a".repeat(40);
const sourceSha = "b".repeat(40);
const hash = "c".repeat(64);
const digest = `sha256:${"d".repeat(64)}`;
const now = new Date("2026-09-17T12:00:00.000Z");

test("artifact ZIP parser rejects traversal, symlinks, extras, and header disagreement", () => {
  const valid = createStoredZip([{ path: "artifact.tar", data: Buffer.from("tar") }]);
  assert.equal(parseArtifactZip(valid, ["artifact.tar"])[0].data.toString(), "tar");
  assert.throws(() => parseArtifactZip(createStoredZip([{ path: "../artifact.tar", data: Buffer.from("tar") }]), ["artifact.tar"]), /Unsafe artifact ZIP/);
  assert.throws(() => parseArtifactZip(createStoredZip([{ path: "artifact.tar", data: Buffer.from("tar"), mode: 0o120777 }]), ["artifact.tar"]), /regular files/);
  assert.throws(() => parseArtifactZip(createStoredZip([
    { path: "artifact.tar", data: Buffer.from("tar") },
    { path: "extra", data: Buffer.from("no") },
  ]), ["artifact.tar"]), /file set/);
  const tampered = Buffer.from(valid);
  tampered.writeUInt32LE(99, 18);
  assert.throws(() => parseArtifactZip(tampered, ["artifact.tar"]), /disagree|bounds|overlap/);
});

test("official Pages tar inspection preserves exact paths, sizes, hashes, and hidden marker", () => {
  const tar = createPublicationTar([
    { path: ".nojekyll", data: Buffer.alloc(0) },
    { path: "index.html", data: Buffer.from("index") },
    { path: "menu-data/v2/catalog.json", data: Buffer.from("{}") },
  ]);
  assert.deepEqual(inspectPagesActionTar(tar).map(({ path: entryPath, bytes }) => ({ path: entryPath, bytes })), [
    { path: ".nojekyll", bytes: 0 },
    { path: "index.html", bytes: 5 },
    { path: "menu-data/v2/catalog.json", bytes: 2 },
  ]);
  const linked = Buffer.from(tar);
  linked[156] = "2".charCodeAt(0);
  rewriteTarChecksum(linked);
  assert.throws(() => inspectPagesActionTar(linked), /prohibited entry type/);
  const trailing = Buffer.concat([tar, Buffer.alloc(512)]);
  trailing[trailing.length - 1] = 1;
  assert.throws(() => inspectPagesActionTar(trailing), /data after its terminator/);
});

test("staged Pages artifact must have unique run identity and exact candidate inventory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-stage-"));
  const tarPath = path.join(root, "artifact.tar");
  const tar = createPublicationTar([
    { path: ".nojekyll", data: Buffer.alloc(0) },
    { path: "index.html", data: Buffer.from("index") },
  ]);
  await writeFile(tarPath, tar);
  const validated = validatedFixture(inspectPagesActionTar(tar));
  const artifact = stagedArtifact();
  const result = await createPreapprovalSummary({ validated, stagedArtifact: artifact, stagedArtifactName: artifact.name, stagedTarPath: tarPath });
  assert.equal(result.summaryVersion, "lionlog.pages-preapproval.v1");
  await assert.rejects(createPreapprovalSummary({
    validated,
    stagedArtifact: { ...artifact, name: "github-pages" },
    stagedArtifactName: "github-pages",
    stagedTarPath: tarPath,
  }), /not unique/);
  const changed = createPublicationTar([{ path: "index.html", data: Buffer.from("changed") }]);
  await writeFile(tarPath, changed);
  await assert.rejects(createPreapprovalSummary({ validated, stagedArtifact: artifact, stagedArtifactName: artifact.name, stagedTarPath: tarPath }), /inventory differs/);
});

test("candidate verification fails closed before touching untrusted bytes when GitHub authority differs", async () => {
  await assert.rejects(verifySupportedCandidate({
    operation: "promote",
    bundleDirectory: "missing",
    extractionDirectory: "missing-output",
    metadata: {
      repository: { id: 1, full_name: "fork/lionlog" },
      main: { sha: workflowSha },
      workflowRun: currentWorkflowRun(),
      candidateRun: candidateRun(),
      candidateArtifact: candidateArtifact(),
      ciRun: ciRun(),
      ciJobs: [{ name: "verify", head_sha: sourceSha, status: "completed", conclusion: "success" }],
    },
    workflowSha,
    workflowRunId: 100,
    candidateRunId: 200,
    candidateArtifactId: 300,
    candidateArtifactDigest: digest,
    candidateManifestSha256: hash,
    expectedReleaseId: hash,
    expectedSourceSha: sourceSha,
    expectedServiceDate: "2026-09-17",
    now,
  }), /Repository identity mismatch/);
});

test("supported candidate verifier accepts a complete frozen live bundle and exact provenance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-supported-candidate-"));
  const recoverySite = path.join(root, "recovery-site");
  const recoveryBundle = path.join(root, "recovery-bundle");
  await writeShellSite(recoverySite);
  await createPublicationBundle({
    site: recoverySite, output: recoveryBundle, releaseKind: "first-release-recovery",
    commitSha: sourceSha, runId: 200, runAttempt: 1, createdAt: "2026-09-17T11:50:00.000Z",
  });
  const liveSite = path.join(root, "live-site");
  const liveBundle = path.join(root, "live-bundle");
  await writeLiveSite(liveSite);
  const manifest = await createPublicationBundle({
    site: liveSite, output: liveBundle, releaseKind: "live", commitSha: sourceSha, runId: 200, runAttempt: 1,
    createdAt: "2026-09-17T11:55:00.000Z", recoveryManifest: path.join(recoveryBundle, "release-manifest.json"),
    recoveryArtifactId: 299, recoveryArtifactDigest: `sha256:${"9".repeat(64)}`,
  });
  const manifestSha256 = sha256(await readFile(path.join(liveBundle, "release-manifest.json")));
  const validated = await verifySupportedCandidate({
    operation: "promote", bundleDirectory: liveBundle, extractionDirectory: path.join(root, "site-extracted"),
    metadata: {
      repository: { id: 1_346_360_244, full_name: "CrunchyBrunch/lionlog" }, main: { sha: workflowSha },
      workflowRun: currentWorkflowRun(), candidateRun: candidateRun(), candidateArtifact: candidateArtifact(), ciRun: ciRun(),
      ciJobs: [{ name: "verify", head_sha: sourceSha, status: "completed", conclusion: "success" }],
    },
    workflowSha, workflowRunId: 100, candidateRunId: 200, candidateArtifactId: 300, candidateArtifactDigest: digest,
    candidateManifestSha256: manifestSha256, expectedReleaseId: manifest.releaseId, expectedSourceSha: sourceSha,
    expectedServiceDate: "2026-09-17", now,
  });
  assert.equal(validated.release.coverage, "complete");
  assert.equal(validated.site.inventory.length > 5, true);
});

test("protected final check rejects main drift, artifact drift, expiration, and unresolved prior submissions", () => {
  const summary = summaryFixture();
  const emptyHistory = { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] };
  assert.equal(verifyFinalState({ summary, state: finalState(), incidents: emptyHistory, now }).release.id, hash);
  assert.throws(() => verifyFinalState({ summary, state: { ...finalState(), main: { sha: "f".repeat(40) } }, incidents: emptyHistory, now }), /main drifted/);
  assert.throws(() => verifyFinalState({
    summary,
    state: { ...finalState(), stagedArtifacts: [{ ...finalState().stagedArtifacts[0], digest: `sha256:${"e".repeat(64)}` }] },
    incidents: emptyHistory,
    now,
  }), /Staged Pages artifact/);
  assert.throws(() => verifyFinalState({
    summary: { ...summary, release: { ...summary.release, earliestRetainUntil: "2026-09-17T11:59:00.000Z" } },
    state: finalState(), incidents: emptyHistory, now,
  }), /retention elapsed/);
  const unresolved = { runId: 99, workflowSha, runAttempt: 1, conclusion: "failure", officialStepConclusion: "failure" };
  assert.throws(() => verifyFinalState({ summary, state: { ...finalState(), priorRuns: [unresolved] }, incidents: emptyHistory, now }), /remains unresolved/);
  assert.doesNotThrow(() => verifyFinalState({
    summary,
    state: { ...finalState(), priorRuns: [unresolved] },
    incidents: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [{
      runId: 99, workflowSha, candidateArtifactId: 1, stagedArtifactId: 2, repositoryDeploymentId: 3,
      outcome: "resolved-unknown-no-publication", publicReleaseId: "NONE_404", checkedAt: "2026-09-17T11:00:00.000Z",
      note: "Reviewed fixture incident with no publication.",
    }] },
    now,
  }));
});

test("flat receipt becomes known-good only after official success and all public checks", () => {
  const good = createFlatReceipt({
    summary: summaryFixture(),
    recordedAt: now.toISOString(),
    official: { submissionStarted: true, result: "success", pageUrl: "https://crunchybrunch.github.io/lionlog/", deploymentId: null },
    publicChecks: { markerVerified: true, inventoryVerified: true, browserVerified: true },
  });
  assert.equal(good.knownGood, true);
  assert.equal(good.unresolved, false);
  const failed = createFlatReceipt({
    summary: summaryFixture(),
    recordedAt: now.toISOString(),
    official: { submissionStarted: true, result: "failure", pageUrl: null, deploymentId: null },
    publicChecks: { markerVerified: false, inventoryVerified: false, browserVerified: false },
  });
  assert.equal(failed.knownGood, false);
  assert.equal(failed.unresolved, true);
});

test("mobile PWA verifier requires attribution, no overflow, and zero warnings/errors", () => {
  const page = {
    url: "https://crunchybrunch.github.io/lionlog/",
    title: "Build a meal | LionLog",
    text: "LionLog Retrieved one minute ago. LionLog is independent and is not affiliated with or endorsed by Penn State.",
    scrollWidth: 390,
    clientWidth: 390,
  };
  assert.doesNotThrow(() => assertPageState(page));
  assert.throws(() => assertPageState({ ...page, scrollWidth: 391 }), /overflows/);
  assert.throws(() => assertPageState({ ...page, text: "LionLog" }), /retrieval time/);
  assert.doesNotThrow(() => assertNoBrowserDiagnostics([{ kind: "console", type: "log" }]));
  assert.throws(() => assertNoBrowserDiagnostics([{ kind: "console", type: "warning" }]), /diagnostics/);
});

function validatedFixture(inventory: Array<{ path: string; bytes: number; sha256: string }>): ValidatedRelease {
  return {
    summaryVersion: "lionlog.pages-validated-release.v1",
    operation: "promote",
    workflow: { sha: workflowSha, runId: 100, runAttempt: 1 },
    candidate: {
      runId: 200, sourceSha, artifactId: 300, artifactName: "lionlog-live-fixture", artifactDigest: digest,
      artifactExpiresAt: "2026-12-01T00:00:00.000Z", manifestSha256: hash,
    },
    ci: { runId: 400 },
    release: {
      id: hash, kind: "live", serviceDate: "2026-09-17", coverage: "complete", omissions: { "invalid-name": 0 },
      earliestFreshUntil: "2026-09-17T14:00:00.000Z", earliestRetainUntil: "2026-09-24T00:00:00.000Z",
    },
    site: { tarFile: "site.tar", tarSha256: hash, bytes: 1, inventory },
    rollbackReceipt: null,
  };
}

function summaryFixture(): PreapprovalSummary {
  return {
    ...validatedFixture([{ path: "index.html", bytes: 5, sha256: hash }]),
    summaryVersion: "lionlog.pages-preapproval.v1",
    staged: {
      artifactId: 500, artifactName: "lionlog-pages-100-1", artifactDigest: digest,
      artifactExpiresAt: "2026-12-01T00:00:00.000Z", tarSha256: hash,
    },
  };
}

function stagedArtifact(): GithubArtifact {
  return {
    id: 500, name: "lionlog-pages-100-1", digest, size_in_bytes: 100, expired: false,
    expires_at: "2026-12-01T00:00:00.000Z",
    workflow_run: { id: 100, head_sha: workflowSha, head_branch: "main", head_repository_id: 1_346_360_244 },
  };
}

function finalState() {
  return {
    repository: { id: 1_346_360_244, full_name: "CrunchyBrunch/lionlog" },
    main: { sha: workflowSha },
    workflowRun: currentWorkflowRun(),
    candidateRun: candidateRun(),
    candidateArtifact: { id: 300, digest, expired: false, expires_at: "2026-12-01T00:00:00.000Z" },
    stagedArtifacts: [{ id: 500, name: "lionlog-pages-100-1", digest, expired: false, expires_at: "2026-12-01T00:00:00.000Z" }],
    ciRun: ciRun(),
    priorRuns: [],
    rollbackReceiptArtifact: null,
    rollbackReceiptRun: null,
  };
}

function currentWorkflowRun() {
  return { id: 100, workflow_id: 347_992_874, path: ".github/workflows/deploy-github-pages.yml", event: "workflow_dispatch", head_sha: workflowSha, head_branch: "main", run_attempt: 1, status: "in_progress", conclusion: null } as const;
}

function candidateRun() {
  return { id: 200, workflow_id: 347_085_467, path: ".github/workflows/build-live-menu-artifact.yml", event: "workflow_dispatch", head_sha: sourceSha, head_branch: "main", run_attempt: 1, status: "completed", conclusion: "success" } as const;
}

function ciRun() {
  return { id: 400, workflow_id: 346_680_782, path: ".github/workflows/ci.yml", event: "push", head_sha: sourceSha, head_branch: "main", run_attempt: 1, status: "completed", conclusion: "success" } as const;
}

function candidateArtifact(): GithubArtifact {
  return { id: 300, name: "lionlog-live-fixture", digest, size_in_bytes: 100, expired: false, expires_at: "2026-12-01T00:00:00.000Z", workflow_run: { id: 200, head_sha: sourceSha, head_branch: "main", head_repository_id: 1_346_360_244 } };
}

function rewriteTarChecksum(archive: Buffer): void {
  archive.fill(0x20, 148, 156);
  const checksum = archive.subarray(0, 512).reduce((sum, value) => sum + value, 0);
  archive.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  archive[154] = 0;
  archive[155] = 0x20;
}

async function writeShellSite(root: string): Promise<void> {
  await mkdir(path.join(root, "_next", "static"), { recursive: true });
  await mkdir(path.join(root, "icons"), { recursive: true });
  await writeFile(path.join(root, ".nojekyll"), "\n");
  await writeFile(path.join(root, "index.html"), `<html data-lionlog-shell="${sourceSha}"><link href="/lionlog/_next/static/app.js"><link href="./manifest.webmanifest"></html>`);
  await writeFile(path.join(root, "_next", "static", "app.js"), "console.log('shell');");
  await writeFile(path.join(root, "icons", "icon-192.png"), "icon");
  await writeFile(path.join(root, "manifest.webmanifest"), JSON.stringify({ id: "./", start_url: "./", scope: "./", icons: [{ src: "./icons/icon-192.png" }] }));
  await writeFile(path.join(root, "sw.js"), `const SHELL_REVISION = "${sourceSha}"; const CACHE='lionlog-shell-${sourceSha}'; const EXCLUDED='menu-data';`);
}

async function writeLiveSite(root: string): Promise<void> {
  await writeShellSite(root);
  const retrievedAt = new Date("2026-09-17T11:20:00.000Z");
  const cachedAt = new Date("2026-09-17T11:30:00.000Z");
  const snapshots = PSU_RELEASE_HALL_IDS.map((hallId) => {
    const hall = getPsuHall(hallId);
    const period = getPsuMealPeriod("lunch");
    return buildPsuSnapshot(
      { serviceDate: "2026-09-17", hallId, mealPeriodId: period.id, venueIds: [] },
      { context: { sourceCampusId: hall.sourceCampusId, sourceDate: sourceDateFromIso("2026-09-17"), sourceMeal: period.sourceValue }, stations: [], empty: true },
      new Map(),
      { retrievedAt, cachedAt, freshForMs: 18 * 60 * 60_000, retainForMs: 48 * 60 * 60_000 },
    );
  });
  const catalog = validatePsuPublicationCatalog({
    catalogVersion: PSU_CATALOG_VERSION, snapshotSchemaVersion: PSU_SNAPSHOT_VERSION, parserVersion: PSU_PARSER_VERSION,
    generatedAt: cachedAt.toISOString(),
    publication: {
      mode: "field-release", sourceKind: "psu-public-menu-html", commitSha: sourceSha, serviceDate: "2026-09-17",
      hallIds: [...PSU_RELEASE_HALL_IDS], retrievalStartedAt: "2026-09-17T11:00:00.000Z", retrievalCompletedAt: cachedAt.toISOString(),
      expectedSnapshotCount: 5, publishedSnapshotCount: 5, recognizedEmptySnapshotCount: 5, itemCount: 0,
      coverage: "complete", sourceObservationCount: 0, publishedObservationCount: 0, omissions: { "invalid-name": 0 },
      requestCount: 10, nutritionRequests: 0, nutritionCacheHits: 0,
    },
    serviceDates: ["2026-09-17"],
    halls: PSU_RELEASE_HALL_IDS.map((id) => ({ id, displayName: getPsuHall(id).displayName })),
    mealPeriods: [{ id: "lunch", displayName: getPsuMealPeriod("lunch").displayName }],
    snapshots: snapshots.map((snapshot) => catalogEntryForSnapshot(snapshot, `./snapshots/${snapshot.query.serviceDate}/${snapshot.query.sourceCampusId}/lunch.json`)),
  });
  for (const snapshot of snapshots) {
    const file = path.join(root, "menu-data", "v2", "snapshots", snapshot.query.serviceDate, snapshot.query.sourceCampusId, "lunch.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  await mkdir(path.join(root, "menu-data", "v2"), { recursive: true });
  await writeFile(path.join(root, "menu-data", "v2", "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
}

function createStoredZip(entries: Array<{ path: string; data: Buffer; mode?: number }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(entry.data.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
