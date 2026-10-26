"""The layout service's client, and the typed subset of Docling's document JSON the reader uses.

The service (`deploy/layout`, Docling in its own container) answers `POST /layout` with
`{"pages": n, "document": <Docling export_to_dict>}`. `HttpLayoutAnalyser.analyse` returns the
`document`, renumbered so its first page is page 1 whatever range was asked for (Docling keeps
the PDF's own numbers); `parse_docling` turns it into `LayoutDoc`: items in Docling's reading
order with groups flattened, boxes in points with a top-left origin, pages 0-based.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx

from ingest_worker.decompose.package import DecompositionRejected

#: x0, y0, x1, y1 in points, top-left origin (y0 < y1).
BBox = tuple[float, float, float, float]


@dataclass(frozen=True)
class LayoutText:
    ref: str
    #: Docling's label (`text`, `section_header`, `title`, `list_item`, `caption`, `footnote`,
    #: `page_header`, `page_footer`, `formula`, `document_index`, ...); unknown ones are `text`.
    label: str
    page: int
    bbox: BBox
    level: int | None
    layer: Literal["body", "furniture"]
    #: The ref of the Docling group this item sits in (a list, say), if any.
    group: str | None


@dataclass(frozen=True)
class LayoutCell:
    row: int
    col: int
    row_span: int
    col_span: int
    bbox: BBox | None
    header: bool


@dataclass(frozen=True)
class LayoutTable:
    ref: str
    page: int
    bbox: BBox
    rows: int
    cols: int
    cells: tuple[LayoutCell, ...]
    captions: tuple[str, ...]


@dataclass(frozen=True)
class LayoutPicture:
    ref: str
    page: int
    bbox: BBox
    captions: tuple[str, ...]


LayoutItem = LayoutText | LayoutTable | LayoutPicture


@dataclass(frozen=True)
class LayoutDoc:
    items: tuple[LayoutItem, ...]


#: Labels the reader tells apart; every other label parses as `text`.
_LABELS = frozenset(
    {
        "text",
        "section_header",
        "title",
        "list_item",
        "caption",
        "footnote",
        "page_header",
        "page_footer",
        "formula",
        "document_index",
        "code",
        "paragraph",
        "reference",
        "checkbox_selected",
        "checkbox_unselected",
    }
)


def parse_docling(doc: Mapping[str, Any], *, page_offset: int = 0) -> LayoutDoc:
    """Docling's `export_to_dict` as `LayoutDoc`; `page_offset` shifts the 0-based pages."""
    return _Parser(doc, page_offset).parse()


class _Parser:
    def __init__(self, doc: Mapping[str, Any], page_offset: int) -> None:
        self._doc = doc
        self._offset = page_offset
        self._heights = {
            int(number): float(page["size"]["height"])
            for number, page in (doc.get("pages") or {}).items()
        }
        self._seen: set[str] = set()
        self._items: list[LayoutItem] = []

    def parse(self) -> LayoutDoc:
        for root in ("body", "furniture"):
            node = self._doc.get(root)
            if node:
                self._walk(node.get("children") or [], group=None)
        return LayoutDoc(tuple(self._items))

    def _resolve(self, ref: str) -> Mapping[str, Any] | None:
        parts = ref.lstrip("#/").split("/")
        if len(parts) != 2 or not parts[1].isdigit():
            return None
        try:
            node: Mapping[str, Any] = self._doc[parts[0]][int(parts[1])]
        except (KeyError, IndexError):
            return None
        return node

    def _walk(self, children: list[Mapping[str, str]], group: str | None) -> None:
        for child in children:
            ref = child.get("$ref", "")
            node = self._resolve(ref)
            if node is None or ref in self._seen:
                continue
            self._seen.add(ref)
            is_group = ref.startswith("#/groups/")
            if not is_group:
                item = self._item(ref, node, group)
                if item is not None:
                    self._items.append(item)
            self._walk(node.get("children") or [], ref if is_group else group)

    def _item(self, ref: str, node: Mapping[str, Any], group: str | None) -> LayoutItem | None:
        prov = node.get("prov") or []
        if not prov:
            return None
        number = int(prov[0]["page_no"])
        page = number - 1 + self._offset
        bbox = self._box(prov[0]["bbox"], number)
        kind = ref.split("/")[1]
        if kind == "tables":
            data = node.get("data") or {}
            cells = tuple(self._cell(c, number) for c in data.get("table_cells") or [])
            return LayoutTable(
                ref,
                page,
                bbox,
                int(data.get("num_rows", 0)),
                int(data.get("num_cols", 0)),
                cells,
                self._captions(node),
            )
        if kind == "pictures":
            return LayoutPicture(ref, page, bbox, self._captions(node))
        label = node.get("label", "text")
        level = node.get("level")
        return LayoutText(
            ref,
            label if label in _LABELS else "text",
            page,
            bbox,
            int(level) if level is not None else None,
            "furniture" if node.get("content_layer") == "furniture" else "body",
            group,
        )

    def _box(self, box: Mapping[str, Any], page_no: int) -> BBox:
        left, right = float(box["l"]), float(box["r"])
        top, bottom = float(box["t"]), float(box["b"])
        # Docling's page boxes are bottom-left; its table cells are top-left. Each says which.
        if str(box.get("coord_origin", "TOPLEFT")).upper() == "BOTTOMLEFT":
            try:
                height = self._heights[page_no]
            except KeyError:
                raise DecompositionRejected(
                    f"layout response lacks the size of page {page_no}"
                ) from None
            top, bottom = height - top, height - bottom
        return (min(left, right), min(top, bottom), max(left, right), max(top, bottom))

    def _cell(self, cell: Mapping[str, Any], page_no: int) -> LayoutCell:
        box = cell.get("bbox")
        return LayoutCell(
            int(cell["start_row_offset_idx"]),
            int(cell["start_col_offset_idx"]),
            int(cell.get("row_span", 1)),
            int(cell.get("col_span", 1)),
            self._box(box, page_no) if box else None,
            bool(cell.get("column_header") or cell.get("row_header")),
        )

    def _captions(self, node: Mapping[str, Any]) -> tuple[str, ...]:
        texts = []
        for ref in node.get("captions") or []:
            target = self._resolve(ref.get("$ref", ""))
            if target is not None and target.get("text"):
                texts.append(str(target["text"]))
        return tuple(texts)


