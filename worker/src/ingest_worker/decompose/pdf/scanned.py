"""A scanned page's transcription turned into pieces (spec section 15.3).

The OCR model's text has no positions, so it is laid out on a **synthetic text layer**: visible
chars placed in reading order below the page's bottom edge, where no real region of the page
reaches, with bold and italic in their fields and superscripts and subscripts smaller and off
the baseline, as pdfium gives them. Links become the page's link annotations, around their
chars. The pieces (headings, paragraphs, list items, tables with a synthetic grid of cells) are
made from those chars, so the reader's later stages (headings, lists, captions, ids, the page
map) treat them as they treat a born-digital page's. Blocks are spaced far enough apart that no
two paragraphs of one page are joined.

Pictures keep the layout service's real boxes and are cropped from the page. Each is matched to
the model's figure placeholder it overlaps most, whose alt text it takes (in reading order alone
when the OCR client turned the page). A display equation takes a picture region left unmatched
when there are exactly as many such regions as equations (Docling, its OCR off, reads an
equation on a scan as a picture); otherwise it stays as its LaTeX text, flagged. A region still
unmatched goes after the page's last block, and a placeholder unmatched is dropped; each kind of
mismatch is flagged on the page.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace

from ingest_worker.decompose.model import Flag
from ingest_worker.decompose.pdf.layout import BBox, LayoutCell, LayoutPicture, LayoutTable
from ingest_worker.decompose.pdf.pieces import Line, Piece
from ingest_worker.decompose.pdf.textlayer import Char, PageText
from ingest_worker.decompose.pdf.transcript import (
    PixelBox,
    Run,
    TxBlock,
    TxEquation,
    TxFigure,
    TxHeading,
    TxListItem,
    TxParagraph,
    TxTable,
)

_SIZE = 10.0
#: A superscript's or subscript's size, and how far its baseline is moved.
_SMALL = 7.0
_SHIFT = 3.0
_LINE = 14.0
#: Between two blocks: more than the builder's join gap, so no two paragraphs are joined.
_BLOCK_GAP = 3 * _LINE
#: A char's width, in ems.
_ADVANCE = 0.5
_MARGIN = 36.0
#: A list's indent per level, more than the builder's nesting step.
_INDENT = 18.0
#: A table column's width: the same for every scanned table, so continuations line up.
_COLUMN = 60.0
_CELL_PAD = 2.0
_FONT = "ocr"

#: A picture region covering this much of a scanned page is the scan itself, not a figure.
_WHOLE_PAGE = 0.8

#: At least this many scanned pages before a repeated first or last line is furniture.
_FURNITURE_PAGES = 3


@dataclass(frozen=True)
class RecognisedPage:
    #: The synthetic page: its visible chars and links; the real size and images.
    page: PageText
    #: In reading order, refs `s{page}-{n}`.
    pieces: list[Piece]
    #: `page_recognised`, and the page's mismatches; `at` a piece ref or None.
    flags: list[Flag]


def _run_text(runs: Sequence[Run]) -> str:
    return "".join(run[0] for run in runs)


def _block_text(block: TxBlock) -> str | None:
    if isinstance(block, TxHeading | TxParagraph):
        return _run_text(block.runs)
    return None


def normalise_levels(pages: Mapping[int, list[TxBlock]]) -> dict[int, list[TxBlock]]:
    """The headings' markdown levels moved up so the shallowest across all the scanned pages is
    level 1."""
    levels = [b.level for blocks in pages.values() for b in blocks if isinstance(b, TxHeading)]
    if not levels or min(levels) == 1:
        return {page: list(blocks) for page, blocks in pages.items()}
    shift = min(levels) - 1
    return {
        page: [replace(b, level=b.level - shift) if isinstance(b, TxHeading) else b for b in blocks]
        for page, blocks in pages.items()
    }


def _furniture_key(text: str) -> str:
    return " ".join(re.sub(r"\d", "#", text).lower().split())


def drop_scanned_furniture(
    pages: Mapping[int, list[TxBlock]],
) -> tuple[dict[int, list[TxBlock]], dict[int, int]]:
    """The pages without a first or last line that repeats (digits aside) on at least half of
    them, and per page how many lines were dropped. Fewer than three scanned pages: nothing is."""
    kept = {page: list(blocks) for page, blocks in pages.items()}
    if len(pages) < _FURNITURE_PAGES:
        return kept, {}
    edges: dict[int, set[int]] = {}
    for page, blocks in pages.items():
        edges[page] = {
            i for i in (0, len(blocks) - 1) if blocks and _block_text(blocks[i]) is not None
        }
    counts: Counter[str] = Counter()
    for page, blocks in pages.items():
        keys = {_furniture_key(_block_text(blocks[i]) or "") for i in edges[page]}
        counts.update(k for k in keys if k)
    needed = math.ceil(len(pages) / 2)
    repeated = {key for key, n in counts.items() if n >= needed}
    dropped: dict[int, int] = {}
    for page, blocks in pages.items():
        gone = {i for i in edges[page] if _furniture_key(_block_text(blocks[i]) or "") in repeated}
        if gone:
            kept[page] = [b for i, b in enumerate(blocks) if i not in gone]
            dropped[page] = len(gone)
    return kept, dropped


# --- The synthetic text layer --------------------------------------------------------------------


@dataclass(frozen=True)
class _Token:
    text: str
    marks: frozenset[str]
    href: str | None


def _words(runs: Sequence[Run]) -> list[list[_Token]]:
    """The runs' chars as words: a space ends a word."""
    words: list[list[_Token]] = []
    current: list[_Token] = []
    for text, marks, href in runs:
        for ch in text:
            if ch.isspace():
                if current:
                    words.append(current)
                    current = []
                continue
            current.append(_Token(ch, frozenset(marks), href))
    if current:
        words.append(current)
    return words


