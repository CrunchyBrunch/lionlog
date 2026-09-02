import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { MenuQuery } from "../domain/dining.ts";
import { PsuIngestionPipeline } from "../infrastructure/psu/ingestion-pipeline.ts";
import { PsuMenuProvider } from "../infrastructure/psu/psu-menu-provider.ts";
import { PsuHttpRetriever } from "../infrastructure/psu/retriever.ts";
import {
  buildPsuSnapshot,
  validatePsuSnapshot,
} from "../infrastructure/psu/snapshot-schema.ts";
import {
  MemoryPsuSnapshotStore,
  type PsuSnapshotStore,
} from "../infrastructure/psu/snapshot-store.ts";
import { parsePsuNutritionHtml } from "../infrastructure/psu/nutrition-parser.ts";

const fixtureDirectory = path.resolve("tests/fixtures/psu");
const now = new Date("2026-08-31T16:00:00.000Z");
const eastLunchQuery: MenuQuery = {
  serviceDate: "2026-08-31",
  hallId: "psu:campus:11",
  mealPeriodId: "lunch",
  venueIds: [],
};

test("two representative hall/meal fixtures produce validated live snapshots", async () => {
  const east = await runFixtureIngestion(eastLunchQuery, fixtureFetch());
  assert.equal(east.state, "live");
  if (east.state !== "live") return;
  assert.equal(east.report.stationCount, 2);
  assert.equal(east.report.itemCount, 2);
  assert.equal(east.snapshot.query.sourceMeal, "Lunch");

  const pollock = await runFixtureIngestion({
    serviceDate: "2026-08-31",
    hallId: "psu:campus:14",
    mealPeriodId: "dinner",
    venueIds: [],
  }, fixtureFetch());
  assert.equal(pollock.state, "live");
  if (pollock.state !== "live") return;
  const item = pollock.snapshot.stations[0].items[0];
  assert.equal(item.serving.label, "1/2 BOWL");
  assert.equal(item.serving.quantity, null);
  assert.equal(item.serving.unit, "BOWL");
  assert.equal(item.nutrition.calories, null);
  assert.equal(item.nutrition.additional.sodiumMg, 610.5);
  assert.equal(item.ingredients, "Vegetables, broth, herbs.");
  assert.deepEqual(item.allergens, ["dairy", "soy", "wheat-gluten"]);
});

test("a repeated ingestion reuses cached nutrition while refreshing the menu", async () => {
  const calls = { menu: 0, nutrition: 0 };
  const store = new MemoryPsuSnapshotStore();
  const pipeline = pipelineFor(fixtureFetch(calls), store);

  const first = await pipeline.run(eastLunchQuery);
  const second = await pipeline.run(eastLunchQuery);
  assert.equal(first.state, "live");
  assert.equal(second.state, "live");
  if (first.state !== "live" || second.state !== "live") return;
  assert.equal(first.report.nutritionRequests, 2);
  assert.equal(first.report.nutritionCacheHits, 0);
  assert.equal(second.report.nutritionRequests, 0);
  assert.equal(second.report.nutritionCacheHits, 2);
  assert.deepEqual(calls, { menu: 2, nutrition: 2 });
});

test("PsuMenuProvider maps live, cached, stale, and unavailable states without sample fallback", async () => {
  const store = new MemoryPsuSnapshotStore();
  const result = await pipelineFor(fixtureFetch(), store).run(eastLunchQuery);
  assert.equal(result.state, "live");
  if (result.state !== "live") return;

  const liveProvider = new PsuMenuProvider(store, {
    activeSnapshot: { state: "live", snapshot: result.snapshot },
    now: () => now,
  });
  const live = await liveProvider.getMenu(eastLunchQuery);
  assert.equal(live.source.mode, "live");
  assert.equal(live.items[0].food.servings[0].sourceUnit, "EACH");
  assert.equal(live.items[0].food.sourceHandle, "900000001");
  assert.match(live.items[0].food.sourceUrl ?? "", /nutrition-label\.cfm\?mid=900000001$/);

  const expiredActiveProvider = new PsuMenuProvider(store, {
    activeSnapshot: { state: "live", snapshot: result.snapshot },
    now: () => new Date(now.getTime() + 49 * 60 * 60 * 1_000),
  });
  const expiredActive = await expiredActiveProvider.getMenu(eastLunchQuery);
  assert.equal(expiredActive.source.mode, "unavailable");
  assert.deepEqual(expiredActive.items, []);
  assert.deepEqual(await expiredActiveProvider.getVenues(eastLunchQuery.hallId), []);

  const cached = await new PsuMenuProvider(store, { now: () => now }).getMenu(eastLunchQuery);
  assert.equal(cached.source.mode, "cached");
  const stale = await new PsuMenuProvider(store, {
    now: () => new Date(now.getTime() + 6 * 60 * 1_000),
  }).getMenu(eastLunchQuery);
  assert.equal(stale.source.mode, "stale");
  const unavailable = await new PsuMenuProvider(store, {
    now: () => new Date(now.getTime() + 49 * 60 * 60 * 1_000),
  }).getMenu(eastLunchQuery);
  assert.equal(unavailable.source.mode, "unavailable");
  assert.deepEqual(unavailable.items, []);
  assert.match(unavailable.source.warning ?? "", /Sample data was not substituted/);
});

