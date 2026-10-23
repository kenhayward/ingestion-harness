"""The decomposed document: a checked, source-neutral tree of sections, blocks and inlines."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

Marks = frozenset[Literal["bold", "italic", "underline", "superscript", "subscript"]]

FlagCode = Literal[
    "changes_accepted",
    "symbol_unmapped",
    "heading_skipped_level",
    "heading_empty",
    "caption_not_found",
    "table_notes_unrecognised",
    "xref_unmatched",
    "image_floating_anchored",
    "image_converted",
    "drawing_rendered",
    "equation_image_only",
    "structure_inferred",
    "page_recognised",
]


class _Model(BaseModel):
    """camelCase on the wire, like the rest of the contract; snake_case names are accepted too."""

    model_config = ConfigDict(
        extra="forbid", frozen=True, alias_generator=to_camel, populate_by_name=True
    )


# --- Inlines ---------------------------------------------------------------------------------


class Text(_Model):
    kind: Literal["text"] = "text"
    text: str
    marks: Marks = frozenset()


class NoteRef(_Model):
    kind: Literal["note_ref"] = "note_ref"
    note_id: str


class XRef(_Model):
    kind: Literal["xref"] = "xref"
    target_id: str
    text: str


class Link(_Model):
    kind: Literal["link"] = "link"
    href: str
    inlines: list[Inline]


class InlineEquation(_Model):
    kind: Literal["inline_equation"] = "inline_equation"
    equation_id: str


class InlineImage(_Model):
    kind: Literal["inline_image"] = "inline_image"
    image_id: str


class Break(_Model):
    kind: Literal["break"] = "break"


Inline = Annotated[
    Text | NoteRef | XRef | Link | InlineEquation | InlineImage | Break,
    Field(discriminator="kind"),
]


# --- Blocks ----------------------------------------------------------------------------------


class Paragraph(_Model):
    kind: Literal["paragraph"] = "paragraph"
    id: str
    inlines: list[Inline]


class ListItem(_Model):
    blocks: list[Block]


class ListBlock(_Model):
    kind: Literal["list"] = "list"
    id: str
    ordered: bool
    items: list[ListItem]


class Cell(_Model):
    row_span: int = 1
    col_span: int = 1
    h_align: Literal["left", "center", "right", "justify"] = "left"
    v_align: Literal["top", "middle", "bottom"] = "top"
    header: bool = False
    blocks: list[Block]


class Row(_Model):
    cells: list[Cell]


class TableNote(_Model):
    marker: str
    inlines: list[Inline]


class Table(_Model):
    kind: Literal["table"] = "table"
    id: str
    numbered: bool = False
    caption: list[Inline] = Field(default_factory=list)
    caption_position: Literal["above", "below"] = "above"
    column_widths: list[float]
    header_rows: int
    rows: list[Row]
    notes: list[TableNote] = Field(default_factory=list)
    wide: bool = False
    key: str | None = None


class Figure(_Model):
    kind: Literal["figure"] = "figure"
    id: str
    image_id: str
    numbered: bool
    caption: list[Inline]
    caption_position: Literal["above", "below"]


class EquationBlock(_Model):
    kind: Literal["equation"] = "equation"
    id: str
    equation_id: str


class ImageBlock(_Model):
    kind: Literal["image"] = "image"
    id: str
    image_id: str


Block = Annotated[
    Paragraph | ListBlock | Table | Figure | EquationBlock | ImageBlock,
    Field(discriminator="kind"),
]


# --- Document --------------------------------------------------------------------------------


class Section(_Model):
    id: str
    title: list[Inline]
    blocks: list[Block]
    sections: list[Section]


class Image(_Model):
    id: str
    content_type: Literal["image/png", "image/jpeg", "image/svg+xml"]
    width_mm: float
    height_mm: float
    align: Literal["left", "center", "right", "inline"]
    alt: str | None = None
    origin: Literal["embedded", "converted", "rendered", "cropped"]
    original_content_type: str | None = None


class Equation(_Model):
    id: str
    mathml: str | None = None
    latex: str | None = None
    image_id: str


class Note(_Model):
    id: str
    blocks: list[Block]


class Property(_Model):
    name: str
    value: str
    origin: Literal["core", "custom", "header-field", "pdf-info"]


class Flag(_Model):
    code: FlagCode
    severity: Literal["info", "warning"]
    at: str | None = None
    message: str


class DecomposedDocument(_Model):
    blocks: list[Block]
    sections: list[Section]
    images: list[Image]
    equations: list[Equation]
    notes: list[Note]
    properties: list[Property]
    report: list[Flag]


for _m in (
    Link,
    ListItem,
    ListBlock,
    Cell,
    Row,
    TableNote,
    Table,
    Figure,
    Paragraph,
    Section,
    Note,
):
    _m.model_rebuild()
DecomposedDocument.model_rebuild()