def _width(token: _Token) -> float:
    small = "superscript" in token.marks or "subscript" in token.marks
    return (_SMALL if small else _SIZE) * _ADVANCE


def _wrap(words: list[list[_Token]], width: float) -> list[list[list[_Token]]]:
    """The words in lines no wider than `width` (a longer word has a line of its own)."""
    space = _SIZE * _ADVANCE
    lines: list[list[list[_Token]]] = []
    current: list[list[_Token]] = []
    used = 0.0
    for word in words:
        w = sum(_width(t) for t in word)
        if current and used + space + w > width:
            lines.append(current)
            current, used = [], 0.0
        used += (space if current else 0.0) + w
        current.append(word)
    if current:
        lines.append(current)
    return lines


class _Writer:
    """Lays lines of text out below `page`, top to bottom."""

    def __init__(self, page: PageText) -> None:
        self.page = page
        self.chars: list[Char] = []
        self.links: list[tuple[BBox, str]] = []
        self.y = page.height + _BLOCK_GAP

    def line(self, words: list[list[_Token]], x0: float, y: float) -> Line:
        baseline = y + _SIZE * 0.8
        x = x0
        chars: list[Char] = []
        for n, word in enumerate(words):
            if n:
                x += _SIZE * _ADVANCE
            for k, token in enumerate(word):
                size, shift = _SIZE, 0.0
                if "superscript" in token.marks:
                    size, shift = _SMALL, -_SHIFT
                elif "subscript" in token.marks:
                    size, shift = _SMALL, _SHIFT
                b = baseline + shift
                w = size * _ADVANCE
                c = Char(
                    index=len(self.chars),
                    text=token.text,
                    font=_FONT,
                    size=size,
                    bold="bold" in token.marks,
                    italic="italic" in token.marks,
                    x0=x,
                    y0=b - size * 0.8,
                    x1=x + w,
                    y1=b + size * 0.2,
                    baseline=b,
                    visible=True,
                    space_before=n > 0 and k == 0,
                )
                self.chars.append(c)
                chars.append(c)
                x += w
        self._link_boxes(words, chars)
        return Line(self.page.index, tuple(chars), _union([_box(c) for c in chars]))

    def _link_boxes(self, words: list[list[_Token]], chars: list[Char]) -> None:
        tokens = [t for word in words for t in word]
        start = 0
        while start < len(tokens):
            href = tokens[start].href
            end = start + 1
            while end < len(tokens) and tokens[end].href == href:
                end += 1
            if href is not None:
                self.links.append((_union([_box(c) for c in chars[start:end]]), href))
            start = end

    def block(
        self, runs: Sequence[Run], *, x0: float = _MARGIN, lead: str | None = None
    ) -> list[Line]:
        """A block's lines, wrapped to the page's width, `lead` (a list marker) first."""
        words = _words(runs)
        if lead is not None:
            words.insert(0, [_Token(ch, frozenset(), None) for ch in lead])
        lines = []
        for wrapped in _wrap(words, max(self.page.width - _MARGIN - x0, _SIZE * 4)):
            lines.append(self.line(wrapped, x0, self.y))
            self.y += _LINE
        self.y += _BLOCK_GAP
        return lines

    def text_page(self) -> PageText:
        return replace(
            self.page,
            chars=tuple(self.chars),
            links=tuple(self.links),
            glyphs_left_out=0,
            recognised=True,
        )


def _box(c: Char) -> BBox:
    return (c.x0, c.y0, c.x1, c.y1)


def _union(boxes: Sequence[BBox]) -> BBox:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


