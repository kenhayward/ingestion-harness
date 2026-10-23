"""Deterministic ids for sections and the things inside them."""

from __future__ import annotations

import re
import unicodedata

_MAX_LEN = 60


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
