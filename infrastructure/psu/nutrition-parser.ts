import type { AdditionalNutrition, Allergen } from "../../domain/nutrition.ts";
import { PsuStructuralError } from "./errors.ts";
import {
  descendants,
  firstDescendant,
  hasClass,
  normalizeText,
  normalizedText,
  parseHtml,
  type HtmlElement,
} from "./html-tree.ts";

export interface ParsedPsuNutrition {
  readonly name: string;
  readonly servingLabel: string;
  readonly sourceQuantity: number | null;
  readonly sourceUnit: string | null;
  readonly calories: number | null;
  readonly proteinG: number | null;
  readonly carbsG: number | null;
  readonly fatG: number | null;
  readonly additional: AdditionalNutrition;
  readonly ingredients: string | null;
  readonly allergens: readonly Allergen[];
}

const allergenMap = new Map<string, Allergen>([
  ["Dairy", "dairy"],
  ["Egg", "eggs"],
  ["Eggs", "eggs"],
  ["Fish", "fish"],
  ["Shellfish", "shellfish"],
  ["Peanuts", "peanuts"],
  ["Tree Nuts", "tree-nuts"],
  ["Soy", "soy"],
  ["Wheat/Gluten", "wheat-gluten"],
  ["Sesame", "sesame"],
  ["Coconut", "coconut"],
]);

export function parsePsuNutritionHtml(html: string): ParsedPsuNutrition {
  const document = parseHtml(html);
  const title = firstDescendant(document, (element) => hasClass(element, "recipe-title"));
  if (!title) throw new PsuStructuralError("PSU nutrition response is missing the recipe title.");

  const summaryValues = descendants(document, (element) => hasClass(element, "summary-value"));
  const servingText = summaryValues.map(normalizedText).find((value) => /^Serving Size\b/i.test(value));
  const caloriesText = summaryValues.map(normalizedText).find((value) => /^Calories:/i.test(value));
  if (!servingText || !caloriesText) {
    throw new PsuStructuralError("PSU nutrition response is missing serving or calorie fields.");
  }

  const servingLabel = normalizeText(servingText.replace(/^Serving Size\s*/i, ""));
  if (!servingLabel || servingLabel.length > 80) {
    throw new PsuStructuralError("PSU serving label failed validation.");
  }
  const serving = parseServing(servingLabel);
  const facts = new Map<string, string>();
  for (const row of descendants(document, (element) => hasClass(element, "fact-row"))) {
    const name = firstDescendant(row, (element) => hasClass(element, "fact-name"));
    const amount = firstDescendant(row, (element) => hasClass(element, "fact-amount"));
    if (name && amount) facts.set(normalizedText(name), normalizedText(amount));
  }

  const ingredients = paragraphAfterHeading(document, "ingredientsHeading");
  const allergensText = paragraphAfterHeading(document, "allergensHeading");
  const allergens = allergensText
    ? allergensText.split(",").map((value) => normalizeText(value)).filter(Boolean).map(parseAllergen)
    : [];

  return {
    name: boundedText(normalizedText(title), "recipe title", 160),
    servingLabel,
    sourceQuantity: serving.quantity,
    sourceUnit: serving.unit,
    calories: parseUnitless(caloriesText.replace(/^Calories:\s*/i, ""), "Calories"),
    proteinG: parseAmount(facts.get("Protein"), "g", "Protein"),
    carbsG: parseAmount(facts.get("Total Carbohydrate"), "g", "Total Carbohydrate"),
    fatG: parseAmount(facts.get("Total Fat"), "g", "Total Fat"),
    additional: {
      saturatedFatG: parseAmount(facts.get("Saturated Fat"), "g", "Saturated Fat"),
      transFatG: parseAmount(facts.get("Trans Fat"), "g", "Trans Fat"),
      cholesterolMg: parseAmount(facts.get("Cholesterol"), "mg", "Cholesterol"),
      sodiumMg: parseAmount(facts.get("Sodium"), "mg", "Sodium"),
      fiberG: parseAmount(facts.get("Dietary Fiber"), "g", "Dietary Fiber"),
      sugarsG: parseAmount(facts.get("Sugars"), "g", "Sugars"),
      addedSugarsG: parseAmount(facts.get("Added Sugars"), "g", "Added Sugars"),
      vitaminDMcg: parseAmount(facts.get("Vitamin D"), "mcg", "Vitamin D"),
      calciumMg: parseAmount(facts.get("Calcium"), "mg", "Calcium"),
      ironMg: parseAmount(facts.get("Iron"), "mg", "Iron"),
      potassiumMg: parseAmount(facts.get("Potassium"), "mg", "Potassium"),
    },
    ingredients: ingredients ? boundedText(ingredients, "ingredients", 20_000) : null,
    allergens: [...new Set(allergens)],
  };
}

function paragraphAfterHeading(root: ReturnType<typeof parseHtml>, headingId: string): string {
  const heading = firstDescendant(root, (element) =>
    element.tagName === "h2" && element.attrs.some((attribute) => attribute.name === "id" && attribute.value === headingId)
  );
  if (!heading?.parentNode || !("childNodes" in heading.parentNode)) return "";
  const paragraph = heading.parentNode.childNodes.find(
    (node): node is HtmlElement => "tagName" in node && node.tagName === "p",
  );
  return paragraph ? normalizedText(paragraph) : "";
}

function parseServing(label: string): { quantity: number | null; unit: string | null } {
  const match = /^(?:(\d+(?:\.\d+)?)|(?:\d+\s+)?\d+\/\d+)\s+(.+)$/.exec(label);
  if (!match) return { quantity: null, unit: null };
  return {
    quantity: match[1] ? Number(match[1]) : null,
    unit: normalizeText(match[2]),
  };
}

function parseAllergen(value: string): Allergen {
  const allergen = allergenMap.get(value);
  if (!allergen) throw new PsuStructuralError(`Unknown PSU allergen: ${value}`);
  return allergen;
}

function parseUnitless(value: string | undefined, field: string): number | null {
  if (isMissing(value)) return null;
  if (!/^\d+(?:\.\d+)?$/.test(value!)) throw new PsuStructuralError(`${field} has an unexpected value.`);
  return finiteNonnegative(Number(value), field);
}

function parseAmount(value: string | undefined, unit: string, field: string): number | null {
  if (isMissing(value)) return null;
  const match = new RegExp(`^(\\d+(?:\\.\\d+)?)${unit}$`, "i").exec(value!);
  if (!match) throw new PsuStructuralError(`${field} has an unexpected unit or value.`);
  return finiteNonnegative(Number(match[1]), field);
}

function isMissing(value: string | undefined): boolean {
  return value === undefined || value === "" || /^(?:-|–|—)$/.test(value);
}

function finiteNonnegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new PsuStructuralError(`${field} must be nonnegative.`);
  return value;
}

function boundedText(value: string, field: string, maximum: number): string {
  if (!value || value.length > maximum) throw new PsuStructuralError(`PSU ${field} failed length validation.`);
  return value;
}
