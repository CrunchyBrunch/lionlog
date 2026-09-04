import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parsePsuMenuHtml } from "../infrastructure/psu/menu-parser.ts";
import { parsePsuNutritionHtml } from "../infrastructure/psu/nutrition-parser.ts";
import { validatePsuPublicationCatalog } from "../infrastructure/psu/publication-catalog.ts";
import { buildPsuSnapshot, validatePsuSnapshot } from "../infrastructure/psu/snapshot-schema.ts";
import { FilePsuSnapshotStore } from "../infrastructure/psu/snapshot-store.ts";
import { preparePagesArtifact, validatePagesArtifact } from "../scripts/prepare-pages-artifact.ts";

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

    const catalogPath = path.join(outputDirectory, "menu-data", "v2", "catalog.json");
    const catalog = validatePsuPublicationCatalog(JSON.parse(await readFile(catalogPath, "utf8")));
    assert.equal(catalog.snapshots.length, 1);
    assert.equal(catalog.generatedAt, "2026-08-31T16:01:00.000Z");
    const snapshotPath = path.join(path.dirname(catalogPath), catalog.snapshots[0].snapshotUrl.slice(2));
    const published = validatePsuSnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
    assert.equal(published.snapshotId, snapshot.snapshotId);

    await writeStaticShell(outputDirectory);
    const files = await validatePagesArtifact(outputDirectory);
    assert.ok(files.includes("menu-data/v2/catalog.json"));

    const prepared = path.join(root, "prepared");
    await preparePagesArtifact(outputDirectory, prepared);
    assert.deepEqual(await validatePagesArtifact(prepared), files);
    const archive = path.join(root, "menu-artifact.tar");
    const roundTrip = path.join(root, "round-trip");
    await executeFile("tar", ["-cf", archive, "-C", prepared, "."]);
    await mkdir(roundTrip);
    await executeFile("tar", ["-xf", archive, "-C", roundTrip]);
    assert.deepEqual(await validatePagesArtifact(roundTrip), files);

    await writeFile(path.join(outputDirectory, "menu-data", "v2", "unreferenced.json"), "{}\n");
    await assert.rejects(validatePagesArtifact(outputDirectory), /not referenced by the catalog/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("menu publication rejects missing, extra, and unexpected snapshot paths and directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-export-boundary-"));
  try {
    const cacheDirectory = path.join(root, "cache");
    const valid = path.join(root, "valid");
    const snapshot = await buildFixtureSnapshot();
    await new FilePsuSnapshotStore(cacheDirectory).writeMenu(snapshot);
    await executeFile(process.execPath, [
      "--experimental-strip-types",
      path.join(projectRoot, "scripts", "export-psu-static.ts"),
      `--cache-dir=${cacheDirectory}`,
      `--output-dir=${valid}`,
      "--generated-at=2026-08-31T16:01:00.000Z",
    ], { cwd: projectRoot });
    await writeStaticShell(valid);
    const catalog = validatePsuPublicationCatalog(JSON.parse(await readFile(path.join(valid, "menu-data", "v2", "catalog.json"), "utf8")));
    const snapshotRelative = path.posix.join("menu-data/v2", catalog.snapshots[0].snapshotUrl.slice(2));
    const snapshotPathParts = snapshotRelative.split("/");

    const missing = path.join(root, "missing");
    await cp(valid, missing, { recursive: true });
    await unlink(path.join(missing, ...snapshotPathParts));
    await assert.rejects(validatePagesArtifact(missing), /Catalog-referenced snapshot is missing/);

    const extra = path.join(root, "extra");
    await cp(valid, extra, { recursive: true });
    const extraPath = path.join(extra, "menu-data", "v2", "snapshots", "2026-08-31", "11", "dinner.json");
    await copyFile(path.join(extra, ...snapshotPathParts), extraPath);
    await assert.rejects(validatePagesArtifact(extra), /not referenced by the catalog/);

    for (const [name, relative] of [
      ["unexpected-date", ["menu-data", "v2", "snapshots", "2099-01-01", "11", "lunch.json"]],
      ["unexpected-hall", ["menu-data", "v2", "snapshots", "2026-08-31", "999", "lunch.json"]],
    ] as const) {
      const mutated = path.join(root, name);
      await cp(valid, mutated, { recursive: true });
      const target = path.join(mutated, ...relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(mutated, ...snapshotPathParts), target);
      await assert.rejects(validatePagesArtifact(mutated), /not referenced by the catalog/);
    }

    const emptyDirectory = path.join(root, "empty-directory");
    await cp(valid, emptyDirectory, { recursive: true });
    await mkdir(path.join(emptyDirectory, "menu-data", "v2", "snapshots", "2099-01-01", "11"), { recursive: true });
    await assert.rejects(validatePagesArtifact(emptyDirectory), /unexpected or missing directory|Unexpected or empty publication directory/);
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
