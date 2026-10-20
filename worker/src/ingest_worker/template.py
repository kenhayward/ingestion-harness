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

import re
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import Field, model_validator

from .normalize import DateOrder, ValueType
from .specs import Check, DocumentLayout, Extraction, Id, Section, _Model

RESERVED_OUTPUT_IDS = {"fields", "document", "issues", "graph"}
BUILTIN_PROMPT = "builtin/extract.md.j2"


class Bound(_Model):
    """A constraint's bounds (docs/design/output-roles.md §1): either may be left out."""

    min: float | None = None
    max: float | None = None


class ValueDef(_Model):
    """A field (atom) or table column."""

    id: Id
    name: str | None = None
    type: ValueType = "text"
    description: str | None = None
    enum: list[str] | None = None
    #: Numbers outside it are review issues (decimal and integer).
    range: Bound | None = None
    #: The whole value must match it (text; Python `re`, as section anchors).
    pattern: str | None = Field(default=None, min_length=1)
    #: Its length in characters (text).
    length: Bound | None = None

    @model_validator(mode="after")
    def _enum_values(self) -> ValueDef:
        if self.type == "enum" and not self.enum:
            raise ValueError(f"{self.id!r}: enum values are required for type enum")
        return self

    @model_validator(mode="after")
    def _constraints(self) -> ValueDef:
        """The constraints' own rules (ValueDefSchema.superRefine in TS)."""
        errors: list[str] = []

        def bounds(name: str, b: Bound) -> None:
            if b.min is None and b.max is None:
                errors.append(f"{self.id!r}: {name} needs min or max")
            if b.min is not None and b.max is not None and b.min > b.max:
                errors.append(f"{self.id!r}: {name} min is above max")

        if self.range is not None:
            if self.type not in ("decimal", "integer"):
                errors.append(f"{self.id!r}: range needs a decimal or integer")
            bounds("range", self.range)
        if self.pattern is not None:
            if self.type != "text":
                errors.append(f"{self.id!r}: pattern needs a text")
            try:
                re.compile(self.pattern)
            except re.error:
                errors.append(f"{self.id!r}: {self.pattern!r} is not a valid pattern")
        if self.length is not None:
            if self.type != "text":
                errors.append(f"{self.id!r}: length needs a text")
            if (self.length.min or 0) < 0 or (self.length.max or 0) < 0:
                errors.append(f"{self.id!r}: length cannot be negative")
            if not all(float(b or 0).is_integer() for b in (self.length.min, self.length.max)):
                errors.append(f"{self.id!r}: length must be whole numbers")
            bounds("length", self.length)
        if errors:
            raise ValueError("; ".join(errors))
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
    #: A table step enriching an earlier step's rows (P4): the columns it fills, the rest being
    #: the creating step's. None: the step creates the table's rows.
    columns: list[Id] | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def _fills(self) -> ExtractStep:
        if bool(self.fields) == (self.table is not None):
            raise ValueError(f"step {self.id!r}: a step must fill either fields or a table")
        if self.chunk_pages is not None and self.table is None:
            raise ValueError(f"step {self.id!r}: only table steps can be chunked")
        if self.chunk_pages is not None and len(self.sections) != 1:
            raise ValueError(f"step {self.id!r}: chunked steps need exactly one section")
        return self


#: A plugin's id and the major version a recipe runs: `text.pattern@1` (TS `PLUGIN_REF`).
PLUGIN_REF = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+@[1-9][0-9]*$"


class CheckStep(_Model):
    """Paths are `<field>` or `<table>.<column>`. A check compares `values` with a `reference`, or
    runs a check plugin (`uses`, its settings in `with`); exactly one of the two."""

    type: Literal["check"]
    id: Id
    description: str | None = None
    values: str
    reference: str | None = None
    aliases: str | None = None
    max_distance: int = Field(default=2, ge=0, alias="maxDistance")
    #: A check plugin and its major version (instead of a reference).
    uses: str | None = Field(default=None, pattern=PLUGIN_REF)
    #: The check plugin's own settings (None: absent, so older recipes hash as before).
    with_: dict[str, Any] | None = Field(default=None, alias="with")

    @model_validator(mode="after")
    def _either(self) -> CheckStep:
        if self.uses is not None and self.reference is not None:
            raise ValueError(
                f"check {self.id!r}: a check runs a plugin or compares with a reference, not both"
            )
        if self.uses is None and self.reference is None:
            raise ValueError(f"check {self.id!r}: a check needs a reference or a plugin")
        return self


