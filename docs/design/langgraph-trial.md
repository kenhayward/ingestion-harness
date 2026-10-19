# LangGraph trial (phase 2 of the agent graph research)

Status: **trial, behind a flag (off by default)**, 2026-10-19. This is phase 2 of
[agent-graph-architecture.md](agent-graph-architecture.md) §8. It builds on the explicit nodes
of [worker-nodes-refactor.md](worker-nodes-refactor.md).

## Question

Can LangGraph run a recipe's steps inside the existing job queue, with checkpoints, so that a
job whose worker stops resumes where it stopped? And can it do so without changing anything
else the worker does?

## What was built

- **`worker/src/ingest_worker/step_graph.py`:** a recipe's pipeline as a LangGraph
  `StateGraph`.
  - **Nodes and edges.** Each step is a node (`run_extract`, `run_check` from part 5), and the
    edges follow the pipeline order.
  - **State.** The state is `{doc: DocState}` in a JSON-native form (`doc_to_state` /
    `doc_from_state`).
  - **Checkpoints.** A checkpoint is written after every step (`durability="sync"`), and the
    recursion limit is set to the number of steps (LangGraph stops at 25 by default).
  - **Resume.** `run_steps` resumes a thread that stopped (`invoke(None)`). It reads a finished
    thread back without running anything, and it starts a new thread otherwise.
  - **Threads.** A thread is one run of one job: `process:<job id>:<hash of recipe, version,
    model override, source sha256, params>`. Another model or recipe version therefore starts
    afresh.
  - **Cleanup.** `step_thread` deletes the thread once no retry will resume it: the run
    finished, raised a `DocumentError` (needs review), was cancelled, or failed on its last
    attempt. Any other error keeps it, so the retry resumes after the last finished step.
  - **Cancellation.** The node wrapper checks for cancellation before each step, the same safe
    point `run_nodes` gives.
  - **No tracing.** LangSmith tracing is forced off around every run (`tracing_context(enabled=False)`),
    whatever the environment says. A test proves it.
  - **Postgres.** `postgres_checkpointer(database_url)` gives a `PostgresSaver` on a small
    checked pool. Its tables are in their own schema, `langgraph`, apart from the tables
    `db/migrations` owns.
- **The flag.** `WORKER_STEP_GRAPH=langgraph` (compose, `.env.example`) makes the worker set
  `PipelineDeps.step_checkpointer`. When it is unset, the steps run through `run_nodes` exactly
  as before. The worker logs `steps=langgraph (checkpointed)` or `steps=loop`.
- **What stays as it was.**
  - The queue still claims, heartbeats, retries and cancels jobs.
  - Preparation (conversion, OCR, segmentation) and the ending (`finalise`, `write_drafts`,
    `apply_outcome`) stay outside the graph. On resume, preparation runs again; OCR comes from
    the job's own OCR pages and the shared cache, so no model is called.
  - Legacy `spec.yaml` jobs, step re-runs and publishing are unchanged.
- **Dependencies.**
  - Added: `langgraph` 1.2.16, `langgraph-checkpoint-postgres` 3.2.0, both MIT.
  - These pull in `langchain-core`, `langsmith`, `ormsgpack`, `psycopg-pool` and others; about
    20 packages in `uv.lock`.
  - Python 3.14 works.

## Results against the phase 2 criteria

