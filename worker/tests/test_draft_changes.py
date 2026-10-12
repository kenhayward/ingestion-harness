"""apply_changes mirrors packages/shared/src/drafting.ts applyChanges (shared fixture)."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from ingest_worker.config import REPO_ROOT
from ingest_worker.draft_changes import apply_changes

FIXTURE = REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "draft-changes.json"
CASES: list[dict[str, Any]] = json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_apply_changes_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    assert apply_changes(case["definition"], case["changes"]) == case["expected"]


def test_apply_changes_never_mutates_its_input() -> None:
    case = CASES[0]
    before = copy.deepcopy(case["definition"])
    apply_changes(case["definition"], case["changes"])
    assert case["definition"] == before


def test_unknown_op_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown change op"):
        apply_changes({}, [{"op": "rename"}])
