from __future__ import annotations

import functools
import logging
import signal
import threading
import time
from collections.abc import Callable
from dataclasses import replace

import httpx
import psycopg

from .bundle import run_export
from .config import Settings
from .convert import GotenbergConverter
from .drafting import run_draft
from .llm.endpoints import LiveModels, PgLlmConfigStore, seed_from_config
from .llm.registry import load_llm_config
from .ocr import OcrSettings
from .ontology import PgOntologyStore, run_ontology_import
from .ontology_fetch import FetchPolicy, fetch_rdf
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
    publish_outputs,
)
from .queue import ClaimedJob, JobQueue, PgJobQueue
from .specs import LoadedTemplate, load_specs
from .storage import S3ObjectStore
from .template_pipeline import publish_template_job, rerun_template_job
from .workbench import prepare_sample, run_segment

log = logging.getLogger("ingest_worker")

#: How often the worker checks whether the stored LLM config changed (ADR 0010).
CONFIG_CHECK_S = 5.0

#: Review reason for a reference run (`params.forceReview`) that needed no review of its own.
FORCE_REVIEW_REASON = "reference run: verify the values, then approve and save as a reference"


def run_once(queue: JobQueue, deps: PipelineDeps, worker_id: str) -> bool:
    """Claim and run one job (process, publish, rerun, prepare, segment, draft, export or
    ontology).
    Returns False when the queue is empty."""
    job = queue.claim(worker_id)
    if job is None:
        return False
    log.info("claimed %s job %s (attempt %d/%d)", job.task, job.id, job.attempts, job.max_attempts)
    try:
        if job.task == "publish":
            check_cancelled(job, queue)
            published = publish_job(job, deps, queue)
            if deps.target is not None and not job.test:  # approved test runs are not delivered
                queue.record_published(job, published, deps.target.bucket)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s published %d outputs", job.id, len(published))
            return True
        if job.task == "rerun":
            loaded = load_definition(job, deps, queue)
            if not isinstance(loaded, LoadedTemplate):
                raise DocumentError("only documents run by a recipe can re-run steps")
            rerun = rerun_template_job(job, deps, queue, loaded)
            queue.record_drafts(job, rerun.outputs, deps.buckets.outputs)
            check_cancelled(job, queue)
            queue.await_review(job, rerun.outputs, deps.buckets.outputs, rerun.review_reasons)
            log.info("job %s re-ran %s, back in review", job.id, (job.rerun or {}).get("step"))
            return True
        if job.task == "prepare":
            triage = prepare_sample(job, deps, queue)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s prepared %d pages", job.id, triage["pageCount"])
            return True
        if job.task == "segment":
            grid = run_segment(job, deps, queue)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s segmented %d samples", job.id, len(grid["samples"]))
            return True
        if job.task == "draft":
            drafted = run_draft(job, deps, queue)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s drafted stage %s with %s", job.id, drafted["stage"], drafted["model"])
            return True
        if job.task == "export":
            manifest = run_export(job, deps, queue)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s exported %d samples", job.id, len(manifest["samples"]))
            return True
        if job.task == "ontology":
            parsed = run_ontology_import(job, deps, queue)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s indexed %d ontology terms", job.id, len(parsed.terms))
            return True
        result = process_job(job, deps, queue)
        queue.record_drafts(job, result.outputs, deps.buckets.outputs)  # findable by Delete
        check_cancelled(job, queue)
        reasons = result.review_reasons
        if not reasons and (job.params or {}).get("forceReview"):
            reasons = [FORCE_REVIEW_REASON]
        if reasons:
            queue.await_review(job, result.outputs, deps.buckets.outputs, reasons)
            log.info("job %s awaiting review: %s", job.id, "; ".join(reasons))
        else:
            published = [] if job.test else publish_outputs(deps, result.outputs)
            if deps.target is not None and published:
                queue.record_published(job, published, deps.target.bucket)
            queue.complete(job, result.outputs, deps.buckets.outputs)
            log.info("job %s succeeded with %d outputs", job.id, len(result.outputs))
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
    return True


def _quietly(job: ClaimedJob, write: Callable[[], None]) -> None:
    """Record an outcome without letting it kill the worker: the job row may have been deleted
    mid-run (operator Delete), which makes every write for it fail."""
    try:
        write()
    except Exception:
        log.exception("could not record the outcome of job %s (deleted?)", job.id)


