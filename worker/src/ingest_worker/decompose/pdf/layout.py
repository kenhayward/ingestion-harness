"""The layout service's client, and the typed subset of Docling's document JSON the reader uses.

The service (`deploy/layout`, Docling in its own container) answers `POST /layout` with
`{"pages": n, "document": <Docling export_to_dict>}`. `HttpLayoutAnalyser.analyse` returns the
`document`, renumbered so its first page is page 1 whatever range was asked for (Docling keeps
the PDF's own numbers); `parse_docling` turns it into `LayoutDoc`: items in Docling's reading
order with groups flattened, boxes in points with a top-left origin, pages 0-based.
"""

from __future__ import annotations

import io
import logging
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from typing import Any, Literal, Protocol, TypeVar

import httpx
from pypdf import PdfReader, PdfWriter
from pypdf.errors import PyPdfError
from pypdf.generic import RectangleObject

from ingest_worker.decompose.package import DecompositionRejected

log = logging.getLogger(__name__)
T = TypeVar("T")

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
    #: Docling's label: `table`, or `document_index` for a table of contents.
    label: str = "table"
    #: Read from a picture's ruling lines (drawn.py), not Docling's table structure.
    ruled: bool = False


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


def parse_docling(
    doc: Mapping[str, Any], *, page_offset: int = 0, ref_prefix: str = ""
) -> LayoutDoc:
    """Docling's `export_to_dict` as `LayoutDoc`; `page_offset` shifts the 0-based pages and
    `ref_prefix` is put before every item and group ref (each chunk numbers its refs from 0).

    Raises `DecompositionRejected` when a node lacks what the reader needs, or holds something
    of the wrong kind."""
    try:
        return _Parser(doc, page_offset, ref_prefix).parse()
    except (KeyError, ValueError, TypeError, AttributeError) as error:
        raise DecompositionRejected(
            f"layout response malformed: {type(error).__name__} {error}"
        ) from error


class _Parser:
    def __init__(self, doc: Mapping[str, Any], page_offset: int, ref_prefix: str) -> None:
        self._doc = doc
        self._offset = page_offset
        self._prefix = ref_prefix
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
            self._walk(node.get("children") or [], self._prefix + ref if is_group else group)

    def _item(self, ref: str, node: Mapping[str, Any], group: str | None) -> LayoutItem | None:
        prov = node.get("prov") or []
        if not prov:
            return None
        number = int(prov[0]["page_no"])
        page = number - 1 + self._offset
        bbox = self._box(prov[0]["bbox"], number)
        kind = ref.split("/")[1]
        ref = self._prefix + ref
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
                str(node.get("label") or "table"),
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
        self.timeout_s = timeout_s
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


class FallbackLayoutAnalyser:
    """A layout service (the GPU one) with another (the CPU one) behind it. A document is read by
    one of them from its first page to its last: if the primary is unavailable part way, the
    document is read again on the fallback, and the primary is left alone for `cooldown_s`. A
    document the primary refuses (`DecompositionRejected`) is not retried: the fallback would
    refuse it too."""

    def __init__(
        self,
        primary: LayoutAnalyser,
        fallback: LayoutAnalyser,
        *,
        cooldown_s: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.primary, self.fallback = primary, fallback
        self._cooldown_s, self._clock = cooldown_s, clock
        self._down_until = 0.0

    def run(self, work: Callable[[LayoutAnalyser], T]) -> T:
        """`work` on the primary, or on the fallback if the primary is (or turns out) down."""
        if self._clock() >= self._down_until:
            try:
                return work(self.primary)
            except LayoutUnavailable as exc:
                self._down_until = self._clock() + self._cooldown_s
                log.warning("layout: primary unavailable (%s); using the fallback", exc)
        return work(self.fallback)

    def analyse(self, pdf: bytes, first: int, last: int) -> Mapping[str, Any]:
        return self.run(lambda analyser: analyser.analyse(pdf, first, last))

    def fingerprint(self) -> str:
        return self.run(lambda analyser: analyser.fingerprint())


#: How long the primary of a `FallbackLayoutAnalyser` may take over one request.
PRIMARY_TIMEOUT_S = 120.0


def layout_analyser(url: str | None, fallback_url: str | None) -> LayoutAnalyser | None:
    """The worker's analyser from `LAYOUT_URL` and `LAYOUT_FALLBACK_URL`; None: neither is set."""
    urls = [u for u in (url, fallback_url) if u]
    if not urls:
        return None
    if len(urls) == 1:
        return HttpLayoutAnalyser(urls[0])
    # The GPU reads a 20-page chunk in under 10 s: a primary taking 2 minutes is hung, and the
    # document is read on the fallback (which keeps the CPU's 10 minutes).
    return FallbackLayoutAnalyser(
        HttpLayoutAnalyser(urls[0], timeout_s=PRIMARY_TIMEOUT_S), HttpLayoutAnalyser(urls[1])
    )


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
    analyser: LayoutAnalyser,
    pdf: bytes,
    page_count: int,
    *,
    chunk: int = 20,
    margins: Mapping[int, float] | None = None,
) -> LayoutDoc:
    """The whole document, analysed `chunk` pages at a time and joined in page order; each page
    in `margins` (0-based) is sent without its left margin up to that x (`without_margins`).
    Behind a `FallbackLayoutAnalyser`, one service reads every chunk."""
    pdf, cut = without_margins(pdf, margins or {})

    def chunks(one: LayoutAnalyser) -> list[LayoutItem]:
        items: list[LayoutItem] = []
        for first in range(1, page_count + 1, chunk):
            last = min(first + chunk - 1, page_count)
            # Every chunk numbers its refs from 0: those after the first are prefixed to stay
            # unique.
            prefix = "" if first == 1 else f"p{first}:"
            doc = one.analyse(pdf, first, last)
            items.extend(parse_docling(doc, page_offset=first - 1, ref_prefix=prefix).items)
        return items

    items = (
        analyser.run(chunks) if isinstance(analyser, FallbackLayoutAnalyser) else chunks(analyser)
    )
    return LayoutDoc(
        tuple(_moved(item, cut[item.page]) if item.page in cut else item for item in items)
    )


def without_margins(pdf: bytes, margins: Mapping[int, float]) -> tuple[bytes, dict[int, float]]:
    """The PDF with the left of each page in `margins` cropped off up to that x (points from the
    left of the page as displayed), and the margins it was cropped by: an upright page's only.
    A PDF pypdf can't rewrite is sent whole."""
    if not margins:
        return pdf, {}
    try:
        writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf)))
        cut: dict[int, float] = {}
        for index, x in sorted(margins.items()):
            page = writer.pages[index]
            if page.rotation % 360:
                continue
            box = page.cropbox
            cropped = RectangleObject([float(box.left) + x, box.bottom, box.right, box.top])
            page.cropbox = page.mediabox = cropped
            cut[index] = x
        if not cut:
            return pdf, {}
        out = io.BytesIO()
        writer.write(out)
    except (PyPdfError, ValueError, KeyError, IndexError):
        return pdf, {}
    return out.getvalue(), cut


def _moved(item: LayoutItem, dx: float) -> LayoutItem:
    """The item of a page cropped by `dx` on the left, in the whole page's coordinates."""

    def box(b: BBox) -> BBox:
        return (b[0] + dx, b[1], b[2] + dx, b[3])

    if isinstance(item, LayoutTable):
        cells = tuple(replace(c, bbox=box(c.bbox)) if c.bbox is not None else c for c in item.cells)
        return replace(item, bbox=box(item.bbox), cells=cells)
    return replace(item, bbox=box(item.bbox))
