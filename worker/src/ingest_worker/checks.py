"""Deterministic cross-extraction consistency checks (spec `checks:`).

A check compares every value found at `values` with the reference values at `reference`
(plus optional per-reference `aliases`, e.g. OCR spelling variants the LLM reported). Values are
compared case- and whitespace-insensitively and classified as:

    match      equal to a reference value
    alias      equal to an alias of a reference value
    near       within `maxDistance` edits of a reference value (typical OCR misreads)
    unmatched  none of the above
    unused     (reference rows) reference values no extracted value matched

Paths are dotted, first segment = extraction id, `[*]` iterates a list:
`test_results.results[*].batch_number`.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from .specs import Check


def _select(node: Any, path: str) -> list[Any]:
    nodes = [node]
    for segment in path.split("."):
        wildcard = segment.endswith("[*]")
        key = segment[:-3] if wildcard else segment
        found: list[Any] = []
        for n in nodes:
            value = n.get(key) if isinstance(n, dict) else None
            if value is None:
                continue
            if wildcard:
                found.extend(value if isinstance(value, list) else [])
            else:
                found.append(value)
        nodes = found
    return nodes


def select_values(results: dict[str, Any], path: str) -> list[str]:
    """Scalar values at `path` as strings; nulls and nested objects are skipped."""
    return [
        str(v) for v in _select(results, path) if v is not None and not isinstance(v, dict | list)
    ]


def container_prefix(path: str) -> str:
    """The part of a reference path that identifies one reference item: everything up to the
    last `[*]`, or just the extraction id when the reference is a single value."""
    cut = path.rfind("[*]")
    return path[: cut + 3] if cut >= 0 else path.split(".", 1)[0]


def edit_distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


_DASHES = re.compile(r"[\u2010-\u2015\u2212\ufe63\uff0d]")


def norm(value: str) -> str:
    """Comparison form: NFKC, every Unicode dash as `-`, no whitespace, upper case."""
    return "".join(_DASHES.sub("-", unicodedata.normalize("NFKC", value)).split()).upper()


def run_check(check: Check, results: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    prefix = container_prefix(check.reference)
    ref_rest = check.reference[len(prefix) + 1 :]
    alias_rest = check.aliases[len(prefix) + 1 :] if check.aliases else None

    references: list[tuple[str, set[str]]] = []  # (reference value, normalised aliases)
    for item in _select(results, prefix):
        # No path below the container: each item is itself a reference value (a list field).
        found = _select(item, ref_rest) if ref_rest else [item]
        for ref in (str(v) for v in found if v is not None and not isinstance(v, dict | list)):
            aliases = {norm(a) for a in select_values(item, alias_rest)} if alias_rest else set()
            if all(norm(ref) != norm(r) for r, _ in references):
                references.append((ref, aliases))

    counts: dict[str, tuple[str, int]] = {}
    for value in select_values(results, check.values):
        key = norm(value)
        shown, count = counts.get(key, (value.strip(), 0))
        counts[key] = (shown, count + 1)
    return {"rows": classify(counts, references, check.max_distance)}


def classify(
    values: dict[str, tuple[str, int]],
    references: list[tuple[str, set[str]]],
    max_distance: int,
) -> list[dict[str, Any]]:
    """One row per value (normalised key -> (value as shown, count)) saying whether it equals a
    reference (`match`), one of a reference's normalised aliases (`alias`), is within
    `max_distance` edits of one (`near`) or none (`unmatched`), then an `unused` row for each
    reference no value matched."""
    rows: list[dict[str, Any]] = []
    used: set[str] = set()
    for key, (shown, count) in values.items():
        row: dict[str, Any] = {
            "value": shown,
            "status": "unmatched",
            "matched": None,
            "distance": None,
            "count": count,
        }
        exact = next((r for r, _ in references if norm(r) == key), None)
        alias = next((r for r, aliases in references if key in aliases), None)
        if exact is not None:
            row.update(status="match", matched=exact, distance=0)
        elif alias is not None:
            row.update(status="alias", matched=alias, distance=0)
        elif references:
            distance, nearest = min((edit_distance(key, norm(r)), r) for r, _ in references)
            if distance <= max_distance:
                row.update(status="near", matched=nearest, distance=distance)
        if row["matched"] is not None:
            used.add(norm(row["matched"]))
        rows.append(row)

    rows += [
        {"value": r, "status": "unused", "matched": None, "distance": None, "count": 0}
        for r, _ in references
        if norm(r) not in used
    ]
    return rows
