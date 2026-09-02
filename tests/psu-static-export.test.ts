import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parsePsuMenuHtml } from "../infrastructure/psu/menu-parser.ts";
import { parsePsuNutritionHtml } from "../infrastructure/psu/nutrition-parser.ts";
import { validatePsuPublicationCatalog } from "../infrastructure/psu/publication-catalog.ts";
import { buildPsuSnapshot, validatePsuSnapshot } from "../infrastructure/psu/snapshot-schema.ts";
import { FilePsuSnapshotStore } from "../infrastructure/psu/snapshot-store.ts";
import { validatePagesArtifact } from "../scripts/prepare-pages-artifact.ts";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const fixtureDirectory = path.join(projectRoot, "tests", "fixtures", "psu");

test("manual exporter creates a validated catalog and independent snapshot tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-export-test-"));
  try {
    const cacheDirectory = path.join(root, "cache");
    const outputDirectory = path.join(root, "site");
    const snapshot = await buildFixtureSnapshot();
    await new FilePsuSnapshotStore(cacheDirectory).writeMenu(snapshot);
    await executeFile(process.execPath, [
      "--experimental-strip-types",
      path.join(projectRoot, "scripts", "export-psu-static.ts"),
      `--cache-dir=${cacheDirectory}`,
      `--output-dir=${outputDirectory}`,
      "--generated-at=2026-08-31T16:01:00.000Z",
    ], { cwd: projectRoot });

    const catalogPath = path.join(outputDirectory, "menu-data", "v1", "catalog.json");
    const catalog = validatePsuPublicationCatalog(JSON.parse(await readFile(catalogPath, "utf8")));
    assert.equal(catalog.snapshots.length, 1);
    assert.equal(catalog.generatedAt, "2026-08-31T16:01:00.000Z");
    const snapshotPath = path.join(path.dirname(catalogPath), catalog.snapshots[0].snapshotUrl.slice(2));
    const published = validatePsuSnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
    assert.equal(published.snapshotId, snapshot.snapshotId);

    await writeStaticShell(outputDirectory);
    const files = await validatePagesArtifact(outputDirectory);
    assert.ok(files.includes("menu-data/v1/catalog.json"));
    await writeFile(path.join(outputDirectory, "menu-data", "v1", "unreferenced.json"), "{}\n");
    await assert.rejects(validatePagesArtifact(outputDirectory), /Unexpected menu-data publication path|not referenced by the catalog/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function buildFixtureSnapshot() {
  const menu = parsePsuMenuHtml(await fixture("menu-east-lunch.sanitized.html"), {
    sourceCampusId: "11",
    sourceDate: "8/31/26",
    sourceMeal: "Lunch",
  });
  const nutrition = new Map();
  for (const handle of ["900000001", "900000002", "900000003"]) {
    nutrition.set(handle, parsePsuNutritionHtml(await fixture(`nutrition-${handle}.sanitized.html`)));
  }
  const now = new Date("2026-08-31T16:00:00.000Z");
  return buildPsuSnapshot({
    serviceDate: "2026-08-31",
    hallId: "psu:campus:11",
    mealPeriodId: "lunch",
    venueIds: [],
  }, menu, nutrition, {
    retrievedAt: now,
    cachedAt: now,
    freshForMs: 5 * 60_000,
    retainForMs: 48 * 60 * 60_000,
  });
}

async function writeStaticShell(root: string): Promise<void> {
  await mkdir(path.join(root, "_next", "static"), { recursive: true });
  await mkdir(path.join(root, "icons"), { recursive: true });
  await writeFile(path.join(root, ".nojekyll"), "\n");
  await writeFile(path.join(root, "index.html"), '<link href="/lionlog/_next/static/app.js"><link href="./manifest.webmanifest">');
  await writeFile(path.join(root, "_next", "static", "app.js"), "console.log('shell');");
  await writeFile(path.join(root, "icons", "icon-192.png"), "icon");
  await writeFile(path.join(root, "manifest.webmanifest"), JSON.stringify({
    id: "./", start_url: "./", scope: "./", icons: [{ src: "./icons/icon-192.png" }],
  }));
  await writeFile(path.join(root, "sw.js"), "const CACHE='lionlog-shell-v1'; const EXCLUDED='menu-data';");
}

function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtureDirectory, name), "utf8");
}
