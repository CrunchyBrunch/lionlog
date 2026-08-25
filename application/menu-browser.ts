import type {
  DiningHall,
  DiningVenue,
  MealPeriod,
  Menu,
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
}
