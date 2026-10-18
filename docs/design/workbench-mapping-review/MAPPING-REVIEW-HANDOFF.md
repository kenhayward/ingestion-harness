# Workbench › Mapping stage: review the proposal in the Recipe outline

The Mapping stage tab reviews the model's proposal in the same outline as Recipe › Mapping.


## Screenshots

Light theme, of the real app (Vite with a mocked `/api`) at 1440 px; the AMV recipe, the proposal
and the term names are sample data.

| File | What it shows |
| --- | --- |
| `screenshots/00-before-full-page.png` | The tab before: the proposal card above a "Current mapping" table |
| `screenshots/01-review-opens-on-first-change.png` | The tab opens on the first change (`method_name`, CHANGED, medium) |
| `screenshots/02-concept-pass-fail.png` | `validation_outcome` (NEW, high): Value as, Property, a row per enum value |
| `screenshots/03-table-low-confidence.png` | `linearity` (NEW table, low): link and row class, evidence, the term it was chosen over |
| `screenshots/04-column-changed-with-its-table.png` | `linearity.concentration`: comes with the table change, no checkbox of its own |
| `screenshots/05-proposed-filter-one-unticked.png` | The Proposed filter with `linearity` unticked |
| `screenshots/06-no-proposal-current-mapping.png` | No proposal: the current mapping, read-only, in the same outline |
| `screenshots/07-narrow-1100.png` | A 1100 px window: the outline above the inspector |

## What changed

### `apps/web/src/workbench/MappingReview.tsx` (new)

The Mapping stage's view, built from the Recipe tab's outline pieces: `outlineItems`,
`useTermLabels`, `nameOf`, `STATUS_WORD` and the same `mapping-*` classes. It takes the
definition and a `ReviewState`, or `null` when no proposal is ready.

**How the semantics are worked out.**
- **Now:** the draft's semantics, with missing parts filled from `EMPTY_SEMANTICS`.
- **Proposed:** `applyChanges(draft, all changes)`.
- **After:** `applyChanges(draft, selected changes)`.

**Where a change sits** (`changeKey`). Each change belongs to one outline item:

| Change | Item |
| --- | --- |
| `setDocumentMapping` | Document |
| `putFieldMapping` | the field |
| `putTableMapping` | the table |
| `removeMapping` | the field, table or column |
| `putLocalTerm` | Local terms |

An item's checkbox covers all of its changes, so it ticks or clears them together.

**Proposal bar** (`section aria-label="Proposal"`). It shows, in order:
- a Proposal tag;
- "n changes · model label · relative time" and Model log;
- the changes counted by confidence, with 3/2/1 bars;
- "k of n selected", **Reject all**, and **Apply k selected change(s)**. Apply is disabled when
  nothing is selected or when `blockedReason` is set.

The proposal's notes go on a second line.

**Outline.**
- **Filter:** a segmented control with All, `Proposed · n` (items with a change or a
  difference) and `Unmapped · n` (outputs not mapped now).
- **Each row:**
  - a 28 px checkbox column, with a checkbox only where a change sits. Its name is
    `Apply: <changeLabel>`, the same names as the old card.
  - the status dot for the mapping now;
  - a NEW, CHANGED or REMOVED tag in place of the summary.
- **How a row's tag is decided:** the item's part of the semantics is compared, now against
  proposed. NEW means it is not mapped now. REMOVED means it is not mapped after. Anything
  else that differs is CHANGED.
- **Group heads** read "4 of 7 → 7 of 7" when the selection changes the count.
- **The opening item** is the first one with a change.

**Inspector** (`section` named after the item).
- **Header:** the dot, the name, the type tag, "not mapped now" or "now mapped" when changed,
  and ‹ › through the filtered list.
- **Comparison:** a table labelled "Now and proposed" (or "Mapping" when nothing changes). It
  has a row per part:
  - **Outputs:** Value as, Property or Link, the entity class and IRI template, a concept for
    each enum value, and the node class, value property and unit.
  - **Tables:** link, row class and row IRI.
  - **Document:** class and IRI template.
  - **Setup items and Local terms** have rows too.
- **What each cell shows:**
  - A term shows its readable name, with the CURIE under it.
  - A proposed cell that differs is tinted with `--ih-accent-soft`.
  - Empty values say what they mean: "Default vocabulary", "The value-node default", or
    "No concept".
