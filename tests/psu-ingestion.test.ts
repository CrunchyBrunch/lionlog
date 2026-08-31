import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { MenuQuery } from "../domain/dining.ts";
import { PsuIngestionPipeline } from "../infrastructure/psu/ingestion-pipeline.ts";
import { PsuMenuProvider } from "../infrastructure/psu/psu-menu-provider.ts";
import { PsuHttpRetriever } from "../infrastructure/psu/retriever.ts";
import { MemoryPsuSnapshotStore } from "../infrastructure/psu/snapshot-store.ts";

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

async function runFixtureIngestion(query: MenuQuery, fetchImpl: typeof fetch) {
  return pipelineFor(fetchImpl, new MemoryPsuSnapshotStore()).run(query);
}

function pipelineFor(fetchImpl: typeof fetch, store: MemoryPsuSnapshotStore): PsuIngestionPipeline {
  const retriever = new PsuHttpRetriever({
    fetchImpl,
    minimumIntervalMs: 0,
    maximumAttempts: 2,
    sleep: () => Promise.resolve(),
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
