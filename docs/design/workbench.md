# Workbench: drafting and evaluating document types

**Status:** design · 2026-10-12 · decisions: [ADR 0007](../adr/0007-workbench.md)

The Workbench is a new top-level page for building a document type from a handful of sample
PDFs. The user uploads samples, the harness prepares and segments their text, the user describes
what they need, and a drafting model proposes the template in reviewable stages. The draft is then
scored against verified reference values on dev samples and on held-out samples until it is good
enough to publish. The same project is reopened to build the next version when a new layout turns
up.

It is mostly an orchestration layer over existing parts:

- draft templates and the `TemplateEditor`;
- test runs (`jobs.test`);
- references and regression (`template_references`, `apps/api/src/regression/compare.ts`);
- step re-runs (`step_runs`, the `rerun` task);
- review editing (`ReviewPage`, `EditableValue`).

What it adds is new: sample preparation, a segmentation preview, staged LLM drafting, a step
result cache, and evaluation with a holdout set.

Export and import of a drafting bundle (samples, text, brief, format reference) stays as a
secondary path for edge cases, built from the same context assembly the drafting tasks use.

## Goals and non-goals

**Goals**
- Get from 3–8 sample PDFs to a published v1 with less hand-written YAML and anchor guessing.
- Make each refine → test → score loop fast enough to do dozens of times: only changed steps
  re-run.
- Produce an honest quality number (holdout) before publishing.
- Reuse the same project to maintain a type over its versions.

**Non-goals (for now)**
- Fully automatic drafting with no human checkpoints.
- Fine-tuning models.
- Sharing projects across deployments (export/import covers that).
- A role system beyond what ADR 0006 already has.

## Concepts

| Concept | Meaning |
| --- | --- |
| **Project** | One per document type, long-lived. It owns the samples, the brief, the stage state, the iteration history and the current draft template version. |
| **Sample** | A PDF in the project, stored as an ordinary `documents` row, with a role `dev` or `holdout` and a triage summary. |
| **Prepared text** | Per sample: page text after extraction and OCR, before copy selection and segmentation. Stored once per PDF sha256. |
| **Segmentation** | Copy selection plus section anchors applied to the prepared text. Cheap and deterministic, and run on every anchor edit. |
| **Brief** | The user's product knowledge (structured form, versioned). |
| **Stage** | One drafting step: `survey` → `outputs` → `sections` → `steps` → `references`. Each produces a **proposal**. |
| **Proposal** | A model's suggested change to the draft (or survey notes), shown as a diff and accepted or rejected per change. |
| **Iteration** | A snapshot: the template definition, the brief version, the evaluation scores and the user's feedback. Iterations can be reverted or branched from. |
| **Reference** | Verified expected values for one sample (`template_references`). Model-proposed values count only after a human verifies them. |

## User journey

1. **Create project:** name and id (the future template id), data policy (default *local only*).
2. **Samples:** upload 3–8 PDFs. The harness checks for duplicates, triages each sample (page
   count, text layer or scanned, copies), and suggests a dev/holdout split with the hardest
   samples in the holdout. A `prepare` task runs per sample.
3. **Brief:** fill in the structured brief (see below).
4. **Survey:** the drafting model reads the dev samples and the brief. It reports structure,
   variants, where each candidate datum lives, and questions for the user. Answers go into the
   brief.
5. **Outputs:** it proposes fields and tables (types, enums, descriptions). The user accepts or
   edits each one.
6. **Sections:** it proposes anchors, which are checked against every dev sample before the user
   sees them. The segmentation grid shows a hit or miss per sample and section.
7. **Steps:** it proposes extract steps, instructions, `pageImages`, `chunkPages`, `context` and
   check steps.
8. **References:** it proposes expected values for each sample, with page evidence. The user
   verifies each one in the Review screen and saves it as a reference.
9. **Evaluate:** a test run on dev (cached steps reused) produces a scorecard and drill-down. The
   user gives feedback on failing fields or steps, `revise` proposes a change, and the loop
   repeats.
10. **Holdout:** a test run on the holdout samples is scored the same way.
11. **Publish:** passing the holdout threshold (or overriding it with a logged reason) publishes
    vN. The references join the published version's regression suite.
12. **Maintain:** "Open in workbench" from Document types adds new samples to the same project
    and starts v(N+1).

Stages run in order, and each needs acceptance before the next one is proposed. The user can
**skip** a stage by writing that part by hand. Re-proposing an earlier stage marks later stages
**stale**; it never deletes them.

