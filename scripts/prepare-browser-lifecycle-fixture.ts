import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parsePsuMenuHtml } from "../infrastructure/psu/menu-parser.ts";
import { parsePsuNutritionHtml } from "../infrastructure/psu/nutrition-parser.ts";
import { buildPsuSnapshot } from "../infrastructure/psu/snapshot-schema.ts";
import { FilePsuSnapshotStore } from "../infrastructure/psu/snapshot-store.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(repositoryRoot, "tests", "fixtures", "psu");
const cache = path.resolve(repositoryRoot, process.argv[2] ?? "work/browser-lifecycle-cache");
const workRoot = path.join(repositoryRoot, "work");
if (cache !== workRoot && !cache.startsWith(`${workRoot}${path.sep}`)) {
  throw new Error("Browser lifecycle fixtures may be written only beneath work/.");
}

await rm(cache, { recursive: true, force: true });
const parsedMenu = parsePsuMenuHtml(await readFile(path.join(fixtures, "menu-east-lunch.sanitized.html"), "utf8"), {
  sourceCampusId: "11",
  sourceDate: "8/31/26",
  sourceMeal: "Lunch",
});
const nutrition = new Map();
for (const handle of ["900000001", "900000002", "900000003"]) {
  nutrition.set(handle, parsePsuNutritionHtml(await readFile(path.join(fixtures, `nutrition-${handle}.sanitized.html`), "utf8")));
}
const now = new Date();
const serviceDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(now);
const [year, month, day] = serviceDate.split("-");
const menu = { ...parsedMenu, context: { ...parsedMenu.context, sourceDate: `${Number(month)}/${Number(day)}/${year.slice(2)}` } };
const snapshot = buildPsuSnapshot({
  serviceDate,
  hallId: "psu:campus:11",
  mealPeriodId: "lunch",
  venueIds: [],
}, menu, nutrition, {
  retrievedAt: now,
  cachedAt: now,
  freshForMs: 18 * 60 * 60_000,
  retainForMs: 48 * 60 * 60_000,
});
await new FilePsuSnapshotStore(cache).writeMenu(snapshot);
process.stdout.write(`${JSON.stringify({ cache, generatedAt: now.toISOString(), snapshotId: snapshot.snapshotId }, null, 2)}\n`);
