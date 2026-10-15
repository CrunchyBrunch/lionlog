import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPsuHall, sourceDateFromIso } from "../infrastructure/psu/constants.ts";
import { PsuIngestionPipeline } from "../infrastructure/psu/ingestion-pipeline.ts";
import { parsePsuMealOptionsHtml } from "../infrastructure/psu/menu-parser.ts";
import {
  buildReleaseQueries,
  PSU_RELEASE_HALL_IDS,
  PSU_RELEASE_MAXIMUM_ATTEMPTS_PER_OPERATION,
  PSU_RELEASE_MAXIMUM_ITEMS,
  PSU_RELEASE_MAXIMUM_REQUESTS,
  PSU_RELEASE_MAXIMUM_UNIQUE_NUTRITION_OBSERVATIONS,
  PSU_RELEASE_MAXIMUM_JITTER_MS,
  PSU_RELEASE_MINIMUM_INTERVAL_MS,
  PSU_RELEASE_REQUEST_BUDGET,
  validatePsuReleaseReport,
} from "../infrastructure/psu/release-plan.ts";
import { PsuHttpRetriever } from "../infrastructure/psu/retriever.ts";
import { FilePsuSnapshotStore } from "../infrastructure/psu/snapshot-store.ts";
import { assertTrustedReleaseIngestionEnvironment } from "../infrastructure/psu/trusted-release-guard.ts";
import { PsuRetrievalError } from "../infrastructure/psu/errors.ts";
import { validateRefreshAccounting } from "./refresh-policy.ts";

