import assert from "node:assert/strict";
import test from "node:test";
import { verifyDiscussionAdmission, type DiscussionEvidenceApi, type DiscussionWake } from "../scripts/discussion-admission.ts";
import { parseDiscussionBinding } from "../scripts/discussion-binding.ts";
import { runDailyPublication, type DailyApi } from "../scripts/run-daily-publication.ts";
import { STANDING_PUBLICATION_POLICY } from "../scripts/supported-pages-release.ts";

const day = "2026-11-10";
const created = "2026-11-10T10:17:00Z";
const commentId = 12345;
const botId = 654321;
const discussionId = "D_kwABC123";
const receiverSha = "a".repeat(40);
const body = `lionlog-dispatch.v1:${day}`;
const wake: DiscussionWake = { action: "created", repository: { id: 1346360244, full_name: "CrunchyBrunch/lionlog" },
  discussion: { id: 88, node_id: discussionId }, sender: { id: botId, login: "lionlog-dispatch[bot]" },
  comment: { id: commentId, node_id: "DC_kwABC123", body, created_at: created, updated_at: created,
    user: { id: botId, login: "lionlog-dispatch[bot]" } } };
const receiver = { id: 77, path: ".github/workflows/daily-publication.yml", event: "discussion_comment",
  run_attempt: 1, head_sha: receiverSha, head_branch: "main", status: "in_progress",
  actor: { id: botId }, display_title: `LionLog wake ${commentId} DC_kwABC123 ${discussionId} ${body}`,
  created_at: "2026-11-10T10:18:00Z" };
const readback = { data: { node: { id: "DC_kwABC123", databaseId: commentId, body,
  createdAt: created, updatedAt: created, discussion: { id: discussionId },
  author: { login: "lionlog-dispatch[bot]" } } } };
const current = { id: 77, path: receiver.path, event: receiver.event, run_attempt: 1, created_at: receiver.created_at };

function fixture(change: { event?: DiscussionWake; receiver?: Record<string, unknown>;
  readback?: Record<string, unknown>; discussionHistory?: unknown; scheduleHistory?: unknown;
  skippedScheduleRun?: Record<string, unknown> } = {}) {
  let reads = 0;
  const api: DiscussionEvidenceApi = {
    get: async (route) => {
      reads += 1;
      if (route.endsWith("/runs/77")) return change.receiver ?? receiver;
      if (route.endsWith("/runs/70")) return change.skippedScheduleRun;
      if (route.includes("event=discussion_comment")) return change.discussionHistory
        ?? { total_count: 1, workflow_runs: [current] };
      if (route.includes("event=schedule")) return change.scheduleHistory
        ?? { total_count: 0, workflow_runs: [] };
      throw new Error(`Unexpected route ${route}`);
    },
    graphql: async () => { reads += 1; return change.readback ?? readback; }
  };
  const options = { api, event: change.event ?? wake, botUserId: botId, discussionNodeId: discussionId,
    receiverRunId: 77, receiverSha, now: new Date("2026-11-10T10:20:00Z") };
  return { options, reads: () => reads };
}

test("exact bot comment, readback and receiver run authenticate", async () => {
  assert.deepEqual(await verifyDiscussionAdmission(fixture().options),
    { commentId, commentNodeId: "DC_kwABC123", serviceDate: day });
});

test("spoofed or edited event is rejected before network reads", async () => {
  for (const event of [
    { ...wake, sender: { id: 1, login: "attacker" } },
    { ...wake, comment: { ...wake.comment, body: `${body} extra` } },
    { ...wake, comment: { ...wake.comment, updated_at: "2026-11-10T10:18:00Z" } },
    { ...wake, repository: { id: 1, full_name: "CrunchyBrunch/lionlog" } },
  ]) {
    const f = fixture({ event });
    await assert.rejects(verifyDiscussionAdmission(f.options), /identity/);
    assert.equal(f.reads(), 0);
  }
});

