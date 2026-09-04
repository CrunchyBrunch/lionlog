import { z } from "zod";
import {
  getPsuHall,
  getPsuMealPeriod,
  PSU_PARSER_VERSION,
  PSU_SNAPSHOT_VERSION,
} from "./constants.ts";
import { PsuStructuralError } from "./errors.ts";
import type { BrowserPsuMenuSnapshot } from "./snapshot-contract.ts";

export const PSU_CATALOG_VERSION = "lionlog.psu-catalog.v3";
export const PSU_MENU_DATA_PATH = "./menu-data/v2/catalog.json";

const omissionSchema = z.object({ "invalid-name": z.number().int().min(0).max(5) }).strict();
const coverageStatusSchema = z.enum(["complete", "partial"]);

export const psuPublicationCatalogSchema = z.object({
  catalogVersion: z.literal(PSU_CATALOG_VERSION),
  snapshotSchemaVersion: z.literal(PSU_SNAPSHOT_VERSION),
  parserVersion: z.literal(PSU_PARSER_VERSION),
  generatedAt: z.string().datetime({ offset: true }),
  publication: z.object({
    mode: z.enum(["manual-export", "field-release"]),
    sourceKind: z.literal("psu-public-menu-html"),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
    serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    hallIds: z.array(z.string().min(1).max(80)).min(1).max(20),
    retrievalStartedAt: z.string().datetime({ offset: true }).nullable(),
    retrievalCompletedAt: z.string().datetime({ offset: true }).nullable(),
    expectedSnapshotCount: z.number().int().min(1).max(2_000),
    publishedSnapshotCount: z.number().int().min(1).max(2_000),
    recognizedEmptySnapshotCount: z.number().int().min(0).max(2_000),
    itemCount: z.number().int().min(0).max(100_000),
    coverage: coverageStatusSchema,
    sourceObservationCount: z.number().int().min(0).max(100_000),
    publishedObservationCount: z.number().int().min(0).max(100_000),
    omissions: omissionSchema,
    requestCount: z.number().int().min(1).max(2_000).nullable(),
    nutritionRequests: z.number().int().min(0).max(2_000).nullable(),
    nutritionCacheHits: z.number().int().min(0).max(100_000).nullable(),
  }).strict(),
  serviceDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60),
  halls: z.array(z.object({
    id: z.string().min(1).max(80),
    displayName: z.string().min(1).max(100),
  }).strict()).max(20),
  mealPeriods: z.array(z.object({
    id: z.string().min(1).max(80),
    displayName: z.string().min(1).max(80),
  }).strict()).max(10),
  snapshots: z.array(z.object({
    serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hallId: z.string().min(1).max(80),
    mealPeriodId: z.string().min(1).max(80),
    snapshotId: z.string().regex(/^psu:snapshot:v2:[a-f0-9]{64}$/),
    snapshotUrl: z.string().regex(/^\.\/snapshots\/\d{4}-\d{2}-\d{2}\/\d+\/(?:breakfast|lunch|dinner|late-night)\.json$/),
    retrievedAt: z.string().datetime({ offset: true }),
    freshUntil: z.string().datetime({ offset: true }),
    retainUntil: z.string().datetime({ offset: true }),
    coverage: coverageStatusSchema,
    sourceObservationCount: z.number().int().min(0).max(1_000),
    publishedObservationCount: z.number().int().min(0).max(1_000),
    omissions: z.object({ "invalid-name": z.number().int().min(0).max(1) }).strict(),
  }).strict()).max(2_000),
}).strict().superRefine((catalog, context) => {
  if (!isSortedUnique(catalog.serviceDates)) {
    context.addIssue({ code: "custom", message: "Catalog service dates must be sorted and unique." });
  }
  const halls = new Set(catalog.halls.map((hall) => hall.id));
  const periods = new Set(catalog.mealPeriods.map((period) => period.id));
  const keys = new Set<string>();
  if (
    catalog.publication.expectedSnapshotCount !== catalog.snapshots.length
    || catalog.publication.publishedSnapshotCount !== catalog.snapshots.length
  ) context.addIssue({ code: "custom", message: "Catalog publication snapshot counts are inconsistent." });
  const sourceObservationCount = catalog.snapshots.reduce((total, entry) => total + entry.sourceObservationCount, 0);
  const publishedObservationCount = catalog.snapshots.reduce((total, entry) => total + entry.publishedObservationCount, 0);
  const invalidNameOmissions = catalog.snapshots.reduce((total, entry) => total + entry.omissions["invalid-name"], 0);
  if (
    catalog.publication.sourceObservationCount !== sourceObservationCount
    || catalog.publication.publishedObservationCount !== publishedObservationCount
    || catalog.publication.itemCount !== publishedObservationCount
    || catalog.publication.omissions["invalid-name"] !== invalidNameOmissions
  ) context.addIssue({ code: "custom", message: "Catalog publication coverage totals are inconsistent." });
  const allowedOmissions = Math.min(5, Math.max(1, Math.floor(sourceObservationCount * 0.01)));
  if (invalidNameOmissions > allowedOmissions) {
    context.addIssue({ code: "custom", message: "Catalog exceeded its invalid-name omission threshold." });
  }
  if (catalog.publication.coverage !== (invalidNameOmissions === 0 ? "complete" : "partial")) {
    context.addIssue({ code: "custom", message: "Catalog publication coverage status is inconsistent." });
  }
  if (catalog.publication.mode === "field-release") {
    if (
      catalog.publication.commitSha === null
      || catalog.publication.serviceDate === null
      || catalog.publication.retrievalStartedAt === null
      || catalog.publication.retrievalCompletedAt === null
      || catalog.publication.requestCount === null
      || catalog.publication.nutritionRequests === null
      || catalog.publication.nutritionCacheHits === null
    ) context.addIssue({ code: "custom", message: "Field-release catalog provenance is incomplete." });
    if (
      catalog.publication.serviceDate !== null
      && (catalog.serviceDates.length !== 1 || catalog.serviceDates[0] !== catalog.publication.serviceDate)
    ) context.addIssue({ code: "custom", message: "Field-release service-date coverage is inconsistent." });
    const expectedHallIds = ["psu:campus:11", "psu:campus:13", "psu:campus:14", "psu:campus:16", "psu:campus:17"];
    if (catalog.publication.hallIds.join("\u001f") !== expectedHallIds.join("\u001f")) {
      context.addIssue({ code: "custom", message: "Field-release hall coverage is incomplete." });
    }
    const startedAt = Date.parse(catalog.publication.retrievalStartedAt ?? "");
    const completedAt = Date.parse(catalog.publication.retrievalCompletedAt ?? "");
    if (!(startedAt <= completedAt && completedAt <= Date.parse(catalog.generatedAt))) {
      context.addIssue({ code: "custom", message: "Field-release provenance timestamps are out of order." });
    }
  }
  if (catalog.publication.hallIds.join("\u001f") !== catalog.halls.map((hall) => hall.id).join("\u001f")) {
    context.addIssue({ code: "custom", message: "Catalog publication hall index is inconsistent." });
  }
  for (const hall of catalog.halls) {
    try {
      if (getPsuHall(hall.id).displayName !== hall.displayName) throw new Error("Hall label mismatch.");
    } catch { context.addIssue({ code: "custom", message: `Unsupported catalog hall: ${hall.id}` }); }
  }
  for (const period of catalog.mealPeriods) {
    try {
      if (getPsuMealPeriod(period.id).displayName !== period.displayName) throw new Error("Period label mismatch.");
    } catch { context.addIssue({ code: "custom", message: `Unsupported meal period: ${period.id}` }); }
  }
  for (const entry of catalog.snapshots) {
    const key = [entry.serviceDate, entry.hallId, entry.mealPeriodId].join("\u001f");
    if (keys.has(key)) context.addIssue({ code: "custom", message: `Duplicate catalog query: ${key}` });
    keys.add(key);
    if (!catalog.serviceDates.includes(entry.serviceDate) || !halls.has(entry.hallId) || !periods.has(entry.mealPeriodId)) {
      context.addIssue({ code: "custom", message: `Catalog entry is missing index metadata: ${key}` });
    }
    try {
      const expectedUrl = `./snapshots/${entry.serviceDate}/${getPsuHall(entry.hallId).sourceCampusId}/${entry.mealPeriodId}.json`;
      if (entry.snapshotUrl !== expectedUrl) {
        context.addIssue({ code: "custom", message: `Catalog snapshot URL does not match its query: ${key}` });
      }
    } catch {
      context.addIssue({ code: "custom", message: `Catalog snapshot URL uses an unsupported hall: ${key}` });
    }
    if (!(Date.parse(entry.retrievedAt) <= Date.parse(entry.freshUntil)
      && Date.parse(entry.freshUntil) <= Date.parse(entry.retainUntil))) {
      context.addIssue({ code: "custom", message: `Catalog entry timestamps are invalid: ${key}` });
    }
    if (
      entry.sourceObservationCount !== entry.publishedObservationCount + entry.omissions["invalid-name"]
      || entry.coverage !== (entry.omissions["invalid-name"] === 0 ? "complete" : "partial")
      || (entry.sourceObservationCount > 0 && entry.publishedObservationCount === 0)
    ) context.addIssue({ code: "custom", message: `Catalog entry coverage is inconsistent: ${key}` });
  }
});

