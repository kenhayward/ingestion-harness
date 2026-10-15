"""Drafting stages that propose changes to the draft template (ADR 0007, phase 3b).

Models answer in a flat JSON shape (every key present, null when not applicable), which every
provider's structured output accepts. `convert` turns that into the typed changes of
packages/shared/src/drafting.ts (DraftChange), validating each item with the template's own
Pydantic models; `check` validates the changes against the current draft. Both feed their
errors back to the model through run_extraction(check=...)."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, get_args

from pydantic import BaseModel, ValidationError

from .draft_changes import apply_changes
from .normalize import ValueType
from .specs import CopySelection, Section
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


#: Why an extract step needs sections, and what to do with a value no section holds.
EMPTY_SECTIONS = (
    "sections is empty: an extract step reads at least one section. For a value no section "
    "holds (a file name, a value these documents lack), fill it in the step that reads the "
    "section it belongs with; it may come back empty."
)


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
                    if not c.get("sections"):
                        # Dropped as empty, it would read "sections: Field required": the model
                        # sent the key, so it repeats itself. Say what the rule is instead.
                        errors.append(f"changes[{i}]: step {c['id']!r}: {EMPTY_SECTIONS}")
                        continue
                    items = c.get("context") or []
                    if any(not x.get("name") or not x.get("path") for x in items):
                        errors.append(f"changes[{i}]: context item needs name and path")
                        continue
                    context = {x["name"]: x["path"] for x in items}
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
    Every extract step reads at least one section: never send an empty list.
  - Either fields (field ids) or table (one table id). Every field and table must be filled
    by exactly one step. A field no section holds (the file name, a value these documents
    lack) goes in the step that reads the section it belongs with; it may come back empty.
  - instructions: concrete guidance (where the value is, formats, what to ignore).
  - pageImages: page numbers to show as images when the text loses information, else null.
  - chunkPages: only for a long table in one section.
  - context: values from earlier steps the prompt should see, as {name, path}, where path is
    a field id or table.column.
- putStep with type check: values and reference are paths (field or table.column) whose values
  must match; aliases optional.
- Every extraction prompt states the source file name and starts each page with "[page N]":
  a step can fill the originating file name from it, and a page number from the markers.
- removeStep: drop a step from the current draft.
- setPreamble: domain guidance placed at the top of every extraction prompt (from the brief).
- Steps run in the order given; context may only use outputs filled by earlier steps.
- Use null for keys that do not apply. reason: one sentence.
Return JSON only.""",
    STEPS_SCHEMA,
    convert_steps,
    check_steps,
)

SECTIONS_SCHEMA = _body(
    _object(
        {
            "op": _ops("putSection", "removeSection", "setCopies"),
            "id": _S,
            "anchor": _NS,
            "required": {"type": ["boolean", "null"]},
            "description": _NS,
            "copiesSelect": {"type": ["string", "null"], "enum": ["first", "last", None]},
            "reason": _S,
        }
    )
)


def _regex_error(pattern: str) -> str | None:
    try:
        re.compile(pattern, re.MULTILINE)
    except re.error as exc:
        return str(exc)
    return None


