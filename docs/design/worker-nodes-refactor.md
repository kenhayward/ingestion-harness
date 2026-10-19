# Worker nodes refactor (phase 1 of the agent graph research)

Status: **done** (parts 0-5), 2026-10-19. Phase 1 of
[agent-graph-architecture.md](agent-graph-architecture.md) §8: turn the graph hidden in the
worker into explicit nodes, **with no framework and no change in behaviour**. Each part below
is one PR; parts can land independently, in the order given.

## Why do this before choosing a runtime

The research found that the worker already runs graphs, but they are implicit:

- `prepare_document` ([pipeline.py](../../worker/src/ingest_worker/pipeline.py)) does five
  separate jobs in one call: convert, read the text layer and check the page count, OCR, select
  the copy and add page markers, and segment. Workbench `prepare` re-implements its first half.
- The step loop in `process_template_job`
  ([template_pipeline.py](../../worker/src/ingest_worker/template_pipeline.py)) shares five
  mutable containers (`fields`, `tables`, `checks`, `issues`, `step_results`).
  `_normalise_step` and `add_report` edit them in place.
- `process`, `rerun` and `publish` each repeat the same ending: build the graph, check it
  against the SHACL shapes, add the report, render and write.
- `main._run_claimed` ([main.py](../../worker/src/ingest_worker/main.py)) chooses a job's status
  by catching exceptions (`DocumentError`, `JobCancelled`, `ShapesViolated`) around a 14-branch
  if-chain. `ProcessResult.deliver_graph` is a closure.
- `enforce_data_policy` is called from four places. `check_cancelled` is called wherever someone
  remembered to call it.

Every graph runtime (LangGraph, DBOS, or one of our own) needs the same four things: nodes with
typed inputs and outputs, state that is passed from node to node rather than shared, outcomes
that are values, and a single place for policy and cancellation. Doing this first:

- keeps the runtime choice open;
- removes duplicated code;
- turns a step re-run into a resume from one step;
- gives plugins a contract to implement.

## Ground rules

1. **No behaviour change.** Same database writes, statuses, task kinds, object keys, events,
   prompts and outputs. A behaviour difference found along the way is written down here and
   fixed in its own PR, never folded into a refactor.
2. **An equivalence net first** (part 0). It runs before and after every part.
3. **The existing suite stays green and is not weakened.** About 1,400 worker tests, mostly
   behavioural through `run_once` with fakes. They are the primary net.
4. Each part ends with `npm run worker:lint` (ruff, ruff format, `mypy --strict`) and
   `npm run worker:test` green.

## Part 0: equivalence traces

`worker/tests/test_equivalence.py` runs fixed scenarios through `run_once` with fakes and
compares a **trace** with a golden file in `worker/tests/fixtures/equivalence/`. A trace
records:

- every object written, per bucket and target: JSON parsed, text kept, binary as a sha256;
- every job event, with its data;
- every queue call (drafts, awaiting review, needs review, failed, completed, published) and
  every step run;
- every model request (system, prompt, schema name, image hashes) and every OCR request.

Wall-clock values (ISO timestamps, `seconds`) are replaced with placeholders. Everything else
must match exactly.

Scenarios:

| Scenario | Covers |
| --- | --- |
| `template-review-rerun-publish` | mapped recipe with review: process → awaiting review → step re-run → publish with an edit; graph registry and store; publishing target |
| `template-delivered` | mapped recipe that is never reviewed: process → delivered with its graph |
| `template-ocr` | a page with no text layer goes through OCR, then extraction |
| `spec-copies` | a legacy `spec.yaml` job with copy selection |
| `workbench-prepare` | a Workbench `prepare` job with one OCR page |

Golden files are rewritten only on purpose (`IH_UPDATE_GOLDEN=1`). A refactor PR that changes
one is not a refactor.

## Part 1: split `prepare_document` into nodes

New functions in `pipeline.py`, each one a future graph node:

| Node | Input → output | Takes over |
| --- | --- | --- |
| `load_source` (exists) | job → `Source` | inbox read, .docx conversion |
| `read_pages` | `Source`, OCR mode, expected page range → `PageText` (`layer`, `pages`) | text layer, `prepare progress` events, page-count check, `ocr_pages` |
| `select_pages` | page texts, layout → `Selected` (`pages`, `first`) | copy selection and its event, "no extractable text", page markers |
| `segment_pages` | `Selected`, layout → segmented sections | `segment_occurrences`, missing sections, the `segmented` event |

