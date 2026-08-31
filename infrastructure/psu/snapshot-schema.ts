import { createHash } from "node:crypto";
import { z } from "zod";
import type { MenuQuery } from "../../domain/dining.ts";
import {
  getPsuHall,
  getPsuMealPeriod,
  nutritionUrlForHandle,
  PSU_MENU_URL,
  PSU_PARSER_VERSION,
  PSU_SNAPSHOT_VERSION,
  sourceDateFromIso,
} from "./constants.ts";
import { PsuStructuralError } from "./errors.ts";
import type { ParsedPsuMenu } from "./menu-parser.ts";
import type { ParsedPsuNutrition } from "./nutrition-parser.ts";

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

export const psuNutritionSchema = z.object({
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

export const psuNutritionDetailSchema = z.object({
  name: z.string().min(1).max(160).nullable(),
  servingLabel: z.string().min(1).max(80).nullable(),
  sourceQuantity: z.number().finite().nonnegative().nullable(),
  sourceUnit: z.string().min(1).max(60).nullable(),
  nutrition: psuNutritionSchema,
  dietaryTraits: z.array(dietaryTraitSchema).max(10),
  ingredients: z.string().min(1).max(20_000).nullable(),
  allergens: z.array(allergenSchema).max(20),
}).strict();

export const psuSnapshotItemSchema = z.object({
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
  nutrition: psuNutritionSchema,
  dietaryTraits: z.array(dietaryTraitSchema).max(10),
  ingredients: z.string().min(1).max(20_000).nullable(),
  allergens: z.array(allergenSchema).max(20),
}).strict();

export const psuSnapshotSchema = z.object({
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
    items: z.array(psuSnapshotItemSchema).max(1_000),
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
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Snapshot query context is invalid.",
    });
  }

  for (const station of snapshot.stations) {
    if (stationIds.has(station.id)) {
      context.addIssue({ code: "custom", message: `Duplicate station ID: ${station.id}` });
    }
    stationIds.add(station.id);
    const expectedStationId = `psu:station:v1:${hash([snapshot.query.hallId, station.displayName])}`;
    if (station.id !== expectedStationId) {
      context.addIssue({ code: "custom", message: `Station ${station.displayName} has an invalid deterministic ID.` });
    }
    const occurrencesByHandle = new Map<string, number>();
    for (const item of station.items) {
      if (item.stationId !== station.id) {
        context.addIssue({ code: "custom", message: `Item ${item.observationId} references the wrong station.` });
      }
      if (observationIds.has(item.observationId)) {
        context.addIssue({ code: "custom", message: `Duplicate observation ID: ${item.observationId}` });
      }
      observationIds.add(item.observationId);
      if (nutritionHandleFromUrl(item.sourceUrl) !== item.sourceHandle) {
        context.addIssue({ code: "custom", message: `Item ${item.observationId} has a mismatched source URL.` });
      }
      const occurrence = occurrencesByHandle.get(item.sourceHandle) ?? 0;
      occurrencesByHandle.set(item.sourceHandle, occurrence + 1);
      const expectedObservationId = `psu:observation:v1:${hash([
        snapshot.query.serviceDate,
        snapshot.query.hallId,
        snapshot.query.mealPeriodId,
        station.displayName,
        item.sourceHandle,
        String(occurrence),
      ])}`;
      if (item.observationId !== expectedObservationId) {
        context.addIssue({ code: "custom", message: `Item ${item.observationId} has an invalid deterministic ID.` });
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
  const expectedSnapshotId = `psu:snapshot:v1:${hash([
    snapshot.query.serviceDate,
    snapshot.query.hallId,
    snapshot.query.mealPeriodId,
    snapshot.retrievedAt,
    JSON.stringify(snapshot.stations),
  ])}`;
  if (snapshot.snapshotId !== expectedSnapshotId) {
    context.addIssue({ code: "custom", message: "Snapshot content does not match its deterministic ID." });
  }
});

export const psuNutritionCacheSchema = z.object({
  schemaVersion: z.literal("lionlog.psu-nutrition.v1"),
  parserVersion: z.literal(PSU_PARSER_VERSION),
  sourceHandle: z.string().regex(/^\d+$/),
  sourceUrl: z.string().url().refine(isAllowedNutritionUrl, "Unexpected PSU nutrition URL"),
  retrievedAt: z.string().datetime({ offset: true }),
  freshUntil: z.string().datetime({ offset: true }),
  detail: psuNutritionDetailSchema,
}).strict().superRefine((entry, context) => {
  if (nutritionHandleFromUrl(entry.sourceUrl) !== entry.sourceHandle) {
    context.addIssue({ code: "custom", message: "Nutrition cache source URL does not match its handle." });
  }
  if (Date.parse(entry.retrievedAt) > Date.parse(entry.freshUntil)) {
    context.addIssue({ code: "custom", message: "Nutrition cache timestamps are out of order." });
  }
});

export type PsuMenuSnapshot = z.infer<typeof psuSnapshotSchema>;
export type PsuNutritionCacheEntry = z.infer<typeof psuNutritionCacheSchema>;
export type PsuNutritionDetail = z.infer<typeof psuNutritionDetailSchema>;

export interface SnapshotTiming {
  readonly retrievedAt: Date;
  readonly cachedAt: Date;
  readonly freshForMs: number;
  readonly retainForMs: number;
}

export function buildPsuSnapshot(
  query: MenuQuery,
  menu: ParsedPsuMenu,
  nutritionByHandle: ReadonlyMap<string, ParsedPsuNutrition>,
  timing: SnapshotTiming,
): PsuMenuSnapshot {
  const hall = getPsuHall(query.hallId);
  const period = getPsuMealPeriod(query.mealPeriodId);
  if (
    menu.context.sourceCampusId !== hall.sourceCampusId
    || menu.context.sourceDate !== sourceDateFromIso(query.serviceDate)
    || menu.context.sourceMeal !== period.sourceValue
  ) {
    throw new PsuStructuralError("Parsed PSU menu context does not match the LionLog query.");
  }

  const stations = menu.stations.map((station) => {
    const stationId = `psu:station:v1:${hash([hall.id, station.displayName])}`;
    const occurrencesByHandle = new Map<string, number>();
    return {
      id: stationId,
      displayName: station.displayName,
      items: station.items.map((item) => {
        const occurrenceIndex = occurrencesByHandle.get(item.sourceHandle) ?? 0;
        occurrencesByHandle.set(item.sourceHandle, occurrenceIndex + 1);
        const detail = nutritionByHandle.get(item.sourceHandle);
        if (!detail) throw new PsuStructuralError(`Missing PSU nutrition detail for ${item.sourceHandle}.`);
        if (detail.name !== null && detail.name !== item.name) {
          throw new PsuStructuralError(`PSU menu and nutrition names disagree for ${item.sourceHandle}.`);
        }
        return {
          observationId: `psu:observation:v1:${hash([
            query.serviceDate,
            hall.id,
            period.id,
            station.displayName,
            item.sourceHandle,
            String(occurrenceIndex),
          ])}`,
          sourceHandle: item.sourceHandle,
          sourceUrl: nutritionUrlForHandle(item.sourceHandle),
          name: item.name,
          stationId,
          serving: {
            label: detail.servingLabel,
            quantity: detail.sourceQuantity,
            unit: detail.sourceUnit,
          },
          nutrition: {
            calories: detail.calories,
            proteinG: detail.proteinG,
            carbsG: detail.carbsG,
            fatG: detail.fatG,
            additional: detail.additional,
          },
          dietaryTraits: item.dietaryTraits,
          ingredients: detail.ingredients,
          allergens: detail.allergens,
        };
      }),
    };
  });

  const cachedAt = timing.cachedAt.toISOString();
  const snapshot = {
    schemaVersion: PSU_SNAPSHOT_VERSION,
    parserVersion: PSU_PARSER_VERSION,
    snapshotId: `psu:snapshot:v1:${hash([
      query.serviceDate,
      hall.id,
      period.id,
      timing.retrievedAt.toISOString(),
      JSON.stringify(stations),
    ])}`,
    query: {
      serviceDate: query.serviceDate,
      hallId: hall.id,
      sourceCampusId: hall.sourceCampusId,
      mealPeriodId: period.id,
      sourceMeal: period.sourceValue,
      sourceUrl: PSU_MENU_URL,
    },
    retrievedAt: timing.retrievedAt.toISOString(),
    cachedAt,
    freshUntil: new Date(timing.cachedAt.getTime() + timing.freshForMs).toISOString(),
    retainUntil: new Date(timing.cachedAt.getTime() + timing.retainForMs).toISOString(),
    stations,
  };
  return validatePsuSnapshot(snapshot);
}

export function validatePsuSnapshot(value: unknown): PsuMenuSnapshot {
  const result = psuSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new PsuStructuralError(`Invalid PSU snapshot: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function validatePsuNutritionCacheEntry(value: unknown): PsuNutritionCacheEntry {
  const result = psuNutritionCacheSchema.safeParse(value);
  if (!result.success) {
    throw new PsuStructuralError(`Invalid PSU nutrition cache entry: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function toNutritionCacheEntry(
  sourceHandle: string,
  detail: ParsedPsuNutrition,
  retrievedAt: Date,
  freshForMs: number,
): PsuNutritionCacheEntry {
  return validatePsuNutritionCacheEntry({
    schemaVersion: "lionlog.psu-nutrition.v1",
    parserVersion: PSU_PARSER_VERSION,
    sourceHandle,
    sourceUrl: nutritionUrlForHandle(sourceHandle),
    retrievedAt: retrievedAt.toISOString(),
    freshUntil: new Date(retrievedAt.getTime() + freshForMs).toISOString(),
    detail: {
      name: detail.name,
      servingLabel: detail.servingLabel,
      sourceQuantity: detail.sourceQuantity,
      sourceUnit: detail.sourceUnit,
      nutrition: {
        calories: detail.calories,
        proteinG: detail.proteinG,
        carbsG: detail.carbsG,
        fatG: detail.fatG,
        additional: detail.additional,
      },
      dietaryTraits: [],
      ingredients: detail.ingredients,
      allergens: detail.allergens,
    },
  });
}

export function nutritionFromCacheEntry(entry: PsuNutritionCacheEntry): ParsedPsuNutrition {
  return {
    name: entry.detail.name,
    servingLabel: entry.detail.servingLabel,
    sourceQuantity: entry.detail.sourceQuantity,
    sourceUnit: entry.detail.sourceUnit,
    calories: entry.detail.nutrition.calories,
    proteinG: entry.detail.nutrition.proteinG,
    carbsG: entry.detail.nutrition.carbsG,
    fatG: entry.detail.nutrition.fatG,
    additional: entry.detail.nutrition.additional,
    ingredients: entry.detail.ingredients,
    allergens: entry.detail.allergens,
  };
}

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex");
}

function isAllowedNutritionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://www.absecom.psu.edu"
      && url.pathname === "/menus/user-pages/nutrition-label.cfm"
      && /^\d+$/.test(url.searchParams.get("mid") ?? "")
      && [...url.searchParams.keys()].length === 1;
  } catch {
    return false;
  }
}

function nutritionHandleFromUrl(value: string): string | null {
  try {
    return new URL(value).searchParams.get("mid");
  } catch {
    return null;
  }
}
