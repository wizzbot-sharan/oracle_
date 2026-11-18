# Repeatable card detection and filling: implementation plan

Status: proposed; implementation awaits operator approval. This document is the only new change in this planning step.

Evidence and selector inventory: [oracle-repeatable-dom-reference.md](oracle-repeatable-dom-reference.md).

## Objective and scope

Make scanner and filler agree on repeatable group identity, existing cards, active editors, controls, and actions. Support Experience and Education in either timeline or ordinary profile-item layouts; support Skills, Licenses, Certifications, and Languages in profile-item layouts and retain explicit support for genuine drawers/dialogs where encountered.

Group meaning and visual layout are independent. A combined Licenses and Certificates section can be one physical group, not two targets to fill twice. Aliases such as Prior Employment and Work Experience must retain their underlying stored group identity.

Only the six operator-approved group categories enter card-based handling: Experience, Education, Skills, Licenses, Certifications, and Languages. Links remain link inputs. Unrecognized Add controls are recorded as unsupported rather than automatically treated as repeatable records.

Keep name, address, county, phone, broad question-bank/resolution redesign, URL deduplication, and submission redesign outside this change. Preserve the operator's established rules for those areas. No job submission is part of validation.

## Required behavior

| Situation | Outcome |
| --- | --- |
| At least one existing saved card in target group | Preserve the whole group; no Add, edit, or delete |
| Existing card has missing title or invalid marker | Preserve it; report its validity separately; do not mistake it for an empty group |
| No saved cards, candidate records available | Open correct editor, fill available facts, save each intended record, verify persistence |
| No saved cards, required facts/records missing | Explicit unresolved/failure outcome; no fabricated defaults |
| Optional empty group without records | Explicit optional skip |
| Group belongs to another page | Defer until its page is active; final traversal must account for expected groups |
| Group/editor ownership ambiguous | Explicit diagnostic; no whole-page fallback |
| Save rejected or editor remains open | Failure with field errors; do not mark group verified |
| Retry after at least one record was previously saved | Preserve existing group under the same one-card rule; log the earlier partial result |

Checking for cards happens before clicking Add and before requiring candidate rows for that group. Once this run starts filling an initially empty group, newly added cards must not prematurely stop the remaining rows in that same operation. Preserve existing record caps (currently 3 experience, 2 education, 5 other) for this scoped change and log intended, saved, and capped counts explicitly.

## 1. Introduce one shared repeatable module

Proposed location: `src/adapters/oracle/repeatable-controls.js`. Keep browser-specific layout logic here rather than duplicating it across scanner and filler.

Small caller-facing interface:

- Discover recognized groups on the active page.
- Inspect an identified group's cards and current editor state.
- Scan a group's field schema with guaranteed cancel/cleanup.
- Fill an identified group and return structured, verified outcomes.

Internally support timeline, profile-inline, and genuine dialog/drawer adapters. Each adapter owns group-scoped card selectors, opener, field root, action root, save/cancel controls, and lifecycle waits. Reuse existing ordinary control filling where suitable, but pass an explicit active-editor scope through text, checkbox, radio, phone-like, and combobox paths; prevent special cases from reverting to page-wide locators.

Do not automatically select the first matching region or dialog when more than one qualifies. Bind an editor to the group/action that opened it. Clear diagnostics must distinguish absent group, hidden group, existing cards, open editor, ambiguous scope, and unsupported layout.

## 2. Persist a versioned group descriptor

Extend template groups additively with:

- Existing group ID and canonical category, including aliases/combined groups.
- Page/step and owning region/block identity.
- Observed layout and descriptor version.
- Portable hints for opener, card scope, editor field root, editor action root, save and cancel.
- Fields scoped to this group, their semantic meaning, type, required state, dependencies, and options/options-discovery mode.
- Date identity plus month/day/year component.
- Scan completeness and unsupported-control diagnostics.

Descriptors contain serializable hints, not Playwright locators, DOM handles, candidate data, timestamp IDs, or generated numeric suffixes. Runtime must re-identify and validate live elements in the candidate session; scan-session layout/source IDs are hints, not authority.

Update `flattenTemplateFields` so this metadata survives flattening. Keep established group IDs and field-ID aliases where existing application answers depend on them. Do not erase historical templates or applications.

## 3. Fix Phase 2 scanning

