"""Workbench drafting (ADR 0007): turn the brief, the current draft and the dev samples into
one context, ask the `draft` model for a stage body, validate it, write it to the runs bucket.

build_context is the single place that decides what a drafting model sees. Holdout samples
are refused here even though the API never sends them."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .extract import ExtractionFailedError, run_extraction
from .llm.base import RefusalError
from .llm.registry import ModelResolutionError
from .pipeline import DocumentError, PipelineDeps, check_cancelled, enforce_data_policy
from .queue import ClaimedJob, JobQueue
from .storage import drafting_key, prepared_text_key, run_key

MAX_SAMPLE_CHARS = 40_000
MAX_CONTEXT_SAMPLES = 8

DRAFT_SYSTEM = (
    "You help configure a document ingestion harness. You read sample documents and a user's "
    "brief and describe how to extract structured data from documents of this type. Respond "
    "only with JSON that satisfies the provided schema. Base every statement on the samples; "
    "say when something is uncertain instead of guessing."
)

RULES = """\
How the ingestion harness reads a document:
- Each PDF's text is extracted page by page; pages without a text layer are OCR'd, and OCR'd
  tables are flattened to one line per row with cells separated by two spaces.
- Pages are prefixed with a line "[page N]" (the original PDF page number).
- Some PDFs hold several copies of the document (e.g. a blank protocol followed by the executed
  one); a copy-selection anchor can keep only the first or last copy.
- The text is split into sections: each section starts at the first match of its anchor, a
  Python regular expression evaluated in multiline mode, and runs to the next section's start.
- A template declares outputs first: single-value fields (text, integer, decimal, date, boolean,
  enum, list) and typed tables; extraction steps then fill each output from chosen sections.
"""


@dataclass(frozen=True)
class DraftSample:
    sample_id: str
    filename: str
    role: str
    pages: list[str]


@dataclass(frozen=True)
class Stage:
    id: str
    instructions: str
    schema: dict[str, Any]


def _object(required: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(required),
        "properties": required,
    }


_STRING: dict[str, Any] = {"type": "string"}

#: Mirrors packages/shared/src/workbench.ts SurveyBodySchema.
SURVEY_SCHEMA: dict[str, Any] = _object(
    {
        "summary": _STRING,
        "structure": {
            "type": "array",
            "items": _object({"name": _STRING, "description": _STRING, "howToFind": _STRING}),
        },
        "variants": {"type": "array", "items": _STRING},
        "candidates": {
            "type": "array",
            "items": _object(
                {
                    "name": _STRING,
                    "description": _STRING,
                    "where": _STRING,
                    "kind": {"type": "string", "enum": ["field", "table"]},
                }
            ),
        },
        "questions": {
            "type": "array",
            "items": _object({"question": _STRING, "why": _STRING}),
        },
    }
)

SURVEY = Stage(
    "survey",
    """\
Task: survey these documents before anyone designs a template.
- summary: what kind of document this is and what the samples have in common, in 2-4 sentences.
- structure: the parts every (or most) sample has, in reading order, with howToFind = the
  heading or wording that marks where each part starts.
- variants: how the samples differ (issuers, layouts, scanned vs text, blank vs executed copies,
  missing parts).
- candidates: data worth extracting, guided by the brief: name (lowercase_snake_case), what it
  is, where it is found, and kind = field (one value per document) or table (repeating rows).
