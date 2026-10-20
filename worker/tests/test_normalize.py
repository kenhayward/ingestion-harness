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


def _def(**kw: Any) -> Any:
    from ingest_worker.template import ValueDef

    return ValueDef.model_validate({"id": "v", **kw})


PATTERN = r"^[A-Z]{2}\d{4}$"


@pytest.mark.parametrize(
    ("raw", "definition", "expected"),
    [
        ("87.5", {"type": "decimal", "range": {"min": 90}}, (87.5, "87.5 is below 90")),
        ("111", {"type": "integer", "range": {"max": 110}}, (111, "111 is above 110")),
        ("100", {"type": "integer", "range": {"min": 90, "max": 110}}, (100, None)),
        (
            "ab1234",
            {"type": "text", "pattern": PATTERN},
            ("ab1234", f"'ab1234' does not match {PATTERN}"),
        ),
        ("AB1234", {"type": "text", "pattern": PATTERN}, ("AB1234", None)),
        (
            "AB1234x",
            {"type": "text", "pattern": PATTERN.rstrip("$")},
            ("AB1234x", f"'AB1234x' does not match {PATTERN.rstrip('$')}"),
        ),
        (
            "abcd",
            {"type": "text", "length": {"max": 3}},
            ("abcd", "'abcd' is longer than 3 characters"),
        ),
        ("ab", {"type": "text", "length": {"min": 3}}, ("ab", "'ab' is shorter than 3 characters")),
        (
            "lots",
            {"type": "integer", "range": {"min": 0}},
            ("lots", "'lots' is not a valid integer"),
        ),
        (None, {"type": "decimal", "range": {"min": 1}}, (None, None)),
    ],
    ids=[
        "below",
        "above",
        "inside",
        "no match",
        "match",
        "the whole value",
        "too long",
        "too short",
        "only the type issue",
        "empty",
    ],
)
def test_check_value_applies_constraints(
    raw: Any, definition: dict[str, Any], expected: Any
) -> None:
    from ingest_worker.normalize import check_value

    assert check_value(raw, _def(**definition), "DMY") == expected
