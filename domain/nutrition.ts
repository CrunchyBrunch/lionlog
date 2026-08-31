export interface Nutrition {
  readonly calories: number | null;
  readonly proteinG: number | null;
  readonly carbsG: number | null;
  readonly fatG: number | null;
  readonly additional?: AdditionalNutrition;
}

export interface AdditionalNutrition {
  readonly saturatedFatG: number | null;
  readonly transFatG: number | null;
  readonly cholesterolMg: number | null;
  readonly sodiumMg: number | null;
  readonly fiberG: number | null;
  readonly sugarsG: number | null;
  readonly addedSugarsG: number | null;
  readonly vitaminDMcg: number | null;
  readonly calciumMg: number | null;
  readonly ironMg: number | null;
  readonly potassiumMg: number | null;
}

export interface Serving {
  readonly id: string;
  readonly sourceQuantity: number | null;
  readonly sourceUnit: string | null;
  readonly displayLabel: string;
  readonly nutrition: Nutrition;
  readonly gramWeight?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly increment?: number;
}

export interface FoodItem {
  readonly id: string;
  readonly name: string;
  readonly servings: readonly Serving[];
  readonly tags?: readonly string[];
  readonly dietaryTraits?: readonly DietaryTrait[];
  readonly allergens?: readonly Allergen[];
  readonly ingredients?: string | null;
  readonly sourceHandle?: string;
  readonly sourceUrl?: string;
}

export type DietaryTrait =
  | "vegan"
  | "meatless"
  | "gluten-friendly"
  | "halal-friendly"
  | "contains-pork";

export type Allergen =
  | "dairy"
  | "eggs"
  | "fish"
  | "shellfish"
  | "peanuts"
  | "tree-nuts"
  | "soy"
  | "wheat-gluten"
  | "sesame"
  | "coconut";
