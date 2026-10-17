import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  evaluateRefreshPolicy,
  validateRefreshAccounting,
  type RefreshAttempt,
} from "../scripts/refresh-policy.ts";
import { assertNoAutomaticCandidateConflict, preflightAutomaticRefresh } from "../scripts/refresh-preflight.ts";

const sourceSha = "a".repeat(40);
const productionRef = "refs/heads/lionlog-production";
const config = {
  activation: "ENABLE_AUTOMATIC_LIONLOG_REFRESH",
  sourceAuthorization: "I_APPROVE_AUTOMATIC_PSU_REQUESTS",
  productionRef,
  productionSha: sourceSha,
};
const invocation = {
  repository: "CrunchyBrunch/lionlog",
  workflowRef: `CrunchyBrunch/lionlog/.github/workflows/build-live-menu-artifact.yml@${productionRef}`,
  workflowSha: sourceSha,
  runId: 900,
  runAttempt: 1,
  serviceDate: "2026-10-15",
};
const day = new Date("2026-10-15T09:17:00.000Z");

function attempt(overrides: Partial<RefreshAttempt> = {}): RefreshAttempt {
  return { runId: 899, runAttempt: 1, workflowSha: sourceSha, workflowRef: productionRef,
    serviceDate: "2026-10-15", startedAt: "2026-10-15T09:17:00.000Z",
    upstreamAttempts: 80, outcome: "transient-prepublication-failure", opportunity: "primary", ...overrides };
}

function decide(overrides: Record<string, unknown> = {}) {
  return evaluateRefreshPolicy({ configuration: config, invocation, now: day,
    trigger: "primary", completeHistory: true, attempts: [], publication: "none", ...overrides });
}

test("automatic refresh is inactive without exact production and source authority", () => {
  assert.equal(decide().remainingRequests, 1_680);
  for (const configuration of [null, { ...config, activation: "" }, { ...config, sourceAuthorization: "" },
    { ...config, productionRef: "refs/heads/main" }, { ...config, productionSha: "b".repeat(40) }]) {
    assert.throws(() => decide({ configuration }), /automatic|source|production|pin/i);
  }
  assert.throws(() => decide({ invocation: { ...invocation, workflowSha: "b".repeat(40) } }), /pin|source|workflow/i);
  assert.throws(() => decide({ invocation: { ...invocation, workflowRef: invocation.workflowRef.replace(productionRef, "refs/heads/main") } }), /ref|workflow/i);
  assert.throws(() => decide({ invocation: { ...invocation, runAttempt: 2 } }), /rerun|attempt/i);
});

test("New York service day and proposed 05:17 primary boundary are exact across DST", () => {
  assert.throws(() => decide({ now: new Date("2026-10-15T09:16:59.999Z") }), /due|05:17/i);
  assert.equal(decide({ now: day }).kind, "primary");
  assert.throws(() => decide({ invocation: { ...invocation, serviceDate: "2026-10-14" } }), /service date/i);
  const winter = { ...invocation, serviceDate: "2026-12-15" };
  assert.throws(() => decide({ invocation: winter, now: new Date("2026-12-15T10:16:59.999Z") }), /due|05:17/i);
  assert.equal(decide({ invocation: winter, now: new Date("2026-12-15T10:17:00.000Z") }).kind, "primary");
});

test("one missed or transient prepublication attempt permits one recovery, never a duplicate", () => {
  assert.equal(decide({ now: new Date("2026-10-15T09:47:00.000Z"), trigger: "recovery" }).kind, "recovery");
  assert.throws(() => decide({ now: new Date("2026-10-15T09:47:00.000Z") }), /primary|recovery/i);
  assert.equal(decide({ trigger: "recovery", attempts: [attempt()] }).remainingRequests, 1_600);
  assert.throws(() => decide({ attempts: [attempt()] }), /duplicate|recovery/i);
  assert.throws(() => decide({ trigger: "recovery", attempts: [attempt(), attempt({ runId: 898 })] }), /recovery|duplicate/i);
  assert.throws(() => decide({ trigger: "recovery", attempts: [attempt({ outcome: "candidate-ready" })] }), /candidate|already/i);
  assert.throws(() => decide({ trigger: "recovery", attempts: [attempt({ outcome: "structural-failure" })] }), /structural|paused/i);
  assert.throws(() => decide({ trigger: "recovery", attempts: [attempt({ outcome: "submission-uncertain" })] }), /uncertain|paused/i);
  assert.throws(() => decide({ trigger: "recovery", publication: "known-good" }), /published|known-good/i);
  assert.throws(() => decide({ trigger: "recovery", publication: "uncertain" }), /uncertain/i);
});

