"""Workbench drafting (ADR 0007): turn the brief, the current draft and the dev samples into
one context, ask the `draft` model for a stage body, validate it, write it to the runs bucket.

build_context is the single place that decides what a drafting model sees. Holdout samples
are refused here even though the API never sends them."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, cast

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .draft_changes import apply_changes
from .draft_stages import OUTPUTS, REVISE, SECTIONS, STEPS, Stage, resolve_answers
from .extract import (
    ExtractionFailedError,
    ExtractionResult,
    OutputTruncatedError,
    run_extraction,
)
from .llm.base import (
    ContextExceededError,
    LLMProvider,
    ModelUnavailableError,
    RefusalError,
    ToolCapable,
)
from .mapping_stage import MAPPING as MAPPING_STAGE
from .occurrence_check import occurrence_round
from .ontology_suggest import LibraryVersion, SuggestCandidate, SuggestPin, queue_suggestions
from .pipeline import (
    DocumentError,
    JobCancelled,
    JobModels,
    PipelineDeps,
    advisory_event,
    check_cancelled,
)
from .queue import ClaimedJob, JobQueue
from .storage import draft_log_key, drafting_key, prepared_text_key
from .tool_loop import Tool, run_tool_extraction
from .workbench import SegmentDocument, segment_with_timeout

#: What tells a tool-using model how to answer (added after the stage's instructions).
TOOLS_NOTE = (
    "\n\nYou may call the tools offered to check your work before answering. Answer by calling "
    "submit with the JSON described above: it is the only way to answer."
)

MAX_SAMPLE_CHARS = 40_000
MAX_CONTEXT_SAMPLES = 8
log = logging.getLogger(__name__)

#: Output budget of one drafting call when its model sets none (Administration > Models: Max output
#: tokens; TS DEFAULT_MAX_OUTPUT_TOKENS).
DRAFT_MAX_TOKENS = 16_000

#: Model calls per proposal round: the first reply, then one more with its errors fed back.
DRAFT_ATTEMPTS = 2

#: A running drafting stage's progress (issue #151; TS DRAFT_PROGRESS_EVENT, DraftProgressSchema;
#: shared fixture draft-progress.json): one event per phase and per model call. Advisory.
DRAFT_PROGRESS = "drafting progress"

DraftPhase = Literal["reading", "model", "anchors", "suggestions"]

#: A streamed reply's token count is reported at once, then after this many more tokens or
#: seconds: often enough to show it moving, never an event per token.
TOKEN_STEP = 500
TOKEN_EVERY_S = 5.0


class TokenThrottle:
    """Passes a model call's growing token estimate on now and then (TOKEN_STEP, TOKEN_EVERY_S)."""

    def __init__(
        self, report: Callable[[int], None], clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._report = report
        self._clock = clock
        self._last: int | None = None
        self._at = 0.0

    def __call__(self, tokens: int) -> None:
        now = self._clock()
        if self._last is not None and (
            tokens <= self._last
            or (tokens - self._last < TOKEN_STEP and now - self._at < TOKEN_EVERY_S)
        ):
            return
        self._last, self._at = tokens, now
        self._report(tokens)


def progress_reporter(
    job: ClaimedJob, queue: JobQueue, stage: str, samples: int
) -> Callable[..., None]:
    """Report a phase of the run: reading the samples, each model call (its attempt, then its
    streamed reply's tokens so far), testing anchors, queuing ontology suggestions. `round` 2 is
    the sections stage's anchor round."""

    def report(
        phase: DraftPhase,
        *,
        attempt: int | None = None,
        round: int = 1,
        tokens: int | None = None,
        tool: dict[str, str] | None = None,
        tool_calls: int | None = None,
    ) -> None:
        data: dict[str, Any] = {
            "stage": stage,
            "phase": phase,
            "samples": samples,
            "attempt": attempt,
            "of": DRAFT_ATTEMPTS if attempt is not None else None,
            "round": round,
            # A streamed reply's estimated tokens so far (model phase only).
            "tokens": tokens,
        }
        if tool_calls is not None:  # a conversation with tools: the running tool and the count
            data["tool"] = tool
            data["toolCalls"] = tool_calls
        advisory_event(job, queue, DRAFT_PROGRESS, data)

    return report


class CallProgress:
    """Reports a drafting model call as it goes: each attempt, its streamed reply's tokens now
    and then (TokenThrottle) and, in a conversation with tools, each tool as it starts (at once,
    with the tokens so far) and the number of tool calls."""

    def __init__(self, report: Callable[..., None], *, round: int = 1, tools: bool = False) -> None:
        self._report = report
        self._round = round
        self._tools = tools
        self._attempt = 1
        self._tokens: int | None = None
        self._tool: dict[str, str] | None = None
        self._calls = 0
        self._throttle = TokenThrottle(lambda _t: None)

    def _emit(self, tokens: int | None) -> None:
        extra = {"tool": self._tool, "tool_calls": self._calls} if self._tools else {}
        self._report("model", attempt=self._attempt, round=self._round, tokens=tokens, **extra)

    def on_attempt(self, n: int) -> None:
        self._attempt = n
        if not self._tools:  # a new call counts from 0; a conversation's count goes on
            self._tokens = None
        self._emit(self._tokens)
        self._throttle = TokenThrottle(self._emit)

    def on_tokens(self, tokens: int) -> None:
        self._tokens = tokens
        self._throttle(tokens)

    def on_tool(self, name: str | None, summary: str, calls: int) -> None:
        self._tool = {"name": name, "summary": summary} if name else None
        self._calls = calls
        self._emit(self._tokens)


class DraftLog:
    """A drafting job's model log (TS DraftLogSchema, `draftLogKey`): each proposal round's
    prompt, replies, tool calls and results, rejections and the error that ended it, written to
    the runs bucket after every round, whatever its outcome. The Workbench shows it as the
    proposal's Model log."""

    def __init__(self, deps: PipelineDeps, job: ClaimedJob, stage: str, model: str) -> None:
        self._deps = deps
        self._job = job
        self._stage = stage
        self._model = model
        self.tools = False
        self.rounds: list[dict[str, Any]] = []

    def round(self, label: str) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        self.rounds.append({"label": label, "entries": entries})
        return entries

    def body(self) -> dict[str, Any]:
        return {
            "stage": self._stage,
            "model": self._model,
            "tools": self.tools,
            "rounds": self.rounds,
        }

    def write(self) -> None:
        """Advisory: a log that cannot be written never fails the stage."""
        try:
            self._deps.store.put(
                self._deps.buckets.runs,
                draft_log_key(self._job.id),
                json.dumps(self.body()).encode(),
                "application/json",
            )
        except Exception as exc:
            log.warning("job %s: the model log could not be written: %s", self._job.id, exc)


def _failure(exc: Exception, limit: int) -> DocumentError | None:
    """What a designer reads when a proposal call fails; None: raise it as it is (a retry)."""
    if isinstance(exc, OutputTruncatedError):
        return DocumentError(truncated_reason(limit))
    if isinstance(exc, ExtractionFailedError):
        return DocumentError(str(exc))
    if isinstance(exc, RefusalError):
        return DocumentError(f"drafting model refused: {exc}")
    if isinstance(exc, ContextExceededError):  # a retry would repeat it
        return DocumentError(context_reason(limit))
    if isinstance(exc, ModelUnavailableError):  # likewise: the server has no such model
        return DocumentError(unavailable_reason(exc))
    return None


def ask(
    job: ClaimedJob,
    deps: PipelineDeps,
    *,
    log_to: DraftLog,
    label: str,
    provider: LLMProvider,
    model_id: str,
    prompt: str,
    schema: dict[str, Any],
    limit: int,
    check: Callable[[dict[str, Any]], list[str]] | None,
    tools: list[Tool],
    progress: CallProgress,
    retry_note: str = "Return corrected JSON only.",
    checkpoint: Callable[[], None] | None = None,
) -> ExtractionResult:
    """One drafting or mapping proposal: a conversation with `tools` when there are any (the
    endpoint allows them), else single replies as before. Errors become the DocumentErrors a
    designer reads; the round goes into the model log either way."""
    entries = log_to.round(label)
    log_to.tools = log_to.tools or bool(tools)
    try:
        if tools:
            result = run_tool_extraction(
                extraction_id=label,
                provider=cast(ToolCapable, provider),
                model_id=model_id,
                prompt=prompt + TOOLS_NOTE,
                schema=schema,
                max_attempts=DRAFT_ATTEMPTS,
                tools=tools,
                max_tokens=limit,
                system=DRAFT_SYSTEM,
                check=check,
                on_attempt=progress.on_attempt,
                on_tokens=progress.on_tokens,
                on_tool=progress.on_tool,
                retry_note=retry_note,
                transcript=entries,
                checkpoint=checkpoint,
            )
        else:
            result = run_extraction(
                extraction_id=label,
                provider=provider,
                model_id=model_id,
                prompt=prompt,
                schema=schema,
                max_attempts=DRAFT_ATTEMPTS,
                max_tokens=limit,
                system=DRAFT_SYSTEM,
                check=check,
                on_attempt=progress.on_attempt,
                on_tokens=progress.on_tokens,
                retry_note=retry_note,
                transcript=entries,
                checkpoint=checkpoint,
            )
    except Exception as exc:
        failure = _failure(exc, limit)
        cancelled = isinstance(exc, JobCancelled)
        entries.append(
            {"kind": "error", "message": "Cancelled." if cancelled else str(failure or exc)}
        )
        log_to.write()
        if failure is not None:
            raise failure from exc
        raise
    log_to.write()
    return result


def output_limit(deps: PipelineDeps, model_ref: str) -> int:
    """A drafting or mapping call's output budget: its model's limit, else DRAFT_MAX_TOKENS."""
    return deps.models.max_output_tokens(model_ref) or DRAFT_MAX_TOKENS


def truncated_reason(limit: int) -> str:
    """Why a drafting stage stopped when the model's reply hit its output limit (no model ref:
    people other than admins read it)."""
    return (
        f"The drafting model's reply was cut off at its output limit ({limit:,} tokens). "
        "An admin can raise the model's Max output tokens under Administration > Models, or the stage "
        "can be run again with less to propose."
    )


def unavailable_reason(error: Exception) -> str:
    """Why a drafting stage stopped when its model is not on its server (no model ref, as
    `truncated_reason`; the server's own words usually name it)."""
    return (
        "The drafting model is not available on its server, so the stage cannot run: an admin "
        "can load it there (e.g. in LM Studio) or choose another drafting model under "
        f"Administration > Models. The server said: {error}"
    )


def context_reason(limit: int) -> str:
    """Why a drafting stage stopped when its request did not fit the drafting model's context
    window (no model ref, as `truncated_reason`)."""
    return (
        "The drafting model's context window, as loaded on its server, is too small for this "
        f"stage's request and its output limit ({limit:,} tokens). An admin can raise the "
        "model's context length on its server (e.g. LM Studio) or lower its Max output tokens "
        "under Administration > Models."
    )


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


#: Ends a drafting retry: a reply is the whole proposal, never a patch on the rejected one
#: (a model that sent only the removals, then only the additions, never passed).
DRAFT_RETRY_NOTE = (
    "Your corrected response replaces your previous response entirely: repeat every change "
    "from it that you still want, then fix the errors above. Return corrected JSON only."
)
#: How many of the draft's own problems the prompt lists.
MAX_DRAFT_PROBLEMS = 30


def problems_block(problems: list[str]) -> str:
    """The draft's own problems as a prompt block (empty without any), ahead of the task."""
    if not problems:
        return ""
    shown = problems[:MAX_DRAFT_PROBLEMS]
    more = len(problems) - len(shown)
    lines = "\n".join(f"- {p}" for p in shown) + (f"\n- and {more} more" if more else "")
    return (
        "<current_draft_problems>\n"
        "The current draft already fails these checks; your changes must fix every one:\n"
        f"{lines}\n"
        "A putStep with an existing id replaces that step; removeStep drops a step that reads "
        "a section or fills an output the draft no longer has.\n"
        "</current_draft_problems>\n\n"
    )


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
    diagnostics: dict[str, Any] | None = None,
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
    if diagnostics:
        version = (diagnostics.get("from") or {}).get("draftVersion")
        # Job ids and the run time are for people (the preview), not the model.
        rows = {k: diagnostics.get(k) or [] for k in ("steps", "columns", "missedKeys")}
        blocks.append(
            f'<run_diagnostics draftVersion="{version}">\n'
            f"{json.dumps(rows, indent=1, ensure_ascii=False)}\n"
            "</run_diagnostics>"
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
    #: Revise: what the latest dev runs of the draft showed (TS RunDiagnostics; dev samples only).
    diagnostics: dict[str, Any] | None = None
    #: The mapping stage (ADR 0011): the brief's vocabulary, its guidance, observed values.
    mapping: dict[str, Any] | None = None
    #: Survey (ontology suggestions): the library's newest ready versions and the brief's
    #: vocabulary pins; empty: no suggestions.
    library: list[LibraryVersion] = Field(default_factory=list)
    pinned: list[SuggestPin] = Field(default_factory=list)


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


def dev_diagnostics(
    diagnostics: dict[str, Any] | None, dev_files: set[str]
) -> dict[str, Any] | None:
    """Run diagnostics (TS RunDiagnostics) keeping only rows of dev samples: the API reads dev
    runs only, so this is a defensive no-op on its input. A column row counts every sample it
    names, so one naming any other sample is dropped whole. None when no row is left."""
    if not diagnostics:
        return None

    def rows(key: str) -> list[dict[str, Any]]:
        value = diagnostics.get(key)
        return [r for r in value if isinstance(r, dict)] if isinstance(value, list) else []

    steps = [r for r in rows("steps") if r.get("sample") in dev_files]
    columns = [
        r
        for r in rows("columns")
        if isinstance(r.get("samples"), list)
        and r["samples"]
        and all(name in dev_files for name in r["samples"])
    ]
    missed = [r for r in rows("missedKeys") if r.get("sample") in dev_files]
    if not (steps or columns or missed):
        return None
    return {**diagnostics, "steps": steps, "columns": columns, "missedKeys": missed}


def diagnostics_samples(diagnostics: dict[str, Any] | None) -> set[str]:
    """Every sample file name run diagnostics name (for the external-call audit)."""
    if not diagnostics:
        return set()
    names = {str(r["sample"]) for r in diagnostics["steps"] + diagnostics["missedKeys"]}
    return names | {str(n) for r in diagnostics["columns"] for n in r["samples"]}


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
    provider, model_id = JobModels(job, deps.models).resolve(ref, what="drafting model")
    model_ref = f"{provider.name}/{model_id}"
    if stage.id == "mapping":
        from .mapping_stage import run_mapping

        return run_mapping(job, deps, queue, params, provider, model_id, model_ref)

    limit = output_limit(deps, model_ref)
    sent = params.samples[:MAX_CONTEXT_SAMPLES]
    report = progress_reporter(job, queue, stage.id, len(sent))
    report("reading")
    samples = [
        DraftSample(s.sample_id, s.filename, s.role, prepared_pages(deps, s.sha256)) for s in sent
    ]
    # Defence in depth for the holdout rule: the API already filters, the worker re-checks.
    names = {s.filename for s in params.samples if s.role == "dev"}
    dev_feedback = [f for f in params.feedback if not f.get("sample") or f["sample"] in names]
    # The worst-scoring failures are the most worth fixing; the cap keeps the prompt bounded.
    dev_failures = select_failures(params.failures, names)
    diagnostics = dev_diagnostics(params.diagnostics, names)
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
        diagnostics=diagnostics,
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
                # Failures, feedback and diagnostics can name dev samples whose text is not sent.
                "referencedSamples": sorted(
                    {str(f["sample"]) for f in dev_feedback + dev_failures if f.get("sample")}
                    | diagnostics_samples(diagnostics)
                ),
            },
        )
    draft = params.draft or {}
    tools: list[Tool] = []
    if deps.models.supports_tools(provider.name):
        from .draft_tools import drafting_tools, sample_pages_tool

        tools = drafting_tools(
            stage.id,
            samples=samples,
            draft=draft,
            pages_tool=lambda: sample_pages_tool(
                job,
                deps,
                queue,
                stage=stage.id,
                model_ref=model_ref,
                external=deps.models.location(provider.name) == "external",
                samples=params.samples,
            ),
        )

    def check(data: dict[str, Any]) -> list[str]:
        body, errors = stage.convert(data) if stage.convert else (data, [])
        if not errors and stage.fit is not None:
            body = stage.fit(body, draft)
        if not errors and stage.check is not None:
            errors = stage.check(body, draft)
        return errors

    model_log = DraftLog(deps, job, stage.id, model_ref)

    def propose(prompt: str, label: str, round: int = 1) -> tuple[ExtractionResult, dict[str, Any]]:
        result = ask(
            job,
            deps,
            log_to=model_log,
            label=label,
            provider=provider,
            model_id=model_id,
            prompt=prompt,
            schema=stage.schema,
            limit=limit,
            check=check if (stage.convert or stage.check) else None,
            tools=tools,
            progress=CallProgress(report, round=round, tools=bool(tools)),
            retry_note=DRAFT_RETRY_NOTE,
            checkpoint=lambda: check_cancelled(job, queue),
        )
        body = stage.convert(result.data)[0] if stage.convert else result.data
        if stage.fit is not None:
            body = stage.fit(body, draft)
        return result, body

    problems = stage.problems(draft) if stage.problems is not None else []
    prompt = f"{context}\n\n{problems_block(problems)}{stage.instructions}"
    result, body = propose(prompt, f"draft-{stage.id}")
    if stage.id == "revise":
        body = resolve_answers(body, labels)
    if stage.id == "survey":
        body = clamp_seen_in(body, len(samples))
        if params.library:  # the ontology library's suggestions (advisory): a job of their own
            report("suggestions")
            try:
                suggest_id = queue_suggestions(
                    job,
                    deps,
                    queue,
                    candidates=[SuggestCandidate.model_validate(c) for c in body["candidates"]],
                    library=params.library,
                    pinned=params.pinned,
                    data_policy=params.data_policy,
                )
                log.info("job %s queued its ontology suggestions as job %s", job.id, suggest_id)
            except Exception as exc:  # advisory: the survey stands without suggestions
                log.warning("job %s: ontology suggestions failed: %s", job.id, exc)
                queue.event(job.id, "warn", "ontology suggestions failed", {"error": str(exc)})
    if stage.id == "sections":
        report("anchors")
        grid, misses = anchor_check(samples, draft, body)
        if misses:
            check_cancelled(job, queue)
            feedback = "\n".join(misses)
            result, body = propose(
                f"{prompt}\n\nYour proposal was tested on the dev samples and these anchors "
                f"need work:\n<anchor_misses>\n{feedback}\n</anchor_misses>\n"
                "Propose the full set of changes again.",
                "draft-sections-anchors",
                round=2,
            )
            report("anchors", round=2)
            grid, final_misses = anchor_check(samples, draft, body)
            if grid is None:
                raise DocumentError(final_misses[0])
        body = {**body, "anchorCheck": grid}
    elif stage.id == "steps" and samples:
        # Steps reading every occurrence of a section whose blocks come in kinds: one round to
        # set occurrence filters (also drops chunkPages short occurrences do not need).
        report("anchors")
        pages = [(s.filename, s.pages) for s in samples]
        body, findings = occurrence_round(pages, draft, body)
        if findings:
            check_cancelled(job, queue)
            feedback = "\n".join(findings)
            result, body = propose(
                f"{prompt}\n\nYour pipeline was checked on the dev samples' occurrences:\n"
                f"<occurrence_check>\n{feedback}\n</occurrence_check>\n"
                "Propose the full set of changes again.",
                "draft-steps-occurrences",
                round=2,
            )
            report("anchors", round=2)
            body, _ = occurrence_round(pages, draft, body)
    elif (
        stage.id == "revise"
        and samples
        and any(c["op"] in ("putSection", "setCopies") for c in body["changes"])
    ):
        # One pass, no feedback round: a runaway anchor must not reach the Sections tab.
        report("anchors")
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
        if f"{sid}.key" in grid["anchorErrors"]:
            misses.append(f'section "{sid}": key: {grid["anchorErrors"][f"{sid}.key"]}')
        misses += [
            f"{names.get(row['sampleId'], row['sampleId'])}: {issue}"
            for row in rows
            for issue in row.get("keyIssues", [])
            if issue.split(" ", 1)[0].rstrip(":") == sid
        ]
        missed = [
            names.get(row["sampleId"], row["sampleId"])
            for row in rows
            if not any(c["id"] == sid and c["found"] for c in row["sections"])
        ]
        hint = suggestion_hint(grid, sid, names)
        if rows and len(missed) == len(rows):
            misses.append(
                f'section "{sid}": anchor {section["anchor"]!r} matched none of the dev samples'
                + hint
            )
        elif missed and section.get("required", True):
            misses.append(
                f'section "{sid}" is required but anchor {section["anchor"]!r} missed: '
                f"{', '.join(missed)}{hint}"
            )
    misses += repeated_blocks(rows, put_ids, names)
    misses += missed_key_feedback(rows, put_ids, names, block["sections"])
    misses += repeated_key_feedback(rows, put_ids, names)
    return grid, misses


