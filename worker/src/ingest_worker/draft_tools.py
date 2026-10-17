"""Tools a drafting model may call before it answers (`tool_loop`): test section anchors on the
dev samples, and read more pages of a dev sample. The mapping stage's ontology tools live in
`mapping_stage`.

Every tool reads only what drafting may already see: dev samples, never holdout ones. Reading
pages for an external model is logged as an `external model call` event, like the prompt."""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any

from .draft_stages import SECTIONS_SCHEMA, check_sections, convert_sections
from .drafting import DraftParamSample, DraftSample, anchor_check, prepared_pages
from .llm.base import ToolSpec
from .pipeline import PipelineDeps
from .queue import ClaimedJob, JobQueue
from .tool_loop import Tool, ToolError

#: Pages one read may return, and characters per read and per conversation.
MAX_READ_PAGES = 5
MAX_READ_CHARS = 20_000
MAX_READ_TOTAL = 60_000


def _anchor_schema() -> dict[str, Any]:
    """The sections stage's change items, `reason` optional: what the model will propose."""
    item = copy.deepcopy(SECTIONS_SCHEMA["properties"]["changes"]["items"])
    item["required"] = ["op"]
    return {
        "type": "object",
        "properties": {"changes": {"type": "array", "items": item, "minItems": 1}},
        "required": ["changes"],
        "additionalProperties": False,
    }


def _flat(change: dict[str, Any]) -> dict[str, Any]:
    keys = SECTIONS_SCHEMA["properties"]["changes"]["items"]["properties"]
    return {k: change.get(k, "" if k == "reason" else None) for k in keys}


def _cell(cell: dict[str, Any]) -> str:
    """Where a section starts: its page and the first line it matched (cut at 40 characters)."""
    if not cell.get("found"):
        return "-"
    line = str(cell.get("line") or "").strip()
    where = f'p{cell["page"]} "{line[:40]}{"…" if len(line) > 40 else ""}"'
    occurrences = cell.get("occurrences") or []
    if occurrences:
        return f"{where} ({len(occurrences)} occurrences)"
    matches = cell.get("matches", 1)
    return where + (f" ({matches}x)" if matches > 1 else "")


def format_grid(grid: dict[str, Any], names: dict[str, str], problems: list[str]) -> str:
    """The segmentation grid as a compact table the model can read: where each section starts
    in each sample (page and matched line), `-` where it was not found, `Nx` where its anchor
    matches more than once; then the problems worth fixing and any suggested anchors."""
    rows = grid["samples"]
    ids = [c["id"] for c in rows[0]["sections"]] if rows else []
    lines = [
        f"Tested on {len(rows)} dev sample(s) with these changes applied to the draft.",
        "Where each section starts (page and the line it matched); - = not found.",
        "\t".join(["sample", *ids]),
    ]
    for row in rows:
        name = names.get(row["sampleId"], row["sampleId"])
        if row.get("error"):
            lines.append(f"{name}\t(error: {row['error']})")
            continue
        lines.append("\t".join([name, *(_cell(c) for c in row["sections"])]))
    errors = [f"{where}: {message}" for where, message in grid.get("anchorErrors", {}).items()]
    if errors:
        lines += ["", "Anchor errors:", *errors]
    if problems:
        lines += ["", "Problems:", *problems]
    suggestions = grid.get("suggestions") or []
    if suggestions:
        lines += ["", "Suggested anchors:"]
        lines += [
            f'section "{s["section"]}" in {names.get(s["sampleId"], s["sampleId"])}: '
            f"{s['anchor']!r} ({s['reason']})"
            for s in suggestions
        ]
    if not problems and not errors:
        lines += ["", "Every proposed anchor found its section where required."]
    return "\n".join(lines)


