import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { MenuQuery } from "../domain/dining.ts";
import { MemoryBrowserMenuApplicationStore } from "../infrastructure/psu/browser-application-store.ts";
import { BrowserStaticPsuSnapshotStore } from "../infrastructure/psu/browser-static-snapshot-store.ts";
import { PsuIngestionPipeline } from "../infrastructure/psu/ingestion-pipeline.ts";
import {
  catalogEntryForSnapshot,
  PSU_CATALOG_VERSION,
  resolveSameOriginMenuUrl,
  validatePsuPublicationCatalog,
} from "../infrastructure/psu/publication-catalog.ts";
import { PsuMenuProvider } from "../infrastructure/psu/psu-menu-provider.ts";
import { PsuHttpRetriever } from "../infrastructure/psu/retriever.ts";
import { validatePsuSnapshotForBrowser } from "../infrastructure/psu/snapshot-contract.ts";
import { MemoryPsuSnapshotStore } from "../infrastructure/psu/snapshot-store.ts";
import { PSU_PARSER_VERSION, PSU_SNAPSHOT_VERSION } from "../infrastructure/psu/constants.ts";

const fixtureDirectory = path.resolve(import.meta.dirname, "fixtures", "psu");
const query: MenuQuery = {
  serviceDate: "2026-08-31",
  hallId: "psu:campus:11",
  mealPeriodId: "lunch",
  venueIds: [],
};
const fetchedAt = new Date("2026-08-31T16:00:00.000Z");

test("catalog and snapshot URLs work at root and /lionlog/ without leaving the origin", () => {
  assert.equal(
    resolveSameOriginMenuUrl("./menu-data/v1/catalog.json", "https://example.test/").href,
    "https://example.test/menu-data/v1/catalog.json",
  );
  assert.equal(
    resolveSameOriginMenuUrl("./menu-data/v1/catalog.json", "https://example.test/lionlog/").href,
    "https://example.test/lionlog/menu-data/v1/catalog.json",
  );
  assert.equal(
    resolveSameOriginMenuUrl("./snapshots/2026-08-31/11/lunch.json", "https://example.test/lionlog/menu-data/v1/catalog.json").href,
    "https://example.test/lionlog/menu-data/v1/snapshots/2026-08-31/11/lunch.json",
  );
  assert.throws(() => resolveSameOriginMenuUrl("https://psu.example/menu.json", "https://example.test/"), /same|origin/i);
});

test("remote validated data is live and an offline reload uses the saved validated snapshot", async () => {
  const snapshot = await fixtureSnapshot();
  const catalog = fixtureCatalog(snapshot);
  const applicationStore = new MemoryBrowserMenuApplicationStore();
  const online = new BrowserStaticPsuSnapshotStore({
    baseUrl: () => "https://example.test/lionlog/",
    fetchImpl: publishedFetch(catalog, snapshot),
    applicationStore,
    now: () => new Date("2026-08-31T16:02:00.000Z"),
  });
  const liveMenu = await new PsuMenuProvider(online, { now: () => new Date("2026-08-31T16:02:00.000Z") }).getMenu(query);
  assert.equal(liveMenu.source.mode, "live");
  assert.ok(liveMenu.items.length > 0);

  const offline = new BrowserStaticPsuSnapshotStore({
    baseUrl: () => "https://example.test/lionlog/",
    fetchImpl: rejectingFetch,
    applicationStore,
    now: () => new Date("2026-08-31T16:03:00.000Z"),
  });
  const cachedMenu = await new PsuMenuProvider(offline, { now: () => new Date("2026-08-31T16:03:00.000Z") }).getMenu(query);
  assert.equal(cachedMenu.source.mode, "cached");
  assert.deepEqual(cachedMenu.items, liveMenu.items);
});

test("validated remote data remains usable when browser persistence is unavailable", async () => {
  const snapshot = await fixtureSnapshot();
  const catalog = fixtureCatalog(snapshot);
  const applicationStore = new class extends MemoryBrowserMenuApplicationStore {
    override async writeCatalog(): Promise<void> { throw new Error("storage unavailable"); }
    override async writeSnapshot(): Promise<void> { throw new Error("storage unavailable"); }
  }();
  const store = new BrowserStaticPsuSnapshotStore({
    baseUrl: () => "https://example.test/lionlog/",
    fetchImpl: publishedFetch(catalog, snapshot),
    applicationStore,
    now: () => new Date("2026-08-31T16:02:00.000Z"),
  });

  const result = await store.readMenuSelection(query);
  assert.equal(result?.state, "live");
  assert.equal(result?.snapshot.snapshotId, snapshot.snapshotId);
});

test("tampered remote data is rejected without replacing last-known-good", async () => {
  const snapshot = await fixtureSnapshot();
  const catalog = fixtureCatalog(snapshot);
  const applicationStore = new MemoryBrowserMenuApplicationStore();
  const first = new BrowserStaticPsuSnapshotStore({
    baseUrl: () => "https://example.test/",
    fetchImpl: publishedFetch(catalog, snapshot),
    applicationStore,
    now: () => new Date("2026-08-31T16:01:00.000Z"),
  });
  assert.equal((await first.readMenuSelection(query))?.state, "live");

  const tampered = structuredClone(snapshot);
  tampered.stations[0].items[0].nutrition.calories = 9999;
  const second = new BrowserStaticPsuSnapshotStore({
    baseUrl: () => "https://example.test/",
    fetchImpl: publishedFetch(catalog, tampered),
    applicationStore,
    now: () => new Date("2026-08-31T16:02:00.000Z"),
  });
  const result = await second.readMenuSelection(query);
  assert.equal(result?.state, "cached");
  assert.equal(result?.snapshot.snapshotId, snapshot.snapshotId);
  assert.notEqual(result?.snapshot.stations[0].items[0].nutrition.calories, 9999);
});

