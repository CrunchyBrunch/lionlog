# LionLog v0.2 production publication runbook

Date: 2026-09-08
Status: implementation boundary; no Pages site or deployment is created by this document or by merging the implementation.

LionLog publishes normalized public PSU menu data as a static project-site PWA. LionLog is independent and is not affiliated with or endorsed by Penn State. It does not use an official or private PSU API. Only the manually dispatched candidate workflow contacts PSU; browsers, CI, builds, promotion, rollback, and app opens do not.

## Trust boundary

Publication has four distinct gates:

1. An owner authorizes one first-attempt candidate run on an exact `main` SHA and service date.
2. The producer ingests, validates, builds, inventories, packages, and retains immutable live and first-release recovery candidates. It cannot deploy.
3. An owner reviews the exact artifact ID, GitHub artifact digest, release-manifest digest, expiry, service date, versions, coverage, omissions, and inventory, then dispatches promotion with a time-bounded approval tuple.
4. An unprivileged job independently derives menu-policy evidence from the catalog and every snapshot, validates the exact recovery relationship, and stages exact bytes. The protected `github-pages` environment then gates a separate job holding `pages: write` and `id-token: write`. After all bounded downloads, that job immediately rechecks main, the numeric producer and CI workflow identities, approval time, freshness, current production receipt/deployment, and artifact retention before requesting OIDC and submitting exactly one Pages deployment request.

The promotion workflow never ingests, builds, runs package scripts from the candidate, or executes candidate contents. It downloads by numeric artifact ID, normalizes the upload-action and API SHA-256 representations before fatal comparison, validates ZIP central/local headers and regular-file metadata before extraction, allows only `release-manifest.json` and `site.tar`, parses the bounded ustar archive without following links, and rejects case-colliding paths before any write. It validates the extracted static site, catalog, and snapshots.

## Repository settings required before the first deployment

An administrator must perform these settings separately:

- Protect `main`: require the CI `verify` check and reviewed changes; prohibit force pushes and deletion.
- Create the `github-pages` environment, restrict it to `main`, add required reviewer approval, and disable administrator bypass. Prevent self-review when a second authorized reviewer exists.
- Configure Pages to use GitHub Actions, leave the custom domain blank, and use HTTPS.

Workflow YAML does not create or enforce these repository settings. The expected URL is `https://crunchybrunch.github.io/lionlog/`.

## Candidate preparation

Dispatch `build-live-menu-artifact.yml` from `main` with:

- `service_date`: strict `YYYY-MM-DD`;
- `expected_source_sha`: the exact lowercase 40-character `main` SHA;
- `expected_run_attempt`: `1`;
- `confirmation`: `PREPARE_LIVE_PAGES_FIELD_RELEASE`.

Never rerun a candidate workflow attempt. A new attempt requires a new dispatch and authorization. Wait for required CI on the same source SHA before promotion.

The producer retains three artifacts for up to 90 days, subject to repository policy and early deletion:

- an immutable live bundle;
- an app-only first-release recovery bundle from the same source, with no menu data;
- external receipts recording candidate artifact IDs, wrapper digests, manifest digests, release IDs, sizes, provenance, and exact expiry.

The live manifest records repository identity, numeric producer workflow ID/path/run/attempt, source SHA, target origin/base path, shell revision, service and retrieval times, parser/schema versions, coverage and omissions, catalog digest, every site file and hash, the Pages tar digest, and the exact retained recovery artifact ID/digest/manifest/release ID. Its 18-hour freshness and 48-hour retention claims are derived again from validated snapshot bytes. `release.json` inside the site exposes a non-secret release ID, but that marker alone is never treated as a known-good product.

## Promotion approval tuple

Dispatch `deploy-github-pages.yml` from the current `main` only after reviewing the candidate receipt and contents. Every field is required:

- operation: `promote`, `rollback`, or `first-release-recovery`;
- exact producer run ID and attempt `1`;
- exact source artifact ID and `sha256:` GitHub artifact digest;
- exact lowercase release-manifest SHA-256;
- exact candidate source SHA and service date (`NONE` only for first-release recovery);
- exact promotion-workflow SHA;
- exact retained recovery artifact ID, wrapper digest, manifest digest, and release ID;
- exact current public release ID, latest Pages deployment ID, and known-good receipt artifact ID/digest, or `NONE_FIRST_DEPLOYMENT` for all four sentinel fields on the first deployment;
- an ISO approval expiry timestamp;
- coverage approval and expired-rollback approval values described below;
- confirmation: `PROMOTE_EXACT_LIONLOG_RELEASE`.

