/** Inactive automatic-refresh policy. No timer or workflow dispatch is defined here. */
export const REFRESH_DAILY_UPSTREAM_LIMIT = 1_680;
export const PROPOSED_PRIMARY_MINUTE = 5 * 60 + 17;
export const PROPOSED_PRIMARY_WINDOW_MINUTES = 30;

const REPOSITORY = "CrunchyBrunch/lionlog";
const PRODUCER_WORKFLOW = ".github/workflows/build-live-menu-artifact.yml";
const SHA = /^[a-f0-9]{40}$/;
const BRANCH_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNTING_KEYS = ["accountingVersion", "completedAt", "outcome", "repository", "runAttempt", "runId",
  "serviceDate", "startedAt", "upstreamAttempts", "workflowRef", "workflowSha"];

export interface RefreshAttempt {
  runId: number;
  runAttempt: number;
  workflowSha: string;
  workflowRef: string;
  serviceDate: string;
  startedAt: string;
  upstreamAttempts: number;
  outcome: string;
}

export type RefreshAccounting = RefreshAttempt & {
  accountingVersion: "lionlog.refresh-accounting.v1";
  repository: typeof REPOSITORY;
  completedAt: string;
};

export interface RefreshConfiguration {
  activation: string;
  sourceAuthorization: string;
  productionRef: string;
  productionSha: string;
}

export interface RefreshInvocation {
  repository: string;
  workflowRef: string;
  workflowSha: string;
  runId: number;
  runAttempt: number;
  serviceDate: string;
}

export function assertRefreshConfiguration(config: RefreshConfiguration | null): asserts config is RefreshConfiguration {
  if (!config || config.activation !== "ENABLE_AUTOMATIC_LIONLOG_REFRESH"
    || config.sourceAuthorization !== "I_APPROVE_AUTOMATIC_PSU_REQUESTS") {
    throw new Error("Automatic refresh source authorization is inactive.");
  }
  if (!BRANCH_REF.test(config.productionRef) || config.productionRef === "refs/heads/main"
    || !SHA.test(config.productionSha)) throw new Error("Automatic production pin is invalid.");
}

export function validateRefreshAccounting(value: unknown): RefreshAccounting {
  const record = value as RefreshAccounting;
  if (!hasExactKeys(value, ACCOUNTING_KEYS)
    || record.accountingVersion !== "lionlog.refresh-accounting.v1" || record.repository !== REPOSITORY
    || !positive(record.runId) || record.runAttempt !== 1 || !SHA.test(record.workflowSha)
    || !BRANCH_REF.test(record.workflowRef) || !DATE.test(record.serviceDate)
    || !canonicalTime(record.startedAt) || !canonicalTime(record.completedAt)
    || Date.parse(record.completedAt) < Date.parse(record.startedAt)
    || !Number.isSafeInteger(record.upstreamAttempts) || record.upstreamAttempts < 0
    || record.upstreamAttempts > REFRESH_DAILY_UPSTREAM_LIMIT
    || !["candidate-ready", "transient-prepublication-failure", "structural-failure"].includes(record.outcome)) {
    throw new Error("Refresh accounting schema or request budget is invalid.");
  }
  return structuredClone(record);
}

export function evaluateRefreshPolicy(options: {
  configuration: RefreshConfiguration | null;
  invocation: RefreshInvocation;
  now: Date;
  trigger: "primary" | "recovery";
  completeHistory: boolean;
  attempts: RefreshAttempt[];
  publication: "none" | "known-good" | "uncertain";
}): { kind: "primary" | "recovery"; serviceDate: string; sourceSha: string; remainingRequests: number } {
  const config = options.configuration;
  assertRefreshConfiguration(config);
  const run = options.invocation;
  if (run.repository !== REPOSITORY || run.workflowRef !== `${REPOSITORY}/${PRODUCER_WORKFLOW}@${config.productionRef}`
    || run.workflowSha !== config.productionSha || !positive(run.runId) || run.runAttempt !== 1) {
    throw new Error("Automatic workflow ref, source pin, or run attempt differs from the approved production revision.");
  }
  if (!(options.now instanceof Date) || !Number.isFinite(options.now.getTime())) throw new Error("Refresh time is invalid.");
  const local = newYorkParts(options.now);
  if (!DATE.test(run.serviceDate) || run.serviceDate !== local.date) {
    throw new Error("Automatic service date is not the current New York date.");
  }
  const minute = local.hour * 60 + local.minute;
  if (minute < PROPOSED_PRIMARY_MINUTE) throw new Error("Proposed 05:17 New York refresh is not due.");
  if (options.publication === "known-good") throw new Error("The service date already has a known-good published release.");
  if (options.publication === "uncertain") throw new Error("Uncertain publication pauses automatic refresh.");
  if (options.publication !== "none" || options.completeHistory !== true || !Array.isArray(options.attempts)) {
    throw new Error("Complete refresh history and accounting are required.");
  }
  let spent = 0;
  const seen = new Set<number>();
  for (const entry of options.attempts) {
    if (!positive(entry.runId) || entry.runId >= run.runId || seen.has(entry.runId)
      || entry.runAttempt !== 1 || entry.workflowSha !== config.productionSha
      || entry.workflowRef !== config.productionRef || entry.serviceDate !== run.serviceDate
      || !canonicalTime(entry.startedAt) || newYorkParts(new Date(entry.startedAt)).date !== run.serviceDate
      || !Number.isSafeInteger(entry.upstreamAttempts) || entry.upstreamAttempts < 0
      || entry.upstreamAttempts > REFRESH_DAILY_UPSTREAM_LIMIT) {
      throw new Error("Refresh history accounting, production pin, or request budget is invalid.");
    }
    seen.add(entry.runId);
    spent += entry.upstreamAttempts;
    if (entry.outcome === "candidate-ready") throw new Error("A candidate already exists for this service date.");
    if (entry.outcome === "structural-failure") throw new Error("Structural failure paused automatic refresh.");
    if (entry.outcome === "submission-uncertain") throw new Error("Uncertain submission paused automatic refresh.");
    if (entry.outcome !== "transient-prepublication-failure") {
      throw new Error("Missing or invalid accounting paused automatic refresh.");
    }
  }
  const remainingRequests = REFRESH_DAILY_UPSTREAM_LIMIT - spent;
  if (remainingRequests < 1) throw new Error("The shared daily upstream request budget is exhausted.");
  if (options.attempts.length > 1) throw new Error("The one recovery opportunity was already used.");
  const missedPrimary = minute >= PROPOSED_PRIMARY_MINUTE + PROPOSED_PRIMARY_WINDOW_MINUTES;
  const kind = options.attempts.length === 0 && !missedPrimary ? "primary" : "recovery";
  if (options.trigger !== kind) throw new Error(`A duplicate ${options.trigger} trigger cannot replace the ${kind} opportunity.`);
  return { kind, serviceDate: run.serviceDate, sourceSha: config.productionSha, remainingRequests };
}

function newYorkParts(date: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const field = (name: string) => parts.find((part) => part.type === name)?.value ?? "";
  return { date: `${field("year")}-${field("month")}-${field("day")}`,
    hour: Number(field("hour")), minute: Number(field("minute")) };
}

function hasExactKeys(value: unknown, names: string[]): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());
}

function canonicalTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
