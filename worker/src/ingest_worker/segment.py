from __future__ import annotations

import re

from .specs import CopySelection, Section

PAGE_BREAK = "\n\f\n"


class MissingSectionsError(Exception):
    def __init__(self, missing: list[str]) -> None:
        super().__init__(f"required sections not found: {', '.join(missing)}")
        self.missing = missing


def segment(
    pages: list[str], sections: list[Section], page_marker: str | None = None
) -> dict[str, str]:
    """Split document text into sections.

    Each section starts at the first match of its anchor (multiline regex) and runs until the
    next matched anchor, in document order. Missing optional sections map to "". When anchors
    match at the same position, the section declared earlier is empty and the later one gets the
    text, so a catch-all start-of-text section yields to a more specific one.

    With `page_marker` (a multiline regex such as the "[page N]" lines added to each page), a
    section starting mid-page is prefixed with that page's marker so its page stays known.
    """
    text = PAGE_BREAK.join(pages)
    starts: list[tuple[int, int, str]] = []
    missing: list[str] = []
    for order, section in enumerate(sections):
        match = re.search(section.anchor, text, re.MULTILINE)
        if match:
            starts.append((match.start(), order, section.id))
        elif section.required:
            missing.append(section.id)
    if missing:
        raise MissingSectionsError(missing)

    markers = (
        [(m.start(), m.group(0)) for m in re.finditer(page_marker, text, re.MULTILINE)]
        if page_marker
        else []
    )
    starts.sort()
    result = {s.id: "" for s in sections}
    for i, (start, _, section_id) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(text)
        body = text[start:end].strip()
        marker = next((m for pos, m in reversed(markers) if pos <= start), None)
        if body and marker and not body.startswith(marker):
            body = f"{marker}\n{body}"
        result[section_id] = body
    return result


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
