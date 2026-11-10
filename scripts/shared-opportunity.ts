/** One durable opportunity is the first authenticated non-skipped Actions receiver run for a New York day. */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RECEIVER_PATH, verifyDiscussionAdmission, type DiscussionEvidenceApi,
  type DiscussionWake } from "./discussion-admission.ts";

const REPOSITORY = "CrunchyBrunch/lionlog";
const SHA = /^[a-f0-9]{40}$/;
type Run = { id: number; path: string; event: string; run_attempt: number; head_sha: string;
  head_branch: string; actor?: { id?: number; login?: string }; display_title?: string;
  status: string; conclusion: string | null; created_at: string };

export async function assertSharedOpportunity(options: {
  api: DiscussionEvidenceApi; event: "schedule" | "discussion_comment"; wake?: DiscussionWake;
  repository: string; workflowRef: string; runId: number; sha: string; attempt: number;
  mode?: string; botId?: number; botLogin?: string; discussionNodeId?: string; now: Date;
  externalActivation?: string;
}): Promise<{ serviceDate: string }> {
  const { api } = options;
  const { serviceDate } = opportunity(options.now);
  if (options.repository !== REPOSITORY || options.workflowRef !== `${REPOSITORY}/${RECEIVER_PATH}@refs/heads/main`
    || !positive(options.runId) || !SHA.test(options.sha) || options.attempt !== 1
    || (options.event === "discussion_comment" ? options.mode !== "external" : options.mode === "external")) {
    throw new Error("Shared daily receiver authority changed.");
  }
  const configuredBot = options.botLogin !== undefined && options.botLogin !== "";
  if (configuredBot && (!positive(options.botId) || !/^[-A-Za-z0-9]+\[bot\]$/.test(options.botLogin!)
    || !/^D_[A-Za-z0-9_-]+$/.test(options.discussionNodeId ?? ""))) {
    throw new Error("Shared opportunity bot identity is incomplete.");
  }
  if (!configuredBot && (options.event === "discussion_comment" || options.botId || options.discussionNodeId
    || options.externalActivation === "ENABLE_LIONLOG_EXTERNAL_DISPATCH")) {
    throw new Error("Shared opportunity bot identity is missing.");
  }
  if (options.event === "discussion_comment") {
    await verifyDiscussionAdmission({ api, event: options.wake!, botUserId: options.botId!,
      discussionNodeId: options.discussionNodeId!, receiverRunId: options.runId,
      receiverSha: options.sha, now: options.now });
    if (options.wake?.sender?.login !== options.botLogin) throw new Error("Dispatcher bot login changed.");
  } else {
    const current = await api.get(`repos/${REPOSITORY}/actions/runs/${options.runId}`) as Run;
    if (current?.id !== options.runId || current.path !== RECEIVER_PATH || current.event !== "schedule"
      || current.run_attempt !== 1 || current.head_sha !== options.sha || current.head_branch !== "main"
      || current.status !== "in_progress" || nyDay(current.created_at) !== serviceDate) {
      throw new Error("Scheduled receiver identity or date changed.");
    }
  }
  const schedule = await runs(api, "schedule", serviceDate);
  const bot = configuredBot ? await runs(api, "discussion_comment", serviceDate, options.botLogin) : [];
  const consuming: number[] = [];
  for (const run of schedule) {
    if (run.status === "completed" && run.conclusion === "skipped" && run.head_sha === options.sha
      && run.run_attempt === 1) continue;
    consuming.push(run.id);
  }
  for (const run of bot) {
    if (run.actor?.id !== options.botId || run.actor?.login !== options.botLogin) {
      throw new Error("Filtered bot receiver history changed identity.");
    }
    const match = /^LionLog wake ([1-9]\d*) (DC_[A-Za-z0-9_-]+) (D_[A-Za-z0-9_-]+) (lionlog-dispatch\.v1:\d{4}-\d{2}-\d{2})$/.exec(run.display_title ?? "");
    if (!match) {
      if ((run.display_title ?? "").startsWith("LionLog wake ")) {
        throw new Error("Bot receiver title cannot authenticate its comment.");
      }
      continue; // An unrelated bot-triggered workflow has no dispatch-shaped title.
    }
    const id = Number(match[1]);
    if (!positive(id)) throw new Error("Bot comment ID is invalid.");
    const readback = await api.graphql(`query($id:ID!){node(id:$id){... on DiscussionComment{
      id databaseId body createdAt updatedAt author{login}
      discussion{id repository{databaseId nameWithOwner}}}}}`, { id: match[2] }) as {
      errors?: unknown; data?: { node?: { id?: string; databaseId?: number; body?: string;
        createdAt?: string; updatedAt?: string; author?: { login?: string };
        discussion?: { id?: string; repository?: { databaseId?: number; nameWithOwner?: string } } } } };
    const node = readback?.data?.node;
    if (readback?.errors !== undefined || node?.id !== match[2] || node.databaseId !== id
      || node.author?.login !== options.botLogin || !canonical(node.createdAt)
      || !canonical(node.updatedAt)) throw new Error("Bot comment history readback is incomplete.");
    if (match[3] !== options.discussionNodeId || match[4] !== `lionlog-dispatch.v1:${serviceDate}`
      || node.discussion?.id !== options.discussionNodeId
      || node.discussion.repository?.databaseId !== 1346360244
      || node.discussion.repository.nameWithOwner !== REPOSITORY
      || node.body !== `lionlog-dispatch.v1:${serviceDate}`
      || nyDay(node.createdAt!) !== serviceDate) continue; // unrelated bot activity
    if (node.updatedAt !== node.createdAt) throw new Error("Trusted bot comment was edited.");
    if (run.status === "completed" && run.conclusion === "skipped" && run.head_sha === options.sha
      && run.run_attempt === 1) continue;
    consuming.push(run.id);
  }
  if (consuming.length !== 1 || consuming[0] !== options.runId) {
    throw new Error("The New York day has another trusted or ambiguous receiver opportunity.");
  }
  return { serviceDate };
}