- questions: what you need the user to decide or explain before the outputs can be designed.
Return JSON only.""",
    SURVEY_SCHEMA,
)

STAGES: dict[str, Stage] = {SURVEY.id: SURVEY}

_BRIEF_LABELS = [
    ("purpose", "Purpose"),
    ("outputs", "Outputs wanted"),
    ("exampleOutput", "Example output"),
    ("glossary", "Glossary"),
    ("variants", "Known variants"),
    ("rules", "Rules"),
]


def _brief_text(brief: dict[str, Any]) -> str:
    parts = [
        f"{label}:\n{str(brief.get(key, '')).strip()}"
        for key, label in _BRIEF_LABELS
        if str(brief.get(key, "")).strip()
    ]
    for qa in brief.get("answers") or []:
        parts.append(f"Q: {qa.get('question', '')}\nA: {qa.get('answer', '')}")
    return "\n\n".join(parts) or "(no brief yet)"


def _sample_text(sample: DraftSample) -> str:
    text = "\n".join(f"[page {i + 1}]\n{page}" for i, page in enumerate(sample.pages))
    if len(text) > MAX_SAMPLE_CHARS:
        omitted = len(text) - MAX_SAMPLE_CHARS
        text = f"{text[:MAX_SAMPLE_CHARS]}\n[... truncated: {omitted} more characters]"
    return text


def build_context(
    *,
    brief: dict[str, Any],
    draft: dict[str, Any] | None,
    samples: list[DraftSample],
    example_yaml: str | None,
) -> str:
    """Everything a drafting model sees, in one string. Refuses holdout (non-dev) samples."""
    for s in samples:
        if s.role != "dev":
            raise ValueError(
                f"sample {s.sample_id} is {s.role}: holdout text is never sent to drafting"
            )
    blocks = [f"<harness>\n{RULES}</harness>", f"<brief>\n{_brief_text(brief)}\n</brief>"]
    if example_yaml:
        blocks.append(f"<example_template>\n{example_yaml.strip()}\n</example_template>")
    if draft:
        blocks.append(
            f"<current_draft>\n{yaml.safe_dump(draft, sort_keys=False).strip()}\n</current_draft>"
        )
    for s in samples[:MAX_CONTEXT_SAMPLES]:
        blocks.append(
            f'<sample id="{s.sample_id}" file="{s.filename}">\n{_sample_text(s)}\n</sample>'
        )
    return "\n\n".join(blocks)


class DraftParamSample(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    sample_id: str = Field(alias="sampleId")
    filename: str
    sha256: str
    role: str


class DraftParams(BaseModel):
    """jobs.params of a draft job (written by the API)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    stage: str
    data_policy: Literal["local", "external"] = Field(alias="dataPolicy")
    brief_version: int | None = Field(default=None, alias="briefVersion")
    brief: dict[str, Any]
    draft: dict[str, Any] | None = None
    samples: list[DraftParamSample]
    model: str | None = None


def _pages(deps: PipelineDeps, sha256: str) -> list[str]:
    raw = deps.store.get_optional(deps.buckets.runs, prepared_text_key(sha256))
    if raw is None:
        raise DocumentError(f"prepared text for {sha256} is missing")
    return [str(p["text"]) for p in json.loads(raw)["pages"]]


def run_draft(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    """Run one drafting stage and write its result (TS: DraftResult) to the runs bucket."""
    try:
        params = DraftParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid draft parameters: {exc}") from exc
    stage = STAGES.get(params.stage)
    if stage is None:
        raise DocumentError(f"drafting stage {params.stage!r} is not available")
    if job.project_id is None:
        raise DocumentError("draft job without a project")
    holdout = [s.sample_id for s in params.samples if s.role != "dev"]
    if holdout:
        raise DocumentError(f"holdout samples are never sent to drafting: {', '.join(holdout)}")

    ref = params.model or "draft"
    try:
        provider, model_id = deps.models.resolve(ref)
    except ModelResolutionError as exc:
        raise DocumentError(f"drafting model: {exc}") from exc
    enforce_data_policy(job, deps, provider, ref)
    model_ref = f"{provider.name}/{model_id}"

    sent = params.samples[:MAX_CONTEXT_SAMPLES]
    samples = [DraftSample(s.sample_id, s.filename, s.role, _pages(deps, s.sha256)) for s in sent]
    context = build_context(
        brief=params.brief, draft=params.draft, samples=samples, example_yaml=deps.example_template
    )
    check_cancelled(job, queue)
    if deps.models.location(provider.name) == "external":
        queue.event(
            job.id,
            "info",
            "external model call",
            {"stage": stage.id, "model": model_ref, "samples": [s.sample_id for s in samples]},
        )
    try:
        result = run_extraction(
            extraction_id=f"draft-{stage.id}",
            provider=provider,
            model_id=model_id,
            prompt=f"{context}\n\n{stage.instructions}",
            schema=stage.schema,
            max_attempts=2,
            system=DRAFT_SYSTEM,
        )
    except ExtractionFailedError as exc:
        _audit(deps, job, stage, exc.attempts)
        raise DocumentError(str(exc)) from exc
    except RefusalError as exc:
        raise DocumentError(f"drafting model refused: {exc}") from exc
    _audit(deps, job, stage, result.attempts)

    last = result.attempts[-1]
    output = {
        "stage": stage.id,
        "model": result.model_ref,
        "body": result.data,
        "usage": {"inputTokens": last.input_tokens, "outputTokens": last.output_tokens},
    }
    check_cancelled(job, queue)
    deps.store.put(
        deps.buckets.runs,
        drafting_key(job.project_id, job.id),
        json.dumps(output).encode(),
        "application/json",
    )
    return output


def _audit(deps: PipelineDeps, job: ClaimedJob, stage: Stage, attempts: list[Any]) -> None:
    for a in attempts:
        record = {"prompt": a.prompt, "response": a.response, "errors": a.errors}
        deps.store.put(
            deps.buckets.runs,
            run_key(job.id, f"draft-{stage.id}", a.n),
            json.dumps(record).encode(),
            "application/json",
        )
