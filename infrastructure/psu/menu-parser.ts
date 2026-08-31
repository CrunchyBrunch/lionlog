import type { DietaryTrait } from "../../domain/nutrition.ts";
import { PsuStructuralError } from "./errors.ts";
import {
  descendants,
  firstDescendant,
  getAttribute,
  hasClass,
  normalizeText,
  normalizedText,
  parseHtml,
  type HtmlElement,
} from "./html-tree.ts";

export interface PsuMenuParseContext {
  readonly sourceCampusId: string;
  readonly sourceDate: string;
  readonly sourceMeal: string;
}

export interface ParsedPsuMenuItem {
  readonly name: string;
  readonly sourceHandle: string;
  readonly dietaryTraits: readonly DietaryTrait[];
}

export interface ParsedPsuStation {
  readonly displayName: string;
  readonly items: readonly ParsedPsuMenuItem[];
}

export interface ParsedPsuMenu {
  readonly context: PsuMenuParseContext;
  readonly stations: readonly ParsedPsuStation[];
  readonly empty: boolean;
}

const dietaryMarkerMap = new Map<string, DietaryTrait>([
  ["Vegan", "vegan"],
  ["Meatless", "meatless"],
  ["Gluten Friendly - made w/o gluten-containing items", "gluten-friendly"],
  ["Halal Friendly", "halal-friendly"],
  ["Contains Pork", "contains-pork"],
]);

export function parsePsuMenuHtml(html: string, expected: PsuMenuParseContext): ParsedPsuMenu {
  const document = parseHtml(html);
  assertSelectedValue(document, "selCampus", expected.sourceCampusId);
  assertSelectedValue(document, "selMenuDate", expected.sourceDate);
  assertSelectedValue(document, "selMeal", expected.sourceMeal);

  const categoryElements = descendants(document, (element) => hasClass(element, "menu-category-section"));
  const stations = categoryElements.map(parseStation);
  const itemCount = stations.reduce((total, station) => total + station.items.length, 0);
  const recognizedEmpty = descendants(document, (element) =>
    hasClass(element, "daily-menu-empty") || getAttribute(element, "data-menu-empty") !== undefined
  ).some((element) => /no (?:menu items|items|menu) (?:are )?available/i.test(normalizedText(element)));

  if (itemCount === 0 && !recognizedEmpty) {
    throw new PsuStructuralError("PSU menu response contained neither validated items nor a recognized empty state.");
  }

  return { context: expected, stations, empty: itemCount === 0 };
}

function assertSelectedValue(root: ReturnType<typeof parseHtml>, name: string, expected: string): void {
  const select = firstDescendant(root, (element) =>
    element.tagName === "select" && getAttribute(element, "name") === name
  );
  if (!select) throw new PsuStructuralError(`PSU menu response is missing ${name}.`);
  const selected = firstDescendant(select, (element) =>
    element.tagName === "option" && getAttribute(element, "selected") !== undefined
  );
  if (!selected || getAttribute(selected, "value") !== expected) {
    throw new PsuStructuralError(`PSU menu response did not echo the requested ${name}.`);
  }
}

function parseStation(element: HtmlElement): ParsedPsuStation {
  const heading = firstDescendant(element, (candidate) => candidate.tagName === "h2");
  if (!heading) throw new PsuStructuralError("PSU menu category is missing its heading.");
  const displayName = boundedText(normalizedText(heading), "station", 100);
  const itemElements = descendants(element, (candidate) => hasClass(candidate, "daily-menu-item"));
  return { displayName, items: itemElements.map(parseMenuItem) };
}

function parseMenuItem(element: HtmlElement): ParsedPsuMenuItem {
  const link = firstDescendant(element, (candidate) =>
    candidate.tagName === "a" && hasClass(candidate, "daily-menu-item__link")
  );
  if (!link) throw new PsuStructuralError("PSU menu item is missing its nutrition link.");
  const href = getAttribute(link, "href") ?? "";
  const handleMatch = /^(?:\.\/)?nutrition-label\.cfm\?mid=(\d+)$/.exec(href);
  if (!handleMatch) throw new PsuStructuralError("PSU menu item has an unexpected nutrition URL.");
  const name = boundedText(normalizedText(link), "food name", 160);

  const dietaryTraits = descendants(element, (candidate) => candidate.tagName === "img")
    .map((image) => normalizeText(getAttribute(image, "alt") ?? ""))
    .filter(Boolean)
    .map((marker) => {
      const trait = dietaryMarkerMap.get(marker);
      if (!trait) throw new PsuStructuralError(`Unknown PSU dietary marker: ${marker}`);
      return trait;
    });

  return {
    name,
    sourceHandle: handleMatch[1],
    dietaryTraits: [...new Set(dietaryTraits)],
  };
}

function boundedText(value: string, field: string, maximum: number): string {
  if (!value || value.length > maximum) {
    throw new PsuStructuralError(`PSU ${field} failed length validation.`);
  }
  return value;
}
