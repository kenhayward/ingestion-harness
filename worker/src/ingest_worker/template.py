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
from .specs import Check, DocumentLayout, Extraction, Id, Section, _Model

RESERVED_OUTPUT_IDS = {"fields", "document", "issues", "graph"}
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
    #: A model choice; `default` (or absent) inherits the template's `model`.
    model: str = "default"
    page_images: list[Annotated[int, Field(ge=1)]] = Field(default_factory=list, alias="pageImages")
    max_attempts: int = Field(default=2, ge=1, le=5, alias="maxAttempts")
    max_tokens: int = Field(default=64000, ge=256, le=128000, alias="maxTokens")
    chunk_pages: int | None = Field(default=None, ge=1, alias="chunkPages")
    #: Values from earlier steps shown in the prompt: name -> `<field>` or `<table>.<column>`.
    context: dict[Id, str] = Field(default_factory=dict)
    #: The table column the worker fills with each occurrence's key (repeating sections).
    key_column: Id | None = Field(default=None, alias="keyColumn")

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


class OntologyPin(_Model):
    id: str = Field(min_length=1)
    version: int = Field(gt=0)


class EntityMapping(_Model):
    """The value names an entity: its class and readable IRI template."""

    class_: str = Field(alias="class", min_length=1)
    iri: str = Field(min_length=1)
    label: bool | None = None


class ConceptMapping(_Model):
    """The value links to a SKOS concept: by explicit value, or by label within `scheme`."""

    scheme: str | None = None
    values: dict[str, str] | None = None
    match: Literal["label"] | None = None


class OutputMapping(_Model):
    """How one field or column becomes RDF (OutputMappingSchema in TS)."""

    property: str = Field(min_length=1)
    object: EntityMapping | None = None
    concepts: ConceptMapping | None = None


class DocumentMapping(_Model):
    class_: str = Field(alias="class", min_length=1)
    iri: str = Field(default="doc/{source}", min_length=1)


class TableMapping(_Model):
    link: str = Field(min_length=1)
    class_: str = Field(alias="class", min_length=1)
    iri: str | None = None
    columns: dict[str, OutputMapping] = Field(default_factory=dict)


class LocalTerm(_Model):
    iri: str = Field(min_length=1)
    kind: Literal["class", "object_property", "datatype_property", "annotation_property", "concept"]
    label: str = Field(min_length=1)
    definition: str | None = None


class Semantics(_Model):
    """The recipe's ontology mapping (ADR 0011; SemanticsSchema in TS)."""

    ontologies: list[OntologyPin] = Field(default_factory=list)
    shapes: list[OntologyPin] = Field(default_factory=list)
    prefixes: dict[str, str] = Field(default_factory=dict)
    document: DocumentMapping
    fields: dict[str, OutputMapping] = Field(default_factory=dict)
    tables: dict[str, TableMapping] = Field(default_factory=dict)
    local: list[LocalTerm] = Field(default_factory=list)


DeliveryFormat = Literal["csv", "json", "rdf"]