class PluginStep(_Model):
    """A step that runs a registered worker plugin instead of a model call
    (docs/design/recipe-plugins.md; PluginStepSchema in TS). It fills fields or one table like an
    extract step; `with` is the plugin's own settings, checked against its schema before the job
    calls any model (`plugins.resolve_plugins`)."""

    type: Literal["plugin"]
    id: Id
    uses: str = Field(pattern=PLUGIN_REF)
    fields: list[Id] = Field(default_factory=list)
    table: Id | None = None
    #: The text it reads (none: it reads only earlier values).
    sections: list[Id] = Field(default_factory=list)
    #: Earlier values it may read: name -> `<field>` or `<table>.<column>`.
    context: dict[Id, str] = Field(default_factory=dict)
    #: The plugin's own settings.
    with_: dict[str, Any] = Field(default_factory=dict, alias="with")
    #: A model choice, for a plugin that calls a model (egress "model"); absent, the document
    #: type's model (absent rather than "default", so older recipes read and hash as before).
    model: str | None = None
    #: The table column the worker fills with each occurrence's key (repeating sections).
    key_column: Id | None = Field(default=None, alias="keyColumn")
    #: A table step enriching an earlier step's rows (P4): the columns it fills, the rest being
    #: the creating step's. None: the step creates the table's rows.
    columns: list[Id] | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def _fills(self) -> PluginStep:
        if bool(self.fields) == (self.table is not None):
            raise ValueError(f"step {self.id!r}: a step must fill either fields or a table")
        return self


#: The steps that fill outputs.
FillingStep = ExtractStep | PluginStep

Step = Annotated[ExtractStep | CheckStep | PluginStep, Field(discriminator="type")]


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


class NodeMapping(_Model):
    """The value sits on a node of `class`, minted per row (per document for a field); terms
    left out come from `Semantics.value_nodes` (NodeMappingSchema in TS)."""

    class_: str = Field(alias="class", min_length=1)
    value: str | None = Field(default=None, min_length=1)
    unit: str | None = Field(default=None, min_length=1)
    unit_property: str | None = Field(default=None, alias="unitProperty", min_length=1)


class ValueNodeDefaults(_Model):
    """The link, value and unit properties every value node uses unless it gives its own."""

    link: str | None = Field(default=None, min_length=1)
    value: str | None = Field(default=None, min_length=1)
    unit_property: str | None = Field(default=None, alias="unitProperty", min_length=1)


class OutputMapping(_Model):
    """How one field or column becomes RDF (OutputMappingSchema in TS). `property` may be absent
    only on a value node, whose link then comes from `Semantics.value_nodes`."""

    property: str | None = Field(default=None, min_length=1)
    object: EntityMapping | None = None
    concepts: ConceptMapping | None = None
    node: NodeMapping | None = None


@dataclass(frozen=True)
class ResolvedNode:
    """A value node's effective terms (ResolvedNode in TS)."""

    class_: str
    link: str | None = None
    value: str | None = None
    unit: str | None = None
    unit_property: str | None = None

    def to_json(self) -> dict[str, str]:
        out = {
            "link": self.link,
            "class": self.class_,
            "value": self.value,
            "unit": self.unit,
            "unitProperty": self.unit_property,
        }
        return {k: v for k, v in out.items() if v is not None}


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
    value_nodes: ValueNodeDefaults | None = Field(default=None, alias="valueNodes")

    def resolve_node(self, m: OutputMapping) -> ResolvedNode | None:
        """A value node's effective terms, its own else the defaults; None for another form.
        Held in step with `resolveNode` in TS by the shared fixture `value-nodes.json`."""
        if m.node is None:
            return None
        d = self.value_nodes or ValueNodeDefaults()
        return ResolvedNode(
            class_=m.node.class_,
            link=m.property if m.property is not None else d.link,
            value=m.node.value if m.node.value is not None else d.value,
            unit=m.node.unit,
            unit_property=(
                m.node.unit_property if m.node.unit_property is not None else d.unit_property
            ),
        )

    def link_of(self, m: OutputMapping) -> str | None:
        """The property an output hangs off its document or row by (`linkOf` in TS)."""
        if m.node is not None and m.property is None:
            return self.value_nodes.link if self.value_nodes else None
        return m.property


