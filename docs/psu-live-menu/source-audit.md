# Official Penn State menu source audit

Audit date: 2026-08-25

Scope: public University Park residential menu and nutrition data needed by LionLog

Decision owner: LionLog Admin; this audit is technical evidence, not legal advice

## Executive finding

The official source is Penn State Campus Dining's [Daily Menu](https://www.absecom.psu.edu/menus/user-pages/daily-menu.cfm). The legacy official URL `https://menu.hfs.psu.edu/` currently redirects to that page. Penn State describes FoodPro as the system behind its recipes, menus, nutrition, and allergen database in [its FoodPro overview](https://www.psu.edu/news/campus-life/story/whats-menu-foodpro-software-helps-feed-thousands-students) and [Registered Dietitian's Office description](https://www.abs.psu.edu/registered-dietitians-office).

No documented or page-discoverable structured menu API was found. The audited page is a server-rendered ColdFusion HTML form, and each item links to a server-rendered nutrition-label page. The response does not permit cross-origin browser reads. Direct client access is therefore not viable.

At the time of the audit, [`https://www.absecom.psu.edu/robots.txt`](https://www.absecom.psu.edu/robots.txt) returned `User-agent: *` and `Disallow: /`. The audit therefore treated automated retrieval as blocked pending direct authorization. That was the correct August 25, 2026 conclusion based on the evidence then available.

## Authorization update — August 2026

Penn State Residential Dining subsequently approved LionLog's use of publicly available dining-menu information in August 2026. The approval clears the permission gate for the bounded public-HTML ingestion proof of concept described by this repository.

The approval did **not** provide, promise, or endorse access to an official or private Penn State API. LionLog must continue to describe the source accurately as publicly available Penn State dining-menu HTML, use conservative centralized retrieval, and avoid implying that LionLog is official or endorsed. This repository records only the authorization outcome; it does not contain correspondence or personal contact information.

## Independent implementation reconciliation — August 31, 2026

An independent working implementation corroborated the ColdFusion POST-and-parse approach as an implementation lead. A bounded manual check on August 31 confirmed that LionLog's existing adapter sends `selMenuDate` in `M/D/YY` form, `selCampus`, and the selected `#selMeal` option value, and that the response echoes the selected date, campus, and meal. The populated East/Lunch response still exposed `.menu-category-section`, `.daily-menu-item`, `a.daily-menu-item__link`, and `.daily-menu-item__icons img[alt]`. The representative nutrition page did not expose the suggested `.nutrition-category-title`; it retained the existing `.recipe-title` sentinel, so LionLog did not tighten its parser to that presentation-only lead.

The independent report's once-or-twice-daily refresh suggestion is recorded only as a provisional future operational cadence. This reconciliation adds no cron, scheduled Action, deployment, or production retrieval. LionLog does not use an official PSU API: its architecture centralizes conservative retrieval and validation into cached snapshots rather than contacting PSU from the frontend, intentionally differing from frontend-only implementations.

## Reproducible observations

The observations below were made with isolated GET, POST, and OPTIONS requests on 2026-08-25. They are a point-in-time audit; upstream behavior can change.

| Check | Observation |
| --- | --- |
| Daily menu GET | `200`, `text/html; charset=UTF-8`; no `Access-Control-Allow-Origin`, `ETag`, `Last-Modified`, or `Cache-Control` response value observed |
| Daily menu form | `<form ... action="daily-menu.cfm" method="post">` |
| Form fields | `selMenuDate`, `selMeal`, `selCampus` |
| Example accepted POST | URL-encoded `selMenuDate=8/25/26&selMeal=Lunch&selCampus=11` returned a populated HTML menu |
| Nutrition GET | `nutrition-label.cfm?mid=217886294` returned `200`, HTML, and no CORS/cache validator headers |
| CORS GET probe | `Origin: https://lionlog.app` received no CORS allow headers on menu or nutrition responses |
| CORS OPTIONS probe | `200`, but no `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, or `Access-Control-Allow-Headers` |
| Robots | Host-root `robots.txt` returned `User-agent: *` / `Disallow: /`; `/menus/robots.txt` returned `404` and does not override the root policy |
| Rendering model | Menu items and nutrition facts were present in returned HTML; no menu JSON, embedded structured payload, or menu XHR/fetch endpoint was found in the page or its first-party scripts |

The absence of CORS allow headers means browser JavaScript cannot read these cross-origin responses, even though an ordinary HTML form navigation can submit to the page. A same-origin Sites server route would be technically required unless Penn State provides a CORS-enabled API.

## Verified form vocabulary

### University Park locations

| `selCampus` | Official option label | Proposed LionLog hall label |
| --- | --- | --- |
| `11` | UP: East Food District @ Findlay | East / Findlay |
| `17` | UP: North Food District @ Warnock | North / Warnock |
| `14` | UP: Pollock Dining Commons | Pollock |
| `13` | UP: South Food District @ Redifer | South / Redifer |
| `16` | UP: West Food District @ Waring | West / Waring |

These numeric values are upstream location selectors, not LionLog-owned identifiers. Preserve them as source references and namespace public IDs.

### Dates and meals

The page offered the audit date plus the following six dates. Date option values used short US form such as `8/25/26`; the adapter must format from an ISO service date in the hall timezone (`America/New_York`) and must verify the selected date echoed by the response.

Meal options observed were `Breakfast`, `Lunch`, `Dinner`, and `Late Night`. An option's presence does not prove a populated menu for every hall/date. Empty results must be distinguished from parse failure.

### Categories and menu items

The response groups items in `<details class="menu-category-section">` sections. Examples included `ENTREES`, `VEGETABLES/STARCHES`, `PURE`, `GRILLERS`, and `ITALIAN`. These are the closest available source concept to LionLog's current `DiningVenue`; no stable category ID was exposed. DOM IDs such as `dailyMenuCategory1` are positional presentation IDs and must not be persisted.

Each item is a text link like `nutrition-label.cfm?mid=217886294`. The menu also exposes plain-text dietary markers through image alternative text:

- `Vegan`
- `Meatless`
- `Gluten Friendly - made w/o gluten-containing items`
- `Halal Friendly`
- `Contains Pork`

Penn State's [allergen and menu-card announcement](https://www.psu.edu/news/campus-life/story/new-menu-item-cards-allergen-icons-help-students-navigate-campus-dining) and [current allergies guidance](https://liveon.psu.edu/allergies-special-diets) corroborate those markers and the major-allergen vocabulary.

## Nutrition-page fields

The audited nutrition page exposed:

- recipe display name;
- source serving label, for example `1 EACH` or `1 SERVG`;
- calories;
- total fat, saturated fat, trans fat;
- cholesterol and sodium;
- total carbohydrate, dietary fiber, sugars, and added sugars;
- protein;
- vitamin D, calcium, iron, and potassium;
- ingredients as plain text;
- a comma-separated allergen list when present; and
- shared-kitchen, fryer, bakery, and allergy-contact notes.

A dash represents an unavailable nutrient. It must map to `null`/unavailable, never zero. Units must be retained exactly as reported after whitespace normalization. The source did not expose a gram weight or a supported conversion from `EACH`/`SERVG` to ounces.

Observed allergen values included `Dairy`, `Eggs`, `Soy`, and `Wheat/Gluten`. Penn State's public guidance lists the top nine as dairy, egg, fish, shellfish, peanuts, tree nuts, soy, wheat/gluten, and sesame. The adapter must allowlist this vocabulary while preserving an unknown value for review rather than silently dropping it.

## Identifier finding

`mid` is an undocumented nutrition-link handle, not a documented canonical food ID. The audit found two `Margherita Pizza` entries in the same East/Lunch response:

| `mid` | Serving | Calories | Fat | Carbohydrate | Protein |
| --- | --- | ---: | ---: | ---: | ---: |
| `217886320` | `1 SERVG` | 323 | 13.1 g | 36.1 g | 16.3 g |
| `217886321` | `1 SERVG` | 2587 | 104.4 g | 288.8 g | 130 g |

The same name and serving label therefore do not identify one nutritional food profile. Conversely, the audit found no guarantee that one recipe will retain a `mid` on another date. LionLog must model source observations, not invent a cross-date canonical food identity.

Recommended keys:

1. `menuObservationId`: hash of schema version, source host, campus ID, ISO service date, meal value, normalized category text, source `mid`, and occurrence index. This is the identity presented by one menu observation.
2. `profileFingerprint`: hash of normalized name, exact serving label, macro values including nulls, ordered allergen/dietary values, and (if retained) normalized ingredients. This is a change/deduplication signal only, never identity.
3. Do not automatically carry a user's selection across menu refreshes unless the observation still exists. An exact fingerprint match may be offered for explicit review, not silently rebound.

## Structured-source search

The audit searched Penn State's public API documentation/catalog results, inspected the official menu form and scripts, checked the redirected legacy menu origin, and reviewed adjacent official FoodPro/dining resources. No supported menu JSON, GraphQL, XML, CSV, or documented FoodPro API was found. This finding means “none discovered,” not proof that no internal or partner API exists.

The first request to Penn State should ask for one of the following, in order:

1. a documented, supported menu/nutrition feed or API with stable identifiers and permitted cache/reuse terms;
2. a scheduled export or bulk endpoint that avoids one nutrition request per menu item; or
3. written permission and explicit rate guidance for the public HTML endpoints.

Public organizational contact links exposed by the official pages are not required by the ingestion pipeline. No credentials, correspondence, or personal contact information is stored in this repository.

## Permission, attribution, and safety risk

- **Dated permission history:** the root robots policy created a material uncertainty on August 25, 2026. Penn State Residential Dining's later August 2026 approval resolved that uncertainty for LionLog's use of publicly available dining-menu information, but did not grant private/API access.
- **No express data license found:** the audited menu footer links Penn State's Web Privacy Statement and accessibility statement, but no menu-data reuse license or API terms were located.
- **Load risk:** HTML-only access creates an N+1 pattern (one menu page plus a nutrition page per item). Do not run this at production scale without an approved bulk source or explicit rate limits.
- **Accuracy risk:** menus, recipes, and on-site preparation can change. Penn State explicitly warns about shared-kitchen cross contact. LionLog must not present dietary markers as medical guarantees.
- **Brand risk:** use plain-text source attribution and links only. Do not use Penn State marks, official-looking trade dress, or language implying affiliation or endorsement.

The approval supports a manually triggered, conservative ingestion proof of concept. It does not authorize scheduled production scraping or change the requirement to retain the clearly labeled `MockMenuProvider`.
