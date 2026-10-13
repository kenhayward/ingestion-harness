"""Workbench drafting bundle (phase 6, ADR 0007).

The export task writes what the in-harness drafter sees: `context.md` comes from
`drafting.build_context`, the context the survey, outputs, sections and steps stages read
(`revise` additionally sees feedback and evaluation failures, which bundles do not carry), plus
each stage's instructions and JSON Schema, the brief, the draft template and the dev samples as
uploaded (PDF or .docx). Holdout
samples are refused here as they are in drafting. The manifest is parsed by
`BundleManifestSchema` (packages/shared/src/bundle.ts).
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from typing import Any, Literal

import yaml
from pydantic import Field, ValidationError

from .convert import is_docx
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
#: The job event naming the finished zip (TS `BUNDLE_EXPORTED_EVENT`, packages/shared/src/bundle.ts).
BUNDLE_EXPORTED = "bundle exported"
#: Fixed timestamp so the same inputs always give the same zip bytes.
_ZIP_TIME = (2020, 1, 1, 0, 0, 0)

README = """\
# Workbench drafting bundle

- `context.md` is exactly what the harness's drafting model reads in the
  survey, outputs, sections and steps stages: harness rules, the brief, the current draft, an
  example template and the dev samples' text (at most 8). The revise stage additionally sees
  feedback and evaluation failures, which bundles do not carry.
- `stages/<stage>.md` is a stage's instructions and `stages/<stage>.schema.json` the JSON
  Schema its answer must satisfy. Give a model `context.md` followed by one stage's
  instructions, and ask for JSON matching the schema.
- `samples/` holds the dev samples as uploaded (`<sha256>.pdf`, or `<sha256>.docx` for a Word
  document); `manifest.json` lists them. Holdout samples are never included.
- `survey.json` (when present) is the accepted survey; `manifest.json` lists the stages
  already accepted or skipped in `completedStages`.
- Import the bundle into another deployment from the Workbench page to start a project with
  this brief, draft, survey, completed stages and these samples.
"""


class ExportParams(DraftParams):
    """jobs.params of an export job (written by the API): a drafting context plus the name."""

    project_name: str = Field(alias="projectName", min_length=1)
    #: Proposal stages accepted or skipped at export time (import restores them); only
    #: `STAGE_ORDER` stages (packages/shared/src/drafting.ts), as the import's manifest schema.
    completed_stages: list[Literal["survey", "outputs", "sections", "steps"]] = Field(
        default_factory=list, alias="completedStages"
    )


def build_bundle(
    *,
    manifest: dict[str, Any],
    context: str,
    brief: dict[str, Any],
    draft: dict[str, Any] | None,
    files: dict[str, bytes],
    survey: dict[str, Any] | None = None,
) -> bytes:
    """The bundle zip. Deterministic: entries in a fixed order with a fixed timestamp."""
    entries: list[tuple[str, bytes]] = [
        ("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False).encode()),
        ("README.md", README.encode()),
        ("context.md", context.encode()),
        ("brief.json", json.dumps(brief, indent=2, ensure_ascii=False).encode()),
    ]
    if survey is not None:
        entries.append(("survey.json", json.dumps(survey, indent=2, ensure_ascii=False).encode()))
    entries += [
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
    entries += files.items()
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

    # Each sample as uploaded (a PDF, or a .docx: never its converted PDF), named by its bytes.
    files: dict[str, bytes] = {}
    names: dict[str, str] = {}
    for s in params.samples:
        if s.bucket is None or s.object_key is None:
            raise DocumentError(f"sample {s.filename} has no file location")
        data = deps.store.get_optional(s.bucket, s.object_key)
        if data is None or hashlib.sha256(data).hexdigest() != s.sha256:
            raise DocumentError(f"sample {s.filename}: the file is missing or changed")
        names[s.sha256] = f"samples/{s.sha256}.{'docx' if is_docx(data) else 'pdf'}"
        files[names[s.sha256]] = data
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
                "file": names[s.sha256],
                "inContext": i < MAX_CONTEXT_SAMPLES,
            }
            for i, s in enumerate(params.samples)
        ],
        "stages": list(STAGES),
        "completedStages": params.completed_stages,
    }
    data = build_bundle(
        manifest=manifest,
        context=context,
        brief=params.brief,
        draft=params.draft,
        files=files,
        survey=params.survey,
    )
    check_cancelled(job, queue)
    key = export_key(job.project_id, job.id)
    deps.store.put(deps.buckets.runs, key, data, "application/zip")
    if queue.is_cancelled(job):
        deps.store.delete(deps.buckets.runs, key)
        raise JobCancelled(job.id)
    queue.event(
        job.id,
        "info",
        BUNDLE_EXPORTED,
        {"samples": [s.sample_id for s in params.samples], "bytes": len(data)},
    )
    return manifest
