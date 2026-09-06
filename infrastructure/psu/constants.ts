import type { DiningHall, MealPeriod } from "../../domain/dining.ts";

export const PSU_SOURCE_ORIGIN = "https://www.absecom.psu.edu";
export const PSU_MENU_PATH = "/menus/user-pages/daily-menu.cfm";
export const PSU_NUTRITION_PATH = "/menus/user-pages/nutrition-label.cfm";
export const PSU_MENU_URL = `${PSU_SOURCE_ORIGIN}${PSU_MENU_PATH}`;
export const PSU_SNAPSHOT_VERSION = "lionlog.psu-menu.v2";
export const PSU_NUTRITION_CACHE_VERSION = "lionlog.psu-nutrition.v2";
export const PSU_PARSER_VERSION = "psu-html.v2";

export interface PsuHall extends DiningHall {
  readonly sourceCampusId: string;
}

export interface PsuMealPeriod extends MealPeriod {
  readonly sourceValue: string;
}

export const psuHalls = [
  hall("psu:campus:11", "East / Findlay", "11"),
  hall("psu:campus:17", "North / Warnock", "17"),
  hall("psu:campus:14", "Pollock", "14"),
  hall("psu:campus:13", "South / Redifer", "13"),
  hall("psu:campus:16", "West / Waring", "16"),
] as const satisfies readonly PsuHall[];

export const psuMealPeriods = [
  meal("breakfast", "Breakfast"),
  meal("lunch", "Lunch"),
  meal("dinner", "Dinner"),
  meal("late-night", "Late Night"),
] as const satisfies readonly PsuMealPeriod[];

function hall(id: string, displayName: string, sourceCampusId: string): PsuHall {
  return { id, displayName, sourceCampusId, timeZone: "America/New_York" };
}

function meal(id: string, sourceValue: string): PsuMealPeriod {
  return { id, displayName: sourceValue, sourceValue };
}

export function getPsuHall(hallId: string): PsuHall {
  const hall = psuHalls.find((candidate) => candidate.id === hallId);
  if (!hall) throw new Error(`Unsupported PSU hall: ${hallId}`);
  return hall;
}

export function getPsuMealPeriod(mealPeriodId: string): PsuMealPeriod {
  const period = psuMealPeriods.find((candidate) => candidate.id === mealPeriodId);
  if (!period) throw new Error(`Unsupported PSU meal period: ${mealPeriodId}`);
  return period;
}

export function sourceDateFromIso(serviceDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(serviceDate);
  if (!match) throw new Error(`Invalid ISO service date: ${serviceDate}`);
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)
  ) {
    throw new Error(`Invalid ISO service date: ${serviceDate}`);
  }
  return `${Number(month)}/${Number(day)}/${year.slice(2)}`;
}

export function nutritionUrlForHandle(sourceHandle: string): string {
  if (!/^\d+$/.test(sourceHandle)) throw new Error("PSU nutrition handle must contain digits only.");
  return `${PSU_SOURCE_ORIGIN}${PSU_NUTRITION_PATH}?mid=${sourceHandle}`;
}
