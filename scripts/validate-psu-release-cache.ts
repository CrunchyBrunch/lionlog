import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { validatePsuNutritionCacheEntry } from "../infrastructure/psu/snapshot-schema.ts";

const root = path.resolve(process.argv.find((value) => value.startsWith("--cache-dir="))?.slice(12)
  ?? "work/psu-field-release-cache/lionlog.psu-nutrition.v1");
let entries;
try { entries = await readdir(root, { withFileTypes: true }); }
catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    process.stdout.write("No persisted nutrition cache was restored.\n");
    process.exit(0);
  }
  throw error;
}
let count = 0;
for (const entry of entries) {
  if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) throw new Error(`Unexpected persisted cache entry: ${entry.name}`);
  const filePath = path.join(root, entry.name);
  if ((await lstat(filePath)).isSymbolicLink()) throw new Error(`Persisted cache cannot contain symlinks: ${entry.name}`);
  const value = validatePsuNutritionCacheEntry(JSON.parse(await readFile(filePath, "utf8")));
  if (`${value.sourceHandle}.json` !== entry.name) throw new Error(`Persisted cache key mismatch: ${entry.name}`);
  count += 1;
}
process.stdout.write(`Validated ${count} persisted nutrition cache entries.\n`);
