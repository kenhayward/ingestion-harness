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
from typing import Protocol

import httpx
import psycopg

from .bundle import run_export
from .config import Settings
from .convert import GotenbergConverter
from .drafting import run_draft
from .embeddings import run_embed
from .graph_preview import run_graph_preview
from .graph_registry import PgGraphRegistry
from .graph_store import graph_store_from_env
from .heartbeat import HEARTBEAT_S, JobHeartbeat, PgJobHeartbeat, beating
from .linked_data import PgLinkedDataSettings
from .llm.endpoints import LiveModels, PgLlmConfigStore, seed_from_config
from .llm.registry import LLMConfig, load_llm_config
from .mapping_memory import PgMappingMemoryStore
from .ocr import OcrSettings
from .ontology import PgOntologyStore, run_ontology_import
from .ontology_fetch import FetchPolicy, fetch_rdf
from .ontology_suggest import run_suggest
from .outcomes import AwaitReview, Complete, Deliver, Outcome, TaskHandler, apply_outcome
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
from .publish_targets import LiveTargets, PgPublishTargetStore, S3Settings, seed_default_target
from .queue import ClaimedJob, JobQueue, PgJobQueue
from .rdf_rebuild import PgRebuildSource, run_rebuild_job
from .specs import LoadedTemplate, SpecRegistry, load_specs
from .storage import S3ObjectStore
from .template_pipeline import (
    PUBLISH_REFUSED,
    ShapesViolated,
    publish_template_job,
    rerun_template_job,
)
from .version import app_version
from .withdrawal import run_republish, run_withdraw
from .workbench import prepare_sample, run_segment

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
) -> bool:
    """Claim and run one job (any task: process, publish, rerun, prepare, segment, draft,
    export, ontology, graph, suggest, embed, withdraw, republish or rebuild), beating its
    heartbeat while it runs (heartbeat.py). Nothing is claimed while the queue is paused.
    Returns False when the queue is empty."""
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
        return True

    def lost() -> None:
        log.warning("job %s is no longer this worker's: it stops at its next check", job.id)

    with beating(lambda: heartbeat.beat(job), heartbeat_s, on_lost=lost):
        _run_claimed(job, queue, deps)
    return True


def handle_process(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Outcome:
    """Extract (a recipe or a legacy spec): to review, else delivered at once."""
    result = process_job(job, deps, queue)
    reasons = result.review_reasons
    if not reasons and (job.params or {}).get("forceReview"):
        reasons = [FORCE_REVIEW_REASON]
    if reasons:
        return AwaitReview(result.outputs, reasons)
    # The target was resolved before extraction (None: a test run, or no targets).
    return Deliver(result.outputs, result.delivered(), result.target, result.graph)


def handle_publish(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Outcome:
    """An approved review: apply the edits and deliver (publish_job)."""
    check_cancelled(job, queue)

    def record(outputs: list[RenderedOutput], target: Target) -> None:
        queue.record_published(job, outputs, target)  # test runs never get here

    try:
        published = publish_job(job, deps, queue, record)
    except ShapesViolated as refused:
        # Nothing was delivered: the reviewer fixes the values and approves again.
        queue.event(job.id, "warn", PUBLISH_REFUSED, {"reasons": refused.reasons})
        return AwaitReview([], refused.reasons, drafts=False, note="publish refused")
    return Complete(note=f"published {len(published)} outputs")


def handle_rerun(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Outcome:
    """A reviewer's step re-run: the draft goes back to review."""
    loaded = load_definition(job, deps, queue)
    if not isinstance(loaded, LoadedTemplate):
        raise DocumentError("only documents run by a recipe can re-run steps")
    rerun = rerun_template_job(job, deps, queue, loaded)
    step = (job.rerun or {}).get("step")
    return AwaitReview(rerun.outputs, rerun.review_reasons, note=f"re-ran {step}, back in review")


def _completes[R](
    run: Callable[[ClaimedJob, PipelineDeps, JobQueue], R], note: Callable[[R], str]
) -> TaskHandler:
    """A task that succeeds with no outputs of its own once `run` returns."""

    def handle(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Outcome:
        return Complete(note=note(run(job, deps, queue)))

    return handle


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
    "suggest": _completes(run_suggest, lambda s: f"suggested {len(s['suggestions'])} ontologies"),
    "embed": _completes(run_embed, lambda n: f"embedded {n} terms"),
    "withdraw": _completes(run_withdraw, lambda w: "withdrew {} objects, {} graphs".format(*w)),
    "republish": _completes(run_republish, lambda n: f"re-delivered {n} jobs"),
    "rebuild": _completes(run_rebuild_job, lambda lines: lines[-1]),
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
    on_published: Callable[[list[RenderedOutput], Target], None] | None = None,
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
        # Publishing targets: .env seeds the default once, then the database decides (own
        # connection, re-opened when lost; refreshed with the LLM config).
        self.target_store = PgPublishTargetStore.connect(settings.database_url)
        seed_default_target(self.target_store, os.environ)
        self.targets = LiveTargets(
            self.target_store,
            S3Settings(
                settings.s3_endpoint,
                settings.s3_region,
                settings.s3_access_key,
                settings.s3_secret_key,
            ),
        )
        # The ontology library and the Linked data settings share one autocommit connection.
        self.library = psycopg.connect(settings.database_url, autocommit=True)
        # Its own connection: a publish holds the graph's lock in a transaction across the PUT.
        self.graph_conn = psycopg.connect(settings.database_url, autocommit=True)
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
            graph_store=graph_store_from_env(os.environ),
            delivered_jobs=PgRebuildSource(self.library),
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
        )
        self.heartbeat = PgJobHeartbeat(settings.database_url)
        self.next_discovery = 0.0
        self.next_reap = 0.0
        self.next_config_check = 0.0
        log.info(
            "worker %s connected: %d specs, providers=%s, ocr=%s, converter=%s",
            settings.worker_id,
            len(specs),
            models.provider_names,
            ocr.model if ocr else "disabled",
            settings.converter_url or "disabled",
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
        if now >= self.next_reap:
            if reaped := queue.reap_stale(settings.stale_lock_s):
                log.warning("re-queued %d stale jobs", reaped)
            self.next_reap = now + 60
        if not run_once(queue, deps, settings.worker_id, self.heartbeat, settings.heartbeat_s):
            idle(queue, self.stop, settings.poll_interval_s)

    def close(self) -> None:
        for close in (
            self.queue.close,
            self.heartbeat.close,
            self.llm_conn.close,
            self.target_store.close,
            self.library.close,
            self.graph_conn.close,
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
