import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MenuQuery } from "../../domain/dining.ts";
import type { PsuMenuSnapshot, PsuNutritionCacheEntry } from "./snapshot-schema.ts";
import { validatePsuNutritionCacheEntry, validatePsuSnapshot } from "./snapshot-schema.ts";

export interface PsuSnapshotStore {
  readMenu(query: MenuQuery): Promise<PsuMenuSnapshot | null>;
  writeMenu(snapshot: PsuMenuSnapshot): Promise<void>;
  readNutrition(sourceHandle: string): Promise<PsuNutritionCacheEntry | null>;
  writeNutrition(entry: PsuNutritionCacheEntry): Promise<void>;
  listMenus(): Promise<readonly PsuMenuSnapshot[]>;
}

export class MemoryPsuSnapshotStore implements PsuSnapshotStore {
  private readonly menus = new Map<string, PsuMenuSnapshot>();
  private readonly nutrition = new Map<string, PsuNutritionCacheEntry>();

  async readMenu(query: MenuQuery): Promise<PsuMenuSnapshot | null> {
    return this.menus.get(menuKey(query)) ?? null;
  }

  async writeMenu(snapshot: PsuMenuSnapshot): Promise<void> {
    this.menus.set(menuKey(snapshot.query), validatePsuSnapshot(snapshot));
  }

  async readNutrition(sourceHandle: string): Promise<PsuNutritionCacheEntry | null> {
    return this.nutrition.get(sourceHandle) ?? null;
  }

  async writeNutrition(entry: PsuNutritionCacheEntry): Promise<void> {
    this.nutrition.set(entry.sourceHandle, validatePsuNutritionCacheEntry(entry));
  }

  async listMenus(): Promise<readonly PsuMenuSnapshot[]> {
    return [...this.menus.values()];
  }
}

export class FilePsuSnapshotStore implements PsuSnapshotStore {
  readonly rootDirectory: string;
  private readonly menuDirectory: string;
  private readonly nutritionDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory;
    this.menuDirectory = path.join(rootDirectory, "lionlog.psu-menu.v1");
    this.nutritionDirectory = path.join(rootDirectory, "lionlog.psu-nutrition.v1");
  }

  readMenu(query: MenuQuery): Promise<PsuMenuSnapshot | null> {
    return readJson(path.join(this.menuDirectory, `${fileHash(menuKey(query))}.json`), validatePsuSnapshot);
  }

  async writeMenu(snapshot: PsuMenuSnapshot): Promise<void> {
    const valid = validatePsuSnapshot(snapshot);
    await writeJsonAtomically(
      this.menuDirectory,
      `${fileHash(menuKey(snapshot.query))}.json`,
      valid,
    );
  }

  readNutrition(sourceHandle: string): Promise<PsuNutritionCacheEntry | null> {
    if (!/^\d+$/.test(sourceHandle)) throw new Error("PSU nutrition handle must contain digits only.");
    return readJson(
      path.join(this.nutritionDirectory, `${sourceHandle}.json`),
      validatePsuNutritionCacheEntry,
    );
  }

  async writeNutrition(entry: PsuNutritionCacheEntry): Promise<void> {
    const valid = validatePsuNutritionCacheEntry(entry);
    await writeJsonAtomically(this.nutritionDirectory, `${valid.sourceHandle}.json`, valid);
  }

  async listMenus(): Promise<readonly PsuMenuSnapshot[]> {
    let names: string[];
    try {
      names = await readdir(this.menuDirectory);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const snapshots = await Promise.all(
      names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) =>
        readJson(path.join(this.menuDirectory, name), validatePsuSnapshot)
      ),
    );
    return snapshots.filter((snapshot): snapshot is PsuMenuSnapshot => snapshot !== null);
  }
}

function menuKey(query: Pick<MenuQuery, "serviceDate" | "hallId" | "mealPeriodId">): string {
  return [query.serviceDate, query.hallId, query.mealPeriodId].join("\u001f");
}

function fileHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readJson<T>(filePath: string, validate: (value: unknown) => T): Promise<T | null> {
  try {
    return validate(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function writeJsonAtomically(directory: string, fileName: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  const finalPath = path.join(directory, fileName);
  const temporaryPath = path.join(directory, `${fileName}.${process.pid}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, finalPath);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
