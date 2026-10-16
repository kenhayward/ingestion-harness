from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Literal

from .specs import CopySelection, Section

PAGE_BREAK = "\n\f\n"

KeySource = Literal["own", "inherited"]


class MissingSectionsError(Exception):
    def __init__(self, missing: list[str]) -> None:
        super().__init__(f"required sections not found: {', '.join(missing)}")
        self.missing = missing


@dataclass(frozen=True)
class SectionSpan:
    """A matched section: [start, end) offsets into the joined document text. A repeating
    section has one span per occurrence (`index` 0, 1, ...); `key` is its resolved key."""

    id: str
    start: int
    end: int
    index: int = 0
    key: str | None = None
    #: What the section's own `key` found in the occurrence's text (the key check compares it).
    own_key: str | None = None
    key_source: KeySource | None = None


def occurrence_key(pattern: str, text: str) -> str | None:
    """The named group `key`, else group 1, else the whole match; stripped; "" reads as None."""
    match = re.search(pattern, text, re.MULTILINE)
    if match is None:
        return None
    if "key" in match.re.groupindex:
        value = match.group("key")
    elif match.re.groups:
        value = match.group(1)
    else:
        value = match.group(0)
    return (value or "").strip() or None


def section_spans(text: str, sections: list[Section]) -> tuple[list[SectionSpan], list[str]]:
    """Where each section lies in `text`, in document order, plus the ids of unmatched sections.

    A section starts at the first match of its anchor (multiline regex); a repeating section
    starts an occurrence at every match. Each span runs until the next start of any section's
    occurrence. When anchors match at the same position, the section declared earlier gets an
    empty span and the later one the text, so a catch-all start-of-text section yields to a more
    specific one. An occurrence's key is what the section's `key` finds in its text, else the
    latest preceding key of its `keyFrom` section. Shared by production segmentation and the
    workbench preview grid. Raises re.error for an invalid anchor or key.
    """
    starts: list[tuple[int, int, int, Section]] = []
    unmatched: list[str] = []
    for order, section in enumerate(sections):
        if section.repeat:
            positions = [m.start() for m in re.finditer(section.anchor, text, re.MULTILINE)]
        else:
            match = re.search(section.anchor, text, re.MULTILINE)
            positions = [match.start()] if match else []
        if not positions:
            unmatched.append(section.id)
        starts += [(pos, order, index, section) for index, pos in enumerate(positions)]
    starts.sort(key=lambda s: (s[0], s[1], s[2]))

    spans: list[SectionSpan] = []
    latest: dict[str, str] = {}  # section id -> its latest key, in document order
    for i, (start, _, index, section) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(text)
        own = occurrence_key(section.key, text[start:end]) if section.key else None
        inherited = latest.get(section.key_from) if section.key_from else None
        key = own or inherited
        source: KeySource | None = "own" if own else "inherited" if inherited else None
        if key is not None:
            latest[section.id] = key
        spans.append(SectionSpan(section.id, start, end, index, key, own, source))
    return spans, unmatched


@dataclass(frozen=True)
class KeyIssue:
    section: str
    #: 1-based occurrence the issue is about (None: a source key with no occurrence).
    occurrence: int | None
    message: str


def key_issues(sections: list[Section], spans: list[SectionSpan]) -> list[KeyIssue]:
    """Check every section with `keyFrom` against its source's keys. Ordered per section (in
    declaration order): its occurrences in document order (a key that is not a source key, then
    an own key that differs from the source key above it, or no key at all), then the source
    keys it has no occurrence for, in source order. A section whose source is not in `sections`
    (the preview leaves out sections with an invalid anchor) is not checked."""
    ids = {s.id for s in sections}
    issues: list[KeyIssue] = []
    for section in sections:
        source = section.key_from
        if source is None or source not in ids:
            continue
        source_keys = [s.key for s in spans if s.id == source and s.key is not None]
        found: set[str] = set()
        above: str | None = None
        for span in spans:
            if span.id == source and span.key is not None:
                above = span.key
            if span.id != section.id:
                continue
            n = span.index + 1
            where = f"{section.id} occurrence {n}"
            if span.key is None:
                issues.append(KeyIssue(section.id, n, f"{where}: no key"))
                continue
            found.add(span.key)
            if span.key not in source_keys:
                message = f"{where}: key {span.key} is not a {source} key"
                issues.append(KeyIssue(section.id, n, message))
            if span.own_key is not None and above is not None and span.own_key != above:
                message = f"{where}: key {span.own_key} differs from {source} {above} above it"
                issues.append(KeyIssue(section.id, n, message))
        issues += [
            KeyIssue(section.id, None, f"{section.id}: no occurrence for {source} {key}")
            for key in dict.fromkeys(source_keys)
            if key not in found
        ]
    return issues