def suggestion_hint(grid: dict[str, Any], section: str, names: dict[str, str]) -> str:
    """The grid's first anchor suggestion for a section that missed (anchor_hints, the same one
    the Sections tab offers), as a sentence to add to the miss; "" when there is none."""
    hint = next((s for s in grid.get("suggestions", []) if s["section"] == section), None)
    if hint is None:
        return ""
    name = names.get(hint["sampleId"], hint["sampleId"])
    return f". Suggested anchor for {name}: {hint['anchor']} ({hint['reason']})"


def repeated_blocks(
    rows: list[dict[str, Any]], put_ids: set[str], names: dict[str, str]
) -> list[str]:
    """Two or more proposed sections whose anchors each match several times in one sample: the
    document repeats a block (per batch, per item), which first-match segmentation cannot split.
    One section that matches twice is common (a "Total" line) and is not reported."""
    out: list[str] = []
    for row in rows:
        repeats = [c for c in row["sections"] if c["id"] in put_ids and c.get("matches", 0) > 1]
        if len(repeats) < 2:
            continue
        ids = ", ".join(f'"{c["id"]}"' for c in repeats)
        times = max(c["matches"] for c in repeats)
        out.append(
            f"sections {ids} each match {times} times in "
            f"{names.get(row['sampleId'], row['sampleId'])}: the document repeats a block "
            "(per batch, item or similar). A plain section starts only at its anchor's first "
            "match and runs to the next section, so every later block ends up in the last "
            "section. Set repeat true on each of these sections (every match then starts an "
            "occurrence), with a key reading the block's identifier and keyFrom naming the "
            "block's heading section if there is one; keep plain sections for parts that "
            "occur once."
        )
    return out


