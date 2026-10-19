"""The LangGraph trial (docs/design/langgraph-trial.md): a recipe's steps as a LangGraph graph.

With a checkpointer (`PipelineDeps.step_checkpointer`, set by the worker when
WORKER_STEP_GRAPH=langgraph), each step is a node and the document's state is saved after every
step, so a job that stops part way (an outage, a lost worker) resumes at the step it stopped at:
the steps it finished are not sent to the model again. Without one, the steps run as before
(`run_nodes`). Either way a cancelled job stops before its next step.

The graph runs inside the job's claim, like everything else: the queue still decides who runs
what, retries and cancels. A thread holds one run of one job (`thread_key`: the job, its recipe
version, model override, source file and params); it is deleted once the run ends in a way no
retry will resume from (finished, a document problem, cancelled, failed on its last attempt),
and kept after any other error so the retry picks it up.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Callable, Collection, Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any, Protocol, TypedDict

from langgraph.graph import END, START, StateGraph
from langsmith import tracing_context

from .errors import DocumentError
from .pipeline import JobCancelled, check_cancelled, run_nodes
from .queue import ClaimedJob, JobQueue
from .template_pipeline import DocState

if TYPE_CHECKING:
    from langchain_core.runnables import RunnableConfig
    from langgraph.checkpoint.base import BaseCheckpointSaver

log = logging.getLogger("ingest_worker")

#: Set to "langgraph" to run recipes' steps through LangGraph with checkpoints.
STEP_GRAPH_ENV = "WORKER_STEP_GRAPH"

StepNode = Callable[[DocState], DocState]


def step_graph_enabled(env: Mapping[str, str]) -> bool:
    return env.get(STEP_GRAPH_ENV, "").strip().lower() == "langgraph"


class StepGraphState(TypedDict):
    #: The DocState, JSON-native (doc_to_state): what each checkpoint holds.
    doc: dict[str, Any]


def doc_to_state(state: DocState) -> dict[str, Any]:
    """A DocState as checkpoints keep it: lists, never tuples (they come back as lists)."""
    return {
        "fields": state.fields,
        "tables": state.tables,
        "checks": state.checks,
        "issues": list(state.issues),
        "step_results": state.step_results,
        "models": state.models,
    }


def doc_from_state(stored: Mapping[str, Any]) -> DocState:
    return DocState(
        fields=dict(stored["fields"]),
        tables=dict(stored["tables"]),
        checks=dict(stored["checks"]),
        issues=tuple(stored["issues"]),
        step_results=dict(stored["step_results"]),
        models=dict(stored["models"]),
    )


def thread_key(job: ClaimedJob, template_id: str, version: int, source_sha256: str) -> str:
    """The thread of one run of a job: anything that changes what its steps would return (the
    recipe version, the model override, the source file, the params) is another thread."""
    what = [template_id, version, job.model_override, source_sha256, job.params]
    digest = hashlib.sha256(json.dumps(what, sort_keys=True, default=str).encode()).hexdigest()
    return f"process:{job.id}:{digest[:16]}"


def run_steps(
    job: ClaimedJob,
    queue: JobQueue,
    checkpointer: BaseCheckpointSaver[Any] | None,
    key: str,
    nodes: Sequence[tuple[str, StepNode]],
    start: DocState,
) -> DocState:
    """The state after `nodes` (step id, node), resuming thread `key` where it stopped."""
    if checkpointer is None:
        return run_nodes(job, queue, [node for _, node in nodes], start)
    if not nodes:
        return start
    graph = StateGraph(StepGraphState)
    previous = START
    for name, node in nodes:
        graph.add_node(name, _checkpointed(job, queue, node))
        graph.add_edge(previous, name)
        previous = name
    graph.add_edge(previous, END)
    app = graph.compile(checkpointer=checkpointer)
    config: RunnableConfig = {
        "configurable": {"thread_id": key},
        "recursion_limit": len(nodes) + 1,  # one superstep per step
    }
    # Never traced to LangSmith, whatever the environment says: document text stays here.
    with tracing_context(enabled=False):
        saved = app.get_state(config)
        if saved.values and not saved.next:
            values = saved.values  # finished before (a crash after the steps): nothing to run
        else:
            begin = None if saved.next else StepGraphState(doc=doc_to_state(start))
            values = app.invoke(begin, config, durability="sync")
    return doc_from_state(values["doc"])


@contextmanager
def step_thread(
    checkpointer: BaseCheckpointSaver[Any] | None, key: str, *, last_attempt: bool
) -> Iterator[None]:
    """Delete thread `key` once the run ends in a way no retry will resume from: it finished,
    it is a document problem (needs review), it was cancelled, or it failed on its last
    attempt. Any other error keeps it: the retry resumes after the last finished step."""
    if checkpointer is None:
        yield
        return
    try:
        yield
    except (DocumentError, JobCancelled):
        checkpointer.delete_thread(key)
        raise
    except Exception:
        if last_attempt:
            checkpointer.delete_thread(key)
        raise
    checkpointer.delete_thread(key)


class _GraphNode(Protocol):
    """A LangGraph node: called with the state by name."""

    def __call__(self, state: StepGraphState) -> StepGraphState: ...


def _checkpointed(job: ClaimedJob, queue: JobQueue, node: StepNode) -> _GraphNode:
    def run(state: StepGraphState) -> StepGraphState:
        check_cancelled(job, queue)  # the safe point run_nodes gives every node
        return StepGraphState(doc=doc_to_state(node(doc_from_state(state["doc"]))))

    return run


#: The schema LangGraph's checkpoint tables live in, apart from CT Studio's own tables (which
#: db/migrations owns): PostgresSaver.setup() creates and migrates them itself.
CHECKPOINT_SCHEMA = "langgraph"


def postgres_checkpointer(database_url: str) -> tuple[BaseCheckpointSaver[Any], Callable[[], None]]:
    """A Postgres checkpointer on its own small pool (connections are checked before use, so a
    database restart is ridden out), its tables set up in CHECKPOINT_SCHEMA; and its closer."""
    import psycopg
    from langgraph.checkpoint.postgres import PostgresSaver
    from psycopg.rows import DictRow, dict_row
    from psycopg_pool import ConnectionPool

    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f"CREATE SCHEMA IF NOT EXISTS {CHECKPOINT_SCHEMA}")
    pool: ConnectionPool[psycopg.Connection[DictRow]] = ConnectionPool(
        database_url,
        min_size=1,
        max_size=2,
        open=True,
        check=ConnectionPool.check_connection,
        connection_class=psycopg.Connection[DictRow],
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
            "options": f"-c search_path={CHECKPOINT_SCHEMA}",
        },
    )
    saver = PostgresSaver(pool)
    saver.setup()
    return saver, pool.close


# --- the thread prune (ADR 0017) ------------------------------------------------------------

#: How often the worker prunes step graph threads (also once when it starts).
PRUNE_EVERY_S = 3600.0
THREAD_PREFIX = "process:"

#: Thread ids (in any of LangGraph's tables) of step graph threads whose job is not queued or
#: running: deleted, finished, cancelled while no worker held it, or ended by a restore. Only the
#: `thread_id` columns of LangGraph's tables are read; deletes go through the saver.
ORPHANS_SQL = f"""
SELECT t.thread_id
FROM (
    SELECT thread_id FROM {CHECKPOINT_SCHEMA}.checkpoints
    UNION SELECT thread_id FROM {CHECKPOINT_SCHEMA}.checkpoint_writes
    UNION SELECT thread_id FROM {CHECKPOINT_SCHEMA}.checkpoint_blobs
) t
WHERE t.thread_id LIKE '{THREAD_PREFIX}%'
  AND NOT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id::text = split_part(t.thread_id, ':', 2) AND j.status IN ('queued', 'running')
  )
