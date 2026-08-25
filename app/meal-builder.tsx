"use client";

import { useEffect, useMemo, useState } from "react";
import { menuBrowser } from "../application/browser-container.ts";
import { todayInTimeZone } from "../application/service-date.ts";
import type { DiningHall, DiningVenue, MealPeriod, Menu } from "../domain/dining.ts";

export interface MealBuilderInitialData {
  readonly halls: readonly DiningHall[];
  readonly periods: readonly MealPeriod[];
  readonly venues: readonly DiningVenue[];
  readonly menu: Menu;
}

export function MealBuilder({ initial }: { readonly initial: MealBuilderInitialData }) {
  const [hallId, setHallId] = useState(initial.menu.query.hallId);
  const [periodId, setPeriodId] = useState(initial.menu.query.mealPeriodId);
  const [serviceDate, setServiceDate] = useState(initial.menu.query.serviceDate);
  const [selectedVenueIds, setSelectedVenueIds] = useState<readonly string[]>([]);
  const [venues, setVenues] = useState(initial.venues);
  const [menu, setMenu] = useState(initial.menu);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hallById = useMemo(
    () => new Map(initial.halls.map((hall) => [hall.id, hall])),
    [initial.halls],
  );
  const venueById = useMemo(
    () => new Map(venues.map((venue) => [venue.id, venue])),
    [venues],
  );
  const periodName = initial.periods.find((period) => period.id === periodId)?.displayName ?? "Meal";

  useEffect(() => {
    let current = true;
    menuBrowser.loadVenues(hallId).then((nextVenues) => {
      if (current) setVenues(nextVenues);
    });
    return () => { current = false; };
  }, [hallId]);

  useEffect(() => {
    let current = true;
    menuBrowser.loadMenu({ hallId, mealPeriodId: periodId, serviceDate, venueIds: selectedVenueIds })
      .then((nextMenu) => {
        if (current) setMenu(nextMenu);
      })
      .catch(() => {
        if (current) setError("The sample menu could not be loaded. Please try another selection.");
      })
      .finally(() => {
        if (current) setIsLoading(false);
      });
    return () => { current = false; };
  }, [hallId, periodId, selectedVenueIds, serviceDate]);

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
        <p className="eyebrow">Sample dining data</p>
        <h1>A practical plate, built around your target.</h1>
        <p className="hero-copy">
          Pick where you’re eating. LionLog shows what’s available before building your meal.
        </p>
      </section>

      <section className="builder-card" aria-labelledby="context-heading">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Step 1</p>
            <h2 id="context-heading">Choose your dining context</h2>
          </div>
          <span className="date-chip">Sample</span>
        </div>

        <div className="field-grid">
          <label>
            <span>Dining hall</span>
            <select value={hallId} onChange={(event) => chooseHall(event.target.value)}>
              {initial.halls.map((hall) => (
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
              {initial.periods.map((period) => (
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
              <small>Browse every sample venue</small>
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
            <p className="section-kicker">Available in this sample</p>
            <h2 id="menu-heading">{periodName} menu</h2>
          </div>
          <span className="item-count">{isLoading ? "Loading" : `${menu.items.length} foods`}</span>
        </div>

        {error ? (
          <div className="empty-state" role="alert">{error}</div>
        ) : menu.items.length === 0 && !isLoading ? (
          <div className="empty-state">No sample foods match this context.</div>
        ) : (
          <div className={`menu-list ${isLoading ? "is-loading" : ""}`}>
            {menu.items.map((item) => {
              const serving = item.food.servings[0];
              return (
                <article className="food-row" key={item.id}>
                  <div className="food-icon" aria-hidden="true">{item.food.name.slice(0, 1)}</div>
                  <div className="food-copy">
                    <h3>{item.food.name}</h3>
                    <p>{venueById.get(item.venueId)?.displayName ?? "Sample venue"} · {serving.displayLabel}</p>
                  </div>
                  <div className="nutrition">
                    <strong>{serving.nutrition.proteinG}g</strong>
                    <span>protein</span>
                  </div>
                  <div className="nutrition calories">
                    <strong>{serving.nutrition.calories}</strong>
                    <span>cal</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <div className="sample-note">
          <span aria-hidden="true">●</span>
          <p><strong>{menu.source.label}.</strong> Names and nutrition are illustrative and do not represent today’s Penn State menu.</p>
        </div>
      </section>

      <footer className="milestone-note">
        <span>v0.1.0-alpha.2</span>
        <p>Installable PWA preview · meal recommendations arrive in alpha.3.</p>
      </footer>
    </main>
  );
}
