"use client";

import { MockMenuProvider } from "../infrastructure/mock-menu-provider.ts";
import { BrowserStaticPsuSnapshotStore } from "../infrastructure/psu/browser-static-snapshot-store.ts";
import { PsuMenuProvider } from "../infrastructure/psu/psu-menu-provider.ts";
import { MenuBrowser } from "./menu-browser.ts";

export const liveMenuBrowser = new MenuBrowser(
  new PsuMenuProvider(new BrowserStaticPsuSnapshotStore()),
);
export const sampleMenuBrowser = new MenuBrowser(new MockMenuProvider());
