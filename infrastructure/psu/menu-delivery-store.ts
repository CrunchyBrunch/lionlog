import type { MenuQuery } from "../../domain/dining.ts";
import type { BrowserPsuMenuSnapshot } from "./snapshot-contract.ts";

export type DeliveredPsuState = "live" | "cached" | "stale";

export interface DeliveredPsuSnapshot {
  readonly state: DeliveredPsuState;
  readonly snapshot: BrowserPsuMenuSnapshot;
}

export interface PsuMenuDeliveryStore {
  readMenu(query: MenuQuery): Promise<BrowserPsuMenuSnapshot | null>;
  listMenus(): Promise<readonly BrowserPsuMenuSnapshot[]>;
  readMenuSelection?(query: MenuQuery): Promise<DeliveredPsuSnapshot | null>;
}