`prepare_document` becomes their composition, so its callers do not change. Workbench `_prepare`
uses `read_pages` with its own text-layer reader (password and corrupt PDFs are `PrepareFailed`).
It reads its OCR page numbers from `PageText.layer`, the text layer before OCR, instead of
computing them before the call.

**Difference found (not changed here):** a password-protected or unreadable PDF goes to review
in Workbench `prepare` (`PrepareFailed`), but in `process` the pypdf error is an ordinary
exception, so the job is retried `max_attempts` times before it fails. Proposed fix, in its own
PR: let `read_pages` always use the Workbench reader.

## Part 2: state passed between steps, not shared

- `DocState` (frozen): `fields`, `tables`, `checks`, `issues` (a tuple), `step_results`,
  `models`. `apply` and `with_check` return a new state, and a step run again replaces its
  values where they were.
- `StepOutcome`: one step's normalised result (as checks read it), its fields or table, its
  issues (normalisation, then rows missing their key) and the model it ran on.
- `normalise_step(template, step, data, model) -> StepOutcome` replaces `_normalise_step`,
  which edited its arguments in place. It also takes in `key_column_issues`, which the loop used
  to add separately.
- The process loop is `state = state.apply(normalise_step(…, _run_step(…, state, …).data, …))`.
  `_run_step` reads the earlier steps' values from the state.
- `step_inputs(template, step)` lists the steps a step reads through its `context`: its
  dependencies, which later allow fan-out. A valid recipe fills each output with exactly one step,
  and a context names only outputs filled by earlier steps, so each input has a single writer.
- A re-run builds its state from the stored draft (`DocState.from_document`), drops the step's
  own and the SHACL issues, and applies the new outcome. Building the draft `document.json` from
  a state (`document_of`) moves to part 3, with the rest of the ending.

## Part 3: one ending for process, re-run and publish

- `document_of(job, doc, template, state, reasons)` builds the draft `document.json` from a state
  in one place.