test("shared request accounting cannot reset through a recovery or missing evidence", () => {
  assert.throws(() => decide({ completeHistory: false }), /history|accounting/i);
  assert.throws(() => decide({ trigger: "recovery", attempts: [attempt({ upstreamAttempts: 1_680 })] }), /budget/i);
  assert.equal(decide({ trigger: "recovery", attempts: [attempt({ upstreamAttempts: 1_679 })] }).remainingRequests, 1);
  for (const entry of [attempt({ upstreamAttempts: -1 }), attempt({ upstreamAttempts: 1_681 }),
    attempt({ workflowSha: "b".repeat(40) }), attempt({ workflowRef: "refs/heads/main" }),
    attempt({ serviceDate: "2026-10-14" }), attempt({ outcome: "missing-accounting" })]) {
    assert.throws(() => decide({ trigger: "recovery", attempts: [entry] }), /accounting|pin|budget|history|paused/i);
  }
});

test("a missed-primary recovery consumes the only recovery opportunity even after transient failure", () => {
  const later = new Date("2026-10-15T10:00:00.000Z");
  assert.equal(decide({ now: new Date("2026-10-15T09:47:00.000Z"), trigger: "recovery" }).kind, "recovery");
  assert.throws(() => decide({ now: later, trigger: "recovery", attempts: [
    { ...attempt(), opportunity: "recovery", startedAt: "2026-10-15T09:47:00.000Z" },
  ] }), /recovery opportunity|already used/i);
  assert.equal(decide({ now: later, trigger: "recovery", attempts: [attempt()] }).remainingRequests, 1_600);
  assert.throws(() => decide({ now: later, trigger: "recovery", attempts: [
    { ...attempt(), opportunity: undefined },
  ] }), /opportunity|accounting|history/i);
});

test("retained accounting binds one run, source and exact attempt count", () => {
  const record = { accountingVersion: "lionlog.refresh-accounting.v1", repository: "CrunchyBrunch/lionlog",
    ...attempt(), completedAt: "2026-10-15T09:20:00.000Z" };
  assert.equal(validateRefreshAccounting(record).upstreamAttempts, 80);
  assert.equal(validateRefreshAccounting({ ...record, opportunity: "recovery" }).opportunity, "recovery");
  assert.throws(() => validateRefreshAccounting({ ...record, opportunity: "extra" }), /opportunity|accounting/i);
  assert.throws(() => validateRefreshAccounting({ ...record, runAttempt: 2 }), /accounting|attempt/i);
  assert.throws(() => validateRefreshAccounting({ ...record, upstreamAttempts: 1_681 }), /accounting|budget/i);
  assert.throws(() => validateRefreshAccounting({ ...record, extra: true }), /accounting|schema/i);
});

test("read-only preflight rejects unconfigured authority before API access and ignores newer feature main", async () => {
  const requested: string[] = [];
  const api = { getJson: async (url: string) => { requested.push(url); return { total_count: 0, workflow_runs: [] }; },
    getBytes: async () => { throw new Error("unexpected artifact download"); } };
  const options = { api, configuration: config, repository: invocation.repository, workflowRef: invocation.workflowRef,
    workflowSha: sourceSha, runId: 900, runAttempt: 1, serviceDate: invocation.serviceDate,
    trigger: "primary" as const, now: day };
  await assert.rejects(preflightAutomaticRefresh({ ...options, configuration: { ...config, activation: "" } }), /inactive/);
  assert.equal(requested.length, 0);
  assert.equal(await preflightAutomaticRefresh(options), 1_680);
  assert.ok(requested.every((url) => !url.includes("/commits/main")));
  await assert.rejects(preflightAutomaticRefresh({ ...options, workflowSha: "b".repeat(40) }), /pin/);
  assert.equal(requested.length, 2);
});