The approval expires at the supplied timestamp. Changing any artifact, manifest, omission count, operation, current-production identity, or source requires a new approval.

### Coverage and freshness

Complete coverage is the default. Use `COMPLETE_ONLY` for a complete candidate.

A bounded `invalid-name` partial candidate requires direct Project Manager approval of the exact manifest digest and omission count using:

`APPROVE_PARTIAL:<manifest-sha256>:<invalid-name-count>`

This cannot waive missing queries, structural errors, unsupported versions, stale data, integrity failures, or any omission outside the existing bounded policy.

A normal promotion requires every snapshot to retain at least 15 minutes of its original freshness window at the final validation. No timestamp is extended.

Rollback restores exact historical bytes without fetching PSU. An unexpired rollback uses `NONE`. If the selected data has passed its retention limit, direct Project Manager approval must use:

`ALLOW_EXPIRED_ROLLBACK:<manifest-sha256>`

Such a rollback restores the application while the menu correctly appears unavailable. It does not describe expired data as current.

## First deployment

1. Merge the reviewed publication-boundary implementation.
2. Apply the repository and environment settings above.
3. Authorize and run one fresh candidate from that exact main SHA.
4. Verify CI, artifact receipts, inventory, coverage, mobile behavior, `/lionlog/` paths, update behavior, and offline reload locally.
5. Record the live candidate and first-release recovery identities before enabling Pages.
6. Obtain direct authorization to enable Pages with GitHub Actions and to promote the exact live tuple.
7. Dispatch promotion and approve its protected environment job.
8. Require a terminal successful Pages deployment plus anonymous byte-for-byte verification of every manifest inventory file before recording the release as known-good.

Pages accepting a deployment, marker verification, and full public-product verification are distinct receipt fields. The always-run receipt collector records failures and uncertainty; `knownGood` is true only when the exact deployment succeeded and the complete served inventory matched. A first deployment is allowed only when both the public marker is absent and the Pages deployment collection is empty. Its exact app-only recovery candidate must already be retained and bound into the live manifest.

## Rollback and uncertain outcomes

Rollback selects a retained, previously validated candidate by exact ID and digest. It uses the same serialized workflow and protected environment approval as promotion. It never rebuilds or re-scrapes. The public release marker, exact known-good receipt, and latest successful Pages deployment must all identify the approved current production state before replacement. This rejects delayed A-to-B-to-A approvals that cite an older deployment of A.

The deploy adapter writes attempt evidence before submission and updates it immediately when an accepted deployment ID is available. Polling, parse, timeout, and public-verification failures retain an incomplete or uncertain receipt rather than losing the ID or claiming success. If any outcome is uncertain, do not rerun or submit another deployment blindly. Reconcile the Pages deployment collection, deployment ID/status, complete public inventory, workflow run, and retained receipt first. Then obtain a new operation approval if another deployment is necessary.

Rollback authority lasts only while the exact candidate bytes remain retrievable. GitHub artifact expiry or deletion is a hard stop. Keep the current known-good candidate and at least one approved rollback/recovery target; durable archival beyond GitHub's retention window is a later milestone.

Service workers use the source commit as their shell revision. Installation fails if any required offline-startup asset cannot be verified and cached. Activation remains user-controlled. Menu JSON remains outside the service-worker shell cache and inside the versioned, validated IndexedDB store, so updates and rollback preserve honest live, cached, stale, partial, sample, and unavailable states.

## Prohibited shortcuts

Do not select artifacts by mutable name or “latest,” deploy a locally rebuilt site, reuse an expired approval, accept a digest warning, promote a feature-branch artifact, couple ingestion to deployment, or invoke the workflow from CI, pull requests, pushes, schedules, or an app open. Do not place credentials, raw PSU HTML, local caches, correspondence, or personal information in artifacts or receipts.
