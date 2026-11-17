# One-time dispatcher PEM provisioning

This is an offline staging handoff. It does not authorize a hosted edit or execution. Review the exact `dispatcher/ProvisionPem.gs` commit independently before using it. Keep the dispatcher activation off, the existing inert-probe attempt marker and daily claims intact, and the current monitor alerts running.

## Prepare and stage

1. On an owner-controlled machine, convert the **same** dispatcher App key to unencrypted PKCS#8 PEM and independently confirm that its public-key fingerprint matches the current key. Do not put either key in source, a shell transcript, a test fixture, or an execution log.
2. Preserve the converted PEM's line breaks. Encode that string as one JSON string value, so line breaks appear as JSON escapes in the single-line Project Settings field. Confirm the staged string fits Apps Script's 9 KB property-value limit. Do not use a flattened PEM or a base64-only value.
3. With the dispatcher activation off, add `LIONLOG_APP_PRIVATE_KEY_PEM_STAGED_JSON` as a temporary Script Property in Project Settings. Leave `LIONLOG_APP_PRIVATE_KEY_PEM` and `INERT_PROBE_POST_ATTEMPT` unchanged at this stage.
4. Add the independently reviewed `dispatcher/ProvisionPem.gs` to the same Apps Script project as the reviewed `Code.gs` and `InertProbe.gs`. Add no trigger. Confirm the existing target property is still the original PKCS#1 envelope before running the utility.

## Run once

Run `provisionLionLogDispatcherPem` manually exactly once. The utility holds the script lock, requires inactive dispatch and the original target envelope, parses the staged JSON string into multiline PKCS#8, and calls Google's `Utilities.computeRsaSha256Signature` on a fixed test message **before** writing. It then writes only `LIONLOG_APP_PRIVATE_KEY_PEM` and requires an exact readback. It makes no network request and does not touch activation, the inert-probe marker, day claims, or triggers. A completed execution means the signer call and exact readback both succeeded; it is not an App token exchange or a successful probe.

If execution fails **before key write**, correct the setup only after examining the generic failure and the retained source/target state. If it reports **outcome uncertain**, the write may have succeeded even when the execution failed. Do not run the utility again, clear the attempt marker, or start a probe. Keep the staged property and obtain separate read-only verification of the target against the staged value and of Google's signer before deciding any recovery. The utility never retries and never logs a key, signature, property value, or raw exception.

After verified success, remove the temporary staged property and remove the one-time utility from the hosted project under the authorized staging change. Keep the intended PKCS#8 property. Preserve the reconciled November 14 inert-probe marker until the owner performs its separately authorized claim cleanup. Recheck activation and monitor status before any later approved probe.
