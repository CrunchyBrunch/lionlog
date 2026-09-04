# v0.2.0-alpha.4 — live Pages field-release preparation

Date: 2026-09-02

## Scope and source status

Alpha 4 prepares, but does not deploy, a production-shaped static artifact containing the project-site PWA and fresh normalized PSU menu snapshots. Penn State Residential Dining approved LionLog's use of publicly available dining-menu information in August 2026. LionLog does not use an official or private Penn State API, is independent, and is not affiliated with or endorsed by Penn State.

The architecture remains centralized: PSU public HTML is retrieved only by the trusted manual Actions job, parsed and normalized outside React, exported as versioned same-origin JSON, and read by the existing `PsuMenuProvider` boundary. Browser code never sends the ColdFusion form or retrieves PSU nutrition pages.

## Manual trusted release path

`.github/workflows/build-live-menu-artifact.yml` has only `workflow_dispatch`. It accepts one strict ISO service date and the exact confirmation phrase. The runtime guard also requires GitHub Actions, the `CrunchyBrunch/lionlog` repository, the authorized workflow path, an exact commit SHA, and either `main` or the reviewed Alpha 4 feature ref. The workflow has only `contents: read`; it has no Pages or identity-token permission and no deployment step.

For the requested date the job:

1. verifies the toolchain with TypeScript, fixture-only tests, and ESLint;
2. restores only the versioned JSON nutrition cache and validates every restored entry;
3. discovers current source-provided meal option values for East (11), South (13), Pollock (14), West (16), and North (17);
4. ingests every discovered hall/meal query, accepting a recognized empty menu and only the narrowly bounded invalid-name omission described below while failing closed for every other retrieval, structure, normalization, cache, or publication failure;
5. exports the exact report-backed query set as catalog version `lionlog.psu-catalog.v3` and snapshot version `lionlog.psu-menu.v2`;
6. builds for `/lionlog/`, validates that `menu-data/v2` contains only the catalog and its referenced snapshots, round-trips the artifact, records SHA-256 inventory output, and retains the site artifact for review.

Bounds are explicit: at most 20 menu queries, 1,000 items and nutrition handles per query, 5,000 observations for the release, and 1,655 unique nutrition observations across the release. The upstream-attempt ceiling is derived rather than selected independently: the 45-minute workflow reserves 10 minutes for verification, build, and artifact handling, leaving a 35-minute ingestion window; at the maximum configured 1.25-second pacing interval this permits `floor(2,100,000 / 1,250) = 1,680` upstream attempts. Five hall meal-option requests and at most 20 menu requests leave at most 1,655 zero-retry nutrition requests. Each retry counts against the same 1,680-attempt ceiling, so retry activity reduces the remaining logical observations instead of expanding the crawl. A separate 35-minute elapsed-time guard accounts for response latency and backoff so cache validation and saving retain the workflow reserve. Requests remain globally serialized, limited to three attempts per operation with ten-second timeouts and response-size caps, and use bounded exponential backoff while honoring a valid `Retry-After` up to 60 seconds. Structural failures are not retried.

The menu freshness window is 18 hours and last-known-good retention is 48 hours, which supports a manually produced static artifact without describing an old snapshot as fresh. Nutrition observations remain reusable for 24 hours when their versioned cache entries pass integrity validation. Missing values remain `null`, PSU serving labels/units are preserved, and source nutrition handles remain provenance rather than canonical food identities.

### Request-budget and resume audit

On September 2, 2026, the first authorized full field-release run failed closed after exactly 750 upstream attempts when the former static ceiling was reached. The run restored no cache because no matching cache existed. Its logs did not contain enough aggregate progress telemetry to reconstruct the exact split among menu, nutrition, and retry attempts; no food-level data was emitted. Code inspection confirmed that cache hits bypass the retriever and do not count as upstream attempts, while each real retry does count. Nutrition handles are deduplicated within a query and a fresh validated file entry prevents a repeat request across queries.

The former combined `actions/cache` step did not save newly validated entries after the failed ingestion step, so the partial nutrition cache was lost with the runner. The workflow now uses explicit restore and save actions with run-specific immutable keys and a date/schema/parser-scoped restore prefix. After any attempted ingestion, it validates every cache entry before saving. The trusted manual repository/ref/event guard prevents pull-request and fork workflows from reaching this path, and GitHub cache branch scoping prevents fork/PR cache entries from poisoning the trusted branch. A new attempt always re-fetches meal options and menu pages; only still-fresh, schema-valid, parser-version-matched nutrition details are reused.

Aggregate progress records now expose only planned/completed query counts, unique-observation counts, cache hits, request categories, retries, and the derived limits. They contain no food names, handles, URLs, or raw HTML. Any ingestion or post-ingestion cache-validation failure is gated before export, build, or upload, so resumable intermediary cache state cannot become a partial publication artifact.

### Bounded invalid-name quarantine

LionLog first uses a valid source menu label, then a valid nutrition-detail title. A recognized menu observation with a valid numeric nutrition handle is omitted only when both display-name sources are empty or exceed the existing 160-character bound. The parser retains only the typed internal condition (`empty` or `over-limit`), never the rejected text. LionLog does not invent a name, display the handle as a name, or expose omitted names, handles, URLs, encodings, or hashes.

The release remains fail-closed unless every threshold holds: no more than one such omission per hall/meal query, no more than five in the release, and no more than `max(1, floor(total source observations × 0.01))`, still subject to the absolute cap of five. A non-empty source query must retain at least one published observation. Invalid handles, changed menu/category/item/link/dietary structure, nutrition structure failures, name disagreement when both names are valid, cache failures, and every non-name validation failure remain blocking.

Snapshots, catalog entries, and the release report record only aggregate typed `invalid-name` omission counts plus independent `complete` or `partial` coverage. Completeness does not change whether data is live, cached, or stale. The PWA explicitly warns when a selected snapshot is partial; sample data is never substituted or blended.

## Publication and browser behavior

The catalog records schema/parser versions, generation and retrieval times, source commit, exact service date, hall/query completeness, aggregate invalid-name omission counts, empty and source/published item counts, request totals, and nutrition cache hits. The artifact validator reconstructs the allowed `menu-data/v2` file set from the validated catalog, validates every snapshot again, rejects inconsistent or tampered coverage metadata, unreferenced files, and unsafe paths, and scans browser JavaScript for retriever/parser/form/pacing and Node-only ingestion code.

The PWA still defaults to PSU snapshots and keeps sample mode explicitly selectable. It shows source state, retrieval time and age, a public-source link, and independent/not-endorsed wording. Same-origin catalog/snapshot validation, IndexedDB last-known-good storage, retention bounds, and app-shell/menu-data service-worker separation remain the Alpha 3 boundary.

## Operator procedure

1. Review and merge the Alpha 4 implementation before preparing a main-branch artifact.
2. Manually dispatch **Prepare live Pages field-release artifact** with the intended current service date and exact confirmation.
3. Confirm the run commit, coverage report, request/cache counts, and all checks.
4. Download the retained artifact, verify its SHA-256/inventory and browser behavior at `/lionlog/`, including an offline reload.
5. Stop. Deployment is a separate explicit owner action through the existing manual Pages workflow.

The field-release job is not a scheduler. Once- or twice-daily production retrieval remains only a proposed future cadence subject to separate approval and implementation; Alpha 4 adds no cron or scheduled Actions trigger. It also does not change `.openai/hosting.json`, Pages settings, repository visibility, DNS, license, optimizer, accounts, diary, or analytics.
