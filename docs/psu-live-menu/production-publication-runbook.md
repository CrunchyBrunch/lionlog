# LionLog v0.2 production publication runbook

Date: 2026-10-15
Status: daily automation engineering prepared; owner activation and production operations remain pending.

LionLog publishes normalized public PSU menu information as a cached static PWA. LionLog is independent and is not affiliated with or endorsed by Penn State. It does not use an official/private PSU API. Only an explicitly authorized candidate workflow may contact PSU; browsers, builds, CI, promotion, rollback, and app opens do not. The automatic route described below is inactive until owner activation.

## Trust boundary

1. An owner authorizes one first-attempt candidate run for an exact `main` SHA and service date.
2. The producer ingests, validates, inventories, packages, and retains immutable live candidate bytes. It cannot deploy.
3. An owner reviews the exact producer run, artifact ID/digest, manifest digest, release ID, source SHA, service date, expiry, versions, coverage/omissions, and inventory, then dispatches promotion.
4. An unprivileged job independently validates those identities and bytes, extracts the deterministic site, and stages it once with pinned `actions/upload-pages-artifact` under a run/attempt-unique name.
5. The protected `github-pages` environment pauses a separate least-privilege job. After approval, that job rechecks all authority and unresolved-attempt state, then invokes pinned `actions/deploy-pages` as the only submission mechanism.
6. A read-only job verifies the public marker, every inventory file byte-for-byte, and the mobile/PWA online and offline behavior. It retains one flat receipt and marks `knownGood` only when every check passes.

The promotion workflow downloads artifacts only by numeric ID, verifies the GitHub wrapper SHA-256, accepts only the expected wrapper files, rejects links/traversal/case collisions, parses bounded tar data, and validates the extracted static site. It never executes candidate content.

## Permissions and triggers

`deploy-github-pages.yml` has only `workflow_dispatch`, an empty top-level permission set, a serialized non-cancelling production concurrency group, and an attempt-1/repository guard. Its manual path remains restricted to `main`; its inactive automatic path requires an exact production ref and commit. The candidate workflow uses the same concurrency group and has only read permissions.

- Validation/staging: `actions: read`, `contents: read`.
- Protected deploy: `actions: read`, `contents: read`, `pages: write`, `id-token: write`.
- Public verification/receipt: `actions: read`, `contents: read`.

No job has `deployments: write`. LionLog does not request OIDC or call the Pages deployment API itself. The daily scheduler is gated and inert without owner activation. There is no push or pull-request trigger, deployment retry, settings mutation, DNS change, or visibility change.

## Daily automatic route (prepared, inactive)

`daily-publication.yml` schedules 05:17 America/New_York on `main`. Its job is skipped until the owner sets the exact activation, source-authorization, standing-policy, production-pin, and writer-ID variables. The default-branch workflow is a minimal stub: it verifies the production ref, checks out the exact immutable approved SHA, then installs and runs the scheduler from those bytes. The scheduler has only `actions: write` and `contents: read`; it validates the authenticated checkpoint and public predecessor before any PSU candidate dispatch. It dispatches `build-live-menu-artifact.yml` on the pinned production branch/SHA, waits for its exact returned run ID, checks the retained candidate receipt and artifact/manifest digests, then dispatches automatic promotion with the exact identities and a bounded execution deadline. It waits for terminal promotion success and dispatches `advance-refresh-checkpoint.yml` with that exact run ID, then rereads the advanced checkpoint. A missing bootstrap, unknown result, drift, or failed public verification stops the sequence and fails the scheduled run. The scheduler holds a separate concurrency group while candidate, promotion, and checkpoint retain `github-pages-production` serialization.

The native timezone trigger chooses the primary opportunity through 05:46 and its single missed-primary recovery window from 05:47 to 09:59. Authenticated schedule, producer, and promotion history allows a delayed first opportunity but blocks a second same-day opportunity after a failure. The producer's complete run/accounting preflight blocks a duplicate or an unaccounted attempt and caps all upstream attempts at 1,680 for the New York service date. A failed or missing schedule is not automatically replayed. GitHub may delay/drop schedule events or disable the schedule after 60 days of repository inactivity; no exact-time or indefinite-delivery guarantee is claimed. See [daily activation and failure handoff](../daily-publication-activation.md).