| Criterion | Result |
| --- | --- |
| Same behaviour as today | **Met.** All 8 equivalence scenarios (part 0) run through both executors against the same golden files: objects, events, queue calls, step runs, model and OCR requests. No thread is left behind. |
| Resume skips finished steps | **Met.** In memory (`test_step_graph.py`), a job that fails after `header` resumes at `date`, and the resumed document equals one produced in one go. **Against real Postgres** (`test_step_graph_integration.py`), a worker *process* hard-killed inside the `date` model call is followed by a new process with a new pool, which calls the model only for `date` and `data`. |
| Cancel still wins | **Met.** A cancel between steps stops before the next step, writes only the `cancelled` event, and deletes the thread. |
| Long recipes | **Met.** A 40-step recipe runs to the end (LangGraph's default limit of 25 is raised to the step count). |
| Data stays here | **Met, with a guard.** With `LANGSMITH_TRACING=true` and the guard removed, LangGraph tried to POST the run to `api.smith.langchain.com` (refused 403: fake key, empty test state). With the guard it makes no call. |

Worker suite: 1,518 passed (the loop and LangGraph executors both covered), and
`mypy --strict` is clean. The integration tests (2) pass against `postgres:17` in Docker.

## Findings

1. **The value is real but narrow, for now.** Resuming saves the model calls of finished steps
   when a worker stops part way (a redeploy, a crash, an outage), and only for production and
   regression jobs, since Workbench test runs already have the step cache. That is worth having
   for long, many-step recipes on slow local models. Most jobs never stop part way.
2. **The refactor made the trial small.** `step_graph.py` is about 200 lines, and
   `process_template_job` changed by about 15. The equivalence traces, `DocState` and
   `run_nodes` from phase 1 did the heavy lifting.
3. **The tracing dependency is a data-policy risk.** `langsmith` is a hard dependency and traces
   whenever `LANGSMITH_TRACING` / `LANGCHAIN_TRACING_V2` is set in the worker's environment, and
   it would send document text. The guard closes this. Any future use of LangGraph (or
   LangChain) must keep it, and the test that proves it.
4. **Storage grows with the square of the step count.** Each checkpoint stores the whole
   `DocState`, so a 20-step run with 200 rows per step wrote about 600 KiB (22 checkpoints, 22
   blobs, 41 writes). Threads are deleted when runs end, so this is transient. For very large
   documents, though, each step should write only its own outcome to its own channel, merged by a
   reducer, which keeps it linear. The same change is what allows independent steps to fan out
   (`step_inputs`).
5. **Checkpoint latency is a Windows dev-host artifact.** `PostgresSaver.put` uses psycopg
   pipeline mode. On this Windows host against Docker that costs about 44 ms per pipeline
   (delayed ACKs; a plain round trip is 0.34 ms), so about 100 ms per step. This is likely much
   less on the Linux deploy hosts (not measured), and it is negligible next to a model call in
   any case.
6. **Schema ownership is split.** `PostgresSaver.setup()` runs LangGraph's own migrations in
   schema `langgraph`. That is outside `db/migrations` and the forward-only rule (ADR 0014).
   Backups (ADR 0015) would carry these tables, which are transient and can be dropped. Both
   are now recorded in [ADR 0017](../adr/0017-capabilities-as-nodes.md).
7. **Some threads can be orphaned.** A thread can outlive its job: a job deleted, or cancelled
   while no worker held it, or a worker killed after its last step. The thread then waits for a
   retry that never comes. **Now pruned:** the worker deletes, at start and hourly, every thread
   whose job is no longer queued or running (`ThreadPruner`, [ADR 0017](../adr/0017-capabilities-as-nodes.md)).
8. **Re-runs still prepare again.** A resumed job re-reads the source and re-segments; OCR comes
   from the caches. Putting preparation inside the graph would need its output (pages,
   sections) kept as object-store references rather than in checkpoints. That was not worth it
   for the trial.

## Recommendation

- **Keep the flag and the code, off by default.**
- **The thread prune (7) is built.** [ADR 0017](../adr/0017-capabilities-as-nodes.md) records 3 and 6
  and the prune's rule: keep a thread only while its job is queued or running.
- **Next for the graph itself:** per-step channels (4), then fan-out of independent steps.
  Fan-out is the second concrete payoff, and the first one the loop cannot give.
- **The decision on LangGraph versus the alternatives** (DBOS, our own executor) can wait.
  Nothing outside `step_graph.py` depends on LangGraph, so swapping the executor stays cheap.

## Running it

```bash
docker run --rm -d --name ih-lg-pg -e POSTGRES_PASSWORD=test -p 55491:5432 postgres:17
```

```bash
IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55491/postgres uv run --directory worker pytest -m integration tests/test_step_graph_integration.py
```

To try it in a stack, set `WORKER_STEP_GRAPH=langgraph` in `deploy/.env`. The worker then
creates schema `langgraph` on start.
