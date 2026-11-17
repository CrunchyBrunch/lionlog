import type {
  DiningHall,
  DiningVenue,
  MealPeriod,
  Menu,
  MenuSelection,
  MenuProvider,
  MenuQuery,
} from "../domain/dining.ts";

export interface DiningContext {
  readonly halls: readonly DiningHall[];
  readonly periods: readonly MealPeriod[];
}

export class MenuBrowser {
  constructor(private readonly provider: MenuProvider) {}

  async loadContext(): Promise<DiningContext> {
    const [halls, periods] = await Promise.all([
      this.provider.getHalls(),
      this.provider.getMealPeriods(),
    ]);
    return { halls, periods };
  }

  loadVenues(hallId: string): Promise<readonly DiningVenue[]> {
    return this.provider.getVenues(hallId);
  }

  loadMenu(query: MenuQuery): Promise<Menu> {
    return this.provider.getMenu(query);
  }

  async loadSelection(query: MenuQuery): Promise<MenuSelection> {
    if (this.provider.getMenuSelection) return this.provider.getMenuSelection(query);
    const [menu, venues] = await Promise.all([
      this.provider.getMenu(query), this.provider.getVenues(query.hallId),
    ]);
    return { menu, venues };
  }
}
