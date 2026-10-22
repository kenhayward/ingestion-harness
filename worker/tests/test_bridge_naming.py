from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.bridge.naming import naming_inputs

FIXTURE = Path(__file__).resolve().parents[2] / "packages/bridge-contract/test/fixtures/naming.json"
CASES: list[dict[str, Any]] = json.loads(FIXTURE.read_text(encoding="utf-8"))["inputs"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_naming_inputs_match_the_shared_fixture(case: dict[str, Any]) -> None:
    assert (
        naming_inputs(
            fields=case["document"]["fields"],
            job_id=case["jobId"],
            recipe_id=case["recipe"]["id"],
            recipe_version=case["recipe"]["version"],
            source_filename=case["source"]["filename"],
            source_sha256=case["source"]["sha256"],
            published_at=datetime.fromisoformat(case["publishedAt"].replace("Z", "+00:00")),
        )
        == case["naming"]
    )
