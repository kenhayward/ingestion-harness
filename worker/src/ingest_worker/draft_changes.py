"""Apply drafting changes to a template definition (ADR 0007, phase 3b).

Mirrors packages/shared/src/drafting.ts applyChanges; both suites run
packages/shared/test/fixtures/draft-changes.json. Pure: the input is never mutated."""

from __future__ import annotations

import copy
from typing import Any

Definition = dict[str, Any]


def _list(value: Any) -> list[dict[str, Any]]:
    return list(value) if isinstance(value, list) else []


def _obj(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _put(items: list[dict[str, Any]], item: dict[str, Any]) -> list[dict[str, Any]]:
    for i, existing in enumerate(items):
        if existing.get("id") == item["id"]:
            return [*items[:i], item, *items[i + 1 :]]
    return [*items, item]


def _drop(items: list[dict[str, Any]], item_id: Any) -> list[dict[str, Any]]:
    return [x for x in items if x.get("id") != item_id]


def apply_changes(definition: Definition, changes: list[dict[str, Any]]) -> Definition:
    out = copy.deepcopy(definition)
    outputs = _obj(out.get("outputs"))
    fields, tables = _list(outputs.get("fields")), _list(outputs.get("tables"))
    document = _obj(out.get("document"))
    sections = _list(document.get("sections"))
    pipeline = _list(out.get("pipeline"))
    preamble = out.get("preamble")
    for change in copy.deepcopy(changes):
        op = change.get("op")
        if op == "putField":
            fields = _put(fields, change["field"])
            tables = _drop(tables, change["field"]["id"])
        elif op == "putTable":
            tables = _put(tables, change["table"])
            fields = _drop(fields, change["table"]["id"])
        elif op == "removeOutput":
            fields, tables = _drop(fields, change["id"]), _drop(tables, change["id"])
        elif op == "putSection":
            sections = _put(sections, change["section"])
        elif op == "removeSection":
            sections = _drop(sections, change["id"])
        elif op == "setCopies":
            if change["copies"] is None:
                document.pop("copies", None)
            else:
                document["copies"] = change["copies"]
        elif op == "putStep":
            pipeline = _put(pipeline, change["step"])
        elif op == "removeStep":
            pipeline = _drop(pipeline, change["id"])
        elif op == "setPreamble":
            preamble = change["preamble"]
        else:
            raise ValueError(f"unknown change op {op!r}")
    out["outputs"] = {**outputs, "fields": fields, "tables": tables}
    out["document"] = {**document, "sections": sections}
    out["pipeline"] = pipeline
    if preamble:
        out["preamble"] = preamble
    else:
        out.pop("preamble", None)
    return out
