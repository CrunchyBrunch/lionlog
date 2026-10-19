import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { scheduledOpportunity, runDailyPublication, type DailyApi } from "../scripts/run-daily-publication.ts";
import { assertStandingPublicationPolicy, STANDING_PUBLICATION_POLICY } from "../scripts/supported-pages-release.ts";
import { loadPublicationCheckpoint } from "../scripts/publication-checkpoint.ts";
import { computePublicationReleaseId } from "../scripts/create-publication-bundle.ts";
import { LIVE_CANDIDATE_WORKFLOW_ID, PROMOTION_WORKFLOW_ID, PUBLICATION_RECEIPT_VERSION } from "../infrastructure/publication/release-contract.ts";

const sha = "a".repeat(40);
const config = { activation: "ENABLE_AUTOMATIC_LIONLOG_REFRESH",
  sourceAuthorization: "I_APPROVE_AUTOMATIC_PSU_REQUESTS", productionRef: "refs/heads/production",
  productionSha: sha };
const fixed = { token: "fixture-token", repository: "CrunchyBrunch/lionlog", event: "schedule",
  workflowRef: "CrunchyBrunch/lionlog/.github/workflows/daily-publication.yml@refs/heads/main",
  attempt: 1, schedulerRunId: 9, schedulerSha: "b".repeat(40), configuration: config,
  standingPolicy: STANDING_PUBLICATION_POLICY, writerId: 42 };
const scheduleRun = { id: 9, path: ".github/workflows/daily-publication.yml", event: "schedule",
  run_attempt: 1, head_branch: "main", head_sha: "b".repeat(40), status: "in_progress",
  created_at: "2026-10-19T09:17:00Z" };

test("native New York schedule handles EST, EDT, spring transition, and the missed-primary window", () => {
  assert.deepEqual(scheduledOpportunity(new Date("2026-01-15T10:17:00Z")), { serviceDate: "2026-01-15", mode: "primary" });
  assert.deepEqual(scheduledOpportunity(new Date("2026-07-15T09:17:00Z")), { serviceDate: "2026-07-15", mode: "primary" });
  assert.deepEqual(scheduledOpportunity(new Date("2026-03-08T09:55:00Z")), { serviceDate: "2026-03-08", mode: "recovery" });
  assert.throws(() => scheduledOpportunity(new Date("2026-07-15T09:16:00Z")), /outside/);
  assert.throws(() => scheduledOpportunity(new Date("2026-07-15T14:00:00Z")), /outside/);
});

test("standing publication policy rejects partial coverage, omissions, rollback, and missing authority", () => {
  const accepted = { policy: STANDING_PUBLICATION_POLICY, operation: "promote", coverage: "complete", invalidNameOmissions: 0 };
  assert.doesNotThrow(() => assertStandingPublicationPolicy(accepted));
  for (const change of [{ coverage: "partial" }, { invalidNameOmissions: 1 },
    { operation: "rollback" }, { policy: undefined }]) {
    assert.throws(() => assertStandingPublicationPolicy({ ...accepted, ...change }), /standing policy/);
  }
});

test("scheduler rejects inactive or changed authority before a GitHub read or dispatch", async () => {
  let requests = 0;
  const api: DailyApi = { get: async () => { requests += 1; throw new Error("unexpected"); },
    bytes: async () => { requests += 1; throw new Error("unexpected"); },
    dispatch: async () => { requests += 1; throw new Error("unexpected"); } };
  const now = new Date("2026-10-19T09:17:00Z");
  for (const change of [{ standingPolicy: "" }, { event: "workflow_dispatch" }, { attempt: 2 },
    { workflowRef: "CrunchyBrunch/lionlog/.github/workflows/daily-publication.yml@refs/heads/feature" },
    { configuration: { ...config, productionSha: "b" } }]) {
    await assert.rejects(runDailyPublication({ ...fixed, ...change, api, now }), /inactive|invalid/);
  }
  assert.equal(requests, 0);
});

test("a queued schedule from the previous service day cannot request today's menus", async () => {
  let dispatches = 0;
  const api: DailyApi = { get: async () => ({ ...scheduleRun, created_at: "2026-10-18T09:17:00Z" }),
    bytes: async () => Buffer.alloc(0), dispatch: async () => { dispatches += 1; return 1; } };
  await assert.rejects(runDailyPublication({ ...fixed, api, now: new Date("2026-10-19T09:17:00Z") }), /crossed/);
  assert.equal(dispatches, 0);
});

