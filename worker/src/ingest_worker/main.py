from __future__ import annotations

import logging
import signal
import threading
import time
from collections.abc import Callable

from .config import Settings
from .llm.registry import build_registry, load_llm_config
from .ocr import OcrSettings
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

log = logging.getLogger("ingest_worker")


def run_once(queue: JobQueue, deps: PipelineDeps, worker_id: str) -> bool:
    """Claim and run one job (process or publish). Returns False when the queue is empty."""
    job = queue.claim(worker_id)
    if job is None:
        return False
    log.info("claimed %s job %s (attempt %d/%d)", job.task, job.id, job.attempts, job.max_attempts)
    try:
        if job.task == "publish":
            check_cancelled(job, queue)
            published = publish_job(job, deps, queue)
            if deps.target is not None:
                queue.record_published(job, published, deps.target.bucket)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s published %d outputs", job.id, len(published))
            return True
        if job.task == "rerun":
            loaded = load_definition(job, deps, queue)
            if not isinstance(loaded, LoadedTemplate):
                raise DocumentError("only template documents can re-run steps")
            rerun = rerun_template_job(job, deps, queue, loaded)
            queue.record_drafts(job, rerun.outputs, deps.buckets.outputs)
            check_cancelled(job, queue)
            queue.await_review(job, rerun.outputs, deps.buckets.outputs, rerun.review_reasons)
            log.info("job %s re-ran %s, back in review", job.id, (job.rerun or {}).get("step"))
            return True
        result = process_job(job, deps, queue)
        queue.record_drafts(job, result.outputs, deps.buckets.outputs)  # findable by Delete
        check_cancelled(job, queue)
        if result.review_reasons:
            queue.await_review(job, result.outputs, deps.buckets.outputs, result.review_reasons)
            log.info("job %s awaiting review: %s", job.id, "; ".join(result.review_reasons))
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
    if job.test:
        raise DocumentError("test runs are never published")
    loaded = load_definition(job, deps, queue)
    if not isinstance(loaded, LoadedTemplate):
        raise DocumentError("only template documents go through review/publish")
    return publish_template_job(job, deps, queue, loaded)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings.from_env()
    specs = load_specs(settings.specs_dir)
    llm_config = load_llm_config(settings.llm_config)
    models = build_registry(llm_config)
    ocr = (
        OcrSettings(
            model=llm_config.ocr.model,
            min_chars=llm_config.ocr.min_chars,
            longest_dim=llm_config.ocr.longest_dim,
            max_tokens=llm_config.ocr.max_tokens,
            temperature=llm_config.ocr.temperature,
            concurrency=llm_config.ocr.concurrency,
            cache=llm_config.ocr.cache,
        )
        if llm_config.ocr and llm_config.ocr.enabled
        else None
    )
    queue = PgJobQueue(settings.database_url)
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
    )
    log.info(
        "worker %s started: %d specs, providers=%s, ocr=%s",
        settings.worker_id,
        len(specs),
        models.provider_names,
        ocr.model if ocr else "disabled",
    )

    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

    next_discovery = 0.0
    next_reap = 0.0
    while not stop.is_set():
        now = time.monotonic()
        if now >= next_discovery:
            discovered = models.discover()
            queue.upsert_models(discovered)
            log.info("model discovery: %d models", len(discovered))
            next_discovery = now + settings.discovery_interval_s
        if now >= next_reap:
            if reaped := queue.reap_stale(settings.stale_lock_s):
                log.warning("re-queued %d stale jobs", reaped)
            next_reap = now + 60
        if not run_once(queue, deps, settings.worker_id):
            stop.wait(settings.poll_interval_s)

    queue.close()
    log.info("worker stopped")


if __name__ == "__main__":
    main()
