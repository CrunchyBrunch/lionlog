# Dispatcher PEM recovery handoff

The one-time `ProvisionPem.gs` execution on November 17, 2026 signed with Google's utility and read back the exact multiline PKCS#8 key. A later Project Settings save to delete the temporary staging property stripped the line breaks from the target property. The sanitized observation is `work/nov17-provisioner/result.json` outside the tracked source. The original provisioner requires a flattened PKCS#1 target and must not be rerun against the current flattened PKCS#8 target.

This document prepares an independently reviewed recovery. It does not authorize a hosted edit, execution, probe, token exchange, dispatch, activation, or credential change. Keep the dispatcher activation off, the existing `INERT_PROBE_POST_ATTEMPT` marker and daily claims intact, and the monitor alerts running. Hosted execution requires separate owner approval after review.

## Prepare for the separate approved recovery

1. On an owner-controlled machine, use the **same** dispatcher App key as the successful November 17 signing check. Independently confirm its public-key fingerprint. Do not put the key in source, a shell transcript, a test fixture, or an execution log.
2. Preserve the unencrypted PKCS#8 PEM line breaks and JSON-encode the PEM as one string. Stage that single-line JSON value in the temporary Script Property `LIONLOG_APP_PRIVATE_KEY_PEM_STAGED_JSON`; it must fit the 9 KB property-value limit. Do not edit the target property in Project Settings. Because a Project Settings save can strip multiline target values, verify the current target again after staging and stop if it differs from the staged PEM with only line breaks removed.
3. Add the independently reviewed `dispatcher/RecoverPem.gs` to the same Apps Script project. Add no trigger. Review the exact source and confirm inactive dispatch, the existing attempt marker, and the intended property names before any separately approved execution.

## One recovery execution

After separate owner approval, run `recoverLionLogDispatcherPem` manually once. It holds the script lock, requires inactive dispatch, parses the staged JSON as multiline PKCS#8, and requires the current target to equal that exact PEM with only line breaks removed. It asks Google's RSA signer to accept the key before any mutation. It then writes the multiline PEM once, requires exact readback, deletes **only** the temporary staging property with `PropertiesService.deleteProperty`, and verifies both the target and staging absence. It makes no network request and touches no activation, marker, day claim, trigger, or unrelated property.

If execution stops **before key write**, inspect the retained properties and source before deciding any next action. Any failure after a write or deletion attempt is an **uncertain outcome**, even if one property appears correct. Do not retry, clear the attempt marker, or start a probe. Obtain separate read-only verification and a new recovery decision. The utility emits only fixed, secret-safe errors and never logs the key, signature, property value, or raw exception.

After verified success, remove the one-time utility from the hosted project under the separately authorized staging change. Do not use Project Settings Save to remove or edit a property after the multiline target is restored; the utility already deletes the temporary property programmatically. Preserve the reconciled November 14 attempt marker until the owner performs its separately authorized claim cleanup. No probe or manual promotion follows from PEM recovery alone.
