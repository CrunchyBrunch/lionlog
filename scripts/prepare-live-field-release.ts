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

assertTrustedReleaseIngestionEnvironment();
const argumentsByName = parseArguments(process.argv.slice(2));
const serviceDate = argumentsByName.get("date") ?? "";
sourceDateFromIso(serviceDate);
const cacheDirectory = path.resolve(argumentsByName.get("cache-dir") ?? "work/psu-field-release-cache");
const reportPath = path.resolve(argumentsByName.get("report") ?? "work/psu-field-release/report.json");
const startedAt = new Date();
const retriever = new PsuHttpRetriever({
  allowNetwork: true,
  minimumIntervalMs: PSU_RELEASE_MINIMUM_INTERVAL_MS,
  jitterMs: PSU_RELEASE_MAXIMUM_JITTER_MS,
  timeoutMs: 10_000,
  maximumAttempts: PSU_RELEASE_MAXIMUM_ATTEMPTS_PER_OPERATION,
  baseBackoffMs: 1_000,
  maximumRequests: PSU_RELEASE_MAXIMUM_REQUESTS,
  maximumElapsedMs: PSU_RELEASE_REQUEST_BUDGET.ingestionWindowMs,
});
const store = new FilePsuSnapshotStore(cacheDirectory);
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
const pipeline = new PsuIngestionPipeline(retriever, store, {
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
    if (result.state !== "live") throw new Error(`Release query failed closed: ${result.error.message}`);
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

function writeAggregateProgress(phase: "planned" | "query-complete" | "failed", plannedQueries: number): void {
  process.stdout.write(`${JSON.stringify({
    event: "lionlog.psu-field-release-progress.v1",
    phase,
    plannedQueries,
    completedQueries: pipeline.telemetry.completedQueries,
    uniqueNutritionObservations: pipeline.telemetry.uniqueNutritionObservations,
    nutritionCacheHits: pipeline.telemetry.nutritionCacheHits,
    requestBudget: {
      maximumUpstreamAttempts: PSU_RELEASE_MAXIMUM_REQUESTS,
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
