# Oracle repeatable controls: supplied DOM reference

Evidence: operator-supplied Experience timeline, Licenses and Certificates, and Languages HTML in this conversation. Selectors below are candidates grounded in those examples, not verified across all Oracle tenants. No production selectors have been changed.

## Agreed behavior

- Card-based groups: experience, education, skills, licenses, certifications, languages.
- Inspect only cards belonging to the target group before opening its editor.
- If at least one saved card exists, preserve the group without adding or editing records.
- Report an existing invalid card separately; do not treat it as absence or silently claim it is verified.
- A provisional card created when opening an editor does not establish successful saving.
- Supporting links are link inputs, not card-based groups.
- Scanner explores and cancels; filler fills and saves. Both need the same group, editor, field, and action descriptors.

## Layout A: shared Experience / Education timeline

| Purpose | Reusable selector / identity |
| --- | --- |
| Group container | `.timeline-container` containing the target Add button |
| Open experience | `button#timeline-add-experience-button` or exact button name `Add Experience` |
| Open education | `button#timeline-add-education-button` or exact button name `Add Education` |
| Active editor | `timeline-form-inline .standard-apply-flow-timeline-form:visible` within that timeline |
| Editor fields | `timeline-form-builder` within the active editor |
| Save record | `button[data-qa="addTimelineItemDialogButton"]` within the active editor |
| Cancel editor | `button.cancel-btn` within the active editor |
| Experience cards | `.beautiful-timeline__column[data-bind*="foreach: experiences"] [data-profile-item-tile="true"]` |
| Education cards | `.beautiful-timeline__column[data-bind*="foreach: educations"] [data-profile-item-tile="true"]` |
| Card title / subtitle | `.beautiful-timeline-item__title` / `.beautiful-timeline-item__subtitle` |

The left/right columns are visual layout; experiences/educations bindings identify the group. Scope columns to the selected timeline. Do not search the surrounding application section for both groups' cards.

The example's `Unnamed Job Title` card has an employer subtitle and no provided dates. The supplied record can exist without a job title. A title heuristic must not override the operator's preserve-existing-card rule.

## Layout B: inline profile items, demonstrated by License

| Purpose | Reusable selector / identity |
| --- | --- |
| Group boundary | `[role="region"]` identified by normalized accessible name, e.g. `Licenses and Certificates` |
| Group container | `.profile-item-container` within that region |
| Open editor | `button.apply-flow-profile-item-tile__new-tile` with exact group-specific name |
| Active editor | `.profile-item-content:visible` inside that container |
| Editor fields | `.profile-item-content--form form-builder` |
| Editor footer | `.profile-item-footer:visible` within the same container |
| Save record | `button[data-qa="profileItemInlineSaveButton"]` in that footer |
| Cancel editor | `button.cancel-btn` in that footer |
| Cards | `.profile-item-list article.apply-flow-profile-item-tile` |
| Card summary | `.apply-flow-profile-item-tile__summary[data-profile-item-tile="true"]` |
| Active/provisional tile | `.apply-flow-profile-item-tile--active` together with an open editor |
| Invalid marker | `data-profile-item-invalid="true"`, invalid tile class, or visible validation text |

The editor footer is a sibling of `.profile-item-content`, so a field-only root cannot also locate its save button. Retain a group root plus separate field and action roots.

`data-qa="add103"` and `data-qa="profileItem103"` can associate controls within this example, but the numeric code must not be assumed to mean License across tenants. Dynamic timestamp IDs and class suffixes are not portable identifiers.

## Languages: the same profile-inline layout

The supplied Languages block has outer modifier `.apply-flow-block--unique-tile-profile-items`. License has `.apply-flow-block--tile-profile-items`. Their group/editor/card/footer structures are shared, so the profile-inline adapter must not depend exclusively on either modifier.

| Purpose | Reusable identity within Languages |
| --- | --- |
| Group | Region with normalized accessible name `Languages`, then its `.profile-item-container` |
| Opener | Exact button name `Add Language` within the group |
| Active fields | `.profile-item-content:visible form-builder` |
| Language | `[role="combobox"][name="contentItemId"]` |
| Reading | `[role="radiogroup"][aria-label="Reading"]` |
| Writing | `[role="radiogroup"][aria-label="Writing"]` |
| Speaking | `[role="radiogroup"][aria-label="Speaking"]` |
| Save | Group footer's `button[data-qa="profileItemInlineSaveButton"]` |
| Saved cards | Group's `.profile-item-list article.apply-flow-profile-item-tile` |

