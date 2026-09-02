import { z } from "zod";
import type { MenuQuery } from "../../domain/dining.ts";
import { getPsuHall, getPsuMealPeriod, sourceDateFromIso } from "./constants.ts";
import { PsuStructuralError } from "./errors.ts";
import type { ParsedPsuMealOption } from "./menu-parser.ts";

export const PSU_RELEASE_HALL_IDS = [
  "psu:campus:11",
  "psu:campus:13",
  "psu:campus:14",
  "psu:campus:16",
  "psu:campus:17",
] as const;
export const PSU_RELEASE_MAXIMUM_QUERIES = 20;
export const PSU_RELEASE_MAXIMUM_ITEMS = 5_000;
export const PSU_RELEASE_MAXIMUM_REQUESTS = 750;
export const PSU_RELEASE_MAXIMUM_INVALID_NAME_OMISSIONS = 5;

const omissionSchema = z.object({ "invalid-name": z.number().int().min(0).max(PSU_RELEASE_MAXIMUM_INVALID_NAME_OMISSIONS) }).strict();

const querySchema = z.object({
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hallId: z.string(),
  mealPeriodId: z.string(),
  sourceMeal: z.string(),
  recognizedEmpty: z.boolean(),
  itemCount: z.number().int().min(0).max(1_000),
  coverage: z.enum(["complete", "partial"]),
  sourceObservationCount: z.number().int().min(0).max(1_000),
  publishedObservationCount: z.number().int().min(0).max(1_000),
  omissions: omissionSchema,
  snapshotId: z.string().regex(/^psu:snapshot:v2:[a-f0-9]{64}$/),
  retrievedAt: z.string().datetime({ offset: true }),
}).strict();

