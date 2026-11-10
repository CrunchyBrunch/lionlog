/** Read-only, fail-closed admission for a single discussion wake-up. */
export const DISPATCH_BODY_PREFIX = "lionlog-dispatch.v1:";
export const RECEIVER_PATH = ".github/workflows/daily-publication.yml";
const REPOSITORY = "CrunchyBrunch/lionlog";
const REPOSITORY_ID = 1346360244;

export interface DiscussionWake {
  action: string;
  repository?: { id?: number; full_name?: string };
  discussion?: { id?: number; node_id?: string };
  comment?: { id?: number; node_id?: string; body?: string; created_at?: string; updated_at?: string;
    user?: { id?: number; login?: string } };
  sender?: { id?: number; login?: string };
}
export interface DiscussionEvidenceApi {
  get(route: string): Promise<unknown>;
  graphql(query: string, variables: Record<string, string>): Promise<unknown>;
}
export interface DiscussionAdmission {
  readonly commentId: number;
  readonly commentNodeId: string;
  readonly serviceDate: string;
}

export async function verifyDiscussionAdmission(options: {
  api: DiscussionEvidenceApi; event: DiscussionWake; botUserId: number; discussionNodeId: string;
  receiverRunId: number; receiverSha: string; now: Date;
}): Promise<DiscussionAdmission> {
  const { api, event } = options;
  const comment = event.comment;
  if (event.action !== "created" || event.repository?.id !== REPOSITORY_ID
    || event.repository.full_name !== REPOSITORY || event.discussion?.node_id !== options.discussionNodeId
    || !Number.isSafeInteger(event.discussion.id) || !positive(comment?.id)
    || typeof comment?.node_id !== "string" || !/^DC_[A-Za-z0-9_-]+$/.test(comment.node_id)
    || !positive(options.botUserId) || event.sender?.id !== options.botUserId
    || comment.user?.id !== options.botUserId || event.sender.login !== comment.user.login
    || !/^lionlog-dispatch\.v1:\d{4}-\d{2}-\d{2}$/.test(comment.body ?? "")
    || !canonical(comment.created_at) || comment.updated_at !== comment.created_at
    || !positive(options.receiverRunId) || !/^[a-f0-9]{40}$/.test(options.receiverSha)) {
    throw new Error("Discussion wake identity is invalid.");
  }
  const serviceDate = comment.body!.slice(DISPATCH_BODY_PREFIX.length);
  const nowDay = newYork(options.now).day;
  if (serviceDate !== nowDay || newYork(new Date(comment.created_at!)).day !== serviceDate) {
    throw new Error("Discussion wake crossed the New York service day.");
  }
  const readback = await api.graphql(`query($id:ID!){node(id:$id){... on DiscussionComment{
    id databaseId body createdAt updatedAt discussion{id} author{login}}}}`, { id: comment.node_id! }) as {
    errors?: unknown;
    data?: { node?: { id?: string; databaseId?: number; body?: string; createdAt?: string;
      updatedAt?: string; discussion?: { id?: string }; author?: { login?: string } } } };
  const node = readback?.data?.node;
  if (readback?.errors !== undefined || node?.id !== comment.node_id || node.databaseId !== comment.id || node.body !== comment.body
    || node.discussion?.id !== options.discussionNodeId || node.author?.login !== comment.user.login
    || Date.parse(node.createdAt ?? "") !== Date.parse(comment.created_at!)
    || Date.parse(node.updatedAt ?? "") !== Date.parse(comment.created_at!)) {
    throw new Error("Discussion comment readback is missing or changed.");
  }
  const run = await api.get(`repos/${REPOSITORY}/actions/runs/${options.receiverRunId}`) as {
    id?: number; path?: string; event?: string; run_attempt?: number; head_sha?: string;
    head_branch?: string; status?: string; actor?: { id?: number }; display_title?: string; created_at?: string };
  if (run?.id !== options.receiverRunId || run.path !== RECEIVER_PATH || run.event !== "discussion_comment"
    || run.run_attempt !== 1 || run.head_sha !== options.receiverSha || run.head_branch !== "main"
    || run.actor?.id !== options.botUserId || run.display_title !== `LionLog wake ${comment.id}`
    || run.status !== "in_progress" || !canonical(run.created_at)
    || newYork(new Date(run.created_at!)).day !== serviceDate) {
    throw new Error("Discussion receiver run identity is invalid.");
  }
  await oneReceiverRun(api, serviceDate, options.receiverRunId);
  await noSameDaySchedule(api, serviceDate);
  return { commentId: comment.id!, commentNodeId: comment.node_id!, serviceDate };
}

async function paginatedRuns(api: DiscussionEvidenceApi, event: string, serviceDate: string): Promise<Array<{
  id: number; event: string; path: string; created_at: string; run_attempt: number }>> {
  const start = new Date(Date.parse(`${serviceDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const end = new Date(Date.parse(`${serviceDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const runs: Array<{ id: number; event: string; path: string; created_at: string; run_attempt: number }> = [];
  const seen = new Set<number>();
  let total: number | undefined;
  for (let page = 1; page <= 10; page += 1) {
    const value = await api.get(`repos/${REPOSITORY}/actions/workflows/daily-publication.yml/runs?event=${event}&created=${start}..${end}&per_page=100&page=${page}`) as {
      total_count?: number; workflow_runs?: typeof runs };
    if (!Number.isSafeInteger(value?.total_count) || value.total_count! < 0 || value.total_count! > 1000
      || (total !== undefined && total !== value.total_count) || !Array.isArray(value.workflow_runs)
      || value.workflow_runs.length !== Math.min(100, value.total_count! - runs.length)) {
      throw new Error("Receiver history is incomplete.");
    }
    total = value.total_count;
    for (const run of value.workflow_runs) {
      if (!positive(run.id) || seen.has(run.id) || run.event !== event || run.path !== RECEIVER_PATH
        || !positive(run.run_attempt) || !canonical(run.created_at)) {
        throw new Error("Receiver history identity is invalid.");
      }
      seen.add(run.id);
      runs.push(run);
    }
    if (runs.length === total) return runs.filter((run) => newYork(new Date(run.created_at)).day === serviceDate);
  }
  throw new Error("Receiver history pagination did not complete.");
}

async function oneReceiverRun(api: DiscussionEvidenceApi, day: string, id: number): Promise<void> {
  const runs = await paginatedRuns(api, "discussion_comment", day);
  if (runs.length !== 1 || runs[0].id !== id || runs[0].run_attempt !== 1) {
    throw new Error("The service day's discussion opportunity was already consumed or is ambiguous.");
  }
}
async function noSameDaySchedule(api: DiscussionEvidenceApi, day: string): Promise<void> {
  if ((await paginatedRuns(api, "schedule", day)).length !== 0) {
    throw new Error("A legacy schedule already consumed the service day's opportunity.");
  }
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function canonical(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}
function newYork(date: Date): { day: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric",
    month: "2-digit", day: "2-digit" }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}` };
}