def convert_sections(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    changes: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, c in enumerate(data["changes"]):
        try:
            if c["op"] == "putSection":
                keys = ("id", "anchor", "required", "description")
                section = Section.model_validate(_clean({k: c.get(k) for k in keys}))
                changes.append(
                    {"op": "putSection", "section": _dump(section), "reason": c["reason"]}
                )
            elif c["op"] == "removeSection":
                changes.append({"op": "removeSection", "id": c["id"], "reason": c["reason"]})
            else:
                copies = (
                    _dump(
                        CopySelection.model_validate(
                            _clean({"anchor": c["anchor"], "select": c.get("copiesSelect")})
                        )
                    )
                    if c.get("anchor")
                    else None
                )
                changes.append({"op": "setCopies", "copies": copies, "reason": c["reason"]})
        except ValidationError as exc:
            errors += _errors(i, exc)
    return {"notes": data["notes"], "changes": changes}, errors


def _section_ids(definition: dict[str, Any]) -> list[Any]:
    return [s.get("id") for s in (definition.get("document") or {}).get("sections") or []]


def check_sections(body: dict[str, Any], draft: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for i, c in enumerate(body["changes"]):
        if c["op"] == "putSection" and (error := _regex_error(c["section"]["anchor"])):
            errors.append(f"section {c['section']['id']!r}: invalid regular expression: {error}")
        elif (
            c["op"] == "setCopies"
            and c["copies"]
            and (error := _regex_error(c["copies"]["anchor"]))
        ):
            errors.append(f"copies: invalid regular expression: {error}")
        elif c["op"] == "removeSection" and c["id"] not in _section_ids(
            apply_changes(draft, body["changes"][:i])
        ):
            errors.append(
                f"changes[{i}]: removeSection {c['id']!r}: no such section in the draft at that point"
            )
    if not _section_ids(apply_changes(draft, body["changes"])):
        errors.append("keep at least one section")
    return errors


SECTIONS = Stage(
    "sections",
    """\
Task: propose section anchors that split every sample the same way.
- putSection:
  - id: lowercase.
  - anchor: a Python regular expression (multiline mode) matching the first line of the
    section in every sample. Prefer headings and wording over page numbers or layout.
  - required: false when some documents legitimately lack the section.
  - description: what the section contains.
- removeSection: drop a section from the current draft.
- setCopies: when a PDF holds several copies (for example blank, then executed), anchor is the
  regex that starts each copy and copiesSelect is first or last; anchor null removes copy
  selection.
- Every anchor is tested on every dev sample before the user sees it; misses are reported back.
- Use null for keys that do not apply. reason: one sentence.
Return JSON only.""",
    SECTIONS_SCHEMA,
    convert_sections,
    check_sections,
)


def _denull(node: Any) -> Any:
    """A schema without union types: Anthropic strict mode allows at most 16 across a schema.
    ["x","null"] becomes "x"; enums that allowed null allow "" instead."""
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "type" and isinstance(value, list):
            out[key] = next(t for t in value if t != "null")
        elif key == "enum":
            out[key] = [x for x in value if x is not None] + ([""] if None in value else [])
        elif key == "properties":
            out[key] = {k: _denull(v) for k, v in value.items()}
        elif key == "items":
            out[key] = _denull(value)
        else:
            out[key] = value
    return out


def _item_schema(stage_schema: dict[str, Any]) -> dict[str, Any]:
    """A stage's flat change item without op/reason, de-nulled: the revise payload."""
    item = stage_schema["properties"]["changes"]["items"]
    result: dict[str, Any] = _denull(
        _object({k: v for k, v in item["properties"].items() if k not in ("op", "reason")})
    )
    return result


_OUTPUT_ITEM = _item_schema(OUTPUTS_SCHEMA)
_SECTION_ITEM = _item_schema(SECTIONS_SCHEMA)
_STEP_ITEM = _item_schema(STEPS_SCHEMA)

#: op -> (stage whose converter handles it, key of its payload in a revise change)
_REVISE_GROUPS: dict[str, tuple[Stage, str]] = {
    **{op: (OUTPUTS, "field") for op in ("putField", "removeOutput")},
    "putTable": (OUTPUTS, "table"),
    **{op: (SECTIONS, "section") for op in ("putSection", "removeSection", "setCopies")},
    **{op: (STEPS, "step") for op in ("putStep", "removeStep", "setPreamble")},
}
#: Ops whose payload carries no id.
_NO_ID_OPS = {"setCopies", "setPreamble"}

REVISE_SCHEMA = _body(
    _object(
        {
            "op": _ops(*_REVISE_GROUPS),
            "field": _OUTPUT_ITEM,
            "table": _OUTPUT_ITEM,
            "section": _SECTION_ITEM,
            "step": _STEP_ITEM,
            "answers": {"type": "array", "items": _S},
            "reason": _S,
        }
    )
)


def _compact(value: Any) -> Any:
    """Drop the empty placeholders ("", [], 0, null) the revise schema uses for 'not set'."""
    if isinstance(value, dict):
        items = ((k, _compact(v)) for k, v in value.items())
        return {k: v for k, v in items if v is not None}
    if isinstance(value, list):
        return [_compact(v) for v in value] or None
    if (
        value == ""
        or value is None
        or (isinstance(value, int) and not isinstance(value, bool) and value == 0)
    ):
        return None
    return value


def _answers(value: Any) -> list[str]:
    """The feedback labels a revise change answers: trimmed, non-empty, each once, in order."""
    items = value if isinstance(value, list) else []
    return list(dict.fromkeys(a.strip() for a in items if isinstance(a, str) and a.strip()))


def convert_revise(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    changes: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, c in enumerate(data["changes"]):
        stage, key = _REVISE_GROUPS[c["op"]]
        payload = _compact(c.get(key)) if isinstance(c.get(key), dict) else None
        if c["op"] in _NO_ID_OPS:
            payload = payload or {}  # empty means clear the preamble / the copy selection
        elif not payload or "id" not in payload:
            errors.append(f"changes[{i}]: {c['op']} needs its {key} object")
            continue
        assert stage.convert is not None
        body, errs = stage.convert(
            {"notes": "", "changes": [{**payload, "op": c["op"], "reason": c["reason"]}]}
        )
        errors += [e.replace("changes[0]", f"changes[{i}]", 1) for e in errs]
        answers = _answers(c.get("answers"))
        changes += [{**ch, "answers": answers} if answers else ch for ch in body["changes"]]
    return {"notes": data["notes"], "changes": changes}, errors


def check_revise(body: dict[str, Any], draft: dict[str, Any]) -> list[str]:
    """Every op's checks over the whole revision (each check inspects only its own ops and
    applies earlier changes in sequence), then the complete template."""
    errors: list[str] = []
    for check in (check_outputs, check_sections, check_steps):
        errors += [e for e in check(body, draft) if e not in errors]
    return errors


def resolve_answers(body: dict[str, Any], labels: dict[str, str]) -> dict[str, Any]:
    """Map the model's feedback labels (F1, F2, ...) to feedback ids (RV2, TS DraftChange.answers).

    Labels are case-insensitive and an exact id is accepted too. Unknown labels are dropped: an
    answer only decides which feedback an accept resolves, and dropping one leaves it open. A
    change left with no answers carries no `answers` key."""
    by_label = {k.upper(): v for k, v in labels.items()}
    ids = set(labels.values())
    changes: list[dict[str, Any]] = []
    for change in body["changes"]:
        rest = {k: v for k, v in change.items() if k != "answers"}
        mapped = [
            by_label.get(a.upper()) or (a if a in ids else None)
            for a in change.get("answers") or []
        ]
        found = list(dict.fromkeys(m for m in mapped if m))
        changes.append({**rest, "answers": found} if found else rest)
    return {**body, "changes": changes}


REVISE = Stage(
    "revise",
    """\
Task: revise the current draft so it answers the user's feedback and fixes the evaluation
failures (expected vs actual values on the dev samples).
- Propose only the changes needed; each change has op and exactly one payload object:
  - field (putField, removeOutput): id, name, type, description, enum, columns as for outputs;
  - table (putTable): id, name, description, columns;
  - section (putSection, removeSection, setCopies): id, anchor, required, description,
    copiesSelect;
  - step (putStep, removeStep, setPreamble): id, type, fields, table, sections, instructions,
    pageImages, chunkPages, context, description, values, reference, aliases, preamble.
  Fill the payload objects you do not use, and keys that do not apply, with empty values:
  "" for text, [] for lists, 0 for numbers (required: true unless a section may be absent).
- The template must stay valid: every field and table filled by exactly one step; steps only
  use existing sections; context only from earlier steps.
- Prefer clearer instructions, better anchors or more precise field descriptions over adding
  outputs. reason: which feedback item or failure the change addresses.
- answers: the labels of the feedback items the change answers (for example ["F1", "F3"]);
  [] when it only fixes evaluation failures.
- notes: anything you could not fix and why.
Return JSON only.""",
    REVISE_SCHEMA,
    convert_revise,
    check_revise,
)
