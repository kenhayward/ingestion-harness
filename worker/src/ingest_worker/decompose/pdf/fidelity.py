"""Fidelity checks for a PDF's decomposed document (spec section 6).

Content must never be silently changed, lost or moved. A PDF has no source tree to walk again,
so the check is built on the ledger: who owns each visible char of a born-digital page. Owners
are the top-level blocks (paragraph, list, table, figure, image, equation), the sections (for
their titles) and the notes; a char can also be dropped on purpose (`dropped:<reason>`).
`check_pdf` lists each word that fails one of the first three, naming its page, and refuses
the document when there are more than `MAX_UNPROVEN` of them, or a reference fails:

1. **Every char accounted for.** A visible char with no ledger entry, with two, or with an owner
   that is not in the document fails.
2. **Each owner's words.** The words of the chars an owner holds, over all its pages, must be
   the words of its text in the document: compared as counts, not in order, since the text
   layer's order is the order the content was drawn in. An owner's text leaves out the tokens
   of note references, cross-references and equations (their chars are dropped or are not
   text); an image's alt text counts as text. The chars of an image-only equation are accounted
   to its image and not compared.
3. **Each table's region.** A word mostly inside a table's region (its box and its cells'
   boxes) on its page must not be another block's, and every word in its cells must be one of
   the table's words at least half inside its regions: "mostly" as `attach_text` gives a word to
   the item most of its chars are in. A cell's text can't move out of its table, or into it. A
   table's caption and notes may lie inside or outside its regions.
4. **References** resolve, as for Word (`check_references`).

Words are those of `forms.normalise`, with the ligatures U+FB00 to U+FB06 split and the
non-breaking hyphen U+2011 read as `-`, split as `\\w+|[^\\w\\s]`. The text layer's words follow the
document's own rule (`pieces.words_of`): a word ends at a blank, where pdfium saw a word gap
(`Char.space_before`), and at a new line; `attach_text` keeps each word whole in one item. Here a
word is also cut where its chars' owner changes, so a dropped marker inside a word splits it, as
the reference token standing for it does in the document.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from typing import get_args

from ingest_worker.decompose.fidelity import check_references
from ingest_worker.decompose.forms import _Forms, normalise, tables_of
from ingest_worker.decompose.model import (
    Block,
    DecomposedDocument,
    EquationBlock,
    Figure,
    ImageBlock,
    Inline,
    InlineEquation,
    InlineImage,
    ListBlock,
    NoteRef,
    Paragraph,
    Section,
    Table,
    XRef,
)
from ingest_worker.decompose.package import DecompositionFailed, Unproven
from ingest_worker.decompose.pdf.build import Provenance
from ingest_worker.decompose.pdf.layout import BBox
from ingest_worker.decompose.pdf.pieces import DROPPED_PREFIX, DropReason, Ledger, words_of
from ingest_worker.decompose.pdf.textlayer import Char, PageText, TextLayer

_WORD = re.compile(r"\w+|[^\w\s]")
#: What the comparison reads differently from `forms.normalise`: ligatures split, the
#: non-breaking hyphen as a hyphen.
_READ_AS = {cp: unicodedata.normalize("NFKC", chr(cp)) for cp in range(0xFB00, 0xFB07)} | {
    0x2011: "-"
}
_DROPPED = frozenset(DROPPED_PREFIX + reason for reason in get_args(DropReason))
#: More words not proven than this fail the document: a page was read badly, not a word (spec 6).
MAX_UNPROVEN = 25


def words(text: str) -> list[str]:
    """The words of `text`, as the PDF checks compare them."""
    return _WORD.findall(normalise(text).translate(_READ_AS))


# --- The document's side ---------------------------------------------------------------------


class _Words(_Forms):
    """The text of an owner, as words: tokens left out, alt text kept."""

    def inline(self, item: Inline) -> str:
        if isinstance(item, NoteRef | XRef | InlineEquation):
            return " "
        if isinstance(item, InlineImage):
            return f" {self.alts.get(item.image_id) or ''} "
        return super().inline(item)

    def block_texts(self, block: Block) -> Iterator[str]:
        if isinstance(block, Paragraph):
            yield self.inline_text(block.inlines)
        elif isinstance(block, ListBlock):
            for item in block.items:
                for inner in item.blocks:
                    yield from self.block_texts(inner)
        elif isinstance(block, Table):
            yield self.inline_text(block.caption)
            yield from self.cell_texts(block)
            for note in block.notes:
                # the marker is the note's own chars; the separator after it was dropped
                yield note.marker
                yield self.inline_text(note.inlines)
        elif isinstance(block, Figure):
            yield self.inline_text(block.caption)
            yield self.alts.get(block.image_id) or ""
        elif isinstance(block, ImageBlock):
            yield self.alts.get(block.image_id) or ""

    def cell_texts(self, table: Table) -> Iterator[str]:
        for row in table.rows:
            for cell in row.cells:
                for inner in cell.blocks:
                    yield from self.block_texts(inner)

    def counts(self, texts: Iterator[str]) -> Counter[str]:
        return Counter(w for text in texts for w in words(text))


@dataclass
class _Expected:
    """Each owner's words in the document, in document order, and the owners not compared."""

    words: dict[str, Counter[str]] = field(default_factory=dict)
    image_only: set[str] = field(default_factory=set)


