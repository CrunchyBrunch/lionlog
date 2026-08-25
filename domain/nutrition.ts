export interface Nutrition {
  readonly calories: number;
  readonly proteinG: number;
  readonly carbsG: number;
  readonly fatG: number;
}

export interface Serving {
  readonly id: string;
  readonly sourceQuantity: number;
  readonly sourceUnit: string;
  readonly displayLabel: string;
  readonly nutrition: Nutrition;
  readonly gramWeight?: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly increment: number;
}

export interface FoodItem {
  readonly id: string;
  readonly name: string;
  readonly servings: readonly Serving[];
  readonly tags?: readonly string[];
}
