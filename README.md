# LionLog

LionLog is a mobile-first dining hall menu browser. The `v0.2.0-alpha.3` milestone delivers validated, centrally ingested Penn State public-menu snapshots to the PWA as same-origin static JSON, with a separate explicit sample mode.

The PWA does not scrape Penn State. Manual ingestion retrieves and parses source HTML outside React, validates a versioned JSON snapshot, and stores it under the ignored `work/` cache. A separate manual export validates that output again and writes a static catalog and independently loadable snapshots. This is not an official Penn State API integration. The milestone does not add an optimizer, accounts, diary, analytics, scheduled production scraping, or deployment.

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
LIONLOG_ALLOW_PSU_NETWORK=I_UNDERSTAND_THIS_CONTACTS_PSU npm run ingest:psu -- --date=2026-08-31 --hall=11 --meal=Lunch
npm run export:psu-static -- --cache-dir=work/psu-ingestion --output-dir=public
```

Validated snapshots and nutrition cache entries are written beneath `work/psu-ingestion`. Repeat the same command to refresh the menu while reusing still-fresh nutrition entries. The browser reads `./menu-data/v1/catalog.json` from its own origin; a missing publication is shown as unavailable, and sample data appears only when sample mode is selected. See the [Alpha 3 implementation notes](docs/psu-live-menu/implementation-alpha-3.md).

The project is a React, Vite, and TypeScript site built with vinext for static-first Sites deployment. Domain contracts live in `domain/`, application coordination in `application/`, and the replaceable sample provider in `infrastructure/`.

## Architecture audits

- [`v0.2.0-alpha.1` PSU live-menu source and architecture audit](docs/psu-live-menu/README.md)
