# `v0.2.0-alpha.3` cached live-menu delivery

Alpha 3 publishes Alpha 2's validated ingestion output as same-origin static JSON. It does not add an official PSU API integration, browser scraping, scheduling, deployment, or meal optimization.

## Delivery boundary

```text
PSU public menu HTML
  -> manual centralized Alpha 2 ingestion
  -> ignored local validated cache
  -> manual static exporter
  -> menu-data/v1/catalog.json + independent snapshots
  -> browser validation + IndexedDB last-known-good store
  -> PsuMenuProvider through MenuProvider
  -> PWA
```

The versioned catalog records generation time, supported schema/parser versions, service dates, halls, meal periods, and relative snapshot URLs. Publication validates cached snapshots before writing and reads them back for a second validation pass. Browser delivery validates the catalog, the full snapshot structure, deterministic station/observation/snapshot identities, and catalog-to-snapshot metadata before storage or use.

`./menu-data/v1/catalog.json` is resolved against the document base URL. Root hosting uses the default empty application base path; a future `/lionlog/` artifact is built with `LIONLOG_BASE_PATH=/lionlog`. The bounded compile-time setting prefixes the route and framework asset URLs. A post-build normalization keeps the artifact tree mount-relative, and the local/worker entry maps prefixed framework requests to that tree. Catalog and snapshot references remain relative and same-origin. The service worker deliberately excludes `menu-data/`; validated IndexedDB state owns menu-data offline behavior while the service worker owns the application shell.

## Honest states

- `live`: a fresh validated snapshot fetched from the same-origin static publication;
- `cached`: a fresh previously validated browser copy used after remote failure;
- `stale`: an expired-but-retained validated browser copy;
- `sample`: an explicitly selected deterministic demonstration provider; and
- `unavailable`: no published or retained valid snapshot exists.

Live mode never imports, blends, or silently substitutes `MockMenuProvider`. Raw PSU HTML and the local ingestion cache remain ignored and are never published as PWA assets.

## Manual artifact workflow

`.github/workflows/build-live-menu-artifact.yml` has only `workflow_dispatch`. It requires the exact `LIVE_PSU_INGESTION` confirmation input, ingests explicit hall/meal queries serially, builds the PWA, exports the static tree into the build, and retains a review artifact for 14 days. It does not deploy or schedule anything. Ordinary CI, pull requests, tests, and builds contain no live-ingestion step and remain network-free after dependency installation.
