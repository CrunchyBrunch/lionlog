# `v0.2.0-alpha.3` verification report

Verification date: August 31, 2026. The review artifact and live ingestion cache remained local and ignored. No deployment, schedule, Pages activation, hosting/DNS change, repository visibility change, or optimizer work was performed.

## Automated and build verification

- clean install: `npm ci --ignore-scripts` installed 562 packages and audited 569;
- TypeScript: `tsc --noEmit` passed;
- production builds: all five Vinext build environments passed for both the default root artifact and `LIONLOG_BASE_PATH=/lionlog`;
- tests: 42 TypeScript fixture/integration tests and 12 JavaScript build/PWA tests passed;
- ESLint: passed with no findings;
- dependency tree: `npm ls --all` exited successfully;
- production dependency audit: 0 vulnerabilities;
- full install audit: 17 existing development/build-tool advisories (2 low, 15 high), with no production advisory and no dependency changes in this milestone.

Tests use only frozen sanitized fixtures. Coverage includes catalog and snapshot tampering, unsupported versions, missing publication files, unavailable results, bounded stale/LKG behavior, offline reload, root and `/lionlog/` URL resolution, explicit sample separation, export read-back validation, service-worker separation, and absence of Node-only retrieval/parser code from the browser bundle.

## Authorized manual live export

The explicit guarded command was run for service date `2026-08-31`:

- East / Findlay lunch: 13 stations, 76 items, snapshot `psu:snapshot:v1:d1e5f048b72371ec12855e7c2e4840e6ad77dd5f06e5e2abe75710a54d0ff4c4`;
- Pollock dinner: 12 stations, 61 items, snapshot `psu:snapshot:v1:7faeae2f64a86654a870b82193a21dafe5bfb68d790fd9b63da6c755fea798c9`.

The first East run reused 15 earlier valid nutrition records and fetched 61. The immediate repeat made one menu request, zero nutrition requests, and 76 nutrition cache hits. PSU explicitly reported nutrition unavailable for several listed observations; those observations were retained with null source serving/nutrition fields. Other missing or changed structures continue to fail closed.

The manual exporter produced:

```text
menu-data/v1/catalog.json
menu-data/v1/snapshots/2026-08-31/11/lunch.json
menu-data/v1/snapshots/2026-08-31/14/dinner.json
```

The catalog and both snapshots passed publication validation and read-back validation. Live output beneath `public/menu-data/` and the ingestion cache beneath `work/` are ignored and are not part of the commit.

## Mobile and offline verification

The root-hosted production build and a separately compiled `/lionlog/` build were checked at a 390×844 iPhone-sized viewport (375 CSS pixels wide):

- East lunch loaded 76 real published observations as `stale`, accurately reflecting the age of the retained August 31 snapshot at review time;
- whole-hall and station selection worked; selecting `ENTREES (0)` reduced the list to 2 items;
- sample mode was available only through its explicit control and displayed its own `sample` state;
- source retrieval time, age, public source link, and independent/not-endorsed disclaimer were visible;
- document scroll width and client width were both 375 CSS pixels in both hosting modes, so no horizontal overflow was present;
- the `/lionlog/` page, prefixed framework asset, and catalog each returned HTTP 200 without an asset redirect;
- console warnings/errors: 0 in both hosting modes.

After the validated East snapshot had been saved, each production server was stopped and its browser tab was reloaded. The service worker restored the application shell, IndexedDB supplied the still-retained validated snapshot, all 76 items remained available as `stale`, and console warnings/errors remained 0.

## Final pre-merge review

The August 31 final review found and corrected two concrete Alpha 3 issues before marking the pull request ready:

- Vinext's generated framework tree did not initially serve a compiled `/lionlog/` mount end to end. The build now accepts only an empty or single-segment `LIONLOG_BASE_PATH`, normalizes the mounted framework tree without overwriting existing output, and maps prefixed framework requests to that validated tree.
- The offline banner previously referred only to an installed sample menu. It now states that retained validated menus remain available when saved and makes no claim of sample fallback.

Post-fix verification repeated the clean install, TypeScript, production builds, all tests, ESLint, dependency-tree validation, production audit, root and `/lionlog/` mobile browser checks, server-stop reloads, artifact inspection, and browser-bundle scan. The dependency lockfile remained unchanged. The browser bundle contains the allowlisted public source URL needed for attribution and source validation, but no PSU POST fields, retriever, parser, pacing, Node filesystem/crypto imports, or nutrition retrieval code.
