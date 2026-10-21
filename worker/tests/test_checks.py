from __future__ import annotations

import json
from pathlib import Path

import pytest

from ingest_worker.checks import edit_distance, norm, run_check, select_values
from ingest_worker.specs import Check

RESULTS = {
    "batches": {
        "batches": [
            {"batch_number": "G17230211", "variants": ["GTT230211"]},
            {"batch_number": "G17230212", "variants": []},
            {"batch_number": "G17230224", "variants": []},
        ]
    },
    "test_results": {
        "results": [
            {"batch_number": "G17230211"},
            {"batch_number": "g17230211 "},
            {"batch_number": "GTT230211"},
            {"batch_number": "G1T230212"},
            {"batch_number": "ZZ999"},
            {"batch_number": None},
        ]
    },
}

CHECK = Check.model_validate(
    {
        "id": "batch_numbers",
        "values": "test_results.results[*].batch_number",
        "reference": "batches.batches[*].batch_number",
        "aliases": "batches.batches[*].variants[*]",
    }
)


def test_select_values_flattens_wildcards_and_skips_nulls() -> None:
    assert select_values(RESULTS, "batches.batches[*].variants[*]") == ["GTT230211"]
    assert len(select_values(RESULTS, "test_results.results[*].batch_number")) == 5
    assert select_values(RESULTS, "batches.missing[*].x") == []


@pytest.mark.parametrize(("a", "b", "d"), [("abc", "abc", 0), ("G17", "G1T", 1), ("", "ab", 2)])
def test_edit_distance(a: str, b: str, d: int) -> None:
    assert edit_distance(a, b) == d


def test_run_check_classifies_values_and_reports_unused_references() -> None:
    rows = run_check(CHECK, RESULTS)["rows"]
    by_value = {r["value"]: r for r in rows}

    assert by_value["G17230211"] == {
        "value": "G17230211",
        "status": "match",
        "matched": "G17230211",
        "distance": 0,
        "count": 2,
    }
    assert by_value["GTT230211"]["status"] == "alias"
    assert by_value["GTT230211"]["matched"] == "G17230211"
    assert by_value["G1T230212"]["status"] == "near"
    assert (by_value["G1T230212"]["matched"], by_value["G1T230212"]["distance"]) == ("G17230212", 1)
    assert by_value["ZZ999"]["status"] == "unmatched" and by_value["ZZ999"]["matched"] is None
    assert by_value["G17230224"]["status"] == "unused"  # listed batch with no results


def test_near_matching_respects_max_distance() -> None:
    strict = CHECK.model_copy(update={"max_distance": 0})
    rows = {r["value"]: r for r in run_check(strict, RESULTS)["rows"]}
    assert rows["G1T230212"]["status"] == "unmatched"


def test_list_field_reference() -> None:
    results = {
        "summary": {"studies": {"value": ["Study-1", "Study-2"]}},
        "t": {"rows": [{"s": "Study-1"}, {"s": "Study-9"}]},
    }
    check = Check.model_validate(
        {
            "id": "studies",
            "values": "t.rows[*].s",
            "reference": "summary.studies.value[*]",
            "maxDistance": 0,
        }
    )
    rows = {r["value"]: r["status"] for r in run_check(check, results)["rows"]}
    assert rows == {"Study-1": "match", "Study-9": "unmatched", "Study-2": "unused"}


@pytest.mark.parametrize("variant", ["Study\u2011201580", "study-201580", "Study - 201580"])
def test_norm_folds_dashes_and_spaces(variant: str) -> None:
    assert norm(variant) == norm("STUDY-201580")


def test_norm_keeps_underscores_distinct() -> None:
    assert norm("Study_201580") != norm("STUDY-201580")


NORM_CASES = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "shared"
        / "test"
        / "fixtures"
        / "check-norm.json"
    ).read_text(encoding="utf-8")
)["cases"]


@pytest.mark.parametrize("case", NORM_CASES, ids=lambda c: ascii(c["input"]))
def test_norm_matches_shared_fixture(case: dict[str, str]) -> None:
    assert norm(case["input"]) == case["norm"]


def test_reference_path_ending_at_the_rows_gives_no_reference_values() -> None:
    results = {"t": {"rows": [{"s": "Study-1"}]}}
    check = Check.model_validate(
        {"id": "c", "values": "t.rows[*].s", "reference": "t.rows[*]", "maxDistance": 0}
    )
    rows = run_check(check, results)["rows"]
    assert [r["status"] for r in rows] == ["unmatched"]
