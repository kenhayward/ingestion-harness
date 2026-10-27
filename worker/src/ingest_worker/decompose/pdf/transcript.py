"""A scanned page's transcription by the OCR model, parsed into blocks (spec section 15.3).

The model (olmOCR's prompt, `ingest_worker.ocr`) returns markdown after a YAML front matter:
headings, paragraphs, lists, HTML tables with their spans, LaTeX equations, and a placeholder
`![alt](page_x_y_w_h.png)` for each figure, its box in the rendered image's pixels. The text has
no positions; the blocks come in the model's reading order.

Inline, `**bold**`, `*italic*`, `<b>`, `<i>`, `<sup>` and `<sub>` become marks and `[text](url)`
a link; other tags are dropped and entities unescaped. A display equation (`$$...$$` or `\\[...\\]`
on its own lines) is a block; inline `$...$` stays text, so "$5 and $10" is never an equation.
Tables are read leniently: a cell not closed, a ragged row or a span past the edge still gives a
rectangular grid, its missing slots empty cells.
"""

from __future__ import annotations

import html
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Literal, Protocol

from ingest_worker.decompose.package import DecompositionFailed
from ingest_worker.ocr import split_front_matter

Mark = Literal["bold", "italic", "superscript", "subscript"]
#: A text run: its text, its marks and the href of the link it is in.
Run = tuple[str, frozenset[Mark], str | None]
#: x0, y0, x1, y1 in the rendered page image's pixels, top-left origin.
PixelBox = tuple[float, float, float, float]


@dataclass(frozen=True)
class Transcript:
    """One page as the OCR model transcribed it."""

    #: The model's raw output, front matter included.
    markdown: str
    #: Clockwise degrees the OCR client turned the page by before the transcription: 0, 90,
    #: 180 or 270.
    rotation: int = 0


class TranscriptionFailed(DecompositionFailed):
    """The OCR model refused a page, or can't be used for it (`at` names the page)."""


class PageTranscriber(Protocol):
    def transcribe(self, pages: Sequence[int]) -> Mapping[int, Transcript]:
        """The 0-based `pages` transcribed. Raises `TranscriptionFailed`, or a transient error
        (the job is retried)."""
        ...


@dataclass(frozen=True)
class TxHeading:
    level: int
    runs: tuple[Run, ...]
    #: A plain line read as a heading by its typed number (olmOCR writes no `#`); its level is
    #: the number's parts.
    typed: bool = False


@dataclass(frozen=True)
class TxParagraph:
    runs: tuple[Run, ...]


@dataclass(frozen=True)
class TxListItem:
    depth: int
    marker: str
    runs: tuple[Run, ...]


@dataclass(frozen=True)
class TxCell:
    row: int
    col: int
    row_span: int
    col_span: int
    header: bool
    lines: tuple[tuple[Run, ...], ...]


@dataclass(frozen=True)
class TxTable:
    rows: int
    cols: int
    cells: tuple[TxCell, ...]


@dataclass(frozen=True)
class TxEquation:
    latex: str


@dataclass(frozen=True)
class TxFigure:
    alt: str
    box: PixelBox | None


TxBlock = TxHeading | TxParagraph | TxListItem | TxTable | TxEquation | TxFigure

_TABLE = re.compile(r"<table\b.*?(?:</table\s*>|\Z)", re.DOTALL | re.IGNORECASE)
_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_ITEM = re.compile(r"^(\s*)([-*+•]|\d+[.)]|[a-zA-Z][.)])\s+(.*)$")
_PLACEHOLDER = re.compile(r"!\[([^\]]*)\]\(([^)]*)\)")
_PLACEHOLDER_BOX = re.compile(
    r"page_(\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)"
)
_DISPLAY_OPEN = {"$$": "$$", "\\[": "\\]"}


def parse_transcript(markdown: str) -> list[TxBlock]:
    """The page's blocks, in the model's order."""
    body, _ = split_front_matter(markdown)
    blocks: list[TxBlock] = []
    at = 0
    for match in _TABLE.finditer(body):
        blocks.extend(_text_blocks(body[at : match.start()]))
        table = _parse_table(match.group(0))
        if table is not None:
            blocks.append(table)
        at = match.end()
    blocks.extend(_text_blocks(body[at:]))
    return blocks


# --- Text blocks -------------------------------------------------------------------------------