class Delivery(_Model):
    formats: list[DeliveryFormat] = Field(min_length=1)


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
    #: The document type's model choice, inherited by every extract step that names none
    #: (absent: the default model choice).
    model: str | None = None
    document: TemplateDocument
    outputs: OutputsDef
    pipeline: list[Step] = Field(min_length=1)
    review: ReviewPolicy = Field(default_factory=ReviewPolicy)
    #: How the outputs map to ontology terms (None: no RDF).
    semantics: Semantics | None = None
    #: What publishing delivers (None: CSV and JSON).
    delivery: Delivery | None = None

    # --- lookups ---------------------------------------------------------------------------

    def field(self, field_id: str) -> ValueDef:
        return next(f for f in self.outputs.fields if f.id == field_id)

    def table(self, table_id: str) -> TableDef:
        return next(t for t in self.outputs.tables if t.id == table_id)

    def repeating_section(self, step: ExtractStep) -> Section | None:
        """The repeating section a step reads (validation allows at most one), or None."""
        by_id = {s.id: s for s in self.document.sections}
        return next((by_id[i] for i in step.sections if i in by_id and by_id[i].repeat), None)

    def extract_steps(self) -> list[ExtractStep]:
        return [s for s in self.pipeline if isinstance(s, ExtractStep)]

    def step_model(self, step: ExtractStep) -> str:
        """The model a step runs: its own, else the template's, else the default choice."""
        if step.model != "default":
            return step.model
        return self.model or "default"

    def delivery_formats(self) -> list[DeliveryFormat]:
        """What publishing delivers (deliveryFormats in TS)."""
        return list(self.delivery.formats) if self.delivery else ["csv", "json"]

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

    def _semantics_errors(self) -> list[str]:
        """Delivery and mapping rules beyond the schema (TemplateSchema.superRefine in TS)."""
        errors: list[str] = []
        formats = list(self.delivery.formats) if self.delivery else []
        errors += [
            f"delivery: {f!r} is listed twice"
            for f in sorted({f for f in formats if formats.count(f) > 1})
        ]
        if "rdf" in formats and self.semantics is None:
            errors.append("delivery: rdf needs an ontology mapping (semantics)")
        if self.semantics is None:
            return errors

        def mapping(label: str, value: ValueDef, m: OutputMapping) -> None:
            if m.object is not None and m.concepts is not None:
                errors.append(f"semantics: {label}: map it to an entity or to concepts, not both")
            if value.type == "enum" and m.concepts is not None and m.concepts.values:
                errors.extend(
                    f"semantics: {label}: {v!r} is not one of its values"
                    for v in m.concepts.values
                    if v not in (value.enum or [])
                )

        fields = {f.id: f for f in self.outputs.fields}
        for fid, m in self.semantics.fields.items():
            if fid in fields:
                mapping(f"field {fid!r}", fields[fid], m)
            else:
                errors.append(f"semantics: unknown field {fid!r}")
        tables = {t.id: t for t in self.outputs.tables}
        for tid, tm in self.semantics.tables.items():
            if tid not in tables:
                errors.append(f"semantics: unknown table {tid!r}")
                continue
            columns = {c.id: c for c in tables[tid].columns}
            for cid, m in tm.columns.items():
                if cid in columns:
                    mapping(f"column {tid}.{cid}", columns[cid], m)
                else:
                    errors.append(f"semantics: table {tid!r}: unknown column {cid!r}")
        return errors

    def _repeat_errors(self, step: ExtractStep) -> list[str]:
        by_id = {s.id: s for s in self.document.sections}
        repeating = [i for i in step.sections if i in by_id and by_id[i].repeat]
        errors = []
        if step.fields and repeating:
            errors.append(
                f"step {step.id!r}: a field step cannot read a repeating section "
                f"({repeating[0]}); fill a table instead"
            )
        if len(repeating) > 1:
            errors.append(
                f"step {step.id!r}: reads more than one repeating section ({', '.join(repeating)})"
            )
        if step.key_column is not None:
            section = by_id[repeating[0]] if repeating else None
            if (
                step.table is None
                or section is None
                or (section.key is None and section.key_from is None)
            ):
                errors.append(
                    f"step {step.id!r}: keyColumn needs a repeating section with a key or keyFrom"
                )
            else:
                table = next((t for t in self.outputs.tables if t.id == step.table), None)
                if table is not None and step.key_column not in [c.id for c in table.columns]:
                    errors.append(
                        f"step {step.id!r}: keyColumn {step.key_column!r} is not a column of "
                        f"{step.table}"
                    )
        return errors

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
            errors += self._repeat_errors(step)
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
        errors += self._semantics_errors()
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
            "model": template.step_model(step),
            "schema": schema,
            "maxAttempts": step.max_attempts,
            "pageImages": step.page_images,
            "maxTokens": step.max_tokens,
            "chunkPages": step.chunk_pages,
            "mergePath": "rows" if step.chunk_pages or template.repeating_section(step) else None,
            "promptContext": context,
        }
    )
