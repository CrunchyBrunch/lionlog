import type { PsuPublicationCatalog } from "./publication-catalog.ts";
import type { BrowserPsuMenuSnapshot } from "./snapshot-contract.ts";

export const PSU_BROWSER_DATABASE = "lionlog-menu-data-v2";

export interface BrowserMenuApplicationStore {
  readCatalog(): Promise<unknown | null>;
  writeCatalog(catalog: PsuPublicationCatalog): Promise<void>;
  readSnapshot(snapshotId: string): Promise<unknown | null>;
  writeSnapshot(snapshot: BrowserPsuMenuSnapshot): Promise<void>;
  listSnapshots(): Promise<readonly unknown[]>;
}

export class MemoryBrowserMenuApplicationStore implements BrowserMenuApplicationStore {
  catalog: unknown | null = null;
  readonly snapshots = new Map<string, unknown>();

  async readCatalog(): Promise<unknown | null> { return this.catalog; }
  async writeCatalog(catalog: PsuPublicationCatalog): Promise<void> { this.catalog = structuredClone(catalog); }
  async readSnapshot(snapshotId: string): Promise<unknown | null> { return this.snapshots.get(snapshotId) ?? null; }
  async writeSnapshot(snapshot: BrowserPsuMenuSnapshot): Promise<void> {
    this.snapshots.set(snapshot.snapshotId, structuredClone(snapshot));
  }
  async listSnapshots(): Promise<readonly unknown[]> { return [...this.snapshots.values()]; }
}

export class IndexedDbBrowserMenuApplicationStore implements BrowserMenuApplicationStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  async readCatalog(): Promise<unknown | null> { return this.get("catalogs", "active"); }
  async writeCatalog(catalog: PsuPublicationCatalog): Promise<void> { await this.put("catalogs", catalog, "active"); }
  async readSnapshot(snapshotId: string): Promise<unknown | null> { return this.get("snapshots", snapshotId); }
  async writeSnapshot(snapshot: BrowserPsuMenuSnapshot): Promise<void> {
    await this.put("snapshots", snapshot, snapshot.snapshotId);
  }
  async listSnapshots(): Promise<readonly unknown[]> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const request = database.transaction("snapshots", "readonly").objectStore("snapshots").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB snapshot read failed."));
    });
  }

  private async get(storeName: "catalogs" | "snapshots", key: string): Promise<unknown | null> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed."));
    });
  }

  private async put(storeName: "catalogs" | "snapshots", value: unknown, key: string): Promise<void> {
    const database = await this.database();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted."));
    });
  }

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error("IndexedDB is unavailable."));
        return;
      }
      const request = globalThis.indexedDB.open(PSU_BROWSER_DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("catalogs")) request.result.createObjectStore("catalogs");
        if (!request.result.objectStoreNames.contains("snapshots")) request.result.createObjectStore("snapshots");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
    });
    return this.databasePromise;
  }
}