test("preflight pauses for a same-day manual candidate, publication, or missing accounting", async () => {
  const run = { id: 899, head_sha: sourceSha, head_branch: "lionlog-production", event: "workflow_dispatch",
    run_attempt: 1, status: "completed", conclusion: "failure", created_at: day.toISOString(),
    path: ".github/workflows/build-live-menu-artifact.yml" };
  const options = { configuration: config, repository: invocation.repository, workflowRef: invocation.workflowRef,
    workflowSha: sourceSha, runId: 900, runAttempt: 1, serviceDate: invocation.serviceDate,
    trigger: "recovery" as const, now: day };
  const api = (which: "manual" | "deploy" | "candidate") => ({
    getJson: async (url: string) => {
      if (url.includes("/artifacts?")) return { total_count: 0, artifacts: [] };
      if (which === "manual" && url.includes("/347085467/runs")) return { total_count: 1, workflow_runs: [{ ...run, head_branch: "main" }] };
      if (which === "deploy" && url.includes("/347992874/runs")) return { total_count: 1, workflow_runs: [{ ...run, path: ".github/workflows/deploy-github-pages.yml" }] };
      if (which === "candidate" && url.includes("/347085467/runs")) return { total_count: 1, workflow_runs: [run] };
      return { total_count: 0, workflow_runs: [] };
    }, getBytes: async () => { throw new Error("unexpected artifact download"); },
  });
  await assert.rejects(preflightAutomaticRefresh({ ...options, api: api("manual") }), /manual candidate/);
  await assert.rejects(preflightAutomaticRefresh({ ...options, api: api("deploy") }), /uncertain publication/i);
  await assert.rejects(preflightAutomaticRefresh({ ...options, api: api("candidate") }), /accounting/);
});

test("a queued cross-midnight candidate and a changed production ref cannot reset the daily budget", async () => {
  const prior = { id: 899, head_sha: sourceSha, head_branch: "lionlog-production", event: "workflow_dispatch",
    run_attempt: 1, status: "completed", conclusion: "failure", created_at: "2026-10-14T23:50:00.000Z",
    updated_at: "2026-10-15T09:18:00.000Z", path: ".github/workflows/build-live-menu-artifact.yml" };
  const options = { configuration: config, repository: invocation.repository, workflowRef: invocation.workflowRef,
    workflowSha: sourceSha, runId: 900, runAttempt: 1, serviceDate: invocation.serviceDate,
    trigger: "recovery" as const, now: day };
  const api = (run: typeof prior) => ({ getJson: async (url: string) =>
    url.includes("/artifacts?") ? { total_count: 0, artifacts: [] }
      : url.includes("/347085467/runs") ? { total_count: 1, workflow_runs: [run] }
        : { total_count: 0, workflow_runs: [] },
    getBytes: async () => { throw new Error("unexpected artifact download"); } });
  await assert.rejects(preflightAutomaticRefresh({ ...options, api: api(prior) }), /accounting/);
  await assert.rejects(preflightAutomaticRefresh({ ...options, api: api({ ...prior, head_branch: "other-production" }) }), /another production pin/);
});

test("manual and automatic attempts share the same-day serialization boundary", async () => {
  let reads = 0;
  const api = { getJson: async () => { reads += 1; return { total_count: 1, workflow_runs: [{ id: 899,
    created_at: day.toISOString() }] }; }, getBytes: async () => Buffer.alloc(0) };
  const options = { api, activation: config.activation, productionRef, serviceDate: invocation.serviceDate, currentRunId: 900 };
  await assertNoAutomaticCandidateConflict({ ...options, activation: "" });
  assert.equal(reads, 0);
  await assert.rejects(assertNoAutomaticCandidateConflict(options), /duplicate manual ingestion/);
});

