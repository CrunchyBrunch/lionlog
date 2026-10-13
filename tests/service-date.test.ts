import assert from "node:assert/strict";
import test from "node:test";
import * as serviceDates from "../application/service-date.ts";
import type { Menu } from "../domain/dining.ts";

const { todayInTimeZone } = serviceDates;

test("service dates use the dining hall timezone", () => {
  const afterMidnightUtc = new Date("2026-01-02T02:30:00.000Z");
  assert.equal(todayInTimeZone("America/New_York", afterMidnightUtc), "2026-01-01");
});

test("an automatic date corrects an old static shell while an explicit date persists", () => {
  assert.equal(typeof serviceDates.activeServiceDate, "function");
  const now = new Date("2026-01-02T02:30:00.000Z");
  assert.equal(serviceDates.activeServiceDate("2025-12-31", false, "America/New_York", now), "2026-01-01");
  assert.equal(serviceDates.activeServiceDate("2025-12-31", true, "America/New_York", now), "2025-12-31");
});

test("next New York service midnight follows 23-hour and 25-hour DST days", () => {
  assert.equal(typeof serviceDates.millisecondsUntilNextServiceDate, "function");
  assert.equal(serviceDates.millisecondsUntilNextServiceDate("America/New_York", new Date("2026-03-08T05:00:00.000Z")), 23 * 60 * 60_000);
  assert.equal(serviceDates.millisecondsUntilNextServiceDate("America/New_York", new Date("2026-11-01T04:00:00.000Z")), 25 * 60 * 60_000);
});

test("resume and reconnect bursts schedule one revalidation and disposal cancels it", () => {
  assert.equal(typeof serviceDates.createCoalescedRevalidation, "function");
  const pending = new Map<number, () => void>();
  let nextId = 0;
  let refreshes = 0;
  const queue = serviceDates.createCoalescedRevalidation(
    (callback) => { pending.set(++nextId, callback); return nextId; },
    (id) => { pending.delete(id); },
    () => { refreshes += 1; },
  );
  queue.request();
  queue.request();
  queue.request();
  assert.equal(pending.size, 1);
  pending.get(1)?.();
  assert.equal(refreshes, 1);
  queue.request();
  assert.equal(pending.size, 2);
  queue.dispose();
  assert.equal(pending.has(2), false);
  assert.equal(refreshes, 1);
});

test("open menus revalidate immediately after freshness and retention boundaries", () => {
  assert.equal(typeof serviceDates.millisecondsUntilMenuRevalidation, "function");
  const freshUntil = "2026-08-31T16:05:00.000Z";
  const retainUntil = "2026-09-02T16:00:00.000Z";
  assert.equal(serviceDates.millisecondsUntilMenuRevalidation({ mode: "live", freshUntil, retainUntil }, new Date(freshUntil)), 1);
  assert.equal(serviceDates.millisecondsUntilMenuRevalidation({ mode: "cached", freshUntil, retainUntil }, new Date(freshUntil)), 1);
  assert.equal(serviceDates.millisecondsUntilMenuRevalidation({ mode: "stale", freshUntil, retainUntil }, new Date(retainUntil)), 1);
  assert.equal(serviceDates.millisecondsUntilMenuRevalidation({ mode: "stale", freshUntil, retainUntil }, new Date("2026-09-02T16:00:00.002Z")), 0);
  assert.equal(serviceDates.millisecondsUntilMenuRevalidation({ mode: "unavailable" }, new Date(freshUntil)), null);
  assert.equal(serviceDates.millisecondsUntilMenuRevalidation({ mode: "sample" }, new Date(freshUntil)), null);
});

test("display ages a validated live menu at inclusive freshness and retention deadlines", () => {
  const menu = {
    query: { serviceDate: "2026-08-31", hallId: "psu:campus:11", mealPeriodId: "lunch", venueIds: [] },
    items: [{ id: "fixture" }] as unknown as Menu["items"],
    source: {
      mode: "live",
      label: "Penn State public menu — retrieved live",
      retrievedAt: "2026-09-16T12:00:00.000Z",
      freshUntil: "2026-09-17T06:00:00.000Z",
      retainUntil: "2026-09-18T12:00:00.000Z",
    },
  } as Menu;
  const display = serviceDates.menuForDisplay;
  assert.equal(typeof display, "function");
  assert.equal(display(menu, new Date(menu.source.freshUntil!)).source.mode, "live");
  assert.equal(display(menu, new Date("2026-09-17T06:00:00.001Z")).source.mode, "stale");
  assert.equal(display(menu, new Date(menu.source.retainUntil!)).items.length, 1);
  const expired = display(menu, new Date("2026-09-18T12:00:00.001Z"));
  assert.equal(expired.source.mode, "unavailable");
  assert.equal(expired.items.length, 0);
  assert.equal(menu.items.length, 1, "aging must not mutate the validated source menu");
});
