# LionLog Admin and Site-owner handoff

> Historical status note (September 1, 2026): this handoff records the Alpha 1 plan. Alpha 2 ingestion and Alpha 3 cached static delivery are now implemented on `main`; use `implementation-alpha-2.md`, `implementation-alpha-3.md`, and the public-release readiness report for current behavior. No deployment or scheduled retrieval has been enabled.

## Current milestone

- Audit branch: `feature/psu-live-menu-alpha-1`
- Baseline: clean `main` at `001e080112c925d50be6a9c6aa92b880e6acfdbe`
- Existing Sites project identity preserved
- No live provider, production scraping, backend persistence, account, analytics, diary, optimizer, deployment, access change, domain purchase, or DNS change

This task is the post-prototype implementation/audit task, not the existing Site-owning Prototype task. The Site owner should review and deploy only after a later implementation milestone is approved. There is nothing to deploy from this documentation-only audit milestone unless Admin explicitly decides to publish repository documentation through another channel.

## Admin actions required

1. Authorization completed: Penn State Residential Dining approved LionLog's use of publicly available dining-menu information in August 2026. No official/private API access was granted.
2. Keep correspondence and personal contact information outside this repository; this documentation records only the authorization outcome.
3. Keep scheduled production scraping outside the proof-of-concept scope unless separately approved.
4. Confirm ownership/registration of `lionlog.app` through a user-controlled registrar account before any custom-domain work.
5. Route custom-domain attachment and any later deployment through the existing Site-owning Prototype task for project `appgprj_6a8d8d0dad888191af93966368936653`.

## Historical proposed `v0.2.0-alpha.2` scope

This section preserves the acceptance plan used before Alpha 2 and Alpha 3 were implemented; it is not the current implementation status.

### In scope

- additive versioned `lionlog.menu.v1` envelope;
- domain evolution for explicit source states/provenance, nullable nutrients, typed dietary/allergen metadata, and source-unit preservation;
- `PsuMenuProvider` consuming same-origin validated JSON;
- narrow server adapter using the approved official source;
- server parsing/sanitization, allowlists, rate limits, request coalescing, cache, circuit breaker, and last-known-good behavior;
- local/offline last-known-good envelope storage with version/age checks;
- explicit live/cached/stale/unavailable UI states while retaining sample mode;
- source timestamp/link, independent-product disclaimer, and allergy/cross-contact warning;
- deterministic fixtures for duplicate names, missing nutrients, empty menus, unknown markers, malformed HTML, redirects, and outages;
- automated boundary, parser, failure-mode, PWA/offline, build, and lint validation.

### Out of scope

- accounts, user backend/persistence, analytics, optimizer, diary;
- unofficial APIs;
- domain purchase or DNS credential handling;
- Sites project replacement;
- production deployment without release approval;
- invented ounce/gram conversions or silent cross-date food merging.

## Proposed `v0.2.0-alpha.2` acceptance criteria

- [x] Admin records Penn State authorization for use of publicly available dining-menu information; no official/private API access is claimed.
- [ ] Direct client scraping is absent; all live reads use a same-origin adapter.
- [ ] Only allowlisted official HTTPS source URLs are contacted.
- [ ] Raw upstream HTML never crosses the adapter boundary or reaches React rendering.
- [ ] The adapter and provider both reject unsupported schema versions and invalid envelopes.
- [ ] All five configured University Park hall selectors, ISO service dates, and four meal periods map deterministically.
- [ ] Categories/stations and duplicate-name items remain distinct without using names as identity.
- [ ] `mid` is stored as provenance only; observation identity includes menu context.
- [ ] Source serving label/unit and source nutrient precision are retained; missing is null; no ounce conversion exists.
- [ ] Typed dietary/allergen values and unknown-value warnings are covered by tests.
- [ ] Live, cached, stale, sample, and unavailable states have deterministic UI tests and honest copy.
- [ ] Invalid/partial source responses cannot overwrite last-known-good data.
- [ ] Request coalescing, approved rate limits, backoff, circuit breaking, and cache TTL behavior are tested with fake time/network.
- [ ] Offline access reads only a previously validated, version-compatible envelope and displays its age.
- [ ] Attribution, independent-product disclaimer, official source link, and allergy warning are visible.
- [ ] `MockMenuProvider` remains deterministic and existing pure domain tests continue to pass.
- [ ] Build, lint, automated tests, and a permissioned canary pass before draft-release review.

## Site-owner deployment handoff for a later approved release

Use the current repository and `.openai/hosting.json` unchanged as the starting identity. After Admin release approval, the existing Site owner should validate the exact approved commit, save/deploy it to the existing project, and attach `lionlog.app` only after ownership is confirmed. Existing `chatgpt.site` Home Screen users must reinstall from the custom origin.
