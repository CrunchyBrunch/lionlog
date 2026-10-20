/** One scheduled, fail-closed handoff across the pinned production workflows. */
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArtifactZip } from "./artifact-zip.ts";
import { assertNoScheduledCandidateConflict } from "./refresh-preflight.ts";
import { loadPublicationCheckpoint } from "./publication-checkpoint.ts";
import { observePublicRelease } from "./public-release-state.ts";
import { assertRefreshConfiguration, LATEST_DAILY_START_MINUTE, PROPOSED_PRIMARY_MINUTE,
  PROPOSED_PRIMARY_WINDOW_MINUTES, type RefreshConfiguration } from "./refresh-policy.ts";
import { STANDING_PUBLICATION_POLICY } from "./supported-pages-release.ts";
import { LIVE_CANDIDATE_WORKFLOW_ID, PROMOTION_WORKFLOW_ID, publicationCandidateReceiptSchema,
  validatePublicationReleaseManifest } from "../infrastructure/publication/release-contract.ts";

const REPOSITORY = "CrunchyBrunch/lionlog";
const PRODUCER = ".github/workflows/build-live-menu-artifact.yml";
const PROMOTION = ".github/workflows/deploy-github-pages.yml";
const CHECKPOINT = ".github/workflows/advance-refresh-checkpoint.yml";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUN_LIMIT_MS = 3 * 60 * 60_000;
const MAX_DAILY_SCHEDULE_RUNS = 1_000;

export interface DailyApi {
  get(path: string, budgetMs?: number): Promise<unknown>;
  bytes(path: string, budgetMs?: number): Promise<Buffer>;
  dispatch(workflow: string, branch: string, inputs: Record<string, string>, budgetMs?: number): Promise<number>;
}
interface GitHubArtifact { id: number; name: string; digest: string; expired: boolean;
  workflow_run: { id: number; head_sha: string } }
interface GitHubRun { id: number; path: string; workflow_id?: number; event: string; run_attempt: number;
  head_sha: string; head_branch: string; status: string; conclusion: string | null; created_at?: string }

export function scheduledOpportunity(now: Date): { serviceDate: string; mode: "primary" | "recovery" } {
  if (!Number.isFinite(now.getTime())) throw new Error("Daily scheduler clock is invalid.");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = (key: string) => parts.find((part) => part.type === key)?.value ?? "";
  const minute = Number(value("hour")) * 60 + Number(value("minute"));
  if (minute < PROPOSED_PRIMARY_MINUTE || minute >= LATEST_DAILY_START_MINUTE) {
    throw new Error("Scheduled run is outside the approved New York morning window.");
  }
  return { serviceDate: `${value("year")}-${value("month")}-${value("day")}`,
    mode: minute < PROPOSED_PRIMARY_MINUTE + PROPOSED_PRIMARY_WINDOW_MINUTES ? "primary" : "recovery" };
}

function newYorkDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Scheduler creation time is invalid.");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric",
    month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (key: string) => parts.find((part) => part.type === key)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function canonicalUtc(value: unknown): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error("Scheduler creation time is invalid.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== (value.includes(".") ? value : value.replace("Z", ".000Z"))) {
    throw new Error("Scheduler creation time is invalid.");
  }
  return date;
}

async function assertOnlyScheduledOpportunity(api: DailyApi, serviceDate: string, currentRunId: number): Promise<void> {
  const nextUtcDate = new Date(Date.parse(`${serviceDate}T00:00:00.000Z`) + 24 * 60 * 60_000).toISOString().slice(0, 10);
  const created = encodeURIComponent(`${serviceDate}..${nextUtcDate}`);
  const seen = new Set<number>();
  let total: number | undefined;
  let currentSeen = false;
  for (let page = 1; page <= 10; page += 1) {
    const value = await api.get(`repos/${REPOSITORY}/actions/workflows/daily-publication.yml/runs?event=schedule&created=${created}&per_page=100&page=${page}`) as {
      total_count?: number; workflow_runs?: Array<{ id: number; event: string; path: string;
        run_attempt: number; head_branch: string; created_at: string }> };
    if (!Number.isSafeInteger(value?.total_count) || value.total_count! < 1
      || value.total_count! > MAX_DAILY_SCHEDULE_RUNS || !Array.isArray(value.workflow_runs)
      || (total !== undefined && total !== value.total_count)
      || value.workflow_runs.length !== Math.min(100, value.total_count! - seen.size)) {
      throw new Error("Scheduled run history is incomplete or ambiguous.");
    }
    total = value.total_count;
    for (const run of value.workflow_runs) {
      if (!Number.isSafeInteger(run.id) || run.id < 1 || seen.has(run.id)
        || run.event !== "schedule" || run.path !== ".github/workflows/daily-publication.yml"
        || run.head_branch !== "main" || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
        throw new Error("Scheduled run history identity is invalid.");
      }
      const createdAt = canonicalUtc(run.created_at);
      seen.add(run.id);
      if (newYorkDate(createdAt) !== serviceDate) continue;
      if (run.id === currentRunId) currentSeen = true;
      else throw new Error("The service day's scheduled retrieval opportunity was already consumed.");
    }
    if (seen.size === total) break;
  }
  if (seen.size !== total || !currentSeen) throw new Error("Scheduled run history omitted the current opportunity.");
}

