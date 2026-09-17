# LionLog v0.2 production publication runbook

Date: 2026-09-17
Status: supported GitHub Pages actions migration under review; no dispatch or deployment is authorized by this document.

LionLog publishes normalized public PSU menu information as a cached static PWA. LionLog is independent and is not affiliated with or endorsed by Penn State. It does not use an official/private PSU API. Only an explicitly authorized manual candidate workflow contacts PSU; browsers, builds, CI, promotion, rollback, and app opens do not.

## Trust boundary

1. An owner authorizes one first-attempt candidate run for an exact `main` SHA and service date.
2. The producer ingests, validates, inventories, packages, and retains immutable live candidate bytes. It cannot deploy.
3. An owner reviews the exact producer run, artifact ID/digest, manifest digest, release ID, source SHA, service date, expiry, versions, coverage/omissions, and inventory, then dispatches promotion.
4. An unprivileged job independently validates those identities and bytes, extracts the deterministic site, and stages it once with pinned `actions/upload-pages-artifact` under a run/attempt-unique name.
5. The protected `github-pages` environment pauses a separate least-privilege job. After approval, that job rechecks all authority and unresolved-attempt state, then invokes pinned `actions/deploy-pages` as the only submission mechanism.
6. A read-only job verifies the public marker, every inventory file byte-for-byte, and the mobile/PWA online and offline behavior. It retains one flat receipt and marks `knownGood` only when every check passes.

The promotion workflow downloads artifacts only by numeric ID, verifies the GitHub wrapper SHA-256, accepts only the expected wrapper files, rejects links/traversal/case collisions, parses bounded tar data, and validates the extracted static site. It never executes candidate content.

## Permissions and triggers

`deploy-github-pages.yml` has only `workflow_dispatch`, an empty top-level permission set, a serialized non-cancelling production concurrency group, and an attempt-1/main/repository guard.

- Validation/staging: `actions: read`, `contents: read`.
- Protected deploy: `actions: read`, `contents: read`, `pages: write`, `id-token: write`.
- Public verification/receipt: `actions: read`, `contents: read`.

No job has `deployments: write`. LionLog does not request OIDC or call the Pages deployment API itself. There is no cron, push, pull-request, PSU access, candidate build, deployment retry, settings mutation, DNS change, or visibility change.

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

Do not select artifacts by mutable name or “latest,” rerun a workflow attempt, overwrite a staged artifact, deploy locally rebuilt bytes, waive a digest mismatch, extend freshness/retention, infer non-submission from missing local evidence, deploy a feature branch, couple ingestion to deployment, or trigger publication from CI, pull requests, pushes, schedules, or an app open. Do not publish raw PSU HTML, caches, credentials, correspondence, or personal information.
