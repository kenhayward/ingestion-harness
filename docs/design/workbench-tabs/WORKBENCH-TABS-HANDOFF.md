# CT Studio — Workbench tabs redesign — handoff for Claude Code

Scope: **only the 11 Workbench project tabs** redesigned one by one after the previous
Workbench handoff (project list, project shell, vertical rail, Overview map — already in
progress). Nothing else in `apps/web` changes. The app is now **CT Studio** (in-app name);
use "Content Transformation Studio" in documents.

Follow the repo's CLAUDE.md: test first, ports and adapters, a contract change lands on both
sides (shared Zod type + API + client) in one PR, forward-only migrations.

## Contents of this pack

| Path | What it is |
| --- | --- |
| `WORKBENCH-TABS-HANDOFF.md` | This document |
| `screenshots/light/NN-<tab>.png`, `screenshots/dark/…` | Each tab in its default state, 1440 px wide, full height |
| `screenshots/states/` | Interactive states worth matching (light) — listed under each tab |
| `prototype/prototype.html` | Clickable offline prototype. Open `?screen=workbench&wtab=<tab>`; add `&theme=dark`. Tabs: `samples brief survey outputs sections steps references evaluate revise template runs` |

All names, counts and scores in the screenshots are one consistent mock project
("Supplier invoice", draft v4, live v3). Copy behaviour and copy text from this document, not
numbers from the PNGs.

**Design tokens:** none new. Everything uses the base tokens plus the Workbench pack's
`--ih-skip-*` (violet), `--ih-lock-*` (rose), `--ih-flow`, `--ih-side`. Tone use is fixed:
`ok` done/accepted, `warn` needs you, `alert` stale, `danger` error/required missing,
`info` dev / informational, `skip` **holdout** (and skipped stages), `lock` publish locked.

---

## 0. Rules shared by every tab

1. **Tab header pattern.** `h2` title → status line (stage status icon + one sentence, tone
   coloured, the same text as the rail tooltip and the Overview box) → one muted sentence on
   what the tab does → actions on the right (primary at most one). Stage tabs keep the
   existing *Propose again* / *Skip this stage* / *Edit by hand* secondary actions.
2. **Proposal card** (Survey, Outputs, Sections, Steps, Revise): warn-bordered card, header
   with model · brief version · age, one row per `DraftChange` with a tick box (default on),
   `NEW / CHANGED / REMOVED` + kind tags, a mono diff chip (`+ due_date`,
   `chunk pages 3 → 2`) and the model's reason. Footer: **Apply N selected** (count is live)
   and **Reject all**. After apply the card becomes an ok-tinted "N changes applied" card with
   the next action (usually a link to the next tab).
3. **Holdout is sealed.** Holdout samples are violet everywhere (`skip` tone). Nothing
   derived from a holdout sample — text, values, diffs, comments — is ever sent to a model.
   Tabs that show holdout data say so in a violet note. Server guard: see **RV3**.
4. **Stale propagation.** A tab whose inputs changed after acceptance shows `alert` status
   and a banner naming what changed, with *Keep* and *Propose again*.
5. **Cross-links.** Every warning names the tab that fixes it and links there
   (`onNavigate('#/workbench/:id/<tab>')`). No dead-end warnings.
6. **Sample identity.** Mono file names; dev = `info` tag "DEV", holdout = `skip` tag
   "HOLDOUT". Section colours are fixed per section across Sections, Steps and Template
   (header `accent`, supplier `ok`, line_items `skip`, totals `warn`, payment `lock`).
7. **Accessibility.** Every status icon has an accessible label; selectable rows are buttons
   with `aria-pressed`; meters are `role="img"` with an `aria-label` carrying the numbers;
   tables use real `table`/`role="table"` semantics; colour is never the only signal
   (each chip also has text).
8. **Polling.** Keep the existing `pollMs` behaviour: poll only while something is running.

---

## 1. Samples — `workbench/SamplesTab.tsx` (+ `SampleText.tsx`)
Screens: `01-samples.png`

- **Summary cards (4):** Dev ready *n of m* (target 3–8), Holdout ready (≥ 2 needed for the
  gate), Capacity *used of max* with slots left, OCR pages *n of total*.
- **Drop zone** with an *Add as Dev / Holdout* switch; text explains preparation (text layer,
  then OCR for image-only pages) and remaining slots.