function exactArtifact(value: unknown, name: string, runId: number, sha: string): GitHubArtifact {
  const list = value as { total_count?: number; artifacts?: GitHubArtifact[] };
  if (!Number.isSafeInteger(list?.total_count) || !Array.isArray(list?.artifacts)
    || list.total_count !== list.artifacts.length || list.total_count > 100) {
    throw new Error("Artifact list is incomplete.");
  }
  const matches = list.artifacts.filter((item) => item.name === name);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1
    || matches[0].expired !== false || !DIGEST.test(matches[0].digest)
    || matches[0].workflow_run?.id !== runId || matches[0].workflow_run?.head_sha !== sha) {
    throw new Error(`Exact artifact ${name} is unavailable or ambiguous.`);
  }
  return matches[0];
}

async function artifactEntries(api: DailyApi, artifact: GitHubArtifact, paths: string[]): Promise<Map<string, Buffer>> {
  const wrapper = await api.bytes(`repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`);
  if (`sha256:${createHash("sha256").update(wrapper).digest("hex")}` !== artifact.digest) {
    throw new Error("Retained artifact wrapper digest changed.");
  }
  return new Map(parseArtifactZip(wrapper, paths).map((entry) => [entry.path, entry.data]));
}

function assertProductionRef(value: unknown, config: RefreshConfiguration): void {
  const ref = value as { ref?: string; object?: { type?: string; sha?: string } };
  if (ref?.ref !== config.productionRef || ref.object?.type !== "commit" || ref.object.sha !== config.productionSha) {
    throw new Error("Approved production branch drifted.");
  }
}

async function waitForRun(api: DailyApi, id: number, workflow: string, workflowId: number | undefined,
  config: RefreshConfiguration, sleep: (ms: number) => Promise<void>, remainingMs: () => number): Promise<void> {
  const branch = config.productionRef.slice("refs/heads/".length);
  while (true) {
    remainingMs();
    const run = await api.get(`repos/${REPOSITORY}/actions/runs/${id}`) as GitHubRun;
    remainingMs();
    if (run?.id !== id || run.path !== workflow || (workflowId !== undefined && run.workflow_id !== workflowId)
      || run.event !== "workflow_dispatch" || run.run_attempt !== 1 || run.head_sha !== config.productionSha
      || run.head_branch !== branch || !["queued", "in_progress", "completed"].includes(run.status)) {
      throw new Error(`${workflow} run identity changed or was rerun.`);
    }
    if (run.status === "completed") {
      if (run.conclusion !== "success") throw new Error(`${workflow} ended ${run.conclusion ?? "without a conclusion"}.`);
      return;
    }
    await sleep(Math.min(15_000, remainingMs()));
  }
}