test("missing bootstrap or public predecessor stops before any PSU candidate dispatch", async () => {
  let dispatches = 0;
  const api: DailyApi = { get: async (route) => route.endsWith("/runs/9") ? scheduleRun : ({ ref: config.productionRef, object: { type: "commit", sha } }),
    bytes: async () => Buffer.alloc(0), dispatch: async () => { dispatches += 1; return 1; } };
  const now = new Date("2026-10-19T09:17:00Z");
  await assert.rejects(runDailyPublication({ ...fixed, api, now,
    loadCheckpoint: async () => { throw new Error("bootstrap absent"); } }), /bootstrap absent/);
  assert.equal(dispatches, 0);
  await assert.rejects(runDailyPublication({ ...fixed, api, now,
    loadCheckpoint: async () => ({ checkpoint: { publication: { releaseId: "c".repeat(64) } } }) as unknown as Awaited<ReturnType<typeof loadPublicationCheckpoint>>,
    observePublic: async () => ({ state: "absent", releaseId: null }) }), /predecessor/);
  assert.equal(dispatches, 0);
});

test("candidate failure or interruption prevents promotion and checkpoint dispatch", async () => {
  const dispatched: string[] = [];
  const api: DailyApi = {
    get: async (route) => route.endsWith("/runs/9") ? scheduleRun : route.includes("/git/ref/")
      ? { ref: config.productionRef, object: { type: "commit", sha } }
      : { id: 100, path: ".github/workflows/build-live-menu-artifact.yml", workflow_id: 347085467,
        event: "workflow_dispatch", run_attempt: 1, head_sha: sha, head_branch: "production",
        status: "completed", conclusion: "failure" },
    bytes: async () => Buffer.alloc(0),
    dispatch: async (workflow) => { dispatched.push(workflow); return 100; },
  };
  await assert.rejects(runDailyPublication({ ...fixed, api, now: new Date("2026-10-19T09:17:00Z"),
    loadCheckpoint: async () => ({ checkpoint: { publication: { releaseId: "c".repeat(64) } } }) as unknown as Awaited<ReturnType<typeof loadPublicationCheckpoint>>,
    observePublic: async () => ({ state: "present", releaseId: "c".repeat(64) }) }), /ended failure/);
  assert.deepEqual(dispatched, [".github/workflows/build-live-menu-artifact.yml"]);
});

