import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPsuHall, sourceDateFromIso } from "../infrastructure/psu/constants.ts";
import { PsuIngestionPipeline } from "../infrastructure/psu/ingestion-pipeline.ts";
import { parsePsuMealOptionsHtml } from "../infrastructure/psu/menu-parser.ts";
import {
  buildReleaseQueries,
  PSU_RELEASE_HALL_IDS,
  PSU_RELEASE_MAXIMUM_ITEMS,
  PSU_RELEASE_MAXIMUM_REQUESTS,
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
  minimumIntervalMs: 1_000,
  jitterMs: 250,
  timeoutMs: 10_000,
  maximumAttempts: 3,
  baseBackoffMs: 1_000,
  maximumRequests: PSU_RELEASE_MAXIMUM_REQUESTS,
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
});
const queryReports = [];
let itemCount = 0;
let nutritionRequests = 0;
let nutritionCacheHits = 0;
for (const query of queries) {
  const result = await pipeline.run(query);
  if (result.state !== "live") throw new Error(`Release query failed closed (${query.hallId}/${query.mealPeriodId}): ${result.error.message}`);
  itemCount += result.report.itemCount;
  nutritionRequests += result.report.nutritionRequests;
  nutritionCacheHits += result.report.nutritionCacheHits;
  if (itemCount > PSU_RELEASE_MAXIMUM_ITEMS) throw new Error("Release item count exceeded its bound.");
  queryReports.push({
    serviceDate,
    hallId: query.hallId,
    mealPeriodId: query.mealPeriodId,
    sourceMeal: result.snapshot.query.sourceMeal,
    recognizedEmpty: result.report.itemCount === 0,
    itemCount: result.report.itemCount,
    snapshotId: result.snapshot.snapshotId,
    retrievedAt: result.snapshot.retrievedAt,
  });
}

const report = validatePsuReleaseReport({
  reportVersion: "lionlog.psu-field-release-report.v1",
  serviceDate,
  commitSha: process.env.GITHUB_SHA,
  startedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  hallIds: [...PSU_RELEASE_HALL_IDS],
  queryCount: queryReports.length,
  itemCount,
  requestCount: retriever.requestCount,
  nutritionRequests,
  nutritionCacheHits,
  queries: queryReports,
});
await writeJsonAtomically(reportPath, report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

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