DeliveryFormat = Literal["csv", "json", "rdf"]


#: The id of a publishing target (TARGET_ID in TS); `default` is the seeded one.
DEFAULT_PUBLISH_TARGET = "default"
PublishTargetId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,39}$")]


class Delivery(_Model):
    #: What publishing delivers (absent: CSV and JSON).
    formats: list[DeliveryFormat] | None = Field(default=None, min_length=1)
    #: The publishing target to deliver to (absent: the default target).
    publish_to: PublishTargetId | None = Field(default=None, alias="publishTo")


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

    def repeating_section(self, step: FillingStep) -> Section | None:
        """The repeating section a step reads (validation allows at most one), or None."""
        by_id = {s.id: s for s in self.document.sections}
        return next((by_id[i] for i in step.sections if i in by_id and by_id[i].repeat), None)

    def extract_steps(self) -> list[ExtractStep]:
        return [s for s in self.pipeline if isinstance(s, ExtractStep)]

    def plugin_steps(self) -> list[PluginStep]:
        return [s for s in self.pipeline if isinstance(s, PluginStep)]

    def filling_steps(self) -> list[FillingStep]:
        """The steps that fill outputs (extract and plugin), in pipeline order."""
        return [s for s in self.pipeline if isinstance(s, ExtractStep | PluginStep)]

    def step_model(self, step: ExtractStep | PluginStep) -> str:
        """The model a step runs: its own, else the template's, else the default choice."""
        if step.model is not None and step.model != "default":
            return step.model
        return self.model or "default"

    def delivery_formats(self) -> list[DeliveryFormat]:
        """What publishing delivers (deliveryFormats in TS)."""
        if self.delivery and self.delivery.formats:
            return list(self.delivery.formats)
        return ["csv", "json"]

    def publish_to(self) -> str:
        """The publishing target id (`delivery.publishTo`, else `default`)."""
        if self.delivery and self.delivery.publish_to:
            return self.delivery.publish_to
        return DEFAULT_PUBLISH_TARGET

    def filler_of_field(self, field_id: str) -> FillingStep:
        return next(s for s in self.filling_steps() if field_id in s.fields)

    def filler_of_table(self, table_id: str) -> FillingStep:
        """The step creating the table's rows (not one enriching it)."""
        return next(s for s in self.filling_steps() if s.table == table_id and s.columns is None)

    def enriching_steps(self, table_id: str) -> list[FillingStep]:
        """The steps filling some columns of the table's rows, in pipeline order (P4)."""
        return [s for s in self.filling_steps() if s.table == table_id and s.columns is not None]

    def columns_of(self, step: FillingStep) -> set[str]:
        """The columns a table step fills: an enriching step's own, else (the creating step)
        every column no enriching step fills."""
        if step.table is None:
            return set()
        if step.columns is not None:
            return set(step.columns)
        enriched = {c for s in self.enriching_steps(step.table) for c in (s.columns or [])}
        return {c.id for c in self.table(step.table).columns} - enriched

    def filler_of_column(self, table_id: str, column_id: str) -> FillingStep:
        """The step filling one column: the step enriching the table with it, else the step
        creating the rows."""
        return next(
            (s for s in self.enriching_steps(table_id) if column_id in (s.columns or [])),
            None,
        ) or self.filler_of_table(table_id)

    def _resolve(self, path: str) -> tuple[str, ValueDef] | None:
        """`<field>` or `<table>.<column>` -> (engine path, definition)."""
        head, _, column = path.partition(".")
        if column:
            table = next((t for t in self.outputs.tables if t.id == head), None)
            col = next((c for c in table.columns if c.id == column), None) if table else None
            if table is None or col is None:
                return None
            suffix = "[*]" if col.type == "list" else ""
            return f"{self.filler_of_column(head, column).id}.rows[*].{column}{suffix}", col
        fld = next((f for f in self.outputs.fields if f.id == head), None)
        if fld is None:
            return None
        suffix = "[*]" if fld.type == "list" else ""
        return f"{self.filler_of_field(head).id}.{head}.value{suffix}", fld

    def _unknown_path(self, path: str) -> str:
        """Why `path` does not resolve, saying how to fix a bare table id (TS `unknownPath`)."""
        table = next((t for t in self.outputs.tables if t.id == path), None)
        if table is None:
            return f"unknown field or column {path!r}"
        columns = ", ".join(f"{path}.{c.id}" for c in table.columns)
        return (
            f"unknown field or column {path!r}: {path!r} is a table, "
            f"so name one of its columns: {columns}"
        )

    def compile_check(self, step: CheckStep) -> Check:
        if step.reference is None:
            raise ValueError(f"check {step.id!r} runs a plugin: it has no reference to compare")

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
        formats = list(self.delivery.formats or []) if self.delivery else []
        errors += [
            f"delivery: {f!r} is listed twice"
            for f in sorted({f for f in formats if formats.count(f) > 1})
        ]
        if "rdf" in formats and self.semantics is None:
            errors.append("delivery: rdf needs an ontology mapping (semantics)")
        semantics = self.semantics
        if semantics is None:
            return errors

        def mapping(label: str, value: ValueDef, m: OutputMapping) -> None:
            if m.object is not None and m.concepts is not None:
                errors.append(f"semantics: {label}: map it to an entity or to concepts, not both")
            if m.node is None and m.property is None:
                errors.append(f"semantics: {label}: a property is required")
            node = semantics.resolve_node(m)
            if node is not None:
                errors.extend(_node_errors(label, value, m, node))
            if value.type == "enum" and m.concepts is not None and m.concepts.values:
                errors.extend(
                    f"semantics: {label}: {v!r} is not one of its values"
                    for v in m.concepts.values
                    if v not in (value.enum or [])
                )

        fields = {f.id: f for f in self.outputs.fields}
        for fid, m in semantics.fields.items():
            if fid in fields:
                mapping(f"field {fid!r}", fields[fid], m)
            else:
                errors.append(f"semantics: unknown field {fid!r}")
        tables = {t.id: t for t in self.outputs.tables}
        for tid, tm in semantics.tables.items():
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

    def _repeat_errors(self, step: FillingStep) -> list[str]:
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

    def _enrich_errors(self, step: FillingStep) -> list[str]:
        """An enriching step's own rules (P4; TemplateSchema.superRefine in TS)."""
        if step.columns is None:
            return []
        errors: list[str] = []
        if step.table is None:
            errors.append(f"step {step.id!r}: columns needs a table")
        table = next((t for t in self.outputs.tables if t.id == step.table), None)
        if table is not None:
            known = {c.id for c in table.columns}
            errors += [
                f"step {step.id!r}: unknown column {c!r} of {step.table}"
                for c in step.columns
                if c not in known
            ]
        if isinstance(step, ExtractStep) and step.chunk_pages is not None:
            errors.append(f"step {step.id!r}: an enriching step cannot be chunked")
        if self.repeating_section(step) is not None:
            errors.append(f"step {step.id!r}: an enriching step cannot read a repeating section")
        if step.key_column is not None:
            errors.append(f"step {step.id!r}: keyColumn is for the step creating the rows")
        return errors

    def _column_errors(self, table_id: str) -> list[str]:
        """A table with one creating step and some enriching ones: every column is filled by
        exactly one step, and the rows exist before a step enriches them."""
        creator = self.filler_of_table(table_id)
        enrichers = self.enriching_steps(table_id)
        errors: list[str] = []
        named = [c for s in enrichers for c in (s.columns or [])]
        errors += [
            f"column '{table_id}.{c}' is filled by more than one step"
            for c in sorted({c for c in named if named.count(c) > 1})
        ]
        if all(c.id in named for c in self.table(table_id).columns):
            errors.append(
                f"step {creator.id!r} creates the rows of {table_id} but fills none of its columns"
            )
        order = {s.id: i for i, s in enumerate(self.pipeline)}
        errors += [
            f"step {e.id!r} enriches {table_id} before step {creator.id!r} creates its rows"
            for e in enrichers
            if order[e.id] < order[creator.id]
        ]
        return errors

    @model_validator(mode="after")
    def _consistency(self) -> Template:
        errors: list[str] = []
        field_ids = [f.id for f in self.outputs.fields]
        table_ids = [t.id for t in self.outputs.tables]
        step_ids = [s.id for s in self.pipeline]
        sections = {s.id: s for s in self.document.sections}
        section_ids = set(sections)

        for label, ids in (("output", field_ids + table_ids), ("step", step_ids)):
            errors += [
                f"duplicate {label} id {i!r}" for i in sorted({i for i in ids if ids.count(i) > 1})
            ]
        clashes = set(table_ids) | {s.id for s in self.pipeline if isinstance(s, CheckStep)}
        errors += [f"output id {i!r} is reserved" for i in sorted(clashes & RESERVED_OUTPUT_IDS)]

        fills: dict[str, int] = {}
        for step in self.filling_steps():
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
                if step.columns is None:
                    fills[step.table] = fills.get(step.table, 0) + 1
            errors += self._repeat_errors(step)
            errors += self._enrich_errors(step)
        for output_id in field_ids + table_ids:
            count = fills.get(output_id, 0)
            kind = "field" if output_id in field_ids else "table"
            enriched = kind == "table" and bool(self.enriching_steps(output_id))
            if count == 0 and enriched:
                errors.append(f"table {output_id!r} has no step creating its rows")
            elif count == 0:
                errors.append(f"{kind} {output_id!r} is not filled by any step")
            elif count > 1:
                errors.append(f"{kind} {output_id!r} is filled by more than one step")
            elif enriched:
                errors += self._column_errors(output_id)

        if not errors:  # context must come from steps that have already run
            order = {s.id: i for i, s in enumerate(self.pipeline)}
            for step in self.filling_steps():
                for name, path in step.context.items():
                    if self._resolve(path) is None:
                        errors.append(
                            f"step {step.id!r}: context {name!r}: {self._unknown_path(path)}"
                        )
                        continue
                    head, _, column = path.partition(".")
                    filler = (
                        self.filler_of_column(head, column)
                        if column
                        else self.filler_of_field(head)
                    )
                    if order[filler.id] >= order[step.id]:
                        errors.append(
                            f"step {step.id!r}: context {name!r} refers to {path!r}, which is "
                            "not filled by an earlier step"
                        )

        if not errors:  # path resolution needs a consistent template
            for check in self.pipeline:
                if isinstance(check, CheckStep):
                    # A plugin check resolves only its values.
                    paths = (check.values, check.reference, check.aliases)
                    for p in filter(None, paths if check.uses is None else paths[:1]):
                        if self._resolve(p) is None:
                            errors.append(f"check {check.id!r}: {self._unknown_path(p)}")
        errors += self._semantics_errors()
        if errors:
            raise ValueError("; ".join(errors))
        return self


