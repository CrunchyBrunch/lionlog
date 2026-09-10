import { PSU_RELEASE_HALL_IDS, PSU_RELEASE_MAXIMUM_QUERIES, PSU_RELEASE_MAXIMUM_REQUESTS } from "../psu/release-plan.ts";
import {
  assertSnapshotMatchesCatalog,
  validatePsuPublicationCatalog,
} from "../psu/publication-catalog.ts";
import { validatePsuSnapshot } from "../psu/snapshot-schema.ts";
import type { PublicationReleaseManifest } from "./release-contract.ts";

const MENU_PREFIX = "menu-data/v2/";
const CATALOG_PATH = `${MENU_PREFIX}catalog.json`;
const FIELD_RELEASE_FRESH_MS = 18 * 60 * 60 * 1_000;
const FIELD_RELEASE_RETAIN_MS = 48 * 60 * 60 * 1_000;

export interface PublicationFileEvidence {
  readonly path: string;
  readonly data: Buffer;
}

export interface DerivedMenuEvidence {
  readonly menu: NonNullable<PublicationReleaseManifest["menu"]>;
  readonly catalogSha256: string;
}

export function deriveMenuEvidence(
  files: readonly PublicationFileEvidence[],
  sourceCommitSha: string,
  sha256: (value: Buffer | string) => string,
  timing: { readonly bundleCreatedAt: string; readonly verificationTime: Date },
): DerivedMenuEvidence {
  const fileMap = new Map(files.map((file) => [file.path, file.data]));
  if (fileMap.size !== files.length) throw new Error("Publication files contain duplicate paths.");
  const catalogBytes = fileMap.get(CATALOG_PATH);
  if (!catalogBytes) throw new Error("Live candidate is missing its catalog bytes.");
  const catalog = validatePsuPublicationCatalog(JSON.parse(catalogBytes.toString("utf8")));
  if (
    catalog.publication.mode !== "field-release"
    || catalog.publication.sourceKind !== "psu-public-menu-html"
    || catalog.publication.commitSha !== sourceCommitSha
    || catalog.publication.serviceDate === null
    || catalog.publication.retrievalStartedAt === null
    || catalog.publication.retrievalCompletedAt === null
  ) throw new Error("Live candidate catalog lacks exact field-release provenance.");
  if (catalog.snapshots.length === 0 || catalog.snapshots.length > PSU_RELEASE_MAXIMUM_QUERIES) {
    throw new Error("Live candidate query set is outside the approved release bound.");
  }
  if ((catalog.publication.requestCount ?? PSU_RELEASE_MAXIMUM_REQUESTS + 1) > PSU_RELEASE_MAXIMUM_REQUESTS) {
    throw new Error("Live candidate request count exceeds the approved release budget.");
  }

  const expectedMenuPaths = [
    CATALOG_PATH,
    ...catalog.snapshots.map((entry) => `${MENU_PREFIX}${entry.snapshotUrl.slice(2)}`),
  ].sort();
  const actualMenuPaths = files.map((file) => file.path).filter((file) => file.startsWith(MENU_PREFIX)).sort();
  if (JSON.stringify(expectedMenuPaths) !== JSON.stringify(actualMenuPaths)) {
    throw new Error("Live candidate menu query/file set is incomplete or contains unexpected files.");
  }

  const snapshotHalls = new Set<string>();
  const snapshotPeriods = new Set<string>();
  const retrievalStartedAt = Date.parse(catalog.publication.retrievalStartedAt);
  const retrievalCompletedAt = Date.parse(catalog.publication.retrievalCompletedAt);
  const catalogGeneratedAt = Date.parse(catalog.generatedAt);
  const bundleCreatedAt = Date.parse(timing.bundleCreatedAt);
  const verificationTime = timing.verificationTime.getTime();
  if (
    retrievalStartedAt > retrievalCompletedAt
    || retrievalCompletedAt > catalogGeneratedAt
    || catalogGeneratedAt > bundleCreatedAt
    || bundleCreatedAt > verificationTime
  ) throw new Error("Live candidate retrieval, catalog, bundle, and verification timestamps are incoherent.");
  let recognizedEmptySnapshotCount = 0;
  for (const entry of catalog.snapshots) {
    const snapshotPath = `${MENU_PREFIX}${entry.snapshotUrl.slice(2)}`;
    const snapshotBytes = fileMap.get(snapshotPath);
    if (!snapshotBytes) throw new Error(`Live candidate is missing snapshot bytes: ${snapshotPath}`);
    const snapshot = validatePsuSnapshot(JSON.parse(snapshotBytes.toString("utf8")));
    assertSnapshotMatchesCatalog(snapshot, entry);
    snapshotHalls.add(snapshot.query.hallId);
    snapshotPeriods.add(snapshot.query.mealPeriodId);
    if (snapshot.query.serviceDate !== catalog.publication.serviceDate) {
      throw new Error("Live candidate snapshot service date differs from field-release provenance.");
    }
    const retrievedAt = Date.parse(snapshot.retrievedAt);
    const cachedAt = Date.parse(snapshot.cachedAt);
    const freshUntil = Date.parse(snapshot.freshUntil);
    const retainUntil = Date.parse(snapshot.retainUntil);
    if (retrievedAt < retrievalStartedAt || retrievedAt > cachedAt || cachedAt > retrievalCompletedAt || cachedAt > verificationTime) {
      throw new Error("Live candidate snapshot retrieval/cache time is outside its original field-release window.");
    }
    if (freshUntil - cachedAt !== FIELD_RELEASE_FRESH_MS || retainUntil - cachedAt !== FIELD_RELEASE_RETAIN_MS) {
      throw new Error("Live candidate snapshot exceeds the approved 18-hour/48-hour timestamp policy.");
    }
    if (snapshot.stations.every((station) => station.items.length === 0)) recognizedEmptySnapshotCount += 1;
  }

  const actualHallIds = [...snapshotHalls].sort();
  const catalogHallIds = catalog.halls.map((hall) => hall.id).sort();
  const actualPeriodIds = [...snapshotPeriods].sort();
  const catalogPeriodIds = catalog.mealPeriods.map((period) => period.id).sort();
  if (
    JSON.stringify(actualHallIds) !== JSON.stringify([...PSU_RELEASE_HALL_IDS])
    || JSON.stringify(actualHallIds) !== JSON.stringify(catalogHallIds)
    || JSON.stringify(actualPeriodIds) !== JSON.stringify(catalogPeriodIds)
    || recognizedEmptySnapshotCount !== catalog.publication.recognizedEmptySnapshotCount
  ) throw new Error("Live candidate indexes do not match its exact validated query set.");

  const catalogSha256 = sha256(catalogBytes);
  return {
    catalogSha256,
    menu: {
      serviceDate: catalog.publication.serviceDate,
      catalogPath: CATALOG_PATH,
      catalogSha256,
      catalogVersion: catalog.catalogVersion,
      snapshotSchemaVersion: catalog.snapshotSchemaVersion,
      parserVersion: catalog.parserVersion,
      generatedAt: catalog.generatedAt,
      retrievalStartedAt: catalog.publication.retrievalStartedAt,
      retrievalCompletedAt: catalog.publication.retrievalCompletedAt,
      earliestFreshUntil: minimumIso(catalog.snapshots.map((entry) => entry.freshUntil)),
      earliestRetainUntil: minimumIso(catalog.snapshots.map((entry) => entry.retainUntil)),
      coverage: catalog.publication.coverage,
      sourceObservationCount: catalog.publication.sourceObservationCount,
      publishedObservationCount: catalog.publication.publishedObservationCount,
      omissions: catalog.publication.omissions,
      snapshotCount: catalog.snapshots.length,
    },
  };
}

function minimumIso(values: readonly string[]): string {
  if (values.length === 0) throw new Error("Live candidate contains no snapshots.");
  return values.reduce((minimum, value) => Date.parse(value) < Date.parse(minimum) ? value : minimum);
}
