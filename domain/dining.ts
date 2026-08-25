import type { FoodItem } from "./nutrition.ts";

export interface DiningHall {
  readonly id: string;
  readonly displayName: string;
  readonly timeZone: string;
}

export interface DiningVenue {
  readonly id: string;
  readonly hallId: string;
  readonly displayName: string;
}

export interface MealPeriod {
  readonly id: string;
  readonly displayName: string;
}

export interface MenuItem {
  readonly id: string;
  readonly food: FoodItem;
  readonly venueId: string;
  readonly availability: {
    readonly serviceDate: string;
    readonly mealPeriodId: string;
  };
}

export interface MenuQuery {
  readonly serviceDate: string;
  readonly hallId: string;
  readonly mealPeriodId: string;
  readonly venueIds: readonly string[];
}

export interface MenuSource {
  readonly mode: "sample" | "live";
  readonly label: string;
  readonly retrievedAt?: string;
}

export interface Menu {
  readonly query: MenuQuery;
  readonly items: readonly MenuItem[];
  readonly source: MenuSource;
}

export interface MenuProvider {
  getHalls(): Promise<readonly DiningHall[]>;
  getMealPeriods(): Promise<readonly MealPeriod[]>;
  getVenues(hallId: string): Promise<readonly DiningVenue[]>;
  getMenu(query: MenuQuery): Promise<Menu>;
}
