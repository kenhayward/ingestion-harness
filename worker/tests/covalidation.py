"""The `covalidation` worked example of repeating sections (spec 2026-10-16): the recipe is the
base of the shared fixture packages/shared/test/fixtures/repeating-sections.json, and PAGES a
trimmed stability report (3 batches, each with an appearance and a microbial table)."""

from __future__ import annotations

import json
from typing import Any

from ingest_worker.config import REPO_ROOT
from ingest_worker.specs import Section

FIXTURE: dict[str, Any] = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "repeating-sections.json").read_text(
        encoding="utf-8"
    )
)
RECIPE: dict[str, Any] = FIXTURE["base"]
SECTIONS = [Section.model_validate(s) for s in RECIPE["document"]["sections"]]

BATCHES = ["4586783", "4586784", "4586785"]


def _batch(n: int, batch: str) -> str:
    return (
        f"{n}. STUDY-202432 - BATCH {batch} (LDLS000) PACKED AS HDPE BOTTLE\n"
        f"Table {2 * n - 1}: Study-202432 - Batch {batch} - Appearance and Water Content Results\n"
        "T0 Complies\n"
        f"Table {2 * n}: Study-202432 - Batch {batch} - Microbial Purity Results\n"
        "T0 Complies"
    )


PAGES = [
    "STABILITY REPORT\nStudy STUDY-202432",
    _batch(1, BATCHES[0]),
    _batch(2, BATCHES[1]),
    _batch(3, BATCHES[2]) + "\n4. CONCLUSION\nAll batches comply.",
]


def edited(old: str, new: str, page: int) -> list[str]:
    """PAGES with `old` replaced by `new` on one 0-based page (it must be there)."""
    assert old in PAGES[page], old
    return [p.replace(old, new) if i == page else p for i, p in enumerate(PAGES)]
