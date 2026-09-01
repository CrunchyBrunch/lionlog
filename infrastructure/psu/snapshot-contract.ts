import { z } from "zod";
import {
  getPsuHall,
  getPsuMealPeriod,
  PSU_MENU_URL,
  PSU_PARSER_VERSION,
  PSU_SNAPSHOT_VERSION,
  sourceDateFromIso,
} from "./constants.ts";
import { PsuStructuralError } from "./errors.ts";

const nullableNutrient = z.number().finite().nonnegative().nullable();
const dietaryTraitSchema = z.enum([
  "vegan",
  "meatless",
  "gluten-friendly",
  "halal-friendly",
  "contains-pork",
]);
const allergenSchema = z.enum([
  "dairy",
  "eggs",
  "fish",
  "shellfish",
  "peanuts",
  "tree-nuts",
  "soy",
  "wheat-gluten",
  "sesame",
  "coconut",
]);

export const browserPsuNutritionSchema = z.object({
  calories: nullableNutrient,
  proteinG: nullableNutrient,
  carbsG: nullableNutrient,
  fatG: nullableNutrient,
  additional: z.object({
    saturatedFatG: nullableNutrient,
    transFatG: nullableNutrient,
    cholesterolMg: nullableNutrient,
    sodiumMg: nullableNutrient,
    fiberG: nullableNutrient,
    sugarsG: nullableNutrient,
    addedSugarsG: nullableNutrient,
    vitaminDMcg: nullableNutrient,
    calciumMg: nullableNutrient,
    ironMg: nullableNutrient,
    potassiumMg: nullableNutrient,
  }).strict(),
}).strict();

export const browserPsuSnapshotSchema = z.object({
  schemaVersion: z.literal(PSU_SNAPSHOT_VERSION),
  parserVersion: z.literal(PSU_PARSER_VERSION),
  snapshotId: z.string().regex(/^psu:snapshot:v1:[a-f0-9]{64}$/),
  query: z.object({
    serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hallId: z.string().min(1).max(80),
    sourceCampusId: z.string().regex(/^\d+$/),
    mealPeriodId: z.string().min(1).max(80),
    sourceMeal: z.string().min(1).max(80),
    sourceUrl: z.literal(PSU_MENU_URL),
  }).strict(),
  retrievedAt: z.string().datetime({ offset: true }),
  cachedAt: z.string().datetime({ offset: true }),
  freshUntil: z.string().datetime({ offset: true }),
  retainUntil: z.string().datetime({ offset: true }),
  stations: z.array(z.object({
    id: z.string().regex(/^psu:station:v1:[a-f0-9]{64}$/),
    displayName: z.string().min(1).max(100),
    items: z.array(z.object({
      observationId: z.string().regex(/^psu:observation:v1:[a-f0-9]{64}$/),
      sourceHandle: z.string().regex(/^\d+$/),
      sourceUrl: z.string().url().refine(isAllowedNutritionUrl, "Unexpected PSU nutrition URL"),
      name: z.string().min(1).max(160),
      stationId: z.string().regex(/^psu:station:v1:[a-f0-9]{64}$/),
      serving: z.object({
        label: z.string().min(1).max(80).nullable(),
        quantity: z.number().finite().nonnegative().nullable(),
        unit: z.string().min(1).max(60).nullable(),
      }).strict(),
      nutrition: browserPsuNutritionSchema,
      dietaryTraits: z.array(dietaryTraitSchema).max(10),
      ingredients: z.string().min(1).max(20_000).nullable(),
      allergens: z.array(allergenSchema).max(20),
    }).strict()).max(1_000),
  }).strict()).max(100),
}).strict().superRefine((snapshot, context) => {
  const stationIds = new Set<string>();
  const observationIds = new Set<string>();
  try {
    const hall = getPsuHall(snapshot.query.hallId);
    if (snapshot.query.sourceCampusId !== hall.sourceCampusId) {
      context.addIssue({ code: "custom", message: "Snapshot campus selector does not match its hall." });
    }
    const period = getPsuMealPeriod(snapshot.query.mealPeriodId);
    if (snapshot.query.sourceMeal !== period.sourceValue) {
      context.addIssue({ code: "custom", message: "Snapshot source meal does not match its meal period." });
    }
    sourceDateFromIso(snapshot.query.serviceDate);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid query." });
  }
  for (const station of snapshot.stations) {
    if (stationIds.has(station.id)) context.addIssue({ code: "custom", message: "Duplicate station ID." });
    stationIds.add(station.id);
    for (const item of station.items) {
      if (item.stationId !== station.id) context.addIssue({ code: "custom", message: "Item references wrong station." });
      if (observationIds.has(item.observationId)) context.addIssue({ code: "custom", message: "Duplicate observation ID." });
      observationIds.add(item.observationId);
      if (nutritionHandleFromUrl(item.sourceUrl) !== item.sourceHandle) {
        context.addIssue({ code: "custom", message: "Item source URL does not match handle." });
      }
    }
  }
  const retrievedAt = Date.parse(snapshot.retrievedAt);
  const cachedAt = Date.parse(snapshot.cachedAt);
  const freshUntil = Date.parse(snapshot.freshUntil);
  const retainUntil = Date.parse(snapshot.retainUntil);
  if (!(retrievedAt <= cachedAt && cachedAt <= freshUntil && freshUntil <= retainUntil)) {
    context.addIssue({ code: "custom", message: "Snapshot timestamps are out of order." });
  }
});

