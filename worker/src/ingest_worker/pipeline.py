from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from .extract import ExtractionFailedError, run_extraction
from .llm.base import RefusalError
from .llm.registry import ModelRegistry
from .outputs import RenderedOutput, render_outputs
from .pdf import TextExtractor
from .prompts import render_prompt
from .queue import ClaimedJob, JobQueue
from .segment import MissingSectionsError, segment
from .specs import SpecRegistry
from .storage import ObjectStore, run_key


class DocumentError(Exception):
    """The document (or spec) can't be processed as-is. Not retried; job goes to needs_review."""


@dataclass
class Buckets:
    inbox: str
    outputs: str
    runs: str


@dataclass
class PipelineDeps:
    store: ObjectStore
    specs: SpecRegistry
    models: ModelRegistry
    extract_text: TextExtractor
    buckets: Buckets


def process_job(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> list[RenderedOutput]:
    loaded = deps.specs.get(job.spec_id, job.spec_version)
    spec = loaded.spec

    pages = deps.extract_text(deps.store.get(job.bucket, job.object_key))
    if spec.document.pages and not (
        spec.document.pages.min <= len(pages) <= spec.document.pages.max
    ):
        raise DocumentError(
            f"page count {len(pages)} outside expected range "
            f"{spec.document.pages.min}-{spec.document.pages.max}"
        )
    if not any(p.strip() for p in pages):
        raise DocumentError("no extractable text (scanned/image-only PDF?)")

    try:
        sections = segment(pages, spec.document.sections)
    except MissingSectionsError as exc:
        raise DocumentError(str(exc)) from exc
    queue.event(job.id, "info", "segmented", {"pages": len(pages), "sections": list(sections)})

    results: dict[str, dict[str, Any]] = {}
    models_used: dict[str, str] = {}
    for ex in spec.extractions:
        provider, model_id = deps.models.resolve(job.model_override or ex.model)
        prompt = render_prompt(loaded.directory, ex.prompt, sections, ex.sections)
        try:
            result = run_extraction(
                extraction_id=ex.id,
                provider=provider,
                model_id=model_id,
                prompt=prompt,
                schema=ex.schema_,
                max_attempts=ex.max_attempts,
            )
        except ExtractionFailedError as exc:
            _audit(deps, job.id, ex.id, exc.attempts)
            raise DocumentError(str(exc)) from exc
        except RefusalError as exc:
            raise DocumentError(f"extraction {ex.id!r}: {exc}") from exc
        _audit(deps, job.id, ex.id, result.attempts)
        results[ex.id] = result.data
        models_used[ex.id] = result.model_ref
        queue.event(
            job.id,
            "info",
            f"extracted {ex.id}",
            {"model": result.model_ref, "attempts": len(result.attempts)},
        )

    outputs = render_outputs(
        spec,
        results,
        document_id=job.document_id,
        job_id=job.id,
        extracted_at=datetime.now(UTC).isoformat(),
        models=models_used,
    )
    for o in outputs:
        content_type = "text/csv" if o.format == "csv" else "application/json"
        deps.store.put(deps.buckets.outputs, o.key, o.body, content_type)
    return outputs


def _audit(deps: PipelineDeps, job_id: str, extraction_id: str, attempts: list[Any]) -> None:
    """Persist every prompt/response pair to the runs bucket for debugging and evals."""
    for a in attempts:
        deps.store.put(
            deps.buckets.runs,
            run_key(job_id, extraction_id, a.n),
            json.dumps(asdict(a), ensure_ascii=False, indent=2).encode("utf-8"),
            "application/json",
        )
