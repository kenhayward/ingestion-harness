# 0017: Capabilities as nodes, and LangGraph as an optional executor

**Status:** accepted · 2026-10-19. The node contract is in use. The LangGraph executor is a
trial, off by default, and is not to be enabled on a real deployment until the thread prune
below is built.

## Context
CT Studio wants to grow by plugging in new capabilities (new step kinds, other OCR engines,
remote agents) and, later, to be reached by and to reach other agents over A2A
([research](../design/agent-graph-architecture.md)). The worker already ran graphs, but nothing
wrote them down:

- `prepare_document` did five jobs in one call.
- A recipe's steps shared five mutable containers.
- Process, re-run and publish each repeated the same ending.
- A job's status was chosen by catching exceptions around a 14-branch if-chain.
- The data policy was checked at four separate call sites.

A plugin had nothing to implement, and a graph runtime had nothing to run.

Phase 1 of the research made those graphs explicit, with no change in behaviour
([worker-nodes-refactor.md](../design/worker-nodes-refactor.md), PRs #257 to #259). Phase 2
tried LangGraph as an executor over the result ([langgraph-trial.md](../design/langgraph-trial.md)).
This ADR records what both settled.

## Decision

### Capabilities are nodes
- **A node** is a worker function that runs as one step of a job's graph. It takes typed values
  and returns typed values, and it never edits shared state:
  - `read_pages` → `PageText`, `select_pages` → `Selected`, `segment_pages` → `Segmented`;
  - `run_step` → `ExtractionResult`, `normalise_step` → `StepOutcome`;
  - `finalise` → `Finalised`.

  A recipe's steps pass a frozen `DocState` (`apply`, `with_check`).
- **Every built-in node is described** in `ingest_worker/nodes.py` (`NodeSpec`, `NODES`): `id`,
  `version`, `fn`, `output`, `effects` and `egress`.
  - `effects` is `pure` (only events), `cacheable` (only content-keyed caches and the audit
    trail, so it is safe to run again) or `effectful` (results or deliveries, so a replay must be
    idempotent).
  - `egress` is `none`, `model` or `remote`.

  Tests hold each entry to its function. This is the contract a plugin will implement; nothing
  reads `NODES` at run time yet.
- **One way to a model.** `JobModels` (`pipeline.py`) is the only way a node gets a chat, vision
  or OCR provider, and it checks the data policy whenever it resolves one. A source test refuses
  any direct `models.resolve(` outside `llm/`. Plugins and remote nodes will reach models through
  it as well, never through their own clients.
- **One safe point before every node.** `run_nodes` checks for cancellation before each node, so
  a cancelled job still stops at the next step (ADR 0005).
- **Outcomes are values.**
  - A task's handler (`main.TASKS`, which covers exactly the tasks `jobs_task_check` allows)
    returns `Complete`, `AwaitReview` or `Deliver`.
  - `apply_outcome` alone writes the job's status and an unreviewed delivery.
  - `GraphDelivery` is data, not a closure.
  - Errors still raise at the edges and are mapped in one place (`DocumentError` →
    `needs_review`, `JobCancelled`, any other exception → retry).
- **Behaviour is pinned by equivalence traces** (`tests/test_equivalence.py`). Fixed scenarios
  record everything a job does that can be observed: objects, events, queue calls, step runs, and
  model and OCR requests. These records must equal golden files. A refactor that changes a golden
  file is not a refactor; golden files are rewritten only on purpose (`IH_UPDATE_GOLDEN=1`).

### A graph runtime is an executor behind that contract
- **The queue stays in charge.** Postgres claims, priorities, heartbeats, the reaper, retries
  with backoff, cancellation and claim-guarded writes are unchanged (ADR 0001, ADR 0005). A graph
  run happens inside one job's claim, on that job's worker.
- **LangGraph's library, never its server.** The trial uses `langgraph` with
  `langgraph-checkpoint-postgres`, both MIT. The LangGraph Agent Server is not used:
  - its licence key is checked against LangChain's servers at start, which an offline or
    local-only deployment cannot allow;
  - it needs Redis;
  - it would duplicate the queue, sign-in, live progress and the data policy;
  - its A2A endpoint lacks push notifications.

  A2A, when it comes, is a layer in our own API, recorded in its own ADR.
- **Only `step_graph.py` imports LangGraph at run time.** `pipeline.py` and `main.py` import its
  types under `TYPE_CHECKING` only. Replacing the executor (DBOS, our own) touches one module.
- **What the trial runs.** `WORKER_STEP_GRAPH=langgraph` runs a recipe's steps as a LangGraph
  graph with a checkpoint after every step (`durability="sync"`), so a job whose worker stopped
  resumes at the step it stopped at. Unset, the steps run through `run_nodes`. Every equivalence
  scenario runs through both executors against the same golden files.
- **Threads.** A thread is one run of one job:
  `process:<job id>:<hash of recipe, version, model override, source sha256, params>`.
  `step_thread` deletes it once no retry will resume it: the run finished, raised a
  `DocumentError`, was cancelled, or failed on its last attempt. Any other error keeps it.
- **State is JSON-native** (`doc_to_state`). A checkpoint returns tuples as lists, so state is
  stored in one canonical form; page text and PDFs never go into a checkpoint.

### Tracing is always off
`langsmith` is a hard dependency of LangGraph. It traces every run when `LANGSMITH_TRACING` or
`LANGCHAIN_TRACING_V2` is set in the worker's environment, and that would send document text to
LangChain's service. With the guard removed, the trial tried to POST to
`api.smith.langchain.com`. Every LangGraph (or LangChain) run in CT Studio runs inside
`tracing_context(enabled=False)`, and a test with tracing switched on in the environment proves
that no node sees it enabled. Observability stays our own: job events, the runs bucket, logs.

### The checkpoint tables are LangGraph's, in their own schema
- `PostgresSaver.setup()` creates and migrates `checkpoints`, `checkpoint_blobs`,
  `checkpoint_writes` and `checkpoint_migrations` in schema **`langgraph`**
  (`CHECKPOINT_SCHEMA`), on the deployment's own database.
- This is a stated exception to the forward-only `db/migrations` rule (ADR 0014): those files
  own the `public` schema only, and nothing in `public` refers to `langgraph`.
- The schema holds only transient state. Dropping it loses nothing but the ability to resume
  jobs that are in flight.
- Backups (ADR 0015) carry it with the rest of the dump; nothing needs excluding.

### Threads are pruned (to build before enabling)
A thread can outlive its job: the job is deleted, cancelled while no worker held it, or its worker
was killed after its last step. A restore (ADR 0015) also cancels running jobs, and a copy drops
queued and running ones, so the threads it carries become orphans.

The rule: **a thread is kept only while its job is `queued` or `running`.**
- The worker prunes when it starts and then hourly. It lists `thread_id`s in
  `langgraph.checkpoints` whose job (`split_part(thread_id, ':', 2)`) is not a queued or running
  job, in one statement, and deletes each through `PostgresSaver.delete_thread`.
- The prune reads only that one column of LangGraph's tables. It never writes them except
  through the saver's API.
- A retry of a job whose thread was pruned starts its steps afresh. That is what happens today
  without the trial, so the prune can never change a result, only lose a resume.

## Consequences
- New capabilities have a contract (`NodeSpec`, `JobModels`, `StepOutcome`) and a test harness
  (equivalence traces). A recipe step kind backed by `NODES` (`uses:`) is the next step and needs
  no further architecture decision.
- With the trial on, a stopped job no longer repeats the model calls of the steps it finished.
  This matters most for long recipes on slow local models. Production otherwise behaves as before.
- The worker image gains about 20 packages (`langchain-core`, `langsmith`, `ormsgpack`,
  `psycopg-pool` and others).
- **Storage grows with the square of the step count** while a run is in flight, because each
  checkpoint stores the whole `DocState`. One channel per step, merged by a reducer, would make it
  linear, and is also what fan-out of independent steps (`step_inputs`) needs. Until then a very
  large document costs more checkpoint storage, briefly.
- `PostgresSaver.put` uses psycopg pipeline mode, which costs about 44 ms per batch on the Windows
  dev host against Docker (delayed ACKs); a plain round trip is 0.34 ms. This is likely much less
  on the Linux deploy hosts (not measured), and it is small next to a model call either way.
- Preparation still runs again on resume, though OCR comes from the job's pages and the shared
  cache, so no model is called. Moving it into the graph would need its output kept as object-store
  references rather than in checkpoints.
- Enabling the trial anywhere real waits for the prune. Turning it off again is safe: an unset
  flag ignores the schema, and a retry runs its steps afresh.