Automatic data publication uses `COMPLETE_COVERAGE_V1`: every expected query must be covered and invalid-name omissions must be zero. The candidate validator and final submission gate both enforce it. The automatic `github-pages-automatic` environment is to be configured without a per-run reviewer and restricted to the protected production branch. Manual promotion and rollback retain the reviewed `github-pages` environment. `approval_expires_at` is a short execution deadline under standing policy for automatic promotion, and remains a PM approval expiry for manual promotion. Neither mode bypasses provenance, public inventory, freshness, retention, or unresolved-submission checks. `knownGood` still requires official Pages success and full public verification. A post-submission failure stays unresolved and blocks the next day.

The scheduler has one elapsed three-hour window for evidence reads, workflow dispatch starts, waits, and terminal confirmation. Automatic `approval_expires_at` is capped by the original wall-clock end of that window and the candidate's freshness bound, with the 45-minute predispatch headroom rechecked after the last asynchronous read. A dispatch already in flight when the deadline expires can have an uncertain outcome; it is not retried automatically. Investigate exact run history, public state, and checkpoint state before recovery.

The production ref/SHA, state branch, writer App, environment protections, source authorization, and activation variables have not been provisioned by this change. The checkpoint writer job is bound to the `lionlog-publication-writer` environment; the owner must restrict that environment to the protected production branch and store the dedicated App private key there only. The [App writer handoff](../publication-app-writer.md) defines the two state rulesets and signed seed readback. The October 1 unresolved publication needs truthful reconciliation and a reviewed checkpoint bootstrap first. A single owner-authorized fresh candidate and protected promotion can establish the fully verified `knownGood` receipt for that bootstrap. The original receipt remains `knownGood=false` / `unresolved=true`, and its expired candidate is ineligible for promotion. The owner performs the activation steps in the linked handoff; engineering here makes no production request or deployment.
## Promotion inputs

Every input is required:

- operation: `promote` or `rollback`;
- exact candidate producer run ID;
- exact candidate artifact ID and `sha256:` wrapper digest;
- exact lowercase manifest SHA-256 and release ID;
- exact candidate source SHA and `YYYY-MM-DD` service date;
- exact current main SHA containing the reviewed workflow;
- exact public predecessor release ID, or `NONE_FIRST_PUBLICATION`;
- operator-supplied approval expiry in canonical UTC form with milliseconds;
- for promotion, `NONE` for both rollback-receipt fields;
- for rollback, exact known-good flat-receipt artifact ID and digest;
- confirmation `PROMOTE_EXACT_LIONLOG_RELEASE`.

Coverage and omissions are not encoded as an operator token. They are derived from exact validated bytes and shown in the protected approval summary. The reviewer decides whether to approve that run. A live promotion requires at least 30 minutes of truthful freshness, retention, candidate-artifact availability, and approval validity during preapproval. Rollback does not require freshness, but it must retain the same 30-minute preapproval margins for its applicable bounds and cite a flat receipt that proves the exact bytes were previously known-good.

The operator-supplied approval expiry is part of the digest-bound authorization. Validation writes that exact canonical UTC timestamp into the retained preapproval summary, making the summary's authorization deadline the canonical deadline used by the protected job. Immediately before the supported action, approval validity, retention, artifact availability, and—only for promotion—freshness must each still have at least the 15-minute final action margin. Human approval does not extend any of those bounds.

## Staging and protected approval

The official Pages artifact is named `lionlog-pages-<workflow-run-id>-<attempt>` and retained for 90 days. It has one producer and `overwrite: false`. After upload, the validator:

