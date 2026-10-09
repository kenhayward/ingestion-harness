from __future__ import annotations

import logging
import signal
import threading
import time

from .config import Settings
from .llm.registry import build_registry, load_llm_config
from .ocr import OcrSettings
from .pdf import extract_pages
from .pipeline import Buckets, DocumentError, PipelineDeps, process_job
from .queue import JobQueue, PgJobQueue
from .specs import load_specs
from .storage import S3ObjectStore

log = logging.getLogger("ingest_worker")


def run_once(queue: JobQueue, deps: PipelineDeps, worker_id: str) -> bool:
    """Claim and process one job. Returns False when the queue is empty."""
    job = queue.claim(worker_id)
    if job is None:
        return False
    log.info("claimed job %s (attempt %d/%d)", job.id, job.attempts, job.max_attempts)
    try:
        outputs = process_job(job, deps, queue)
    except DocumentError as exc:
        log.warning("job %s needs review: %s", job.id, exc)
        queue.event(job.id, "warn", "needs review", {"reason": str(exc)})
        queue.needs_review(job, str(exc))
    except Exception as exc:
        log.exception("job %s failed", job.id)
        queue.event(job.id, "error", "failed", {"error": repr(exc)})
        queue.fail(job, f"{type(exc).__name__}: {exc}")
    else:
        queue.complete(job, outputs, deps.buckets.outputs)
        log.info("job %s succeeded with %d outputs", job.id, len(outputs))
    return True


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
