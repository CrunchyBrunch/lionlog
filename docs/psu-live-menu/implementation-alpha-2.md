# `v0.2.0-alpha.2` public-menu ingestion proof of concept

## Scope and source description

Penn State Residential Dining approved LionLog's use of publicly available dining-menu information in August 2026. No official or private API access was granted. This implementation retrieves the public daily-menu and nutrition-label HTML through a manually triggered centralized command. It must not be described as an official PSU API integration.

No correspondence, credentials, or personal contact information is stored in the repository.

## Pipeline

```text
public PSU menu HTML
  -> strict retriever (one request at a time, paced, bounded retries)
  -> pure parse5 menu and nutrition parsers
  -> normalization + strict Zod schema validation
  -> versioned JSON menu and nutrition cache under ignored work/
  -> PsuMenuProvider through MenuProvider
```

The PWA remains wired to `MockMenuProvider` for this undeployed proof of concept. `PsuMenuProvider` is exercised through the same `MenuProvider` contract in fixture and live verification. No raw upstream HTML reaches React or the JSON snapshot.

## Manual command

```bash
npm run ingest:psu -- --date=YYYY-MM-DD --hall=<campus-id> --meal=<meal>
```

Example campus IDs are `11` (East/Findlay), `17` (North/Warnock), `14` (Pollock), `13` (South/Redifer), and `16` (West/Waring). Meals are source-provided `Breakfast`, `Lunch`, `Dinner`, or `Late Night` values.

The default cache directory is `work/psu-ingestion`, which is ignored by Git. The command writes validated JSON only. It never persists raw HTML.

## Retrieval controls

- exact HTTPS origin and path allowlists for the menu and nutrition pages;
- response status, final URL, content type, byte limit, and timeout validation;
- one in-flight upstream request for the entire retriever instance;
- minimum one-second interval between upstream request starts;
- at most three attempts for network failures, `429`, and `5xx` responses;
- exponential backoff; and
- no retriever retry for parser/schema structural failures.

The constructor disables real network access by default. Only the manual CLI explicitly enables it; tests inject a local fake fetch implementation.

## Snapshot contract

`lionlog.psu-menu.v1` preserves:

- hall and source campus selector;
- station/category and service date;
- LionLog meal-period ID plus the exact source meal value;
- source food name and nutrition handle as provenance;
- source serving label, parsed quantity when unambiguous, and exact source unit;
- calories, protein, carbohydrates, fat, and reliably exposed additional nutrients;
- dietary traits, ingredients, and allergens;
- allowlisted source URLs and retrieval/cache timestamps.

Unavailable nutrients are `null`, never zero. No ounce/gram conversion, inferred precision, or cross-date canonical food identity is created. Observation IDs include menu context and the source handle.

## Cache and provider states

- `live`: a newly retrieved and validated snapshot supplied to `PsuMenuProvider`;
- `cached`: a validated snapshot within its five-minute menu TTL;
- `stale`: a validated last-known-good snapshot past fresh TTL but within 48-hour retention, including after a failed refresh;
- `sample`: deterministic `MockMenuProvider` content; and
- `unavailable`: no valid live/cached/retained snapshot.

The live provider never substitutes or mixes sample items when unavailable. Nutrition observations are cached for 24 hours. A repeated manual ingestion refreshes the menu page but reuses matching still-fresh nutrition cache entries.

## Test and CI policy

All automated parsing, caching, failure, and provider tests use committed files whose names end in `.sanitized.html` or the existing sanitized JSON observation. Each HTML fixture is marked as sanitized and contains no upstream scripts, styles, correspondence, or personal contact details.

CI runs `npm ci`, the production build plus Node test suite, and ESLint. It does not run the manual ingestion command. Real PSU access requires the retriever's explicit manual-network flag, which fixture tests never set.

## Operational limits

This proof of concept is not scheduled, deployed, or wired to a production backend. GitHub Pages, Sites configuration, repository visibility, DNS, optimizer, macro-target UI, accounts, diary, and analytics remain unchanged.