assertTrustedReleaseIngestionEnvironment();
const argumentsByName = parseArguments(process.argv.slice(2));
const serviceDate = argumentsByName.get("date") ?? "";
sourceDateFromIso(serviceDate);
const cacheDirectory = path.resolve(argumentsByName.get("cache-dir") ?? "work/psu-field-release-cache");
const reportPath = path.resolve(argumentsByName.get("report") ?? "work/psu-field-release/report.json");
const startedAt = new Date();
const automatic = process.env.LIONLOG_REFRESH_MODE === "automatic";
const maximumRequests = automatic ? Number(process.env.LIONLOG_REMAINING_REQUESTS) : PSU_RELEASE_MAXIMUM_REQUESTS;
const retriever = new PsuHttpRetriever({
  allowNetwork: true,
  minimumIntervalMs: PSU_RELEASE_MINIMUM_INTERVAL_MS,
  jitterMs: PSU_RELEASE_MAXIMUM_JITTER_MS,
  timeoutMs: 10_000,
  maximumAttempts: PSU_RELEASE_MAXIMUM_ATTEMPTS_PER_OPERATION,
  baseBackoffMs: 1_000,
  maximumRequests,
  maximumElapsedMs: PSU_RELEASE_REQUEST_BUDGET.ingestionWindowMs,
});
const store = new FilePsuSnapshotStore(cacheDirectory);
let pipeline: PsuIngestionPipeline | undefined;
try {
const sourceDate = sourceDateFromIso(serviceDate);
const mealsByHall = new Map();
for (const hallId of PSU_RELEASE_HALL_IDS) {
  const hall = getPsuHall(hallId);
  const response = await retriever.retrieveMealOptions({ sourceDate, sourceCampusId: hall.sourceCampusId });
  mealsByHall.set(hallId, parsePsuMealOptionsHtml(response.html, {
    sourceCampusId: hall.sourceCampusId,
    sourceDate,
  }));
}

const queries = buildReleaseQueries(serviceDate, mealsByHall);
pipeline = new PsuIngestionPipeline(retriever, store, {
  policy: {
    menuFreshForMs: 18 * 60 * 60 * 1_000,
    lastKnownGoodForMs: 48 * 60 * 60 * 1_000,
    nutritionFreshForMs: 24 * 60 * 60 * 1_000,
  },
  maximumStationsPerQuery: 100,
  maximumItemsPerQuery: 1_000,
  maximumNutritionHandlesPerQuery: 1_000,
  maximumNutritionHandlesTotal: PSU_RELEASE_MAXIMUM_UNIQUE_NUTRITION_OBSERVATIONS,
});
const queryReports = [];
let itemCount = 0;
let sourceObservationCount = 0;
let invalidNameOmissions = 0;
let nutritionRequests = 0;
let nutritionCacheHits = 0;
writeAggregateProgress("planned", queries.length);
try {
  for (const query of queries) {
    const result = await pipeline.run(query);
    if (result.state !== "live") throw result.error;
    itemCount += result.report.itemCount;
    sourceObservationCount += result.report.sourceObservationCount;
    invalidNameOmissions += result.report.omissions["invalid-name"];
    nutritionRequests += result.report.nutritionRequests;
    nutritionCacheHits += result.report.nutritionCacheHits;
    if (itemCount > PSU_RELEASE_MAXIMUM_ITEMS) throw new Error("Release item count exceeded its bound.");
    queryReports.push({
      serviceDate,
      hallId: query.hallId,
      mealPeriodId: query.mealPeriodId,
      sourceMeal: result.snapshot.query.sourceMeal,
      recognizedEmpty: result.report.sourceObservationCount === 0,
      itemCount: result.report.itemCount,
      coverage: result.report.coverage,
      sourceObservationCount: result.report.sourceObservationCount,
      publishedObservationCount: result.report.publishedObservationCount,
      omissions: result.report.omissions,
      snapshotId: result.snapshot.snapshotId,
      retrievedAt: result.snapshot.retrievedAt,
    });
    writeAggregateProgress("query-complete", queries.length);
  }
} catch (error) {
  writeAggregateProgress("failed", queries.length);
  throw error;
}

const report = validatePsuReleaseReport({
  reportVersion: "lionlog.psu-field-release-report.v2",
  serviceDate,
  commitSha: process.env.GITHUB_SHA,
  startedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  hallIds: [...PSU_RELEASE_HALL_IDS],
  queryCount: queryReports.length,
  itemCount,
  coverage: invalidNameOmissions === 0 ? "complete" : "partial",
  sourceObservationCount,
  publishedObservationCount: itemCount,
  omissions: { "invalid-name": invalidNameOmissions },
  requestCount: retriever.requestCount,
  nutritionRequests,
  nutritionCacheHits,
  queries: queryReports,
});
await writeJsonAtomically(reportPath, report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await writeRefreshAccounting("candidate-ready");
} catch (error) {
  await writeRefreshAccounting(error instanceof PsuRetrievalError && error.retryable
    ? "transient-prepublication-failure" : "structural-failure");
  throw error;
}

async function writeRefreshAccounting(outcome: "candidate-ready" | "transient-prepublication-failure" | "structural-failure"): Promise<void> {
  if (!automatic) return;
  const accountingPath = process.env.LIONLOG_REFRESH_ACCOUNTING_PATH;
  if (!accountingPath) throw new Error("Automatic refresh accounting path is missing.");
  const record = validateRefreshAccounting({
    accountingVersion: "lionlog.refresh-accounting.v1",
    repository: process.env.GITHUB_REPOSITORY,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    workflowSha: process.env.GITHUB_SHA,
    workflowRef: process.env.GITHUB_REF,
    serviceDate,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    upstreamAttempts: retriever.requestCount,
    outcome,
  });
  await writeJsonAtomically(path.resolve(accountingPath), record);
}

function writeAggregateProgress(phase: "planned" | "query-complete" | "failed", plannedQueries: number): void {
  process.stdout.write(`${JSON.stringify({
    event: "lionlog.psu-field-release-progress.v1",
    phase,
    plannedQueries,
    completedQueries: pipeline?.telemetry.completedQueries ?? 0,
    uniqueNutritionObservations: pipeline?.telemetry.uniqueNutritionObservations ?? 0,
    nutritionCacheHits: pipeline?.telemetry.nutritionCacheHits ?? 0,
    requestBudget: {
      maximumUpstreamAttempts: maximumRequests,
      maximumUniqueNutritionObservations: PSU_RELEASE_MAXIMUM_UNIQUE_NUTRITION_OBSERVATIONS,
      maximumAttemptsPerOperation: PSU_RELEASE_REQUEST_BUDGET.maximumAttemptsPerOperation,
    },
    upstream: retriever.telemetry,
  })}\n`);
}

function parseArguments(values: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const value of values) {
    const match = /^--([a-z-]+)=(.+)$/.exec(value);
    if (!match) throw new Error(`Unexpected argument: ${value}`);
    parsed.set(match[1], match[2]);
  }
  return parsed;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const stagingPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(stagingPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rm(filePath, { force: true });
    await rename(stagingPath, filePath);
  } finally {
    await unlink(stagingPath).catch(() => undefined);
  }
}
