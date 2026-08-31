# LionLog

LionLog is a mobile-first dining hall meal builder. The `v0.2.0-alpha.2` proof of concept adds a manually triggered, centralized ingestion path for Penn State's publicly available dining-menu HTML while retaining the deterministic sample experience.

The PWA does not scrape Penn State. Manual ingestion retrieves and parses source HTML outside React, validates a versioned JSON snapshot, and stores it under the ignored `work/` cache. This is not an official Penn State API integration. The milestone does not add an optimizer, accounts, diary, analytics, scheduled production scraping, or deployment.

## Requirements

- Node.js 22.13 or newer

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Verify

```bash
npm test
npm run lint
```

Automated tests use frozen sanitized fixtures and do not contact Penn State.

## Manual PSU ingestion proof of concept

```bash
npm run ingest:psu -- --date=2026-08-31 --hall=11 --meal=Lunch
```

Validated snapshots and nutrition cache entries are written beneath `work/psu-ingestion`. Repeat the same command to refresh the menu while reusing still-fresh nutrition entries. See the [implementation notes](docs/psu-live-menu/implementation-alpha-2.md) for states and safety limits and the [verification report](docs/psu-live-menu/verification-alpha-2.md) for recorded results.

The project is a React, Vite, and TypeScript site built with vinext for static-first Sites deployment. Domain contracts live in `domain/`, application coordination in `application/`, and the replaceable sample provider in `infrastructure/`.

## Architecture audits

- [`v0.2.0-alpha.1` PSU live-menu source and architecture audit](docs/psu-live-menu/README.md)