export async function runDailyPublication(options: {
  api: DailyApi; token: string; repository: string; event: string; workflowRef: string; attempt: number;
  schedulerRunId: number; schedulerSha: string;
  configuration: RefreshConfiguration; standingPolicy: string; writerId: number; now: Date;
  sleep?: (ms: number) => Promise<void>; summary?: (line: string) => Promise<void>;
  wallNowMs?: () => number; elapsedNowMs?: () => number;
  loadCheckpoint?: typeof loadPublicationCheckpoint;
  observePublic?: typeof observePublicRelease;
}): Promise<{ candidateRunId: number; promotionRunId: number; checkpointRunId: number }> {
  const { configuration: config, api } = options;
  assertRefreshConfiguration(config);
  if (options.repository !== REPOSITORY || options.event !== "schedule" || options.attempt !== 1
    || options.workflowRef !== `${REPOSITORY}/.github/workflows/daily-publication.yml@refs/heads/main`
    || !Number.isSafeInteger(options.schedulerRunId) || options.schedulerRunId < 1 || !SHA.test(options.schedulerSha)
    || options.standingPolicy !== STANDING_PUBLICATION_POLICY
    || !Number.isSafeInteger(options.writerId) || options.writerId < 1 || !options.token) {
    throw new Error("Daily schedule or standing authority is inactive or changed.");
  }
  const wallNowMs = options.wallNowMs ?? Date.now;
  const elapsedNowMs = options.elapsedNowMs ?? (() => performance.now());
  const wallStartMs = wallNowMs();
  const elapsedStartMs = elapsedNowMs();
  if (!Number.isFinite(wallStartMs) || !Number.isFinite(elapsedStartMs)) {
    throw new Error("Daily scheduler clock is invalid.");
  }
  const deadline = elapsedStartMs + RUN_LIMIT_MS;
  const remainingMs = (): number => {
    const remaining = Math.floor(deadline - elapsedNowMs());
    if (!Number.isFinite(remaining) || remaining < 1) {
      throw new Error("Daily publication did not complete within the bounded daily window.");
    }
    return remaining;
  };
  const boundedApi: DailyApi = {
    get: async (route) => {
      const result = await api.get(route, remainingMs());
      remainingMs();
      return result;
    },
    bytes: async (route) => {
      const result = await api.bytes(route, remainingMs());
      remainingMs();
      return result;
    },
    // A dispatch may have started remotely even when its response arrives late. Preserve its returned ID for the summary.
    dispatch: (workflow, branch, inputs) => api.dispatch(workflow, branch, inputs, remainingMs()),
  };
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init,
    signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(remainingMs())]) });
  const { serviceDate, mode } = scheduledOpportunity(options.now);
  const scheduledRun = await boundedApi.get(`repos/${REPOSITORY}/actions/runs/${options.schedulerRunId}`) as GitHubRun;
  if (scheduledRun?.id !== options.schedulerRunId || scheduledRun.path !== ".github/workflows/daily-publication.yml"
    || scheduledRun.event !== "schedule" || scheduledRun.run_attempt !== 1
    || scheduledRun.head_branch !== "main" || scheduledRun.head_sha !== options.schedulerSha
    || scheduledRun.status !== "in_progress") {
    throw new Error("Scheduler run identity or creation time is invalid.");
  }
  if (newYorkDate(canonicalUtc(scheduledRun.created_at)) !== serviceDate) {
    throw new Error("Delayed schedule crossed the New York service-day boundary.");
  }
  const branch = config.productionRef.slice("refs/heads/".length);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const summary = options.summary ?? (async () => {});
  const readCheckpoint = options.loadCheckpoint ?? loadPublicationCheckpoint;
  const observePublic = options.observePublic ?? observePublicRelease;
  const checkPin = async () => assertProductionRef(await boundedApi.get(`repos/${REPOSITORY}/git/ref/${config.productionRef.slice("refs/".length)}`), config);
  await checkPin();
  const checkpoint = await readCheckpoint({ token: options.token, authorizedWriterId: options.writerId,
    fetchImpl: boundedFetch });
  remainingMs();
  const publicBefore = await observePublic(boundedFetch);
  remainingMs();
  if (publicBefore.state !== "present" || publicBefore.releaseId !== checkpoint.checkpoint.publication.releaseId) {
    throw new Error("Public predecessor differs from the authenticated checkpoint.");
  }
  await assertOnlyScheduledOpportunity(boundedApi, serviceDate, options.schedulerRunId);
  await assertNoScheduledCandidateConflict({ api: { getJson: (route) => boundedApi.get(route), getBytes: (route) => boundedApi.bytes(route) },
    serviceDate });
  remainingMs();
  const candidateRunId = await boundedApi.dispatch(PRODUCER, branch, {
    refresh_mode: mode, service_date: serviceDate, confirmation: "PREPARE_LIVE_PAGES_FIELD_RELEASE",
    expected_source_sha: config.productionSha, expected_run_attempt: "1",
  });
  await summary(`Candidate run: [${candidateRunId}](https://github.com/${REPOSITORY}/actions/runs/${candidateRunId})`);
  remainingMs();
  await waitForRun(boundedApi, candidateRunId, PRODUCER, LIVE_CANDIDATE_WORKFLOW_ID, config, sleep, remainingMs);
  const receipts = exactArtifact(await boundedApi.get(`repos/${REPOSITORY}/actions/runs/${candidateRunId}/artifacts?per_page=100`),
    `lionlog-candidate-receipts-${candidateRunId}-1`, candidateRunId, config.productionSha);
  const receiptFiles = await artifactEntries(boundedApi, receipts, ["live.json", "first-release-recovery.json"]);
  const receipt = publicationCandidateReceiptSchema.parse(JSON.parse(receiptFiles.get("live.json")!.toString("utf8")));
  if (receipt.producer.runId !== candidateRunId || receipt.producer.runAttempt !== 1
    || receipt.producer.sourceCommitSha !== config.productionSha || receipt.producer.workflowPath !== PRODUCER
    || receipt.candidate.releaseKind !== "live") throw new Error("Candidate receipt differs from the exact scheduled run.");
  const candidate = await boundedApi.get(`repos/${REPOSITORY}/actions/artifacts/${receipt.candidate.artifactId}`) as GitHubArtifact;
  if (candidate?.id !== receipt.candidate.artifactId || candidate.digest !== receipt.candidate.artifactDigest
    || candidate.name !== receipt.candidate.artifactName || candidate.expired !== false
    || candidate.workflow_run?.id !== candidateRunId || candidate.workflow_run?.head_sha !== config.productionSha) {
    throw new Error("Live candidate artifact differs from its retained receipt.");
  }
  const bundle = await artifactEntries(boundedApi, candidate, ["release-manifest.json", "site.tar"]);
  const manifestBytes = bundle.get("release-manifest.json")!;
  const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
  const manifest = validatePublicationReleaseManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (manifestDigest !== receipt.candidate.manifestSha256 || manifest.releaseId !== receipt.candidate.releaseId
    || manifest.source.commitSha !== config.productionSha || manifest.source.workflowRunId !== candidateRunId
    || manifest.menu?.serviceDate !== serviceDate || manifest.menu.coverage !== "complete"
    || manifest.menu.omissions["invalid-name"] !== 0) {
    throw new Error("Candidate manifest is outside complete-coverage standing policy.");
  }
  remainingMs();
  const expiresAt = Math.min(wallStartMs + RUN_LIMIT_MS, Date.parse(manifest.menu.earliestFreshUntil) - 60 * 60_000);
  const assertPromotionHeadroom = () => {
    const now = wallNowMs();
    if (!Number.isFinite(now) || expiresAt < now + 45 * 60_000) {
      throw new Error("Candidate lacks time for unattended publication and verification.");
    }
  };
  assertPromotionHeadroom();
  await checkPin();
  const predecessor = await observePublic(boundedFetch);
  remainingMs();
  if (predecessor.state !== "present" || predecessor.releaseId !== checkpoint.checkpoint.publication.releaseId) {
    throw new Error("Public predecessor changed before publication dispatch.");
  }
  assertPromotionHeadroom();
  const promotionRunId = await boundedApi.dispatch(PROMOTION, branch, {
    publication_mode: "automatic", operation: "promote", candidate_run_id: String(candidateRunId),
    candidate_artifact_id: String(candidate.id), candidate_artifact_digest: candidate.digest,
    candidate_manifest_sha256: manifestDigest, expected_release_id: manifest.releaseId,
    expected_source_sha: config.productionSha, expected_service_date: serviceDate,
    expected_workflow_sha: config.productionSha, expected_predecessor_release_id: predecessor.releaseId,
    approval_expires_at: new Date(expiresAt).toISOString(), rollback_receipt_artifact_id: "NONE",
    rollback_receipt_artifact_digest: "NONE", confirmation: "PROMOTE_EXACT_LIONLOG_RELEASE",
  });
  await summary(`Publication run: [${promotionRunId}](https://github.com/${REPOSITORY}/actions/runs/${promotionRunId})`);
  remainingMs();
  await waitForRun(boundedApi, promotionRunId, PROMOTION, PROMOTION_WORKFLOW_ID, config, sleep, remainingMs);
  await checkPin();
  remainingMs();
  const checkpointRunId = await boundedApi.dispatch(CHECKPOINT, branch, { expected_promotion_run_id: String(promotionRunId) });
  await summary(`Checkpoint run: [${checkpointRunId}](https://github.com/${REPOSITORY}/actions/runs/${checkpointRunId})`);
  remainingMs();
  await waitForRun(boundedApi, checkpointRunId, CHECKPOINT, undefined, config, sleep, remainingMs);
  const advanced = await readCheckpoint({ token: options.token, authorizedWriterId: options.writerId,
    fetchImpl: boundedFetch });
  remainingMs();
  if (advanced.checkpoint.boundary.runId !== promotionRunId
    || advanced.checkpoint.publication.releaseId !== manifest.releaseId) {
    throw new Error("Terminal checkpoint does not bind the verified publication.");
  }
  await summary(`Verified service date ${serviceDate}; release ${manifest.releaseId}`);
  remainingMs();
  return { candidateRunId, promotionRunId, checkpointRunId };
}

