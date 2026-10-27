"""How well a PDF's reading matches the Word reading of the same document (spec section 7).

The Word decomposition is the truth, the PDF's decomposition of the converted twin is the
reading under test. Three things are compared:

- headings, keyed by title (lower case, whitespace removed) and aligned as sequences; a
  heading's level is its depth in the section tree;
- tables, through their grid forms; each truth table is paired with the best of the next few
  unpaired PDF tables, and the shape and the cells are compared;
- words, as the PDF fidelity check reads them, with the text form's tokens left out.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher

from ingest_worker.decompose.forms import _Forms, grid_forms, tables_of, text_form
from ingest_worker.decompose.model import DecomposedDocument, Row, Section, Table
from ingest_worker.decompose.pdf.fidelity import words

#: A truth table is paired with the best of this many next unpaired PDF tables.
PAIRING_WINDOW = 4
#: The least cell-text overlap (Jaccard) that pairs two tables.
PAIRING_MIN_JACCARD = 0.3

#: A note row's text: a marker, then a separator or just whitespace, then the note.
_NOTE_ROW = re.compile(r"^\s*([a-z]|\d{1,2}|[*†‡§])(\s*[:.)]\s*|\s+)\S")
_TOKEN = re.compile(r"⟦[^⟧]*⟧")


@dataclass(frozen=True)
class Score:
    headings_total: int
    headings_found: int
    levels_right: int
    tables_total: int
    tables_found: int
    shape_right: int
    cells_total: int
    cells_right: int
    #: None when undefined: the truth has no words (recall), or the PDF has none (precision).
    words_recall: float | None
    words_precision: float | None
    #: The truth's word count: the weight of the word rates in `total`.
    words_total: int = 0
    #: PDF tables that no truth table was paired with.
    tables_extra: int = 0


def _squash(text: str) -> str:
    """The text as the word comparison reads it (ligatures, U+2011), tokens and whitespace out."""
    return "".join(words(_TOKEN.sub(" ", text)))


def _key(text: str) -> str:
    return _squash(text).lower()


def _headings(doc: DecomposedDocument) -> list[tuple[str, int]]:
    forms = _Forms(doc)
    found: list[tuple[str, int]] = []

    def walk(s: Section, depth: int) -> None:
        found.append((_key(forms.inline_text(s.title)), depth))
        for sub in s.sections:
            walk(sub, depth + 1)

    for s in doc.sections:
        walk(s, 0)
    return found


def _text(slot: str) -> str:
    """A grid slot's text, whitespace removed."""
    return _squash(slot.partition("|")[2])


def _cells(grid: list[list[str]]) -> dict[tuple[int, int], str]:
    """The cells of a grid by the position they start at, their text with whitespace removed."""
    cells: dict[tuple[int, int], str] = {}
    for row in grid:
        for slot in row:
            if not slot:
                continue
            r, c = (int(n) for n in slot.partition("|")[0].split(","))
            cells.setdefault((r, c), _text(slot))
    return cells


def _is_note_row(row: Row, slots: list[str], width: int) -> bool:
    """A row of one cell that spans the whole width, its text starting with a note marker, then
    a separator or just whitespace. Tables one slot wide are never stripped (conservative: their
    last row is as likely data), and a row with other, even empty, cells is kept."""
    if width < 2 or len(row.cells) != 1 or len(set(slots)) != 1 or not slots[0]:
        return False
    cell = row.cells[0]
    return (
        cell.col_span >= width
        and cell.row_span == 1
        and _NOTE_ROW.match(slots[0].partition("|")[2]) is not None
    )


def _without_notes(table: Table, grid: list[list[str]]) -> list[list[str]]:
    """The grid without its last rows that read as notes."""
    rows = list(grid)
    width = max(map(len, grid), default=0)
    count = len(table.rows)
    while rows and len(rows) == count and _is_note_row(table.rows[count - 1], rows[-1], width):
        rows.pop()
        count -= 1
    return rows


def _jaccard(a: Counter[str], b: Counter[str]) -> float:
    union = sum((a | b).values())
    return sum((a & b).values()) / union if union else 0.0