def anchor_tool(samples: list[DraftSample], draft: dict[str, Any]) -> Tool:
    """`test_anchors`: segment the dev samples with proposed section changes applied (the
    anchor check's code, capped by SEGMENT_TIMEOUT_S)."""
    names = {s.sample_id: s.filename for s in samples}

    def run(args: dict[str, Any]) -> str:
        body, errors = convert_sections(
            {"notes": "", "changes": [_flat(c) for c in args.get("changes") or []]}
        )
        errors = errors or check_sections(body, draft)
        if errors:
            raise ToolError("These changes cannot be tested:\n" + "\n".join(errors))
        grid, problems = anchor_check(samples, draft, body)
        if grid is None:
            raise ToolError(problems[0])
        return format_grid(grid, names, problems)

    def describe(args: dict[str, Any]) -> str:
        puts = sum(1 for c in args.get("changes") or [] if c.get("op") == "putSection")
        what = f"{puts} anchor{'s' if puts != 1 else ''}" if puts else "the changes"
        return f"Testing {what} on {len(samples)} dev sample{'s' if len(samples) != 1 else ''}"

    return Tool(
        ToolSpec(
            "test_anchors",
            "Try section changes on the dev samples before you answer: applies them to the "
            "current draft, splits every dev sample into sections and reports where each "
            "section starts (page and matched line), which samples miss it, anchors that match more than "
            "once, and suggested fixes. Pass the same change items you would answer with "
            "(putSection, removeSection, setCopies); reason may be left out.",
            _anchor_schema(),
        ),
        run,
        describe,
    )


def sample_pages_tool(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    *,
    stage: str,
    model_ref: str,
    external: bool,
    samples: list[DraftParamSample],
) -> Tool:
    """`read_sample_pages`: the text of some pages of any dev sample of the project, also those
    whose text the prompt left out. Holdout samples are never readable."""
    dev = {s.filename: s for s in samples if s.role == "dev"}
    pages_of: dict[str, list[str]] = {}
    read = [0]

    def pages(sample: DraftParamSample) -> list[str]:
        if sample.sha256 not in pages_of:
            pages_of[sample.sha256] = prepared_pages(deps, sample.sha256)
        return pages_of[sample.sha256]

    def run(args: dict[str, Any]) -> str:
        name = str(args.get("file", ""))
        sample = dev.get(name)
        if sample is None:
            raise ToolError(
                f"{name} is not a dev sample of this project; dev samples: "
                + ", ".join(sorted(dev))
            )
        text = pages(sample)
        first, last = int(args.get("fromPage", 1)), int(args.get("toPage", 0) or 0)
        last = last or first
        if first < 1 or first > len(text):
            raise ToolError(f"{name} has {len(text)} page(s); fromPage must be 1-{len(text)}")
        if last < first:
            raise ToolError("toPage must not be before fromPage")
        last = min(last, len(text), first + MAX_READ_PAGES - 1)
        budget = min(MAX_READ_CHARS, MAX_READ_TOTAL - read[0])
        if budget <= 0:
            raise ToolError("the reading budget for this run is spent: answer with what you have")
        out = "\n\n".join(f"[page {n}]\n{text[n - 1]}" for n in range(first, last + 1))
        cut = len(out) > budget
        out = out[:budget]
        read[0] += len(out)
        if external:
            queue.event(
                job.id,
                "info",
                "external model call",
                {
                    "stage": stage,
                    "model": model_ref,
                    "samples": [sample.sample_id],
                    "pages": [first, last],
                    "purpose": "tool",
                },
            )
        header = f"{name}, pages {first}-{last} of {len(text)}"
        if cut:
            header += " (cut at the reading limit)"
        return f"{header}\n\n{out}"

    def describe(args: dict[str, Any]) -> str:
        first = int(args.get("fromPage", 1) or 1)
        last = int(args.get("toPage", 0) or 0) or first
        span = f"page {first}" if last == first else f"pages {first} to {last}"
        return f"Reading {span} of {args.get('file', 'a sample')}"

    return Tool(
        ToolSpec(
            "read_sample_pages",
            "Read the text of pages of a dev sample, by its file name (also samples whose text "
            f"is not in the prompt). At most {MAX_READ_PAGES} pages a call.",
            {
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "The sample's file name."},
                    "fromPage": {"type": "integer", "minimum": 1},
                    "toPage": {"type": "integer", "minimum": 1},
                },
                "required": ["file", "fromPage", "toPage"],
                "additionalProperties": False,
            },
        ),
        run,
        describe,
    )


def drafting_tools(
    stage: str,
    *,
    samples: list[DraftSample],
    draft: dict[str, Any],
    pages_tool: Callable[[], Tool],
) -> list[Tool]:
    """The tools a drafting stage offers: sections test anchors; revise tests anchors and reads
    sample pages. Other stages offer none (they run as single replies)."""
    if stage == "sections":
        return [anchor_tool(samples, draft)] if samples else []
    if stage == "revise":
        return [*([anchor_tool(samples, draft)] if samples else []), pages_tool()]
    return []