1. Discover approved groups using their owning region, Add controls, and observed DOM structure.
2. Establish group-specific card count and editor state before opening anything.
3. Click the group's Add action and wait for its actual editor and controls to become ready.
4. Extract controls from that editor, not a page-wide before/after difference.
5. Inspect dropdown options and radio/pill choices. Use each live combobox's `aria-controls` to bind its popup even when mounted outside the editor. For remote search controls, record lookup behavior and partial/unknown option completeness rather than claiming a full enumeration.
6. Explore applicable dependent controls (for example Current Job affecting End Date, country affecting subordinate controls, or renewal choices). Use bounded exploration and wait for observable DOM readiness.
7. Cancel in `finally`, wait for the active editor to disappear, and verify the pre-scan card state has been restored. In profile-inline forms, cancellation must remove any provisional item created by Add.
8. If cleanup fails, stop traversal and mark scan incomplete; do not proceed into another group with an active editor.

Scanner never fills candidate identity, saves records, or clicks application Submit. Any structural option toggles are confined to the dummy scan session and undone by cancellation. Do not click an existing card to edit it just to obtain a schema.

## 4. Fix group-specific card detection

- Timeline: target timeline plus its experiences or educations column; never choose by left/right position alone.
- Profile-inline: target named region/block plus its profile-item container and card list. Education/Experience use this adapter when rendered as ordinary cards.
- Skills/Licenses/Certifications/Languages: resolve their own region and card list; support singular/plural and combined labels. Profile-inline discovery must support both tile-profile-items and unique-tile-profile-items blocks using their shared structure rather than requiring a single outer modifier class.
- Genuine drawer layouts: obtain cards from the owning group before opening the editor.
- Deduplicate article/summary representations of one card.
- Distinguish saved cards from active provisional items using editor lifecycle and before/after observations, not title text alone.
- Retain invalid markers as diagnostics. Existing invalid cards are preserved but do not become a false verified result.
- Remove broad `.apply-flow-section` and whole-document card fallbacks.

Group inspection must still work when an Add button is hidden because the group already has a card or cannot accept another item.

## 5. Fix repeatable filling and record mapping

1. Reach the group's active page and inspect its saved cards before reading/validating candidate rows.
2. Preserve the group when any existing saved card is found.
3. For an empty group, validate available candidate records against its scanned fields and required conditions.
4. Open the correct editor, fail immediately if it is not ready, and re-extract live controls so numeric instance changes do not matter.
5. Resolve each child using group meaning + semantic field + control component. Prefer exact normalized row keys; accept supported raw/normalized aliases. Validate actual candidate-record shapes used by the three pillars before implementing mapping.
6. Select Current Job and other dependency controls in dependency order, re-inspecting controls that become enabled/hidden. Do not fill End Date for a current job unless Oracle actually requires it under that state.
7. Fill month/day/year independently even when they share an HTML name. Use the specific date component, never a union containing broad `[name=...]` followed by `.first()`.
8. Locate checkbox/radio controls within the editor and select through their accessible labels or associated visible controls. Bind dropdown options to the initiating combobox.
9. Save via the editor's dedicated action root. Profile-item footers can be siblings of the field container; timeline opener and saver can share the same text, so text alone is insufficient.
10. Wait for validation settlement, editor closure, and a new saved card in the target group. Verify the new summary against available identifying facts where exposed; retain field-readback evidence for facts not shown in a card. A click or timeout being swallowed is never success.
11. Re-identify the opener/editor for subsequent rows and return planned/saved counts plus per-row outcomes. Stop on failure, record partial saves, and avoid adding duplicates on retry.

Correct License/Certificate mapping so `contentItemId` does not imply Education. Handle candidate skill/license/certification facts explicitly. Missing degree, major, GPA, certificate name, country, or dates must not be invented by the repeatable mapper. If a required group lacks source records, surface it rather than ask a generic field resolver to fabricate a record.

Languages use the same profile-inline adapter, with group-specific mapping: `contentItemId` means language, and Reading/Writing/Speaking are separate proficiency fields. Scan the actual available options (High/Medium/Low Proficiency in the supplied example) and map only supported candidate facts. Do not infer proficiency from a language merely appearing in resume text, default all levels to Fluent/High Proficiency, or interpret the language selector as a degree. Leave unknown optional levels empty and surface unknown required levels. Respect actual unique-item restrictions; do not add duplicate candidate language rows.

The Languages example creates a provisional `Unnamed Language` tile on opening Add, then reuses the same tile ID after saving. Verify closure, removal of active/invalid state, and the expected saved title; do not require a new tile ID or a count increase relative to the already-open editor. Compare against the state before Add.

## 6. Integrate readiness, outcomes, and legacy templates

