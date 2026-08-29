# PSU source-to-LionLog field mapping

This mapping describes the authorized public-menu proof-of-concept adapter. “Gap” means the current domain contract must change before `PsuMenuProvider` is implemented. Unknown or unavailable upstream values must not be guessed.

## Query and dining context

| PSU source | LionLog target | Rule | Gap / validation |
| --- | --- | --- | --- |
| `selCampus` option value | `DiningHall.id` | Namespace as `psu:campus:<value>`; keep raw value in provenance | Accept only configured University Park values `11`, `17`, `14`, `13`, `16` |
| `selCampus` option label | `DiningHall.displayName` | Map configured official label to LionLog's non-branded concise label | Response must echo the requested campus; do not trust position |
| Campus | `DiningHall.timeZone` | `America/New_York` for audited University Park halls | Configuration, not scraped inference |
| `selMenuDate` | `MenuQuery.serviceDate` | Convert ISO `YYYY-MM-DD` to accepted source format for POST; return ISO | Validate calendar date in hall timezone and verify selected response value |
| `selMeal` | `MealPeriod.id` | Namespace normalized exact value, e.g. `psu:meal:late-night` | Enum: Breakfast, Lunch, Dinner, Late Night |
| `selMeal` label | `MealPeriod.displayName` | Preserve official display text | Missing option is not the same as empty menu |
| Category heading | `DiningVenue.displayName` | Plain text, entity-decoded once, Unicode/whitespace normalized | 1–100 characters; no markup |
| Category heading + campus | `DiningVenue.id` | `psu:campus:<id>:category:v1:<hash(normalized exact heading)>` | DOM `dailyMenuCategoryN` is positional and rejected |
| Category ordering | Menu grouping/order metadata | Preserve response order for display | Current contract lacks explicit station/category grouping and order metadata |

The source calls these group headings categories; LionLog's current `DiningVenue` is the closest boundary concept. Product copy should use “station/category” until Penn State confirms the semantic distinction.

## Menu item and identity

| PSU source | LionLog target | Rule | Gap / validation |
| --- | --- | --- | --- |
| Nutrition link text | `FoodItem.name` | Extract text only; normalize whitespace; retain meaningful punctuation/case | 1–160 characters; reject markup/control characters |
| Nutrition `mid` query value | source observation provenance | Digits only; construct allowlisted official source URL | Do not expose as canonical food ID |
| Query + category + `mid` + occurrence | `MenuItem.id` | `psu:observation:v1:<sha256(canonical fields)>` | Stable for the same observed menu occurrence, not promised across dates |
| Nutrition profile fields | `FoodItem.id` | Use the observation ID for now | Current contract implies a reusable food identity that upstream cannot guarantee; do not silently merge |
| Category ID | `MenuItem.venueId` | Reference derived hall-scoped category ID | Required |
| Requested/echoed date | `MenuItem.availability.serviceDate` | ISO date | Must equal validated response context |
| Requested/echoed meal | `MenuItem.availability.mealPeriodId` | Reference configured meal ID | Must equal validated response context |
| Item position | source observation metadata | Preserve category-local occurrence index | Needed to disambiguate duplicate `mid`/links if upstream ever emits them |

A separate `profileFingerprint` may hash normalized name, exact serving label, nutrition including nulls, dietary/allergen values, and optional ingredients. It supports change detection only. It must not be used for automatic cross-date identity or selection carryover.

## Serving and primary nutrition