export const psuReleaseReportSchema = z.object({
  reportVersion: z.literal("lionlog.psu-field-release-report.v2"),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  hallIds: z.array(z.string()).length(5),
  queryCount: z.number().int().min(1).max(PSU_RELEASE_MAXIMUM_QUERIES),
  itemCount: z.number().int().min(0).max(PSU_RELEASE_MAXIMUM_ITEMS),
  coverage: z.enum(["complete", "partial"]),
  sourceObservationCount: z.number().int().min(0).max(PSU_RELEASE_MAXIMUM_ITEMS),
  publishedObservationCount: z.number().int().min(0).max(PSU_RELEASE_MAXIMUM_ITEMS),
  omissions: omissionSchema,
  requestCount: z.number().int().min(1).max(PSU_RELEASE_MAXIMUM_REQUESTS),
  nutritionRequests: z.number().int().min(0),
  nutritionCacheHits: z.number().int().min(0),
  queries: z.array(querySchema).min(1).max(PSU_RELEASE_MAXIMUM_QUERIES),
}).strict().superRefine((report, context) => {
  try { sourceDateFromIso(report.serviceDate); } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid service date." });
  }
  if (report.hallIds.join("\u001f") !== PSU_RELEASE_HALL_IDS.join("\u001f")) {
    context.addIssue({ code: "custom", message: "Release report does not cover the exact PSU hall set." });
  }
  if (report.queryCount !== report.queries.length) {
    context.addIssue({ code: "custom", message: "Release report query count is inconsistent." });
  }
  if (report.itemCount !== report.queries.reduce((total, query) => total + query.itemCount, 0)) {
    context.addIssue({ code: "custom", message: "Release report item count is inconsistent." });
  }
  const sourceObservationCount = report.queries.reduce((total, query) => total + query.sourceObservationCount, 0);
  const publishedObservationCount = report.queries.reduce((total, query) => total + query.publishedObservationCount, 0);
  const invalidNameOmissions = report.queries.reduce((total, query) => total + query.omissions["invalid-name"], 0);
  if (
    report.sourceObservationCount !== sourceObservationCount
    || report.publishedObservationCount !== publishedObservationCount
    || report.omissions["invalid-name"] !== invalidNameOmissions
    || report.itemCount !== publishedObservationCount
  ) context.addIssue({ code: "custom", message: "Release coverage totals are inconsistent." });
  const allowedOmissions = Math.min(
    PSU_RELEASE_MAXIMUM_INVALID_NAME_OMISSIONS,
    Math.max(1, Math.floor(sourceObservationCount * 0.01)),
  );
  if (invalidNameOmissions > allowedOmissions) {
    context.addIssue({ code: "custom", message: "Release exceeded its invalid-name omission threshold." });
  }
  if (report.coverage !== (invalidNameOmissions === 0 ? "complete" : "partial")) {
    context.addIssue({ code: "custom", message: "Release coverage status is inconsistent." });
  }
  if (Date.parse(report.startedAt) > Date.parse(report.completedAt)) {
    context.addIssue({ code: "custom", message: "Release report timestamps are out of order." });
  }
  const keys = new Set<string>();
  for (const query of report.queries) {
    const key = releaseQueryKey(query);
    if (keys.has(key)) context.addIssue({ code: "custom", message: `Duplicate release query: ${key}` });
    keys.add(key);
    if (query.serviceDate !== report.serviceDate || !PSU_RELEASE_HALL_IDS.includes(query.hallId as never)) {
      context.addIssue({ code: "custom", message: `Release query is outside the declared coverage: ${key}` });
    }
    try {
      if (getPsuMealPeriod(query.mealPeriodId).sourceValue !== query.sourceMeal) throw new Error("Meal mismatch.");
    } catch { context.addIssue({ code: "custom", message: `Release query uses an unsupported meal: ${key}` }); }
    if (query.recognizedEmpty !== (query.sourceObservationCount === 0)) {
      context.addIssue({ code: "custom", message: `Release empty status is inconsistent: ${key}` });
    }
    if (
      query.itemCount !== query.publishedObservationCount
      || query.sourceObservationCount !== query.publishedObservationCount + query.omissions["invalid-name"]
      || query.coverage !== (query.omissions["invalid-name"] === 0 ? "complete" : "partial")
      || query.omissions["invalid-name"] > 1
      || (query.sourceObservationCount > 0 && query.publishedObservationCount === 0)
    ) context.addIssue({ code: "custom", message: `Release query coverage is inconsistent: ${key}` });
    if (Date.parse(query.retrievedAt) < Date.parse(report.startedAt) || Date.parse(query.retrievedAt) > Date.parse(report.completedAt)) {
      context.addIssue({ code: "custom", message: `Release query timestamp is outside the retrieval window: ${key}` });
    }
  }
  for (const hallId of PSU_RELEASE_HALL_IDS) {
    if (!report.queries.some((query) => query.hallId === hallId)) {
      context.addIssue({ code: "custom", message: `Release has no verified meal coverage for ${hallId}.` });
    }
  }
});

export type PsuReleaseReport = z.infer<typeof psuReleaseReportSchema>;

export function buildReleaseQueries(
  serviceDate: string,
  mealsByHall: ReadonlyMap<string, readonly ParsedPsuMealOption[]>,
): readonly MenuQuery[] {
  sourceDateFromIso(serviceDate);
  const queries: MenuQuery[] = [];
  for (const hallId of PSU_RELEASE_HALL_IDS) {
    getPsuHall(hallId);
    const meals = mealsByHall.get(hallId);
    if (!meals || meals.length === 0) throw new PsuStructuralError(`No source meal options were verified for ${hallId}.`);
    for (const meal of meals) {
      if (getPsuMealPeriod(meal.mealPeriodId).sourceValue !== meal.sourceValue) {
        throw new PsuStructuralError(`Source meal option does not match ${meal.mealPeriodId}.`);
      }
      queries.push({ serviceDate, hallId, mealPeriodId: meal.mealPeriodId, venueIds: [] });
    }
  }
  if (queries.length > PSU_RELEASE_MAXIMUM_QUERIES) {
    throw new PsuStructuralError("Release query plan exceeded its bound.");
  }
  return queries;
}

export function validatePsuReleaseReport(value: unknown): PsuReleaseReport {
  const result = psuReleaseReportSchema.safeParse(value);
  if (!result.success) throw new PsuStructuralError(`Invalid PSU release report: ${z.prettifyError(result.error)}`);
  return result.data;
}

export function releaseQueryKey(query: Pick<MenuQuery, "serviceDate" | "hallId" | "mealPeriodId">): string {
  return [query.serviceDate, query.hallId, query.mealPeriodId].join("\u001f");
}