def _text_blocks(text: str) -> list[TxBlock]:
    blocks: list[TxBlock] = []
    para: list[str] = []
    item: tuple[int, str, list[str]] | None = None
    figures: list[TxFigure] = []

    def flush() -> None:
        nonlocal item
        if para:
            runs = inline_runs(" ".join(para))
            if "".join(r[0] for r in runs).strip():
                blocks.append(TxParagraph(runs))
            para.clear()
        if item is not None:
            depth, marker, parts = item
            blocks.append(TxListItem(depth, marker, inline_runs(" ".join(parts))))
            item = None
        blocks.extend(figures)
        figures.clear()

    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        i += 1
        if not stripped:
            flush()
            continue
        opener = next((o for o in _DISPLAY_OPEN if stripped.startswith(o)), None)
        if opener is not None:
            found_equation = _display_equation(lines, i - 1, opener)
            if found_equation is not None:
                latex, i = found_equation
                flush()
                blocks.append(TxEquation(latex))
                continue
        found = [
            TxFigure(m.group(1).strip(), _pixel_box(m.group(2)))
            for m in _PLACEHOLDER.finditer(stripped)
        ]
        if found:
            stripped = _PLACEHOLDER.sub(" ", stripped).strip()
            line = _PLACEHOLDER.sub(" ", line)
            figures.extend(found)
            if not stripped:
                if not para and item is None:
                    flush()
                continue
        heading = _HEADING.match(stripped)
        if heading:
            flush()
            blocks.append(TxHeading(len(heading.group(1)), inline_runs(heading.group(2))))
            continue
        if CONTENTS_ENTRY.search(stripped):
            # a contents entry stays a line of its own, its spaced leader closed up, so the
            # reader's contents rule sees it (spec 4.3)
            flush()
            blocks.append(TxParagraph(inline_runs(_SPACED_LEADER.sub(_close_leader, stripped))))
            continue
        level = _typed_heading(stripped) if not para else None
        if level is not None and not _in_ordered_list(lines, i, stripped, item is not None):
            flush()
            blocks.append(TxHeading(level, inline_runs(stripped), typed=True))
            continue
        listed = _ITEM.match(line)
        if listed and not _is_number_only(listed.group(3)):
            flush()
            indent = len(listed.group(1).expandtabs(4))
            item = (indent // 2, listed.group(2), [listed.group(3)])
            continue
        if item is not None:
            if line[:1].isspace():
                item[2].append(stripped)
                continue
            flush()
        para.append(stripped)
    flush()
    return blocks


#: What may follow a display equation's closer on its line: punctuation, an equation number.
_EQUATION_TAIL = re.compile(r"[\s,.;:]*(?:\(\d+(?:\.\d+)*[a-z]?\))?[\s,.;:]*")


def _display_equation(lines: list[str], start: int, opener: str) -> tuple[str, int] | None:
    """The display equation opened on `lines[start]`, and the index of the line after it; or
    None when it is not one: its closer is followed by more than punctuation or an equation
    number (a reference "\\[1\\] Smith"), or no closer comes before a blank line or a heading.
    """
    closer = _DISPLAY_OPEN[opener]
    gathered: list[str] = []
    first = lines[start].strip()[len(opener) :]
    k = start
    text = first
    while True:
        at = text.find(closer)
        if at >= 0:
            if not _EQUATION_TAIL.fullmatch(text[at + len(closer) :]):
                return None
            gathered.append(text[:at])
            latex = "\n".join(part.strip() for part in gathered if part.strip())
            return (latex, k + 1) if latex else None
        gathered.append(text)
        k += 1
        if k >= len(lines) or not lines[k].strip() or _HEADING.match(lines[k].strip()):
            return None
        text = lines[k].strip()


#: A contents entry: a dot leader (or an ellipsis), then a page number, ending the line.
CONTENTS_ENTRY = re.compile(r"(?:\.{2,}|…|(?:\.\s+){2,}\.?)\s*\d{1,4}$")
_SPACED_LEADER = re.compile(r"\.(?:\s+\.){2,}")


def _close_leader(match: re.Match[str]) -> str:
    return "." * match.group(0).count(".")


#: A heading's typed number at the start of a line: "3.2.", "3.2" or "4", then a word.
_TYPED = re.compile(r"^(\d{1,3}(?:\.\d{1,3})*)\.?\s+(?=[^\d\s.])")
_ORDERED_ITEM = re.compile(r"^\d+[.)]\s")
#: A heading is at most this many words, and doesn't end like a sentence.
_HEADING_WORDS = 15
_SENTENCE_END = (".", ":", ";", ",", "?", "!")


def _typed_heading(line: str) -> int | None:
    """The level of `line` read as a numbered heading (spec 15.3): it starts with a typed number
    and is short, not ending like a sentence; None when it doesn't read as one."""
    match = _TYPED.match(line)
    if match is None or len(line.split()) > _HEADING_WORDS or line.endswith(_SENTENCE_END):
        return None
    return match.group(1).count(".") + 1


def _in_ordered_list(lines: list[str], i: int, line: str, after_item: bool) -> bool:
    """Whether `line`, a single-number line like "1. Weigh", sits in an ordered list: an item
    just before it, or one on the next line with text."""
    if not _ORDERED_ITEM.match(line):
        return False
    if after_item:
        return True
    following = next((n.strip() for n in lines[i:] if n.strip()), "")
    return bool(_ORDERED_ITEM.match(following))


def _is_number_only(text: str) -> bool:
    """ "2. 5" reads as a list item, "3.2 Scope" as a heading-like line: a marker must be
    followed by words, not by more of a number."""
    return bool(re.fullmatch(r"[\d.]+", text.strip()))


def _pixel_box(name: str) -> PixelBox | None:
    match = _PLACEHOLDER_BOX.search(name)
    if match is None:
        return None
    x, y, w, h = (float(g) for g in match.groups())
    return (x, y, x + w, y + h)


# --- Inline text ---------------------------------------------------------------------------------

_INLINE = re.compile(
    r"\\\(.+?\\\)|\*\*|\*|<(/?)(b|strong|i|em|sup|sub)\s*>|\[([^\]]*)\]\(([^)\s]*)\)|\$[^$\n]+\$|<[^>]*>",
    re.IGNORECASE,
)
_ESCAPE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!|<>])")
_TAG_MARK: dict[str, Mark] = {
    "b": "bold",
    "strong": "bold",
    "i": "italic",
    "em": "italic",
    "sup": "superscript",
    "sub": "subscript",
}


