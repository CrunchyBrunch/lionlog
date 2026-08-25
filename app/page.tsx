import type { Metadata } from "next";
import { menuBrowser } from "../application/browser-container.ts";
import { todayInTimeZone } from "../application/service-date.ts";
import { MealBuilder } from "./meal-builder.tsx";

export const metadata: Metadata = {
  title: "Build a meal | LionLog",
  description: "Turn a dining hall menu into a practical plate.",
};

export default async function Home() {
  const context = await menuBrowser.loadContext();
  const hall = context.halls[0];
  const period = context.periods.find((candidate) => candidate.id === "dinner") ?? context.periods[0];

  if (!hall || !period) {
    throw new Error("The sample dining context is incomplete.");
  }

  const serviceDate = todayInTimeZone(hall.timeZone);
  const [venues, menu] = await Promise.all([
    menuBrowser.loadVenues(hall.id),
    menuBrowser.loadMenu({
      serviceDate,
      hallId: hall.id,
      mealPeriodId: period.id,
      venueIds: [],
    }),
  ]);

  return <MealBuilder initial={{ ...context, venues, menu }} />;
}
