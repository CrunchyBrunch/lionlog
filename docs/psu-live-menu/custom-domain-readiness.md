# `lionlog.app` custom-domain readiness

Audit date: 2026-08-25

Status: source-ready with metadata follow-up; domain ownership not confirmed in this task

No domain was purchased, no DNS was changed, no Sites project was created, and no Sites access/domain configuration was mutated. `.openai/hosting.json` still identifies the existing project `appgprj_6a8d8d0dad888191af93966368936653`.

## Current origin-safe surfaces

| Surface | Current implementation | Finding |
| --- | --- | --- |
| Manifest link | `./manifest.webmanifest` | Safe under a new origin and path scope |
| Manifest `start_url` | `./` | Origin-relative and safe |
| Manifest `scope` | `./` | Origin-relative and safe |
| Manifest icons | `./icons/...` | Origin-relative and safe; declared PNG dimensions are tested |
| Apple touch icon | `./icons/apple-touch-icon.png` | Origin-relative and safe |
| Service-worker registration | `./sw.js`, scope `./` | Origin-relative; service workers are origin-bound |
| App-shell asset discovery | resolves against registration scope and filters to same origin | Safe against cross-origin cache injection |
| Navigation fallback | verifies same origin, HTML content type, and LionLog shell marker | Safe under a new origin |
| API handling | service worker skips `/api/` | Appropriate for a future freshness-aware provider store |
| Internal code/assets | no production `chatgpt.site` absolute URL found | Safe for custom origin |

## Required before custom-domain launch

- Admin confirms `lionlog.app` is registered in an account the user controls. Never request registrar credentials or store DNS/publishing credentials in the repository.
- The existing Site-owning Prototype task follows the Sites custom-domain process for the existing project. Do not initialize or deploy a new Sites project.
- Configure both apex and chosen `www` behavior deliberately; redirect the non-canonical host to the canonical HTTPS origin if Sites supports it.
- Replace request-header-derived social origin construction with a trusted configured public origin (`https://lionlog.app`) for production metadata. The current `generateMetadata` trusts `x-forwarded-host`/`host`; that is unsuitable as the canonical authority.
- Add framework-native canonical metadata (`metadataBase`/canonical URL and Open Graph `url`) using the trusted origin, while retaining local-preview behavior without publishing localhost metadata.
- Confirm `/og.png`, the root document, manifest, icons, and service worker all return `200` at the custom origin over HTTPS.
- Add an explicit manifest `id` such as `./` before public custom-domain launch so future path changes do not accidentally change the installed-app identity. The ID is still origin-bound.
- Bump the application-shell cache/marker version with the release that changes metadata or PWA assets; rerun current redirect/cross-origin shell tests.
- If the live adapter is approved later, expose it only same-origin and allowlist the deployed canonical origin in any request-origin/CSRF checks. Do not add `*` CORS.
- Verify source attribution links, privacy/support links, and any application URL shown in copy use `lionlog.app` only after the domain is active.
- Check search-engine ownership/canonicalization only after Admin approves; no analytics is required.

## Installation migration

PWA storage, service workers, caches, and manifest identity are origin-bound. An existing Home Screen installation from `lionlog.crunchybrunch.chatgpt.site` will not become the `lionlog.app` installation. Users must visit `https://lionlog.app`, reinstall LionLog, and may remove the old installation. Cached sample or future last-known-good data on the old origin will not migrate automatically.

Keep the old public URL available or present a short migration notice for a product-approved transition window; do not make that change in this audit task.

## Launch verification checklist

- [ ] User-controlled registration confirmed by Admin
- [ ] Existing Sites project reused; project ID unchanged
- [ ] Custom origin attached by existing Site-owning task
- [ ] HTTPS valid at apex/canonical host
- [ ] Redirect policy and canonical host agreed
- [ ] Trusted metadata origin configured
- [ ] Canonical/Open Graph URL fields validated
- [ ] Manifest loads and includes explicit `id`, relative `start_url`, and relative `scope`
- [ ] All declared icons return correct content type/dimensions
- [ ] Service worker installs, controls, updates, and stays within intended scope
- [ ] Offline app shell works on the new origin
- [ ] Future menu store starts empty and handles offline/unavailable cleanly
- [ ] No absolute `chatgpt.site` production asset links remain
- [ ] Existing-install reinstallation notice approved
- [ ] No official Penn State marks or endorsement language present

## Evidence commands for the Site-owning handoff

The Site-owning task should run the repository's existing build, lint, and PWA tests, then verify headers/URLs on the actual custom origin. This task intentionally did not mutate or deploy the Site.