test("edited readback and rerun fail closed", async () => {
  const changes = [
    { readback: { data: { node: { ...readback.data.node, body: "changed" } } } },
    { receiver: { ...receiver, run_attempt: 2 } },
  ];
  for (const change of changes) {
    await assert.rejects(verifyDiscussionAdmission(fixture(change).options));
  }
});

test("comment received on a later New York date cannot dispatch", async () => {
  const f = fixture();
  await assert.rejects(verifyDiscussionAdmission({ ...f.options,
    now: new Date("2026-11-11T10:20:00Z") }), /service day/);
});

test("monitor correlation requires the exact receiver and stage-specific downstream IDs", () => {
  const binding = { version: "lionlog.discussion-binding.v1", stage: "candidate-dispatched",
    serviceDate: day, commentId, commentNodeId: "DC_kwABC123", receiverRunId: 77,
    receiverSha, candidateRunId: 90 };
  assert.equal(parseDiscussionBinding(binding, 77, receiverSha).candidateRunId, 90);
  assert.throws(() => parseDiscussionBinding(binding, 78, receiverSha), /binding/);
  assert.throws(() => parseDiscussionBinding({ ...binding, stage: "complete" }, 77, receiverSha), /binding/);
});

test("orchestrator binds an admitted comment before checkpoint read and never dispatches on missing seed", async () => {
  const f = fixture();
  let dispatches = 0;
  const binding: Array<Record<string, unknown>> = [];
  const api: DailyApi = { ...f.options.api,
    get: async (route) => route.includes("/git/ref/")
      ? { ref: "refs/heads/production", object: { type: "commit", sha: receiverSha } }
      : f.options.api.get(route),
    bytes: async () => Buffer.alloc(0), dispatch: async () => { dispatches += 1; return 1; } };
  await assert.rejects(runDailyPublication({ api, token: "fixture", repository: "CrunchyBrunch/lionlog",
    event: "discussion_comment", workflowRef: "CrunchyBrunch/lionlog/.github/workflows/daily-publication.yml@refs/heads/main",
    attempt: 1, schedulerRunId: 77, schedulerSha: receiverSha,
    configuration: { activation: "ENABLE_AUTOMATIC_LIONLOG_REFRESH",
      sourceAuthorization: "I_APPROVE_AUTOMATIC_PSU_REQUESTS",
      productionRef: "refs/heads/production", productionSha: receiverSha },
    standingPolicy: STANDING_PUBLICATION_POLICY, writerId: 42,
    now: new Date("2026-11-10T10:20:00Z"), discussionWake: wake,
    dispatchMode: "external",
    botUserId: botId, botLogin: "lionlog-dispatch[bot]", discussionNodeId: discussionId,
    binding: async (value) => { binding.push(value); },
    loadCheckpoint: async () => { throw new Error("seed absent"); }
  }), /seed absent/);
  assert.equal(binding.length, 1);
  assert.equal(binding[0].commentId, commentId);
  assert.equal(dispatches, 0);
});

test("discussion event cannot enter the orchestrator without the explicit external mode", async () => {
  const api: DailyApi = { get: async () => { throw new Error("unexpected read"); },
    graphql: async () => { throw new Error("unexpected read"); },
    bytes: async () => Buffer.alloc(0), dispatch: async () => { throw new Error("unexpected dispatch"); } };
  await assert.rejects(runDailyPublication({ api, token: "fixture", repository: "CrunchyBrunch/lionlog",
    event: "discussion_comment", workflowRef: "CrunchyBrunch/lionlog/.github/workflows/daily-publication.yml@refs/heads/main",
    attempt: 1, schedulerRunId: 77, schedulerSha: receiverSha,
    configuration: { activation: "ENABLE_AUTOMATIC_LIONLOG_REFRESH",
      sourceAuthorization: "I_APPROVE_AUTOMATIC_PSU_REQUESTS",
      productionRef: "refs/heads/production", productionSha: receiverSha },
    standingPolicy: STANDING_PUBLICATION_POLICY, writerId: 42,
    now: new Date("2026-11-10T10:20:00Z"), discussionWake: wake,
    botUserId: botId, discussionNodeId: discussionId
  }), /inactive/);
});
