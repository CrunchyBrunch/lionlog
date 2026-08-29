# Caching, validation, attribution, and failure policy

Penn State Residential Dining approved LionLog's use of publicly available dining-menu information in August 2026. This policy governs the resulting bounded proof of concept. The approval did not grant official/private API access or scheduled production scraping; any later source-specific terms or rate guidance override the provisional values below.

## Fetch and cache policy

Use one adapter cache key per `schemaVersion + campus + ISO service date + meal`. Coalesce concurrent misses for the same key. Never fetch upstream directly from the client.

Provisional TTLs:

| Source record | Fresh TTL | Stale-while-revalidate | Last-known-good retention |
| --- | ---: | ---: | ---: |
| Current-day menu | 5 minutes | 15 minutes | 48 hours |
| Future menu | 30 minutes | 2 hours | Through service date + 48 hours |
| Past menu | 24 hours | none | 7 days |
| Nutrition observation by authorized source handle | 24 hours or source-approved duration | 24 hours | Service date + 7 days |

If HTML is the approved source, a menu cache refresh must not automatically refetch every unchanged nutrition observation. Reuse a validated detail record only when its source handle and profile validation metadata match the current observation. Prefer a PSU bulk feed because per-item pages create an N+1 request pattern.

Provisional upstream limits for an authorized HTML source:

- maximum two in-flight upstream requests globally per adapter instance;
- sustained rate no faster than one request per second, with jitter;
- exponential backoff for `429`, `503`, timeouts, and connection failures;
- honor `Retry-After` exactly;
- no retries for structural validation failures;
- bounded response size (menu 1 MiB, nutrition 256 KiB unless observed authorized limits require less) and 10-second timeout;
- circuit opens after three consecutive upstream/structural failures for a source route, then probes no more than once per 15 minutes.

These are conservative ceilings for manually triggered proof-of-concept ingestion. If PSU specifies stricter limits or withdraws approval, use the stricter limit or stop retrieval.

## Provider states

| State | Meaning | UI behavior |
| --- | --- | --- |
| `live` | Validated bytes were fetched from the official source for this response and remain within fresh TTL | Show source and retrieval time |
| `cached` | Validated adapter/browser snapshot remains within fresh TTL | Show source, retrieval time, and “cached” without warning styling |
| `stale` | Fresh fetch failed or the cached TTL expired, but a validated last-known-good snapshot remains within retention | Show prominent age/warning and official-source link; never call it today's confirmed menu |
| `sample` | Deterministic `MockMenuProvider` data | Keep current “not live PSU data” labeling; never blend with official items |
| `unavailable` | No validated authorized source or acceptable last-known-good snapshot exists | Show unavailable state and official menu link; do not silently substitute sample data |

An offline client stores the last successful validated envelope in IndexedDB (or an equivalently explicit application store) keyed by query. The existing service worker continues to own the app shell; it must not blindly cache `/api/` responses. On offline lookup, the provider revalidates the stored envelope version and presents it as `cached` or `stale` according to age. A different origin has a different browser store.

## Validation policy

Validate twice: after upstream parsing in the adapter and after JSON receipt in `PsuMenuProvider`.

### Transport and context sentinels

- HTTPS final origin and path match the allowlist; no external redirect.
- `200` and expected content type.
- Response is under size/time limits.
- Menu form contains the expected field names and the selected campus/date/meal matches the request.
- Page contains recognized menu/no-menu structure, not merely status `200`.
- Nutrition page has a digits-only requested handle, a recipe title, serving section, and recognized facts structure.

### Data validation

- Exact envelope/schema version and supported parser version.
- Strict enums for state, meal, configured campus, dietary traits, and known allergen values.
- ISO date/instant parsing with normalized UTC timestamps.
- Finite nonnegative nutrients; expected units; null for unavailable.
- Plain-text length/control-character limits.
- Unique observation IDs and valid category references.
- Maximum 100 categories and 1,000 items per response; exceeding a bound is a structural failure, not truncation.
- Source URLs reconstruct to the official allowlisted HTTPS origin/path.
- Raw HTML is not a field anywhere in the envelope.

### Snapshot acceptance

A newly fetched menu is publishable only when all required context sentinels pass, every published item passes core validation, and at least 95% of nutrition-linked items have valid required primary fields. The exact threshold should be confirmed against a permissioned test corpus. Below threshold, keep the prior last-known-good snapshot and emit a structural alert.

Do not overwrite last-known-good data with an invalid, partial-below-threshold, empty-but-unverified, or error response. Store a checksum and validation report beside each accepted snapshot.

## Change and outage detection

Record privacy-preserving operational metrics only; do not add user analytics:

- upstream status/latency/bytes by route;
- cache outcome and coalesced-request count;
- parser/schema version;
- categories/items discovered, valid, rejected, and nutrition-complete;
- unknown dietary/allergen labels;
- structural-sentinel failures and content checksum changes; and
- snapshot age/state served.

Alert/disable new ingestion on any of the following:

- two consecutive structural failures for the same route/query class;
- response context not matching request;
- more than 5% item validation failure;
- unknown category/item markup eliminating required selectors;
- unexpected redirect/origin/content type;
- new robots/terms restriction or withdrawal of permission; or
- source owner requests suspension.

Use a small authorized canary set spanning one populated menu, one empty/unavailable meal, and representative nutrition values. Run it at the lowest approved frequency, not as a crawler. Parser changes require reviewed sanitized fixtures and a new `parserVersion` before release.

## Attribution and safety copy

Place source/freshness adjacent to the menu, not only in a footer. Recommended copy:

> Menu and nutrition data sourced from Penn State Campus Dining. Updated {time}. View the official menu. LionLog is independent and is not affiliated with or endorsed by Penn State.

For stale data, prefix:

> Live data is unavailable. Showing a saved menu from {time}; items may have changed.

For dietary/allergen surfaces, include a concise warning and link to Penn State's [current allergies and special-diets guidance](https://liveon.psu.edu/allergies-special-diets):

> Ingredients and preparation can change, and shared kitchens create cross-contact risk. Verify the official source and ask dining staff; LionLog is not medical advice.

Use the official source name in text and a normal link. Do not copy Penn State logos, use official marks, or imply endorsement. Link each menu snapshot to the daily menu and each item detail to its allowlisted nutrition URL when available.

## Failure matrix

| Failure | Adapter action | User-visible result |
| --- | --- | --- |
| Timeout, network error, `429`, `5xx` | Back off; retain last-known-good | `stale` if retained snapshot is eligible, otherwise `unavailable` |
| `4xx` other than `429` | No retry; alert configuration/permission owner | `stale`/`unavailable` |
| Redirect outside allowlist | Reject; open circuit; security alert | `stale`/`unavailable` |
| Context mismatch or missing form sentinels | Reject as source change | `stale`/`unavailable` |
| Confirmed valid empty menu | Cache short-lived empty result | `live`/`cached` empty state, not error |
| Some invalid items but threshold passes | Publish valid items with partial-data warning; retain report | State plus explicit partial warning |
| Nutrition missing/dash | Preserve null; exclude from macro recommendation | Item may display “nutrition unavailable” |
| Stored envelope version unsupported | Ignore local snapshot | `unavailable` offline; sample only by explicit user/demo choice |
| Permission withdrawn / robots or terms tighten | Stop all automated fetches immediately | `stale` until retention expires, then `unavailable`; retain mock demo |

## Data minimization and retention

Cache only public menu/nutrition fields and operational validation metadata. Store no accounts, user selections, credentials, or tracking identifiers. Expire last-known-good records on the schedule above and allow an operator to purge a source snapshot if Penn State requests removal.