export type PsuPublicationCatalog = z.infer<typeof psuPublicationCatalogSchema>;
export type PsuPublicationEntry = PsuPublicationCatalog["snapshots"][number];

export function validatePsuPublicationCatalog(value: unknown): PsuPublicationCatalog {
  const result = psuPublicationCatalogSchema.safeParse(value);
  if (!result.success) throw new PsuStructuralError(`Invalid PSU catalog: ${z.prettifyError(result.error)}`);
  return result.data;
}

export function assertSnapshotMatchesCatalog(
  snapshot: BrowserPsuMenuSnapshot,
  entry: PsuPublicationEntry,
): void {
  if (
    snapshot.snapshotId !== entry.snapshotId
    || snapshot.query.serviceDate !== entry.serviceDate
    || snapshot.query.hallId !== entry.hallId
    || snapshot.query.mealPeriodId !== entry.mealPeriodId
    || snapshot.retrievedAt !== entry.retrievedAt
    || snapshot.freshUntil !== entry.freshUntil
    || snapshot.retainUntil !== entry.retainUntil
    || snapshot.coverage.status !== entry.coverage
    || snapshot.coverage.sourceObservationCount !== entry.sourceObservationCount
    || snapshot.coverage.publishedObservationCount !== entry.publishedObservationCount
    || snapshot.coverage.omissions["invalid-name"] !== entry.omissions["invalid-name"]
  ) throw new PsuStructuralError("Published snapshot does not match its catalog entry.");
}

export function catalogEntryForSnapshot(
  snapshot: BrowserPsuMenuSnapshot,
  snapshotUrl: string,
): PsuPublicationEntry {
  return {
    serviceDate: snapshot.query.serviceDate,
    hallId: snapshot.query.hallId,
    mealPeriodId: snapshot.query.mealPeriodId,
    snapshotId: snapshot.snapshotId,
    snapshotUrl,
    retrievedAt: snapshot.retrievedAt,
    freshUntil: snapshot.freshUntil,
    retainUntil: snapshot.retainUntil,
    coverage: snapshot.coverage.status,
    sourceObservationCount: snapshot.coverage.sourceObservationCount,
    publishedObservationCount: snapshot.coverage.publishedObservationCount,
    omissions: snapshot.coverage.omissions,
  };
}

export function resolveSameOriginMenuUrl(reference: string, base: string | URL): URL {
  const baseUrl = new URL(base);
  const resolved = new URL(reference, baseUrl);
  if (resolved.origin !== baseUrl.origin || !["http:", "https:"].includes(resolved.protocol)) {
    throw new PsuStructuralError("Menu-data URL must remain on the application origin.");
  }
  return resolved;
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}
