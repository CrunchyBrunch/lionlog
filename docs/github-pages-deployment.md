# Manual GitHub Pages deployment handoff

Date: 2026-09-17
Expected project URL: `https://crunchybrunch.github.io/lionlog/`

## Supported architecture

The manual production workflow uses GitHub's supported Pages actions:

validated retained candidate → `actions/upload-pages-artifact` → protected `github-pages` approval → `actions/deploy-pages` → exact public inventory and mobile/offline verification → one flat retained receipt.

LionLog does not create Pages deployments, request OIDC tokens, or poll Pages status itself. Those responsibilities belong to the pinned official action. The removed custom adapter, deployment ledgers, partial-approval tokens, and automatic first-release recovery are not part of this workflow. A Project Manager approval still has an exact digest-bound expiry; the workflow requires 30 minutes of headroom before staging and 15 minutes immediately before submission.

## Safety boundary

- `workflow_dispatch` is the only trigger; there is no push, pull-request, or schedule trigger.
- Top-level permissions are `{}`. Validation and public verification have only `contents: read` and `actions: read`. Only the protected deploy job receives `pages: write` and `id-token: write`.
- The workflow runs only for `CrunchyBrunch/lionlog`, `refs/heads/main`, and attempt 1, at an operator-supplied exact workflow SHA. Its shared production lock is exactly `github-pages-production` with cancellation disabled; operators must let any run using the predecessor lock finish before merging this lock-name migration.
- Candidate run, artifact, wrapper digest, manifest digest, release ID, source SHA, service date, exact-source CI, expiry, freshness/retention, complete inventory, catalog/snapshots, marker, and `/lionlog/` paths are revalidated.
- The official staged artifact has the unique name `lionlog-pages-<run>-<attempt>`, is uploaded once without overwrite, then downloaded again by numeric ID. Its wrapper digest and every tar path, size, and hash must match the approved candidate.
- The authorization binds either the exact currently published release ID or the explicit `NONE_FIRST_PUBLICATION` sentinel. The public marker is checked before staging and re-observed after protected approval.
- The protected job repeats main, run, CI, candidate, artifact, staged-artifact, approval-expiry, freshness/retention, public-predecessor, and attempt-specific unresolved-submission checks after human approval and immediately before the official deploy action. GitHub cannot make a shell check and the later action-internal HTTP submission one atomic operation, so a stopped or ambiguous action remains unresolved rather than being inferred safe.
- Promotion never builds, runs candidate code, contacts PSU, changes Pages settings, modifies DNS, or changes repository visibility.
- A successful official action is not enough for `knownGood`: the exact public marker and full inventory must match, and a 390×844 Chrome check must render an approved non-empty hall/date/meal snapshot with the exact shell revision, item count, and first item online and after a service-worker-backed offline reload. Sample fallback, console warnings/errors, and horizontal overflow fail verification.

Official actions are pinned to immutable commits:

- `actions/upload-pages-artifact` v5: `fc324d3547104276b827a68afc52ff2a11cc49c9`
- `actions/deploy-pages` v5: `368f82528645a54fb793d4d04e342629a3f51346`

## Operation

Do not dispatch until the workflow is reviewed, merged, exact-source CI succeeds, the candidate remains retained, and a human has reviewed the candidate receipt and inventory.

Promotion inputs identify one exact fresh live candidate, exact public predecessor, and approval deadline. Rollback uses the same workflow and exact retained candidate bytes, plus the flat receipt artifact ID/digest from a prior fully verified `knownGood` deployment. Rollback never rebuilds or re-scrapes. Automated first-release recovery is intentionally absent; a first-release incident requires a separately reviewed change and authorization. Candidate construction still retains the existing first-release recovery artifact as reviewed recovery material, but the supported deployment workflow neither consumes nor promotes it automatically; removing that candidate-build artifact is deferred to a separately scoped change.

The `github-pages` environment must restrict deployment to `main` and require reviewer approval. GitHub Pages must separately be configured to use GitHub Actions. Workflow YAML does not create or attest those settings.

## Failed and uncertain attempts

The workflow never retries a deployment. History collection uses bounded, attempt-specific run/job and uniquely named receipt evidence. Only an exact fully verified `knownGood` attempt or an affirmative final-gate failure whose submission boundary and deploy step were both skipped clears automatically. Cancellation, interruption, missing evidence, incomplete jobs, and ambiguous multi-attempt history remain unresolved and block a later submission. A source-reviewed incident-history entry is required to resolve historical uncertainty from authoritative evidence.

Legacy run `35221481720` is reconciled once in `infrastructure/publication/pages-incident-history.json` as `resolved-unknown-no-publication`: retained evidence did not establish a completed publication and the public marker remained absent. The record preserves uncertainty and does not infer non-submission merely from missing custom-ledger data.

## Scope

This handoff does not authorize a workflow dispatch, environment approval, deployment, ingestion, schedule, GitHub Pages/settings change, DNS/hosting change, repository visibility change, or optimizer work.
