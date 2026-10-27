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

from ingest_worker.decompose.forms import _Forms, grid_forms, text_form
from ingest_worker.decompose.model import DecomposedDocument, Section
from ingest_worker.decompose.pdf.fidelity import words
from ingest_worker.decompose.tables import NOTE_PREFIX

#: A truth table is paired with the best of this many next unpaired PDF tables.
PAIRING_WINDOW = 4
#: The least cell-text overlap (Jaccard) that pairs two tables.
PAIRING_MIN_JACCARD = 0.3

_TOKEN = re.compile(r"⟦[^⟧]*⟧")
_SPACE = re.compile(r"\s+")


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
    words_recall: float
    words_precision: float
    #: The truth's word count: the weight of the word rates in `total`.
    words_total: int = 0


def _key(text: str) -> str:
    return _SPACE.sub("", text).lower()


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
    return _SPACE.sub("", slot.partition("|")[2])


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


def _without_notes(grid: list[list[str]]) -> list[list[str]]:
    """The grid without its last rows that read as notes."""
    rows = list(grid)
    while rows and rows[-1] and NOTE_PREFIX.match(rows[-1][0].partition("|")[2]) is not None:
        rows.pop()
    return rows


def _jaccard(a: Counter[str], b: Counter[str]) -> float:
    union = sum((a | b).values())
    return sum((a & b).values()) / union if union else 0.0


def _word_list(doc: DecomposedDocument) -> list[str]:
    return [w for unit in text_form(doc) for w in words(_TOKEN.sub(" ", unit))]


def score(truth: DecomposedDocument, pdf: DecomposedDocument) -> Score:
    """The scores of `pdf`'s reading against `truth`'s."""
    truth_heads = _headings(truth)
    pdf_heads = _headings(pdf)
    matcher = SequenceMatcher(
        None, [k for k, _ in truth_heads], [k for k, _ in pdf_heads], autojunk=False
    )
    found = 0
    levels = 0
    for block in matcher.get_matching_blocks():
        for n in range(block.size):
            found += 1
            levels += truth_heads[block.a + n][1] == pdf_heads[block.b + n][1]

    truth_grids = [_without_notes(g) for g in grid_forms(truth).values()]
    pdf_grids = list(grid_forms(pdf).values())
    pdf_cells = [_cells(g) for g in pdf_grids]
    tables_found = shape_right = cells_total = cells_right = 0
    cursor = 0
    paired: set[int] = set()
    for grid in truth_grids:
        cells = _cells(grid)
        cells_total += len(cells)
        bag = Counter(cells.values())
        best: tuple[float, int] | None = None
        candidates = [i for i in range(cursor, len(pdf_grids)) if i not in paired]
        for i in candidates[:PAIRING_WINDOW]:
            similarity = _jaccard(bag, Counter(pdf_cells[i].values()))
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
        words_recall=matched / n_truth if n_truth else 1.0,
        words_precision=matched / n_pdf if n_pdf else 1.0,
        words_total=n_truth,
    )


def total(scores: Sequence[Score]) -> Score:
    """The counts summed; the word rates weighted by each truth's word count."""
    weight = sum(s.words_total for s in scores)

    def rate(values: list[float]) -> float:
        if weight:
            return sum(v * s.words_total for v, s in zip(values, scores, strict=True)) / weight
        return sum(values) / len(values) if values else 1.0

    return Score(
        headings_total=sum(s.headings_total for s in scores),
        headings_found=sum(s.headings_found for s in scores),
        levels_right=sum(s.levels_right for s in scores),
        tables_total=sum(s.tables_total for s in scores),
        tables_found=sum(s.tables_found for s in scores),
        shape_right=sum(s.shape_right for s in scores),
        cells_total=sum(s.cells_total for s in scores),
        cells_right=sum(s.cells_right for s in scores),
        words_recall=rate([s.words_recall for s in scores]),
        words_precision=rate([s.words_precision for s in scores]),
        words_total=weight,
    )
