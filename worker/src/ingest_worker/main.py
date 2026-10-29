from __future__ import annotations

import contextlib
import functools
import logging
import os
import signal
import threading
import time
from collections.abc import Callable
from dataclasses import replace
from typing import TYPE_CHECKING, Any, Protocol

import httpx
import psycopg

from .bridge.client import HttpBridgeClient
from .bridge.package import Delivered, record_delivered
from .bundle import run_export
from .call_slots import PgCallSlots
from .config import Settings
from .convert import GotenbergConverter
from .decompose.dispatch import LANE_DISPATCH_S, dispatch_lanes
from .decompose.items import PgItemStore
from .decompose.job import DecompositionStores, decompose_deps, run_decompose
from .decompose.lanes import PgLaneStore
from .decompose.pdf.layout import layout_analyser
from .decompose.register import PgRegisterStore
from .drafting import run_draft
from .embeddings import run_embed
from .graph_preview import run_graph_preview
from .graph_registry import PgGraphRegistry
from .heartbeat import HEARTBEAT_S, JobHeartbeat, PgJobHeartbeat, beating
from .linked_data import PgLinkedDataSettings
from .llm.endpoints import LiveModels, PgLlmConfigStore, seed_from_config
from .llm.registry import LLMConfig, load_llm_config
from .mapping_memory import PgMappingMemoryStore
from .ocr import OcrSettings
from .ontology import PgOntologyStore, run_ontology_import
from .ontology_fetch import FetchPolicy, fetch_rdf
from .ontology_suggest import run_suggest
from .outcomes import (
    AwaitReview,
    Complete,
    Deliver,
    Delivering,
    Outcome,
    TaskHandler,
    apply_outcome,
)
from .outputs import RenderedOutput
from .pdf import extract_pages
from .pipeline import (
    Buckets,
    DocumentError,
    JobCancelled,
    PipelineDeps,
    Target,
    check_cancelled,
    load_definition,
    process_job,
)
from .plugin_catalogue import PgPluginCatalogue, catalogue_rows
from .plugin_preview import run_plugin_preview
from .plugins import plugins
from .publish_targets import (
    LiveTargets,
    PgPublishTargetStore,
    TargetNotSynced,
)
from .queue import ClaimedJob, JobQueue, PgJobQueue
from .rdf_rebuild import PgRebuildSource, run_rebuild_job
from .specs import LoadedTemplate, SpecRegistry, load_specs
from .step_graph import (
    ThreadPruner,
    pg_orphaned_threads,
    postgres_checkpointer,
    step_graph_enabled,
)
from .storage import S3ObjectStore
from .template_pipeline import (
    PUBLISH_REFUSED,
    PUBLISH_REFUSED_FOR_A_PERSON,
    BackToReview,
    ShapesViolated,
    publish_template_job,
    rerun_template_job,
)
from .version import app_version
from .withdrawal import run_republish, run_withdraw
from .workbench import prepare_sample, run_segment

if TYPE_CHECKING:
    from langgraph.checkpoint.base import BaseCheckpointSaver

log = logging.getLogger("ingest_worker")

#: How often the worker checks whether the stored LLM config changed (ADR 0010).
CONFIG_CHECK_S = 5.0

#: After a lost database connection (a restore's swap, a Postgres restart), the wait before
#: every connection is opened again.
RECONNECT_S = 5.0

#: Review reason for a reference run (`params.forceReview`) that needed no review of its own.
FORCE_REVIEW_REASON = "reference run: verify the values, then approve and save as a reference"


