# Publication checkpoint App writer handoff

This code is an inactive implementation proposal. It requires an owner-approved App, protected production pin, state rulesets, a genuine known-good promotion, and live readback before activation. The October 20 package remains the historical baseline; its personal-token writer instructions are superseded by this handoff.

## Owner configuration and server boundary

Register a dedicated GitHub App and install it only on `CrunchyBrunch/lionlog`. Grant repository Contents read/write, Actions read, and implicit Metadata read; grant no Administration or Workflows write. Set `LIONLOG_PUBLICATION_APP_CLIENT_ID` to its client ID and `LIONLOG_PUBLICATION_WRITER_ID` to the numeric ID of `<app-slug>[bot]`. Put `LIONLOG_PUBLICATION_APP_PRIVATE_KEY` only in the `lionlog-publication-writer` environment, restricted to the immutable approved production branch. Do not place the private key in a repository secret or source file. The workflows mint a short-lived token scoped to this repository and those two permissions after entering that environment.

Create the zero-parent empty-tree state root and state ref under separate authorization. Then apply and read back **two active exact-branch rulesets** for `refs/heads/lionlog-publication-state` before the seed:

1. An `update` rule with `update_allows_fetch_and_merge=false`, whose sole bypass actor is the dedicated App's actual numeric **App ID** (`actor_type=Integration`, `bypass_mode=always`). The App ID differs from the bot user ID and client ID.
2. `required_signatures`, `non_fast_forward`, and `deletion` rules with no bypass actors. The App must still append a signed, ordinary commit; it cannot bypass these invariants.

Keep the production-branch freeze and branch-gated environment from the activation package. Contents write is repository scoped, so verify the protections on `main` and the production branch too. Read back the exact target, enforcement, rules, bypass actors, and root SHA. Neither the code nor an offline test proves GitHub accepted or enforces these settings.

## One-time seed and activation gate

After the reviewed reconciliation and one fresh candidate plus protected manual promotion produce a terminal `knownGood` receipt and complete public inventory, dispatch `bootstrap-publication-checkpoint.yml` once on the approved production ref. The protected manual promotion run comes from `main` at the exact SHA pinned for the bootstrap job on the production ref; these are distinct workflow branches with the same approved source revision. Supply its exact promotion run ID, production/source SHA, and approved empty root SHA. Activation must still be absent. The workflow checks the pinned bootstrap ref/SHA, the completed manual promotion run, and promotion artifact IDs/digests, mints the App token, recollects complete history and public bytes, then calls `createCommitOnBranch` with the expected root and exactly `checkpoint.json`, `receipt.json`, and `manifest.json`. It reads back the signed one-parent App-bot commit, exact files, unchanged state ref, and public proof.

Before enabling the daily route, independently verify the actual GraphQL App-token behavior in this repository: the seed's author is the approved bot user ID, the committer is a positive GitHub identity, `verification.verified=true`, and the App can bypass only the update gate while the no-bypass signature/force/delete rules remain enforced. If GitHub rejects the mutation or attribution differs, stop and review the exact response; do not loosen the loader or ruleset to make the seed pass. Confirm all other activation gates, then set `LIONLOG_REFRESH_ACTIVATION` last.

The later `advance-refresh-checkpoint.yml` uses the same App identity and environment, recollects the exact terminal run and public release, appends with an expected-head comparison, and rereads the new checkpoint. A built-in `GITHUB_TOKEN` remains read-only in these jobs and is not a substitute for this App writer.