def _expected(doc: DecomposedDocument, forms: _Words) -> _Expected:
    out = _Expected()
    image_only = {e.id for e in doc.equations if e.mathml is None}

    def blocks(items: Sequence[Block]) -> None:
        for block in items:
            out.words[block.id] = forms.counts(forms.block_texts(block))
            if isinstance(block, EquationBlock) and block.equation_id in image_only:
                out.image_only.add(block.id)

    def section(s: Section) -> None:
        out.words[s.id] = forms.counts(iter([forms.inline_text(s.title)]))
        blocks(s.blocks)
        for sub in s.sections:
            section(sub)

    blocks(doc.blocks)
    for s in doc.sections:
        section(s)
    for note in doc.notes:
        out.words[note.id] = forms.counts(t for b in note.blocks for t in forms.block_texts(b))
    return out


# --- The text layer's side -------------------------------------------------------------------


@dataclass
class _Segment:
    """Chars with the same ledger entries and no word gap between them."""

    page: int
    entries: tuple[str, ...]
    chars: list[Char]

    @property
    def text(self) -> str:
        return "".join(c.text for c in self.chars)

    @property
    def owner(self) -> str | None:
        """The one owner of the chars, if they have one and were not dropped."""
        if len(self.entries) != 1 or self.entries[0].startswith(DROPPED_PREFIX):
            return None
        return self.entries[0]


def _segments(page: PageText, entries: dict[int, list[str]]) -> list[_Segment]:
    """The page's words (`pieces.words_of`, as `attach_text` keeps them whole), each cut where
    its chars' ledger entries change; blanks left out."""
    out: list[_Segment] = []
    for word in words_of(page):
        current: _Segment | None = None
        for c in word:
            if c.text.isspace():
                continue
            key = tuple(entries.get(c.index, ()))
            if current is not None and current.entries == key:
                current.chars.append(c)
                continue
            current = _Segment(page.index, key, [c])
            out.append(current)
    return out