def run_once(
    queue: JobQueue,
    deps: PipelineDeps,
    worker_id: str,
    heartbeat: JobHeartbeat | None = None,
    heartbeat_s: float = HEARTBEAT_S,
    after: Callable[[ClaimedJob], None] | None = None,
) -> bool:
    """Claim and run one job (any task: process, publish, rerun, prepare, segment, draft,
    export, ontology, graph, suggest, embed, withdraw, republish, rebuild or decompose),
    beating its heartbeat while it runs (heartbeat.py), then `after(job)`. Nothing is claimed
    while the queue is paused. Returns False when the queue is empty."""
    job = queue.claim(worker_id)
    if job is None:
        return False
    log.info("claimed %s job %s (attempt %d/%d)", job.task, job.id, job.attempts, job.max_attempts)
    if job.attempts > job.max_attempts:
        # Only the reaper does this: a job whose worker stopped (e.g. a redeploy) is re-queued
        # whatever its attempts, so a long job is never lost to restarts.
        log.warning(
            "job %s is on attempt %d of %d: its worker stopped while running it and it was "
            "re-queued",
            job.id, job.attempts, job.max_attempts,
        )  # fmt: skip
    if heartbeat is None:
        _run_claimed(job, queue, deps)
    else:

        def lost() -> None:
            log.warning("job %s is no longer this worker's: it stops at its next check", job.id)

        with beating(lambda: heartbeat.beat(job), heartbeat_s, on_lost=lost):
            _run_claimed(job, queue, deps)
    if after is not None:
        after(job)
    return True


def lane_round(deps: PipelineDeps, queue: JobQueue) -> int:
    """Give the conversions' free lanes to waiting documents (decompose/dispatch.py); the jobs
    queued. Advisory: a failure is logged, the next round tries again."""
    stores, targets = deps.decomposition, deps.targets
    if stores is None or targets is None:
        return 0
    try:
        queued = dispatch_lanes(stores.lanes, targets, queue, stores.items)
    except Exception:
        log.warning("lane dispatch failed", exc_info=True)
        return 0
    if queued:
        log.info("lanes: queued %d waiting documents", queued)
    return queued