test("unsupported catalog and snapshot versions fail closed", async () => {
  const snapshot = await fixtureSnapshot();
  const catalog = fixtureCatalog(snapshot);
  assert.throws(
    () => validatePsuPublicationCatalog({ ...catalog, catalogVersion: "lionlog.psu-catalog.v2" }),
    /invalid PSU catalog/i,
  );
  await assert.rejects(
    () => validatePsuSnapshotForBrowser({ ...snapshot, schemaVersion: "lionlog.psu-menu.v2" }),
    /invalid PSU snapshot/i,
  );
  assert.throws(
    () => validatePsuPublicationCatalog({
      ...catalog,
      snapshots: [{ ...catalog.snapshots[0], snapshotUrl: "./snapshots/../../secrets.json" }],
    }),
    /invalid PSU catalog/i,
  );
});

test("missing publication is unavailable and never falls back to sample data", async () => {
  const store = new BrowserStaticPsuSnapshotStore({
    baseUrl: () => "https://example.test/",
    fetchImpl: rejectingFetch,
    applicationStore: new MemoryBrowserMenuApplicationStore(),
    now: () => fetchedAt,
  });
  const menu = await new PsuMenuProvider(store, { now: () => fetchedAt }).getMenu(query);
  assert.equal(menu.source.mode, "unavailable");
  assert.deepEqual(menu.items, []);
  assert.match(menu.source.warning ?? "", /sample data was not substituted/i);
});

test("failed refresh serves stale LKG only inside its bounded retention period", async () => {
  const snapshot = await fixtureSnapshot();
  const applicationStore = new MemoryBrowserMenuApplicationStore();
  await applicationStore.writeCatalog(fixtureCatalog(snapshot));
  await applicationStore.writeSnapshot(snapshot);
  const staleTime = new Date(Date.parse(snapshot.freshUntil) + 1);
  const staleStore = new BrowserStaticPsuSnapshotStore({
    baseUrl: () => "https://example.test/",
    fetchImpl: rejectingFetch,
    applicationStore,
    now: () => staleTime,
  });
  assert.equal((await staleStore.readMenuSelection(query))?.state, "stale");

  const expiredStore = new BrowserStaticPsuSnapshotStore({
    baseUrl: () => "https://example.test/",
    fetchImpl: rejectingFetch,
    applicationStore,
    now: () => new Date(Date.parse(snapshot.retainUntil) + 1),
  });
  assert.equal(await expiredStore.readMenuSelection(query), null);
});

test("tampered browser storage is ignored during offline reload", async () => {
  const snapshot = await fixtureSnapshot();
  const applicationStore = new MemoryBrowserMenuApplicationStore();
  await applicationStore.writeCatalog(fixtureCatalog(snapshot));
  const tampered = structuredClone(snapshot);
  tampered.stations[0].displayName = "Tampered";
  applicationStore.snapshots.set(snapshot.snapshotId, tampered);
  const store = new BrowserStaticPsuSnapshotStore({
    baseUrl: () => "https://example.test/",
    fetchImpl: rejectingFetch,
    applicationStore,
    now: () => new Date("2026-08-31T16:02:00.000Z"),
  });
  assert.equal(await store.readMenuSelection(query), null);
});

async function fixtureSnapshot() {
  const store = new MemoryPsuSnapshotStore();
  const nowMs = fetchedAt.getTime();
  const retriever = new PsuHttpRetriever({
    fetchImpl: fixtureFetch,
    minimumIntervalMs: 0,
    maximumAttempts: 1,
    now: () => nowMs,
  });
  const result = await new PsuIngestionPipeline(retriever, store, { now: () => fetchedAt }).run(query);
  assert.equal(result.state, "live");
  return result.snapshot;
}

function fixtureCatalog(snapshot: Awaited<ReturnType<typeof fixtureSnapshot>>) {
  return validatePsuPublicationCatalog({
    catalogVersion: PSU_CATALOG_VERSION,
    snapshotSchemaVersion: PSU_SNAPSHOT_VERSION,
    parserVersion: PSU_PARSER_VERSION,
    generatedAt: "2026-08-31T16:00:30.000Z",
    serviceDates: [snapshot.query.serviceDate],
    halls: [{ id: snapshot.query.hallId, displayName: "East / Findlay" }],
    mealPeriods: [{ id: snapshot.query.mealPeriodId, displayName: "Lunch" }],
    snapshots: [catalogEntryForSnapshot(snapshot, "./snapshots/2026-08-31/11/lunch.json")],
  });
}

function publishedFetch(catalog: unknown, snapshot: unknown): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/catalog.json")) return jsonResponse(catalog, url.href);
    if (url.pathname.endsWith("/snapshots/2026-08-31/11/lunch.json")) return jsonResponse(snapshot, url.href);
    return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
  };
}

const rejectingFetch: typeof fetch = async () => { throw new TypeError("offline"); };

async function fixtureFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname.endsWith("daily-menu.cfm")) {
    return htmlResponse(await readFile(path.join(fixtureDirectory, "menu-east-lunch.sanitized.html"), "utf8"), url.href);
  }
  const handle = url.searchParams.get("mid");
  return htmlResponse(await readFile(path.join(fixtureDirectory, `nutrition-${handle}.sanitized.html`), "utf8"), url.href);
}

function jsonResponse(value: unknown, url: string): Response {
  const response = new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function htmlResponse(body: string, url: string): Response {
  const response = new Response(body, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
