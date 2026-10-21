"""The Pipeline stage's check of a pipeline against the dev samples' occurrences (plan
2026-10-21-occurrence-filter, Tasks C2 and C3).

Several table steps reading one repeating section each run once per occurrence. When each wants
one kind of block (the heading names the test), every other call is wasted, so the stage is told
which kinds of heading the samples hold and asked for occurrence filters, once. Filters that
match nothing and kinds no filter reads are reported too, and chunkPages on a step whose
occurrences are only a few pages long is dropped (each occurrence is already its own call)."""

from __future__ import annotations

import logging
import re
from typing import Any

from .capped import CallFailed, CallTimedOut, capped_call
from .draft_changes import apply_changes
from .errors import DocumentError
from .pipeline import PAGE_MARKER, content_pages, mark_pages
from .segment import (
    MissingSectionsError,
    head_matches,
    occurrence_head,
    segment_occurrences,
    select_copy,
)
from .specs import CopySelection, Section

log = logging.getLogger(__name__)

#: Characters of a head that decide its kind (a wrapped title fits; most of the body does not).
KIND_CHARS = 160
#: Characters of a head quoted back to the model.
QUOTE_CHARS = 120
#: An occurrence at most this many pages long is never chunked by a drafted step.
MIN_CHUNKED_OCCURRENCE_PAGES = 8
#: Longest the check's segmentation may run (as the anchor preview, workbench.SEGMENT_TIMEOUT_S).
CHECK_TIMEOUT_S = 10.0

Samples = list[tuple[str, list[str]]]


def _kind(head: str) -> str:
    """What a head says without its numbers and punctuation: occurrences of one kind of block
    (keys and table numbers apart) share it."""
    return " ".join(re.sub(r"[^a-z]+", " ", head[:KIND_CHARS].lower()).split())


def _quote(head: str) -> str:
    cut = head[:QUOTE_CHARS]
    return f'"{cut}…"' if len(head) > QUOTE_CHARS else f'"{cut}"'


def _matches(pattern: str, head: str) -> bool:
    try:
        return head_matches(pattern, head)
    except re.error:  # the step check reports an invalid pattern
        return False


def _heads(samples: Samples, document: dict[str, Any]) -> dict[str, list[tuple[str, int]]]:
    """Every repeating section's occurrences across the samples: (head, pages), segmented as a
    job would be. A sample that does not segment (a missing required section, an invalid anchor)
    is left out: the sections stage and the Sections tab report those."""
    sections = [Section.model_validate(s) for s in document.get("sections") or []]
    copies = CopySelection.model_validate(document["copies"]) if document.get("copies") else None
    markers = document.get("pageMarkers", True)
    out: dict[str, list[tuple[str, int]]] = {}
    for _, pages in samples:
        if not pages:
            continue
        first, kept = select_copy(pages, copies) if copies else (0, pages)
        if markers:
            kept = mark_pages(kept, first + 1)
        try:
            segmented = segment_occurrences(
                kept, sections, page_marker=PAGE_MARKER if markers else None
            )
        except (MissingSectionsError, re.error):
            continue
        for sid, found in segmented.occurrences.items():
            out.setdefault(sid, []).extend(
                (occurrence_head(o.text), len(content_pages(o.text))) for o in found
            )
    return out


