import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(
  projectRoot,
  "tests",
  "fixtures",
  "psu",
  "sanitized-menu-observation.v1.json",
);

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

test("sanitized PSU fixture preserves source units without retaining HTML", async () => {
  const fixtureText = await readFile(fixturePath, "utf8");
  const fixture = JSON.parse(fixtureText);

  assert.doesNotMatch(fixtureText, /<(?:script|style|div|span|img|a)\b/i);
  assert.equal(fixture.fixtureVersion, "psu-sanitized-observation.v1");
  assert.equal(fixture.items[0].serving.label, "1 SERVG");
  assert.equal(fixture.items[0].serving.unit, "SERVG");
  assert.equal("ounces" in fixture.items[0].serving, false);
  assert.equal("gramWeight" in fixture.items[0].serving, false);
});

test("same-name PSU observations remain distinct", async () => {
  const fixture = await loadFixture();
  const [first, second] = fixture.items;

  assert.equal(first.name, second.name);
  assert.equal(first.serving.label, second.serving.label);
  assert.notEqual(first.sourceHandle, second.sourceHandle);
  assert.notDeepEqual(first.nutrition, second.nutrition);
  assert.match(first.nutritionUrl, /^https:\/\/www\.absecom\.psu\.edu\/menus\/user-pages\/nutrition-label\.cfm\?mid=\d+$/);
  assert.match(second.nutritionUrl, /^https:\/\/www\.absecom\.psu\.edu\/menus\/user-pages\/nutrition-label\.cfm\?mid=\d+$/);
});
