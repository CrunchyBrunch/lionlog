# Manual GitHub Pages deployment handoff

Date: 2026-09-01  
Expected project URL: `https://crunchybrunch.github.io/lionlog/`

## Current state

The repository contains a least-privilege, manual-only workflow at `.github/workflows/deploy-github-pages.yml`. The workflow was introduced in commit `bb46104e4bb222e2f01c638f9a148f8d7dd6e337`. It has not been dispatched, GitHub Pages has not been activated by this change, and no deployment has occurred.

The separate review-artifact boundary was proven at commit `6858a885f12484e5843daaf68de6c14fbd61d424` by GitHub Actions run `33567755269`. The downloaded tar had SHA-256 `F3A9EF4DA047856D18FAEFFB35084267EBB007EF7D719CBC0207813C43B9CA43`. It retained `.nojekyll`, project-prefixed framework and self-hosted font URLs, and no menu publication.

## Workflow safety boundary

- Trigger: `workflow_dispatch` only. There is no `push`, pull-request, or cron trigger.
- Repository/ref guard: only `CrunchyBrunch/lionlog` on `refs/heads/main` can run its jobs.
- Default permissions: none.
- Build job permission: `contents: read` only.
- Deploy job permissions: `pages: write` and `id-token: write` only.
- The deploy job waits for the validated build artifact and targets the protected `github-pages` environment.
- Official actions are pinned to immutable commit SHAs.
- The workflow contains no PSU ingestion command, ingestion authorization variable, schedule, DNS operation, custom-domain file, Pages-settings mutation, or repository-visibility mutation.
- The artifact validator rejects menu data, source maps, raw ingestion/browser retrieval code, secrets, private-key patterns, local paths, hidden files other than the empty `.nojekyll`, and same-origin root paths that would break `/lionlog/` hosting.

The workflow publishes only the application shell. Publishing live menu snapshots and choosing a retrieval cadence are separate, explicitly authorized operational milestones.

## Owner activation checklist

Do not perform these steps until the deployment PR is reviewed and merged and its exact resulting `main` SHA is recorded.

1. Confirm `main` contains the reviewed workflow commit and all required checks pass.
2. Run **Build reviewable GitHub Pages artifact** manually on `main`; download and inspect `github-pages-review` before enabling deployment.
3. In **Settings → Pages**, select **GitHub Actions** as the build/deployment source.
4. Leave **Custom domain** blank and enable **Enforce HTTPS**.
5. Optionally configure required reviewers on the `github-pages` environment for a human approval gate.
6. From the Actions tab, select **Deploy GitHub Pages (manual)**, choose `main`, verify the displayed commit SHA, and dispatch it intentionally.
7. Verify the resulting deployment reports `https://crunchybrunch.github.io/lionlog/`, then perform the iPhone/PWA checklist in `docs/iphone-pwa-verification.md`.

Selecting GitHub Actions as the Pages source does not itself run this workflow. No automated deployment or ingestion is introduced.

## Rollback

For an application regression, revert the offending change on `main` through the normal reviewed Git process, verify the restored tree with the review-artifact workflow, and manually dispatch the deployment workflow at the new revert commit. Do not rewrite shared history or deploy an unreviewed branch.

For an urgent publication stop, an owner may disable Pages in repository settings. That is a separate administrative action; the workflow does not change settings itself. Restoring a prior deployment does not restore or publish menu data because menu publication is outside this artifact.

## License and scope

The public repository still has no project license. Public visibility and Pages publication do not grant general reuse rights; choosing a license remains an explicit owner decision.

This handoff does not authorize scheduled ingestion, production menu publication, optimizer work, accounts, diary, analytics, custom domains, DNS, repository visibility changes, or Sites deployment.