| PSU source | LionLog target | Rule | Gap / validation |
| --- | --- | --- | --- |
| `Serving Size 1 EACH` | `Serving.sourceQuantity` | Parse the leading locale-invariant number only when unambiguous | Reject/flag labels without a parseable quantity; retain original label |
| Same field | `Serving.sourceUnit` | Preserve normalized source token/text, e.g. `EACH`, `SERVG` | No semantic replacement with ounces |
| Same field | `Serving.displayLabel` | Preserve normalized complete label, e.g. `1 EACH` | Plain text only |
| No exposed gram weight | `Serving.gramWeight` | Omit | Never derive from name/unit |
| No source portion constraints | `Serving.minimum`, `maximum`, `increment` | Not mapped | Required current fields are a contract gap; move to a separate product-approved portion policy or make optional |
| Calories | `Nutrition.calories` | Parse finite nonnegative number; preserve source precision if present | Source dash maps to `null`, so current required `number` is a gap |
| Protein | `Nutrition.proteinG` | Parse number from source `g` value | Dash -> `null`; reject unexpected unit for this field |
| Total Carbohydrate | `Nutrition.carbsG` | Parse number from source `g` value | Dash -> `null` |
| Total Fat | `Nutrition.fatG` | Parse number from source `g` value | Dash -> `null` |

Numeric parsing must not round source values at the provider boundary. Presentation may round visually while retaining the validated value.

## Additional nutrition, dietary, and allergen metadata

| PSU source | Proposed target | Rule |
| --- | --- | --- |
| Saturated Fat / Trans Fat | `nutrition.details` typed values | Preserve value and `g` unit; null for dash |
| Cholesterol / Sodium | `nutrition.details` | Preserve value and `mg` unit |
| Dietary Fiber / Sugars / Added Sugars | `nutrition.details` | Preserve value and `g` unit |
| Vitamin D | `nutrition.details` | Preserve value and `mcg` unit |
| Calcium / Iron / Potassium | `nutrition.details` | Preserve value and `mg` unit |
| Dietary marker alt text | typed `dietaryTraits` | Map exact allowlisted phrases to `vegan`, `meatless`, `gluten-friendly`, `halal-friendly`, `contains-pork` |
| Allergen paragraph | typed `containsAllergens` | Split known comma-separated labels into normalized enums; retain unknown plain text in a warning field for review |
| Ingredients paragraph | optional `ingredientsText` | Extract normalized plain text only if approved for the next milestone; never HTML |
| Shared-kitchen/fryer/bakery notes | source-level safety notice | Link/summarize the official warning rather than duplicating it per item |

The current `FoodItem.tags?: string[]` cannot distinguish dietary suitability, contains-pork, allergens, and parser warnings. Replace it with typed metadata while retaining `tags` only for backward-compatible sample demonstrations if necessary.

Absence of an allergen label is not a claim that an item is allergen-free. Model `containsAllergens` separately from an explicit source review status, and always surface the shared-kitchen cross-contact warning.

## Source and freshness

| PSU / adapter value | LionLog target | Rule | Gap |
| --- | --- | --- | --- |
| Adapter state | `MenuSource` | `live`, `cached`, `stale`, `unavailable`; `sample` remains mock-only | Current `mode` allows only `sample`/`live` |
| Adapter clock | `MenuSource.retrievedAt` | ISO 8601 UTC instant when upstream bytes were obtained | Existing optional field should become required for non-sample data |
| Validation clock | proposed `validatedAt` | ISO 8601 UTC instant | New field |
| Official menu URL | proposed `sourceMenuUrl` | Fixed HTTPS URL or allowlisted link for selected context | New field |
| Nutrition URL | proposed item provenance | Constructed official URL with digits-only `mid` | New field |
| Cache age | proposed `cacheAgeSeconds` | Adapter-computed nonnegative integer | New field |
| Schema/parser versions | envelope | Exact version strings | New boundary envelope |
| Human label | `MenuSource.label` | State-specific, e.g. “Penn State menu · cached 8 min ago” | Must never imply official affiliation |

## Empty, partial, and invalid values

- A valid page with a recognized context and explicit no-menu/zero-item state maps to an empty `Menu` in `live` or `cached` state.
- Missing sentinels, unexpected selected context, an HTML sign-in/error page, or a parse anomaly maps to a failed fetch, never an empty menu.
- If any item lacks required identity/name/category/link structure, reject that item and mark the snapshot partial. Do not publish a newly fetched snapshot when the accepted-item ratio or required nutrition coverage falls below the policy threshold.
- Missing macros remain null. The recommendation engine must exclude incomplete profiles or explicitly operate under a product-approved rule; it must never treat missing as zero.