def publish_job(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> list[RenderedOutput]:
    """Approved review: apply the edits and deliver. A test run's approval (a workbench
    reference) keeps the reviewed document but is never delivered to the target."""
    loaded = load_definition(job, deps, queue)
    if not isinstance(loaded, LoadedTemplate):
        raise DocumentError("only documents run by a recipe go through review/publish")
    return publish_template_job(job, deps, queue, loaded, deliver=not job.test)


def refresh_models(live: LiveModels, deps: PipelineDeps) -> bool:
    """Swap in a rebuilt registry (and OCR model) when an admin, or another worker's seed,
    changed the stored LLM config. Jobs already running keep the registry they started with."""
    if not live.refresh():
        return False
    deps.models = live.registry
    if deps.ocr is not None and live.ocr_model:
        deps.ocr = replace(deps.ocr, model=live.ocr_model)
    return True


def idle(queue: JobQueue, stop: threading.Event, timeout_s: float) -> None:
    """Nothing to claim: wait for a NOTIFY (or the poll interval), unless shutting down."""
    if not stop.is_set():
        queue.wait_for_work(timeout_s)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings.from_env()
    specs = load_specs(settings.specs_dir)
    llm_config = load_llm_config(settings.llm_config)
    ocr_config = llm_config.ocr if llm_config.ocr and llm_config.ocr.enabled else None
    queue = PgJobQueue(settings.database_url)
    # .env and config/llm-providers.yaml are the defaults; the database (and an admin's edits
    # there) decides what the registry holds.
    llm_store = PgLlmConfigStore(psycopg.connect(settings.database_url, autocommit=True))
    llm_store.seed(seed_from_config(llm_config))
    live = LiveModels(llm_store, ocr_config)
    models = live.registry
    ocr = (
        OcrSettings(
            model=live.ocr_model or llm_config.ocr.model,
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
    deps = PipelineDeps(
        store=S3ObjectStore(
            settings.s3_endpoint, settings.s3_region, settings.s3_access_key, settings.s3_secret_key
        ),
        specs=specs,
        models=models,
        extract_text=extract_pages,
        buckets=Buckets(settings.bucket_inbox, settings.bucket_outputs, settings.bucket_runs),
        ocr=ocr,
        target=Target(
            store=S3ObjectStore(
                settings.target_endpoint,
                settings.target_region,
                settings.target_access_key,
                settings.target_secret_key,
            ),
            bucket=settings.target_bucket,
            prefix=settings.target_prefix,
        ),
        converter=(GotenbergConverter(settings.converter_url) if settings.converter_url else None),
        example_template=(
            settings.example_template.read_text(encoding="utf-8")
            if settings.example_template.is_file()
            else None
        ),
        ontologies=PgOntologyStore(psycopg.connect(settings.database_url, autocommit=True)),
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
    log.info(
        "worker %s started: %d specs, providers=%s, ocr=%s, converter=%s",
        settings.worker_id,
        len(specs),
        models.provider_names,
        ocr.model if ocr else "disabled",
        settings.converter_url or "disabled",
    )

    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

    next_discovery = 0.0
    next_reap = 0.0
    next_config_check = 0.0
    while not stop.is_set():
        now = time.monotonic()
        if now >= next_config_check:
            if refresh_models(live, deps):
                log.info("LLM config changed: providers=%s", deps.models.provider_names)
                next_discovery = now  # list the models of new or moved endpoints now
            next_config_check = now + CONFIG_CHECK_S
        if now >= next_discovery:
            discovered = deps.models.discover()
            queue.upsert_models(discovered)
            log.info("model discovery: %d models", len(discovered))
            next_discovery = now + settings.discovery_interval_s
        if now >= next_reap:
            if reaped := queue.reap_stale(settings.stale_lock_s):
                log.warning("re-queued %d stale jobs", reaped)
            next_reap = now + 60
        if not run_once(queue, deps, settings.worker_id):
            idle(queue, stop, settings.poll_interval_s)

    queue.close()
    log.info("worker stopped")


if __name__ == "__main__":
    main()