- resolves the returned numeric artifact ID;
- requires exactly the expected name/run/SHA/repository provenance;
- downloads the wrapper again and verifies its reported digest;
- accepts only `artifact.tar`;
- parses regular files/directories without following links;
- requires the exact approved inventory, including the empty `.nojekyll`, with identical paths, sizes, and hashes.

The protected job downloads the compact preapproval evidence by numeric artifact ID and digest. Immediately before the official deploy action it rechecks authoritative `main`, current workflow/run/attempt, candidate producer, candidate artifact availability/digest/expiry, exact-source CI, unique staged artifact, the summary-bound approval deadline, freshness/retention, and prior attempts. Drift fails before the submission boundary. This pre-action check and GitHub's subsequent `actions/deploy-pages` invocation are sequential workflow steps, not one atomic transaction; the 15-minute final action margin bounds that documented limitation but cannot eliminate it.

## Uncertain attempts and the legacy reconciliation

There is no workflow-level deployment retry. If the official deploy step starts and the run does not finish with official success plus complete public verification, the attempt is unresolved. Another submission is blocked until a source-reviewed incident-history entry resolves it from authoritative evidence. A completed successful workflow is self-resolving because its terminal step requires a `knownGood` receipt.

Legacy attempts `34609219734/1` and `34881025561/1` are reconciled from exact immutable attempt-specific job evidence: each contains an affirmative failed validation boundary and an affirmatively skipped deployment step or job. Altered, incomplete, ambiguous, or mismatched evidence remains blocking. Legacy custom-adapter run `35221481720` at SHA `4a91cda0de93b920607f2aa37163790bb4b662f2` is reconciled separately. Its retained candidate artifact was `10497255246`, staged artifact `10496838181`, and automatic repository environment deployment `6502721175`. Available evidence did not establish a completed publication, and the anonymous public marker remained `404`; the historical outcome is therefore `resolved-unknown-no-publication`, not a claim that a missing custom ledger alone proves Pages was never contacted.

The removed custom OIDC adapter, Pages POST/status polling, repository deployment ledgers, partial-coverage exception tokens, pre-submission exception tokens, and automatic recovery mode must not be reintroduced as a workaround. The current digest-bound canonical approval-expiry contract remains mandatory.

## Public acceptance and receipt

After the official action succeeds, anonymous checks must establish:

- canonical project URL `https://crunchybrunch.github.io/lionlog/`;
- exact `release.json` release identity;
- exact bytes, sizes, and hashes for every manifest inventory path;
- visible source retrieval time and independent/not-endorsed wording;
- 390×844 viewport without horizontal overflow;
- zero console warnings/errors;
- service worker activation and server-independent offline reload of the validated shell/saved menu.

The retained `lionlog.pages-flat-receipt.v1` contains the exact workflow, candidate, CI, release, staged artifact, optional rollback source, official-action result/page URL, and public-check booleans. `knownGood` is true only when submission started, the official action succeeded at the canonical URL, and marker, inventory, and browser checks all passed. Otherwise a started attempt is `unresolved: true`.

## Rollback

Rollback selects an exact retained candidate that a prior flat receipt binds to the same artifact ID/digest, manifest digest, and release ID. It uses the same staging validation, protected approval, official deploy action, and public acceptance checks. It does not rebuild, contact PSU, or silently change menu freshness semantics.

First-release recovery is not automated. If the first supported release fails without a known-good rollback target, stop and prepare a separately reviewed, explicitly authorized response. Do not infer permission to deploy the legacy app-only recovery artifact.

## Prohibited shortcuts

Do not select artifacts by mutable name or “latest,” rerun a workflow attempt, overwrite a staged artifact, deploy locally rebuilt bytes, waive a digest mismatch, extend freshness/retention, infer non-submission from missing local evidence, deploy a feature branch, couple ingestion to deployment, or trigger publication from CI, pull requests, pushes, or an app open. The reviewed daily scheduler may dispatch only the approved pinned workflows after owner activation. Do not publish raw PSU HTML, caches, credentials, correspondence, or personal information.
