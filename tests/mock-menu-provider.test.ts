import assert from "node:assert/strict";
import test from "node:test";
import { MockMenuProvider } from "../infrastructure/mock-menu-provider.ts";

const provider = new MockMenuProvider();
const baseQuery = {
  serviceDate: "2026-08-25",
  hallId: "north-commons",
  mealPeriodId: "dinner",
  venueIds: [] as string[],
};

test("an empty venue selection returns the whole hall", async () => {
  const menu = await provider.getMenu(baseQuery);
  assert.equal(menu.source.mode, "sample");
  assert.ok(menu.items.length > 1);
  assert.deepEqual(new Set(menu.items.map((item) => item.venueId)), new Set([
    "north-grill",
    "north-bowls",
    "north-market",
  ]));
});

test("one or more selected venues constrain the menu", async () => {
  const menu = await provider.getMenu({
    ...baseQuery,
    venueIds: ["north-grill", "north-market"],
  });
  assert.ok(menu.items.length > 0);
  assert.ok(menu.items.every((item) => ["north-grill", "north-market"].includes(item.venueId)));
});

test("venue and period data are values supplied by the provider", async () => {
  const [venues, periods] = await Promise.all([
    provider.getVenues("south-commons"),
    provider.getMealPeriods(),
  ]);
  assert.deepEqual(venues.map((venue) => venue.hallId), [
    "south-commons",
    "south-commons",
    "south-commons",
  ]);
  assert.deepEqual(periods.map((period) => period.id), ["breakfast", "lunch", "dinner"]);
});
