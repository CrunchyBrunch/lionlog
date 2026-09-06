import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PSU_NUTRITION_CACHE_VERSION } from "./constants.ts";
import { validatePsuNutritionCacheEntry } from "./snapshot-schema.ts";

export interface PsuReleaseCacheValidation {
  readonly restored: boolean;
  readonly entryCount: number;
}

export async function validatePsuReleaseCacheDirectory(rootDirectory: string): Promise<PsuReleaseCacheValidation> {
  const root = path.resolve(rootDirectory);
  if (path.basename(root) !== PSU_NUTRITION_CACHE_VERSION) {
    throw new Error("Persisted nutrition cache directory version does not match the current schema.");
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return { restored: false, entryCount: 0 };
    throw error;
  }
  let entryCount = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) {
      throw new Error(`Unexpected persisted cache entry: ${entry.name}`);
    }
    const filePath = path.join(root, entry.name);
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new Error(`Persisted cache cannot contain symlinks: ${entry.name}`);
    }
    const value = validatePsuNutritionCacheEntry(JSON.parse(await readFile(filePath, "utf8")));
    if (`${value.sourceHandle}.json` !== entry.name) {
      throw new Error(`Persisted cache key mismatch: ${entry.name}`);
    }
    entryCount += 1;
  }
  return { restored: true, entryCount };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
