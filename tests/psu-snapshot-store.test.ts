import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { MenuQuery } from "../domain/dining.ts";
import { PsuStructuralError } from "../infrastructure/psu/errors.ts";
import { PsuIngestionPipeline } from "../infrastructure/psu/ingestion-pipeline.ts";
import { parsePsuMenuHtml } from "../infrastructure/psu/menu-parser.ts";
import { parsePsuNutritionHtml } from "../infrastructure/psu/nutrition-parser.ts";
import { validatePsuReleaseCacheDirectory } from "../infrastructure/psu/release-cache.ts";
import { PsuHttpRetriever } from "../infrastructure/psu/retriever.ts";
import {
  buildPsuSnapshot,
  toNutritionCacheEntry,
} from "../infrastructure/psu/snapshot-schema.ts";
import { FilePsuSnapshotStore } from "../infrastructure/psu/snapshot-store.ts";

const fixtureDirectory = path.resolve("tests/fixtures/psu");
const query: MenuQuery = {
  serviceDate: "2026-08-31",
  hallId: "psu:campus:11",
  mealPeriodId: "lunch",
  venueIds: [],
};
const timestamp = new Date("2026-08-31T16:00:00.000Z");

test("file cache writes atomically and rejects mismatched or corrupted records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-psu-cache-"));
  try {
    const menu = parsePsuMenuHtml(await fixture("menu-east-lunch.sanitized.html"), {
      sourceCampusId: "11",
      sourceDate: "8/31/26",
      sourceMeal: "Lunch",
    });
    const chicken = parsePsuNutritionHtml(await fixture("nutrition-900000001.sanitized.html"));
    const rice = parsePsuNutritionHtml(await fixture("nutrition-900000002.sanitized.html"));
    const snapshot = buildPsuSnapshot(query, menu, new Map([
      ["900000001", chicken],
      ["900000002", rice],
    ]), {
      retrievedAt: timestamp,
      cachedAt: timestamp,
      freshForMs: 300_000,
      retainForMs: 172_800_000,
    });
    const store = new FilePsuSnapshotStore(root);
    await store.writeMenu(snapshot);
    assert.deepEqual(await store.readMenu(query), snapshot);

    const menuDirectory = path.join(root, "lionlog.psu-menu.v2");
    const menuFiles = await readdir(menuDirectory);
    assert.equal(menuFiles.length, 1);
    assert.match(menuFiles[0], /^[a-f0-9]{64}\.json$/);
    const menuPath = path.join(menuDirectory, menuFiles[0]);
    const corrupted = JSON.parse(await readFile(menuPath, "utf8"));
    corrupted.query.sourceCampusId = "99";
    await writeFile(menuPath, JSON.stringify(corrupted), "utf8");
    await assert.rejects(store.readMenu(query), PsuStructuralError);

    const nutrition = toNutritionCacheEntry("900000001", chicken, timestamp, 86_400_000);
    await store.writeNutrition(nutrition);
    const nutritionPath = path.join(root, "lionlog.psu-nutrition.v2", "900000001.json");
    const mismatched = {
      ...nutrition,
      sourceHandle: "900000002",
      sourceUrl: "https://www.absecom.psu.edu/menus/user-pages/nutrition-label.cfm?mid=900000002",
    };
    await writeFile(nutritionPath, JSON.stringify(mismatched), "utf8");
    await assert.rejects(store.readNutrition("900000001"), /lookup key/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validated nutrition cache survives a failed run and safely resumes without partial menu publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-psu-resume-"));
  try {
    const store = new FilePsuSnapshotStore(root);
    const firstRetriever = new PsuHttpRetriever({
      fetchImpl: fixtureFetch(),
      minimumIntervalMs: 0,
      jitterMs: 0,
      maximumAttempts: 1,
      maximumRequests: 2,
      now: () => timestamp.getTime(),
    });
    const first = await new PsuIngestionPipeline(firstRetriever, store, { now: () => timestamp }).run(query);
    assert.equal(first.state, "unavailable");
    assert.equal((await store.listMenus()).length, 0);
    assert.deepEqual(
      await validatePsuReleaseCacheDirectory(path.join(root, "lionlog.psu-nutrition.v2")),
      { restored: true, entryCount: 1 },
    );

    const resumedRetriever = new PsuHttpRetriever({
      fetchImpl: fixtureFetch(),
      minimumIntervalMs: 0,
      jitterMs: 0,
      maximumAttempts: 1,
      maximumRequests: 2,
      now: () => timestamp.getTime(),
    });
    const resumedPipeline = new PsuIngestionPipeline(resumedRetriever, store, { now: () => timestamp });
    const resumed = await resumedPipeline.run(query);
    assert.equal(resumed.state, "live");
    assert.equal(resumedRetriever.telemetry.menuRequests, 1);
    assert.equal(resumedRetriever.telemetry.nutritionRequests, 1);
    assert.equal(resumedPipeline.telemetry.nutritionCacheHits, 1);
    assert.equal((await store.listMenus()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release cache validation rejects poisoned and wrong-version entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-psu-poisoned-cache-"));
  try {
    const store = new FilePsuSnapshotStore(root);
    const detail = parsePsuNutritionHtml(await fixture("nutrition-900000001.sanitized.html"));
    await store.writeNutrition(toNutritionCacheEntry("900000001", detail, timestamp, 86_400_000));
    const nutritionRoot = path.join(root, "lionlog.psu-nutrition.v2");
    const entryPath = path.join(nutritionRoot, "900000001.json");
    const entry = JSON.parse(await readFile(entryPath, "utf8"));
    entry.parserVersion = "psu-html.poisoned";
    await writeFile(entryPath, JSON.stringify(entry), "utf8");
    await assert.rejects(validatePsuReleaseCacheDirectory(nutritionRoot), /Invalid PSU nutrition cache entry/);
    await assert.rejects(
      validatePsuReleaseCacheDirectory(path.join(root, "lionlog.psu-nutrition.v1")),
      /directory version/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtureDirectory, name), "utf8");
}

function fixtureFetch(): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    const body = url.pathname.endsWith("/daily-menu.cfm")
      ? await fixture("menu-east-lunch.sanitized.html")
      : await fixture(`nutrition-${url.searchParams.get("mid")}.sanitized.html`);
    const response = new Response(body, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  };
}
