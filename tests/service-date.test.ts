import assert from "node:assert/strict";
import test from "node:test";
import { todayInTimeZone } from "../application/service-date.ts";

test("service dates use the dining hall timezone", () => {
  const afterMidnightUtc = new Date("2026-01-02T02:30:00.000Z");
  assert.equal(todayInTimeZone("America/New_York", afterMidnightUtc), "2026-01-01");
});