def missed_key_feedback(
    rows: list[dict[str, Any]],
    put_ids: set[str],
    names: dict[str, str],
    sections: list[dict[str, Any]],
) -> list[str]:
    """Headings a proposed repeating section's key pattern finds that no anchor caught, per
    sample and group of sections sharing the key: usually a title that wraps over lines."""
    keys = {s["id"]: s.get("key") for s in sections}
    out: list[str] = []
    for row in rows:
        groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
        for entry in row.get("missedKeys", []):
            groups.setdefault(tuple(entry["sections"]), []).append(entry)
        for ids, entries in groups.items():
            if not put_ids.intersection(ids):
                continue
            # missedKeysTotal counts the whole sample's keys, so it is exact for one group only.
            total = row.get("missedKeysTotal", len(entries)) if len(groups) == 1 else len(entries)
            named = [e["key"] for e in entries[:10]]
            more = f" (and {total - len(named)} more)" if total > len(named) else ""
            pattern = next((keys[i] for i in ids if keys.get(i)), "")
            quoted = ", ".join(f'"{i}"' for i in ids)
            out.append(
                f"sections {quoted} have key {pattern}, which finds keys "
                f"{', '.join(named)}{more} in "
                f"{names.get(row['sampleId'], row['sampleId'])} that no anchor matched, "
                f'e.g. "{entries[0]["line"]}". '
                "If these are headings of the kind this section reads, widen the anchor: "
                "headings may wrap over several lines, so look ahead across them (for example "
                r"^\s*Table\s+\d+:(?=(?:(?!<first column header>)[\s\S]){0,400}?"
                r"<last word of the title>[ \t]*$)) rather than requiring the whole title on one "
                "line, and keep contents entries out. If they are headings of a kind the recipe "
                "does not read, make the key match only this kind's headings so they are not "
                "counted."
            )
    return out


