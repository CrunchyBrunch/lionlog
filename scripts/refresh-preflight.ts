/** Read-only GitHub evidence for an inactive, explicitly authorized refresh run. */
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArtifactZip } from "./artifact-zip.ts";
import { LIVE_CANDIDATE_WORKFLOW_ID, PROMOTION_WORKFLOW_ID } from "../infrastructure/publication/release-contract.ts";
import { assertRefreshConfiguration, evaluateRefreshPolicy, validateRefreshAccounting, type RefreshAccounting, type RefreshConfiguration } from "./refresh-policy.ts";

const REPOSITORY = "CrunchyBrunch/lionlog";
const PRODUCER = ".github/workflows/build-live-menu-artifact.yml";
const DEPLOYER = ".github/workflows/deploy-github-pages.yml";
interface Run { id: number; head_sha: string; head_branch: string; event: string; run_attempt: number;
  status: string; conclusion: string | null; created_at: unknown; updated_at?: unknown; run_started_at?: unknown; path: string }
interface Artifact { id: number; name: string; digest: string; expired: boolean; workflow_run: { id: number; head_sha: string } }
interface Api { getJson(path: string): Promise<unknown>; getBytes(path: string): Promise<Buffer> }

export async function preflightAutomaticRefresh(options: {
  api: Api; configuration: RefreshConfiguration; repository: string; workflowRef: string; workflowSha: string;
  runId: number; runAttempt: number; serviceDate: string; trigger: "primary" | "recovery"; now: Date;
}): Promise<number> {
  if (options.repository !== REPOSITORY) throw new Error("Refresh repository is not authorized.");
  assertRefreshConfiguration(options.configuration);
  if (options.workflowRef !== `${REPOSITORY}/${PRODUCER}@${options.configuration.productionRef}`
    || options.workflowSha !== options.configuration.productionSha || options.runAttempt !== 1) {
    throw new Error("Automatic producer workflow and source differ from the approved pin.");
  }
  const branch = options.configuration.productionRef.replace(/^refs\/heads\//, "");
  const candidateRuns = await completeRuns(options.api, PRODUCER, options.serviceDate, options.runId);
  if (candidateRuns.some((run) => run.head_branch === "main")) {
    throw new Error("A same-day manual candidate attempt pauses automatic refresh.");
  }
  if (candidateRuns.some((run) => run.head_branch !== branch)) {
    throw new Error("A same-day candidate attempt on another production pin pauses automatic refresh.");
  }
  const deployRuns = await completeRuns(options.api, DEPLOYER, options.serviceDate, options.runId);
  const publication = deployRuns.length === 0 ? "none" : "uncertain";
  const attempts: RefreshAccounting[] = [];
  for (const run of candidateRuns) {
    if (run.status !== "completed" || run.run_attempt !== 1 || run.event !== "workflow_dispatch"
      || run.path !== PRODUCER || run.head_branch !== branch || run.head_sha !== options.configuration.productionSha) {
      throw new Error("Candidate history is incomplete or differs from the production pin.");
    }
    const metadata = await options.api.getJson(`repos/${REPOSITORY}/actions/runs/${run.id}/artifacts?per_page=100`);
    const artifacts = (metadata as { total_count?: number; artifacts?: Artifact[] }).artifacts;
    if (!artifacts || (metadata as { total_count?: number }).total_count !== artifacts.length) {
      throw new Error("Candidate accounting artifact enumeration is incomplete.");
    }
    const matches = artifacts?.filter((item) => item.name === `lionlog-refresh-accounting-${run.id}-1`) ?? [];
    if (matches.length !== 1 || matches[0].expired || !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest)
      || matches[0].workflow_run?.id !== run.id || matches[0].workflow_run.head_sha !== run.head_sha) {
      throw new Error("Missing or ambiguous retained refresh accounting pauses recovery.");
    }
    const wrapper = await options.api.getBytes(`repos/${REPOSITORY}/actions/artifacts/${matches[0].id}/zip`);
    if (wrapper.byteLength > 1_048_576 || `sha256:${createHash("sha256").update(wrapper).digest("hex")}` !== matches[0].digest) {
      throw new Error("Refresh accounting artifact digest or size is invalid.");
    }
    const entries = parseArtifactZip(wrapper, ["refresh-accounting.json"]);
    const record = validateRefreshAccounting(JSON.parse(entries[0].data.toString("utf8")));
    if (record.runId !== run.id || record.workflowSha !== run.head_sha || record.workflowRef !== `refs/heads/${branch}`
      || record.serviceDate !== options.serviceDate
      || (record.outcome === "candidate-ready" && run.conclusion !== "success")
      || (record.outcome === "transient-prepublication-failure" && run.conclusion !== "failure")
      || (run.conclusion === "success" && record.outcome !== "candidate-ready")) {
      throw new Error("Refresh accounting is inconsistent with the exact candidate run.");
    }
    attempts.push(record);
  }
  return evaluateRefreshPolicy({
    configuration: options.configuration,
    invocation: { repository: options.repository, workflowRef: options.workflowRef, workflowSha: options.workflowSha,
      runId: options.runId, runAttempt: options.runAttempt, serviceDate: options.serviceDate },
    trigger: options.trigger, now: options.now, completeHistory: true, attempts, publication,
  }).remainingRequests;
}

export async function assertNoAutomaticCandidateConflict(options: {
  api: Api; activation: string; productionRef: string; serviceDate: string; currentRunId: number;
}): Promise<void> {
  if (options.activation !== "ENABLE_AUTOMATIC_LIONLOG_REFRESH") return;
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.productionRef)
    || options.productionRef === "refs/heads/main") {
    throw new Error("Active automatic production ref is invalid.");
  }
  const runs = await completeRuns(options.api, PRODUCER, options.serviceDate, options.currentRunId);
  if (runs.length !== 0) throw new Error("A same-day automatic candidate attempt blocks duplicate manual ingestion.");
}

