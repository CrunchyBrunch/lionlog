import assert from "node:assert/strict";
import test from "node:test";
import { assertSharedOpportunity, verifyDayReservation } from "../scripts/shared-opportunity.ts";
import type { DiscussionEvidenceApi, DiscussionWake } from "../scripts/discussion-admission.ts";

const day = "2026-11-10";
const sha = "a".repeat(40);
const botId = 42;
const botLogin = "lionlog-dispatch[bot]";
const discussion = "D_kwABC123";
const commentNode = "DC_kwABC123";
const body = `lionlog-dispatch.v1:${day}`;
const created = "2026-11-10T10:17:00Z";
const path = ".github/workflows/daily-publication.yml";
const schedule = { id: 70, path, event: "schedule", run_attempt: 1, head_sha: sha,
  head_branch: "main", status: "in_progress", conclusion: null, created_at: created };
const external = { id: 77, path, event: "discussion_comment", run_attempt: 1, head_sha: sha,
  head_branch: "main", status: "in_progress", conclusion: null, created_at: created,
  actor: { id: botId, login: botLogin },
  display_title: `LionLog wake 12345 ${commentNode} ${discussion} ${body}` };
const wake: DiscussionWake = { action: "created",
  repository: { id: 1346360244, full_name: "CrunchyBrunch/lionlog" },
  discussion: { id: 80, node_id: discussion }, sender: { id: botId, login: botLogin },
  comment: { id: 12345, node_id: commentNode, body, created_at: created, updated_at: created,
    user: { id: botId, login: botLogin } } };
const node = { id: commentNode, databaseId: 12345, body, createdAt: created, updatedAt: created,
  author: { login: botLogin }, discussion: { id: discussion,
    repository: { databaseId: 1346360244, nameWithOwner: "CrunchyBrunch/lionlog" } } };

type ScheduleRun = Omit<typeof schedule, "conclusion"> & { conclusion: string | null };
type ExternalRun = Omit<typeof external, "conclusion"> & { conclusion: string | null };
function fixture(scheduleRuns: ScheduleRun[], botRuns: ExternalRun[]) {
  const routes: string[] = [];
  const api: DiscussionEvidenceApi = {
    get: async (route) => {
      routes.push(route);
      if (route.endsWith("/runs/70")) return scheduleRuns.find((run) => run.id === 70);
      if (route.endsWith("/runs/77")) return botRuns.find((run) => run.id === 77);
      if (route.includes("/runs?event=schedule")) return { total_count: scheduleRuns.length, workflow_runs: scheduleRuns };
      if (route.includes("/runs?event=discussion_comment")) {
        assert.match(route, /actor=lionlog-dispatch%5Bbot%5D/);
        return { total_count: botRuns.length, workflow_runs: botRuns };
      }
      throw new Error(`Unexpected ${route}`);
    },
    graphql: async (_query, variables) => ({ data: { node: variables.id === commentNode ? node : null } })
  };
  const common = { api, repository: "CrunchyBrunch/lionlog",
    workflowRef: "CrunchyBrunch/lionlog/.github/workflows/daily-publication.yml@refs/heads/main",
    sha, attempt: 1, botId, botLogin, discussionNodeId: discussion,
    now: new Date("2026-11-10T10:20:00Z") };
  return { api, routes,
    cron: { ...common, event: "schedule" as const, runId: 70, mode: undefined },
    app: { ...common, event: "discussion_comment" as const, runId: 77, mode: "external", wake } };
}

test("first schedule is the durable day claim; later App receiver cannot dispatch", async () => {
  const f = fixture([schedule], []);
  assert.deepEqual(await assertSharedOpportunity(f.cron), { serviceDate: day });
  const later = fixture([schedule], [external]);
  await assert.rejects(assertSharedOpportunity(later.app), /another trusted/);
});

test("first App receiver survives crash or ambiguous downstream response and blocks later cron", async () => {
  const failed = { ...external, status: "completed", conclusion: "failure" };
  const first = fixture([], [external]);
  assert.deepEqual(await assertSharedOpportunity(first.app), { serviceDate: day });
  const later = fixture([schedule], [failed]);
  await assert.rejects(assertSharedOpportunity(later.cron), /another trusted/);
  assert.ok(later.routes.some((route) => route.includes("actor=lionlog-dispatch%5Bbot%5D")));
});

test("simultaneously visible schedule and App opportunities both fail closed", async () => {
  const f = fixture([schedule], [external]);
  await assert.rejects(assertSharedOpportunity(f.cron), /another trusted/);
  await assert.rejects(assertSharedOpportunity(f.app), /another trusted/);
});

test("unrelated comments and terminal skipped cron runs do not consume the day", async () => {
  const skipped = { ...schedule, status: "completed", conclusion: "skipped" };
  const other = { ...external, id: 78, display_title: `LionLog wake 67890 DC_kwOTHER D_kwOTHER ${body}` };
  const unrelated = { ...external, id: 79,
    display_title: `LionLog wake 67891 DC_kwOTHER ${discussion} Ordinary status comment` };
  const f = fixture([skipped], [external, other, unrelated]);
  f.api.graphql = async (_query, variables) => ({ data: { node: variables.id === commentNode ? node :
    { ...node, id: "DC_kwOTHER", databaseId: 67890,
      discussion: { ...node.discussion, id: "D_kwOTHER" } } } });
  assert.deepEqual(await assertSharedOpportunity(f.app), { serviceDate: day });
});

test("history gaps, reruns and old-revision non-skips block before a producer call", async () => {
  const f = fixture([schedule], [external]);
  const original = f.api.get;
  f.api.get = async (route) => route.includes("/runs?event=discussion_comment")
    ? { total_count: 2, workflow_runs: [external] } : original(route);
  await assert.rejects(assertSharedOpportunity(f.app), /history is incomplete/);
  const rerun = fixture([], [{ ...external, run_attempt: 2 }]);
  await assert.rejects(assertSharedOpportunity(rerun.app), /run identity|history|attempt/i);
});

test("default cron needs no unprovisioned bot, but enabled external authority requires its sticky identity", async () => {
  const f = fixture([schedule], []);
  const legacy = { ...f.cron, botId: undefined, botLogin: undefined, discussionNodeId: undefined };
  assert.equal((await assertSharedOpportunity(legacy)).serviceDate, day);
  await assert.rejects(assertSharedOpportunity({ ...legacy,
    externalActivation: "ENABLE_LIONLOG_EXTERNAL_DISPATCH" }), /bot identity is missing/);
});

test("producer gate requires one durable artifact bound to the exact run and SHA", async () => {
  const artifact = { id: 500, name: `lionlog-day-reservation-${day}`, expired: false,
    digest: `sha256:${"c".repeat(64)}`,
    workflow_run: { id: 77, head_sha: sha, repository_id: 1346360244 } };
  const api = { get: async (route: string) => {
    assert.match(route, /actions\/artifacts\?name=lionlog-day-reservation-2026-11-10/);
    return { total_count: 1, artifacts: [artifact] };
  } };
  await verifyDayReservation({ api, serviceDate: day, runId: 77, sha });
  await assert.rejects(verifyDayReservation({ api, serviceDate: day, runId: 70, sha }), /changed identity/);
  await assert.rejects(verifyDayReservation({ api: { get: async () => ({ total_count: 2,
    artifacts: [artifact, { ...artifact, id: 501 }] }) }, serviceDate: day, runId: 77, sha }), /ambiguous/);
});
