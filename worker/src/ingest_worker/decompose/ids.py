"""Deterministic ids for sections and the things inside them."""

from __future__ import annotations

import re
import unicodedata

_MAX_LEN = 60

#: A heading number typed at the start of a heading: parts of one to three digits joined by
#: dots, an optional trailing dot, then whitespace before the title itself.
_TYPED_NUMBER = re.compile(r"\s*(\d{1,3}(?:\.\d{1,3})*)\.?\s+(?=\S)")


def typed_number_length(text: str, level: int) -> int:
    """How many leading characters of a heading's text are a typed heading number, or 0.

    The target numbers headings itself, so a typed number would show twice. Only a number with
    as many parts as the heading's 0-based `level` has, plus one, counts: `2.1 Scope` at level 1,
    never `2023 Results` or `1.5mg Dose`.
    """
    match = _TYPED_NUMBER.match(text)
    if match is None or match.group(1).count(".") != level:
        return 0
    return match.end()


def normalise_title(text: str) -> str:
    """NFKC, casefolded, whitespace collapsed, non-alphanumerics to `-`; `untitled` if empty."""
    folded = " ".join(unicodedata.normalize("NFKC", text).casefold().split())
    slug = re.sub(r"[\W_]+", "-", folded).strip("-")[:_MAX_LEN].strip("-")
    return slug or "untitled"


def section_id(parent_id: str | None, title: str, occurrence: int) -> str:
    """`s-<slug>` under its parent's path; `~N` suffix for the Nth (N > 1) repeat of a title."""
    own = f"s-{normalise_title(title)}"
    if occurrence > 1:
        own = f"{own}~{occurrence}"
    return f"{parent_id}/{own}" if parent_id else own


def child_id(section_id: str, kind: str, ordinal: int) -> str:
    """Id of the `ordinal`-th `kind` inside a section, e.g. `s-results#table-3`."""
    return f"{section_id}#{kind}-{ordinal}"
