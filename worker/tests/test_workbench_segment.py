"""Segmentation preview grid: the same spans as production segment(), per-anchor errors."""

from __future__ import annotations

import copy
import hashlib
import json
import multiprocessing
import signal
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, DocumentError, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.segment import segment
from ingest_worker.specs import Section, load_specs
from ingest_worker.storage import MemoryObjectStore, prepared_text_key, segmentation_key
from ingest_worker.workbench import SegmentDocument, segment_samples, segment_with_timeout

from .covalidation import BATCHES, RECIPE, SECTIONS, edited
from .covalidation import PAGES as COVALIDATION
from .fakes import FakeQueue

PAGES = [
    "PROTOCOL APPROVAL\nPrepared by: A\n",
    "1.0 PURPOSE\nValidate the blend\n2.0 PRODUCT DETAILS\nFolic acid 5 mg tablets\n",
]


def doc(**overrides: Any) -> SegmentDocument:
    base: dict[str, Any] = {
        "sections": [
            {"id": "approvals", "anchor": r"(?i)^PROTOCOL APPROVAL"},
            {"id": "purpose", "anchor": r"^\d+\.0 PURPOSE"},
            {"id": "product", "anchor": r"^\d+\.0 PRODUCT DETAILS"},
            {"id": "references", "anchor": r"^\d+\.0 REFERENCES", "required": False},
        ]
    }
    return SegmentDocument.model_validate({**base, **overrides})


def cells(result: dict[str, Any], sample: int = 0) -> dict[str, dict[str, Any]]:
    return {c["id"]: c for c in result["samples"][sample]["sections"]}


def test_grid_reports_page_line_and_size_per_section() -> None:
    result = segment_samples([("s1", PAGES)], doc())
    assert result["anchorErrors"] == {}
    sample = result["samples"][0]
    assert sample["sampleId"] == "s1"
    assert sample["firstPage"] == 1 and sample["pageCount"] == 2
    assert sample["error"] is None and sample["missingRequired"] == []
    c = cells(result)
    assert c["approvals"]["page"] == 1 and c["approvals"]["line"] == "PROTOCOL APPROVAL"
    assert c["purpose"]["page"] == 2 and c["purpose"]["line"] == "1.0 PURPOSE"
    assert c["product"]["found"] is True and c["product"]["chars"] > 0
    assert c["references"] == {
        "id": "references",
        "found": False,
        "page": None,
        "line": None,
        "chars": 0,
        "occurrences": [],
        "matches": 0,
    }
    assert c["approvals"]["matches"] == 1


def test_grid_counts_every_match_of_an_anchor() -> None:
    # A block repeated per batch: production uses the first match, the grid says how many.
    pages = ["BATCH 1\nAssay 1\n", "BATCH 2\nAssay 2\n", "BATCH 3\nAssay 3\n"]
    document = doc(
        sections=[
            {"id": "batch", "anchor": "^BATCH"},
            {"id": "assay", "anchor": "^Assay"},
            {"id": "none", "anchor": "^NOWHERE", "required": False},
        ]
    )
    c = cells(segment_samples([("s1", pages)], document))
    assert (c["batch"]["matches"], c["assay"]["matches"], c["none"]["matches"]) == (3, 3, 0)


def test_grid_sizes_match_production_segmentation() -> None:
    document = doc(pageMarkers=False)
    result = segment_samples([("s1", PAGES)], document)
    production = segment(PAGES, list(document.sections))
    for section_id, cell in cells(result).items():
        assert cell["chars"] == len(production[section_id])


def test_invalid_anchor_is_reported_and_skipped_not_fatal() -> None:
    broken = doc(
        sections=[
            {"id": "approvals", "anchor": r"(?i)^PROTOCOL APPROVAL"},
            {"id": "purpose", "anchor": r"^(\d+\.0 PURPOSE"},  # unclosed group
        ]
    )
    result = segment_samples([("s1", PAGES)], broken)
    assert "purpose" in result["anchorErrors"]
    assert "unterminated" in result["anchorErrors"]["purpose"]
    c = cells(result)
    assert c["approvals"]["found"] is True
    assert c["purpose"]["found"] is False


def test_missing_required_sections_are_listed() -> None:
    result = segment_samples([("s1", ["PROTOCOL APPROVAL\nonly"])], doc())
    assert result["samples"][0]["missingRequired"] == ["purpose", "product"]


