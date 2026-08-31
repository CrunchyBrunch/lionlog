import { z } from "zod";
import {
  getPsuHall,
  getPsuMealPeriod,
  PSU_PARSER_VERSION,
  PSU_SNAPSHOT_VERSION,
} from "./constants.ts";
import { PsuStructuralError } from "./errors.ts";
import type { BrowserPsuMenuSnapshot } from "./snapshot-contract.ts";

export const PSU_CATALOG_VERSION = "lionlog.psu-catalog.v1";
export const PSU_MENU_DATA_PATH = "./menu-data/v1/catalog.json";

export const psuPublicationCatalogSchema = z.object({
  catalogVersion: z.literal(PSU_CATALOG_VERSION),
  snapshotSchemaVersion: z.literal(PSU_SNAPSHOT_VERSION),
  parserVersion: z.literal(PSU_PARSER_VERSION),
  generatedAt: z.string().datetime({ offset: true }),
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
    snapshotId: z.string().regex(/^psu:snapshot:v1:[a-f0-9]{64}$/),
    snapshotUrl: z.string().regex(/^\.\/snapshots\/\d{4}-\d{2}-\d{2}\/\d+\/(?:breakfast|lunch|dinner|late-night)\.json$/),
    retrievedAt: z.string().datetime({ offset: true }),
    freshUntil: z.string().datetime({ offset: true }),
    retainUntil: z.string().datetime({ offset: true }),
  }).strict()).max(2_000),
}).strict().superRefine((catalog, context) => {
  if (!isSortedUnique(catalog.serviceDates)) {
    context.addIssue({ code: "custom", message: "Catalog service dates must be sorted and unique." });
  }
  const halls = new Set(catalog.halls.map((hall) => hall.id));
  const periods = new Set(catalog.mealPeriods.map((period) => period.id));
  const keys = new Set<string>();
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