class GitHubApi implements DailyApi {
  private readonly token: string;
  constructor(token: string) { this.token = token; }
  private async request(route: string, body?: unknown, budgetMs?: number): Promise<Response> {
    const timeout = Math.min(30_000, budgetMs ?? 30_000);
    if (!Number.isFinite(timeout) || timeout < 1) throw new Error("GitHub request has no daily window remaining.");
    const response = await fetch(`https://api.github.com/${route}`, { method: body === undefined ? "GET" : "POST",
      redirect: "error", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2026-03-10", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(Math.floor(timeout)) });
    if (!response.ok || response.redirected) throw new Error(`GitHub API ${route} returned HTTP ${response.status}.`);
    return response;
  }
  async get(route: string, budgetMs?: number): Promise<unknown> { return (await this.request(route, undefined, budgetMs)).json(); }
  async bytes(route: string, budgetMs?: number): Promise<Buffer> {
    const timeout = Math.min(120_000, budgetMs ?? 120_000);
    if (!Number.isFinite(timeout) || timeout < 1) throw new Error("Artifact request has no daily window remaining.");
    const response = await fetch(`https://api.github.com/${route}`, { redirect: "follow",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2026-03-10" }, signal: AbortSignal.timeout(Math.floor(timeout)) });
    if (!response.ok || !response.url.startsWith("https://")) throw new Error(`Artifact download returned HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 115 * 1024 * 1024) throw new Error("Artifact download size is invalid.");
    return bytes;
  }
  async dispatch(workflow: string, branch: string, inputs: Record<string, string>, budgetMs?: number): Promise<number> {
    let response: Response;
    try {
      response = await this.request(`repos/${REPOSITORY}/actions/workflows/${workflow.slice(workflow.lastIndexOf("/") + 1)}/dispatches`,
        { ref: branch, inputs, return_run_details: true }, budgetMs);
    } catch (error) {
      throw new Error("Dispatch response is unavailable or uncertain; do not retry automatically.", { cause: error });
    }
    if (response.status !== 200) throw new Error("Dispatch returned no exact run ID; do not retry automatically.");
    const result = await response.json() as { workflow_run_id?: unknown };
    if (!Number.isSafeInteger(result.workflow_run_id) || (result.workflow_run_id as number) < 1) {
      throw new Error("Dispatch did not return a valid exact run ID; do not retry automatically.");
    }
    return result.workflow_run_id as number;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const token = process.env.GH_TOKEN ?? "";
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const summary = async (line: string) => { if (summaryPath) await appendFile(summaryPath, `- ${line}\n`); };
  try {
    await runDailyPublication({ api: new GitHubApi(token), token, repository: process.env.GITHUB_REPOSITORY ?? "",
      event: process.env.GITHUB_EVENT_NAME ?? "", workflowRef: process.env.GITHUB_WORKFLOW_REF ?? "",
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT), now: new Date(), summary,
      schedulerRunId: Number(process.env.GITHUB_RUN_ID), schedulerSha: process.env.GITHUB_SHA ?? "",
      configuration: { activation: process.env.LIONLOG_REFRESH_ACTIVATION ?? "",
        sourceAuthorization: process.env.LIONLOG_REFRESH_SOURCE_AUTHORIZATION ?? "",
        productionRef: process.env.LIONLOG_PRODUCTION_REF ?? "", productionSha: process.env.LIONLOG_PRODUCTION_SHA ?? "" },
      standingPolicy: process.env.LIONLOG_STANDING_PUBLICATION_POLICY ?? "",
      writerId: Number(process.env.LIONLOG_PUBLICATION_WRITER_ID), });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await summary(`Daily publication stopped: ${reason}`);
    console.error(reason);
    process.exitCode = 1;
  }
}
