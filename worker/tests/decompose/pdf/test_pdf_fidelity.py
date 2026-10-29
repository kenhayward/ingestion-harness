"""The PDF fidelity checks: every char accounted for, each block's words, each table's region."""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from ingest_worker.decompose.model import (
    Block,
    Cell,
    DecomposedDocument,
    Equation,
    EquationBlock,
    Image,
    ImageBlock,
    Inline,
    Note,
    NoteRef,
    Paragraph,
    Row,
    Section,
    Table,
    Text,
)
from ingest_worker.decompose.package import DecompositionFailed
from ingest_worker.decompose.pdf.build import Provenance
from ingest_worker.decompose.pdf.fidelity import MAX_UNPROVEN, check_pdf
from ingest_worker.decompose.pdf.pieces import Ledger
from ingest_worker.decompose.pdf.textlayer import Char, PageText, TextLayer

#: Each char is this wide, and the next starts this far on.
_ADVANCE = 6.0


@dataclass
class R:
    """A run of chars on one line, every char given to `owners` (none: no ledger entry)."""

    text: str
    owners: list[str] = field(default_factory=list)
    x: float = 72
    y: float = 100
    #: pdfium put a word gap before the run.
    gap: bool = True


def layer(*runs: R) -> tuple[TextLayer, Ledger]:
    """A one-page text layer of the runs and the ledger their owners make."""
    chars: list[Char] = []
    ledger = Ledger()
    for run in runs:
        for n, ch in enumerate(run.text):
            x = run.x + _ADVANCE * n
            c = Char(
                index=len(chars),
                text=ch,
                font="Helvetica",
                size=11,
                bold=False,
                italic=False,
                x0=x,
                y0=run.y - 9,
                x1=x + _ADVANCE - 1,
                y1=run.y + 2,
                baseline=run.y,
                visible=True,
                space_before=n == 0 and run.gap and bool(chars),
            )
            chars.append(c)
            for owner in run.owners:
                ledger.own(0, c.index, owner)
    page = PageText(0, 595, 842, tuple(chars), 0.0)
    return TextLayer((page,), ()), ledger


def para(block_id: str, *inlines: Inline | str) -> Paragraph:
    return Paragraph(
        id=block_id, inlines=[Text(text=i) if isinstance(i, str) else i for i in inlines]
    )


def doc(
    *blocks: Block,
    sections: list[Section] | None = None,
    notes: list[Note] | None = None,
    images: list[Image] | None = None,
    equations: list[Equation] | None = None,
) -> DecomposedDocument:
    return DecomposedDocument(
        blocks=list(blocks),
        sections=sections or [],
        images=images or [],
        equations=equations or [],
        notes=notes or [],
        properties=[],
        report=[],
    )


def image(image_id: str, alt: str | None = None) -> Image:
    return Image(
        id=image_id,
        content_type="image/png",
        width_mm=1,
        height_mm=1,
        align="left",
        alt=alt,
        origin="cropped",
    )


def table(table_id: str, *cells: str, caption: str = "") -> Table:
    return Table(
        id=table_id,
        caption=[Text(text=caption)] if caption else [],
        column_widths=[1 / len(cells)] * len(cells),
        header_rows=0,
        rows=[
            Row(
                cells=[
                    Cell(blocks=[para(f"{table_id}/cell-{n}#p-1", text)])
                    for n, text in enumerate(cells, start=1)
                ]
            )
        ],
    )


def prov(**pages: set[int]) -> Provenance:
    return Provenance(pages={k.replace("_", "-"): v for k, v in pages.items()})


def fails(doc_: DecomposedDocument, text: TextLayer, ledger: Ledger, p: Provenance) -> str:
    """The first word not proven, with the block it is in."""
    [first, *_] = check_pdf(doc_, ledger, text, p)
    return f"{first.detail} (at {first.at})" if first.at else first.detail


# --- Every char accounted for -----------------------------------------------------------------


def test_correct_document_passes() -> None:
    text, ledger = layer(R("Hello world.", ["p-1"]))
    assert check_pdf(doc(para("p-1", "Hello world.")), ledger, text, prov(p_1={0})) == []


def test_unowned_char_fails_with_page_and_word() -> None:
    text, ledger = layer(R("Hello world", ["p-1"]), R("stray", [], y=130))
    message = fails(doc(para("p-1", "Hello world")), text, ledger, prov(p_1={0}))
    assert message == "page 1: word 'stray' not accounted for"


def test_char_read_twice_fails() -> None:
    text, ledger = layer(R("Hello", ["p-1"]), R("twice", ["p-1", "p-2"], y=130))
    d = doc(para("p-1", "Hello twice"), para("p-2", "twice"))
    message = fails(d, text, ledger, prov(p_1={0}, p_2={0}))
    assert message == "page 1: word 'twice' read twice"


def test_char_with_an_owner_not_in_the_document_fails() -> None:
    text, ledger = layer(R("Hello", ["p-1"]), R("lost", ["#/texts/4"], y=130))
    message = fails(doc(para("p-1", "Hello")), text, ledger, prov(p_1={0}))
    assert message == "page 1: word 'lost' not placed"


