"""Withdraw and republish params (ADR 0011 step 7), held in step with the TS schemas."""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import ValidationError

from ingest_worker.config import REPO_ROOT
from ingest_worker.withdrawal import RepublishParams, WithdrawParams

FIXTURE: dict[str, Any] = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "withdraw-params.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("params", FIXTURE["valid"])
def test_valid(params: dict[str, Any]) -> None:
    assert WithdrawParams.model_validate(params).model_dump(by_alias=True) == params


@pytest.mark.parametrize("params", FIXTURE["invalid"])
def test_invalid(params: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        WithdrawParams.model_validate(params)


def test_republish() -> None:
    for v in FIXTURE["republish"]["valid"]:
        assert RepublishParams.model_validate(v).model_dump(by_alias=True) == v
    for v in FIXTURE["republish"]["invalid"]:
        with pytest.raises(ValidationError):
            RepublishParams.model_validate(v)