- **Two groups**, Dev then Holdout, each row: page-count badge, file name, status
  (`Ready / Preparing / Failed`), meta line (pages · OCR pages · size · "added for vN"),
  Dev/Holdout segmented switch, and a one-line note (OCR model used; "line table runs across
  pages 2–4"; failure reason in plain words, e.g. password-protected).
- Holdout rows show "Used in N holdout evaluations · never sent to a model".
- **Preparing** rows show live progress ("OCR page 2 of 3").
- **Text preview** panel for the selected sample: per-page chips (OCR flagged), the prepared
  text with `[page n]` markers, and the cache note ("cached per PDF hash").
- API: existing `listSamples`, upload, triage (role switch), delete, sample text.
  New **SM1–SM2**.

## 2. Brief — `workbench/BriefTab.tsx` (+ `ExportPanel.tsx`)
Screens: `02-brief.png`

- Status: "Saved as vN · age · n fields changed since". Unsaved bar: *Discard* / *Save as
  vN+1* (each save is a new version).
- **Section nav** (Purpose, Outputs wanted, Glossary, Example output, Variants, Rules,
  Survey answers · n) jumping to the matching card. Each card: label, char count, an
  "edited" tag when dirty, a one-line hint, the textarea.
- **Example output** renders the pasted CSV as a preview table ("2 rows × 7 columns").
- **Survey answers** card: read-only list of answers saved from Survey, or an empty state
  linking to Survey with the open-question count.
- **Versions** list: version, age, CURRENT tag, "used by Outputs" tag, what changed,
  *Compare*.
- **Drafting bundle** (ExportPanel restyled): what is included (never holdout), export
  status with version, PDF count and size, *Download* / *Export again*, and the local-only
  token note.
- API: existing brief get/save, export. New **BR1–BR3**.

## 3. Survey — `workbench/SurveyTab.tsx`
Screens: `03-survey.png`, states `03b-survey-answered.png`

- Banner when the stage was skipped earlier and later run ("You skipped this stage on 3 Oct…
  Accepting replaces the skip — Outputs, Sections and Steps … will be marked stale").
- **Questions from the model** (primary card, warn border): numbered questions, "Why it
  asks" line, an answer textarea each; header shows "n of m answered" with a progress bar;
  footer *Save n answers to brief (vN+1)* — unanswered ones can wait.
- **What the model found:** model · brief version · age, a summary paragraph, "Variants it
  noticed" chips.
- **Candidate data** table: kind (FIELD/TABLE), name, what, where it is found, **In brief**
  (Yes / Not yet). Footer: "the Outputs stage turns these into fields and tables".
- **Document anatomy** column: numbered structure cards with "Find it:" hints — feeds
  Sections.
- API: existing survey stage/proposal calls. New **SV1–SV2**.

## 4. Outputs — `workbench/StagePanel.tsx` stage `outputs`
Screens: `04-outputs.png`

- Stale-proposal banner when the proposal used an older brief or Survey has a new candidate
  ("This proposal used brief v2; the brief is now v3 and the Survey has a new candidate
  (discount_percent)…").
- Summary chips: *n fields*, *1 table · 4 columns*, `+added`, `~changed`, `−removed`.
- **Outputs in draft vN** table compared with the live version: filter *All / Changed since
  vN-1*; columns vs-live tag, id, name, type, values, description; table columns indented
  under their table; removed outputs shown struck through.
- **Latest proposal** (collapsible): summary + each change with Applied / Not applied.
- API: existing (`diffVersions`, `ProposalView.briefVersion`, `acceptedChanges`). No new
  calls.

## 5. Sections — `workbench/SectionsTab.tsx` (+ `SegmentationGrid.tsx`, `segmentation.ts`)
Screens: `05-sections.png`, states `05b-sections-anchor-fix.png`

- Stale banner with **Keep these anchors** (confirms without re-proposing) and *Propose
  again*.
- **Anchors** list: order, id, regex input, hits badge *n/8* (ok when all, danger when a
  required section misses), Required tick, move/remove; under each, where it lands in the
  selected sample ("In inv-0027-globex.pdf: no match — required"). *Add section*. Editing
  is live: the grid recomputes on input; *Save to draft vN* enables when dirty.
- **Where each anchor lands** grid: samples × sections; cell shows page and characters;
  states *Found*, *Swallows > 60% of the text* (warn), *Missing (required)* (danger),
  *Missing (optional)*. Clicking a cell selects sample + section.
- **Text panel** for the selected sample with "▶ section starts here" markers in section
  colours; when the selected required section is missing, a hint with a one-click fix
  ("This sample labels it *Vendor:* … **Use ^(From|Supplier|Vendor)\b**").
- API: existing segmentation preview. New **SC1–SC2**.

## 6. Steps — `workbench/StagePanel.tsx` stage `steps`
Screens: `06-steps.png`, states `06b-steps-applied.png`

- **Coverage strip** "Which step fills each output": one chip per output with the step
  number; outputs filled by no step are warn chips with `!`; header says how many are
  uncovered and whether the proposal fixes them.
- **Pipeline in draft vN:** "Prepared text, split into n sections" → step cards joined by
  flow connectors → "Outputs: …". Each card: number, kind (EXTRACT/CHECK), id, model,
  *Fills* chips, *Reads* section chips (section colours), chunking, and per-step figures
  from the last test runs (Runs, Failed, Attempts, Avg time — warn when high) with a
  plain-language warning when a step keeps retrying.
- **Proposal card** (pattern §0.2). Applying redraws the pipeline (new steps tagged
  JUST ADDED) and the coverage strip turns green.
- API: existing proposals + `getMetrics` per-step stats. New **TP2** (shared coverage check).

## 7. References — `workbench/ReferencesTab.tsx`
Screens: `07-references.png`, states `07b-references-holdout-detail.png`

- Ready banner when every dev and holdout reference matches the draft's outputs, with
  **Go to Evaluate** and why references were re-verified (`outdated` keys).
- **Three cards:** Dev references *n/n*, Holdout references *n/n* (violet), Right first time
  *x / y* (% of dev values the model proposed correctly, excluding values no step fills).
- **"Where the draft model needed you"**: one chip per output with the number of dev
  references where you changed it (amber corrected, blue entered by hand); links to Steps
  when an output has no step.
- **Samples** list, Dev and Holdout groups, filter *All / Corrected / Needs you*. Row:
  name + "Re-verified in v4 · date · was v3" (or "carried from vN"), a 3-dot tracker
  **Run → Reviewed → Saved** (`role="img"`, labelled), "Corrected: total" or "No
  corrections", **Review** link. Group headers carry the run buttons with counts
  ("Run the template on 0 unverified", disabled with a reason). Foot lists samples not
  counted (preparing / failed) with a link to Samples.
- **Detail panel** for the selected sample: reference name, saved by/at, which run proposed
  it; every output with value and provenance tag **MODEL ✓ / CORRECTED** (model value
  struck through) **/ BY HAND**; *Open in Review to change*.
- API: existing `listReferenceRows` (dev + holdout), `proposeReferences`,
  `startHoldoutReferenceRuns`, `skipStage`. New **RF1–RF2**.

## 8. Evaluate and publish — `workbench/EvaluateTab.tsx` + `PublishPanel.tsx`
Screens: `08-evaluate.png`, states `08b-evaluate-override.png`, `08c-evaluate-dev-comment.png`

- **Publish gate card** at the top (rose border when locked, ok when passing):
  - tag LOCKED / READY / PUBLISHED + title ("Publish v4 is locked — holdout 88% is under 90%");
  - two meters on a 70–100 % scale with the threshold tick: **Holdout** ("decides the gate",
    violet) and **Dev** ("guides your changes", blue);
  - **What is holding it back**: plain-language cause from the gate run's worst outputs and
    the template (e.g. "no step fills due_date"), with links to the fixing tab;
  - footer: threshold input (%), "Live: v3 · published date at score", **Publish anyway…**
    (only when locked) and **Publish vN** (disabled with a lock icon while locked).
  - *Publish anyway…* opens an override panel (rose): reason textarea (10–1000 chars, live
    counter), **Publish vN with override**, *Cancel*. The reason and score go to the
    publication log.
- **Run bar:** Holdout / Dev segmented switch, Model (Template's models / default / fast /
  draft — holdout forces template's), *Fresh model calls*, *Compare models* (dev only,
  disabled with a tooltip on holdout), primary **Evaluate vN on holdout|dev**.
- **Latest run** for the selected set: title, time, compared count, cache reuse; one row per
  sample with a score bar + threshold tick, score (ok/warn), "Off: due_date, total".
  Selecting a row opens the **comparison table** (Output · Reference · This run · ✓/✗).
  Mismatches on **dev** have *Comment* → inline textarea → *Save comment* → "Comment saved —
  see Revise". On **holdout** comments are hidden and a violet note explains why (§0.3).
- **Accuracy by output:** worst first, bar + % + matched/total, red < 70 %, amber
  < threshold, green ≥ threshold; "+ n more at 100 %".
- **History:** bar chart of template-model runs (dev blue, holdout violet, older versions
  dimmed, dashed threshold line) and the iteration list (version, set tag, model or compare
  summary, time, score, *Restore*). **Publications** log below with overrides in rose.
- API: all existing (`listIterations`, `getIteration` ×2, `startEvaluation`,
  `startComparison`, `restoreIteration`, `addFeedback`, `getPublishGate`,
  `setPublishThreshold`, `publish(reason)`, `listPublications`). Optional **EV1**.

## 9. Revise — `workbench/ReviseTab.tsx`
Screens: `09-revise.png`, states `09b-revise-proposal.png`, `09c-revise-applied.png`

- Banner when another stage has an undecided proposal that addresses the same failure
  ("Steps has an open proposal. It adds due_date… Decide it first").
- **What the model will see** card: summary line (n feedback items · n failure diffs with
  trimming limits · draft · model) and the primary **Ask the model for a revision**.
  - *Your feedback:* numbered items — target tag (FIELD/TABLE/STEP/SECTION), id, sample,
    body, origin ("From Evaluate · dev run …" / "Added here"), delete. Add form: target
    segmented switch + **id dropdown filled from the draft** (replaces the free-text id) +
    textarea + *Add*.
  - *Failures from the latest dev run:* dev samples below 100 %, worst first, with diff chips
    (`due_date`, `total 3,912.00 ≠ 4,694.40`). Violet footer: "Not sent: the holdout run and
    its n samples".
- **Running** strip (info) while the stage runs, then the **proposal card** (§0.2) where each
  change carries an **Answers ①** badge pointing at the feedback it addresses. Applying marks
  those items ANSWERED and offers **Evaluate on dev**.
- **Earlier revisions** (collapsed): version, date, applied/rejected counts, what they
  answered.
- API: existing `listFeedback`, `addFeedback`, `deleteFeedback`, revise stage calls,
  `failureDiffs`. New **RV1–RV3**.

## 10. Template — `templates/TemplateEditor.tsx` with `embedded`
Screens: `10-template.png`, states `10b-template-unsaved.png`, `10c-template-outputs.png`

The standalone editor screen keeps its own design (UI handoff). Embedded in the Workbench:

- **No** back link, name heading or Publish button (the project header owns them). Header:
  "Template · draft vN", one sentence ("Model proposals and your edits change the same
  draft… Saving marks the latest evaluation as out of date"), **Try on [dev sample ▾] →
  Test run** (replaces the PDF file input), icon buttons *Export YAML* and *More → Delete
  draft*.
- **Sub-tabs:** General, Sections n, Outputs n, Pipeline n, YAML. **Quality is removed**
  (Evaluate replaces it). A warn dot marks sub-tabs with a check failure. Default sub-tab:
  Pipeline.
- **Pipeline:** step list (number, id, "Fills n · reads …", *+ Add step*) and the selected
  step's form: Model, Pages per call, Max attempts, **Reads sections** as toggle chips in
  section colours, **Fills outputs** chips with remove × and an "+ Add output…" select that
  lists unfilled outputs first, Instructions textarea, last-runs figures. Inline warnings
  tie to metrics ("Reading payment makes this step retry on most runs — the Steps proposal
  drops it").
- General / Sections / Outputs sub-tabs keep the existing forms; each ends with a link to
  the stage tab that drafts that part.
- **Checks** panel (right): validation issues + coverage gaps + stale stages, each with a
  link to the fixing tab.
- **Changes since vN-1** panel: provenance log, newest first — BY HAND / <STAGE> PROPOSAL /
  SURVEY / STARTED, time, summary, diff chip; *Full diff* opens `diffVersions`.
- **Unsaved bar** (sticky bottom, warn border) on any edit: "Unsaved change to step totals ·
  Saving marks the <date> evaluations out of date", *Discard*, **Save draft vN**.
- API: existing `getTemplate`, `saveTemplate`, `deleteDraft`, `exportUrl`, `listModels`,
  `getMetrics`, `diffVersions`. New **TP1–TP2**, uses **TR1** for *Try on*.

## 11. Test runs — `workbench/RunsTab.tsx`
Screens: `11-runs.png`, states `11b-runs-new-batch.png`

- Status "n test runs in progress · n awaiting review"; text: runs draft on prepared dev
  samples, **not scored** (Evaluate scores), never holdout, queued behind production.
  Primary **Run on n dev samples** (n follows the selection).
- **Samples** chips with tick boxes (all ready dev samples on by default; preparing/failed
  greyed with a reason tooltip) and the queue estimate ("3 production jobs ahead · about
  2 min").
- **Batches**, newest first (live batch has an info border): title (time · draft), who/what
  started it, a stacked status bar + counts. Rows: file, status pill (Queued, Running,
  Awaiting review, Succeeded, Failed), detail line (check flags, attempts, error in plain
  words), a 3-segment step progress bar on running rows, duration, action (**Review now**
  for awaiting review, *Review*, *Retry* on failed). Older batches collapsed behind *Show*.
- API: existing `listTestRuns`, `runDevTests`, job retry if Jobs already exposes one. New
  **TR1–TR4**.

---

## New API (all tabs)

IDs are prefixed per tab so they do not clash with the Workbench pack's W1–W4.

| ID | Change | Tab · used for |
| --- | --- | --- |
| **SM1** | `SampleView.prepare: { stage: 'text' \| 'ocr', page: number, of: number } \| null` | Samples · live "OCR page 2 of 3" |
| **SM2** | `SampleView.prepareError: { code: 'password' \| 'corrupt' \| 'too_large' \| 'other', message } \| null`; `holdoutEvaluations: number` | Samples · plain-language failure, holdout usage line |
| **BR1** | `GET /api/workbench/projects/:id/briefs` → `{ version, createdAt, changedSections: string[], usedBy: Stage[] }[]` | Brief · versions list |
| **BR2** | `GET …/briefs/:a/diff/:b` → per-section before/after (or diff client-side from two `GET …/briefs/:v`) | Brief · Compare |
| **BR3** | `ExportView` gains `briefVersion`, `devPdfs`, `bytes` | Brief · bundle status line |
| **SV1** | `StageView.skippedAt: string \| null` kept after a later run | Survey · "You skipped this stage on …" banner |
| **SV2** | Survey candidates gain `inBrief: boolean` and `seenIn: { n, of }` | Survey · In brief column, "3 of 6 samples" |
| **SC1** | `POST /api/workbench/projects/:id/stages/sections/confirm` → clears `stale` without a new proposal | Sections · *Keep these anchors* |
| **SC2** | Segmentation preview returns `suggestions: { section, sampleId, anchor, reason }[]` for required sections that miss (label-variant heuristic) | Sections · one-click anchor fix |
| **RF1** | `ReferenceRow.reference.corrections: { key, kind: 'corrected' \| 'entered', proposed }[]` (stored when the reference is saved) and `verifiedBy` | References · strip, row text, right-first-time |
| **RF2** | `GET …/references/:sampleId` → `{ values, corrections }` | References · detail panel |
| **EV1** *(optional)* | `GateView.hints: { key, accuracy, cause: 'no_step' \| 'low_accuracy', stage }[]` | Evaluate · "What is holding it back" (keeps Overview and list consistent) |
| **RV1** | `GET …/stages/revise/preview` → `{ feedback, failures: FailureDiff[], model, draft }` | Revise · exactly what will be sent |
| **RV2** | `DraftChange.answers: string[]` (feedback ids) on revise proposals | Revise · Answers badges, marking feedback answered |
| **RV3** *(guard)* | `addFeedback` → 422 when `sampleId` is a holdout sample or `iterationId` is a holdout iteration | Revise/Evaluate · keeps holdout sealed (check whether the API already enforces this) |
| **TP1** | `GET …/projects/:id/draft/changes` → `{ at, source: 'hand' \| Stage, proposalId?, summary, diff }[]` (record on save and on proposal apply) | Template · Changes since vN-1 |
| **TP2** | Validation issue "output `x` is not filled by any step", exported from `packages/shared` and used by Steps coverage and Template Checks | Steps, Template |
| **TR1** | `runDevTests(projectId, { sampleIds?: string[] })` | Test runs selection; Template *Try on* |
| **TR2** | `JobSummary.batchId`, `startedAt`, `finishedAt`, `attempts` | Test runs · batches, durations |
| **TR3** | `JobSummary.progress: { step, index, of, attempt, chunk?: { n, of } } \| null` | Test runs · step progress |
| **TR4** *(optional)* | `GET /api/queue/summary` → `{ ahead: number, etaSeconds: number \| null }` | Test runs · queue estimate |

Phase suggestion: **1** RV3, TP2, TR1, SC1 (small, unblock behaviour) → **2** RF1–RF2,
RV1–RV2, TR2–TR3, SV1–SV2, SM1–SM2 → **3** BR1–BR3, TP1, SC2, EV1, TR4.

## Tests to add (minimum)

- Each tab: status line text and icon label per stage state; primary action disabled
  states carry a reason (`title`/`aria-describedby`).
- Evaluate: override button disabled under 10 chars; holdout set hides *Comment*;
  compare disabled on holdout.
- Revise: holdout feedback rejected (API, RV3); proposal apply marks answered feedback.
- Sections: editing an anchor recomputes hits without saving; *Keep* calls SC1.
- Template: any edit shows the unsaved bar; Discard restores; Quality sub-tab absent when
  embedded.
- Test runs: selection count drives the button label; preparing/failed samples not
  selectable.
