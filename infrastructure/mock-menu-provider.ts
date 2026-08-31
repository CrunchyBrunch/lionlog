import type { Menu, MenuProvider, MenuQuery } from "../domain/dining.ts";
import { sampleHalls, sampleMenuTemplates, samplePeriods, sampleVenues } from "./mock-menu-data.ts";

export class MockMenuProvider implements MenuProvider {
  async getHalls() {
    return sampleHalls;
  }

  async getMealPeriods() {
    return samplePeriods;
  }

  async getVenues(hallId: string) {
    return sampleVenues.filter((venue) => venue.hallId === hallId);
  }

  async getMenu(query: MenuQuery): Promise<Menu> {
    const selectedVenues = new Set(query.venueIds);
    const items = sampleMenuTemplates
      .filter((item) => item.hallId === query.hallId)
      .filter((item) => item.periodIds.includes(query.mealPeriodId))
      .filter((item) => selectedVenues.size === 0 || selectedVenues.has(item.venueId))
      .map((item) => ({
        id: item.id,
        food: item.food,
        venueId: item.venueId,
        availability: {
          serviceDate: query.serviceDate,
          mealPeriodId: query.mealPeriodId,
        },
      }));

    return {
      query: { ...query, venueIds: [...query.venueIds] },
      items,
      source: {
        mode: "sample",
        label: "Sample menu — not live PSU data",
        retrievedAt: null,
        sourceUrl: null,
      },
    };
  }
}