/** The artifact is uploaded in the same serialized job before the producer can be invoked. */
export async function verifyDayReservation(options: {
  api: Pick<DiscussionEvidenceApi, "get">; serviceDate: string; runId: number; sha: string;
}): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.serviceDate) || !positive(options.runId) || !SHA.test(options.sha)) {
    throw new Error("Day reservation identity is invalid.");
  }
  const name = `lionlog-day-reservation-${options.serviceDate}`;
  const response = await options.api.get(`repos/${REPOSITORY}/actions/artifacts?name=${name}&per_page=100&page=1`) as {
    total_count?: number; artifacts?: Array<{ id?: number; name?: string; digest?: string;
      expired?: boolean; workflow_run?: { id?: number; head_sha?: string; repository_id?: number } }> };
  if (response?.total_count !== 1 || !Array.isArray(response.artifacts) || response.artifacts.length !== 1) {
    throw new Error("Shared day reservation is absent or ambiguous.");
  }
  const item = response.artifacts[0];
  if (!positive(item.id) || item.name !== name || item.expired !== false
    || !/^sha256:[a-f0-9]{64}$/.test(item.digest ?? "")
    || item.workflow_run?.id !== options.runId || item.workflow_run.head_sha !== options.sha
    || item.workflow_run.repository_id !== 1346360244) {
    throw new Error("Shared day reservation artifact changed identity.");
  }
}