## The brief

A structured form, versioned. Every proposal records the brief version it used.

- **Purpose:** what the outputs are for and who consumes them.
- **Outputs wanted:** must-have and nice-to-have, in plain words.
- **Example output:** a mock CSV or a few example rows (optional, high value).
- **Glossary:** domain terms and abbreviations.
- **Variants:** known issuers, layouts, languages, blank versus executed copies.
- **Rules:** for example "placeholders are null", "use the executed copy", "dates are DMY".
- **Answers:** questions from the survey stage and the user's answers.

Parts of the brief feed the template's `preamble` and field `description`s, so the published
template documents itself.

## Data model (sketch)

All tables are new except where noted. Migrations are forward-only.

```text
workbench_projects
  id text PK (= template id)            name, description
  data_policy  text  'local' | 'external'   -- external set by admin only (ADR 0007)
  draft_version int                      -- templates(id, draft_version) being developed
  publish_threshold numeric DEFAULT 0.9
  stage_state jsonb                      -- per stage: pending | proposed | accepted | skipped | stale
  created_at, updated_at, archived_at

workbench_samples
  project_id → workbench_projects       document_id → documents
  role text 'dev' | 'holdout'           added_for_version int
  triage jsonb  -- pages, text_layer_pages, ocr_pages, copies_detected, outlier_score
  prepared_key text                      -- runs bucket key of prepared text, null until ready

workbench_briefs
  project_id, version, body jsonb, created_at       -- append-only

workbench_proposals
  id, project_id, stage, brief_version, base_template_hash
  status 'proposed' | 'accepted' | 'partially_accepted' | 'rejected' | 'stale'
  body jsonb      -- changes (JSON-patch-like ops on the definition) + notes/questions
  model, input_tokens, output_tokens, job_id, created_at

workbench_iterations
  id, project_id, template_version, definition jsonb, brief_version
  scores jsonb   -- dev/holdout summaries from compare.ts
  feedback jsonb -- per field/step comments
  parent_id      -- branching
  publish_override_reason text

workbench_feedback
  id, project_id, iteration_id, target 'field'|'table'|'step'|'section', target_id,
  sample_id?, body, resolved_by_proposal?

step_cache
  key text PK   -- sha256 of the step's full input (see Evaluation)
  output_key text, model text, created_at, last_used_at

jobs (changed)
  task: + 'prepare' | 'segment' | 'draft' | 'revise'
  project_id text NULL → workbench_projects
  document_id: NULL allowed for project-scoped tasks
               CHECK (document_id IS NOT NULL OR project_id IS NOT NULL)
  priority smallint NOT NULL DEFAULT 0   -- production 0, workbench -10; claim orders by it
  params jsonb  -- task parameters (stage, sample ids, proposal id ...)
```

`documents.spec_id` / `spec_version` on sample documents point at the project's draft template.

## Worker tasks

All LLM and PDF work stays in the worker. The API only enqueues and reads results.

| Task | Scope | Does |
| --- | --- | --- |
| `prepare` | sample | Text extraction and OCR (`ocr: auto`, cached by sha256). Writes the per-page text and triage metadata to the runs bucket. Copy selection and segmentation are *not* applied, so changing anchors never needs a re-prepare. |
| `segment` | project | For each sample, applies the current draft's `copies` and `sections` (or a candidate anchor set) to the prepared text. Writes the grid: per sample × section, the hit, matched line, page and length. Text-only and sub-second. Runs at the highest workbench priority. |
| `draft` | project | Runs one stage (`params.stage`). Builds the context (below), calls the `draft` model, validates the result and retries with the errors fed back. Writes a proposal. |
| `revise` | project | Given feedback items and **dev** failure diffs, proposes a change to outputs, sections or steps. |
| test runs | sample | The existing `process` path with `jobs.test`, using the step cache. A dev or holdout evaluation is a batch of test jobs linked to an iteration. |

`prepare_document` is split so the workbench can stop after the OCR stage. The existing pipeline
keeps calling the composed function, so production behaviour is unchanged.

Drafting tasks reuse the extraction loop's pattern. The model emits JSON fragments (not the whole
template under a constrained schema, because the template's rules live outside JSON Schema).
These are validated with the Pydantic template model plus the cross-reference rules, and the
errors are fed back. The `sections` stage also runs the segmenter on every dev sample and feeds
back misses. Prompts and responses go to the runs bucket like extraction does.