def occurrence_findings(
    samples: Samples, definition: dict[str, Any]
) -> tuple[list[str], dict[str, int]]:
    """Feedback lines for the definition's table steps over the samples' repeating sections,
    and each repeating section's longest occurrence in pages. Pure, but it runs the recipe's
    anchors and filters: callers run it capped (occurrence_round)."""
    seen = _heads(samples, definition.get("document") or {})
    steps = [
        s
        for s in definition.get("pipeline") or []
        if s.get("type") in ("extract", "plugin") and s.get("table")
    ]
    lines: list[str] = []
    for sid, occurrences in seen.items():
        reading = [s for s in steps if sid in (s.get("sections") or [])]
        if not reading or not occurrences:
            continue
        heads = [h for h, _ in occurrences]
        examples = list(dict.fromkeys(heads))[:3]
        for s in reading:
            pattern = (s.get("occurrences") or {}).get("match")
            if pattern and not any(_matches(pattern, h) for h in heads):
                lines.append(
                    f"step {s['id']!r}: occurrenceMatch {pattern!r} matches none of the "
                    f'{len(heads)} occurrences of "{sid}" in the dev samples; their headings '
                    f"begin: {', '.join(_quote(h) for h in examples)}"
                )
        kinds: dict[str, list[str]] = {}
        for h in heads:
            kinds.setdefault(_kind(h), []).append(h)
        repeated = {k: hs for k, hs in kinds.items() if len(hs) >= 2}
        listed = "; ".join(f"{len(hs)} like {_quote(hs[0])}" for hs in repeated.values())
        unfiltered = [s["id"] for s in reading if not s.get("occurrences")]
        tables = {s["table"] for s in reading}
        if unfiltered and len(tables) >= 2 and len(repeated) >= 2:
            lines.append(
                f"steps {', '.join(repr(i) for i in unfiltered)} read every occurrence of "
                f'"{sid}", whose headings come in {len(repeated)} kinds: {listed}. If each step '
                "wants one kind, set occurrenceMatch on it to words of that kind's heading; "
                "leave it null for a step that really wants every occurrence."
            )
        elif not unfiltered:
            patterns = [s["occurrences"]["match"] for s in reading]
            missed = {
                k: hs
                for k, hs in repeated.items()
                if not any(_matches(p, h) for p in patterns for h in hs)
            }
            if missed:
                kinds_text = "; ".join(f"{len(hs)} like {_quote(hs[0])}" for hs in missed.values())
                lines.append(
                    f'occurrences of "{sid}" no step reads (no occurrenceMatch matches them): '
                    f"{kinds_text}. Add a step if the brief wants them, or widen a filter."
                )
    longest = {sid: max(n for _, n in occ) for sid, occ in seen.items() if occ}
    return lines, longest


def _fit_chunks(
    body: dict[str, Any], definition: dict[str, Any], longest: dict[str, int]
) -> dict[str, Any]:
    repeating = {
        s.get("id")
        for s in (definition.get("document") or {}).get("sections") or []
        if s.get("repeat")
    }
    changes: list[dict[str, Any]] = []
    dropped: list[str] = []
    for c in body["changes"]:
        step = c.get("step") if c["op"] == "putStep" else None
        section = next((i for i in (step or {}).get("sections") or [] if i in repeating), None)
        pages = longest.get(section) if section is not None else None
        if (
            step
            and step.get("chunkPages")
            and pages is not None
            and pages <= MIN_CHUNKED_OCCURRENCE_PAGES
        ):
            dropped.append(
                f"Ignored chunkPages on {step['id']!r}: the longest occurrence of "
                f"{section!r} in the dev samples is {pages} page{'' if pages == 1 else 's'}, "
                "and each occurrence is already its own call."
            )
            c = {**c, "step": {k: v for k, v in step.items() if k != "chunkPages"}}
        changes.append(c)
    if not dropped:
        return body
    notes = "\n".join([body["notes"], *dropped] if body.get("notes") else dropped)
    return {**body, "notes": notes, "changes": changes}


def occurrence_round(
    samples: Samples,
    draft: dict[str, Any],
    body: dict[str, Any],
    timeout_s: float = CHECK_TIMEOUT_S,
) -> tuple[dict[str, Any], list[str]]:
    """A steps proposal checked on the dev samples: the body with unneeded chunkPages dropped,
    and the feedback worth one more round. The segmentation runs in a capped child process; a
    timeout is a DocumentError (an anchor that backtracks), any other failure skips the check."""
    definition = apply_changes(draft, body["changes"])
    try:
        lines, longest = capped_call(occurrence_findings, [samples, definition], timeout_s)
    except CallTimedOut as exc:
        raise DocumentError(
            f"checking the pipeline on the dev samples took longer than {timeout_s:g}s; an "
            "anchor or occurrence filter may backtrack catastrophically"
        ) from exc
    except CallFailed as exc:
        log.warning("occurrence check skipped: %s", exc)
        return body, []
    return _fit_chunks(body, definition, longest), lines
