import type { MenuQuery } from "../../domain/dining.ts";
import { getPsuHall, getPsuMealPeriod, sourceDateFromIso } from "./constants.ts";
import { parsePsuMenuHtml } from "./menu-parser.ts";
import { parsePsuNutritionHtml, type ParsedPsuNutrition } from "./nutrition-parser.ts";
import type { PsuHttpRetriever } from "./retriever.ts";
import {
  buildPsuSnapshot,
  nutritionFromCacheEntry,
  toNutritionCacheEntry,
  validatePsuNutritionCacheEntry,
  validatePsuSnapshot,
  type PsuMenuSnapshot,
} from "./snapshot-schema.ts";
import type { PsuSnapshotStore } from "./snapshot-store.ts";

export interface PsuIngestionPolicy {
  readonly menuFreshForMs: number;
  readonly lastKnownGoodForMs: number;
  readonly nutritionFreshForMs: number;
}

export const defaultPsuIngestionPolicy: PsuIngestionPolicy = {
  menuFreshForMs: 5 * 60 * 1_000,
  lastKnownGoodForMs: 48 * 60 * 60 * 1_000,
  nutritionFreshForMs: 24 * 60 * 60 * 1_000,
};

export type PsuIngestionResult =
  | {
    readonly state: "live";
    readonly snapshot: PsuMenuSnapshot;
    readonly report: PsuIngestionReport;
  }
  | {
    readonly state: "stale";
    readonly snapshot: PsuMenuSnapshot;
    readonly error: Error;
  }
  | {
    readonly state: "unavailable";
    readonly snapshot: null;
    readonly error: Error;
  };

export interface PsuIngestionReport {
  readonly menuRequests: number;
  readonly nutritionRequests: number;
  readonly nutritionCacheHits: number;
  readonly stationCount: number;
  readonly itemCount: number;
}

export interface PsuIngestionPipelineOptions {
  readonly policy?: PsuIngestionPolicy;
  readonly now?: () => Date;
}

export class PsuIngestionPipeline {
  private readonly retriever: PsuHttpRetriever;
  private readonly store: PsuSnapshotStore;
  private readonly policy: PsuIngestionPolicy;
  private readonly now: () => Date;

  constructor(
    retriever: PsuHttpRetriever,
    store: PsuSnapshotStore,
    options: PsuIngestionPipelineOptions = {},
  ) {
    this.retriever = retriever;
    this.store = store;
    this.policy = options.policy ?? defaultPsuIngestionPolicy;
    this.now = options.now ?? (() => new Date());
  }

  async run(query: MenuQuery): Promise<PsuIngestionResult> {
    try {
      const snapshotResult = await this.ingest(query);
      return { state: "live", ...snapshotResult };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      let lastKnownGood: PsuMenuSnapshot | null;
      try {
        const storedSnapshot = await this.store.readMenu(query);
        lastKnownGood = storedSnapshot ? validatePsuSnapshot(storedSnapshot) : null;
      } catch (cacheError) {
        const cacheMessage = cacheError instanceof Error ? cacheError.message : String(cacheError);
        return {
          state: "unavailable",
          snapshot: null,
          error: new Error(`${normalizedError.message} Saved snapshot validation also failed: ${cacheMessage}`),
        };
      }
      if (lastKnownGood && this.now().getTime() <= Date.parse(lastKnownGood.retainUntil)) {
        return { state: "stale", snapshot: lastKnownGood, error: normalizedError };
      }
      return { state: "unavailable", snapshot: null, error: normalizedError };
    }
  }

  private async ingest(query: MenuQuery): Promise<{
    readonly snapshot: PsuMenuSnapshot;
    readonly report: PsuIngestionReport;
  }> {
    const hall = getPsuHall(query.hallId);
    const period = getPsuMealPeriod(query.mealPeriodId);
    const sourceDate = sourceDateFromIso(query.serviceDate);
    const menuResponse = await this.retriever.retrieveMenu({
      sourceDate,
      sourceMeal: period.sourceValue,
      sourceCampusId: hall.sourceCampusId,
    });
    const parsedMenu = parsePsuMenuHtml(menuResponse.html, {
      sourceCampusId: hall.sourceCampusId,
      sourceDate,
      sourceMeal: period.sourceValue,
    });

    const nutritionByHandle = new Map<string, ParsedPsuNutrition>();
    let nutritionRequests = 0;
    let nutritionCacheHits = 0;
    const uniqueHandles = [...new Set(parsedMenu.stations.flatMap((station) =>
      station.items.map((item) => item.sourceHandle)
    ))];
    for (const sourceHandle of uniqueHandles) {
      const storedNutrition = await this.store.readNutrition(sourceHandle);
      const cached = storedNutrition ? validatePsuNutritionCacheEntry(storedNutrition) : null;
      if (cached && this.now().getTime() <= Date.parse(cached.freshUntil)) {
        nutritionByHandle.set(sourceHandle, nutritionFromCacheEntry(cached));
        nutritionCacheHits += 1;
        continue;
      }
      const response = await this.retriever.retrieveNutrition(sourceHandle);
      const detail = parsePsuNutritionHtml(response.html);
      await this.store.writeNutrition(toNutritionCacheEntry(
        sourceHandle,
        detail,
        response.retrievedAt,
        this.policy.nutritionFreshForMs,
      ));
      nutritionByHandle.set(sourceHandle, detail);
      nutritionRequests += 1;
    }

    const cachedAt = this.now();
    const snapshot = buildPsuSnapshot(query, parsedMenu, nutritionByHandle, {
      retrievedAt: menuResponse.retrievedAt,
      cachedAt,
      freshForMs: this.policy.menuFreshForMs,
      retainForMs: this.policy.lastKnownGoodForMs,
    });
    await this.store.writeMenu(snapshot);
    return {
      snapshot,
      report: {
        menuRequests: 1,
        nutritionRequests,
        nutritionCacheHits,
        stationCount: snapshot.stations.length,
        itemCount: snapshot.stations.reduce((total, station) => total + station.items.length, 0),
      },
    };
  }
}
