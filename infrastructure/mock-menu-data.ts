import type { DiningHall, DiningVenue, MealPeriod } from "../domain/dining.ts";
import type { FoodItem } from "../domain/nutrition.ts";

export const sampleHalls = [
  { id: "north-commons", displayName: "North Commons", timeZone: "America/New_York" },
  { id: "south-commons", displayName: "South Commons", timeZone: "America/New_York" },
] as const satisfies readonly DiningHall[];

export const samplePeriods = [
  { id: "breakfast", displayName: "Breakfast" },
  { id: "lunch", displayName: "Lunch" },
  { id: "dinner", displayName: "Dinner" },
] as const satisfies readonly MealPeriod[];

export const sampleVenues = [
  { id: "north-grill", hallId: "north-commons", displayName: "The Grill" },
  { id: "north-bowls", hallId: "north-commons", displayName: "Grain & Greens" },
  { id: "north-market", hallId: "north-commons", displayName: "Market Kitchen" },
  { id: "south-hearth", hallId: "south-commons", displayName: "The Hearth" },
  { id: "south-pasta", hallId: "south-commons", displayName: "Pasta Works" },
  { id: "south-garden", hallId: "south-commons", displayName: "Garden Bar" },
] as const satisfies readonly DiningVenue[];

const foods = {
  herbChicken: food("herb-chicken", "Herb roasted chicken", "1 breast", "piece", 1, 240, 35, 3, 9, 118, ["protein"]),
  brownRice: food("brown-rice", "Brown rice", "1 scoop", "scoop", 1, 180, 4, 38, 2, 142, ["grain"]),
  broccoli: food("roasted-broccoli", "Roasted broccoli", "1 scoop", "scoop", 1, 70, 3, 10, 3, 96, ["vegetable"]),
  turkeyBurger: food("turkey-burger", "Turkey burger", "1 patty", "piece", 1, 260, 29, 8, 12, 132, ["protein"]),
  quinoa: food("lemon-quinoa", "Lemon herb quinoa", "1 scoop", "scoop", 1, 210, 7, 36, 5, 148, ["grain"]),
  tofu: food("sesame-tofu", "Sesame glazed tofu", "1 scoop", "scoop", 1, 220, 17, 15, 11, 125, ["protein", "plant-based"]),
  eggs: food("scrambled-eggs", "Soft scrambled eggs", "1 scoop", "scoop", 1, 190, 15, 3, 13, 120, ["protein", "breakfast"]),
  oats: food("steel-cut-oats", "Steel-cut oats", "1 bowl", "bowl", 1, 230, 8, 41, 5, 275, ["grain", "breakfast"]),
  salmon: food("roasted-salmon", "Citrus roasted salmon", "1 fillet", "piece", 1, 290, 32, 2, 17, 145, ["protein"]),
  pasta: food("tomato-pasta", "Tomato basil pasta", "1 bowl", "bowl", 1, 360, 13, 62, 8, 310, ["grain"]),
  lentils: food("braised-lentils", "Braised lentils", "1 scoop", "scoop", 1, 190, 12, 31, 3, 150, ["protein", "plant-based"]),
  salad: food("garden-salad", "Chopped garden salad", "1 bowl", "bowl", 1, 90, 4, 12, 4, 205, ["vegetable"]),
} as const;

function food(
  id: string,
  name: string,
  displayLabel: string,
  sourceUnit: string,
  sourceQuantity: number,
  calories: number,
  proteinG: number,
  carbsG: number,
  fatG: number,
  gramWeight: number | undefined,
  tags: readonly string[],
): FoodItem {
  return {
    id,
    name,
    tags,
    servings: [{
      id: `${id}-standard`,
      sourceQuantity,
      sourceUnit,
      displayLabel,
      nutrition: { calories, proteinG, carbsG, fatG },
      gramWeight,
      minimum: 0.5,
      maximum: 3,
      increment: 0.5,
    }],
  };
}

export interface SampleMenuTemplate {
  readonly id: string;
  readonly hallId: string;
  readonly venueId: string;
  readonly periodIds: readonly string[];
  readonly food: FoodItem;
}

export const sampleMenuTemplates: readonly SampleMenuTemplate[] = [
  template("north-chicken", "north-commons", "north-grill", ["lunch", "dinner"], foods.herbChicken),
  template("north-burger", "north-commons", "north-grill", ["lunch", "dinner"], foods.turkeyBurger),
  template("north-rice", "north-commons", "north-bowls", ["lunch", "dinner"], foods.brownRice),
  template("north-broccoli", "north-commons", "north-bowls", ["lunch", "dinner"], foods.broccoli),
  template("north-quinoa", "north-commons", "north-bowls", ["lunch", "dinner"], foods.quinoa),
  template("north-tofu", "north-commons", "north-market", ["lunch", "dinner"], foods.tofu),
  template("north-eggs", "north-commons", "north-market", ["breakfast"], foods.eggs),
  template("north-oats", "north-commons", "north-market", ["breakfast"], foods.oats),
  template("south-salmon", "south-commons", "south-hearth", ["dinner"], foods.salmon),
  template("south-chicken", "south-commons", "south-hearth", ["lunch", "dinner"], foods.herbChicken),
  template("south-pasta", "south-commons", "south-pasta", ["lunch", "dinner"], foods.pasta),
  template("south-lentils", "south-commons", "south-garden", ["lunch", "dinner"], foods.lentils),
  template("south-salad", "south-commons", "south-garden", ["lunch", "dinner"], foods.salad),
  template("south-eggs", "south-commons", "south-hearth", ["breakfast"], foods.eggs),
];

function template(
  id: string,
  hallId: string,
  venueId: string,
  periodIds: readonly string[],
  item: FoodItem,
): SampleMenuTemplate {
  return { id, hallId, venueId, periodIds, food: item };
}
