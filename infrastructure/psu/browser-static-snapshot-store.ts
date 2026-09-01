import type { MenuQuery } from "../../domain/dining.ts";
import type { DeliveredPsuSnapshot, PsuMenuDeliveryStore } from "./menu-delivery-store.ts";
import {
  assertSnapshotMatchesCatalog,
  PSU_MENU_DATA_PATH,
  resolveSameOriginMenuUrl,
  validatePsuPublicationCatalog,
  type PsuPublicationCatalog,
  type PsuPublicationEntry,
} from "./publication-catalog.ts";
import {
  validatePsuSnapshotForBrowser,
  type BrowserPsuMenuSnapshot,
} from "./snapshot-contract.ts";
import {
  IndexedDbBrowserMenuApplicationStore,
  type BrowserMenuApplicationStore,
} from "./browser-application-store.ts";

const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export interface BrowserStaticPsuSnapshotStoreOptions {
  readonly baseUrl?: () => string;
  readonly fetchImpl?: typeof fetch;
  readonly applicationStore?: BrowserMenuApplicationStore;
  readonly now?: () => Date;
}

export class BrowserStaticPsuSnapshotStore implements PsuMenuDeliveryStore {
  private readonly baseUrl: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly applicationStore: BrowserMenuApplicationStore;
  private readonly now: () => Date;
  private catalogPromise: Promise<PsuPublicationCatalog | null> | null = null;

  constructor(options: BrowserStaticPsuSnapshotStoreOptions = {}) {
    this.baseUrl = options.baseUrl ?? (() => globalThis.document?.baseURI ?? globalThis.location?.href);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.applicationStore = options.applicationStore ?? new IndexedDbBrowserMenuApplicationStore();
    this.now = options.now ?? (() => new Date());
  }

  async readMenu(query: MenuQuery): Promise<BrowserPsuMenuSnapshot | null> {
    return (await this.readMenuSelection(query))?.snapshot ?? null;
  }

  async readMenuSelection(query: MenuQuery): Promise<DeliveredPsuSnapshot | null> {
    const catalog = await this.loadCatalog();
    const entry = catalog?.snapshots.find((candidate) => sameQuery(candidate, query));
    if (entry) {
      try {
        const catalogUrl = resolveSameOriginMenuUrl(PSU_MENU_DATA_PATH, this.baseUrl());
        const snapshotUrl = resolveSameOriginMenuUrl(entry.snapshotUrl, catalogUrl);
        const snapshot = await this.fetchSnapshot(snapshotUrl, entry);
        if (!this.isRetained(snapshot)) return null;
        await this.applicationStore.writeSnapshot(snapshot);
        return { state: this.isFresh(snapshot) ? "live" : "stale", snapshot };
      } catch {
        // A failed or invalid publication must not replace a previously validated snapshot.
      }
    }
    return this.readLastKnownGood(query, entry?.snapshotId);
  }

  async listMenus(): Promise<readonly BrowserPsuMenuSnapshot[]> {
    await this.loadCatalog();
    const snapshots: BrowserPsuMenuSnapshot[] = [];
    for (const value of await this.applicationStore.listSnapshots()) {
      try {
        const snapshot = await validatePsuSnapshotForBrowser(value);
        if (this.isRetained(snapshot)) snapshots.push(snapshot);
      } catch {
        // Invalid browser storage is ignored and never reaches the provider.
      }
    }
    return snapshots;
  }

  private async loadCatalog(): Promise<PsuPublicationCatalog | null> {
    if (this.catalogPromise) return this.catalogPromise;
    const pending = (async () => {
      try {
        const url = resolveSameOriginMenuUrl(PSU_MENU_DATA_PATH, this.baseUrl());
        const remote = validatePsuPublicationCatalog(await fetchJson(this.fetchImpl, url, MAX_CATALOG_BYTES));
        await this.applicationStore.writeCatalog(remote);
        return remote;
      } catch {
        try {
          const saved = await this.applicationStore.readCatalog();
          return saved === null ? null : validatePsuPublicationCatalog(saved);
        } catch { return null; }
      }
    })();
    this.catalogPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.catalogPromise === pending) this.catalogPromise = null;
    }
  }

  private async fetchSnapshot(url: URL, entry: PsuPublicationEntry): Promise<BrowserPsuMenuSnapshot> {
    const snapshot = await validatePsuSnapshotForBrowser(await fetchJson(this.fetchImpl, url, MAX_SNAPSHOT_BYTES));
    assertSnapshotMatchesCatalog(snapshot, entry);
    return snapshot;
  }

  private async readLastKnownGood(query: MenuQuery, preferredSnapshotId?: string): Promise<DeliveredPsuSnapshot | null> {
    const candidates: BrowserPsuMenuSnapshot[] = [];
    if (preferredSnapshotId) {
      const preferred = await this.applicationStore.readSnapshot(preferredSnapshotId);
      if (preferred !== null) {
        try { candidates.push(await validatePsuSnapshotForBrowser(preferred)); } catch { /* ignore tampering */ }
      }
    }
    for (const value of await this.applicationStore.listSnapshots()) {
      try {
        const snapshot = await validatePsuSnapshotForBrowser(value);
        if (!candidates.some((candidate) => candidate.snapshotId === snapshot.snapshotId)) candidates.push(snapshot);
      } catch { /* ignore tampering */ }
    }
    const snapshot = candidates
      .filter((candidate) => sameQuery(candidate.query, query) && this.isRetained(candidate))
      .sort((left, right) => right.retrievedAt.localeCompare(left.retrievedAt))[0];
    if (!snapshot) return null;
    return { state: this.isFresh(snapshot) ? "cached" : "stale", snapshot };
  }

  private isFresh(snapshot: BrowserPsuMenuSnapshot): boolean {
    return this.now().getTime() <= Date.parse(snapshot.freshUntil);
  }
  private isRetained(snapshot: BrowserPsuMenuSnapshot): boolean {
    return this.now().getTime() <= Date.parse(snapshot.retainUntil);
  }
}

async function fetchJson(fetchImpl: typeof fetch, url: URL, maximumBytes: number): Promise<unknown> {
  const response = await fetchImpl(url, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok || response.redirected || response.type === "opaqueredirect") throw new Error("Menu data request failed.");
  if (response.url && response.url !== url.href) throw new Error("Menu data response URL changed.");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) throw new Error("Menu data response was not JSON.");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error("Menu data response is too large.");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new Error("Menu data response is too large.");
  return JSON.parse(text);
}

function sameQuery(
  left: Pick<MenuQuery, "serviceDate" | "hallId" | "mealPeriodId">,
  right: Pick<MenuQuery, "serviceDate" | "hallId" | "mealPeriodId">,
): boolean {
  return left.serviceDate === right.serviceDate
    && left.hallId === right.hallId
    && left.mealPeriodId === right.mealPeriodId;
}