async function completeRuns(api: Api, workflow: string, serviceDate: string, currentRunId: number): Promise<Run[]> {
  const workflowId = workflow === PRODUCER ? LIVE_CANDIDATE_WORKFLOW_ID : PROMOTION_WORKFLOW_ID;
  const all: Array<{ run: Run; updatedMs: number | undefined }> = [];
  const seen = new Set<number>();
  let lastCreatedMs = Number.POSITIVE_INFINITY;
  let expectedTotal: number | undefined;
  for (let page = 1; page <= 10; page += 1) {
    const data = await api.getJson(`repos/${REPOSITORY}/actions/workflows/${workflowId}/runs?event=workflow_dispatch&per_page=100&page=${page}`);
    const response = data as { total_count?: unknown; workflow_runs?: Run[] };
    const runs = response?.workflow_runs;
    const total = response?.total_count;
    if (!Number.isSafeInteger(total) || (total as number) < 0 || (total as number) > 1_000
      || !Array.isArray(runs) || runs.length !== Math.min(100, (total as number) - all.length)
      || (expectedTotal !== undefined && total !== expectedTotal)) {
      throw new Error("Refresh run history count or pagination is incomplete.");
    }
    expectedTotal = total as number;
    for (const run of runs) {
      if (!Number.isSafeInteger(run?.id) || run.id < 1 || seen.has(run.id)) {
        throw new Error("Refresh run history contains a duplicate or invalid run ID.");
      }
      seen.add(run.id);
      const createdMs = runTime(run.created_at, "creation");
      const startedMs = optionalRunTime(run.run_started_at, "start");
      const updatedMs = optionalRunTime(run.updated_at, "update");
      if ((startedMs !== undefined && startedMs < createdMs)
        || (updatedMs !== undefined && (updatedMs < createdMs || (startedMs !== undefined && updatedMs < startedMs)))) {
        throw new Error("Refresh run activity times are inconsistent.");
      }
      if (createdMs > lastCreatedMs) throw new Error("Refresh run history ordering is incomplete.");
      lastCreatedMs = createdMs;
      all.push({ run, updatedMs });
    }
    if (all.length === expectedTotal) break;
  }
  if (expectedTotal === undefined || all.length !== expectedTotal) {
    throw new Error("Refresh run history exceeded the bounded enumeration window.");
  }
  return all.filter(({ run, updatedMs }) => {
    if (run.id === currentRunId) return false;
    // A completed run can be excluded only when its terminal update proves the entire activity interval is older.
    if (run.status !== "completed" || updatedMs === undefined) return true;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(updatedMs));
    const field = (name: string) => parts.find((part) => part.type === name)?.value ?? "";
    return `${field("year")}-${field("month")}-${field("day")}` >= serviceDate;
  }).map(({ run }) => run);
}

function runTime(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error(`Refresh run ${field} time is invalid.`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error(`Refresh run ${field} time is invalid.`);
  }
  return epoch;
}

function optionalRunTime(value: unknown, field: string): number | undefined {
  return value === undefined || value === null ? undefined : runTime(value, field);
}

async function githubApi(token: string): Promise<Api> {
  const request = async (path: string): Promise<Response> => {
    const response = await fetch(`https://api.github.com/${path}`, { headers: {
      authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
    }, redirect: path.endsWith("/zip") ? "follow" : "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`GitHub evidence request failed: ${response.status}`);
    return response;
  };
  return {
    getJson: async (path) => (await request(path)).json(),
    getBytes: async (path) => {
      const response = await request(path);
      if (!response.url.startsWith("https://") || Number(response.headers.get("content-length") ?? 0) > 1_048_576) {
        throw new Error("Refresh accounting wrapper size or origin is invalid.");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Refresh accounting wrapper has no response body.");
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > 1_048_576) throw new Error("Refresh accounting wrapper exceeded its size bound.");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const env = process.env;
  const config = { activation: env.LIONLOG_REFRESH_ACTIVATION ?? "", sourceAuthorization: env.LIONLOG_REFRESH_SOURCE_AUTHORIZATION ?? "",
    productionRef: env.LIONLOG_PRODUCTION_REF ?? "", productionSha: env.LIONLOG_PRODUCTION_SHA ?? "" };
  if (!env.GITHUB_TOKEN || !env.GITHUB_OUTPUT) throw new Error("Refresh evidence token or output is unavailable.");
  const api = await githubApi(env.GITHUB_TOKEN);
  if (process.argv.includes("--manual-conflict")) {
    await assertNoAutomaticCandidateConflict({ api, activation: config.activation, productionRef: config.productionRef,
      serviceDate: env.SERVICE_DATE ?? "", currentRunId: Number(env.GITHUB_RUN_ID) });
  } else {
    if (env.REFRESH_TRIGGER !== "primary" && env.REFRESH_TRIGGER !== "recovery") {
      throw new Error("Automatic refresh opportunity is invalid.");
    }
    const remaining = await preflightAutomaticRefresh({ api, configuration: config,
      repository: env.GITHUB_REPOSITORY ?? "", workflowRef: env.GITHUB_WORKFLOW_REF ?? "", workflowSha: env.GITHUB_SHA ?? "",
      runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT), serviceDate: env.SERVICE_DATE ?? "",
      trigger: env.REFRESH_TRIGGER, now: new Date() });
    await appendFile(env.GITHUB_OUTPUT, `remaining_requests=${remaining}\nopportunity=${env.REFRESH_TRIGGER}\n`);
  }
}
