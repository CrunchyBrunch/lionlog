"use client";

import { useEffect, useMemo, useState } from "react";
import { liveMenuBrowser, sampleMenuBrowser } from "../application/browser-container.ts";
import { todayInTimeZone } from "../application/service-date.ts";
import type { DiningHall, DiningVenue, MealPeriod, Menu } from "../domain/dining.ts";

export interface MealBuilderInitialData {
  readonly halls: readonly DiningHall[];
  readonly periods: readonly MealPeriod[];
  readonly venues: readonly DiningVenue[];
  readonly menu: Menu;
}

export function MealBuilder({ initial }: { readonly initial: MealBuilderInitialData }) {
  const [dataMode, setDataMode] = useState<"live" | "sample">("live");
  const [halls, setHalls] = useState(initial.halls);
  const [periods, setPeriods] = useState(initial.periods);
  const [hallId, setHallId] = useState(initial.menu.query.hallId);
  const [periodId, setPeriodId] = useState(initial.menu.query.mealPeriodId);
  const [serviceDate, setServiceDate] = useState(initial.menu.query.serviceDate);
  const [selectedVenueIds, setSelectedVenueIds] = useState<readonly string[]>([]);
  const [venues, setVenues] = useState(initial.venues);
  const [menu, setMenu] = useState(initial.menu);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuBrowser = dataMode === "live" ? liveMenuBrowser : sampleMenuBrowser;

  const hallById = useMemo(
    () => new Map(halls.map((hall) => [hall.id, hall])),
    [halls],
  );
  const venueById = useMemo(
    () => new Map(venues.map((venue) => [venue.id, venue])),
    [venues],
  );
  const periodName = periods.find((period) => period.id === periodId)?.displayName ?? "Meal";
  const isSample = menu.source.mode === "sample";
  const sourceStateLabel = menu.source.mode === "sample"
    ? "Sample"
    : menu.source.mode.charAt(0).toUpperCase() + menu.source.mode.slice(1);

  useEffect(() => {
    let current = true;
    menuBrowser.loadVenues(hallId).then((nextVenues) => {
      if (current) setVenues(nextVenues);
    });
    return () => { current = false; };
  }, [hallId, menuBrowser]);

  useEffect(() => {
    let current = true;
    menuBrowser.loadMenu({ hallId, mealPeriodId: periodId, serviceDate, venueIds: selectedVenueIds })
      .then(async (nextMenu) => {
        const nextVenues = await menuBrowser.loadVenues(hallId);
        if (current) {
          setMenu(nextMenu);
          setVenues(nextVenues);
        }
      })
      .catch(() => {
        if (current) setError("The menu could not be loaded. Please try another selection.");
      })
      .finally(() => {
        if (current) setIsLoading(false);
      });
    return () => { current = false; };
  }, [hallId, menuBrowser, periodId, selectedVenueIds, serviceDate]);

  async function chooseDataMode(nextMode: "live" | "sample") {
    if (nextMode === dataMode) return;
    setIsLoading(true);
    setError(null);
    setDataMode(nextMode);
    setSelectedVenueIds([]);
    const browser = nextMode === "live" ? liveMenuBrowser : sampleMenuBrowser;
    const context = await browser.loadContext();
    const nextHall = context.halls[0];
    const nextPeriod = context.periods.find((period) => period.id === "dinner") ?? context.periods[0];
    setHalls(context.halls);
    setPeriods(context.periods);
    if (nextHall && nextPeriod) {
      setHallId(nextHall.id);
      setPeriodId(nextPeriod.id);
      setServiceDate(todayInTimeZone(nextHall.timeZone));
    }
  }

  function chooseHall(nextHallId: string) {
    setIsLoading(true);
    setError(null);
    setHallId(nextHallId);
    setSelectedVenueIds([]);
    const hall = hallById.get(nextHallId);
    if (hall) setServiceDate(todayInTimeZone(hall.timeZone));
  }

  function toggleVenue(venueId: string) {
    setIsLoading(true);
    setError(null);
    setSelectedVenueIds((current) =>
      current.includes(venueId)
        ? current.filter((id) => id !== venueId)
        : [...current, venueId],
    );
  }

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="LionLog home">
          <span className="brand-mark" aria-hidden="true">LL</span>
          <span>LionLog</span>
        </a>
        <span className="step-label">Meal builder</span>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow">{isSample ? "Sample dining data" : "Penn State public menu data"}</p>
        <h1>A practical plate, built around your target.</h1>
        <p className="hero-copy">
          Pick where you’re eating. LionLog shows what’s available before building your meal.
        </p>
      </section>

      <section className="data-mode" aria-label="Menu data mode">
        <div>
          <strong>Menu source</strong>
          <span>Live delivery never falls back to sample foods.</span>
        </div>
        <div className="mode-options">
          <button type="button" aria-pressed={dataMode === "live"} onClick={() => void chooseDataMode("live")}>PSU snapshots</button>
          <button type="button" aria-pressed={dataMode === "sample"} onClick={() => void chooseDataMode("sample")}>Sample demo</button>
        </div>
      </section>

      <section className="builder-card" aria-labelledby="context-heading">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Step 1</p>
            <h2 id="context-heading">Choose your dining context</h2>
          </div>
          <span className="date-chip">{sourceStateLabel}</span>
        </div>

        <div className="field-grid">
          <label>
            <span>Dining hall</span>
            <select value={hallId} onChange={(event) => chooseHall(event.target.value)}>
              {halls.map((hall) => (
                <option value={hall.id} key={hall.id}>{hall.displayName}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Meal period</span>
            <select value={periodId} onChange={(event) => {
              setIsLoading(true);
              setError(null);
              setPeriodId(event.target.value);
            }}>
              {periods.map((period) => (
                <option value={period.id} key={period.id}>{period.displayName}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Service date</span>
            <input type="date" value={serviceDate} onChange={(event) => {
              setIsLoading(true);
              setError(null);
              setServiceDate(event.target.value);
            }} />
          </label>
        </div>

        <fieldset className="venue-picker">
          <legend>Venues</legend>
          <label className={`choice-card ${selectedVenueIds.length === 0 ? "selected" : ""}`}>
            <input
              type="checkbox"
              checked={selectedVenueIds.length === 0}
              onChange={() => {
                setIsLoading(true);
                setError(null);
                setSelectedVenueIds([]);
              }}
            />
            <span>
              <strong>Whole dining hall</strong>
              <small>Browse every station/category</small>
            </span>
            {selectedVenueIds.length === 0 && <span className="check" aria-hidden="true">✓</span>}
          </label>
          <div className="venue-options">
            {venues.map((venue) => {
              const selected = selectedVenueIds.includes(venue.id);
              return (
                <label className={`venue-option ${selected ? "selected" : ""}`} key={venue.id}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleVenue(venue.id)}
                  />
                  <span>{venue.displayName}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </section>

      <section className="menu-section" aria-labelledby="menu-heading" aria-busy={isLoading}>
        <div className="section-heading menu-heading-row">
          <div>
            <p className="section-kicker">{isSample ? "Available in this sample" : `Source state: ${menu.source.mode}`}</p>
            <h2 id="menu-heading">{periodName} menu</h2>
          </div>
          <span className="item-count">{isLoading ? "Loading" : `${menu.items.length} foods`}</span>
        </div>

        {error ? (
          <div className="empty-state" role="alert">{error}</div>
        ) : menu.items.length === 0 && !isLoading ? (
          <div className="empty-state">
            {menu.source.mode === "unavailable"
              ? "No validated live or saved menu is available for this context."
              : isSample
                ? "No sample foods match this context."
                : "No foods are listed for this context."}
          </div>
        ) : (
          <div className={`menu-list ${isLoading ? "is-loading" : ""}`}>
            {menu.items.map((item) => {
              const serving = item.food.servings[0];
              return (
                <article className="food-row" key={item.id}>
                  <div className="food-icon" aria-hidden="true">{item.food.name.slice(0, 1)}</div>
                  <div className="food-copy">
                    <h3>{item.food.name}</h3>
                    <p>{venueById.get(item.venueId)?.displayName ?? "Station/category"} · {serving.displayLabel}</p>
                  </div>
                  <div className="nutrition">
                    <strong>{formatNutrient(serving.nutrition.proteinG, "g")}</strong>
                    <span>protein</span>
                  </div>
                  <div className="nutrition calories">
                    <strong>{formatNutrient(serving.nutrition.calories)}</strong>
                    <span>cal</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <div className="sample-note">
          <span aria-hidden="true">●</span>
          {isSample ? (
            <p><strong>{menu.source.label}.</strong> Names and nutrition are illustrative and do not represent today’s Penn State menu.</p>
          ) : (
            <p>
              <strong>{menu.source.label}.</strong>{" "}
              {menu.source.retrievedAt && `Retrieved ${formatRetrievedAt(menu.source.retrievedAt)} (${formatAge(menu.source.retrievedAt)}). `}
              {menu.source.warning && `${menu.source.warning} `}
              {menu.source.completeness === "partial" && (
                <strong>
                  This snapshot is partial: {menu.source.omittedObservationCount} source item was omitted because PSU did not provide a trustworthy display name.{" "}
                </strong>
              )}
              {menu.source.sourceUrl && (
                <a href={menu.source.sourceUrl} target="_blank" rel="noreferrer">View the public source.</a>
              )}{" "}
              LionLog is independent and is not affiliated with or endorsed by Penn State.
            </p>
          )}
        </div>
      </section>

      <footer className="milestone-note">
        <span>v0.2.0-alpha.4</span>
        <p>Cached public-menu delivery · no official PSU API.</p>
      </footer>
    </main>
  );
}

function formatNutrient(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${value}${suffix}`;
}

function formatRetrievedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "at an unknown time" : date.toLocaleString();
}

function formatAge(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "age unavailable";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr old`;
  return `${Math.floor(hours / 24)} days old`;
}
