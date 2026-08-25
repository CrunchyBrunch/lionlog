import { MockMenuProvider } from "../infrastructure/mock-menu-provider.ts";
import { MenuBrowser } from "./menu-browser.ts";

export const menuBrowser = new MenuBrowser(new MockMenuProvider());
