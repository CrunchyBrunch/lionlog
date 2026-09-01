import type {
  DiningVenue,
  Menu,
  MenuDataState,
  MenuProvider,
  MenuQuery,
} from "../../domain/dining.ts";
import { psuHalls, psuMealPeriods, PSU_MENU_URL } from "./constants.ts";
import type { PsuMenuDeliveryStore } from "./menu-delivery-store.ts";
import {
  validatePsuSnapshotStructure,
  type BrowserPsuMenuSnapshot as PsuMenuSnapshot,
} from "./snapshot-contract.ts";

export interface PsuSnapshotSelection {
  readonly state: Exclude<MenuDataState, "sample" | "unavailable">;
  readonly snapshot: PsuMenuSnapshot;
}

export interface PsuMenuProviderOptions {
  readonly activeSnapshot?: PsuSnapshotSelection;
  readonly now?: () => Date;
}

export class PsuMenuProvider implements MenuProvider {
  private readonly store: PsuMenuDeliveryStore;
  private readonly options: PsuMenuProviderOptions;
  private readonly now: () => Date;

  constructor(
    store: PsuMenuDeliveryStore,
    options: PsuMenuProviderOptions = {},
  ) {
    this.store = store;
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  async getHalls() {
    return psuHalls;
  }

  async getMealPeriods() {
    return psuMealPeriods;
  }

  async getVenues(hallId: string): Promise<readonly DiningVenue[]> {
    try {
      const active = this.options.activeSnapshot
        ? validatePsuSnapshotStructure(this.options.activeSnapshot.snapshot)
        : undefined;
      const snapshots = active?.query.hallId === hallId
        ? [active]
        : (await this.store.listMenus()).filter((snapshot) => snapshot.query.hallId === hallId);
      const now = this.now().getTime();
      const latest = snapshots
        .filter((snapshot) => now <= Date.parse(snapshot.retainUntil))
        .sort((left, right) => right.retrievedAt.localeCompare(left.retrievedAt))[0];
      return latest?.stations.map((station) => ({
        id: station.id,
        hallId,
        displayName: station.displayName,
      })) ?? [];
    } catch {
      return [];
    }
  }

  async getMenu(query: MenuQuery): Promise<Menu> {
    let selection: PsuSnapshotSelection | null;
    try {
      selection = await this.selectSnapshot(query);
    } catch {
      return unavailableMenu(query, "The saved PSU snapshot failed validation. Sample data was not substituted.");
    }
    if (!selection) return unavailableMenu(query);
    const selectedVenueIds = new Set(query.venueIds);
    const items = selection.snapshot.stations.flatMap((station) => station.items)
      .filter((item) => selectedVenueIds.size === 0 || selectedVenueIds.has(item.stationId))
      .map((item) => ({
        id: item.observationId,
        venueId: item.stationId,
        availability: {
          serviceDate: selection.snapshot.query.serviceDate,
          mealPeriodId: selection.snapshot.query.mealPeriodId,
        },
        food: {
          id: item.observationId,
          name: item.name,
          dietaryTraits: item.dietaryTraits,
          allergens: item.allergens,
          ingredients: item.ingredients,
          sourceHandle: item.sourceHandle,
          sourceUrl: item.sourceUrl,
          servings: [{
            id: `${item.observationId}:serving`,
            sourceQuantity: item.serving.quantity,
            sourceUnit: item.serving.unit,
            displayLabel: item.serving.label ?? "Serving information unavailable",
            nutrition: item.nutrition,
          }],
        },
      }));
    const mode = selection.state;
    return {
      query: { ...query, venueIds: [...query.venueIds] },
      items,
      source: {
        mode,
        label: sourceLabel(mode),
        retrievedAt: selection.snapshot.retrievedAt,
        sourceUrl: selection.snapshot.query.sourceUrl,
        snapshotVersion: selection.snapshot.schemaVersion,
        warning: mode === "stale"
          ? "Live retrieval failed or the cached snapshot expired; items may have changed."
          : undefined,
      },
    };
  }

  private async selectSnapshot(query: MenuQuery): Promise<PsuSnapshotSelection | null> {
    const active = this.options.activeSnapshot;
    if (active && sameQuery(active.snapshot, query)) {
      const snapshot = validatePsuSnapshotStructure(active.snapshot);
      const now = this.now().getTime();
      if (now > Date.parse(snapshot.retainUntil)) return null;
      if (active.state === "stale" || now > Date.parse(snapshot.freshUntil)) {
        return { state: "stale", snapshot };
      }
      return { state: active.state, snapshot };
    }
    if (this.store.readMenuSelection) {
      const delivered = await this.store.readMenuSelection(query);
      if (!delivered) return null;
      const snapshot = validatePsuSnapshotStructure(delivered.snapshot);
      const now = this.now().getTime();
      if (now > Date.parse(snapshot.retainUntil)) return null;
      return now > Date.parse(snapshot.freshUntil)
        ? { state: "stale", snapshot }
        : { state: delivered.state, snapshot };
    }
    const storedSnapshot = await this.store.readMenu(query);
    if (!storedSnapshot) return null;
    const snapshot = validatePsuSnapshotStructure(storedSnapshot);
    const now = this.now().getTime();
    if (now <= Date.parse(snapshot.freshUntil)) return { state: "cached", snapshot };
    if (now <= Date.parse(snapshot.retainUntil)) return { state: "stale", snapshot };
    return null;
  }
}

function sameQuery(snapshot: PsuMenuSnapshot, query: MenuQuery): boolean {
  return snapshot.query.serviceDate === query.serviceDate
    && snapshot.query.hallId === query.hallId
    && snapshot.query.mealPeriodId === query.mealPeriodId;
}

function sourceLabel(mode: PsuSnapshotSelection["state"]): string {
  if (mode === "live") return "Penn State public menu — retrieved live";
  if (mode === "cached") return "Penn State public menu — cached";
  return "Penn State public menu — stale saved copy";
}

function unavailableMenu(
  query: MenuQuery,
  warning = "No validated live or retained snapshot is available. Sample data was not substituted.",
): Menu {
  return {
    query: { ...query, venueIds: [...query.venueIds] },
    items: [],
    source: {
      mode: "unavailable",
      label: "Penn State menu unavailable",
      retrievedAt: null,
      sourceUrl: PSU_MENU_URL,
      warning,
    },
  };
}