### Context assembly

One function builds the drafting context for every stage, for `revise`, and for the export bundle:

- **Format reference:** JSON Schema generated from the template model, the cross-reference rules in
  prose, a rendered example of the built-in extraction prompt, and the runtime model's limits
  (from the alias the template will run on).
- **Worked example:** a published template plus excerpts of its sample text (configurable; the
  Process Validation Protocol v3 template by default).
- **The brief** (current version).
- **Dev samples only:** prepared text with page markers, triage metadata, and selected page images
  where the text loses information (scans, headers OCR drops).
- **The current draft** and accepted proposals; for `revise`, the feedback and dev failure diffs.

**Holdout text, holdout page images and holdout failure diffs are never included.** This is
enforced here, in one place, and covered by tests.

### Models and data policy

- A new alias `draft` in `config/llm-providers.yaml`. It may point at a frontier model or at a
  slower, more capable local model, and a project can override it.
- Each provider gets `location: local | external`.
- Before a drafting call, the worker resolves the model and checks the project's policy against
  the **resolved provider's** location. This happens alongside the existing up-front
  `ModelResolutionError` check.
  - A local-only project whose `draft` resolves to an external provider fails the task with a
    clear configuration error. The worker never silently falls back to another model.
  - Every external call is logged as a project event: stage, model, sample ids sent, tokens.
- The policy also applies to test runs started from the Workbench, because extraction sends sample
  text too: a local-only project cannot pick an external model in the evaluation model picker.

## Evaluation

### Step cache

The key is the sha256 of the step's **full input**:

- the compiled step: the rendered prompt including preamble, instructions and output schema;
- the section text it receives;
- the page image hashes;
- the resolved model reference and its provider options (temperature etc.);
- the values of `context` paths from earlier steps.

A hit reuses the stored output and records a `step_runs` row marked cached. Changing the preamble
or an upstream step invalidates exactly the steps whose input changed.

Rules:
- Only test jobs started from the Workbench use the cache. Production and regression jobs never do.
- "Re-run uncached" forces fresh calls, for checking variance.
- The cache is keyed by content, not by project, so identical inputs share an entry.

### Scorecard

`compare.ts` already compares outputs with references. The Workbench shows it per iteration:

- accuracy per field, per table column and per sample, with the trend across iterations;
- a drill-down: the actual value against the expected value, evidence and page image, and the
  step and section that produced it;
- model comparison: the same iteration on `default`, `fast` and `draft`, to separate a weak
  template from a model at its limit.

### Holdout

- The drafter never sees holdout material (see Context assembly).
- Holdout failures **are** visible to the user (ADR 0007). A sample's `added_for_version` and its
  holdout history stay with it, so a later reader can see how much the holdout was relied on.
- The publish gate uses the holdout score: at or above `publish_threshold` publishes directly;
  below it, publishing needs an override reason, recorded on the iteration.

### References across versions

References belong to a template version when used for regression. Moving the project to
v(N+1) keeps vN's references pinned to vN. Samples added for v(N+1) don't change vN's regression
results. Accepted references are copied forward as the starting set for the new version, and
re-verified only where outputs changed.

## API (sketch)

All routes are under `/api/workbench`, covered by the session hook and the `access.test.ts` sweep.

```text
GET/POST          /projects                       list / create
GET/PATCH         /projects/:id                   detail / name, threshold
PUT               /projects/:id/data-policy       admin only
POST              /projects/:id/samples           upload (multipart), enqueues prepare
PATCH/DELETE      /projects/:id/samples/:sid      role / remove
GET               /projects/:id/samples/:sid/text prepared text (paged)
POST              /projects/:id/segment           enqueue segment (optional candidate anchors)
GET               /projects/:id/segmentation      latest grid
GET/POST          /projects/:id/brief             current / new version
POST              /projects/:id/stages/:stage     propose (enqueue draft)
POST              /projects/:id/stages/:stage/skip
GET               /projects/:id/proposals[/:pid]
POST              /projects/:id/proposals/:pid/decision   accept/reject per change
POST              /projects/:id/feedback          comment on field/step/section
POST              /projects/:id/revise            enqueue revise from open feedback
POST              /projects/:id/evaluate          { set: dev|holdout, model?, uncached? }
GET               /projects/:id/iterations[/:iid] history, scores
POST              /projects/:id/iterations/:iid/revert
POST              /projects/:id/publish           { overrideReason? }
GET               /projects/:id/export            bundle (zip)
POST              /projects/import                bundle → project
```