def test_unprepared_samples_get_an_error_row_and_others_still_segment() -> None:
    result = segment_samples([("s0", None), ("s1", PAGES)], doc())
    assert result["samples"][0] == {
        "sampleId": "s0",
        "firstPage": 1,
        "pageCount": 0,
        "error": "not prepared",
        "missingRequired": [],
        "sections": [],
        "keyIssues": [],
    }
    assert cells(result, 1)["purpose"]["found"] is True


def test_sample_with_no_pages_gets_an_error_row() -> None:
    result = segment_samples([("s1", [])], doc())
    assert result["samples"][0] == {
        "sampleId": "s1",
        "firstPage": 1,
        "pageCount": 0,
        "error": "no pages",
        "missingRequired": [],
        "sections": [],
        "keyIssues": [],
    }


def test_duplicate_section_ids_are_rejected() -> None:
    with pytest.raises(ValueError, match="duplicate section id a"):
        doc(sections=[{"id": "a", "anchor": "x"}, {"id": "a", "anchor": "y"}])


def test_copy_selection_keeps_the_last_copy_and_numbers_original_pages() -> None:
    pages = [
        "PROTOCOL APPROVAL\nblank",
        "1.0 PURPOSE\nx",
        "PROTOCOL APPROVAL\nexecuted",
        "1.0 PURPOSE\ny",
    ]
    result = segment_samples(
        [("s1", pages)],
        doc(
            sections=[
                {"id": "approvals", "anchor": r"^PROTOCOL APPROVAL"},
                {"id": "purpose", "anchor": r"^\d+\.0 PURPOSE"},
            ],
            copies={"anchor": r"^PROTOCOL APPROVAL", "select": "last"},
        ),
    )
    sample = result["samples"][0]
    assert sample["firstPage"] == 3 and sample["pageCount"] == 2
    assert cells(result)["purpose"]["page"] == 4


def test_invalid_copies_anchor_is_an_anchor_error_and_copies_are_ignored() -> None:
    result = segment_samples([("s1", PAGES)], doc(copies={"anchor": "(", "select": "last"}))
    assert "copies" in result["anchorErrors"]
    assert result["samples"][0]["firstPage"] == 1


@pytest.mark.parametrize("long_line", ["X" * 500])
def test_matched_lines_are_trimmed(long_line: str) -> None:
    result = segment_samples(
        [("s1", [long_line])], doc(sections=[{"id": "all", "anchor": r"\A"}], pageMarkers=False)
    )
    assert len(cells(result)["all"]["line"]) == 200


def segment_job(params: dict[str, Any]) -> ClaimedJob:
    return ClaimedJob(
        id="job-seg",
        document_id="",
        spec_id="letter",
        spec_version=0,
        bucket="",
        object_key="",
        model_override=None,
        attempts=1,
        max_attempts=1,
        task="segment",
        test=True,
        project_id="letter",
        params=params,
    )


def deps_with(store: MemoryObjectStore, specs_dir: Path) -> PipelineDeps:
    return PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
    )


def put_prepared(store: MemoryObjectStore, sha: str, pages: list[str]) -> None:
    text = {
        "sha256": sha,
        "pages": [{"number": i + 1, "text": t, "ocr": False} for i, t in enumerate(pages)],
    }
    store.put("runs", prepared_text_key(sha), json.dumps(text).encode(), "application/json")


def test_segment_job_writes_the_grid_and_completes(fixture_specs_dir: Path) -> None:
    store = MemoryObjectStore()
    sha = hashlib.sha256(b"a").hexdigest()
    put_prepared(store, sha, PAGES)
    params = {
        "samples": [{"sampleId": "s1", "sha256": sha}, {"sampleId": "s2", "sha256": "missing"}],
        "document": {"sections": [{"id": "purpose", "anchor": r"^\d+\.0 PURPOSE"}]},
    }
    queue = FakeQueue(jobs=[segment_job(params)])

    assert run_once(queue, deps_with(store, fixture_specs_dir), "w1") is True

    assert queue.completed == [("job-seg", [])]
    grid = json.loads(store.get("runs", segmentation_key("letter", "job-seg")))
    assert grid["samples"][0]["sections"][0]["page"] == 2
    assert grid["samples"][1]["error"] == "not prepared"


SEGMENT_PARAMS: dict[str, Any] = {
    "samples": [{"sampleId": "s1", "sha256": "a" * 64}],
    "document": {"sections": [{"id": "purpose", "anchor": r"^\d+\.0 PURPOSE"}]},
}


