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

from .draft_changes import apply_changes
from .draft_stages import OUTPUTS, REVISE, SECTIONS, STEPS, Stage, resolve_answers
from .extract import ExtractionFailedError, ExtractionResult, run_extraction
from .llm.base import RefusalError
from .llm.registry import ModelResolutionError
from .mapping_stage import MAPPING as MAPPING_STAGE
from .pipeline import DocumentError, PipelineDeps, check_cancelled, enforce_data_policy
from .queue import ClaimedJob, JobQueue
from .storage import drafting_key, prepared_text_key, run_key
from .workbench import SegmentDocument, segment_with_timeout

MAX_SAMPLE_CHARS = 40_000
MAX_CONTEXT_SAMPLES = 8
#: Output budget of one drafting call (a survey or proposal is far smaller than an extraction).
DRAFT_MAX_TOKENS = 16_000

DRAFT_SYSTEM = (
    "You help configure a document ingestion harness. You read sample documents and a user's "
    "brief and describe how to extract structured data from documents of this type. Respond "
    "only with JSON that satisfies the provided schema. Base every statement on the samples; "
    "say when something is uncertain instead of guessing."
)

RULES = """\
How the ingestion harness reads a document:
- Each document is a PDF, or a Word document converted to PDF first. Its text is extracted page
  by page; pages without a text layer are OCR'd, and OCR'd tables are flattened to one line per
  row with cells separated by two spaces.
- Pages are prefixed with a line "[page N]" (the page number in the PDF).
- Some documents hold several copies of the document (e.g. a blank protocol followed by the executed
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


def _object(required: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(required),
        "properties": required,
    }


_STRING: dict[str, Any] = {"type": "string"}

#: Mirrors packages/shared/src/workbench.ts SurveyBodySchema (seenIn is optional there: older
#: surveys have none).
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
                    "seenIn": _object({"n": {"type": "integer"}, "of": {"type": "integer"}}),
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
  is, where it is found, kind = field (one value per document) or table (repeating rows), and
  seenIn: In how many of the samples shown here you saw it (n), of how many samples (of).
- questions: what you need the user to decide or explain before the outputs can be designed.
Return JSON only.""",
    SURVEY_SCHEMA,
)


def clamp_seen_in(body: dict[str, Any], samples: int) -> dict[str, Any]:
    """`of` is the number of samples the model was shown, whatever it wrote; `n` stays within
    0..of. Returns a new body (TS: SeenInSchema)."""
    candidates = [
        {**c, "seenIn": {"n": max(0, min(int(c["seenIn"]["n"]), samples)), "of": samples}}
        for c in body["candidates"]
    ]
    return {**body, "candidates": candidates}


STAGES: dict[str, Stage] = {
    s.id: s for s in (SURVEY, OUTPUTS, SECTIONS, STEPS, REVISE, MAPPING_STAGE)
}
#: Stages that propose changes to the current draft (so they need it).
CHANGE_STAGE_IDS = {"outputs", "sections", "steps", "revise", "mapping"}

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
    survey: dict[str, Any] | None = None,
    feedback: list[dict[str, Any]] | None = None,
    failures: list[dict[str, Any]] | None = None,
    failures_from: FailuresFrom | None = None,
) -> str:
    """Everything a drafting model sees, in one string. Refuses holdout (non-dev) samples."""
    for s in samples:
        if s.role != "dev":
            raise ValueError(
                f"sample {s.sample_id} is {s.role}: holdout text is never sent to drafting"
            )
    blocks = [f"<harness>\n{RULES}</harness>", f"<brief>\n{_brief_text(brief)}\n</brief>"]
    if survey:
        blocks.append(f"<survey>\n{json.dumps(survey, indent=1, ensure_ascii=False)}\n</survey>")
    if feedback:
        lines = [
            f"- F{n} [{f.get('target')} {f.get('targetId')}]"
            + (f" (sample {f['sample']})" if f.get("sample") else "")
            + f": {f.get('body', '')}"
            for n, f in enumerate(feedback, 1)
        ]
        blocks.append("<feedback>\n" + "\n".join(lines) + "\n</feedback>")
    if failures:
        header = "<evaluation_failures>"
        if failures_from is not None:
            header = (
                f'<evaluation_failures templateVersion="{failures_from.template_version}" '
                f'model="{failures_from.model or "template"}">'
            )
        blocks.append(
            f"{header}\n"
            f"{json.dumps(failures, indent=1, ensure_ascii=False)}\n"
            "</evaluation_failures>"
        )
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
    #: Where the sample's file lives (export jobs only; draft jobs never read it).
    bucket: str | None = None
    object_key: str | None = Field(default=None, alias="objectKey")


