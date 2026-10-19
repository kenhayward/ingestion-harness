"""The worker's bridge contract models, held equal to the TypeScript schemas by the shared fixtures
in packages/bridge-contract/test/fixtures (the TS side parses the same files)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from ingest_worker.bridge.models import (
    BridgeError,
    BridgeEvent,
    BridgePackage,
    CreateDeliveriesRequest,
    DeliveryView,
    TargetTestResult,
    idempotency_key,
)

FIXTURES = (
    Path(__file__).resolve().parents[2] / "packages" / "bridge-contract" / "test" / "fixtures"
)


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    ("name", "model"),
    [
        ("package-document.json", BridgePackage),
        ("package-graph.json", BridgePackage),
        ("delivery-request.json", CreateDeliveriesRequest),
        ("delivery-view.json", DeliveryView),
        ("event.json", BridgeEvent),
        ("error.json", BridgeError),
        ("target-test-result.json", TargetTestResult),
    ],
)
def test_fixture_validates_and_reserialises_unchanged(name: str, model: type[BaseModel]) -> None:
    data = fixture(name)
    assert model.model_validate(data).model_dump(by_alias=True, mode="json") == data


def test_unknown_fields_are_refused() -> None:
    data = fixture("error.json")
    with pytest.raises(ValidationError):
        BridgeError.model_validate({**data, "extra": 1})


def test_a_document_package_needs_provenance() -> None:
    data = fixture("package-document.json")
    with pytest.raises(ValidationError, match="provenance"):
        BridgePackage.model_validate({**data, "provenance": None})


def test_file_names_are_unique_in_a_package() -> None:
    data = fixture("package-document.json")
    with pytest.raises(ValidationError, match="duplicate file name"):
        BridgePackage.model_validate({**data, "files": [data["files"][0], data["files"][0]]})


def test_an_error_without_details_dumps_without_them() -> None:
    error = BridgeError(class_="needs_user", code="target_missing", message="no target x")
    assert error.model_dump(by_alias=True, mode="json") == {
        "class": "needs_user",
        "code": "target_missing",
        "message": "no target x",
    }


def test_idempotency_key_matches_the_typescript_one() -> None:
    f = fixture("idempotency.json")
    assert idempotency_key(f["sourceSha256"], f["recipeId"], f["recipeVersion"]) == f["key"]
