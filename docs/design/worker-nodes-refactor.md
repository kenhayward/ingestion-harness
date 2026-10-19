# Worker nodes refactor (phase 1 of the agent graph research)

Status: **in progress**, started 2026-10-19. Phase 1 of
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

- `DocState` (frozen): `fields`, `tables`, `checks`, `issues`, `step_results`, `models`.
- `StepOutcome`: one step's normalised values, its issues and the model it ran on.
- `normalise_step(template, step, data) -> StepOutcome` replaces `_normalise_step`, which edited
  its arguments in place.
- `DocState.apply(outcome) -> DocState`. The loop becomes
  `state = state.apply(run_step(state, step))`.
- `context_values(state, step)` reads upstream values from the state. The steps a step reads
  become a recorded dependency (`step_inputs(template, step)`), which later allows fan-out.
- `document_of(state, …)` builds the draft `document.json` in one place. A re-run builds its
  `DocState` from the stored draft (`DocState.from_document`).

## Part 3: one ending for process, re-run and publish

`finalise(job, deps, queue, template, document, mode) -> Finalised`, where `mode` is one of
`draft`, `rerun` or `publish`. It builds the graph, runs the SHACL check (the advisory-or-blocking
rule depends on `mode` and on whether `rdf` is delivered), adds the report to the issues and
reasons, and renders the outputs. Writing the drafts stays with the caller, because a publish
never writes drafts. The three copies of this sequence go.

## Part 4: outcomes as values

- `Outcome` is one of:
  - `AwaitReview(outputs, reasons)`;
  - `Deliver(outputs, formats, graph: GraphDelivery | None, target)`, where `GraphDelivery` is
    data (the document, its graph and the template) instead of a closure;
  - `Complete(outputs)`;
  - `NeedsReview(reason)`.
- `TASKS: dict[str, TaskHandler]` replaces the if-chain. Each handler is
  `(job, deps, queue) -> Outcome`, and `apply_outcome(job, outcome, queue, deps)` performs the
  status writes, including delivering outputs and then the graph, in today's order.
- Errors still raise at the edges (`DocumentError`, `JobCancelled`, infrastructure errors).
  `_run_claimed` keeps the one `try` that maps them, but it no longer decides anything else.
  `ShapesViolated` becomes `AwaitReview` returned by the publish handler.

## Part 5: node descriptions, one data-policy gate, one cancellation runner

- `NodeSpec` (id, version, input and output types, `effects`: pure, cacheable or effectful,
  `egress`: none, model or remote, safe points) for every built-in node, in a `NODES` registry.
  The registry is listed nowhere yet; it is the shape plugins will follow (phase 3).
- `JobModels`: a per-job view of the `ModelRegistry` that enforces the data policy whenever it
  resolves a model (extraction, OCR, re-run, drafting). It replaces the four
  `enforce_data_policy` calls, so a node cannot get a provider without the check.
- `run_nodes(job, queue, nodes, state)`: a sequential runner that calls `check_cancelled` before
  each node. The in-call `checkpoint=` hooks (OCR pages, drafting turns) stay as they are.

## Out of scope for phase 1

- Drafting conversations, the mapping stage and housekeeping jobs. They only move into `TASKS`.
- The API, the web, migrations, and anything on the TypeScript side.
- Parallel steps, checkpoints and LangGraph. These are phase 2, which this refactor makes possible.

## Progress

| Part | State |
| --- | --- |
| 0 equivalence traces | done: `worker/tests/test_equivalence.py`, 7 scenarios |
| 1 split `prepare_document` | done: `read_pages`, `select_pages`, `segment_pages` (`tests/test_prepare_nodes.py`); Workbench `prepare` uses `read_pages` |
| 2 `DocState` | — |
| 3 `finalise` | — |
| 4 outcomes and `TASKS` | — |
| 5 `NodeSpec`, `JobModels`, `run_nodes` | — |
