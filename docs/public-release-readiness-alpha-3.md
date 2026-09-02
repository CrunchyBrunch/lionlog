# Public release readiness — v0.2.0-alpha.3

Date: 2026-09-01  
Audited base: `37706c119f4b2f12d089004a3e59de6ae8f8223f`

Status update: the repository was subsequently made public. A separate manual-only Pages deployment workflow was added for review in commit `bb46104e4bb222e2f01c638f9a148f8d7dd6e337`; it has not been run, Pages settings remain an owner action, and the original audit conclusions remain historical context.

## Result

The Alpha 3 repository is suitable for public visibility after the changes on the public-release-readiness branch are reviewed and merged. Making the repository public and enabling or configuring GitHub Pages remain owner actions; this audit does neither.

## Privacy, history, and artifact boundary

- The current tree, all reachable commits, historical GitHub Actions logs, and current dependency/build artifacts were checked for credentials, tokens, private correspondence, personal contact details, local cache output, raw live PSU HTML, and committed live menu publications.
- No credential or private-data blocker was found. An older documentation revision contained two public Penn State organizational contact addresses; the current tree does not. Those public institutional addresses do not justify rewriting otherwise valid history.
- Git commit authorship remains ordinary public repository metadata. The owner may select a GitHub-provided `noreply` address for future commits if desired; no existing history rewrite is required.
- Eight sanitized deterministic HTML fixtures are the only committed PSU HTML. Ignored `work/` ingestion state and `public/menu-data/` output are not part of the repository or reviewable Pages artifact.
- Historical Alpha 1/2 screenshots contain no private information. They are currently unreferenced and may be removed in a later documentation cleanup, but they do not block publication.
- The Pages review workflow verifies that neither source nor built `menu-data/` is present. It has read-only repository permission, no schedule, no deployment step, and no permission to contact PSU.

## Compliance and product claims

- Documentation and UI consistently describe Penn State public-menu information, not an official Penn State API.
- The project states that LionLog is independent and is not affiliated with or endorsed by Penn State.
- August 2026 permission for use of publicly available Residential Dining menu information is documented without correspondence, names, or contact information. No official or private API access is claimed.
- Browser code fetches only same-origin normalized JSON. Live retrieval remains an explicit, manually dispatched trusted workflow; ordinary CI, pull requests, tests, builds, and the Pages artifact workflow remain network-free with respect to PSU.
- Sample mode is explicit and is never a silent live-data fallback. Optimizer, accounts, diary, analytics, scheduled ingestion, deployment, Pages activation, visibility changes, hosting changes, and DNS remain outside this work.

## Build and dependency readiness

- The repository requires Node.js `>=22.13.0 <23`. Node 22 is also pinned in all GitHub workflows. This avoids an observed Windows Node 24 shutdown assertion after otherwise successful Vinext builds.
- Direct build dependencies were updated to compatible maintained releases. Full and production dependency audits report zero known vulnerabilities, and registry signatures/attestations verify successfully.
- The installed dependency inventory contains no unknown licenses. Most packages are MIT, Apache-2.0, ISC, or BSD licensed; build-only Sharp platform artifacts include their declared LGPL combination.
- LionLog itself intentionally has no license yet. Public visibility permits reading the source but does not grant broad reuse rights. MIT is a reasonable default only if the owner affirmatively wants permissive reuse.

## Static project-site preparation

The manual `Build reviewable GitHub Pages artifact` workflow builds with:

```text
LIONLOG_BASE_PATH=/lionlog
LIONLOG_PUBLIC_ORIGIN=https://crunchybrunch.github.io
```

The resulting artifact has `index.html`, `.nojekyll`, the PWA manifest and icons, service worker, and versioned framework assets at its root. Framework URLs are prefixed with `/lionlog/`; the manifest, service worker, source catalog, and snapshots use mount-relative same-origin URLs. No menu-data publication, source HTML, local cache, source map, credential, or correspondence is included.

Proposed GitHub Pages settings, after the owner intentionally makes the repository public and after a separate deployment workflow is reviewed, are:

- Settings → Pages → Build and deployment → Source: **GitHub Actions**
- Custom domain: **blank**
- Enforce HTTPS: **enabled**
- Expected project-site URL: `https://crunchybrunch.github.io/lionlog/`

The current workflow only retains a reviewable artifact for seven days. It deliberately omits `pages: write`, `id-token: write`, environment configuration, and `actions/deploy-pages`; therefore selecting the Pages source alone will not deploy this branch.

## Verification record

- Clean install: Node `v22.22.0`, npm `10.9.4`, 459 packages installed from the lockfile with scripts disabled.
- TypeScript: `tsc --noEmit` passed.
- Production builds: root and `/lionlog/` static exports passed; each prerendered two routes with zero skipped routes.
- Automated tests: 55 passed, 0 failed. Tests use sanitized deterministic fixtures and did not contact PSU.
- ESLint: passed with zero warnings or errors.
- Dependency audits: full audit 0 vulnerabilities; production-only audit 0 vulnerabilities. The final audit found and then removed one newly published high-severity transitive Browserslist advisory before these results were recorded.
- Supply chain: 458 registry signatures and 106 attestations verified.
- Dependency tree: `npm ls --all --json` exited 0. npm reports three Windows Sharp optional-platform artifacts as extraneous (`@img/sharp-wasm32` and its two support packages); they are lockfile-managed optional install output, not imported application dependencies or audit findings.
- Static artifact: 24 files; `index.html` and `.nojekyll` present; no `menu-data/`, source maps, raw HTML, credentials, correspondence, or local cache.
- Browser bundle: zero matches for PSU POST fields, ingestion guards, retriever/parser/pacing identifiers, or Node filesystem/crypto imports. The normalized snapshot contracts and public PSU attribution/source links are intentionally present.
- Browser checks: root and `/lionlog/` builds loaded online, explicit sample/live switching did not blend modes, server-stop reloads restored the application shell, and the unavailable state remained honest. Browser console logs contained zero warnings or errors.
- Mobile check: at an iPhone-sized `390 × 844` viewport, rendered content stayed within the 375 CSS-pixel content width with no horizontal overflow.
- Privacy scans: zero secret-pattern matches in the current publishable tree or branch/tag/remote history; zero tracked cache, live menu publication, environment, key, archive, log, or source-map files; eight tracked sanitized PSU HTML fixtures.

## Manual owner actions

1. Review and merge the public-release-readiness PR if its checks pass.
2. Decide whether to add a project license. Do not infer a license from public visibility.
3. Optionally change future Git author email to the GitHub `noreply` address.
4. In GitHub Settings → General → Danger Zone, change repository visibility from Private to Public only when ready.
5. Run the manual review-artifact workflow on the resulting `main` and inspect its retained artifact.
6. In a separate reviewed change, add a least-privilege GitHub Pages deployment workflow if deployment is desired.
7. Only after that review, choose the Pages settings above and perform the first intentional deployment.

## Deferred

Deployment, GitHub Pages activation, repository visibility changes, DNS/custom domains, production scheduling, live publication cadence, optimizer work, accounts, diary, and analytics remain deferred.