# --- Matching figures and equations to regions ----------------------------------------------------


def _overlap(a: BBox, b: BBox) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def _points(box: PixelBox, page: PageText, render_px: tuple[int, int]) -> BBox:
    sx, sy = page.width / render_px[0], page.height / render_px[1]
    return (box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy)


def _match_figures(
    figures: list[TxFigure],
    regions: list[LayoutPicture],
    page: PageText,
    *,
    rotation: int,
    render_px: tuple[int, int],
) -> dict[int, LayoutPicture]:
    """Figure index -> its region: by overlap, or in reading order when the page was turned or
    a placeholder has no box."""
    matched: dict[int, LayoutPicture] = {}
    free = list(regions)
    if rotation % 360 == 0:
        pairs = []
        for i, figure in enumerate(figures):
            if figure.box is None:
                continue
            box = _points(figure.box, page, render_px)
            for k, region in enumerate(regions):
                area = _overlap(box, region.bbox)
                if area > 0:
                    pairs.append((area, i, k))
        taken: set[int] = set()
        for _, i, k in sorted(pairs, key=lambda p: (-p[0], p[1], p[2])):
            if i in matched or k in taken:
                continue
            matched[i] = regions[k]
            taken.add(k)
        free = [r for k, r in enumerate(regions) if k not in taken]
        order = [i for i, f in enumerate(figures) if f.box is None and i not in matched]
    else:
        order = list(range(len(figures)))
    for i, region in zip(order, list(free), strict=False):
        matched[i] = region
        free.remove(region)
    return matched


def _reading_order(region: LayoutPicture) -> tuple[float, float]:
    return (region.bbox[1], region.bbox[0])


# --- The page ------------------------------------------------------------------------------------


def _has_text(block: TxBlock) -> bool:
    if isinstance(block, TxHeading | TxParagraph | TxListItem):
        return bool(_run_text(block.runs).strip())
    if isinstance(block, TxTable):
        return any(cell.lines for cell in block.cells)
    return isinstance(block, TxEquation)


def recognise_page(
    original: PageText,
    blocks: list[TxBlock],
    regions: Sequence[LayoutPicture],
    *,
    rotation: int,
    render_px: tuple[int, int],
    left_out_words: int,
) -> RecognisedPage:
    """The scanned page `original` as pieces from its transcription's `blocks`, with the layout
    service's picture `regions` on it. `render_px` is the size of the image the OCR model was
    sent, in which its figure boxes are given; `left_out_words` the visible words over the scan
    the reader left out (spec 15.2)."""
    number = original.index + 1
    writer = _Writer(original)
    area = original.width * original.height
    ordered = sorted(
        (r for r in regions if area <= 0 or _overlap(r.bbox, r.bbox) < _WHOLE_PAGE * area),
        key=_reading_order,
    )
    figures = [b for b in blocks if isinstance(b, TxFigure)]
    matched = _match_figures(figures, ordered, original, rotation=rotation, render_px=render_px)
    used = {id(r) for r in matched.values()}
    unmatched = [r for r in ordered if id(r) not in used]
    equations = [b for b in blocks if isinstance(b, TxEquation)]
    equation_regions: dict[int, LayoutPicture] = {}
    if equations and len(unmatched) == len(equations):
        equation_regions = {id(eq): region for eq, region in zip(equations, unmatched, strict=True)}
        unmatched = []

    pieces: list[Piece] = []
    flags: list[Flag] = []
    lists = 0
    in_list = False

    def ref() -> str:
        return f"s{original.index}-{len(pieces)}"

    def text_piece(
        label: str, lines: list[Line], level: int | None = None, group: str | None = None
    ) -> Piece:
        box = _union([line.bbox for line in lines])
        return Piece(ref(), label, original.index, box, lines, level, group, recognised=True)

    figure_index = 0
    dropped_figures = 0
    for block in blocks:
        if not isinstance(block, TxListItem):
            in_list = False
        if isinstance(block, TxHeading):
            lines = writer.block(block.runs)
            if lines:
                pieces.append(text_piece("section_header", lines, level=block.level))
        elif isinstance(block, TxParagraph):
            lines = writer.block(block.runs)
            if lines:
                pieces.append(text_piece("text", lines))
        elif isinstance(block, TxListItem):
            if not in_list:
                lists += 1
                in_list = True
            marker = "•" if block.marker in ("-", "*", "+", "•") else block.marker
            lines = writer.block(block.runs, x0=_MARGIN + block.depth * _INDENT, lead=marker)
            if lines:
                pieces.append(
                    text_piece("list_item", lines, group=f"s{original.index}-list{lists}")
                )
        elif isinstance(block, TxTable):
            pieces.append(_table_piece(writer, block, ref()))
        elif isinstance(block, TxEquation):
            region = equation_regions.get(id(block))
            if region is not None:
                pieces.append(
                    Piece(
                        ref(),
                        "formula",
                        original.index,
                        region.bbox,
                        [],
                        None,
                        None,
                        recognised=True,
                        latex=block.latex,
                    )
                )
                continue
            lines = writer.block(((f"$${block.latex}$$", frozenset(), None),))
            piece = text_piece("text", lines)
            pieces.append(piece)
            flags.append(
                Flag(
                    code="structure_inferred",
                    severity="warning",
                    at=piece.ref,
                    message="Equation kept as its LaTeX text",
                )
            )
        else:  # TxFigure
            picture = matched.get(figure_index)
            figure_index += 1
            if picture is None:
                dropped_figures += 1
                continue
            pieces.append(_picture_piece(writer, picture, block.alt, ref()))
    for region in unmatched:
        pieces.append(_picture_piece(writer, region, "", ref()))

    message = f"page {number} was read by the OCR model"
    if not any(_has_text(b) for b in blocks):
        message += f"; page {number}: no text was recognised"
    if left_out_words:
        message += (
            f"; page {number}: {left_out_words} words of visible text over the scan were left out"
        )
    page_flags = [Flag(code="page_recognised", severity="warning", at=None, message=message)]
    if unmatched:
        page_flags.append(
            Flag(
                code="structure_inferred",
                severity="warning",
                at=None,
                message=(
                    f"page {number}: {_count(len(unmatched), 'picture')} the OCR model didn't "
                    "mention placed at the end of the page"
                ),
            )
        )
    if dropped_figures:
        page_flags.append(
            Flag(
                code="structure_inferred",
                severity="warning",
                at=None,
                message=(
                    f"page {number}: {_count(dropped_figures, 'figure')} the OCR model described "
                    "had no picture region and were left out"
                ),
            )
        )
    return RecognisedPage(writer.text_page(), pieces, [*page_flags, *flags])


