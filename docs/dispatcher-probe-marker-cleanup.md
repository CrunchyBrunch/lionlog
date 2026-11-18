# Reconciled November 14 probe marker cleanup

The marker `INERT_PROBE_POST_ATTEMPT=2026-11-14T15:27:59.677Z` corresponds to the successful inert probe in run [43610324125](https://github.com/CrunchyBrunch/lionlog/actions/runs/43610324125), attempt 1, with publication skipped. Admin retained the reconciliation and November 17 PEM recovery evidence in `work/nov14-inert-probe-reconciliation.json` and `work/nov17-recovery/result.json`.

1. After independent review and explicit owner approval for this exact cleanup, confirm the reconciliation, the recovered multiline key, inactive dispatch, and no concurrent probe or Script Properties edits. Add only the reviewed `dispatcher/ClearReconciledProbeMarker.gs` in the Apps Script editor. Keep the probe idle and add no trigger.
2. Manually invoke `clearLionLogReconciledProbeMarker` once. Success means the expected marker was deleted and the PEM matched exactly before and after. Record the execution result and independently verify marker absence, exact multiline key preservation, and inactive gates using read-only checks. Record only redacted results.
3. After verified success, remove only the temporary source in the Apps Script editor. Avoid Project Settings Save throughout. The November 17 incident showed that it can strip the PEM's line breaks even when another property is being edited.

On a predeletion stop, inspect the prerequisites read-only. If the outcome is uncertain, do not retry or run the probe. Reconcile the marker and key read-only and return the result to the owner for a new decision. Keep the execution record and historical evidence. Cleanup approval covers the utility and this one marker. Any later probe requires its own authorization and fresh eligibility checks.