class FailuresFrom(BaseModel):
    """The dev iteration a revision's failures were taken from."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    template_version: int = Field(alias="templateVersion")
    model: str | None = None


class DraftParams(BaseModel):
    """jobs.params of a draft job (written by the API)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    stage: str
    data_policy: Literal["local", "external"] = Field(alias="dataPolicy")
    brief_version: int | None = Field(default=None, alias="briefVersion")
    brief: dict[str, Any]
    draft: dict[str, Any] | None = None
    survey: dict[str, Any] | None = None
    samples: list[DraftParamSample]
    model: str | None = None
    feedback: list[dict[str, Any]] = Field(default_factory=list)
    failures: list[dict[str, Any]] = Field(default_factory=list)
    feedback_ids: list[str] = Field(default_factory=list, alias="feedbackIds")
    failures_from: FailuresFrom | None = Field(default=None, alias="failuresFrom")
    #: The mapping stage (ADR 0011): the brief's vocabulary, its guidance, observed values.
    mapping: dict[str, Any] | None = None


def prepared_pages(deps: PipelineDeps, sha256: str) -> list[str]:
    """A prepared sample's page text (DocumentError when it was never prepared)."""
    raw = deps.store.get_optional(deps.buckets.runs, prepared_text_key(sha256))
    if raw is None:
        raise DocumentError(f"prepared text for {sha256} is missing")
    return [str(p["text"]) for p in json.loads(raw)["pages"]]


def select_failures(failures: list[dict[str, Any]], dev_files: set[str]) -> list[dict[str, Any]]:
    """The failures a revision sends (TS revisionFailures; shared fixture revise-failures.json):
    dev samples only, lowest score first (stable), at most MAX_CONTEXT_SAMPLES. The API sends
    them already selected, so this is a defensive no-op on its input."""
    return sorted(
        (f for f in failures if f.get("sample") in dev_files),
        key=lambda f: float(f.get("score", 0)),
    )[:MAX_CONTEXT_SAMPLES]