def test_segment_job_cancelled_before_the_write_writes_nothing(fixture_specs_dir: Path) -> None:
    store = MemoryObjectStore()
    put_prepared(store, "a" * 64, PAGES)
    queue = FakeQueue(jobs=[segment_job(SEGMENT_PARAMS)], cancel_when=lambda: True)

    run_once(queue, deps_with(store, fixture_specs_dir), "w1")

    assert store.get_optional("runs", segmentation_key("letter", "job-seg")) is None
    assert queue.completed == []


def test_segment_job_cancelled_during_the_write_removes_its_object(
    fixture_specs_dir: Path,
) -> None:
    store = MemoryObjectStore()
    put_prepared(store, "a" * 64, PAGES)
    calls: list[int] = []

    def cancel_after_first_check() -> bool:
        calls.append(1)
        return len(calls) > 1

    queue = FakeQueue(jobs=[segment_job(SEGMENT_PARAMS)], cancel_when=cancel_after_first_check)

    run_once(queue, deps_with(store, fixture_specs_dir), "w1")

    assert len(calls) == 2
    assert store.get_optional("runs", segmentation_key("letter", "job-seg")) is None
    assert queue.completed == []


def test_segment_job_with_bad_params_needs_review(fixture_specs_dir: Path) -> None:
    queue = FakeQueue(jobs=[segment_job({"samples": [], "document": {"sections": []}})])
    run_once(queue, deps_with(MemoryObjectStore(), fixture_specs_dir), "w1")
    [(_, reason)] = queue.reviewed
    assert "segment parameters" in reason


def test_segment_with_timeout_returns_the_grid() -> None:
    document = doc()
    assert segment_with_timeout([("s1", PAGES)], document) == segment_samples(
        [("s1", PAGES)], document
    )


def test_runaway_anchor_is_killed_and_reported() -> None:
    document = SegmentDocument.model_validate({"sections": [{"id": "x", "anchor": "(a+)+$"}]})
    started = time.monotonic()
    with pytest.raises(DocumentError, match="backtrack"):
        segment_with_timeout([("s1", ["a" * 40 + "!"])], document, timeout_s=3)
    assert time.monotonic() - started < 3 + 5


@pytest.mark.skipif(sys.platform == "win32", reason="needs fork and POSIX signals")
def test_runaway_child_is_reaped_even_when_the_worker_handles_sigterm() -> None:
    previous = signal.signal(signal.SIGTERM, lambda *_: None)  # like main()'s graceful stop
    try:
        document = SegmentDocument.model_validate({"sections": [{"id": "x", "anchor": "(a+)+$"}]})
        with pytest.raises(DocumentError, match="backtrack"):
            segment_with_timeout([("s1", ["a" * 40 + "!"])], document, timeout_s=1)
        assert multiprocessing.active_children() == []
    finally:
        signal.signal(signal.SIGTERM, previous)


def test_a_required_section_that_misses_gets_a_label_variant_suggestion() -> None:
    document = SegmentDocument.model_validate(
        {
            "sections": [
                {"id": "header", "anchor": r"^TAX INVOICE"},
                {"id": "supplier", "anchor": r"^(From|Supplier)\b"},
                {"id": "notes", "anchor": r"^Notes\b", "required": False},
            ]
        }
    )
    acme = ["TAX INVOICE\nSupplier: Acme Ltd\n"]
    globex = ["TAX INVOICE\nVendor: Globex Corporation\nNOTES: none\n"]
    result = segment_samples([("acme", acme), ("globex", globex), ("blank", None)], document)
    assert result["suggestions"] == [
        {
            "section": "supplier",
            "sampleId": "globex",
            "anchor": r"^(From|Supplier|Vendor)\b",
            "reason": 'This sample labels it "Vendor:"; the anchor has no alternative for that.',
        }
    ]


def test_a_grid_without_misses_has_no_suggestions() -> None:
    assert segment_samples([("s1", PAGES)], doc())["suggestions"] == []


def test_a_suggestion_that_breaks_a_sample_where_the_section_was_found_is_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "ingest_worker.workbench.suggest_anchor", lambda anchor, text: (r"^Vendor\b", "x")
    )
    document = SegmentDocument.model_validate(
        {"sections": [{"id": "supplier", "anchor": r"^Supplier\b"}]}
    )
    both = [("acme", ["Supplier: Acme\n"]), ("globex", ["Vendor: Globex\n"])]
    assert segment_samples(both, document)["suggestions"] == []
    only_misses = [("globex", ["Vendor: Globex\n"])]
    assert len(segment_samples(only_misses, document)["suggestions"]) == 1


