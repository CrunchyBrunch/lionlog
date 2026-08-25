import type { MenuItem } from "./dining.ts";
import type { Nutrition } from "./nutrition.ts";

export interface MacroTarget {
  readonly calories: number;
  readonly proteinG: number;
  readonly carbsG?: number;
  readonly fatG?: number;
}

export interface LockedPortion {
  readonly menuItemId: string;
  readonly servingId: string;
  readonly amount: number;
}

export interface RecommendationConstraints {
  readonly maximumFoods: number;
}

export interface MealRequest {
  readonly target: MacroTarget;
  readonly availableMenuItems: readonly MenuItem[];
  readonly excludedItemIds: readonly string[];
  readonly lockedPortions: readonly LockedPortion[];
  readonly constraints: RecommendationConstraints;
}

export interface MealPortion {
  readonly menuItemId: string;
  readonly servingId: string;
  readonly amount: number;
  readonly displayAmount: string;
  readonly nutrition: Nutrition;
}

export interface MealRecommendation {
  readonly portions: readonly MealPortion[];
  readonly totalNutrition: Nutrition;
  readonly differences: Partial<Nutrition>;
  readonly score: number;
  readonly warnings: readonly string[];
}

export interface MealOptimizer {
  optimize(request: MealRequest): MealRecommendation;
}
