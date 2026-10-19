"""Plugin step previews (recipe plugins 3c): a recipe's plugin step run on the Workbench's
prepared dev samples, before any test run.

The API puts the samples (id, file name, sha256) and the open draft in the job's params
(PluginPreviewJobParams in TS). Each sample's prepared text is cut into sections as production does
(copy selection, page markers, segmentation), the plugin runs on the step's sections (without
earlier steps' values: a preview runs no other step) and its reply is normalised as a run's would
be. Everything runs in one child process with a time limit, so a runaway pattern cannot stall the
worker. A preview that cannot run (no such step, a plugin this worker lacks, bad settings, past
its time limit) still succeeds, with the reason as `problem`. The result goes to
`plugin-previews/{project}/{job}.json` in the runs bucket.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .capped import CallFailed, CallTimedOut, capped_call
from .pipeline import (
    PAGE_MARKER,
    DocumentError,
    JobCancelled,
    PipelineDeps,
    check_cancelled,
    mark_pages,
)
from .plugins import PLUGINS, PluginContext
from .queue import ClaimedJob, JobQueue
from .segment import MissingSectionsError, segment_occurrences, select_copy
from .storage import plugin_preview_key
from .template import PluginStep, Template
from .template_pipeline import normalise_step
from .workbench import _prepared_pages

#: The time limit of a whole preview (every sample), like the anchor preview's.
PLUGIN_PREVIEW_TIMEOUT_S = 20.0


class PreviewSample(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    sample_id: str = Field(alias="sampleId")
    file_name: str = Field(alias="fileName")
    sha256: str = Field(min_length=1)


class PluginPreviewParams(BaseModel):
    """What the API's createPluginPreviewJob puts in the job's params."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    samples: list[PreviewSample] = Field(min_length=1)
    definition: Template
    step_id: str = Field(alias="stepId")


def _failed(sample_id: str, name: str, error: str) -> dict[str, Any]:
    return {
        "sampleId": sample_id,
        "fileName": name,
        "fields": None,
        "rows": None,
        "issues": [],
        "error": error,
    }


def preview_samples(
    definition: dict[str, Any],
    step_id: str,
    job_id: str,
    samples: list[tuple[str, str, list[str] | None]],
) -> dict[str, Any]:
    """The preview result for (sample id, file name, prepared pages or None). Pure, so it runs
    in the capped child; the parent has checked the step, the plugin and its settings."""
    template = Template.model_validate(definition)
    step = next(s for s in template.plugin_steps() if s.id == step_id)
    plugin = PLUGINS[step.uses]
    settings = plugin.settings_for(template, step)
    document = template.document
    marker = PAGE_MARKER if document.page_markers else None
    out: list[dict[str, Any]] = []
    for sample_id, name, pages in samples:
        if pages is None:
            out.append(_failed(sample_id, name, "the sample is not prepared yet"))
            continue
        first, kept = select_copy(pages, document.copies) if document.copies else (0, pages)
        if not any(p.strip() for p in kept):
            out.append(_failed(sample_id, name, "no text on its pages"))
            continue
        if document.page_markers:
            kept = mark_pages(kept, first + 1)
        try:
            segmented = segment_occurrences(kept, document.sections, page_marker=marker)
        except MissingSectionsError as exc:
            missing = ", ".join(exc.missing)
            out.append(_failed(sample_id, name, f"missing required sections: {missing}"))
            continue
        job = ClaimedJob(
            job_id, "", template.id, template.version, "", "", None, 1, 1,
            task="plugin", test=True, filename=name,
        )  # fmt: skip
        ctx = PluginContext(
            job,
            template,
            step,
            {i: segmented.sections.get(i, "") for i in step.sections},
            [],  # a preview runs no earlier step
            lambda *_: None,
        )
        try:
            data = plugin.run(ctx, settings)
        except Exception as exc:  # the plugin's own failure, shown on its sample
            out.append(_failed(sample_id, name, f"the plugin failed: {exc}"))
            continue
        outcome = normalise_step(template, step, data)
        out.append(
            {
                "sampleId": sample_id,
                "fileName": name,
                "fields": outcome.fields if step.fields else None,
                "rows": next(iter(outcome.tables.values()), []) if step.table else None,
                "issues": list(outcome.issues),
                "error": None,
            }
        )
    return {"stepId": step.id, "uses": step.uses, "problem": None, "samples": out}


def run_plugin_preview(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    *,
    timeout_s: float = PLUGIN_PREVIEW_TIMEOUT_S,
) -> dict[str, Any]:
    try:
        params = PluginPreviewParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid plugin preview parameters: {exc}") from exc
    project_id = job.project_id
    if project_id is None:
        raise DocumentError("plugin preview without a project")
    template = params.definition

    def finish(result: dict[str, Any]) -> dict[str, Any]:
        check_cancelled(job, queue)
        key = plugin_preview_key(project_id, job.id)
        deps.store.put(deps.buckets.runs, key, json.dumps(result).encode(), "application/json")
        if queue.is_cancelled(job):  # a newer preview replaced this one while it wrote
            deps.store.delete(deps.buckets.runs, key)
            raise JobCancelled(job.id)
        return result

    def problem(message: str, uses: str = "") -> dict[str, Any]:
        return finish({"stepId": params.step_id, "uses": uses, "problem": message, "samples": []})

    step: PluginStep | None = next(
        (s for s in template.plugin_steps() if s.id == params.step_id), None
    )
    if step is None:
        return problem(f"no plugin step {params.step_id} in the recipe")
    plugin = PLUGINS.get(step.uses)
    if plugin is None:
        return problem(f"no plugin {step.uses} on this worker", step.uses)
    if plugin.spec.egress != "none":
        return problem("only plugins that send no data out can be previewed yet", step.uses)
    try:
        plugin.settings_for(template, step)
    except ValueError as exc:
        return problem(f"{step.uses}: {exc}", step.uses)
    samples = [(s.sample_id, s.file_name, _prepared_pages(deps, s.sha256)) for s in params.samples]
    check_cancelled(job, queue)
    definition = template.model_dump(by_alias=True, exclude_none=True, mode="json")
    try:
        result = capped_call(preview_samples, (definition, step.id, job.id, samples), timeout_s)
    except CallTimedOut as exc:
        return problem(
            f"the plugin did not finish within {exc.timeout_s:g}s: a pattern may backtrack "
            "catastrophically",
            step.uses,
        )
    except CallFailed as exc:
        return problem(f"the preview failed: {exc}", step.uses)
    return finish(dict(result))