Reading/Writing/Speaking each expose High, Medium, and Low Proficiency in this example. These are independent facts, not one inferred overall level. Optional unknown levels remain empty; required unknowns are unresolved. A resume mention alone is not evidence of fluency.

`add109`, `profileItem109`, numeric block IDs, and timestamp tile IDs are observed instance metadata, not portable constants. `contentItemId` is shared by Language, License, and Degree fields, so group scope plus semantic label is mandatory.

On Add, a provisional active `Unnamed Language` card appears before any language is selected. On save, that same tile ID becomes a non-active card titled with the selected language (`Achinese` is sample DOM content, not a candidate answer). Verify against the pre-Add baseline and editor lifecycle; a newly generated tile ID is not required for successful save. Cancel must restore the pre-Add state.

## Stable field identities

Within the correct active editor:

- Employer: `input[name="employerName"]`.
- Job title: `input[name="jobTitle"]`.
- Employer city: `input[name="employerCity"]`.
- Responsibilities: `textarea[name="responsibilities"]`; exclude helper textareas.
- Supervisor name/title: `input[name="supervisorName"]`, `input[name="supervisorTitle"]`.
- Current Job: checkbox associated with the `Current Job` label; generated ID fallback `[id^="af-checkbox-currentJobFlag-"]`.
- License/certificate: `[role="combobox"][name="contentItemId"]`; its semantic meaning depends on the group and label, not this shared backend name alone.
- Country: `[role="combobox"][name="countryCode"]`, scoped to the group editor.
- Renewal Required: `[role="radiogroup"][aria-label="Renewal Required"]`, scoped to the group editor.
- Generated field IDs such as `employerName-44` are runtime instances; retain stable name and semantic role instead of suffix `44`.

### Composite dates

Month and year share a `name`. Do not use `[name="startDate"].first()` to locate both components.

| Date | Month control | Year control | Day control |
| --- | --- | --- | --- |
| Start | `input[id^="month-startDate-"]` | `input[id^="year-startDate-"]` | Not present in supplied timeline |
| End | `input[id^="month-endDate-"]` | `input[id^="year-endDate-"]` | Not present in supplied timeline |
| Issue | `input[id^="month-issueDate-"]` | `input[id^="year-issueDate-"]` | `input[id^="day-issueDate-"]` |
| Expiration | `input[id^="month-expirationDate-"]` | `input[id^="year-expirationDate-"]` | `input[id^="day-expirationDate-"]` |

Retain date identity plus component (month/day/year). Read each live combobox's `aria-controls` for its popup rather than reusing a scan-session listbox ID. Popups can be outside the editor and must be associated with their trigger.

## Current implementation findings

- `#scanRepeatableGroups` clicks Add and extracts a page-wide before/after field difference, then cancels. It does not retain inline layout/editor/save/card descriptors and disables combobox option expansion.
- Scanner dynamic Add discovery is broader than the approved card-based categories and treats supporting links as a repeatable group.
- `#fillRepeatableGroup` assumes `.apply-flow-drawer:visible, [role="dialog"]:visible`. Neither supplied inline editor has these markers. Its failed editor wait is swallowed before child field filling continues inside the nonexistent root.
- `#inspectExistingRepeatableCards` includes broad application-section roots and falls back to the whole document. Education can therefore detect Experience cards; Skills has no dedicated root branch.
- Existing card logic filters out cards considered invalid, including `Unnamed Job Title`, contrary to preserving any existing saved card.
- Child lookup unions shared `name` selectors with IDs and then takes `.first()`, allowing month/year confusion.
- Save handling does not require a newly saved card or a clean validation result before returning successfully.
- Generic child mapping can interpret a License `content_item_id` as an education degree and supply the fallback `Master's Degree` when no direct row key exists.

## Verification performed

Three in-memory probes exercised the existing adapter methods with synthetic data and minimal DOM stubs: shared-section card contamination, whole-document Skills fallback/unnamed-card classification, and License-to-degree fallback mapping. All three reproduced the behavior above. These are narrow code-path checks, not full browser replays or live Oracle verification.

For a future implementation, verify empty/prefilled groups independently; inline timeline and profile-item layouts; distinct date components; invalid save remaining open; successful save closing the editor and producing a group-specific card; and scan cancellation leaving no provisional record. No automatic job submission is part of this investigation.
