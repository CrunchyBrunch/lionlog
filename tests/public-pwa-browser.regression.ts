import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getPsuHall, getPsuMealPeriod, PSU_PARSER_VERSION, PSU_SNAPSHOT_VERSION } from "../infrastructure/psu/constants.ts";
import { parsePsuMenuHtml } from "../infrastructure/psu/menu-parser.ts";
import { parsePsuNutritionHtml } from "../infrastructure/psu/nutrition-parser.ts";
import { catalogEntryForSnapshot, PSU_CATALOG_VERSION, validatePsuPublicationCatalog } from "../infrastructure/psu/publication-catalog.ts";
import { buildPsuSnapshot } from "../infrastructure/psu/snapshot-schema.ts";
import { verifyBrowserSession } from "../scripts/verify-public-pwa.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(projectRoot, "tests", "fixtures", "psu");
const shellRevision = "a".repeat(40);
const releaseId = "b".repeat(64);
const fixedBrowserNow = "2026-09-17T12:00:00.000Z";
const browserBasePath = process.env.LIONLOG_BROWSER_TEST_BASE_PATH ?? "";
if (!/^(?:|\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(browserBasePath)) throw new Error("Browser regression base path is invalid.");

test("React-controlled historical date and target-wide offline reload use only validated saved data", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-browser-regression-"));
  const site = path.join(root, "site");
  let offlinePhase = false;
  let offlineRequests = 0;
  const requestPaths: string[] = [];
  try {
    await cp(path.join(projectRoot, "dist", "client"), site, { recursive: true });
    await replaceShellRevision(site);
    const snapshot = await historicalSnapshot();
    const snapshotUrl = "./snapshots/2026-08-31/11/lunch.json";
    const catalog = validatePsuPublicationCatalog({
      catalogVersion: PSU_CATALOG_VERSION,
      snapshotSchemaVersion: PSU_SNAPSHOT_VERSION,
      parserVersion: PSU_PARSER_VERSION,
      generatedAt: "2026-09-17T12:00:00.000Z",
      publication: {
        mode: "manual-export",
        sourceKind: "psu-public-menu-html",
        commitSha: null,
        serviceDate: null,
        hallIds: ["psu:campus:11"],
        retrievalStartedAt: null,
        retrievalCompletedAt: null,
        expectedSnapshotCount: 1,
        publishedSnapshotCount: 1,
        recognizedEmptySnapshotCount: 0,
        itemCount: snapshot.coverage.publishedObservationCount,
        coverage: snapshot.coverage.status,
        sourceObservationCount: snapshot.coverage.sourceObservationCount,
        publishedObservationCount: snapshot.coverage.publishedObservationCount,
        omissions: snapshot.coverage.omissions,
        requestCount: null,
        nutritionRequests: null,
        nutritionCacheHits: null,
      },
      serviceDates: ["2026-08-31"],
      halls: [{ id: "psu:campus:11", displayName: getPsuHall("psu:campus:11").displayName }],
      mealPeriods: [{ id: "lunch", displayName: getPsuMealPeriod("lunch").displayName }],
      snapshots: [catalogEntryForSnapshot(snapshot, snapshotUrl)],
    });
    const dataRoot = path.join(site, "menu-data", "v2");
    const snapshotPath = path.join(dataRoot, "snapshots", "2026-08-31", "11", "lunch.json");
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await writeFile(path.join(dataRoot, "catalog.json"), `${JSON.stringify(catalog)}\n`);
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
    await writeFile(path.join(site, "release.json"), `${JSON.stringify({ releaseId })}\n`);

    const server = createServer(async (request, response) => {
      if (offlinePhase) offlineRequests += 1;
      try {
        const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
        requestPaths.push(pathname);
        const scopedPath = browserBasePath === ""
          ? pathname
          : pathname === `${browserBasePath}/` ? "/" : pathname.startsWith(`${browserBasePath}/`) ? pathname.slice(browserBasePath.length) : "__outside_scope__";
        const relative = scopedPath === "/" ? "index.html" : scopedPath.replace(/^\/+/, "");
        const resolved = path.resolve(site, relative);
        if (resolved !== site && !resolved.startsWith(`${site}${path.sep}`)) throw new Error("path traversal");
        const bytes = await readFile(resolved);
        response.statusCode = 200;
        response.setHeader("content-type", contentType(resolved));
        response.end(bytes);
      } catch {
        response.statusCode = 404;
        response.end("not found");
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    let serverClosed = false;
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const itemNames = snapshot.stations.flatMap((station) => station.items.map((item) => item.name));
      const result = await verifyBrowserSession({
        targetUrl: `http://127.0.0.1:${address.port}${browserBasePath}/`,
        chromeBin: browserExecutable(),
        browserNow: fixedBrowserNow,
        expected: {
          contextVersion: "lionlog.pages-browser-context.v1",
          releaseId,
          shellRevision,
          serviceDate: "2026-08-31",
          hallId: "psu:campus:11",
          mealPeriodId: "lunch",
          expectedItemCount: itemNames.length,
          expectedFirstFoodName: itemNames[0],
        },
        onOfflineStart: async () => {
          offlinePhase = true;
        },
        onBeforeOfflineReload: async () => {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeAllConnections();
          });
          serverClosed = true;
        },
        getOfflineServerRequestCount: () => offlineRequests,
      }).catch((error) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; origin requests: ${JSON.stringify(requestPaths)}`);
      });
      assert.equal(result.uncachedResourceFailed, true);
      assert.equal(result.dedicatedWorkerUncachedResourceFailed, true);
      assert.equal(result.offlineServerRequestCount, 0);
      assert.ok(result.isolatedTargetTypes.includes("service_worker"));
      assert.ok(result.isolatedTargetTypes.includes("worker"));
      assert.equal(result.online.selectedDate, "2026-08-31");
      assert.equal(result.offline.selectedDate, "2026-08-31");
      assert.deepEqual(result.offline.itemNames, itemNames);
      assert.equal(result.offline.samplePressed, false);
      assert.equal(result.offline.livePressed, true);
      assert.equal(result.online.shellRevision, shellRevision);
      assert.equal(result.offline.shellRevision, shellRevision);
      assert.equal(result.approvedReleaseId, releaseId);
    } finally {
      if (!serverClosed) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function historicalSnapshot() {
  const menu = parsePsuMenuHtml(await readFile(path.join(fixtureRoot, "menu-east-lunch.sanitized.html"), "utf8"), {
    sourceCampusId: "11",
    sourceDate: "8/31/26",
    sourceMeal: "Lunch",
  });
  const nutrition = new Map();
  for (const handle of ["900000001", "900000002", "900000003"]) {
    nutrition.set(handle, parsePsuNutritionHtml(await readFile(path.join(fixtureRoot, `nutrition-${handle}.sanitized.html`), "utf8")));
  }
  const retrievedAt = new Date("2026-08-31T16:00:00.000Z");
  return buildPsuSnapshot({ serviceDate: "2026-08-31", hallId: "psu:campus:11", mealPeriodId: "lunch", venueIds: [] }, menu, nutrition, {
    retrievedAt,
    cachedAt: retrievedAt,
    freshForMs: 60 * 60_000,
    retainForMs: 18 * 24 * 60 * 60_000,
  });
}

async function replaceShellRevision(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await replaceShellRevision(target);
    else if (/\.(?:html|js|json|rsc|webmanifest)$/.test(entry.name)) {
      const text = await readFile(target, "utf8");
      await writeFile(target, text.replaceAll("development", shellRevision));
    }
  }
}

function browserExecutable(): string {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  return process.platform === "win32" && existsSync(edge) ? edge : "google-chrome";
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json") || file.endsWith(".webmanifest")) return "application/json; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}
