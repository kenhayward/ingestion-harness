"""Drafting stages that propose changes to the draft template (ADR 0007, phase 3b).

Models answer in a flat JSON shape (every key present, null when not applicable), which every
provider's structured output accepts. `convert` turns that into the typed changes of
packages/shared/src/drafting.ts (DraftChange), validating each item with the template's own
Pydantic models; `check` validates the changes against the current draft. Both feed their
errors back to the model through run_extraction(check=...)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, get_args

from pydantic import BaseModel, ValidationError

from .draft_changes import apply_changes
from .normalize import ValueType
from .template import RESERVED_OUTPUT_IDS, CheckStep, ExtractStep, TableDef, Template, ValueDef

Converter = Callable[[dict[str, Any]], tuple[dict[str, Any], list[str]]]
Checker = Callable[[dict[str, Any], dict[str, Any]], list[str]]


@dataclass(frozen=True)
class Stage:
    id: str
    instructions: str
    schema: dict[str, Any]
    convert: Converter | None = None
    check: Checker | None = None


def _object(props: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(props),
        "properties": props,
    }


_S: dict[str, Any] = {"type": "string"}
_NS: dict[str, Any] = {"type": ["string", "null"]}
_NSA: dict[str, Any] = {"type": ["array", "null"], "items": {"type": "string"}}


def _ops(*ops: str) -> dict[str, Any]:
    return {"type": "string", "enum": list(ops)}


def _body(item: dict[str, Any]) -> dict[str, Any]:
    return _object({"notes": _S, "changes": {"type": "array", "items": item}})


_TYPE: dict[str, Any] = {"type": ["string", "null"], "enum": [*get_args(ValueType), None]}
_VALUE = _object({"id": _S, "name": _NS, "type": _TYPE, "description": _NS, "enum": _NSA})

OUTPUTS_SCHEMA = _body(
    _object(
        {
            "op": _ops("putField", "putTable", "removeOutput"),
            "id": _S,
            "name": _NS,
            "type": _TYPE,
            "description": _NS,
            "enum": _NSA,
            "columns": {"type": ["array", "null"], "items": _VALUE},
            "reason": _S,
        }
    )
)

STEPS_SCHEMA = _body(
    _object(
        {
            "op": _ops("putStep", "removeStep", "setPreamble"),
            "id": _S,
            "type": {"type": ["string", "null"], "enum": ["extract", "check", None]},
            "fields": _NSA,
            "table": _NS,
            "sections": _NSA,
            "instructions": _NS,
            "pageImages": {"type": ["array", "null"], "items": {"type": "integer"}},
            "chunkPages": {"type": ["integer", "null"]},
            "context": {"type": ["array", "null"], "items": _object({"name": _S, "path": _S})},
            "description": _NS,
            "values": _NS,
            "reference": _NS,
            "aliases": _NS,
            "preamble": _NS,
            "reason": _S,
        }
    )
)


def _clean(d: dict[str, Any]) -> dict[str, Any]:
    """Drop null, empty strings and empty lists: the TS schemas reject them (min(1))."""
    return {k: v for k, v in d.items() if v is not None and v != "" and v != []}


def _dump(model: BaseModel) -> dict[str, Any]:
    """Typed change payload (camelCase, defaults omitted: the TS schema fills them back)."""
    return model.model_dump(by_alias=True, exclude_none=True, exclude_defaults=True)


def _errors(i: int, exc: ValidationError) -> list[str]:
    return [
        f"changes[{i}]: {'.'.join(str(p) for p in e['loc']) or 'item'}: {e['msg']}"
        for e in exc.errors()
    ]


def _value(c: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "name", "type", "description", "enum")
    return _clean({k: c.get(k) for k in keys})


def convert_outputs(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    changes: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, c in enumerate(data["changes"]):
        try:
            if c["op"] == "putField":
                field = ValueDef.model_validate(_value(c))
                changes.append({"op": "putField", "field": _dump(field), "reason": c["reason"]})
            elif c["op"] == "putTable":
                table = TableDef.model_validate(
                    _clean(
                        {
                            "id": c["id"],
                            "name": c.get("name"),
                            "description": c.get("description"),
                            "columns": [_value(col) for col in c.get("columns") or []],
                        }
                    )
                )
                changes.append({"op": "putTable", "table": _dump(table), "reason": c["reason"]})
            else:
                changes.append({"op": "removeOutput", "id": c["id"], "reason": c["reason"]})
        except ValidationError as exc:
            errors += _errors(i, exc)
    return {"notes": data["notes"], "changes": changes}, errors


def _output_ids(definition: dict[str, Any]) -> set[str]:
    outputs = definition.get("outputs") or {}
    return {
        str(o.get("id")) for o in [*(outputs.get("fields") or []), *(outputs.get("tables") or [])]
    }


def check_outputs(body: dict[str, Any], draft: dict[str, Any]) -> list[str]:
    errors = [
        f"changes[{i}]: removeOutput {c['id']!r}: no such output in the draft at that point"
        for i, c in enumerate(body["changes"])
        if c["op"] == "removeOutput"
        and c["id"] not in _output_ids(apply_changes(draft, body["changes"][:i]))
    ]
    applied = apply_changes(draft, body["changes"])
    errors += [
        f"output id {t['id']!r} is reserved"
        for t in applied["outputs"]["tables"]
        if t["id"] in RESERVED_OUTPUT_IDS
    ]
    if not _output_ids(applied):
        errors.append("propose at least one field or table")
    return errors


def convert_steps(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    changes: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, c in enumerate(data["changes"]):
        try:
            if c["op"] == "putStep":
                step: BaseModel
                if c.get("type") == "check":
                    keys = ("id", "description", "values", "reference", "aliases")
                    step = CheckStep.model_validate(
                        _clean({"type": "check", **{k: c.get(k) for k in keys}})
                    )
                else:
                    context = {x["name"]: x["path"] for x in c.get("context") or []}
                    step = ExtractStep.model_validate(
                        _clean(
                            {
                                "type": "extract",
                                "id": c["id"],
                                "fields": c.get("fields"),
                                "table": c.get("table"),
                                "sections": c.get("sections"),
                                "instructions": c.get("instructions"),
                                "pageImages": c.get("pageImages"),
                                "chunkPages": c.get("chunkPages"),
                                "context": context or None,
                            }
                        )
                    )
                changes.append({"op": "putStep", "step": _dump(step), "reason": c["reason"]})
            elif c["op"] == "removeStep":
                changes.append({"op": "removeStep", "id": c["id"], "reason": c["reason"]})
            else:
                changes.append(
                    {
                        "op": "setPreamble",
                        "preamble": c.get("preamble") or "",
                        "reason": c["reason"],
                    }
                )
        except ValidationError as exc:
            errors += _errors(i, exc)
    return {"notes": data["notes"], "changes": changes}, errors


def check_steps(body: dict[str, Any], draft: dict[str, Any]) -> list[str]:
    errors = [
        f"changes[{i}]: removeStep {c['id']!r}: no such step in the draft at that point"
        for i, c in enumerate(body["changes"])
        if c["op"] == "removeStep"
        and c["id"]
        not in {
            s.get("id") for s in apply_changes(draft, body["changes"][:i]).get("pipeline") or []
        }
    ]
    try:
        Template.model_validate(apply_changes(draft, body["changes"]))
    except ValidationError as exc:
        for e in exc.errors():
            msg = str(e["msg"])
            if msg.startswith("Value error, "):
                errors += [part.strip() for part in msg.removeprefix("Value error, ").split(";")]
            else:
                errors.append(f"{'.'.join(str(p) for p in e['loc']) or 'template'}: {msg}")
    return errors


OUTPUTS = Stage(
    "outputs",
    """\