- Route both the flattened-field path and the dedicated repeatable-group loop through the same module exactly once per group.
- Exclude controls inside an active repeatable editor from ordinary page-level filling.
- Keep links on their separate input path, including legacy templates that store them under repeatable groups; preserve existing answer IDs.
- Inspect existing cards even if no candidate row array is available. Do not skip inspection at `if (!answer.length)` before seeing the actual group.
- Keep Phase 3's data-readiness assessment distinct from live Oracle card state. A group-only unresolved application can use an explicit live preflight on a manual preparation attempt; it must not be labeled fully answered or automatically queued solely because unknown cards might exist. Ordinary unresolved required fields continue to block preparation.
- During Phase 4, defer record-required validation until after card inspection for that group. Empty required groups without adequate records fail clearly; existing cards satisfy the preserve policy without inventing candidate rows.
- For existing invalid cards, return preserved-with-validation-issue and keep the application not ready; do not edit/delete them.
- Return explicit preserved-existing, added-and-verified, skipped-optional, deferred, unsupported, and failed outcomes with group identity, observed layout, counts, and reasons. Map these consistently into existing application statuses and fill results; only unresolved/invalid outcomes block readiness.
- Add bounded diagnostic evidence on failure: group/layout, editor state, field semantic key, scoped locator strategies, visible validation errors, and screenshot path. Avoid logging sensitive candidate answers unnecessarily.
- Legacy descriptors receive safe live discovery; if ownership cannot be resolved, return rescan-required rather than guessing. Rescan only selected job keys and use existing versioning. Changed field schemas require scoped answer re-resolution, not blind reuse of old mappings.

## 7. Verification and rollout

Create minimal browser fixtures representing the supplied DOM structures, preserving their significant attributes and state transitions. Exercise the same module interface used by production callers, with actual Playwright DOM behavior rather than selector-only mocks.

| Coverage | Expected assertion |
| --- | --- |
| Experience and Education, each layout, empty/prefilled | Correct adapter; preserve existing or add as appropriate |
| Shared timeline with Experience card and empty Education | Education remains empty until its own fill; no cross-group preservation |
| Profile Education/Experience beside License/Skills | No unrelated cards/fields/actions selected |
| Unnamed existing card; invalid existing card | Preserve both; report invalidity separately |
| Add hidden with existing cards | Existing group still detected and preserved |
| Provisional profile tile after Add | Not accepted as successful saving |
| Changed generated IDs and timestamp IDs | Same fields/actions still found |
| Shared date names with distinct components | Month/day/year receive their intended values |
| Current Job and cascading dropdowns | Hidden/disabled controls respected; correct popup ownership |
| License contentItemId beside education degree | Group-specific facts; no degree/default leakage |
| Languages in a unique-tile-profile-items block | Same profile-inline adapter; correctly scoped language dropdown and three proficiency groups |
| Language/License/Education sharing contentItemId | Group-specific meanings; no cross-group selection or answer leakage |
| Language tile reuses its provisional ID after saving | Pre-Add baseline, editor closure, settled validity, and title establish saving |
| Language with unknown proficiency and duplicate candidate rows | No invented levels; optional blanks respected; duplicate languages not added |
| Multiple rows, row cap, partial failure, retry | Correct counts; no premature stop or duplicate creation |
| Missing required data, optional absent data | Explicit failure versus optional skip |
| Save validation error; slow editor opening/closing | No false success; bounded waits and useful diagnostics |
| Scanner Cancel after provisional item | Original cards restored; no lingering editor |
| Old template and links | Safe discovery/aliases or rescan-required; links use input handling |
| Flattened and dedicated fill paths | One group operation only |
| Required group with existing card and no candidate rows | Manual live preflight preserves group; unrelated unresolved fields still block |

Run focused regressions, then `npm test` and require zero failures with exact pass counts. If frontend code becomes necessary, run `npm run build`. No schema migration is planned; if that changes, apply repository migration verification requirements.

After fixture checks, validate selected job keys in fill-only mode: capture scan cleanup, group decisions, per-row outcomes, and final review screenshots. Keep submission dry-run enabled. Report separately what fixtures prove and what selected live sessions confirm. No claims that every Oracle tenant is covered without representative evidence.

## Delivery sequence

1. Shared group discovery + card inspection with cross-group regression fixtures.
2. Scanner/editor descriptor support and cancellation verification.
3. Group-scoped filling, dates, mappings, and save persistence verification.
4. Caller/readiness/legacy integration, complete regression suite, selected fill-only live checks.

Each step should be reviewable independently; do not enable a partially integrated production path. Implementation starts only after approval of this plan.