def _centre_in(c: Char, box: BBox) -> bool:
    x, y = (c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2
    return box[0] <= x <= box[2] and box[1] <= y <= box[3]


def _shown(text: str) -> str:
    return normalise(text).translate(_READ_AS) or text


# --- The checks ------------------------------------------------------------------------------


class _Check:
    def __init__(
        self, doc: DecomposedDocument, ledger: Ledger, text: TextLayer, prov: Provenance
    ) -> None:
        self.doc = doc
        self.prov = prov
        self.forms = _Words(doc)
        self.expected = _expected(doc, self.forms)
        self.pages = [p for p in text.pages if p.kind == "born_digital"]
        #: Scanned pages are flagged, not checked (spec 6, 15.4).
        self.recognised = {p.index for p in text.pages if p.kind == "scanned"}
        self.entries = {p.index: ledger.entries(p.index) for p in self.pages}
        self.segments = {p.index: _segments(p, self.entries[p.index]) for p in self.pages}
        self.unproven: list[Unproven] = []

    def run(self) -> list[Unproven]:
        self.accounted()
        self.owned_words()
        self.table_regions()
        check_references(self.doc)
        if len(self.unproven) > MAX_UNPROVEN:
            first = self.unproven[0]
            raise DecompositionFailed(
                f"{first.detail}, and {len(self.unproven) - 1} more words not proven", first.at
            )
        return self.unproven

    def _unproven(self, page: int, problem: str, at: str | None) -> None:
        self.unproven.append(Unproven(f"page {page + 1}: {problem}", page + 1, at))

    # -- 1. every char accounted for --

    def accounted(self) -> None:
        owners = set(self.expected.words)
        for page in self.pages:
            entries = self.entries[page.index]
            segment_of = {c.index: s for s in self.segments[page.index] for c in s.chars}
            seen: set[int] = set()  # one problem per word, not per char
            for c in page.chars:
                if not c.visible:
                    continue
                found = entries.get(c.index, [])
                problem = None
                if not found:
                    problem = "not accounted for"
                elif len(found) > 1:
                    problem = "read twice"
                elif found[0] not in owners and found[0] not in _DROPPED:
                    problem = "not placed"
                segment = segment_of.get(c.index)
                if problem is not None and id(segment) not in seen:
                    seen.add(id(segment))
                    word = _shown(segment.text if segment is not None else c.text)
                    owner = found[0] if len(found) == 1 and found[0] in owners else None
                    self._unproven(page.index, f"word '{word}' {problem}", owner)

    # -- 2. each owner's words --

    def owned_words(self) -> None:
        got: dict[str, dict[int, Counter[str]]] = {}
        for page in self.pages:
            for segment in self.segments[page.index]:
                owner = segment.owner
                if owner is not None:
                    by_page = got.setdefault(owner, {})
                    by_page.setdefault(page.index, Counter()).update(words(segment.text))
        for owner, expected in self.expected.words.items():
            if owner in self.expected.image_only:
                continue
            if self.prov.pages.get(owner, set()) & self.recognised:
                continue
            by_page = got.get(owner, {})
            total: Counter[str] = sum(by_page.values(), Counter())
            differing = sorted(w for w in set(total) | set(expected) if total[w] != expected[w])
            for word in differing:
                if total[word] > expected[word]:
                    at = min(p for p, counts in by_page.items() if counts[word] > 0)
                    problem = "missing"
                else:
                    at = min(set(by_page) or self.prov.pages.get(owner) or {0})
                    problem = "extra"
                self._unproven(at, f"'{word}' {problem}", owner)

    # -- 3. each table's region --

    def table_regions(self) -> None:
        for table in tables_of(self.doc):
            regions = self.prov.regions.get(table.id, [])
            if any(number in self.recognised for number, _ in regions):
                continue
            inside: Counter[str] = Counter()
            for number, box in regions:
                for segment in self.segments.get(number, []):
                    # as attach_text decides a word's item: by most of its chars
                    share = sum(_centre_in(c, box) for c in segment.chars) / len(segment.chars)
                    if segment.owner == table.id:
                        if share >= 1 / 2:
                            inside.update(words(segment.text))
                    elif segment.owner is not None and share > 1 / 2:
                        self._unproven(
                            number,
                            f"'{_shown(segment.text)}' moved out of table {table.id}",
                            table.id,
                        )
            cells = self.forms.counts(self.forms.cell_texts(table))
            moved_in = sorted(cells - inside)
            page = regions[0][0] if regions else min(self.prov.pages.get(table.id) or {0})
            for word in moved_in:
                self._unproven(page, f"'{word}' moved into table {table.id}", table.id)


def check_pdf(
    doc: DecomposedDocument, ledger: Ledger, text: TextLayer, prov: Provenance
) -> list[Unproven]:
    """The words of `doc` not proven, in check order, page and word named: a char of a
    born-digital page not accounted for exactly once, an owner's word missing or extra, a cell's
    word moved across its table's edge. Refuses `doc` when there are more than `MAX_UNPROVEN`,
    or a reference doesn't resolve."""
    return _Check(doc, ledger, text, prov).run()