- **Under the table, for each change on the item:**
  - Confidence, Why (`reason`), Seen in samples (`evidence` chips) and Chosen over
    (`alternatives`: label plus compacted IRI);
  - an **Apply this change** checkbox with "· k of n selected".
- **A column changed only through its table's change:** "Changed with Table x: apply it there."
  and a button that opens the table.
- **An item the proposal leaves alone:** "The proposal leaves this as it is."

**Footer.**
- A meter: solid for mapped now, hatched for what the selected changes add.
- "a of m mapped now · b after applying the selected changes". Without a proposal it reads "a
  of m outputs mapped".
- **Edit the mapping on the Recipe tab**, linking to `#/workbench/<id>/template`.

**Without a proposal.** The same outline and inspector, read-only:
- no bar, filter or checkboxes;
- a single "Now" column;
- no Remove button. Editing stays on the Recipe tab.

### `apps/web/src/workbench/StagePanel.tsx`

- New optional `review?: (state: ReviewState | null) => ReactNode` and an exported
  `ReviewState`: proposal, body, models, selected, `onSelect(indices, on)`, onApply, onReject,
  busy, blockedReason.
- With `review` set:
  - A ready proposal with at least one change renders `review(state)` in place of
    `ProposalCard`.
  - Otherwise it renders the card (decided, empty, or none), then `review(null)`.
- Stages without `review` are unchanged. Apply, Reject, selection, Stale/Keep, progress and
  failure all stay in StagePanel.

### `apps/web/src/workbench/MappingTab.tsx`

- Passes `review` to render `MappingReview`. The "Current mapping" table is removed.
- After Apply it reloads the draft it loaded itself, because applying changes the open draft in
  place. Without this the outline would keep showing the old mapping.
- The not-used banners and `GraphPreview` are unchanged.

### `apps/web/src/templates/MappingEditor.tsx`

Exports only: `nameOf`, `useTermLabels`, `ItemKey`, `OutlineItem`, `STATUS_WORD` and
`outlineItems`. There is no change in behaviour.

### `apps/web/src/styles.css`

There is a new block, "Workbench Mapping stage", just before `.turtle`. It styles:
- the proposal bar;
- the confidence colours and bars (`--ih-ok-fg`, `--ih-warn-fg`, `--ih-danger-fg`);
- the filter;
- rows with a checkbox column (the open row's highlight moves to the `li`);
- the comparison table and the evidence chips;
- the Apply-this-change box;
- the hatched meter segment.

Under 720 px the existing container query stacks the outline above the inspector. Every colour
is an existing token, so light and dark work alike.

### `apps/web/src/help/WorkbenchTabsHelp.tsx`

The *Proposing a mapping* help gains **Reviewing the proposal**.

### Unchanged

- The API and the proposal format.
- `mappingBadge` and `mappingNote`. (`mappingRows`, used only by the old table, was removed.)
- The other stages, and the Recipe › Mapping editor.

## Tests: `apps/web/test/MappingTab.test.tsx`

**Replaced:** the two tests for the old card ("shows a proposal… and applies it") and for the
Current mapping table.

**New:** the fixture is a proposal with three changes:
- `lot`, which is the same as now;
- `expires`, which is new, medium;
- `tests`, a table change that adds column `assay`, low.

The new tests cover:
- the outline has exactly three checkboxes, on `lot`, `expires` and the table, all checked. The
  tags are NEW on `expires` and `tests.assay`, CHANGED on the table, and none on `lot`. The bar
  shows "3 changes", "1 high / 1 medium / 1 low" and "3 of 3 selected", plus the notes. The
  footer reads "1 of 3 mapped now · 3 after applying the selected changes";
- it opens on `lot`. On `expires`, the Property row shows "Default vocabulary" and
  `dcterms:date`, with the confidence, the reason, the evidence chip, the alternative, and a
  checked Apply this change;
- `tests.assay` says it comes with Table tests, and its button opens the table;
- unticking `expires` gives "2 of 3 selected" and "2 after applying". Apply calls
  `decideProposal('batch', id, 'accepted', [0, 2])`;
- Reject all calls `decideProposal(…, 'rejected')`;
- the Proposed and Unmapped filters;
- with no proposal: the read-only outline, `expires` described as "unmapped (not mapped)", no
  checkboxes, no Remove the mapping, and the Recipe link.

The banner, preview and helper tests are unchanged. `StagePanel`, `MappingEditor`, `Help` and
the other stage tests pass unchanged.
