# `v0.2.0-alpha.2` verification report

Verified on August 31, 2026. Live checks were run manually against Penn State's public dining-menu pages. Automated tests and CI use sanitized frozen fixtures and have no network-enabled code path.

## Documentation gate

- Research PR #3 recorded Penn State Residential Dining's August 2026 approval for LionLog to use publicly available dining-menu information.
- The documentation states that no official or private API access was granted, preserves the August 25 uncertainty as dated history, and contains no correspondence or personal contact information.
- The documentation build, lint, tests, and link checks passed before PR #3 was merged as commit `c51d67324d47338c1496249958a3499634ae2932`.
- Implementation began afterward on `feature/psu-live-ingestion-alpha-2`.

## Live ingestion checks

Both checks used service date `2026-08-31`, the manual CLI, one-second request pacing, the exact allowlisted PSU origin and paths, and the ignored `work/psu-live-validation` cache. Only validated versioned JSON was persisted.

| Hall / meal | Source selector | Result | Stations | Items | Nutrition requests | Initial cache hits |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| North / Warnock — Breakfast | campus `17`, `Breakfast` | `live` | 5 | 18 | 18 | 0 |
| Pollock — Dinner | campus `14`, `Dinner` | `live` | 12 | 61 | 61 | 0 |

The North / Warnock breakfast run was then repeated against the same cache. The repeated run made one menu request, made **zero nutrition requests**, and reused all **18** fresh nutrition entries. This demonstrates bounded nutrition-cache reuse without treating the PSU handle as a permanent canonical food identity; snapshot observation IDs remain scoped to hall, station, service date, meal, handle, and occurrence.

## Empty, unavailable, and failure checks

Frozen sanitized fixtures verify:

- a recognized empty upstream menu returns a valid `live` snapshot with zero items and no nutrition requests;
- malformed/structurally changed HTML fails immediately without parser retry;
- a failed refresh retains and exposes a still-retained last-known-good snapshot as `stale`;
- a failure with no retained snapshot returns `unavailable`; and
- `PsuMenuProvider` never substitutes or mixes `MockMenuProvider` sample items into live/cached/stale/unavailable results.

## Automated verification

- TypeScript: `tsc --noEmit` — passed.
- Production build plus tests: `npm test` — passed, 39 tests total (30 TypeScript ingestion/domain tests and 9 built-PWA tests).
- ESLint: `npm run lint` — passed.
- Production Vinext build — passed as part of `npm test`.
- Clean install: `npm ci --ignore-scripts` — passed.
- Dependency tree: `npm ls --all` — passed; `parse5@8.0.1` and `zod@4.5.4` resolved as direct production dependencies.
- Production dependency audit: `npm audit --omit=dev --audit-level=low` — zero vulnerabilities.
- Registry verification: `npm audit signatures` — 458 packages have verified registry signatures and 83 have verified attestations.
- Full-tree audit: 17 development/build-tool findings (2 low, 15 high) remain in the pre-existing Vinext/Vite/Cloudflare toolchain. They are absent from the production-dependency audit; upgrading that toolchain is outside this ingestion milestone.
- Sanitization guard — every committed PSU HTML fixture is explicitly marked `SANITIZED DETERMINISTIC`; no upstream scripts, styles, correspondence, or contact information are present.
- CI guard — `.github/workflows/ci.yml` runs `npm ci --ignore-scripts`, `npm test`, and `npm run lint`; it never invokes `ingest:psu`.

The final boundary review additionally verifies no-follow redirect handling, streaming response-size enforcement, body-read timeouts, bounded retriever configuration, required nutrition-fact sentinels, stable context-scoped observation IDs, semantic cache provenance, atomic file-cache writes, invalid-cache rejection, provider revalidation, and a CI-environment live-ingestion guard.

## Scope confirmation

No production scheduler, deployment, GitHub Pages activation, Sites hosting action, repository visibility change, DNS change, optimizer, macro-target UI, account, diary, or analytics work was performed. The implementation PR is intentionally left as a draft and must not be merged or deployed as part of this milestone.
