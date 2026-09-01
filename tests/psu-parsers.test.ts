import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PsuStructuralError } from "../infrastructure/psu/errors.ts";
import { parsePsuMenuHtml } from "../infrastructure/psu/menu-parser.ts";
import { parsePsuNutritionHtml } from "../infrastructure/psu/nutrition-parser.ts";

const fixtureDirectory = path.resolve("tests/fixtures/psu");

test("pure menu parser preserves station, meal context, names, handles, and dietary metadata", async () => {
  const parsed = parsePsuMenuHtml(await fixture("menu-east-lunch.sanitized.html"), {
    sourceCampusId: "11",
    sourceDate: "8/31/26",
    sourceMeal: "Lunch",
  });

  assert.equal(parsed.empty, false);
  assert.deepEqual(parsed.stations.map((station) => station.displayName), [
    "PURE",
    "VEGETABLES/STARCHES",
  ]);
  assert.deepEqual(parsed.stations[0].items[0], {
    name: "Fixture Lemon Chicken",
    sourceHandle: "900000001",
    dietaryTraits: ["gluten-friendly", "halal-friendly"],
  });
  assert.deepEqual(parsed.stations[1].items[0].dietaryTraits, ["vegan"]);
});

test("pure menu parser distinguishes a validated empty menu from structural failure", async () => {
  const empty = parsePsuMenuHtml(await fixture("menu-empty.sanitized.html"), {
    sourceCampusId: "17",
    sourceDate: "8/31/26",
    sourceMeal: "Late Night",
  });
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.stations, []);

  assert.throws(
    () => parsePsuMenuHtml(
      "<html><body><p>temporary upstream page</p></body></html>",
      { sourceCampusId: "11", sourceDate: "8/31/26", sourceMeal: "Lunch" },
    ),
    PsuStructuralError,
  );
});

test("menu parser validates the returned selected meal value instead of the requested label", async () => {
  const html = await fixture("menu-east-lunch.sanitized.html");
  assert.throws(
    () => parsePsuMenuHtml(html, {
      sourceCampusId: "11",
      sourceDate: "8/31/26",
      sourceMeal: "Dinner",
    }),
    /did not echo the requested selMeal/i,
  );
});

test("menu fixture changes fail closed at category, item, link, and dietary boundaries", async () => {
  const html = await fixture("menu-east-lunch.sanitized.html");
  const expected = {
    sourceCampusId: "11",
    sourceDate: "8/31/26",
    sourceMeal: "Lunch",
  };

  assert.throws(
    () => parsePsuMenuHtml(html.replaceAll("menu-category-section", "menu-category-changed"), expected),
    /neither validated items nor a recognized empty state/i,
  );
  assert.throws(
    () => parsePsuMenuHtml(html.replaceAll("menu-items daily-menu-item", "menu-items daily-menu-changed"), expected),
    /neither validated items nor a recognized empty state/i,
  );
  assert.throws(
    () => parsePsuMenuHtml(html.replaceAll("daily-menu-item__link", "daily-menu-item__link-changed"), expected),
    /missing its nutrition link/i,
  );
  assert.throws(
    () => parsePsuMenuHtml(html.replace("alt=\"Halal Friendly\"", "alt=\"Dietary Marker Changed\""), expected),
    /unknown PSU dietary marker/i,
  );
});

test("pure nutrition parser preserves source precision, units, ingredients, and allergens", async () => {
  const detail = parsePsuNutritionHtml(await fixture("nutrition-900000001.sanitized.html"));

  assert.equal(detail.name, "Fixture Lemon Chicken");
  assert.equal(detail.servingLabel, "1 EACH");
  assert.equal(detail.sourceQuantity, 1);
  assert.equal(detail.sourceUnit, "EACH");
  assert.equal(detail.calories, 305);
  assert.equal(detail.proteinG, 42.1);
  assert.equal(detail.additional.cholesterolMg, 226.2);
  assert.equal(detail.additional.vitaminDMcg, 0.3);
  assert.equal(detail.ingredients, "Chicken, rosemary, lemon seasoning.");
  assert.deepEqual(detail.allergens, []);
});

test("source-unavailable nutrient values remain null rather than zero", async () => {
  const detail = parsePsuNutritionHtml(await fixture("nutrition-900000003.sanitized.html"));

  assert.equal(detail.servingLabel, "1/2 BOWL");
  assert.equal(detail.sourceQuantity, null);
  assert.equal(detail.sourceUnit, "BOWL");
  assert.equal(detail.calories, null);
  assert.equal(detail.proteinG, null);
  assert.equal(detail.carbsG, null);
  assert.equal(detail.fatG, null);
  assert.equal(detail.additional.sodiumMg, 610.5);
  assert.deepEqual(detail.allergens, ["dairy", "soy", "wheat-gluten"]);
});

test("an explicit PSU unavailable-nutrition page preserves null source fields", async () => {
  const parsed = parsePsuNutritionHtml(await fixture("nutrition-unavailable.sanitized.html"));
  assert.equal(parsed.name, null);
  assert.equal(parsed.servingLabel, null);
  assert.equal(parsed.sourceQuantity, null);
  assert.equal(parsed.sourceUnit, null);
  assert.equal(parsed.calories, null);
  assert.equal(parsed.proteinG, null);
  assert.equal(parsed.ingredients, null);
  assert.deepEqual(parsed.allergens, []);
});

test("nutrition parser fails closed when a required fact label disappears", async () => {
  const changed = (await fixture("nutrition-900000001.sanitized.html"))
    .replace("<div class=\"fact-name\">Protein</div>", "<div class=\"fact-name\">Protein Changed</div>");
  assert.throws(() => parsePsuNutritionHtml(changed), /missing the Protein field/i);
});

test("every committed PSU HTML fixture is explicitly sanitized and deterministic", async () => {
  const names = (await readdir(fixtureDirectory)).filter((name) => name.endsWith(".html"));
  assert.ok(names.length >= 7);
  for (const name of names) {
    const html = await fixture(name);
    assert.match(html, /SANITIZED DETERMINISTIC/);
    assert.doesNotMatch(html, /<(?:script|style)\b/i);
    assert.doesNotMatch(html, /mailto:|@psu\.edu/i);
  }
});

function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtureDirectory, name), "utf8");
}