ORDER BY 1
"""


def orphaned_threads(thread_ids: Iterable[str], live_jobs: Collection[str]) -> list[str]:
    """The step graph threads (ids from `thread_key`) whose job is not in `live_jobs` (the
    queued and running jobs), sorted; anything else is left alone. ORPHANS_SQL, in memory."""
    return sorted(
        {t for t in thread_ids if t.startswith(THREAD_PREFIX) and t.split(":")[1] not in live_jobs}
    )


def pg_orphaned_threads(database_url: str) -> list[str]:
    """ORPHANS_SQL on the deployment's database: one statement, one snapshot of the jobs."""
    import psycopg

    with psycopg.connect(database_url, autocommit=True) as conn:
        return [row[0] for row in conn.execute(ORPHANS_SQL)]


def prune_threads(
    checkpointer: BaseCheckpointSaver[Any], find_orphans: Callable[[], Sequence[str]]
) -> int:
    """Delete every orphaned thread; how many. A retry of a job whose thread was pruned runs
    its steps afresh, as without the trial: a prune can lose a resume, never change a result."""
    orphans = find_orphans()
    for thread_id in orphans:
        checkpointer.delete_thread(thread_id)
    return len(orphans)


class ThreadPruner:
    """Prunes when the worker starts (the first tick) and then every PRUNE_EVERY_S. A failure
    (a database outage) is logged and waits for the next hour: it never stops the worker."""

    def __init__(
        self,
        checkpointer: BaseCheckpointSaver[Any],
        find_orphans: Callable[[], Sequence[str]],
        *,
        every_s: float = PRUNE_EVERY_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.checkpointer = checkpointer
        self.find_orphans = find_orphans
        self.every_s = every_s
        self.clock = clock
        self.next_at: float | None = None

    def tick(self) -> None:
        now = self.clock()
        if self.next_at is not None and now < self.next_at:
            return
        self.next_at = now + self.every_s
        try:
            pruned = prune_threads(self.checkpointer, self.find_orphans)
        except Exception:
            log.warning(
                "could not prune step graph threads; trying again in an hour", exc_info=True
            )
            return
        if pruned:
            log.info(
                "pruned %d step graph threads whose job is no longer queued or running", pruned
            )