def handle_process(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Outcome:
    """Extract (a recipe or a legacy spec): to review, else delivered at once."""
    result = process_job(job, deps, queue)
    reasons = result.review_reasons
    if not reasons and (job.params or {}).get("forceReview"):
        reasons = [FORCE_REVIEW_REASON]
    if reasons:
        return AwaitReview(result.outputs, reasons)
    # The target was resolved before extraction (None: a test run, or no targets).
    return Deliver(
        result.outputs,
        result.delivered(),
        result.targets,
        result.graph,
        document=result.document,
        template=result.template,
    )


def handle_publish(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Outcome:
    """An approved review: apply the edits and deliver (publish_job)."""
    check_cancelled(job, queue)
    deliveries: list[tuple[str, str]] = []

    def record(targets: list[Target], delivered: Delivered) -> None:
        # Test runs never get here.
        record_delivered(queue, job, delivered, targets)
        deliveries.extend(delivered.deliveries)

    try:
        published = publish_job(job, deps, queue, record)
    except ShapesViolated as refused:
        # Nothing was delivered: the reviewer fixes the values and approves again.
        queue.event(job.id, "warn", PUBLISH_REFUSED, {"reasons": refused.reasons})
        return AwaitReview([], refused.reasons, drafts=False, note="publish refused")
    except BackToReview as refused:
        # Nothing was delivered: a person adds their connection (or a name) and approves again.
        queue.event(job.id, "warn", PUBLISH_REFUSED_FOR_A_PERSON, {"reason": refused.reason})
        return AwaitReview(
            [],
            [refused.reason],
            drafts=False,
            note="publish refused",
            connection_needed=refused.connection,
        )
    if not deliveries:
        return Complete(note=f"published {len(published)} outputs")  # a test run
    return Delivering([], deliveries, note=f"handed {len(published)} outputs to the bridge")


def handle_rerun(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Outcome:
    """A reviewer's step re-run: the draft goes back to review."""
    loaded = load_definition(job, deps, queue)
    if not isinstance(loaded, LoadedTemplate):
        raise DocumentError("only documents run by a recipe can re-run steps")
    rerun = rerun_template_job(job, deps, queue, loaded)
    step = (job.rerun or {}).get("step")
    return AwaitReview(rerun.outputs, rerun.review_reasons, note=f"re-ran {step}, back in review")


def handle_republish(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Outcome:
    """Deliver a re-enabled type's withdrawn jobs again; the bridge's events finish the job."""
    deliveries = run_republish(job, deps, queue)
    if not deliveries:
        return Complete(note="re-delivered 0 jobs")
    return Delivering([], deliveries, note=f"handed {len(deliveries)} deliveries to the bridge")


def handle_decompose(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Outcome:
    """Decompose and deliver one conversion batch item (decompose/job.py); a delivered one
    waits for the bridge's events, which settle the item and finish the job."""
    return run_decompose(job, decompose_deps(deps, queue))


def handle_rebuild(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Outcome:
    """Rebuild, backfill or re-mint the triple store; the bridge's events finish the job."""
    lines, deliveries = run_rebuild_job(job, deps, queue)
    if not deliveries:
        return Complete(note=lines[-1])
    return Delivering([], deliveries, note=lines[-1])


def _completes[R](
    run: Callable[[ClaimedJob, PipelineDeps, JobQueue], R], note: Callable[[R], str]
) -> TaskHandler:
    """A task that succeeds with no outputs of its own once `run` returns."""

    def handle(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Outcome:
        return Complete(note=note(run(job, deps, queue)))

    return handle


#: How long a job waits for a target the API has not synced yet.
TARGET_SYNC_WAIT_S = 15
#: How long a job waits for a target sync in all (jobs.waiting_since) before it fails.
TARGET_SYNC_MAX_WAIT_S = 1800


#: Every task's handler, by `jobs.task` (the database's jobs_task_check lists the same tasks).
TASKS: dict[str, TaskHandler] = {
    "process": handle_process,
    "publish": handle_publish,
    "rerun": handle_rerun,
    "prepare": _completes(prepare_sample, lambda t: f"prepared {t['pageCount']} pages"),
    "segment": _completes(run_segment, lambda g: f"segmented {len(g['samples'])} samples"),
    "draft": _completes(run_draft, lambda r: f"drafted stage {r['stage']} with {r['model']}"),
    "export": _completes(run_export, lambda m: f"exported {len(m['samples'])} samples"),
    "graph": _completes(run_graph_preview, lambda p: f"previewed {len(p['samples'])} graphs"),
    "plugin": _completes(run_plugin_preview, lambda r: f"previewed plugin step {r['stepId']}"),
    "suggest": _completes(run_suggest, lambda s: f"suggested {len(s['suggestions'])} ontologies"),
    "embed": _completes(run_embed, lambda n: f"embedded {n} terms"),
    "withdraw": _completes(run_withdraw, lambda w: "withdrew {} objects, {} graphs".format(*w)),
    "republish": handle_republish,
    "rebuild": handle_rebuild,
    "decompose": handle_decompose,
    "ontology": _completes(run_ontology_import, lambda p: f"indexed {len(p.terms)} ontology terms"),
}


def _run_claimed(job: ClaimedJob, queue: JobQueue, deps: PipelineDeps) -> None:
    """Run the job's handler and write its outcome; map what it raised to a status."""
    try:
        handler = TASKS.get(job.task, handle_process)
        apply_outcome(job, handler(job, deps, queue), queue, deps)
    except JobCancelled:
        log.info("job %s cancelled, deleted or re-queued: stopping", job.id)
        _quietly(job, lambda: queue.event(job.id, "warn", "cancelled"))
    except TargetNotSynced as exc:
        if job.waited_s is not None and job.waited_s >= TARGET_SYNC_MAX_WAIT_S:
            # Waited too long: the bridge or the API's sync is down, not just starting.
            error = (
                f"publishing target {exc.target_id} has not synced with the delivery bridge for "
                f"{TARGET_SYNC_MAX_WAIT_S // 60} minutes: check the bridge and the API's log"
            )
            log.error("job %s failed: %s", job.id, error)
            _quietly(job, lambda: queue.event(job.id, "error", "failed", {"error": error}))
            _quietly(job, lambda: queue.give_up(job, error))
            return
        # The API has not synced the target yet: wait, without spending one of the job's attempts.
        log.info("job %s waits: %s", job.id, exc)
        why, note = str(exc), f"{type(exc).__name__}: {exc}"
        _quietly(
            job, lambda: queue.event(job.id, "warn", "waiting for target sync", {"reason": why})
        )
        _quietly(job, lambda: queue.wait(job, note, TARGET_SYNC_WAIT_S))
    except DocumentError as exc:
        reason = str(exc)
        log.warning("job %s needs review: %s", job.id, reason)
        _quietly(job, lambda: queue.event(job.id, "warn", "needs review", {"reason": reason}))
        _quietly(job, lambda: queue.needs_review(job, reason))
    except Exception as exc:
        log.exception("job %s failed", job.id)
        detail, error = repr(exc), f"{type(exc).__name__}: {exc}"
        _quietly(job, lambda: queue.event(job.id, "error", "failed", {"error": detail}))
        _quietly(job, lambda: queue.fail(job, error))


def _quietly(job: ClaimedJob, write: Callable[[], None]) -> None:
    """Record an outcome without letting it kill the worker: the job row may have been deleted
    mid-run (operator Delete), which makes every write for it fail."""
    try:
        write()
    except Exception:
        log.exception("could not record the outcome of job %s (deleted?)", job.id)


def publish_job(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    on_published: Callable[[list[Target], Delivered], None] | None = None,
) -> list[RenderedOutput]:
    """Approved review: apply the edits and deliver. A test run's approval (a workbench
    reference) keeps the reviewed document but is never delivered to a target."""
    loaded = load_definition(job, deps, queue)
    if not isinstance(loaded, LoadedTemplate):
        raise DocumentError("only documents run by a recipe go through review/publish")
    return publish_template_job(
        job, deps, queue, loaded, deliver=not job.test, on_published=on_published
    )


def refresh_models(live: LiveModels, deps: PipelineDeps) -> bool:
    """Swap in a rebuilt registry (and OCR model) when an admin, or another worker's seed,
    changed the stored LLM config. Jobs already running keep the registry they started with."""
    if not live.refresh():
        return False
    deps.models = live.registry
    deps.embedding_model = live.embedding_model
    if deps.ocr is not None and live.ocr_model:
        deps.ocr = replace(deps.ocr, model=live.ocr_model)
    return True


def refresh_targets(targets: LiveTargets) -> bool:
    """Reload the publishing targets when they changed; a database restart is ridden out (the
    store reconnects on its next call, and every lookup refreshes again)."""
    try:
        return targets.refresh()
    except psycopg.OperationalError as exc:
        log.warning("publishing targets could not be refreshed: %s", exc)
        return False


def idle(queue: JobQueue, stop: threading.Event, timeout_s: float) -> None:
    """Nothing to claim: wait for a NOTIFY (or the poll interval), unless shutting down."""
    if not stop.is_set():
        queue.wait_for_work(timeout_s)


class Runtime(Protocol):
    """What `serve` runs: one pass of the main loop, and closing every connection it holds."""

    def tick(self) -> None: ...

    def close(self) -> None: ...


def serve(
    connect: Callable[[], Runtime],
    stop: threading.Event,
    wait: Callable[[float], object] | None = None,
) -> None:
    """Run the main loop until `stop`. A lost database connection (`psycopg.OperationalError`:
    a restore swapped the database and ended every connection to the old one, or Postgres
    restarted) closes every connection and opens them all again after `RECONNECT_S`, as a
    restart of the worker would, instead of ending the worker. Anything else still ends it."""
    pause = wait or stop.wait
    runtime: Runtime | None = None
    try:
        while not stop.is_set():
            try:
                if runtime is None:
                    runtime = connect()
                runtime.tick()
            except psycopg.OperationalError as exc:
                log.warning(
                    "the database connection was lost (%s): reconnecting in %.0f s",
                    exc,
                    RECONNECT_S,
                )
                if runtime is not None:
                    with contextlib.suppress(Exception):  # already broken: close what closes
                        runtime.close()
                runtime = None
                pause(RECONNECT_S)
    finally:
        if runtime is not None:
            runtime.close()


class _Worker:
    """Every long-lived connection of a running worker and the loop's timers. Built anew after
    a lost connection, so the seeds and registries see the database as it is now."""

    def __init__(
        self,
        settings: Settings,
        specs: SpecRegistry,
        llm_config: LLMConfig,
        stop: threading.Event,
    ) -> None:
        self.settings = settings
        self.stop = stop
        ocr_config = llm_config.ocr if llm_config.ocr and llm_config.ocr.enabled else None
        self.queue = PgJobQueue(settings.database_url)
        # .env and config/llm-providers.yaml are the defaults; the database (and an admin's
        # edits there) decides what the registry holds.
        self.llm_conn = psycopg.connect(settings.database_url, autocommit=True)
        llm_store = PgLlmConfigStore(self.llm_conn)
        llm_store.seed(seed_from_config(llm_config))
        self.live = LiveModels(llm_store, ocr_config)
        models = self.live.registry
        ocr = (
            OcrSettings(
                model=self.live.ocr_model or llm_config.ocr.model,
                min_chars=llm_config.ocr.min_chars,
                longest_dim=llm_config.ocr.longest_dim,
                max_tokens=llm_config.ocr.max_tokens,
                temperature=llm_config.ocr.temperature,
                concurrency=llm_config.ocr.concurrency,
                cache=llm_config.ocr.cache,
            )
            if llm_config.ocr and ocr_config is not None
            else None
        )
        # Publishing targets: the API's cache of the bridge's registry, read only (own
        # connection, re-opened when lost; refreshed with the LLM config).
        self.target_store = PgPublishTargetStore.connect(settings.database_url)
        self.targets = LiveTargets(
            self.target_store, rdf_expected=bool(os.environ.get("RDF_ENDPOINT"))
        )
        # The ontology library and the Linked data settings share one autocommit connection.
        self.library = psycopg.connect(settings.database_url, autocommit=True)
        # The plugins this image can run, for the API's recipe checks and the editor (recipe
        # plugins 3b), built-in and from installed packages (3d: one that breaks the contract is
        # logged and left out). Advisory: a database without the table yet must not stop the worker.
        registry = plugins()
        log.info("plugins: %s", ", ".join(sorted(registry)))
        try:
            PgPluginCatalogue(self.library).publish(catalogue_rows(registry), app_version())
        except psycopg.Error:
            log.warning("could not publish the plugin catalogue", exc_info=True)
        # Its own connection: a publish holds the graph's lock in a transaction across the PUT.
        self.graph_conn = psycopg.connect(settings.database_url, autocommit=True)
        # A model's parallel calls hold across every worker: slots as advisory locks on their own
        # connection, opened when a model with the setting is first called.
        self.call_slots = PgCallSlots(settings.database_url)
        # The conversions' lane gate commits each claim on its own connection (lanes.py).
        self.lanes_conn = psycopg.connect(settings.database_url, autocommit=True)
        # The LangGraph trial (WORKER_STEP_GRAPH=langgraph): a recipe's steps checkpointed in
        # Postgres, so a stopped job resumes at the step it stopped at (step_graph.py).
        self.step_checkpointer: BaseCheckpointSaver[Any] | None = None
        self.close_checkpointer: Callable[[], None] = lambda: None
        self.thread_pruner: ThreadPruner | None = None
        if step_graph_enabled(os.environ):
            self.step_checkpointer, self.close_checkpointer = postgres_checkpointer(
                settings.database_url
            )
            # ADR 0018: a thread lives only while its job is queued or running.
            self.thread_pruner = ThreadPruner(
                self.step_checkpointer,
                functools.partial(pg_orphaned_threads, settings.database_url),
            )
        self.deps = PipelineDeps(
            store=S3ObjectStore(
                settings.s3_endpoint,
                settings.s3_region,
                settings.s3_access_key,
                settings.s3_secret_key,
            ),
            specs=specs,
            models=models,
            extract_text=extract_pages,
            buckets=Buckets(settings.bucket_inbox, settings.bucket_outputs, settings.bucket_runs),
            ocr=ocr,
            targets=self.targets,
            bridge=HttpBridgeClient(settings.bridge_url, settings.bridge_client_key),
            converter=(
                GotenbergConverter(settings.converter_url) if settings.converter_url else None
            ),
            example_template=(
                settings.example_template.read_text(encoding="utf-8")
                if settings.example_template.is_file()
                else None
            ),
            ontologies=PgOntologyStore(self.library),
            linked_data=PgLinkedDataSettings(self.library),
            mapping_memory=PgMappingMemoryStore(self.library),
            embedding_model=self.live.embedding_model,
            graph_registry=PgGraphRegistry(self.graph_conn),
            delivered_jobs=PgRebuildSource(self.library),
            step_checkpointer=self.step_checkpointer,
            call_slots=self.call_slots,
            decomposition=DecompositionStores(
                register=PgRegisterStore.for_url(settings.database_url),
                items=PgItemStore(self.library),
                lanes=PgLaneStore(self.lanes_conn),
            ),
            ontology_max_triples=settings.ontology_max_triples,
            ontology_fetch=(
                functools.partial(
                    fetch_rdf,
                    policy=FetchPolicy(settings.ontology_fetch_allow, settings.ontology_max_bytes),
                    client=httpx.Client(),
                )
                if settings.ontology_fetch_allow
                else None
            ),
            layout=layout_analyser(settings.layout_url, settings.layout_fallback_url),
        )
        self.heartbeat = PgJobHeartbeat(settings.database_url)
        self.next_discovery = 0.0
        self.next_reap = 0.0
        self.next_config_check = 0.0
        self.next_lane_dispatch = 0.0
        log.info(
            "worker %s connected: %d specs, providers=%s, ocr=%s, converter=%s, layout=%s, steps=%s",
            settings.worker_id,
            len(specs),
            models.provider_names,
            ocr.model if ocr else "disabled",
            settings.converter_url or "disabled",
            " then ".join(u for u in (settings.layout_url, settings.layout_fallback_url) if u)
            or "disabled",
            "langgraph (checkpointed)" if self.step_checkpointer else "loop",
        )

    def tick(self) -> None:
        settings, deps, queue = self.settings, self.deps, self.queue
        now = time.monotonic()
        if now >= self.next_config_check:
            if refresh_models(self.live, deps):
                log.info("LLM config changed: providers=%s", deps.models.provider_names)
                self.next_discovery = now  # list the models of new or moved endpoints now
            if refresh_targets(self.targets):
                log.info("publishing targets changed")
            self.next_config_check = now + CONFIG_CHECK_S
        if now >= self.next_discovery:
            discovered = deps.models.discover()
            queue.upsert_models(discovered)
            log.info("model discovery: %d models", len(discovered))
            self.next_discovery = now + settings.discovery_interval_s
        if self.thread_pruner is not None:
            self.thread_pruner.tick()  # at start, then hourly
        if now >= self.next_reap:
            if reaped := queue.reap_stale(settings.stale_lock_s):
                log.warning("re-queued %d stale jobs", reaped)
            self.next_reap = now + 60
        if now >= self.next_lane_dispatch:
            self.dispatch_lanes()
        ran = run_once(
            queue,
            deps,
            settings.worker_id,
            self.heartbeat,
            settings.heartbeat_s,
            # A lane this worker's run freed goes to a waiting document at once.
            after=lambda job: self.dispatch_lanes() if job.task == "decompose" else None,
        )
        if not ran:
            idle(queue, self.stop, settings.poll_interval_s)

    def dispatch_lanes(self) -> None:
        lane_round(self.deps, self.queue)
        self.next_lane_dispatch = time.monotonic() + LANE_DISPATCH_S

    def close(self) -> None:
        for close in (
            self.queue.close,
            self.heartbeat.close,
            self.llm_conn.close,
            self.target_store.close,
            self.library.close,
            self.graph_conn.close,
            self.lanes_conn.close,
            self.call_slots.close,
            self.close_checkpointer,
        ):
            with contextlib.suppress(Exception):
                close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    log.info("ingest-worker %s", app_version())
    settings = Settings.from_env()
    specs = load_specs(settings.specs_dir)
    llm_config = load_llm_config(settings.llm_config)

    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

    serve(lambda: _Worker(settings, specs, llm_config, stop), stop)
    log.info("worker stopped")


if __name__ == "__main__":
    main()