def test_unknown_drop_reason_is_not_accounted() -> None:
    text, ledger = layer(R("Hello", ["p-1"]), R("gone", ["dropped:whim"], y=130))
    message = fails(doc(para("p-1", "Hello")), text, ledger, prov(p_1={0}))
    assert message == "page 1: word 'gone' not placed"


# --- Each block's words -------------------------------------------------------------------------


def test_block_missing_a_word_fails() -> None:
    text, ledger = layer(R("Hello brave world", ["p-1"]))
    message = fails(doc(para("p-1", "Hello world")), text, ledger, prov(p_1={0}))
    assert message == "page 1: 'brave' missing (at p-1)"


def test_extra_word_fails() -> None:
    text, ledger = layer(R("Hello world", ["p-1"]))
    message = fails(doc(para("p-1", "Hello big world")), text, ledger, prov(p_1={0}))
    assert message == "page 1: 'big' extra (at p-1)"


def test_word_in_the_wrong_block_fails() -> None:
    text, ledger = layer(R("One two", ["p-1"]), R("Three", ["p-2"], y=130))
    d = doc(para("p-1", "One"), para("p-2", "two Three"))
    message = fails(d, text, ledger, prov(p_1={0}, p_2={0}))
    assert message == "page 1: 'two' missing (at p-1)"


def test_every_word_not_proven_is_listed() -> None:
    text, ledger = layer(R("Hello brave world", ["p-1"]), R("stray", [], y=130))
    problems = check_pdf(doc(para("p-1", "Hello big world")), ledger, text, prov(p_1={0}))
    assert [(u.detail, u.page, u.at) for u in problems] == [
        ("page 1: word 'stray' not accounted for", 1, None),
        ("page 1: 'big' extra", 1, "p-1"),
        ("page 1: 'brave' missing", 1, "p-1"),
    ]


def test_a_word_is_listed_once_not_per_char() -> None:
    text, ledger = layer(R("Hello", ["p-1"]), R("stray", [], y=130))
    problems = check_pdf(doc(para("p-1", "Hello")), ledger, text, prov(p_1={0}))
    assert [u.detail for u in problems] == ["page 1: word 'stray' not accounted for"]


def test_more_words_not_proven_than_the_cap_fail_the_document() -> None:
    words = " ".join(f"w{n}" for n in range(MAX_UNPROVEN))
    text, ledger = layer(R(words, ["p-1"]))
    assert len(check_pdf(doc(para("p-1", "")), ledger, text, prov(p_1={0}))) == MAX_UNPROVEN
    text, ledger = layer(R(f"{words} more", ["p-1"]))
    with pytest.raises(DecompositionFailed) as info:
        check_pdf(doc(para("p-1", "")), ledger, text, prov(p_1={0}))
    assert str(info.value) == "page 1: 'more' missing, and 25 more words not proven (at p-1)"


def test_words_compare_as_counts_not_order() -> None:
    text, ledger = layer(R("world", ["p-1"]), R("Hello", ["p-1"], y=130))
    assert check_pdf(doc(para("p-1", "Hello world")), ledger, text, prov(p_1={0})) == []


def passes(text: TextLayer, ledger: Ledger, said: str) -> bool:
    """Whether a paragraph `p-1` saying `said` passes against the chars."""
    return check_pdf(doc(para("p-1", said)), ledger, text, prov(p_1={0})) == []


def test_a_word_gap_pdfium_saw_cuts_a_word() -> None:
    text, ledger = layer(R("ab", ["p-1"]), R("cd", ["p-1"], x=84, gap=True))
    assert passes(text, ledger, "ab cd")
    assert not passes(text, ledger, "abcd")


def test_without_a_word_gap_chars_join_however_far_apart() -> None:
    text, ledger = layer(R("ab", ["p-1"]), R("cd", ["p-1"], x=300, gap=False))
    assert passes(text, ledger, "abcd")
    assert not passes(text, ledger, "ab cd")


def test_a_blank_char_cuts_a_word() -> None:
    text, ledger = layer(R("ab cd", ["p-1"]))
    assert passes(text, ledger, "ab cd")
    assert not passes(text, ledger, "abcd")


def test_a_new_line_cuts_a_word() -> None:
    text, ledger = layer(R("ab", ["p-1"]), R("cd", ["p-1"], y=130, gap=False))
    assert passes(text, ledger, "ab cd")
    assert not passes(text, ledger, "abcd")


def test_a_superscript_stays_in_its_word() -> None:
    text, ledger = layer(R("x", ["p-1"]), R("2", ["p-1"], x=78, y=96, gap=False))
    assert passes(text, ledger, "x2")
    assert not passes(text, ledger, "x 2")