class LayoutUnavailable(Exception):
    """The layout service is down, busy or slow: transient, so the job is retried."""


class LayoutAnalyser(Protocol):
    def analyse(self, pdf: bytes, first: int, last: int) -> Mapping[str, Any]:
        """Docling's document dict for pages `first`..`last` (1-based, inclusive), numbered from 1."""
        ...

    def fingerprint(self) -> str:
        """Identifies the service's models and options: part of the layout cache key."""
        ...


class HttpLayoutAnalyser:
    """The layout service over HTTP (`POST /layout`, `GET /health`)."""

    def __init__(
        self, base_url: str, client: httpx.Client | None = None, timeout_s: float = 600.0
    ) -> None:
        self._base = base_url.rstrip("/")
        self._client = client or httpx.Client(timeout=timeout_s)
        self._fingerprint: str | None = None

    def analyse(self, pdf: bytes, first: int, last: int) -> Mapping[str, Any]:
        try:
            response = self._client.post(
                f"{self._base}/layout",
                files={"file": ("document.pdf", pdf, "application/pdf")},
                data={"first": str(first), "last": str(last)},
            )
        except httpx.HTTPError as exc:
            raise LayoutUnavailable(f"layout service unreachable: {exc}") from exc
        status = response.status_code
        if 400 <= status < 500:
            raise DecompositionRejected(f"layout service refused the document: {_detail(response)}")
        if status != 200:
            raise LayoutUnavailable(f"layout service error {status}: {_detail(response)}")
        try:
            document = response.json()["document"]
        except (ValueError, KeyError, TypeError) as exc:
            raise LayoutUnavailable("layout service returned no document") from exc
        if not isinstance(document, dict):
            raise LayoutUnavailable("layout service returned no document")
        return _renumbered(document, first - 1)

    def fingerprint(self) -> str:
        if self._fingerprint is None:
            try:
                response = self._client.get(f"{self._base}/health")
                response.raise_for_status()
                self._fingerprint = str(response.json()["fingerprint"])
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
                raise LayoutUnavailable(f"layout service unreachable: {exc}") from exc
        return self._fingerprint


def _renumbered(document: dict[str, Any], shift: int) -> dict[str, Any]:
    """The document with its page numbers lowered by `shift` (Docling keeps the PDF's own)."""
    if shift == 0:
        return document
    pages = document.get("pages") or {}
    document["pages"] = {
        str(int(number) - shift): {**page, "page_no": int(page.get("page_no", number)) - shift}
        for number, page in pages.items()
    }
    for key in ("texts", "tables", "pictures", "key_value_items", "form_items"):
        for node in document.get(key) or []:
            for prov in node.get("prov") or []:
                prov["page_no"] = int(prov["page_no"]) - shift
    return document


def _detail(response: httpx.Response) -> str:
    text = response.content[:300].decode("utf-8", errors="replace").strip()
    try:
        body = response.json()
    except ValueError:
        return text
    if isinstance(body, dict):
        for key in ("error", "detail"):
            if body.get(key):
                return str(body[key])
    return text


def analyse_document(
    analyser: LayoutAnalyser, pdf: bytes, page_count: int, *, chunk: int = 20
) -> LayoutDoc:
    """The whole document, analysed `chunk` pages at a time and joined in page order."""
    items: list[LayoutItem] = []
    for first in range(1, page_count + 1, chunk):
        last = min(first + chunk - 1, page_count)
        items.extend(parse_docling(analyser.analyse(pdf, first, last), page_offset=first - 1).items)
    return LayoutDoc(tuple(items))