test("producer and manual conflict preflights reject incomplete run counts", async () => {
  const options = { configuration: config, repository: invocation.repository, workflowRef: invocation.workflowRef,
    workflowSha: sourceSha, runId: 900, runAttempt: 1, serviceDate: invocation.serviceDate,
    trigger: "primary" as const, now: day };
  for (const total_count of [1, undefined, -1, "0"]) {
    const api = { getJson: async (url: string) => url.includes("/347992874/runs")
      ? { total_count: 0, workflow_runs: [] } : { total_count, workflow_runs: [] },
    getBytes: async () => { throw new Error("unexpected artifact download"); } };
    await assert.rejects(preflightAutomaticRefresh({ ...options, api }), /history|pagination|count|incomplete/i);
    await assert.rejects(assertNoAutomaticCandidateConflict({ api, activation: config.activation,
      productionRef, serviceDate: invocation.serviceDate, currentRunId: 900 }), /history|pagination|count|incomplete/i);
  }
});

test("run history requires every unique page before service-date filtering", async () => {
  const prior = { id: 800, head_sha: sourceSha, head_branch: "lionlog-production", event: "workflow_dispatch",
    run_attempt: 1, status: "completed", conclusion: "failure", created_at: "2026-10-13T09:17:00.000Z",
    path: ".github/workflows/build-live-menu-artifact.yml" };
  const first = Array.from({ length: 100 }, (_, index) => ({ ...prior, id: 800 - index }));
  const options = { configuration: config, repository: invocation.repository, workflowRef: invocation.workflowRef,
    workflowSha: sourceSha, runId: 900, runAttempt: 1, serviceDate: invocation.serviceDate,
    trigger: "primary" as const, now: day };
  const api = (second: typeof first) => ({ getJson: async (url: string) => url.includes("/347992874/runs")
    ? { total_count: 0, workflow_runs: [] }
    : url.endsWith("&page=1") ? { total_count: 101, workflow_runs: first }
      : { total_count: 101, workflow_runs: second },
  getBytes: async () => { throw new Error("unexpected artifact download"); } });
  await assert.rejects(preflightAutomaticRefresh({ ...options, api: api([]) }), /history|pagination|count|incomplete/i);
  await assert.rejects(preflightAutomaticRefresh({ ...options, api: api([first[0]]) }), /duplicate|history/i);
  assert.equal(await preflightAutomaticRefresh({ ...options, api: api([{ ...prior, id: 700 }]) }), 1_680);
});

test("retained primary accounting permits one bounded recovery while retained recovery blocks another", async () => {
  const run = { id: 899, head_sha: sourceSha, head_branch: "lionlog-production", event: "workflow_dispatch",
    run_attempt: 1, status: "completed", conclusion: "failure", created_at: "2026-10-15T09:17:00.000Z",
    updated_at: "2026-10-15T09:18:00.000Z", path: ".github/workflows/build-live-menu-artifact.yml" };
  const options = { configuration: config, repository: invocation.repository, workflowRef: invocation.workflowRef,
    workflowSha: sourceSha, runId: 900, runAttempt: 1, serviceDate: invocation.serviceDate,
    trigger: "recovery" as const, now: new Date("2026-10-15T10:00:00.000Z") };
  const api = (opportunity: "primary" | "recovery") => {
    const record = { accountingVersion: "lionlog.refresh-accounting.v1", repository: invocation.repository,
      ...attempt({ opportunity }), completedAt: "2026-10-15T09:18:00.000Z" };
    const wrapper = storedZip("refresh-accounting.json", Buffer.from(JSON.stringify(record)));
    const digest = `sha256:${createHash("sha256").update(wrapper).digest("hex")}`;
    return { getJson: async (url: string) => url.includes("/artifacts?")
      ? { total_count: 1, artifacts: [{ id: 500, name: "lionlog-refresh-accounting-899-1",
        digest, expired: false, workflow_run: { id: 899, head_sha: sourceSha } }] }
      : url.includes("/347085467/runs") ? { total_count: 1, workflow_runs: [run] }
        : { total_count: 0, workflow_runs: [] },
    getBytes: async () => wrapper };
  };
  assert.equal(await preflightAutomaticRefresh({ ...options, api: api("primary") }), 1_600);
  await assert.rejects(preflightAutomaticRefresh({ ...options, api: api("recovery") }), /recovery opportunity.*used/i);
});

function storedZip(name: string, data: Buffer): Buffer {
  const filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}
