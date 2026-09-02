# v0.2.0-alpha.4 — live Pages field-release preparation

Date: 2026-09-01

## Scope and source status

Alpha 4 prepares, but does not deploy, a production-shaped static artifact containing the project-site PWA and fresh normalized PSU menu snapshots. Penn State Residential Dining approved LionLog's use of publicly available dining-menu information in August 2026. LionLog does not use an official or private Penn State API, is independent, and is not affiliated with or endorsed by Penn State.

The architecture remains centralized: PSU public HTML is retrieved only by the trusted manual Actions job, parsed and normalized outside React, exported as versioned same-origin JSON, and read by the existing `PsuMenuProvider` boundary. Browser code never sends the ColdFusion form or retrieves PSU nutrition pages.

## Manual trusted release path

`.github/workflows/build-live-menu-artifact.yml` has only `workflow_dispatch`. It accepts one strict ISO service date and the exact confirmation phrase. The runtime guard also requires GitHub Actions, the `CrunchyBrunch/lionlog` repository, the authorized workflow path, an exact commit SHA, and either `main` or the reviewed Alpha 4 feature ref. The workflow has only `contents: read`; it has no Pages or identity-token permission and no deployment step.

For the requested date the job:

1. verifies the toolchain with TypeScript, fixture-only tests, and ESLint;
2. restores only the versioned JSON nutrition cache and validates every restored entry;
3. discovers current source-provided meal option values for East (11), South (13), Pollock (14), West (16), and North (17);
4. ingests every discovered hall/meal query, accepting a recognized empty menu but failing the complete release for any retrieval, structure, normalization, cache, or publication failure;
5. exports the exact report-backed query set as catalog version `lionlog.psu-catalog.v2` and snapshot version `lionlog.psu-menu.v1`;
6. builds for `/lionlog/`, validates that `menu-data/v1` contains only the catalog and its referenced snapshots, round-trips the artifact, records SHA-256 inventory output, and retains the site artifact for review.

Bounds are explicit: at most 20 menu queries, 1,000 items and nutrition handles per query, 5,000 items for the release, and 750 upstream attempts including retries. Requests are serialized, paced by at least one second plus bounded jitter, limited to three attempts with ten-second timeouts and response-size caps, and use bounded exponential backoff while honoring a valid `Retry-After` up to 60 seconds. Structural failures are not retried.

The menu freshness window is 18 hours and last-known-good retention is 48 hours, which supports a manually produced static artifact without describing an old snapshot as fresh. Nutrition observations remain reusable for 24 hours when their versioned cache entries pass integrity validation. Missing values remain `null`, PSU serving labels/units are preserved, and source nutrition handles remain provenance rather than canonical food identities.

## Publication and browser behavior

The catalog records schema/parser versions, generation and retrieval times, source commit, exact service date, hall/query coverage, empty and item counts, request totals, and nutrition cache hits. The artifact validator reconstructs the allowed `menu-data/v1` file set from the validated catalog, validates every snapshot again, rejects unreferenced files and unsafe paths, and scans browser JavaScript for retriever/parser/form/pacing and Node-only ingestion code.

The PWA still defaults to PSU snapshots and keeps sample mode explicitly selectable. It shows source state, retrieval time and age, a public-source link, and independent/not-endorsed wording. Same-origin catalog/snapshot validation, IndexedDB last-known-good storage, retention bounds, and app-shell/menu-data service-worker separation remain the Alpha 3 boundary.

## Operator procedure

1. Review and merge the Alpha 4 implementation before preparing a main-branch artifact.
2. Manually dispatch **Prepare live Pages field-release artifact** with the intended current service date and exact confirmation.
3. Confirm the run commit, coverage report, request/cache counts, and all checks.
4. Download the retained artifact, verify its SHA-256/inventory and browser behavior at `/lionlog/`, including an offline reload.
5. Stop. Deployment is a separate explicit owner action through the existing manual Pages workflow.

The field-release job is not a scheduler. Once- or twice-daily production retrieval remains only a proposed future cadence subject to separate approval and implementation; Alpha 4 adds no cron or scheduled Actions trigger. It also does not change `.openai/hosting.json`, Pages settings, repository visibility, DNS, license, optimizer, accounts, diary, or analytics.