def run_draft(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    """Run one drafting stage and write its result (TS: DraftResult) to the runs bucket."""
    try:
        params = DraftParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid draft parameters: {exc}") from exc
    stage = STAGES.get(params.stage)
    if stage is None:
        raise DocumentError(f"drafting stage {params.stage!r} is not available")
    if stage.id in CHANGE_STAGE_IDS and params.draft is None:
        raise DocumentError(f"drafting stage {stage.id} needs the current draft")
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
    if stage.id == "mapping":
        from .mapping_stage import run_mapping

        return run_mapping(job, deps, queue, params, provider, model_id, model_ref)

    sent = params.samples[:MAX_CONTEXT_SAMPLES]
    samples = [
        DraftSample(s.sample_id, s.filename, s.role, prepared_pages(deps, s.sha256)) for s in sent
    ]
    # Defence in depth for the holdout rule: the API already filters, the worker re-checks.
    names = {s.filename for s in params.samples if s.role == "dev"}
    dev_feedback = [f for f in params.feedback if not f.get("sample") or f["sample"] in names]
    # The worst-scoring failures are the most worth fixing; the cap keeps the prompt bounded.
    dev_failures = select_failures(params.failures, names)
    # The prompt labels feedback F1..Fn in this order; answers name those labels (RV2).
    labels = {f"F{n}": str(f["id"]) for n, f in enumerate(dev_feedback, 1) if f.get("id")}
    context = build_context(
        brief=params.brief,
        draft=params.draft,
        samples=samples,
        example_yaml=deps.example_template,
        survey=params.survey,
        feedback=dev_feedback,
        failures=dev_failures,
        failures_from=params.failures_from,
    )
    check_cancelled(job, queue)
    if deps.models.location(provider.name) == "external":
        queue.event(
            job.id,
            "info",
            "external model call",
            {
                "stage": stage.id,
                "model": model_ref,
                "samples": [s.sample_id for s in samples],
                # Failures and feedback can name dev samples whose text is not sent.
                "referencedSamples": sorted(
                    {str(f["sample"]) for f in dev_feedback + dev_failures if f.get("sample")}
                ),
            },
        )
    draft = params.draft or {}

    def check(data: dict[str, Any]) -> list[str]:
        body, errors = stage.convert(data) if stage.convert else (data, [])
        if not errors and stage.check is not None:
            errors = stage.check(body, draft)
        return errors

    def propose(prompt: str, label: str) -> tuple[ExtractionResult, dict[str, Any]]:
        try:
            result = run_extraction(
                extraction_id=label,
                provider=provider,
                model_id=model_id,
                prompt=prompt,
                schema=stage.schema,
                max_attempts=2,
                max_tokens=DRAFT_MAX_TOKENS,
                system=DRAFT_SYSTEM,
                check=check if (stage.convert or stage.check) else None,
            )
        except ExtractionFailedError as exc:
            _audit(deps, job, label, exc.attempts)
            raise DocumentError(str(exc)) from exc
        except RefusalError as exc:
            raise DocumentError(f"drafting model refused: {exc}") from exc
        _audit(deps, job, label, result.attempts)
        body = stage.convert(result.data)[0] if stage.convert else result.data
        return result, body

    prompt = f"{context}\n\n{stage.instructions}"
    result, body = propose(prompt, f"draft-{stage.id}")
    if stage.id == "revise":
        body = resolve_answers(body, labels)
    if stage.id == "survey":
        body = clamp_seen_in(body, len(samples))
    if stage.id == "sections":
        grid, misses = anchor_check(samples, draft, body)
        if misses:
            check_cancelled(job, queue)
            feedback = "\n".join(misses)
            result, body = propose(
                f"{prompt}\n\nYour proposal was tested on the dev samples and these anchors "
                f"need work:\n<anchor_misses>\n{feedback}\n</anchor_misses>\n"
                "Propose the full set of changes again.",
                "draft-sections-anchors",
            )
            grid, final_misses = anchor_check(samples, draft, body)
            if grid is None:
                raise DocumentError(final_misses[0])
        body = {**body, "anchorCheck": grid}
    elif (
        stage.id == "revise"
        and samples
        and any(c["op"] in ("putSection", "setCopies") for c in body["changes"])
    ):
        # One pass, no feedback round: a runaway anchor must not reach the Sections tab.
        segment_with_timeout(
            [(s.sample_id, s.pages) for s in samples], _segment_document(draft, body)
        )

    last = result.attempts[-1]
    output = {
        "stage": stage.id,
        "model": result.model_ref,
        "body": body,
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


def anchor_check(
    samples: list[DraftSample], draft: dict[str, Any], body: dict[str, Any]
) -> tuple[dict[str, Any] | None, list[str]]:
    """Apply a sections proposal to the draft and segment every dev sample with it (the same
    code as the anchor preview, capped by SEGMENT_TIMEOUT_S). Returns the grid and the misses
    worth feeding back: an anchor that matches no sample, or a required one that misses any."""
    block = apply_changes(draft, body["changes"])["document"]
    document = _segment_document(draft, body)
    try:
        grid = segment_with_timeout([(s.sample_id, s.pages) for s in samples], document)
    except DocumentError as exc:
        return None, [str(exc)]
    names = {s.sample_id: s.filename for s in samples}
    rows = [row for row in grid["samples"] if not row.get("error")]
    misses: list[str] = []
    put_ids = {c["section"]["id"] for c in body["changes"] if c["op"] == "putSection"}
    for section in block["sections"]:
        sid = section["id"]
        if sid not in put_ids:
            continue
        if sid in grid["anchorErrors"]:
            misses.append(f'section "{sid}": {grid["anchorErrors"][sid]}')
            continue
        missed = [
            names.get(row["sampleId"], row["sampleId"])
            for row in rows
            if not any(c["id"] == sid and c["found"] for c in row["sections"])
        ]
        if rows and len(missed) == len(rows):
            misses.append(
                f'section "{sid}": anchor {section["anchor"]!r} matched none of the dev samples'
            )
        elif missed and section.get("required", True):
            misses.append(
                f'section "{sid}" is required but anchor {section["anchor"]!r} missed: '
                f"{', '.join(missed)}"
            )
    return grid, misses


def _segment_document(draft: dict[str, Any], body: dict[str, Any]) -> SegmentDocument:
    """The draft's document block with a proposal's changes applied, as segmentation sees it."""
    block = apply_changes(draft, body["changes"])["document"]
    return SegmentDocument.model_validate(
        {k: block[k] for k in ("sections", "copies", "pageMarkers") if k in block}
    )


def _audit(deps: PipelineDeps, job: ClaimedJob, label: str, attempts: list[Any]) -> None:
    for a in attempts:
        record = {"prompt": a.prompt, "response": a.response, "errors": a.errors}
        deps.store.put(
            deps.buckets.runs,
            run_key(job.id, label, a.n),
            json.dumps(record).encode(),
            "application/json",
        )