def _count(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _picture_piece(writer: _Writer, region: LayoutPicture, alt: str, ref: str) -> Piece:
    """A picture with its real box; its alt text laid out as its lines (the builder's alt)."""
    lines = writer.block(((alt, frozenset(), None),)) if alt.strip() else []
    return Piece(
        ref,
        "picture",
        writer.page.index,
        region.bbox,
        lines,
        None,
        None,
        picture=region,
        recognised=True,
    )


def _table_piece(writer: _Writer, table: TxTable, ref: str) -> Piece:
    """The table on a synthetic grid of `_COLUMN`-wide columns, rows as tall as their text."""
    wrapped: dict[tuple[int, int], list[list[list[_Token]]]] = {}
    for cell in table.cells:
        width = cell.col_span * _COLUMN - 2 * _CELL_PAD
        lines: list[list[list[_Token]]] = []
        for runs in cell.lines:
            lines.extend(_wrap(_words(runs), width))
        wrapped[(cell.row, cell.col)] = lines
    heights = [_LINE] * table.rows
    for cell in table.cells:
        if cell.row_span == 1:
            need = max(1, len(wrapped[(cell.row, cell.col)])) * _LINE
            heights[cell.row] = max(heights[cell.row], need)
    tops = [writer.y]
    for h in heights:
        tops.append(tops[-1] + h)
    page = writer.page.index
    cells: list[LayoutCell] = []
    cell_lines: dict[tuple[int, int], list[Line]] = {}
    for cell in table.cells:
        x0 = _MARGIN + cell.col * _COLUMN
        x1 = x0 + cell.col_span * _COLUMN
        y0, y1 = tops[cell.row], tops[cell.row + cell.row_span]
        cells.append(
            LayoutCell(
                row=cell.row,
                col=cell.col,
                row_span=cell.row_span,
                col_span=cell.col_span,
                bbox=(x0, y0, x1, y1),
                header=cell.header,
            )
        )
        cell_lines[(cell.row, cell.col)] = [
            writer.line(words, x0 + _CELL_PAD, y0 + n * _LINE)
            for n, words in enumerate(wrapped[(cell.row, cell.col)])
        ]
    bbox = (_MARGIN, tops[0], _MARGIN + table.cols * _COLUMN, tops[-1])
    writer.y = tops[-1] + _BLOCK_GAP
    layout = LayoutTable(
        ref=ref,
        page=page,
        bbox=bbox,
        rows=table.rows,
        cols=table.cols,
        cells=tuple(cells),
        captions=(),
    )
    return Piece(
        ref, "table", page, bbox, [], None, None, table=layout, cells=cell_lines, recognised=True
    )