#: Characters of an occurrence's line quoted in repeated-key feedback.
_QUOTED_LINE = 80


def repeated_key_feedback(
    rows: list[dict[str, Any]], put_ids: set[str], names: dict[str, str]
) -> list[str]:
    """Keys a proposed repeating section read from more than one of its occurrences, per sample
    and section: its anchor also catches lines that are not its headings, usually contents
    entries. The first key's occurrences are quoted with their page and line."""
    out: list[str] = []
    for row in rows:
        by_section: dict[str, list[dict[str, Any]]] = {}
        for entry in row.get("repeatedKeys", []):
            if entry["section"] in put_ids:
                by_section.setdefault(entry["section"], []).append(entry)
        for sid, entries in by_section.items():
            # repeatedKeysTotal counts the whole sample's keys, so it is exact for one section only.
            total = (
                row.get("repeatedKeysTotal", len(entries)) if len(by_section) == 1 else len(entries)
            )
            named = [e["key"] for e in entries[:10]]
            more = f" (and {total - len(named)} more)" if total > len(named) else ""
            cell: dict[str, Any] = next((c for c in row["sections"] if c["id"] == sid), {})
            occurrences: list[dict[str, Any]] = cell.get("occurrences", [])
            first = entries[0]
            quoted = [
                f'p.{o["page"]} "{(o["line"] or "")[:_QUOTED_LINE]}"'
                for n in first["occurrences"][:3]
                if 0 < n <= len(occurrences)
                for o in [occurrences[n - 1]]
            ]
            where = (
                ", ".join(quoted[:-1]) + " and " + quoted[-1]
                if len(quoted) > 1
                else "".join(quoted)
            )
            out.append(
                f'section "{sid}" reads keys {", ".join(named)}{more} more than once in '
                f"{names.get(row['sampleId'], row['sampleId'])}, e.g. key {first['key']} at "
                f"{where}. Its anchor also catches lines that are not this section's headings, "
                'usually table-of-contents entries, running headers or "continued" lines. '
                "Tighten the anchor so it matches only the heading itself, one occurrence per "
                "key: for example require what follows the number on the heading but not in "
                "the contents (the gap after the colon, the first word of the title), or leave "
                "out lines that end in dots and a page number."
            )
    return out


def _segment_document(draft: dict[str, Any], body: dict[str, Any]) -> SegmentDocument:
    """The draft's document block with a proposal's changes applied, as segmentation sees it."""
    block = apply_changes(draft, body["changes"])["document"]
    return SegmentDocument.model_validate(
        {k: block[k] for k in ("sections", "copies", "pageMarkers") if k in block}
    )