export type BrowserPsuMenuSnapshot = z.infer<typeof browserPsuSnapshotSchema>;

export function validatePsuSnapshotStructure(value: unknown): BrowserPsuMenuSnapshot {
  const result = browserPsuSnapshotSchema.safeParse(value);
  if (!result.success) throw new PsuStructuralError(`Invalid PSU snapshot: ${z.prettifyError(result.error)}`);
  return result.data;
}

export async function validatePsuSnapshotForBrowser(value: unknown): Promise<BrowserPsuMenuSnapshot> {
  const snapshot = validatePsuSnapshotStructure(value);
  const stationIds = new Set<string>();
  const observationIds = new Set<string>();
  for (const station of snapshot.stations) {
    const expectedStationId = `psu:station:v1:${await sha256([snapshot.query.hallId, station.displayName])}`;
    if (station.id !== expectedStationId || stationIds.has(station.id)) {
      throw new PsuStructuralError(`Invalid deterministic station ID: ${station.displayName}`);
    }
    stationIds.add(station.id);
    const occurrencesByHandle = new Map<string, number>();
    for (const item of station.items) {
      const occurrence = occurrencesByHandle.get(item.sourceHandle) ?? 0;
      occurrencesByHandle.set(item.sourceHandle, occurrence + 1);
      const expectedObservationId = `psu:observation:v1:${await sha256([
        snapshot.query.serviceDate,
        snapshot.query.hallId,
        snapshot.query.mealPeriodId,
        station.displayName,
        item.sourceHandle,
        String(occurrence),
      ])}`;
      if (item.observationId !== expectedObservationId || observationIds.has(item.observationId)) {
        throw new PsuStructuralError(`Invalid deterministic observation ID: ${item.observationId}`);
      }
      observationIds.add(item.observationId);
    }
  }
  const expectedSnapshotId = `psu:snapshot:v1:${await sha256([
    snapshot.query.serviceDate,
    snapshot.query.hallId,
    snapshot.query.mealPeriodId,
    snapshot.retrievedAt,
    JSON.stringify(snapshot.stations),
  ])}`;
  if (snapshot.snapshotId !== expectedSnapshotId) {
    throw new PsuStructuralError("Snapshot content does not match its deterministic ID.");
  }
  return snapshot;
}

async function sha256(parts: readonly string[]): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new PsuStructuralError("Secure snapshot validation is unavailable.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u001f")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isAllowedNutritionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://www.absecom.psu.edu"
      && url.pathname === "/menus/user-pages/nutrition-label.cfm"
      && /^\d+$/.test(url.searchParams.get("mid") ?? "")
      && [...url.searchParams.keys()].length === 1;
  } catch { return false; }
}

function nutritionHandleFromUrl(value: string): string | null {
  try { return new URL(value).searchParams.get("mid"); } catch { return null; }
}