test("validated empty menus are live and do not request nutrition", async () => {
  const calls = { menu: 0, nutrition: 0 };
  const query: MenuQuery = {
    serviceDate: "2026-08-31",
    hallId: "psu:campus:17",
    mealPeriodId: "late-night",
    venueIds: [],
  };
  const result = await runFixtureIngestion(query, fixtureFetch(calls));
  assert.equal(result.state, "live");
  if (result.state !== "live") return;
  assert.equal(result.report.itemCount, 0);
  assert.equal(result.report.nutritionRequests, 0);
  assert.deepEqual(calls, { menu: 1, nutrition: 0 });
});

test("ingestion fails before nutrition retrieval when a per-query release bound is exceeded", async () => {
  const calls = { menu: 0, nutrition: 0 };
  const retriever = new PsuHttpRetriever({
    fetchImpl: fixtureFetch(calls),
    minimumIntervalMs: 0,
    jitterMs: 0,
    maximumAttempts: 1,
    now: () => now.getTime(),
  });
  const result = await new PsuIngestionPipeline(retriever, new MemoryPsuSnapshotStore(), {
    now: () => now,
    maximumItemsPerQuery: 1,
  }).run(eastLunchQuery);
  assert.equal(result.state, "unavailable");
  assert.match(result.error.message, /item bound/i);
  assert.deepEqual(calls, { menu: 1, nutrition: 0 });
});

test("structural failures are not retried and preserve last-known-good as stale", async () => {
  const store = new MemoryPsuSnapshotStore();
  const good = await pipelineFor(fixtureFetch(), store).run(eastLunchQuery);
  assert.equal(good.state, "live");

  let calls = 0;
  const brokenFetch: typeof fetch = async (input) => {
    calls += 1;
    return htmlResponse(
      await fixture("menu-structural-failure.sanitized.html"),
      String(input),
    );
  };
  const result = await pipelineFor(brokenFetch, store).run(eastLunchQuery);
  assert.equal(result.state, "stale");
  assert.equal(calls, 1);
});

test("failure without retained data returns unavailable rather than sample", async () => {
  const brokenFetch: typeof fetch = async (input) => htmlResponse(
    await fixture("menu-structural-failure.sanitized.html"),
    String(input),
  );
  const result = await pipelineFor(brokenFetch, new MemoryPsuSnapshotStore()).run(eastLunchQuery);
  assert.equal(result.state, "unavailable");
  assert.equal(result.snapshot, null);
});

test("observation IDs remain stable when unrelated station items are reordered", async () => {
  const chicken = parsePsuNutritionHtml(await fixture("nutrition-900000001.sanitized.html"));
  const rice = parsePsuNutritionHtml(await fixture("nutrition-900000002.sanitized.html"));
  if (!chicken.name || !rice.name) throw new Error("Named nutrition fixtures are incomplete.");
  const nutrition = new Map([
    ["900000001", chicken],
    ["900000002", rice],
  ]);
  const baseMenu = {
    context: { sourceCampusId: "11", sourceDate: "8/31/26", sourceMeal: "Lunch" },
    empty: false,
    stations: [{
      displayName: "PURE",
      items: [{ name: chicken.name, sourceHandle: "900000001", dietaryTraits: [] }],
    }],
  } as const;
  const reorderedMenu = {
    ...baseMenu,
    stations: [{
      displayName: "PURE",
      items: [
        { name: rice.name, sourceHandle: "900000002", dietaryTraits: [] },
        ...baseMenu.stations[0].items,
      ],
    }],
  } as const;
  const timing = { retrievedAt: now, cachedAt: now, freshForMs: 300_000, retainForMs: 172_800_000 };
  const first = buildPsuSnapshot(eastLunchQuery, baseMenu, nutrition, timing);
  const reordered = buildPsuSnapshot(eastLunchQuery, reorderedMenu, nutrition, timing);
  const firstId = first.stations[0].items.find((item) => item.sourceHandle === "900000001")?.observationId;
  const reorderedId = reordered.stations[0].items.find((item) => item.sourceHandle === "900000001")?.observationId;
  assert.equal(firstId, reorderedId);
});

