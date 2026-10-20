"""Typed normalisation of extracted values (template field/column types).

normalize_value returns (value, issue). On success issue is None. When a value cannot be
converted, the raw value is kept (nothing is silently dropped) and issue explains why; issues
are written to issues.csv and make a document require review. check_value adds a field's or
column's constraints (range, pattern, length; docs/design/output-roles.md §1).
"""

from __future__ import annotations

import re
from datetime import date
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from .template import ValueDef

ValueType = Literal["text", "integer", "decimal", "date", "boolean", "enum", "list"]
DateOrder = Literal["DMY", "MDY"]

_MONTHS = {
    m: i
    for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
        start=1,
    )
}
_TRUE = {"true", "yes", "y", "1", "ticked", "✓"}
_FALSE = {"false", "no", "n", "0", "na", "n/a"}


def _empty(raw: Any) -> bool:
    return raw is None or (isinstance(raw, str) and not raw.strip())


def _decimal(raw: Any) -> float:
    if isinstance(raw, bool):
        raise ValueError
    if isinstance(raw, int | float):
        return float(raw)
    text = "".join(str(raw).replace("·", ".").split())  # also drops thin spaces
    text = text.rstrip("%")
    if "," in text and "." in text:
        text = text.replace(",", "")
    elif re.fullmatch(r"\d{1,3}(,\d{2,3})+", text):
        text = text.replace(",", "")  # digit grouping, incl. Indian 13,50,000
    elif re.fullmatch(r"-?\d+,\d{1,2}", text):
        text = text.replace(",", ".")  # decimal comma
    return float(text)


def _year(text: str) -> int:
    year = int(text)
    return year + 2000 if year < 100 else year


def _date(raw: Any, order: DateOrder) -> str:
    text = str(raw).strip()
    if m := re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", text):
        return date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    if m := re.fullmatch(r"(\d{1,2})[/.\-\s]([A-Za-z]{3})[A-Za-z]*[/.\-\s](\d{2,4})", text):
        month = _MONTHS[m[2].lower()]
        return date(_year(m[3]), month, int(m[1])).isoformat()
    if m := re.fullmatch(r"(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})", text):
        first, second = int(m[1]), int(m[2])
        day, month = (first, second) if order == "DMY" else (second, first)
        return date(_year(m[3]), month, day).isoformat()
    if m := re.fullmatch(r"(\d{1,2})[/.\-](\d{4})", text):
        month = int(m[1])
        if not 1 <= month <= 12:
            raise ValueError
        return f"{int(m[2]):04d}-{month:02d}"
    raise ValueError


def normalize_value(
    raw: Any,
    kind: ValueType,
    *,
    options: list[str] | None = None,
    date_order: DateOrder = "DMY",
) -> tuple[Any, str | None]:
    if kind == "list":
        items = raw if isinstance(raw, list) else ([] if _empty(raw) else [raw])
        return [str(i).strip() for i in items if not _empty(i)], None
    if _empty(raw):
        return None, None
    try:
        if kind == "text":
            return str(raw).strip(), None
        if kind == "decimal":
            return _decimal(raw), None
        if kind == "integer":
            number = _decimal(raw)
            if not number.is_integer():
                raise ValueError
            return int(number), None
        if kind == "date":
            return _date(raw, date_order), None
        if kind == "boolean":
            if isinstance(raw, bool):
                return raw, None
            word = str(raw).strip().lower()
            if word in _TRUE or word in _FALSE:
                return word in _TRUE, None
            raise ValueError
        if kind == "enum":
            key = " ".join(str(raw).split()).casefold()
            for option in options or []:
                if " ".join(option.split()).casefold() == key:
                    return option, None
            return raw, f"{raw!r} is not one of {options}"
    except (ValueError, KeyError):
        pass
    return raw, f"{raw!r} is not a valid {kind}"


def check_value(raw: Any, definition: ValueDef, date_order: DateOrder) -> tuple[Any, str | None]:
    """`normalize_value` for a field or column, then its constraints: the value is kept as
    captured and the first constraint it breaks is the issue (none when the type already failed
    or the value is empty)."""
    value, issue = normalize_value(
        raw, definition.type, options=definition.enum, date_order=date_order
    )
    if issue is not None or value is None:
        return value, issue
    return value, _constraint_issue(value, definition)


def _constraint_issue(value: Any, definition: ValueDef) -> str | None:
    if definition.range is not None and isinstance(value, int | float):
        low, high = definition.range.min, definition.range.max
        if low is not None and value < low:
            return f"{value:g} is below {low:g}"
        if high is not None and value > high:
            return f"{value:g} is above {high:g}"
    if isinstance(value, str):
        if definition.pattern is not None and re.fullmatch(definition.pattern, value) is None:
            return f"{value!r} does not match {definition.pattern}"
        if definition.length is not None:
            low, high = definition.length.min, definition.length.max
            if low is not None and len(value) < low:
                return f"{value!r} is shorter than {low:g} characters"
            if high is not None and len(value) > high:
                return f"{value!r} is longer than {high:g} characters"
    return None
