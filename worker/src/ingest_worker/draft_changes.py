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


def _empty_semantics() -> dict[str, Any]:
    """A new mapping with no document class yet (validation then asks for one)."""
    return {
        "ontologies": [],
        "shapes": [],
        "prefixes": {},
        "document": {"class": "", "iri": "doc/{source}"},
        "fields": {},
        "tables": {},
        "local": [],
    }


def _apply_mapping(semantics: dict[str, Any], change: dict[str, Any]) -> None:
    """The mapping stage's ops (ADR 0011), on the recipe's `semantics` in place."""
    op = change["op"]
    if op == "setDocumentMapping":
        semantics["document"] = change["document"]
        semantics["ontologies"] = change["ontologies"]
        semantics["prefixes"] = {**_obj(semantics.get("prefixes")), **change["prefixes"]}
        if change.get("valueNodes"):  # absent: the draft's defaults are kept
            semantics["valueNodes"] = change["valueNodes"]
    elif op == "putFieldMapping":
        semantics["fields"] = {**_obj(semantics.get("fields")), change["field"]: change["mapping"]}
    elif op == "putTableMapping":
        semantics["tables"] = {**_obj(semantics.get("tables")), change["table"]: change["mapping"]}
    elif op == "removeMapping":
        table, _, column = change["id"].partition(".")
        tables = _obj(semantics.get("tables"))
        if column:
            if table in tables:
                columns = _obj(_obj(tables[table]).get("columns"))
                columns.pop(column, None)
                semantics["tables"] = {**tables, table: {**_obj(tables[table]), "columns": columns}}
        else:
            fields = _obj(semantics.get("fields"))
            fields.pop(change["id"], None)
            tables.pop(change["id"], None)
            semantics["fields"], semantics["tables"] = fields, tables
    elif op == "putLocalTerm":
        local = _list(semantics.get("local"))
        term = change["term"]
        for i, existing in enumerate(local):
            if existing.get("iri") == term["iri"]:
                local[i] = term
                break
        else:
            local.append(term)
        semantics["local"] = local


MAPPING_OPS = frozenset(
    {"setDocumentMapping", "putFieldMapping", "putTableMapping", "removeMapping", "putLocalTerm"}
)


def apply_changes(definition: Definition, changes: list[dict[str, Any]]) -> Definition:
    out = copy.deepcopy(definition)
    outputs = _obj(out.get("outputs"))
    fields, tables = _list(outputs.get("fields")), _list(outputs.get("tables"))
    document = _obj(out.get("document"))
    sections = _list(document.get("sections"))
    pipeline = _list(out.get("pipeline"))
    preamble = out.get("preamble")
    semantics: dict[str, Any] | None = _obj(out["semantics"]) if out.get("semantics") else None
    for change in copy.deepcopy(changes):
        op = change.get("op")
        if op in MAPPING_OPS:
            if semantics is None:
                semantics = _empty_semantics()
            _apply_mapping(semantics, change)
        elif op == "putField":
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
    if semantics is not None:
        out["semantics"] = semantics
    return out