@dataclass(frozen=True)
class Occurrence:
    """One occurrence of a repeating section, 1-based."""

    index: int
    count: int
    key: str | None
    key_source: KeySource | None
    #: PDF page the occurrence starts on (from its page marker; None without page markers).
    page: int | None
    #: Stripped, prefixed with its page's marker when it starts mid-page.
    text: str


@dataclass(frozen=True)
class Segmented:
    #: Each section's text; a repeating section's occurrences joined by a blank line.
    sections: dict[str, str]
    #: Repeating sections only.
    occurrences: dict[str, list[Occurrence]]
    key_issues: list[KeyIssue]


def segment_occurrences(
    pages: list[str], sections: list[Section], page_marker: str | None = None
) -> Segmented:
    """Split document text into sections (see section_spans). Missing optional sections map to
    "". With `page_marker` (a multiline regex such as the "[page N]" lines added to each page), a
    section or occurrence starting mid-page is prefixed with that page's marker so its page stays
    known."""
    text = PAGE_BREAK.join(pages)
    spans, unmatched = section_spans(text, sections)
    required = {s.id for s in sections if s.required}
    missing = [section_id for section_id in unmatched if section_id in required]
    if missing:
        raise MissingSectionsError(missing)

    markers = (
        [(m.start(), m.group(0)) for m in re.finditer(page_marker, text, re.MULTILINE)]
        if page_marker
        else []
    )
    result = {s.id: "" for s in sections}
    repeating = {s.id for s in sections if s.repeat}
    found: dict[str, list[Occurrence]] = {section_id: [] for section_id in repeating}
    for span in spans:
        body = text[span.start : span.end].strip()
        marker = next((m for pos, m in reversed(markers) if pos <= span.start), None)
        if body and marker and not body.startswith(marker):
            body = f"{marker}\n{body}"
        if span.id not in repeating:
            result[span.id] = body
            continue
        digits = re.search(r"\d+", marker) if marker else None
        page = int(digits.group(0)) if digits else None
        occurrence = Occurrence(span.index + 1, 0, span.key, span.key_source, page, body)
        found[span.id].append(occurrence)
    occurrences = {
        section_id: [replace(o, count=len(items)) for o in items]
        for section_id, items in found.items()
    }
    for section_id, items in occurrences.items():
        result[section_id] = "\n\n".join(o.text for o in items if o.text)
    return Segmented(result, occurrences, key_issues(sections, spans))


def segment(
    pages: list[str], sections: list[Section], page_marker: str | None = None
) -> dict[str, str]:
    """Each section's text (see segment_occurrences)."""
    return segment_occurrences(pages, sections, page_marker).sections


def select_copy(pages: list[str], copies: CopySelection) -> tuple[int, list[str]]:
    """Keep one copy of a multi-copy document. Returns (index of first kept page, pages).

    Copies start on pages where `copies.anchor` matches. `last` keeps the last copy through to
    the end; `first` keeps everything before the second copy. Fewer than two matches: no-op.
    """
    pattern = re.compile(copies.anchor, re.MULTILINE)
    starts = [i for i, text in enumerate(pages) if pattern.search(text)]
    if len(starts) < 2:
        return 0, pages
    if copies.select == "last":
        return starts[-1], pages[starts[-1] :]
    return 0, pages[: starts[1]]