Accepting a proposal applies its changes to the draft template through the same validation as the
template editor. It is rejected if the draft has changed since the proposal's
`base_template_hash` in a way that conflicts with it.

## UI

New nav item **Workbench** in the app shell, using the existing tokens and `ui/` primitives.

- **Project list:** name, version under development, stage, last dev and holdout score, data
  policy badge.
- **Project page:** a stage rail on the left (Samples · Brief · Survey · Outputs · Sections · Steps ·
  References · Evaluate · History), each marked pending, accepted, skipped or stale. A persistent
  data-policy badge shows *Local only* or *External allowed*, and wherever an action would send text
  to an external model it says so before the action runs.
  - **Samples:** upload, triage, dev/holdout toggle, prepared-text viewer with page markers.
  - **Brief:** form plus version history.
  - **Survey:** notes and questions; answers are written back into the brief.
  - **Outputs / Steps:** the embedded `TemplateEditor` plus a proposals panel (diff, accept or
    reject per change).
  - **Sections:** the segmentation grid (samples × sections; hit, line, length; empty or oversized
    sections flagged), an anchor editor, and a text pane with section boundaries marked.
  - **References:** per sample, proposed values open in the Review screen for verification.
  - **Evaluate:** run dev or holdout, scorecard, drill-down, feedback, `revise`.
  - **History:** iterations, scores trend, revert or branch, publish.
- **Document types** becomes the catalogue of published types. "Open in workbench" replaces
  draft editing there.

## Cross-language contracts touched

| Contract | TypeScript | Python |
| --- | --- | --- |
| Job tasks, `priority`, `project_id`, `params` | `packages/shared/src/jobs.ts` | `queue.py`, migration |
| Provider `location`, `draft` alias | config loader/types where read | `llm/` config models |
| Prepared text and segmentation grid object keys | `storage-keys.ts` | `storage.py` |
| Proposal body (change ops) | `packages/shared` (new) | `worker` (new) |

## Testing

Unit tests stay offline, as the rest of the repo does:

- **Worker:** `FakeProvider`s return canned stage outputs (valid, invalid-then-valid, anchors that
  miss). Context assembly has table-driven tests, including **the holdout exclusion**. Step-cache
  key tests vary each input and assert that only the right steps invalidate. Data-policy
  resolution is tested against local and external providers. `segment` is tested on prepared-text
  fixtures (the recorded PVP OCR fixture already exists).
- **API:** routes via `app.inject()` with `MemoryRepo`; proposal accept and conflict handling;
  admin-only data policy; publish gate with and without override.
- **Web:** stage rail, segmentation grid, proposal diff, using `fakeApi()`.
- **Integration (`dev-infra`):** priority ordering in the claim query; nullable `document_id`
  jobs through cancel, retry and delete.

## Phasing

Each phase is usable on its own.

1. **Foundations:** projects, samples, `prepare`, prepared-text viewer, brief, embedded editor,
   dev test runs; `jobs.priority`; "Open in workbench".
2. **Segmentation:** `segment` task, grid, anchor editing.
3. **Drafting:** context assembly, `draft` alias, provider `location`, data policy, the five stages
   with proposals.
4. **Evaluation loop:** reference proposals and verification, step cache, scorecard, feedback,
   `revise`, iterations.
5. **Holdout and publish:** holdout runs, publish gate, references across versions.
6. **Export/import bundle.**

The most important phases are 2 and 4. If the segmentation preview and the scored loop aren't
fast, users will go back to editing YAML by hand.

## Risks and open questions

- **Anchors overfit the samples.** Mitigations: prefer meaning-based anchors (the drafting
  prompt says so); grid warnings for anchors that match only one sample by a coincidental string;
  holdout catches the rest.
- **Model-proposed references may share the drafter's blind spots.** Verification is mandatory;
  the Review UI should make every value visible, not only the ones flagged.
- **Cost and latency of drafting on a local `draft` model** with several long samples. The
  `survey` stage may need to summarise sample by sample before a combined pass. Measure in
  phase 3.
- **Proposal conflicts** when the user edits the draft while a proposal is pending. The first
  version rejects conflicting changes; per-change rebase can come later.
- Decided in phase 2, on design grounds (real timings are still to be measured): the worker
  wakes on `NOTIFY ih_jobs`; the UI polls the preview every 300 ms.
- **Open:** retention of archived projects and their samples (follow ADR 0005's deletion rules).