- `finalise(job, deps, queue, template, document, *, mode) -> Finalised` (`document`, `graph`,
  `outputs`, and `reasons`, the document's own list). It builds the graph, runs the shapes check
  and renders the outputs. There are two modes:
  - `draft` covers an extraction and a step re-run, which behave the same here. The report's
    violations become review reasons and its warnings issues, and the document is updated.
  - `publish` leaves the reviewed document as it is. A delivered graph that violates the shapes
    raises `ShapesViolated`, and a graph that is not delivered is checked only when its shapes
    can be read.
- `write_drafts(deps, outputs)` puts the outputs in the outputs bucket. Process and re-run call
  it; a publish never writes drafts.
- The three copies of build graph → shapes → report → render → write are gone.

## Part 4: outcomes as values

- `ingest_worker/outcomes.py`: `Outcome` is one of
  - `Complete(outputs, note)`;
  - `AwaitReview(outputs, reasons, drafts=True, note)`. With `drafts`, the outputs are recorded
    as drafts and the job stops at a safe point if it was cancelled. A refused publish passes
    `drafts=False`, because it wrote nothing;
  - `Deliver(outputs, delivered, target, graph)`, an extraction that needs no review.
- `apply_outcome(job, outcome, queue, deps)` is the only place that writes a job's status. For
  `Deliver`, it also makes the delivery in today's order: drafts, then the safe point, then the
  outputs to the target, the publication record and the graph, then complete.
- `GraphDelivery(template, document, graph)` replaces the `ProcessResult.deliver_graph` closure
  (`ProcessResult.graph`, `GraphDelivery.deliver`).
- `main.TASKS: dict[str, TaskHandler]` replaces the 14-branch if-chain. Each handler is
  `(job, deps, queue) -> Outcome`: `handle_process`, `handle_publish`, `handle_rerun`, and
  `_completes(run, note)` for the tasks that only succeed. A test checks that `TASKS` covers
  exactly the tasks the newest `jobs_task_check` migration allows.
- `_run_claimed` is now the handler, `apply_outcome`, and the one `try` that maps errors.
- **Changed from the plan:** there is no `NeedsReview` outcome. `DocumentError`, `JobCancelled`
  and outages are raised deep inside nodes, and they still map to a status in that one place.
  A publish still delivers inside its handler (`publish_template_job`) and returns `Complete`.
  `ShapesViolated` becomes an `AwaitReview` returned by the publish handler.

## Part 5: one data-policy gate, one cancellation runner, node descriptions

- `JobModels(job, registry)` (`pipeline.py`) is the only way to get a chat, vision or OCR
  provider:
  - `resolve(ref, what=…)` and `resolve_ocr(ref, what=…)` check the data policy before
    returning. With `what`, a ref that does not resolve becomes a `DocumentError` naming its use,
    such as `extraction 'header'`, `OCR model`, `re-run of 'header'` or `drafting model`; the
    messages are the same as before.
  - `allow(provider, ref)` checks a provider resolved elsewhere.
  - It replaces `enforce_data_policy` and its four calls: extraction, OCR, step re-run and
    drafting. The offline `mapping_eval` uses it too.
  - A source test fails if any module outside `llm/` calls `models.resolve(` or
    `models.resolve_ocr(` directly. Embeddings keep their own location checks in the mapping stage.
- `run_nodes(job, queue, nodes, state)` runs nodes in order with a safe point before each one.
  The recipe's step loop is now a list of nodes (`run_check`, `run_extract`) run by it, which
  gives the same safe points as before. `_run_step` is now `run_step`.
- `ingest_worker/nodes.py`: `NodeSpec` describes a node:
  - `id`, `version`, `fn` and `output`;
  - `effects`: `pure`, `cacheable` (writes only content-keyed caches and the audit trail, so it
    is safe to run again) or `effectful` (writes results or deliveries, so a replay must be
    idempotent);
  - `egress`: `none`, `model` or `remote`;
  - `cancels_inside` and `summary`.

  `NODES` lists the eleven built-ins, from `source.load` to `graph.deliver`. Tests check each
  entry's `output` against its function's return annotation, that only `read.pages` and
  `extract.step` reach a model, and that only the three writers are effectful. Nothing reads
  `NODES` at run time yet: it is the contract plugins will follow (phase 3).

## Out of scope for phase 1

- Drafting conversations, the mapping stage and housekeeping jobs. They only move into `TASKS`.
- The API, the web, migrations, and anything on the TypeScript side.
- Parallel steps, checkpoints and LangGraph. These are phase 2, which this refactor makes possible.

## Progress

| Part | State |
| --- | --- |
| 0 equivalence traces | done: `worker/tests/test_equivalence.py`, 7 scenarios |
| 1 split `prepare_document` | done: `read_pages`, `select_pages`, `segment_pages` (`tests/test_prepare_nodes.py`); Workbench `prepare` uses `read_pages` |
| 2 `DocState` | done: `DocState`, `StepOutcome`, `normalise_step`, `step_inputs` (`tests/test_doc_state.py`); process and re-run use them |
| 3 `finalise` | done: `document_of`, `finalise`, `write_drafts` (`tests/test_finalise.py`); process, re-run and publish use them |
| 4 outcomes and `TASKS` | done: `outcomes.py`, `GraphDelivery`, `main.TASKS` (`tests/test_outcomes.py`) |
| 5 `NodeSpec`, `JobModels`, `run_nodes` | done: `JobModels`, `run_nodes`, `nodes.py` (`tests/test_nodes.py`) |

### After the refactor: delivery through the bridge

The delivery bridge ([ADR 0017](../adr/0017-delivery-bridge.md), phase 2) changed behaviour on
purpose, so two golden files were rewritten with it (`template-review-rerun-publish`,
`template-delivered`). Their traces now end in `delivering` (with the bridge's delivery ids)
instead of `completed`. Every object written, at the store and at the target, is unchanged: the
bridge writes the same keys. In `outcomes.py`, `Deliver` hands one package to the bridge
(`deliver_document`) instead of writing the target itself. A new outcome, `Delivering`, is
returned by publish and republish once the bridge has accepted something. Both leave the job
`delivering` until the bridge's events finish it.