def _word_list(doc: DecomposedDocument) -> list[str]:
    return [w for unit in text_form(doc) for w in words(_TOKEN.sub(" ", unit))]


def score(truth: DecomposedDocument, pdf: DecomposedDocument) -> Score:
    """The scores of `pdf`'s reading against `truth`'s."""
    # untitled sections can't be told apart, so they are not aligned
    truth_heads = [h for h in _headings(truth) if h[0]]
    pdf_heads = [h for h in _headings(pdf) if h[0]]
    matcher = SequenceMatcher(
        None, [k for k, _ in truth_heads], [k for k, _ in pdf_heads], autojunk=False
    )
    found = 0
    levels = 0
    for block in matcher.get_matching_blocks():
        for n in range(block.size):
            found += 1
            levels += truth_heads[block.a + n][1] == pdf_heads[block.b + n][1]

    truth_grids = [
        _without_notes(t, g)
        for t, g in zip(tables_of(truth), grid_forms(truth).values(), strict=True)
    ]
    pdf_grids = list(grid_forms(pdf).values())
    pdf_cells = [_cells(g) for g in pdf_grids]
    tables_found = shape_right = cells_total = cells_right = 0
    cursor = 0
    paired: set[int] = set()
    for grid in truth_grids:
        cells = _cells(grid)
        cells_total += len(cells)
        bag = Counter(t for t in cells.values() if t)
        best: tuple[float, int] | None = None
        candidates = [i for i in range(cursor, len(pdf_grids)) if i not in paired]
        for i in candidates[:PAIRING_WINDOW]:
            similarity = _jaccard(bag, Counter(t for t in pdf_cells[i].values() if t))
            if similarity >= PAIRING_MIN_JACCARD and (best is None or similarity > best[0]):
                best = (similarity, i)
        if best is None:
            continue
        i = best[1]
        paired.add(i)
        cursor = i + 1
        tables_found += 1
        other = pdf_grids[i]
        shape_right += len(grid) == len(other) and (
            max(map(len, grid), default=0) == max(map(len, other), default=0)
        )
        cells_right += sum(1 for pos, t in cells.items() if pdf_cells[i].get(pos) == t)

    truth_words = Counter(_word_list(truth))
    pdf_words = Counter(_word_list(pdf))
    matched = sum((truth_words & pdf_words).values())
    n_truth = sum(truth_words.values())
    n_pdf = sum(pdf_words.values())
    return Score(
        headings_total=len(truth_heads),
        headings_found=found,
        levels_right=levels,
        tables_total=len(truth_grids),
        tables_found=tables_found,
        shape_right=shape_right,
        cells_total=cells_total,
        cells_right=cells_right,
        words_recall=matched / n_truth if n_truth else None,
        words_precision=matched / n_pdf if n_pdf else None,
        words_total=n_truth,
        tables_extra=len(pdf_grids) - len(paired),
    )


def _weighted(pairs: list[tuple[float, int]]) -> float | None:
    weight = sum(w for _, w in pairs)
    if weight:
        return sum(v * w for v, w in pairs) / weight
    return sum(v for v, _ in pairs) / len(pairs) if pairs else None


def total(scores: Sequence[Score]) -> Score:
    """The counts summed; the word rates weighted by each truth's word count (None when no
    document has the rate defined)."""
    return Score(
        headings_total=sum(s.headings_total for s in scores),
        headings_found=sum(s.headings_found for s in scores),
        levels_right=sum(s.levels_right for s in scores),
        tables_total=sum(s.tables_total for s in scores),
        tables_found=sum(s.tables_found for s in scores),
        shape_right=sum(s.shape_right for s in scores),
        cells_total=sum(s.cells_total for s in scores),
        cells_right=sum(s.cells_right for s in scores),
        words_recall=_weighted(
            [(s.words_recall, s.words_total) for s in scores if s.words_recall is not None]
        ),
        words_precision=_weighted(
            [(s.words_precision, s.words_total) for s in scores if s.words_precision is not None]
        ),
        words_total=sum(s.words_total for s in scores),
        tables_extra=sum(s.tables_extra for s in scores),
    )
