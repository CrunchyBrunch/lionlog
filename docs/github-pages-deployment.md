# Manual GitHub Pages deployment handoff

Date: 2026-09-09
Expected project URL: `https://crunchybrunch.github.io/lionlog/`

## Current state

The repository contains a manual-only production publication workflow at `.github/workflows/deploy-github-pages.yml`. Its first protected promotion attempt on September 11, 2026 failed at the final manifest boundary. The immutable job record shows the separately named Pages adapter step was skipped, so that job did not enter LionLog's OIDC/Pages adapter; the retained receipt remains conservatively `submission-uncertain`. The exact bounded incident record, reconciliation tuple, automatic environment-deployment relationship, and next-attempt prerequisites are in the [production publication runbook](psu-live-menu/production-publication-runbook.md).

The separate review-artifact boundary was proven at commit `6858a885f12484e5843daaf68de6c14fbd61d424` by GitHub Actions run `33567755269`. The downloaded tar had SHA-256 `F3A9EF4DA047856D18FAEFFB35084267EBB007EF7D719CBC0207813C43B9CA43`. It retained `.nojekyll`, project-prefixed framework and self-hosted font URLs, and no menu publication.

## Workflow safety boundary

- Trigger: `workflow_dispatch` only. There is no `push`, pull-request, or cron trigger.
- Repository/ref guard: only `CrunchyBrunch/lionlog` on `refs/heads/main` can run its jobs.
- Default permissions: none.
- Verification job permissions: `contents: read`, `actions: read`, and `deployments: read`.
- Protected deploy job permissions: `contents: read`, `actions: read`, `deployments: write`, `pages: write`, and `id-token: write`.
- Receipt collector permissions: `contents: read`, `actions: read`, and `deployments: write`; public-product requests are anonymous.
- The deploy job waits for the validated build artifact and targets the protected `github-pages` environment.
- Official actions are pinned to immutable commit SHAs.
- The workflow contains no PSU ingestion command, ingestion authorization variable, schedule, DNS operation, custom-domain file, Pages-settings mutation, or repository-visibility mutation.
- The artifact validator rejects raw HTML, source maps, browser retrieval code, secrets, private-key patterns, local paths, hidden files other than the empty `.nojekyll`, and same-origin root paths that would break `/lionlog/` hosting. A live candidate may contain only validated normalized public menu JSON covered by its versioned manifest.

Candidate ingestion and publication remain separate explicit manual operations. The promotion workflow never contacts PSU and never rebuilds candidate bytes.

## Owner activation checklist

Do not perform these steps until the deployment PR is reviewed and merged and its exact resulting `main` SHA is recorded.

1. Confirm `main` contains the reviewed workflow commit and all required checks pass.
2. Run **Build reviewable GitHub Pages artifact** manually on `main`; download and inspect `github-pages-review` before enabling deployment.
3. In **Settings → Pages**, select **GitHub Actions** as the build/deployment source.
4. Leave **Custom domain** blank and enable **Enforce HTTPS**.
5. Optionally configure required reviewers on the `github-pages` environment for a human approval gate.
6. From the Actions tab, select **Promote exact LionLog release to GitHub Pages**, choose `main`, verify every candidate/current-attempt/rollback-target identity and deadline, and dispatch it intentionally.
7. Verify the resulting deployment reports `https://crunchybrunch.github.io/lionlog/`, then perform the iPhone/PWA checklist in `docs/iphone-pwa-verification.md`.

Selecting GitHub Actions as the Pages source does not itself run this workflow. No automated deployment or ingestion is introduced.

## Rollback

For a publication regression, use the runbook's exact-byte rollback path with the latest attempt receipt and a separately identified known-good target receipt. Do not rebuild, re-scrape, rewrite shared history, or deploy an unreviewed branch.

For an urgent publication stop, an owner may disable Pages in repository settings. That is a separate administrative action; the workflow does not change settings itself. Restoring a prior live release restores its exact normalized menu snapshot bytes; retained data still displays according to its original freshness and retention deadlines.

## License and scope

The public repository still has no project license. Public visibility and Pages publication do not grant general reuse rights; choosing a license remains an explicit owner decision.

This handoff does not authorize scheduled ingestion, production menu publication, optimizer work, accounts, diary, analytics, custom domains, DNS, repository visibility changes, or Sites deployment.
