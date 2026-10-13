import type { MenuSource } from "../domain/dining.ts";

export function todayInTimeZone(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function millisecondsUntilMenuRevalidation(
  source: Pick<MenuSource, "mode" | "freshUntil" | "retainUntil">,
  now = new Date(),
): number | null {
  const boundary = source.mode === "live" || source.mode === "cached"
    ? source.freshUntil
    : source.mode === "stale" ? source.retainUntil : null;
  const time = Date.parse(boundary ?? "");
  return Number.isFinite(time) ? Math.max(0, time - now.getTime() + 1) : null;
}

export function activeServiceDate(selectedDate: string, explicit: boolean, timeZone: string, now = new Date()): string {
  return explicit ? selectedDate : todayInTimeZone(timeZone, now);
}

export function millisecondsUntilNextServiceDate(timeZone: string, now = new Date()): number {
  const currentDay = todayInTimeZone(timeZone, now);
  const start = now.getTime();
  let lower = start;
  let upper = start + 36 * 60 * 60_000;
  while (lower + 1 < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (todayInTimeZone(timeZone, new Date(middle)) === currentDay) lower = middle;
    else upper = middle;
  }
  return upper - start;
}

export function createCoalescedRevalidation(
  schedule: (callback: () => void) => number,
  cancel: (id: number) => void,
  revalidate: () => void,
) {
  let pending: number | null = null;
  let disposed = false;
  return {
    request() {
      if (disposed || pending !== null) return;
      pending = schedule(() => {
        pending = null;
        if (!disposed) revalidate();
      });
    },
    dispose() {
      disposed = true;
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}
