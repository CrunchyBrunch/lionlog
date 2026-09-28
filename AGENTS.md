# Working in LionLog

## Scope and architecture
- Read `README.md` and `package.json` first. Use Node 22 LTS (at least 22.13, below 23); retain the lockfile and existing dependency versions unless dependency work is requested.
- Keep domain contracts in `domain/`, coordination in `application/`, and provider/IO details in `infrastructure/`. PSU retrieval/parsing belongs outside React; the browser consumes validated static snapshots from its own origin.
- Follow the requested scope. Optimizers, accounts, diary, schedules, analytics, licensing, and hosting/settings changes require their own task.

## Source and data boundaries
- For ingestion/parser/provider work, read `docs/psu-live-menu/README.md`, `field-mapping.md`, `operating-policy.md`, and the relevant implementation notes. Alpha-1 policy includes future proposals; use current implementation and later notes for what actually exists.
- CI and ordinary tests use frozen sanitized fixtures and must not contact PSU. Do not run ingestion, live-candidate preparation, or enable `LIONLOG_ALLOW_PSU_NETWORK` without explicit task authorization for that operation.
- Preserve strict validation, provenance, freshness/retention, coverage, and the distinct `live`, `cached`, `stale`, `sample`, and `unavailable` states. Never silently substitute sample foods or interpret an unverified empty response as a valid empty menu.
- Keep raw PSU HTML, work caches, credentials, correspondence, and personal information out of published artifacts. Synthetic/sanitized test fixtures belong under `tests/fixtures/`.

## Verification
- Install with `npm ci --ignore-scripts`.
- Run `npm test` (includes the build and regression suites) and `npm run lint`, matching `.github/workflows/ci.yml`. Run `npm exec tsc -- --noEmit` for TypeScript changes and release-artifact work, as in the artifact workflow.
- Report exact commands/results and any environment-blocked checks. Investigate failures; do not weaken the source, artifact, or publication guards to obtain green CI.
- For UI/PWA work, consult `docs/iphone-pwa-verification.md`; automated desktop/mobile emulation does not establish physical iPhone acceptance.

## Review and publication
- Work on a task branch, review the diff, and open a draft PR with scope, supported root cause, preserved contracts, verification evidence, and deferred work. Do not force-push, mark ready, merge, or deploy without task authorization.
- Before touching publication machinery, read `docs/github-pages-deployment.md` and `docs/psu-live-menu/production-publication-runbook.md`.
- Candidate production and deployment are separate owner-authorized manual operations. Retain immutable artifact IDs/digests, exact-SHA CI/provenance, expiry checks, protected approval, and the supported Pages actions.
- Do not dispatch/rerun candidate or deployment workflows, approve environments, alter Pages/DNS/settings, or publish from a branch/PR as part of ordinary implementation work. Ambiguous deployment outcomes require the runbook's evidence-based reconciliation; never infer permission to retry.
