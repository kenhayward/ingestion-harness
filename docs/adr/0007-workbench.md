# 0007: Workbench for drafting and evaluating document types

**Status:** proposed · 2026-10-12 · design: [docs/design/workbench.md](../design/workbench.md)

## Context
New document types are written by hand: section anchors are guessed against OCR output, fields
and prompts are iterated through test runs one document at a time, and nothing measures quality
on documents the author did not tune against. A frontier or capable local model, given the
harness's own extracted text, the format rules and the user's product knowledge, can produce a
good first draft. The harness already has draft templates, test runs, references and regression.
It lacks sample preparation, staged drafting, fast iteration and a held-out measure. Sample
documents may be confidential, and the default models are local for that reason.

## Decision
- **Workbench is the home for drafts.** It embeds the existing `TemplateEditor`. Document types
  becomes the catalogue of published types with "Open in workbench". There is one editor and one
  workflow, for new types and for maintenance.
- **One long-lived project per document type** (`workbench_projects.id` = template id). Samples,
  brief and history carry over from version to version. References used for a published version's
  regression stay pinned to that version.
- **New worker tasks on the existing `jobs` queue:** `prepare` (text and OCR only, stored by
  sha256), `segment` (copies and anchors on prepared text), `draft` (one stage) and `revise`.
  - Project-scoped jobs have `project_id` and a null `document_id`.
  - Task parameters live in `jobs.params`.
  - They get cancel, retry, events and the stale-job reaper for free.
- **Segmentation preview runs in the worker,** never in the browser. Anchors are Python regexes
  (`\A`, a leading `(?i)`) that JavaScript cannot run as written, and the preview must match
  production exactly.
- **Queue priority:** a new `jobs.priority` column. Production jobs (0) are claimed before
  Workbench jobs (negative). The claim query orders by priority, then by the current order.
- **Staged drafting:** `survey` → `outputs` → `sections` → `steps` → `references`.
  - Stages run in order, each needing acceptance before the next is proposed.
  - Any stage can be skipped by writing that part by hand.
  - Re-proposing a stage marks the later ones stale; it never deletes them.
  - Proposals are diffs, accepted per change, and validated like editor saves.
- **Drafting model:** a new alias `draft`, which may resolve to a frontier model or to a slower,
  more capable local model, and can be overridden per project. Model output is validated by the
  template model and cross-reference rules, with errors fed back, rather than constrained by the
  full template schema.
- **Data policy per project, default `local`.**
  - Providers declare `location: local | external`.
  - The worker checks the policy against the *resolved* provider before any call, both for
    drafting and for Workbench test runs.
  - A violation is a configuration error. There is no fallback to another model.
  - Only the **admin token** can switch a project to `external`.
  - Every external call is logged with the stage, model and sample ids sent.
- **Holdout.**
  - Samples are `dev` or `holdout`.
  - A single context-assembly function builds every drafting prompt and the export bundle. It
    never includes holdout text, page images or failure diffs, so `revise` sees dev failures only.
  - Holdout scores and failures are visible to users.
- **References:** the drafting model may propose expected values with evidence. They count in
  scores only after a person verifies them in the Review screen.
- **Step cache** for Workbench test runs only. The key is the sha256 of the step's full input:
  rendered prompt (preamble, instructions, schema), section text, page image hashes, resolved
  model and provider kind, endpoint and options, step id, and upstream `context` values.
  "Re-run uncached" and reference runs bypass the lookup (they still write).
  Production and regression jobs never use it.
- **Publish gate:** a per-project holdout threshold (default 0.9). Publishing below it needs an
  override reason, recorded on the iteration. *Amended:* the gate is now informational.
  References and evaluation are optional, any valid draft can be published (also from the
  Template tab), and no override is needed or recorded; each publication still records the
  gate's iteration and score, if any.

## Consequences
- **Contract changes on both sides:** new job tasks, `priority`, `project_id`, nullable
  `document_id`, `params`, provider `location`, the `draft` alias, new object keys, and the
  proposal body format. One forward-only migration per phase.
- **`prepare_document` is split** so preparation can stop after OCR. Production keeps the composed
  function and behaves the same.
- **Cancel, retry, delete and the reaper must handle project-scoped jobs** (no document). This is
  covered by integration tests.
- **Draft editing leaves the Document types page.** Existing drafts open in a project created on
  demand.
- **The cache trades variance for speed.** Iteration scores on cached steps hide sampling noise;
  local models run at temperature 0, and "Re-run uncached" exists for checking.
- **Visible holdout failures mean the holdout can be tuned against by hand.** The publish gate
  measures the template on unseen documents only to the extent users don't do that.
  `added_for_version` and the iteration history show when samples were relied on.
- **External drafting sends full sample text out of the network.** It is opt-in per project,
  admin-controlled and logged, but once sent it cannot be recalled.
- **Export/import of a drafting bundle** remains for edge cases (air-gapped drafting, another
  deployment) and shares the context assembly, so a bundle is exactly what the in-harness drafter
  would see.