async function runs(api: DiscussionEvidenceApi, event: string, day: string, actor?: string): Promise<Run[]> {
  const start = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const end = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const out: Run[] = [];
  const seen = new Set<number>();
  let total: number | undefined;
  for (let page = 1; page <= 10; page += 1) {
    const route = `repos/${REPOSITORY}/actions/workflows/daily-publication.yml/runs?event=${event}`
      + `${actor ? `&actor=${encodeURIComponent(actor)}` : ""}&created=${start}..${end}&per_page=100&page=${page}`;
    const response = await api.get(route) as { total_count?: number; workflow_runs?: Run[] };
    if (!Number.isSafeInteger(response?.total_count) || response.total_count! < 0 || response.total_count! > 1000
      || (total !== undefined && total !== response.total_count) || !Array.isArray(response.workflow_runs)
      || response.workflow_runs.length !== Math.min(100, response.total_count! - out.length)) {
      throw new Error("Shared opportunity history is incomplete.");
    }
    total = response.total_count;
    for (const run of response.workflow_runs) {
      if (!positive(run?.id) || seen.has(run.id) || run.event !== event || run.path !== RECEIVER_PATH
        || !positive(run.run_attempt) || !SHA.test(run.head_sha) || run.head_branch !== "main"
        || !["queued", "in_progress", "completed"].includes(run.status)
        || !canonical(run.created_at)) throw new Error("Shared opportunity history identity is invalid.");
      seen.add(run.id); out.push(run);
    }
    if (out.length === total) break;
  }
  if (out.length !== total) throw new Error("Shared opportunity history pagination did not complete.");
  return out.filter((run) => nyDay(run.created_at) === day);
}

function opportunity(now: Date): { serviceDate: string } {
  if (!Number.isFinite(now.getTime())) throw new Error("New York opportunity clock invalid.");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (minute < 5 * 60 + 17 || minute >= 12 * 60 + 15) throw new Error("Outside the New York start window.");
  return { serviceDate: `${parts.year}-${parts.month}-${parts.day}` };
}
function nyDay(value: string): string {
  if (!canonical(value)) throw new Error("Receiver timestamp invalid.");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value)).map((x) => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function canonical(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const token = process.env.GH_TOKEN ?? "";
    if (!token) throw new Error("GitHub token missing.");
    const event = process.env.GITHUB_EVENT_NAME;
    if (event !== "schedule" && event !== "discussion_comment") throw new Error("Unsupported receiver event.");
    const wake = event === "discussion_comment"
      ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as DiscussionWake : undefined;
    const request = async (route: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`https://api.github.com/${route}`, { method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
          "x-github-api-version": "2026-03-10", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Shared opportunity GitHub API returned ${response.status}.`);
      return response.json();
    };
    const api = { get: (route: string) => request(route),
      graphql: (query: string, variables: Record<string, string>) => request("graphql", { query, variables }) };
    const identity: Omit<Parameters<typeof assertSharedOpportunity>[0], "api"> = {
      event, wake, repository: process.env.GITHUB_REPOSITORY ?? "",
      workflowRef: process.env.GITHUB_WORKFLOW_REF ?? "", runId: Number(process.env.GITHUB_RUN_ID),
      sha: process.env.GITHUB_SHA ?? "", attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      mode: process.env.LIONLOG_DISPATCH_MODE,
      externalActivation: process.env.LIONLOG_EXTERNAL_DISPATCH_ACTIVATION,
      botId: Number(process.env.LIONLOG_DISPATCHER_BOT_USER_ID),
      botLogin: process.env.LIONLOG_DISPATCHER_BOT_LOGIN,
      discussionNodeId: process.env.LIONLOG_DISPATCH_DISCUSSION_NODE_ID, now: new Date() };
    const { serviceDate } = await assertSharedOpportunity({ api, ...identity });
    const reservation = { version: "lionlog.day-reservation.v1", serviceDate,
      runId: identity.runId, sha: identity.sha, event };
    if (process.env.LIONLOG_OPPORTUNITY_PHASE === "prepare") {
      await writeFile("receiver/day-reservation.json", `${JSON.stringify(reservation)}\n`, { flag: "wx" });
      if (!process.env.GITHUB_OUTPUT) throw new Error("Day reservation output path missing.");
      await appendFile(process.env.GITHUB_OUTPUT, `service_date=${serviceDate}\n`);
    } else if (process.env.LIONLOG_OPPORTUNITY_PHASE === "confirm") {
      const local = JSON.parse(await readFile("receiver/day-reservation.json", "utf8")) as typeof reservation;
      if (JSON.stringify(local) !== JSON.stringify(reservation)) throw new Error("Local day reservation changed.");
      await verifyDayReservation({ api, serviceDate, runId: identity.runId, sha: identity.sha });
    } else {
      throw new Error("Day reservation phase missing.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
