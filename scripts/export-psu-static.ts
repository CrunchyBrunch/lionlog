import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPsuHall, getPsuMealPeriod, PSU_PARSER_VERSION, PSU_SNAPSHOT_VERSION } from "../infrastructure/psu/constants.ts";
import {
  catalogEntryForSnapshot,
  PSU_CATALOG_VERSION,
  validatePsuPublicationCatalog,
  type PsuPublicationCatalog,
} from "../infrastructure/psu/publication-catalog.ts";
import { validatePsuSnapshot } from "../infrastructure/psu/snapshot-schema.ts";
import { FilePsuSnapshotStore } from "../infrastructure/psu/snapshot-store.ts";
import { releaseQueryKey, validatePsuReleaseReport, type PsuReleaseReport } from "../infrastructure/psu/release-plan.ts";

const argumentsByName = parseArguments(process.argv.slice(2));
if (argumentsByName.has("help")) {
  process.stdout.write([
    "Export validated ingestion snapshots as static same-origin menu data.",
    "",
    "Usage:",
    "  npm run export:psu-static -- --cache-dir=work/psu-ingestion --output-dir=public",
    "",
    "The command writes <output-dir>/menu-data/v1/catalog.json and independently loadable snapshots.",
  ].join("\n") + "\n");
  process.exit(0);
}

const cacheDirectory = path.resolve(argumentsByName.get("cache-dir") ?? "work/psu-ingestion");
const outputDirectory = path.resolve(argumentsByName.get("output-dir") ?? "public");
const generatedAt = parseGeneratedAt(argumentsByName.get("generated-at"));
const releaseReport = await readReleaseReport(argumentsByName.get("release-report"));
const store = new FilePsuSnapshotStore(cacheDirectory);
const snapshots = (await store.listMenus()).map(validatePsuSnapshot)
  .sort((left, right) => menuKey(left.query).localeCompare(menuKey(right.query)));
if (snapshots.length === 0) throw new Error(`No validated PSU menu snapshots found in ${cacheDirectory}.`);
if (releaseReport) assertExactReleaseSet(snapshots, releaseReport);

const publicationDirectory = path.join(outputDirectory, "menu-data", "v1");
const stagingDirectory = `${publicationDirectory}.staging-${process.pid}`;
await rm(stagingDirectory, { recursive: true, force: true });
await mkdir(stagingDirectory, { recursive: true });