#: LaTeX symbols inline math is often made of, and the characters they stand for.
_MATH_SYMBOLS = (
    (r"^{\circ}", "°"),
    (r"^\circ", "°"),
    (r"\circ", "°"),
    (r"\degree", "°"),
    (r"\geq", "≥"),
    (r"\leq", "≤"),
    (r"\ge", "≥"),
    (r"\le", "≤"),
    (r"\pm", "±"),
    (r"\times", chr(0xD7)),
    (r"\cdot", "·"),
    (r"\approx", "≈"),
    (r"\sim", "~"),
    (r"\mu", "µ"),
    (r"\%", "%"),
    (r"\,", " "),
    (r"\ ", " "),
)


def _plain_math(latex: str) -> str | None:
    """`latex` as plain text when it is only text and the symbols of `_MATH_SYMBOLS`; else None
    (a real formula is kept as LaTeX)."""
    text = latex
    for command, char in _MATH_SYMBOLS:
        text = text.replace(command, char)
    if any(c in text for c in "\\^_{}"):
        return None
    return " ".join(text.split()) or None


def inline_runs(text: str) -> tuple[Run, ...]:
    """`text`'s runs: marks from emphasis and tags, links, entities unescaped."""
    stars = text.count("**")
    singles = text.count("*") - 2 * stars
    use_bold = stars % 2 == 0
    use_italic = singles % 2 == 0
    runs: list[Run] = []
    marks: set[Mark] = set()

    def add(piece: str, href: str | None = None, *, literal: bool = False) -> None:
        if not literal:
            piece = _ESCAPE.sub(r"\1", piece)
        piece = html.unescape(piece)
        if piece:
            runs.append((piece, frozenset(marks), href))

    at = 0
    for match in _INLINE.finditer(text):
        add(text[at : match.start()])
        at = match.end()
        token = match.group(0)
        if token == "**" and use_bold:
            marks.symmetric_difference_update({"bold"})
        elif token == "*" and use_italic:
            marks.symmetric_difference_update({"italic"})
        elif token in ("**", "*"):
            add(token, literal=True)
        elif match.group(2):
            mark = _TAG_MARK[match.group(2).lower()]
            if match.group(1):
                marks.discard(mark)
            else:
                marks.add(mark)
        elif match.group(3) is not None:
            add(match.group(3), match.group(4) or None)
        elif token.startswith(("$", "\\(")):
            # inline math: plain text when it is only symbols ("\\( \\geq 98\\% \\)" is
            # "≥ 98%"), else kept as written; "$5 and $" has no command and stays as it is
            inner = token[1:-1] if token.startswith("$") else token[2:-2]
            plain = _plain_math(inner) if "\\" in inner else None
            add(plain if plain is not None else token, literal=True)
        # any other tag is dropped
    add(text[at:])
    return _merged(runs)