# --- compiling extract steps -----------------------------------------------------------------


def _node_errors(label: str, value: ValueDef, m: OutputMapping, node: ResolvedNode) -> list[str]:
    """A value node's rules beyond the schema (TemplateSchema.superRefine in TS)."""
    errors: list[str] = []
    where = f"semantics: {label}"
    if m.object is not None or m.concepts is not None:
        errors.append(f"{where}: a value node cannot also be an entity or concepts")
    if node.link is None:
        errors.append(
            f"{where}: a value node needs a link: give its property or set "
            "semantics.valueNodes.link"
        )
    if node.value is None:
        errors.append(
            f"{where}: a value node needs a value property: give node.value or set "
            "semantics.valueNodes.value"
        )
    if node.unit is not None and node.unit_property is None:
        errors.append(
            f"{where}: a unit needs a unit property: give node.unitProperty or set "
            "semantics.valueNodes.unitProperty"
        )
    if value.type == "list":
        errors.append(
            f"{where}: a list cannot be a value node: map its items as literals, entities or "
            "concepts"
        )
    return errors


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
        own = template.columns_of(step)
        columns = [c for c in table.columns if c.id in own]
        row = {
            "type": "object",
            "additionalProperties": False,
            "required": [c.id for c in columns],
            "properties": {c.id: value_schema(c) for c in columns},
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
                "columns": [_definition(c) for c in columns],
            },
        }
        if step.columns is not None:  # enriching the table (P4): its rows, filled at run time
            context["enrich"] = {"count": 0, "rows": []}
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