try {
  const entries = [];
  for (const snapshot of snapshots) {
    const relativeUrl = `./snapshots/${snapshot.query.serviceDate}/${snapshot.query.sourceCampusId}/${snapshot.query.mealPeriodId}.json`;
    const filePath = path.join(stagingDirectory, relativeUrl.slice(2));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    validatePsuSnapshot(JSON.parse(await readFile(filePath, "utf8")));
    entries.push(catalogEntryForSnapshot(snapshot, relativeUrl));
  }

  const hallIds = [...new Set(snapshots.map((snapshot) => snapshot.query.hallId))].sort();
  const mealPeriodIds = [...new Set(snapshots.map((snapshot) => snapshot.query.mealPeriodId))].sort();
  const catalog: PsuPublicationCatalog = validatePsuPublicationCatalog({
    catalogVersion: PSU_CATALOG_VERSION,
    snapshotSchemaVersion: PSU_SNAPSHOT_VERSION,
    parserVersion: PSU_PARSER_VERSION,
    generatedAt: generatedAt.toISOString(),
    publication: releaseReport ? {
      mode: "field-release",
      sourceKind: "psu-public-menu-html",
      commitSha: releaseReport.commitSha,
      serviceDate: releaseReport.serviceDate,
      hallIds,
      retrievalStartedAt: releaseReport.startedAt,
      retrievalCompletedAt: releaseReport.completedAt,
      expectedSnapshotCount: releaseReport.queryCount,
      publishedSnapshotCount: snapshots.length,
      recognizedEmptySnapshotCount: releaseReport.queries.filter((query) => query.recognizedEmpty).length,
      itemCount: releaseReport.itemCount,
      requestCount: releaseReport.requestCount,
      nutritionRequests: releaseReport.nutritionRequests,
      nutritionCacheHits: releaseReport.nutritionCacheHits,
    } : {
      mode: "manual-export",
      sourceKind: "psu-public-menu-html",
      commitSha: null,
      serviceDate: null,
      hallIds,
      retrievalStartedAt: null,
      retrievalCompletedAt: null,
      expectedSnapshotCount: snapshots.length,
      publishedSnapshotCount: snapshots.length,
      recognizedEmptySnapshotCount: snapshots.filter((snapshot) => snapshot.stations.every((station) => station.items.length === 0)).length,
      itemCount: snapshots.reduce((total, snapshot) => total + snapshot.stations.reduce((subtotal, station) => subtotal + station.items.length, 0), 0),
      requestCount: null,
      nutritionRequests: null,
      nutritionCacheHits: null,
    },
    serviceDates: [...new Set(snapshots.map((snapshot) => snapshot.query.serviceDate))].sort(),
    halls: hallIds.map((id) => ({ id, displayName: getPsuHall(id).displayName })),
    mealPeriods: mealPeriodIds.map((id) => ({ id, displayName: getPsuMealPeriod(id).displayName })),
    snapshots: entries,
  });
  await writeFile(path.join(stagingDirectory, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  validatePsuPublicationCatalog(JSON.parse(await readFile(path.join(stagingDirectory, "catalog.json"), "utf8")));

  await mkdir(path.dirname(publicationDirectory), { recursive: true });
  await rm(publicationDirectory, { recursive: true, force: true });
  await rename(stagingDirectory, publicationDirectory);
  process.stdout.write(`${JSON.stringify({
    catalog: path.join(publicationDirectory, "catalog.json"),
    generatedAt: catalog.generatedAt,
    snapshotCount: catalog.snapshots.length,
    serviceDates: catalog.serviceDates,
    halls: catalog.halls.map((hall) => hall.id),
    mealPeriods: catalog.mealPeriods.map((period) => period.id),
  }, null, 2)}\n`);
} catch (error) {
  await rm(stagingDirectory, { recursive: true, force: true });
  throw error;
}

async function readReleaseReport(value: string | undefined): Promise<PsuReleaseReport | null> {
  if (!value) return null;
  return validatePsuReleaseReport(JSON.parse(await readFile(path.resolve(value), "utf8")));
}

function assertExactReleaseSet(
  snapshots: readonly ReturnType<typeof validatePsuSnapshot>[],
  report: PsuReleaseReport,
): void {
  const snapshotsByKey = new Map(snapshots.map((snapshot) => [releaseQueryKey(snapshot.query), snapshot]));
  if (snapshotsByKey.size !== report.queries.length || snapshots.length !== report.queries.length) {
    throw new Error("Validated cache does not contain the exact release query set.");
  }
  for (const query of report.queries) {
    const snapshot = snapshotsByKey.get(releaseQueryKey(query));
    if (!snapshot || snapshot.snapshotId !== query.snapshotId || snapshot.retrievedAt !== query.retrievedAt) {
      throw new Error(`Validated cache does not match release query ${releaseQueryKey(query)}.`);
    }
  }
}

function parseArguments(values: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const value of values) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(value);
    if (!match) throw new Error(`Unexpected argument: ${value}`);
    parsed.set(match[1], match[2] ?? "true");
  }
  return parsed;
}

function parseGeneratedAt(value: string | undefined): Date {
  if (!value) return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("--generated-at must be an ISO date-time.");
  return date;
}

function menuKey(query: { serviceDate: string; hallId: string; mealPeriodId: string }): string {
  return [query.serviceDate, query.hallId, query.mealPeriodId].join("\u001f");
}
