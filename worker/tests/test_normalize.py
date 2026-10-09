from __future__ import annotations

from typing import Any

import pytest

from ingest_worker.normalize import normalize_value


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (137.8, 137.8),
        ("137·8", 137.8),
        (" 120.1 ", 120.1),
        ("1,234.5", 1234.5),
        ("13,50,000", 1350000.0),  # Indian digit grouping
        ("12,5", 12.5),  # decimal comma
        ("2.4 %", 2.4),
        (None, None),
        ("", None),
    ],
)
def test_decimals(raw: Any, expected: float | None) -> None:
    assert normalize_value(raw, "decimal") == (expected, None)


def test_unparseable_decimal_keeps_raw_and_reports() -> None:
    value, issue = normalize_value("Complies", "decimal")
    assert value == "Complies" and issue is not None and "decimal" in issue


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("16/02/2023", "2023-02-16"),
        ("15/02/23", "2023-02-15"),
        ("2023-04-27", "2023-04-27"),
        ("25/Jan/2023", "2023-01-25"),
        ("06.10.23", "2023-10-06"),
        ("02/2023", "2023-02"),  # month precision kept, not invented
    ],
)
def test_dates_are_day_first_iso(raw: str, expected: str) -> None:
    assert normalize_value(raw, "date") == (expected, None)


def test_month_first_dates_when_configured() -> None:
    assert normalize_value("02/16/2023", "date", date_order="MDY") == ("2023-02-16", None)


def test_bad_date_reports() -> None:
    value, issue = normalize_value("sometime in spring", "date")
    assert value == "sometime in spring" and issue


@pytest.mark.parametrize(
    ("raw", "kind", "expected"),
    [
        ("42", "integer", 42),
        ("3.0", "integer", 3),
        ("yes", "boolean", True),
        ("No", "boolean", False),
        (True, "boolean", True),
        ("  Batch A ", "text", "Batch A"),
        ("  ", "text", None),
        (["a ", " ", "b"], "list", ["a", "b"]),
    ],
)
def test_other_types(raw: Any, kind: str, expected: Any) -> None:
    assert normalize_value(raw, kind) == (expected, None)  # type: ignore[arg-type]


def test_enum_values_snap_to_canonical_spelling() -> None:
    options = ["Blending", "Capsule filling"]
    assert normalize_value("capsule  Filling", "enum", options=options) == ("Capsule filling", None)
    value, issue = normalize_value("Granulation", "enum", options=options)
    assert value == "Granulation" and issue and "not one of" in issue
