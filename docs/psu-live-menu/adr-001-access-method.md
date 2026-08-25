# ADR 001: Permission-gated same-origin PSU menu adapter

- Status: accepted architecture; production data access blocked pending Penn State authorization
- Date: 2026-08-25
- Decision scope: `v0.2.0-alpha.1` design only

## Context

LionLog needs official menu and nutrition data without coupling UI code to an upstream page. The official daily menu uses a POSTed, server-rendered HTML form and item-specific HTML nutrition pages. The responses do not allow CORS reads from `lionlog.app`. No supported structured API was discovered. The source host's root `robots.txt` disallows all crawling.

## Decision

Retain `MenuProvider` as the application boundary. If and only if Penn State authorizes access or supplies a supported feed, implement a narrow same-origin route and a `PsuMenuProvider` that consumes validated LionLog JSON from that route.

The adapter will prefer the approved source in this order:

1. supported Penn State structured API/feed;
2. approved scheduled/bulk export;
3. authorized HTML retrieval with strict parsing, coalescing, caching, and rate limits.

Direct browser scraping is rejected. An unofficial API is rejected as the production source. Automated HTML retrieval before permission is rejected.

## Proposed request flow

```text
LionLog UI
  -> PsuMenuProvider
  -> same-origin /api/menus/v1 route
  -> cache + rate limiter + validation
  -> approved official Penn State source

On any upstream or parse failure:
  -> validated last-known-good snapshot
  -> explicit stale state
  -> unavailable state if no safe snapshot exists
```

The route returns data only; it never forwards or embeds upstream HTML. `MockMenuProvider` remains available for deterministic tests, demonstrations, and the permission-blocked product state.

## Boundary contract shape

The future adapter response should be an additive, versioned envelope. Names are illustrative design, not implementation in this milestone.

```ts
interface MenuEnvelopeV1 {
  schemaVersion: "lionlog.menu.v1";
  parserVersion: string;
  state: "live" | "cached" | "stale" | "unavailable";
  query: MenuQuery;
  menu: Menu | null;
  provenance: {
    sourceName: "Penn State Campus Dining";
    sourceMenuUrl: string;
    retrievedAt: string;
    validatedAt: string;
    cacheAgeSeconds: number;
  };
  warning?: { code: string; message: string };
}
```

`sample` remains a provider state produced locally by `MockMenuProvider`; the PSU adapter must never label fallback sample content as cached/live PSU data.

Before implementation, evolve the domain contracts identified in `field-mapping.md`: nullable unavailable nutrient values, typed source state/provenance, allergen metadata, category provenance, and removal or separation of invented portion constraints.

## Security and sanitization

- Allowlist the upstream HTTPS host and exact paths; reject redirects outside that origin/path family.
- Construct POST bodies from validated ISO dates, fixed meal enums, and known campus IDs only.
- Accept only `text/html` for an authorized HTML source and enforce response byte/time limits.
- Parse with a server-side HTML parser. Extract text nodes/attributes only; decode entities once, normalize Unicode/whitespace, strip controls, and enforce field lengths.
- Construct source URLs from validated numeric `mid` values. Never accept arbitrary upstream URLs.
- Allowlist dietary/allergen vocabulary while recording unknown values as validation warnings.
- Never return raw HTML, inline event handlers, scripts, styles, or untrusted markup. The UI renders ordinary React text nodes and links.
- Validate the final JSON envelope again at the provider boundary before domain mapping.

## Consequences

### Benefits

- Works with browser same-origin rules.
- Centralizes permission controls, caching, rate limiting, parsing, validation, observability, and failure handling.
- Keeps the existing provider boundary and pure domain logic.
- Can switch from authorized HTML to a future official API without rewriting UI orchestration.
- Supports explicit freshness and offline behavior.

### Costs and risks

- A server route is operationally more complex than a static mock provider.
- Authorized HTML parsing is brittle and potentially request-heavy.
- A structured/bulk official source may require coordination not controlled by this repository.
- Live-provider work cannot start until the Admin task clears the permission gate and approves any resulting terms.

## Rejected alternatives

- **Cross-origin client fetch:** responses lack CORS allow headers.
- **Client-side HTML scraping through navigation/iframes:** unreliable, unsafe, not readable across origins, and contrary to the provider boundary.
- **Unofficial scraper/API:** adds an untrusted dependency and does not solve permission, provenance, or data-quality concerns.
- **Treating `mid` or normalized name as canonical food ID:** neither is documented; observed duplicate names have materially different nutrition.
- **Inventing ounce/gram conversions:** the source serving units do not provide a supported conversion.

## Permission gate acceptance

The ADR can advance to implementation only when the Admin task records:

- written Penn State permission or an approved feed/API;
- permitted fields, attribution wording, cache duration, request rate, and redistribution scope;
- a source owner/escalation contact; and
- confirmation that the use does not imply Penn State sponsorship.

If Penn State declines or does not answer, the live-provider milestone remains blocked and LionLog continues with clearly labeled sample data.