test("snapshot validation rejects semantically mismatched cache provenance", async () => {
  const result = await runFixtureIngestion(eastLunchQuery, fixtureFetch());
  assert.equal(result.state, "live");
  if (result.state !== "live") return;
  const tampered = structuredClone(result.snapshot);
  tampered.stations[0].items[0].sourceUrl =
    "https://www.absecom.psu.edu/menus/user-pages/nutrition-label.cfm?mid=900000002";
  assert.throws(() => validatePsuSnapshot(tampered), /mismatched source URL/i);
});

test("provider maps invalid saved cache to unavailable without sample fallback", async () => {
  const invalidStore = invalidCacheStore();
  const provider = new PsuMenuProvider(invalidStore, { now: () => now });
  const menu = await provider.getMenu(eastLunchQuery);
  assert.equal(menu.source.mode, "unavailable");
  assert.deepEqual(menu.items, []);
  assert.match(menu.source.warning ?? "", /failed validation.*not substituted/i);
  assert.deepEqual(await provider.getVenues(eastLunchQuery.hallId), []);
});

test("failed refresh does not expose an invalid last-known-good snapshot", async () => {
  const brokenFetch: typeof fetch = async (input) => htmlResponse(
    await fixture("menu-structural-failure.sanitized.html"),
    String(input),
  );
  const result = await new PsuIngestionPipeline(
    new PsuHttpRetriever({
      fetchImpl: brokenFetch,
      minimumIntervalMs: 0,
      maximumAttempts: 1,
    }),
    invalidCacheStore(),
    { now: () => now },
  ).run(eastLunchQuery);
  assert.equal(result.state, "unavailable");
  assert.equal(result.snapshot, null);
  assert.match(result.error.message, /saved snapshot validation also failed/i);
});

async function runFixtureIngestion(query: MenuQuery, fetchImpl: typeof fetch) {
  return pipelineFor(fetchImpl, new MemoryPsuSnapshotStore()).run(query);
}

function pipelineFor(fetchImpl: typeof fetch, store: MemoryPsuSnapshotStore): PsuIngestionPipeline {
  const retriever = new PsuHttpRetriever({
    fetchImpl,
    minimumIntervalMs: 0,
    maximumAttempts: 2,
    sleep: () => Promise.resolve(),
    now: () => now.getTime(),
  });
  return new PsuIngestionPipeline(retriever, store, { now: () => now });
}

function fixtureFetch(calls = { menu: 0, nutrition: 0 }): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/daily-menu.cfm")) {
      calls.menu += 1;
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body));
      const campus = body.get("selCampus");
      const meal = body.get("selMeal");
      const file = campus === "11" && meal === "Lunch"
        ? "menu-east-lunch.sanitized.html"
        : campus === "14" && meal === "Dinner"
          ? "menu-pollock-dinner.sanitized.html"
          : "menu-empty.sanitized.html";
      return htmlResponse(await fixture(file), url.href);
    }
    calls.nutrition += 1;
    const handle = url.searchParams.get("mid");
    return htmlResponse(await fixture(`nutrition-${handle}.sanitized.html`), url.href);
  };
}

function htmlResponse(body: string, url: string): Response {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtureDirectory, name), "utf8");
}

function invalidCacheStore(): PsuSnapshotStore {
  return {
    readMenu: async () => { throw new Error("invalid cache"); },
    writeMenu: async () => undefined,
    readNutrition: async () => null,
    writeNutrition: async () => undefined,
    listMenus: async () => { throw new Error("invalid cache"); },
  };
}