test("one complete scheduled sequence binds candidate, promotion, public verification, and checkpoint", async () => {
  const parsed = JSON.parse(await readFile(new URL("./fixtures/published-incident-parsed.json", import.meta.url), "utf8"));
  const manifest = parsed.manifest;
  manifest.source.commitSha = sha;
  manifest.source.workflowRunId = 100;
  manifest.shellRevision = sha;
  manifest.menu.serviceDate = "2026-10-19";
  manifest.menu.coverage = "complete";
  manifest.menu.omissions["invalid-name"] = 0;
  manifest.menu.earliestFreshUntil = "2026-10-20T18:00:00.000Z";
  manifest.menu.earliestRetainUntil = "2026-10-22T18:00:00.000Z";
  manifest.releaseId = computePublicationReleaseId({ releaseKind: manifest.releaseKind,
    sourceCommitSha: sha, workflowRunId: 100, workflowRunAttempt: 1,
    serviceDate: manifest.menu.serviceDate, catalogSha256: manifest.menu.catalogSha256,
    shellRevision: sha, recoveryReleaseId: manifest.recovery.releaseId });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestSha = hash(manifestBytes);
  const candidateZip = storedZip([{ name: "release-manifest.json", bytes: manifestBytes },
    { name: "site.tar", bytes: Buffer.from("fixture tar") }]);
  const candidateDigest = `sha256:${hash(candidateZip)}`;
  const receipt = {
    receiptVersion: PUBLICATION_RECEIPT_VERSION, recordedAt: "2026-10-19T09:20:00.000Z",
    repository: { id: 1346360244, name: "CrunchyBrunch/lionlog" },
    producer: { workflowPath: ".github/workflows/build-live-menu-artifact.yml",
      workflowId: LIVE_CANDIDATE_WORKFLOW_ID, runId: 100, runAttempt: 1, sourceCommitSha: sha },
    candidate: { releaseKind: "live", artifactId: 300,
      artifactName: `lionlog-live-2026-10-19-${sha}-100-1`, artifactDigest: candidateDigest,
      artifactBytes: candidateZip.length, artifactExpiresAt: "2026-12-30T00:00:00Z",
      manifestSha256: manifestSha, releaseId: manifest.releaseId },
  };
  const receiptZip = storedZip([{ name: "live.json", bytes: Buffer.from(JSON.stringify(receipt)) },
    { name: "first-release-recovery.json", bytes: Buffer.from("{}") }]);
  const dispatched: Array<{ workflow: string; inputs: Record<string, string> }> = [];
  let promotionFails = false;
  const run = (id: number, workflow: string, workflowId?: number) => ({ id, path: workflow,
    workflow_id: workflowId, event: "workflow_dispatch", run_attempt: 1, head_sha: sha,
    head_branch: "production", status: "completed", conclusion: "success" });
  const api: DailyApi = {
    get: async (route) => {
      if (route.endsWith("/runs/9")) return scheduleRun;
      if (route.includes("/git/ref/")) return { ref: config.productionRef, object: { type: "commit", sha } };
      if (route.endsWith("/runs/100")) return run(100, ".github/workflows/build-live-menu-artifact.yml", LIVE_CANDIDATE_WORKFLOW_ID);
      if (route.endsWith("/runs/101")) return { ...run(101, ".github/workflows/deploy-github-pages.yml", PROMOTION_WORKFLOW_ID),
        conclusion: promotionFails ? "failure" : "success" };
      if (route.endsWith("/runs/102")) return run(102, ".github/workflows/advance-refresh-checkpoint.yml");
      if (route.includes("/runs/100/artifacts")) return { total_count: 1, artifacts: [{ id: 200,
        name: "lionlog-candidate-receipts-100-1", digest: `sha256:${hash(receiptZip)}`,
        expired: false, workflow_run: { id: 100, head_sha: sha } }] };
      if (route.endsWith("/artifacts/300")) return { id: 300, name: receipt.candidate.artifactName,
        digest: candidateDigest, expired: false, workflow_run: { id: 100, head_sha: sha } };
      throw new Error(`Unexpected fixture API route: ${route}`);
    },
    bytes: async (route) => route.endsWith("/artifacts/200/zip") ? receiptZip : candidateZip,
    dispatch: async (workflow, _branch, inputs) => { dispatched.push({ workflow, inputs }); return 99 + dispatched.length; },
  };
  let checkpointReads = 0;
  const outcome = await runDailyPublication({ ...fixed, api, now: new Date("2026-10-19T09:17:00Z"),
    loadCheckpoint: async () => ({ checkpoint: { publication: { releaseId: checkpointReads++ === 0
      ? "c".repeat(64) : manifest.releaseId }, boundary: { runId: 101 } } }) as unknown as Awaited<ReturnType<typeof loadPublicationCheckpoint>>,
    observePublic: async () => ({ state: "present", releaseId: "c".repeat(64) }), });
  assert.deepEqual(outcome, { candidateRunId: 100, promotionRunId: 101, checkpointRunId: 102 });
  assert.deepEqual(dispatched.map((entry) => entry.workflow), [
    ".github/workflows/build-live-menu-artifact.yml", ".github/workflows/deploy-github-pages.yml",
    ".github/workflows/advance-refresh-checkpoint.yml",
  ]);
  assert.equal(dispatched[1].inputs.candidate_artifact_digest, candidateDigest);
  assert.equal(dispatched[1].inputs.candidate_manifest_sha256, manifestSha);
  assert.equal(dispatched[2].inputs.expected_promotion_run_id, "101");
  promotionFails = true;
  dispatched.length = 0;
  checkpointReads = 0;
  await assert.rejects(runDailyPublication({ ...fixed, api, now: new Date("2026-10-19T09:17:00Z"),
    loadCheckpoint: async () => ({ checkpoint: { publication: { releaseId: "c".repeat(64) } } }) as unknown as Awaited<ReturnType<typeof loadPublicationCheckpoint>>,
    observePublic: async () => ({ state: "present", releaseId: "c".repeat(64) }), }), /ended failure/);
  assert.deepEqual(dispatched.map((entry) => entry.workflow), [
    ".github/workflows/build-live-menu-artifact.yml", ".github/workflows/deploy-github-pages.yml",
  ]);
});

function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function storedZip(entries: Array<{ name: string; bytes: Buffer }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name);
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