def test_segment_samples_reports_occurrences_matches_and_key_issues() -> None:
    sections = [*SECTIONS, Section(id="tables", anchor="^T0 Complies", required=False)]
    missed = edited("Microbial Purity", "Microbal Purity", 3)
    grid = segment_samples(
        [("s1", COVALIDATION), ("s2", missed)], SegmentDocument(sections=sections)
    )
    cells = {c["id"]: c for c in grid["samples"][0]["sections"]}
    appearance = cells["appearance"]
    assert [(o["page"], o["key"], o["keySource"]) for o in appearance["occurrences"]] == [
        (2, BATCHES[0], "own"),
        (3, BATCHES[1], "own"),
        (4, BATCHES[2], "own"),
    ]
    assert appearance["page"] == 2
    assert appearance["chars"] == sum(o["chars"] for o in appearance["occurrences"])
    assert appearance["line"].startswith("Table 1:")
    assert cells["tables"]["matches"] == 6
    assert cells["front"]["matches"] == 1 and cells["front"]["occurrences"] == []
    assert appearance["matches"] == 0
    assert grid["samples"][0]["keyIssues"] == []
    assert grid["samples"][1]["keyIssues"] == [f"microbial: no occurrence for batch {BATCHES[2]}"]


def test_an_inherited_key_is_marked() -> None:
    sections = [s.model_copy(update={"key": None}) if s.id == "appearance" else s for s in SECTIONS]
    grid = segment_samples([("s1", COVALIDATION)], SegmentDocument(sections=sections))
    cell = next(c for c in grid["samples"][0]["sections"] if c["id"] == "appearance")
    assert {o["keySource"] for o in cell["occurrences"]} == {"inherited"}


def test_an_invalid_key_is_an_anchor_error() -> None:
    sections = copy.deepcopy(RECIPE["document"]["sections"])
    sections[1]["key"] = r"BATCH (\w+"
    grid = segment_samples(
        [("s1", COVALIDATION)], SegmentDocument.model_validate({"sections": sections})
    )
    assert "batch.key" in grid["anchorErrors"]
    cell = next(c for c in grid["samples"][0]["sections"] if c["id"] == "batch")
    assert [o["key"] for o in cell["occurrences"]] == [None, None, None]


MISS_ANCHOR = r"^\s*Table\s+\d+:\s.*Results\s*$"
MISS_KEY = r"^\s*Table\s+(\d+):"


def tables_doc() -> SegmentDocument:
    return SegmentDocument.model_validate(
        {
            "sections": [
                {"id": "result_tables", "anchor": MISS_ANCHOR, "repeat": True, "key": MISS_KEY}
            ]
        }
    )


def test_grid_reports_missed_keys() -> None:
    page = (
        "Table\xa01: Study A - Assay and Chromatographic Purity (HDPE\n   bottle - X) Results\n"
        "row data\n"
        "Table\xa02: Study A - Assay Results\nrow data\n"
        "Table\xa03: Study B - Assay and Chromatographic Purity (HDPE\n   bottle - Y) Results\n"
    )
    row = segment_samples([("s1", [page])], tables_doc())["samples"][0]
    assert row["missedKeys"] == [
        {
            "sections": ["result_tables"],
            "key": "1",
            "line": "Table\xa01: Study A - Assay and Chromatographic Purity (HDPE",
        },
        {
            "sections": ["result_tables"],
            "key": "3",
            "line": "Table\xa03: Study B - Assay and Chromatographic Purity (HDPE",
        },
    ]
    assert "missedKeysTotal" not in row


def test_grid_omits_missed_keys_when_covered() -> None:
    page = "Table 1: A Results\nrow\nTable 2: B Results\nrow\n"
    row = segment_samples([("s1", [page])], tables_doc())["samples"][0]
    assert "missedKeys" not in row
    assert "missedKeysTotal" not in row


def test_grid_caps_missed_keys() -> None:
    page = "Table 0: ok Results\n" + "".join(f"Table {n}: wrapped (\n" for n in range(1, 26))
    row = segment_samples([("s1", [page])], tables_doc())["samples"][0]
    assert len(row["missedKeys"]) == 20
    assert row["missedKeysTotal"] == 25