def _merged(runs: list[Run]) -> tuple[Run, ...]:
    out: list[Run] = []
    for run in runs:
        if out and out[-1][1:] == run[1:]:
            out[-1] = (out[-1][0] + run[0], run[1], run[2])
        else:
            out.append(run)
    if out:  # no blank edges
        text, marks, href = out[0]
        out[0] = (text.lstrip(), marks, href)
        text, marks, href = out[-1]
        out[-1] = (text.rstrip(), marks, href)
    collapsed = [(re.sub(r"\s+", " ", t), m, h) for t, m, h in out]
    return tuple(r for r in collapsed if r[0])


# --- Tables --------------------------------------------------------------------------------------


@dataclass
class _RawCell:
    header: bool
    row_span: int
    col_span: int
    parts: list[str]


class _TableParser(HTMLParser):
    _INLINE_TAGS = frozenset(_TAG_MARK)

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.rows: list[list[_RawCell]] = []
        self.cell: _RawCell | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "tr":
            self.cell = None
            self.rows.append([])
        elif tag in ("td", "th"):
            if not self.rows:
                self.rows.append([])
            values = dict(attrs)
            self.cell = _RawCell(
                header=tag == "th",
                row_span=_span(values.get("rowspan")),
                col_span=_span(values.get("colspan")),
                parts=[],
            )
            self.rows[-1].append(self.cell)
        elif tag == "br" and self.cell is not None:
            self.cell.parts.append("\n")
        elif tag in self._INLINE_TAGS and self.cell is not None:
            self.cell.parts.append(f"<{tag}>")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in ("td", "th", "tr"):
            self.cell = None
        elif tag in self._INLINE_TAGS and self.cell is not None:
            self.cell.parts.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if self.cell is not None:
            self.cell.parts.append(data.replace("\n", " "))

    def handle_entityref(self, name: str) -> None:
        self.handle_data(f"&{name};")

    def handle_charref(self, name: str) -> None:
        self.handle_data(f"&#{name};")


def _span(value: str | None) -> int:
    try:
        return max(1, int(value or "1"))
    except ValueError:
        return 1


def _width(raw_rows: list[list[_RawCell]], rows: int) -> int:
    held: set[tuple[int, int]] = set()
    width = 0
    for r, row in enumerate(raw_rows):
        col = 0
        for cell in row:
            while (r, col) in held:
                col += 1
            for rr in range(r, min(r + cell.row_span, rows)):
                held.add((rr, col))
            col += 1
        width = max(width, col, max((k + 1 for rr, k in held if rr == r), default=0))
    return max(width, 1)


def _parse_table(markup: str) -> TxTable | None:
    parser = _TableParser()
    parser.feed(markup)
    parser.close()
    raw_rows = [row for row in parser.rows if row]
    if not raw_rows:
        return None
    rows = len(raw_rows)
    # The width: the widest row with its row spans held, a column span counted as one; spans
    # then widen nothing past it, so a stray colspan="9" doesn't make nine columns.
    base = _width(raw_rows, rows)
    occupied: set[tuple[int, int]] = set()
    placed: list[tuple[int, int, int, int, _RawCell]] = []
    for r, row in enumerate(raw_rows):
        col = 0
        for cell in row:
            while (r, col) in occupied:
                col += 1
            if col >= base:  # no room: its text goes to the row's last cell
                if placed and placed[-1][0] == r:
                    placed[-1][4].parts.extend([" ", *cell.parts])
                continue
            col_span = min(cell.col_span, base - col)
            while any((r, k) in occupied for k in range(col, col + col_span)):
                col_span -= 1
            row_span = min(cell.row_span, rows - r)
            for rr in range(r, r + row_span):
                for k in range(col, col + col_span):
                    occupied.add((rr, k))
            placed.append((r, col, row_span, col_span, cell))
            col += col_span
    cells = [
        TxCell(
            row=r,
            col=c,
            row_span=rs,
            col_span=cs,
            header=cell.header,
            lines=tuple(
                inline_runs(line) for line in "".join(cell.parts).split("\n") if line.strip()
            ),
        )
        for r, c, rs, cs, cell in placed
    ]
    for r in range(rows):
        for c in range(base):
            if (r, c) not in occupied:
                cells.append(TxCell(r, c, 1, 1, False, ()))
    cells.sort(key=lambda cell: (cell.row, cell.col))
    return TxTable(rows=rows, cols=base, cells=tuple(cells))
