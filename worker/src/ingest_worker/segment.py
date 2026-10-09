from __future__ import annotations

import re

from .specs import Section

PAGE_BREAK = "\n\f\n"


class MissingSectionsError(Exception):
    def __init__(self, missing: list[str]) -> None:
        super().__init__(f"required sections not found: {', '.join(missing)}")
        self.missing = missing


def segment(pages: list[str], sections: list[Section]) -> dict[str, str]:
    """Split document text into sections.

    Each section starts at the first match of its anchor (multiline regex) and runs until the
    next matched anchor, in document order. Missing optional sections map to "".
    """
    text = PAGE_BREAK.join(pages)
    starts: list[tuple[int, str]] = []
    missing: list[str] = []
    for section in sections:
        match = re.search(section.anchor, text, re.MULTILINE)
        if match:
            starts.append((match.start(), section.id))
        elif section.required:
            missing.append(section.id)
    if missing:
        raise MissingSectionsError(missing)

    starts.sort()
    result = {s.id: "" for s in sections}
    for i, (start, section_id) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(text)
        result[section_id] = text[start:end].strip()
    return result