Task: propose the template's outputs from the survey, the brief and the samples.
- changes: one per output.
  - putField: one value per document. id is lowercase_snake_case; type is one of text,
    integer, decimal, date, boolean, enum, list; enum lists the allowed values for type enum;
    description tells an extractor exactly what to copy.
  - putTable: repeating rows. columns use the same keys as a field; columns is null for fields.
  - removeOutput: drop an output the current draft has that the brief does not want.
- Keep outputs the current draft already has unless the brief or survey says otherwise;
  proposing an existing id replaces it.
- Use null for keys that do not apply. reason: one sentence citing the brief or a sample.
- notes: anything the user should know (ambiguities, outputs you left out).
Return JSON only.""",
    OUTPUTS_SCHEMA,
    convert_outputs,
    check_outputs,
)

STEPS = Stage(
    "steps",
    """\
Task: propose the extraction pipeline that fills every output in the current draft.
- putStep with type extract:
  - id, and sections (ids from the current draft's sections).
  - Either fields (field ids) or table (one table id). Every field and table must be filled
    by exactly one step.
  - instructions: concrete guidance (where the value is, formats, what to ignore).
  - pageImages: page numbers to show as images when the text loses information, else null.
  - chunkPages: only for a long table in one section.
  - context: values from earlier steps the prompt should see, as {name, path}, where path is
    a field id or table.column.
- putStep with type check: values and reference are paths (field or table.column) whose values
  must match; aliases optional.
- removeStep: drop a step from the current draft.
- setPreamble: domain guidance placed at the top of every extraction prompt (from the brief).
- Steps run in the order given; context may only use outputs filled by earlier steps.
- Use null for keys that do not apply. reason: one sentence.
Return JSON only.""",
    STEPS_SCHEMA,
    convert_steps,
    check_steps,
)
