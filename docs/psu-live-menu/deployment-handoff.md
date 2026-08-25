# LionLog Admin and Site-owner handoff

## Current milestone

- Audit branch: `feature/psu-live-menu-alpha-1`
- Baseline: clean `main` at `001e080112c925d50be6a9c6aa92b880e6acfdbe`
- Existing Sites project identity preserved
- No live provider, production scraping, backend persistence, account, analytics, diary, optimizer, deployment, access change, domain purchase, or DNS change

This task is the post-prototype implementation/audit task, not the existing Site-owning Prototype task. The Site owner should review and deploy only after a later implementation milestone is approved. There is nothing to deploy from this documentation-only audit milestone unless Admin explicitly decides to publish repository documentation through another channel.

## Admin actions required

1. Contact Penn State Dining/Housing and Food Services for a supported feed/API or written permission covering automation, caching, fields, redistribution, attribution, rate limits, and support.
2. Record the approval or denial and any terms in an Admin-controlled decision log; do not store credentials in this repository.
3. Confirm whether ingredients are in `v0.2.0-alpha.2` scope or whether the next slice is limited to menu grouping, serving units, primary macros, dietary traits, and allergens.
4. Confirm ownership/registration of `lionlog.app` through a user-controlled registrar account.
5. Route custom-domain attachment and any later deployment through the existing Site-owning Prototype task for project `appgprj_6a8d8d0dad888191af93966368936653`.

## Proposed `v0.2.0-alpha.2` scope

The next milestone should implement the provider contract and same-origin adapter against a permissioned fixture/source, not expand product scope.

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

- [ ] Admin records Penn State authorization or an approved feed. Without it, the milestone remains fixture-only and cannot claim live data.
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
