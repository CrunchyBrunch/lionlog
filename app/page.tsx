import type { Metadata } from "next";
import { todayInTimeZone } from "../application/service-date.ts";
import type { Menu } from "../domain/dining.ts";
import { psuHalls, psuMealPeriods, PSU_MENU_URL } from "../infrastructure/psu/constants.ts";
import { MealBuilder } from "./meal-builder.tsx";

export const metadata: Metadata = {
  title: "Build a meal | LionLog",
  description: "Turn a dining hall menu into a practical plate.",
};

export default async function Home() {
  const context = { halls: psuHalls, periods: psuMealPeriods };
  const hall = context.halls[0];
  const period = context.periods.find((candidate) => candidate.id === "dinner") ?? context.periods[0];

  if (!hall || !period) {
    throw new Error("The PSU dining context is incomplete.");
  }

  const serviceDate = todayInTimeZone(hall.timeZone);
  const menu: Menu = {
    query: {
      serviceDate,
      hallId: hall.id,
      mealPeriodId: period.id,
      venueIds: [],
    },
    items: [],
    source: {
      mode: "unavailable",
      label: "Penn State menu not loaded",
      retrievedAt: null,
      sourceUrl: PSU_MENU_URL,
      warning: "Checking for a validated published snapshot.",
    },
  };

  return <MealBuilder initial={{ ...context, venues: [], menu }} />;
}
