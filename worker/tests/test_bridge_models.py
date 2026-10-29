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
    DocumentReceipt,
    ProducerSourceList,
    ProducerSourceMove,
    ProducerSourcePut,
    ProducerSourceRead,
    Receipt,
    SourceListAnswer,
    SourceListRequest,
    SourceMoveRequest,
    SourcePutRequest,
    TargetTestResult,
    decomposition_idempotency_key,
    graph_idempotency_key,
    idempotency_key,
    package_archive_keys,
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
        ("package-document-rdf.json", BridgePackage),
        ("package-decomposed.json", BridgePackage),
        ("delivery-request.json", CreateDeliveriesRequest),
        ("delivery-view.json", DeliveryView),
        ("event.json", BridgeEvent),
        ("error.json", BridgeError),
        ("target-test-result.json", TargetTestResult),
        ("source-list.json", SourceListRequest),
        ("source-move.json", SourceMoveRequest),
        ("source-put.json", SourcePutRequest),
        ("producer-source-list.json", ProducerSourceList),
        ("producer-source-read.json", ProducerSourceRead),
        ("producer-source-move.json", ProducerSourceMove),
        ("producer-source-put.json", ProducerSourcePut),
        ("source-list-answer.json", SourceListAnswer),
    ],
)
def test_fixture_validates_and_reserialises_unchanged(name: str, model: type[BaseModel]) -> None:
    data = fixture(name)
    assert model.model_validate(data).model_dump(by_alias=True, mode="json") == data


def test_a_list_answer_takes_any_non_empty_name() -> None:
    # One odd file never invalidates the answer; requests keep the strict name rule.
    file = {"size": 1, "modifiedAt": "2026-10-29T09:15:00Z", "etag": None}
    odd = [r"a\b.pdf", "n" * 300]
    SourceListAnswer.model_validate({"files": [{**file, "name": n} for n in odd]})
    with pytest.raises(ValidationError):
        SourceListAnswer.model_validate({"files": [{**file, "name": ""}]})
    with pytest.raises(ValidationError):
        ProducerSourceRead.model_validate(
            {**fixture("producer-source-read.json"), "name": "n" * 300}
        )


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


def test_graph_idempotency_key_matches_the_fixture() -> None:
    g = fixture("idempotency.json")["graph"]
    assert graph_idempotency_key(g["graphName"], g["version"]) == g["key"]


def test_package_archive_keys_match_the_fixture() -> None:
    fx = fixture("archive-keys.json")
    package = BridgePackage.model_validate(fixture(fx["package"]))
    assert package_archive_keys(fx["prefix"], package) == [
        (k["outputId"], k["key"]) for k in fx["keys"]
    ]


def test_decomposed_fixture_round_trips() -> None:
    data = fixture("package-decomposed.json")
    package = BridgePackage.model_validate(data)
    assert package.contract_version == 2
    assert package.document is not None
    assert package.model_dump(by_alias=True, mode="json") == data


def test_v1_fixtures_unchanged() -> None:
    for name in ("package-document.json", "package-graph.json", "package-document-rdf.json"):
        data = fixture(name)
        package = BridgePackage.model_validate(data)
        assert package.document is None
        dumped = package.model_dump(by_alias=True, mode="json")
        assert "document" not in dumped
        assert dumped == data


def test_decomposition_key_matches_typescript() -> None:
    assert (
        decomposition_idempotency_key("a" * 64, None, 1, None)
        == "94272c6b2a68fe7f0bb80994ceac3e804b264d676e266b6f7d2d0ff20bb7e730"
    )
    assert (
        decomposition_idempotency_key("a" * 64, "doc-1", 2, "batch-1")
        == "1096d758e38351123f98cefa632e569a8d122b940258f51851f2f0ddb59534fd"
    )


def test_document_refinements() -> None:
    data = fixture("package-decomposed.json")
    pkg = BridgePackage.model_validate

    with pytest.raises(ValidationError, match="needs contractVersion 2"):
        pkg({**data, "contractVersion": 1})

    file = fixture("package-document.json")["files"][0]
    with pytest.raises(ValidationError, match="no files"):
        pkg({**data, "files": [file]})
    with pytest.raises(ValidationError, match="no data"):
        pkg({**data, "data": {"fields": [], "tables": []}})
    with pytest.raises(ValidationError, match="no rdf"):
        pkg({**data, "rdf": {"graphName": "https://x.test/g", "version": 1, "turtle": ""}})
    with pytest.raises(ValidationError, match="no narrative"):
        pkg({**data, "narrative": []})

    extraction = fixture("package-document.json")["provenance"]
    with pytest.raises(ValidationError, match="decomposition provenance"):
        pkg({**data, "provenance": extraction})

    without_document = {k: v for k, v in data.items() if k != "document"}
    with pytest.raises(ValidationError, match="needs a document"):
        pkg({**without_document, "files": [], "images": None})


def test_images_match_the_documents_images_both_ways() -> None:
    data = fixture("package-decomposed.json")
    assert data["images"], "the fixture carries an image"
    with pytest.raises(ValidationError, match="not in images"):
        BridgePackage.model_validate({**data, "images": []})
    extra = {"id": "stray", "contentType": "image/png", "content": "AAAA"}
    with pytest.raises(ValidationError, match="not in the document"):
        BridgePackage.model_validate({**data, "images": [*data["images"], extra]})


def test_update_needs_exactly_one_target() -> None:
    request = fixture("delivery-request.json")
    update = {
        "persistentId": "doc-1",
        "expected": [{"kind": "section", "id": "c1", "version": "3", "element": None}],
    }
    one = CreateDeliveriesRequest.model_validate({**request, "targets": ["t1"], "update": update})
    assert one.update is not None
    assert one.model_dump(by_alias=True, mode="json")["update"] == update
    with pytest.raises(ValidationError, match="exactly one target"):
        CreateDeliveriesRequest.model_validate(
            {**request, "targets": ["t1", "t2"], "update": update}
        )
    with pytest.raises(ValidationError):
        CreateDeliveriesRequest.model_validate(
            {**request, "targets": ["t1"], "update": {**update, "expected": []}}
        )


def test_receipt_document_is_optional_and_round_trips() -> None:
    assert "document" not in Receipt(written=[]).model_dump(by_alias=True, mode="json")
    data = {
        "written": [],
        "document": {
            "persistentId": "doc-1",
            "components": [{"kind": "section", "id": "c1", "version": "1", "element": None}],
            "readBack": {"ok": True, "at": None, "detail": None},
        },
    }
    receipt = Receipt.model_validate(data)
    assert isinstance(receipt.document, DocumentReceipt)
    assert receipt.model_dump(by_alias=True, mode="json") == data


def test_archive_keys_include_the_document() -> None:
    package = BridgePackage.model_validate(fixture("package-decomposed.json"))
    keys = package_archive_keys("p/", package)
    outputs = [k[0] for k in keys]
    assert outputs[-1] == "package:manifest"
    assert "package:document" in outputs
    assert outputs.index("package:document") < outputs.index(
        f"package:image:{package.images[0].id}"  # type: ignore[index]
    )
