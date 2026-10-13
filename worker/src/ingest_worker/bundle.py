"""Workbench drafting bundle (phase 6, ADR 0007).

The export task writes exactly what the in-harness drafter sees: `context.md` comes from
`drafting.build_context`, the same function every drafting stage uses, plus each stage's
instructions and JSON Schema, the brief, the draft template and the dev sample PDFs. Holdout
samples are refused here as they are in drafting. The manifest is parsed by
`BundleManifestSchema` (packages/shared/src/bundle.ts).
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from typing import Any

import yaml
from pydantic import Field, ValidationError

from .drafting import (
    MAX_CONTEXT_SAMPLES,
    STAGES,
    DraftParams,
    DraftSample,
    build_context,
    prepared_pages,
)
from .pipeline import DocumentError, JobCancelled, PipelineDeps, check_cancelled
from .queue import ClaimedJob, JobQueue
from .storage import export_key

BUNDLE_FORMAT = "ih-workbench-bundle"
#: Fixed timestamp so the same inputs always give the same zip bytes.
_ZIP_TIME = (2020, 1, 1, 0, 0, 0)

README = """\
# Workbench drafting bundle

- `context.md` is exactly what the harness's drafting model reads: harness rules, the brief,
  the current draft, an example template and the dev samples' text (at most 8).
- `stages/<stage>.md` is a stage's instructions and `stages/<stage>.schema.json` the JSON
  Schema its answer must satisfy. Give a model `context.md` followed by one stage's
  instructions, and ask for JSON matching the schema.
- `samples/` holds the dev sample PDFs; `manifest.json` lists them. Holdout samples are never
  included.
- Import the bundle into another deployment from the Workbench page to start a project with
  this brief, draft and these samples.
"""


class ExportParams(DraftParams):
    """jobs.params of an export job (written by the API): a drafting context plus the name."""

    project_name: str = Field(alias="projectName")


def build_bundle(
    *,
    manifest: dict[str, Any],
    context: str,
    brief: dict[str, Any],
    draft: dict[str, Any] | None,
    pdfs: dict[str, bytes],
) -> bytes:
    """The bundle zip. Deterministic: entries in a fixed order with a fixed timestamp."""
    entries: list[tuple[str, bytes]] = [
        ("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False).encode()),
        ("README.md", README.encode()),
        ("context.md", context.encode()),
        ("brief.json", json.dumps(brief, indent=2, ensure_ascii=False).encode()),
        (
            "template.yaml",
            yaml.safe_dump(draft or {}, sort_keys=False, allow_unicode=True).encode(),
        ),
    ]
    for stage in STAGES.values():
        entries.append((f"stages/{stage.id}.md", stage.instructions.encode()))
        entries.append(
            (f"stages/{stage.id}.schema.json", json.dumps(stage.schema, indent=2).encode())
        )
    for sha, pdf in pdfs.items():
        entries.append((f"samples/{sha}.pdf", pdf))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    return out.getvalue()


def run_export(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    """Build a project's drafting bundle and write it to the runs bucket; returns the manifest."""
    try:
        params = ExportParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid export parameters: {exc}") from exc
    if params.stage != "export":
        raise DocumentError(f"export job with stage {params.stage!r}")
    if job.project_id is None:
        raise DocumentError("export job without a project")
    holdout = [s.sample_id for s in params.samples if s.role != "dev"]
    if holdout:
        raise DocumentError(f"holdout samples are never exported: {', '.join(holdout)}")

    pdfs: dict[str, bytes] = {}
    for s in params.samples:
        if s.bucket is None or s.object_key is None:
            raise DocumentError(f"sample {s.filename} has no PDF location")
        pdf = deps.store.get_optional(s.bucket, s.object_key)
        if pdf is None or hashlib.sha256(pdf).hexdigest() != s.sha256:
            raise DocumentError(f"sample {s.filename}: PDF is missing or changed")
        pdfs[s.sha256] = pdf
    in_context = params.samples[:MAX_CONTEXT_SAMPLES]
    context = build_context(
        brief=params.brief,
        draft=params.draft,
        samples=[
            DraftSample(s.sample_id, s.filename, s.role, prepared_pages(deps, s.sha256))
            for s in in_context
        ],
        example_yaml=deps.example_template,
        survey=params.survey,
    )
    manifest: dict[str, Any] = {
        "format": BUNDLE_FORMAT,
        "formatVersion": 1,
        "project": {"id": job.project_id, "name": params.project_name},
        "templateVersion": int((params.draft or {}).get("version") or 1),
        "briefVersion": params.brief_version,
        "samples": [
            {
                "sampleId": s.sample_id,
                "filename": s.filename,
                "sha256": s.sha256,
                "file": f"samples/{s.sha256}.pdf",
                "inContext": i < MAX_CONTEXT_SAMPLES,
            }
            for i, s in enumerate(params.samples)
        ],
        "stages": list(STAGES),
    }
    data = build_bundle(
        manifest=manifest, context=context, brief=params.brief, draft=params.draft, pdfs=pdfs
    )
    check_cancelled(job, queue)
    key = export_key(job.project_id, job.id)
    deps.store.put(deps.buckets.runs, key, data, "application/zip")
    if queue.is_cancelled(job):
        deps.store.delete(deps.buckets.runs, key)
        raise JobCancelled(job.id)
    queue.event(
        job.id, "info", "bundle exported", {"samples": [s.sample_id for s in params.samples]}
    )
    return manifest
