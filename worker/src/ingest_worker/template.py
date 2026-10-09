"""Document type templates (outputs-first). Mirrors packages/shared/src/template.ts.

A template declares:
- outputs: atomic `fields` (one value per document, e.g. Compound, Execution Date) and `tables`
  (rows), each with typed columns;
- pipeline: ordered `extract` steps, each filling some fields or one table (from its own prompt,
  sections, page images and model), and `check` steps comparing values across outputs;
- review: when a processed document needs human review.

Extract steps compile to the engine's Extraction model with a JSON Schema generated from the
field/column definitions, so the schema and the CSV layout can never disagree.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field, model_validator

from .normalize import DateOrder, ValueType
from .specs import Check, DocumentLayout, Extraction, Id, _Model

RESERVED_OUTPUT_IDS = {"fields", "document", "issues"}
BUILTIN_PROMPT = "builtin/extract.md.j2"


class ValueDef(_Model):
    """A field (atom) or table column."""

    id: Id
    name: str | None = None
    type: ValueType = "text"
    description: str | None = None
    enum: list[str] | None = None

    @model_validator(mode="after")
    def _enum_values(self) -> ValueDef:
        if self.type == "enum" and not self.enum:
            raise ValueError(f"{self.id!r}: enum values are required for type enum")
        return self


class TableDef(_Model):
    id: Id
    name: str | None = None
    description: str | None = None
    columns: list[ValueDef] = Field(min_length=1)


class OutputsDef(_Model):
    fields: list[ValueDef] = Field(default_factory=list)
    tables: list[TableDef] = Field(default_factory=list)


class ExtractStep(_Model):
    type: Literal["extract"]
    id: Id
    fields: list[Id] = Field(default_factory=list)
    table: Id | None = None
    sections: list[Id] = Field(min_length=1)
    #: Free-text guidance added to the built-in prompt (no Jinja needed).
    instructions: str | None = None
    #: Custom Jinja2 prompt file relative to the template directory (replaces the built-in).
    prompt: str | None = None
    model: str = "default"
    page_images: list[Annotated[int, Field(ge=1)]] = Field(default_factory=list, alias="pageImages")
    max_attempts: int = Field(default=2, ge=1, le=5, alias="maxAttempts")
    max_tokens: int = Field(default=16000, ge=256, le=128000, alias="maxTokens")
    chunk_pages: int | None = Field(default=None, ge=1, alias="chunkPages")
    #: Values from earlier steps shown in the prompt: name -> `<field>` or `<table>.<column>`.
    context: dict[Id, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _fills(self) -> ExtractStep:
        if bool(self.fields) == (self.table is not None):
            raise ValueError(f"step {self.id!r}: a step must fill either fields or a table")
        if self.chunk_pages is not None and self.table is None:
            raise ValueError(f"step {self.id!r}: only table steps can be chunked")
        if self.chunk_pages is not None and len(self.sections) != 1:
            raise ValueError(f"step {self.id!r}: chunked steps need exactly one section")
        return self


class CheckStep(_Model):
    """Paths are `<field>` or `<table>.<column>`."""

    type: Literal["check"]
    id: Id
    description: str | None = None
    values: str
    reference: str
    aliases: str | None = None
    max_distance: int = Field(default=2, ge=0, alias="maxDistance")


Step = Annotated[ExtractStep | CheckStep, Field(discriminator="type")]


class ReviewPolicy(_Model):
    #: always: every document; on_warnings: issues or unmatched checks; never: auto-approve.
    required: Literal["always", "on_warnings", "never"] = "on_warnings"


class TemplateDocument(DocumentLayout):
    #: Prefix each page with "[page N]" (original PDF numbering) so models can cite pages.
    page_markers: bool = Field(default=True, alias="pageMarkers")
    #: How to read ambiguous numeric dates like 02/03/2023.
    date_order: DateOrder = Field(default="DMY", alias="dateOrder")


class Template(_Model):
    id: Id
    version: int = Field(gt=0)
    name: str = Field(min_length=1)
    description: str | None = None
    #: Domain guidance placed at the top of every built-in prompt.
    preamble: str | None = None
    document: TemplateDocument
    outputs: OutputsDef
    pipeline: list[Step] = Field(min_length=1)
    review: ReviewPolicy = Field(default_factory=ReviewPolicy)

    # --- lookups ---------------------------------------------------------------------------

    def field(self, field_id: str) -> ValueDef:
        return next(f for f in self.outputs.fields if f.id == field_id)

    def table(self, table_id: str) -> TableDef:
        return next(t for t in self.outputs.tables if t.id == table_id)

    def extract_steps(self) -> list[ExtractStep]:
        return [s for s in self.pipeline if isinstance(s, ExtractStep)]

    def filler_of_field(self, field_id: str) -> ExtractStep:
        return next(s for s in self.extract_steps() if field_id in s.fields)

    def filler_of_table(self, table_id: str) -> ExtractStep:
        return next(s for s in self.extract_steps() if s.table == table_id)

    def _resolve(self, path: str) -> tuple[str, ValueDef] | None:
        """`<field>` or `<table>.<column>` -> (engine path, definition)."""
        head, _, column = path.partition(".")
        if column:
            table = next((t for t in self.outputs.tables if t.id == head), None)
            col = next((c for c in table.columns if c.id == column), None) if table else None
            if table is None or col is None:
                return None
            suffix = "[*]" if col.type == "list" else ""
            return f"{self.filler_of_table(head).id}.rows[*].{column}{suffix}", col
        fld = next((f for f in self.outputs.fields if f.id == head), None)
        if fld is None:
            return None
        suffix = "[*]" if fld.type == "list" else ""
        return f"{self.filler_of_field(head).id}.{head}.value{suffix}", fld

    def compile_check(self, step: CheckStep) -> Check:
        def path(p: str) -> str:
            resolved = self._resolve(p)
            assert resolved is not None  # validated
            return resolved[0]

        return Check.model_validate(
            {
                "id": step.id,
                "description": step.description,
                "values": path(step.values),
                "reference": path(step.reference),
                "aliases": path(step.aliases) if step.aliases else None,
                "maxDistance": step.max_distance,
            }
        )

    # --- validation --------------------------------------------------------------------------

    @model_validator(mode="after")
    def _consistency(self) -> Template:
        errors: list[str] = []
        field_ids = [f.id for f in self.outputs.fields]
        table_ids = [t.id for t in self.outputs.tables]
        step_ids = [s.id for s in self.pipeline]
        section_ids = {s.id for s in self.document.sections}

        for label, ids in (("output", field_ids + table_ids), ("step", step_ids)):
            errors += [
                f"duplicate {label} id {i!r}" for i in sorted({i for i in ids if ids.count(i) > 1})
            ]
        clashes = set(table_ids) | {s.id for s in self.pipeline if isinstance(s, CheckStep)}
        errors += [f"output id {i!r} is reserved" for i in sorted(clashes & RESERVED_OUTPUT_IDS)]

        fills: dict[str, int] = {}
        for step in self.extract_steps():
            errors += [
                f"step {step.id!r}: unknown section {s!r}"
                for s in step.sections
                if s not in section_ids
            ]
            for f in step.fields:
                if f not in field_ids:
                    errors.append(f"step {step.id!r}: unknown field {f!r}")
                fills[f] = fills.get(f, 0) + 1
            if step.table is not None:
                if step.table not in table_ids:
                    errors.append(f"step {step.id!r}: unknown table {step.table!r}")
                fills[step.table] = fills.get(step.table, 0) + 1
        for output_id in field_ids + table_ids:
            count = fills.get(output_id, 0)
            kind = "field" if output_id in field_ids else "table"
            if count == 0:
                errors.append(f"{kind} {output_id!r} is not filled by any step")
            elif count > 1:
                errors.append(f"{kind} {output_id!r} is filled by more than one step")

        if not errors:  # context must come from steps that have already run
            order = {s.id: i for i, s in enumerate(self.pipeline)}
            for step in self.extract_steps():
                for name, path in step.context.items():
                    if self._resolve(path) is None:
                        errors.append(
                            f"step {step.id!r}: context {name!r}: unknown field or column {path!r}"
                        )
                        continue
                    head, _, column = path.partition(".")
                    filler = self.filler_of_table(head) if column else self.filler_of_field(head)
                    if order[filler.id] >= order[step.id]:
                        errors.append(
                            f"step {step.id!r}: context {name!r} refers to {path!r}, which is "
                            "not filled by an earlier step"
                        )

        if not errors:  # path resolution needs a consistent template
            for check in self.pipeline:
                if isinstance(check, CheckStep):
                    for p in filter(None, (check.values, check.reference, check.aliases)):
                        if self._resolve(p) is None:
                            errors.append(f"check {check.id!r}: unknown field or column {p!r}")
        if errors:
            raise ValueError("; ".join(errors))
        return self


# --- compiling extract steps -----------------------------------------------------------------


def value_schema(v: ValueDef) -> dict[str, Any]:
    """JSON Schema for one value. Numbers may also arrive as strings ("137·8"); they are
    normalised after validation, so the model is never forced to invent a clean number."""
    schema: dict[str, Any]
    if v.type == "list":
        schema = {"type": "array", "items": {"type": "string"}}
    elif v.type == "enum":
        schema = {"type": ["string", "null"], "enum": [*(v.enum or []), None]}
    elif v.type in ("decimal", "integer"):
        schema = {"type": ["number" if v.type == "decimal" else "integer", "string", "null"]}
    elif v.type == "boolean":
        schema = {"type": ["boolean", "null"]}
    else:  # text, date (dates are copied as written, normalised to ISO afterwards)
        schema = {"type": ["string", "null"]}
    if v.description:
        schema["description"] = v.description
    return schema


def _field_schema(v: ValueDef) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "additionalProperties": False,
        "required": ["value", "evidence", "page"],
        "properties": {
            "value": value_schema(v),
            "evidence": {
                "type": ["string", "null"],
                "description": "Short verbatim quote from the document supporting the value",
            },
            "page": {
                "type": ["integer", "null"],
                "description": "Page number from the nearest preceding [page N] marker",
            },
        },
    }
    if v.description:
        schema["description"] = v.description
    return schema


def _definition(v: ValueDef) -> dict[str, Any]:
    return v.model_dump()  # keep None keys: prompt templates use StrictUndefined


def compile_step(template: Template, step: ExtractStep) -> Extraction:
    if step.fields:
        defs = [template.field(f) for f in step.fields]
        schema: dict[str, Any] = {
            "type": "object",
            "additionalProperties": False,
            "required": list(step.fields),
            "properties": {d.id: _field_schema(d) for d in defs},
        }
        context: dict[str, Any] = {"fields": [_definition(d) for d in defs], "table": None}
    else:
        assert step.table is not None
        table = template.table(step.table)
        row = {
            "type": "object",
            "additionalProperties": False,
            "required": [c.id for c in table.columns],
            "properties": {c.id: value_schema(c) for c in table.columns},
        }
        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["rows"],
            "properties": {"rows": {"type": "array", "items": row}},
        }
        context = {
            "fields": None,
            "table": {
                **table.model_dump(exclude={"columns"}),
                "columns": [_definition(c) for c in table.columns],
            },
        }
    context.update(
        preamble=template.preamble,
        instructions=step.instructions,
        document_name=template.name,
        step_context=[],  # filled at run time from earlier steps' results
    )
    return Extraction.model_validate(
        {
            "id": step.id,
            "sections": step.sections,
            "prompt": step.prompt or BUILTIN_PROMPT,
            "model": step.model,
            "schema": schema,
            "maxAttempts": step.max_attempts,
            "pageImages": step.page_images,
            "maxTokens": step.max_tokens,
            "chunkPages": step.chunk_pages,
            "mergePath": "rows" if step.chunk_pages else None,
            "promptContext": context,
        }
    )