def test_ligature_and_nb_hyphen_normalise() -> None:
    as_drawn = "\N{LATIN SMALL LIGATURE FI}ne non\N{NON-BREAKING HYPHEN}stop"
    text, ledger = layer(R(as_drawn, ["p-1"]))
    assert check_pdf(doc(para("p-1", "fine non-stop")), ledger, text, prov(p_1={0})) == []
    assert check_pdf(doc(para("p-1", as_drawn)), ledger, text, prov(p_1={0})) == []
    assert check_pdf(doc(para("p-1", "fine nonstop")), ledger, text, prov(p_1={0}))


def test_dropped_chars_and_note_tokens_are_accounted() -> None:
    text, ledger = layer(
        R("Running header", ["dropped:furniture"], y=40),
        R("1.2", ["dropped:heading-number"], y=80),
        R("Scope", ["s-1-2-scope"], x=100, y=80),
        R("Dose", ["s-1-2-scope#p-1"]),
        R("1", ["dropped:note-marker"], x=96, y=97),
        R("given.", ["s-1-2-scope#p-1"], x=110),
        R("1", ["dropped:note-marker"], y=700),
        R("Once daily.", ["fn-1"], x=84, y=700),
    )
    d = doc(
        sections=[
            Section(
                id="s-1-2-scope",
                title=[Text(text="Scope")],
                blocks=[para("s-1-2-scope#p-1", "Dose", NoteRef(note_id="fn-1"), " given.")],
                sections=[],
            )
        ],
        notes=[Note(id="fn-1", blocks=[para("fn-1#p-1", "Once daily.")])],
    )
    assert check_pdf(d, ledger, text, prov(s_1_2_scope={0})) == []


def test_a_marker_inside_a_word_splits_it_on_both_sides() -> None:
    text, ledger = layer(
        R("foo", ["p-1"]),
        R("1", ["dropped:note-marker"], x=90, gap=False),
        R("bar", ["p-1"], x=96, gap=False),
    )
    d = doc(para("p-1", "foo", NoteRef(note_id="fn-1"), "bar"), notes=[Note(id="fn-1", blocks=[])])
    assert check_pdf(d, ledger, text, prov(p_1={0})) == []


def test_image_only_equation_chars_are_not_words() -> None:
    text, ledger = layer(R("Before", ["p-1"]), R("x = y + 1", ["equation-1"], y=130))
    d = doc(
        para("p-1", "Before"),
        EquationBlock(id="equation-1", equation_id="equation-1/eq-1"),
        images=[image("img")],
        equations=[Equation(id="equation-1/eq-1", image_id="img")],
    )
    assert check_pdf(d, ledger, text, prov(p_1={0}, equation_1={0})) == []


def test_alt_text_is_compared() -> None:
    text, ledger = layer(R("Axis label", ["image-1"]))
    d = doc(
        ImageBlock(id="image-1", image_id="image-1/img-1"), images=[image("image-1/img-1", "Axis")]
    )
    message = fails(d, text, ledger, prov(image_1={0}))
    assert message == "page 1: 'label' missing (at image-1)"


# --- Each table's region --------------------------------------------------------------------------


def table_prov(**pages: set[int]) -> Provenance:
    p = prov(**pages)
    p.regions["t-1"] = [(0, (70.0, 85.0, 200.0, 105.0))]
    return p


def test_table_words_inside_its_region_pass() -> None:
    text, ledger = layer(R("Doses", ["t-1"], y=70), R("A", ["t-1"]), R("B", ["t-1"], x=120))
    d = doc(table("t-1", "A", "B", caption="Doses"))
    assert check_pdf(d, ledger, text, table_prov(t_1={0})) == []


def test_char_of_another_block_inside_a_table_fails() -> None:
    text, ledger = layer(R("A", ["t-1"]), R("B", ["p-1"], x=120))
    d = doc(table("t-1", "A"), para("p-1", "B"))
    message = fails(d, text, ledger, table_prov(t_1={0}, p_1={0}))
    assert message == "page 1: 'B' moved out of table t-1 (at t-1)"


def test_word_moved_into_a_table_fails() -> None:
    text, ledger = layer(R("A", ["t-1"]), R("B", ["t-1"], y=130))
    d = doc(table("t-1", "A", "B"))
    message = fails(d, text, ledger, table_prov(t_1={0}))
    assert message == "page 1: 'B' moved into table t-1 (at t-1)"


def test_a_word_is_inside_a_region_by_most_of_its_chars() -> None:
    # the region ends at x=200: "abc" at x=188 has two chars of three centred inside it
    text, ledger = layer(R("A", ["t-1"]), R("abc", ["t-1"], x=188))
    assert check_pdf(doc(table("t-1", "A", "abc")), ledger, text, table_prov(t_1={0})) == []
    text, ledger = layer(R("A", ["t-1"]), R("abc", ["p-1"], x=188))
    message = fails(doc(table("t-1", "A"), para("p-1", "abc")), text, ledger, table_prov())
    assert message == "page 1: 'abc' moved out of table t-1 (at t-1)"
    # one char of three inside is not the table's
    text, ledger = layer(R("A", ["t-1"]), R("abc", ["p-1"], x=194))
    assert check_pdf(doc(table("t-1", "A"), para("p-1", "abc")), ledger, text, table_prov()) == []
