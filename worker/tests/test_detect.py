from __future__ import annotations

import json

import pytest

from ingest_worker.detect import (
    Candidate,
    LabelledSample,
    candidate_from_definition,
    coverage_matrix,
    detect,
    format_matrix,
    format_report,
    load_corpus,
    research_report,
    score_type,
)
from ingest_worker.specs import CopySelection, DocumentLayout, PageRange, Section
from ingest_worker.storage import MemoryObjectStore, prepared_text_key


def layout(*sections: Section, pages: PageRange | None = None, **kw: object) -> DocumentLayout:
    return DocumentLayout(sections=list(sections), pages=pages, **kw)  # type: ignore[arg-type]


INVOICE = Candidate(
    "invoice",
    1,
    "published",
    layout(
        Section(id="head", anchor=r"\A"),
        Section(id="bill", anchor=r"^INVOICE\b"),
        Section(id="lines", anchor=r"^Description\s+Qty"),
        Section(id="notes", anchor=r"^Notes", required=False),
    ),
)
PROTOCOL = Candidate(
    "protocol",
    2,
    "published",
    layout(
        Section(id="front", anchor=r"\A"),
        Section(id="approval", anchor=r"(?i)^PROTOCOL APPROVAL\b"),
        Section(id="process", anchor=r"(?i)^\d+\.\s+MANUFACTURING PROCESS\b"),
        pages=PageRange(min=2, max=50),
    ),
)
#: Its only required section matches anything: never evidence of the type.
LOOSE = Candidate("loose", 1, "draft", layout(Section(id="all", anchor=r"\A")))

INVOICE_TEXT = ["INVOICE #7\nAcme\nDescription Qty Price\nWidget 1 2.00"]
PROTOCOL_TEXT = ["PROTOCOL APPROVAL\nSigned", "1. MANUFACTURING PROCESS\nMix"]


def test_scores_informative_required_sections_and_ignores_catch_all_anchors() -> None:
    score = score_type(INVOICE_TEXT, INVOICE)
    assert (score.required_matched, score.required_total) == (2, 2)
    assert (score.optional_matched, score.optional_total) == (0, 1)
    assert score.page_fit and score.full and score.missing_required == []


def test_a_missing_required_section_is_not_a_full_match() -> None:
    score = score_type(["INVOICE #7\nno lines here"], INVOICE)
    assert score.required_matched == 1 and not score.full
    assert score.missing_required == ["lines"]


def test_a_page_count_outside_the_range_is_not_a_full_match() -> None:
    score = score_type(["PROTOCOL APPROVAL\n1. MANUFACTURING PROCESS"], PROTOCOL)
    assert score.required_matched == 2 and not score.page_fit and not score.full


def test_a_type_without_informative_required_sections_never_matches_fully() -> None:
    score = score_type(INVOICE_TEXT, LOOSE)
    assert score.required_total == 0 and score.vacuous and not score.full


def test_scores_the_kept_copy_like_production() -> None:
    copies = Candidate(
        "copies",
        1,
        "published",
        layout(
            Section(id="approval", anchor=r"^APPROVAL"),
            Section(id="executed", anchor=r"^EXECUTED"),
            copies=CopySelection(anchor=r"^APPROVAL", select="first"),
        ),
    )
    # The second copy holds EXECUTED; production keeps the first copy only.
    pages = ["APPROVAL\nblank", "APPROVAL\nEXECUTED"]
    assert not score_type(pages, copies).full


def test_page_markers_are_added_like_production() -> None:
    marked = Candidate("marked", 1, "published", layout(Section(id="p2", anchor=r"^\[page 2\]$")))
    marked_layout = Candidate("marked", 1, "published", marked.document, page_markers=True)
    pages = ["one", "two"]
    assert not score_type(pages, marked).full
    assert score_type(pages, marked_layout).full


def test_an_invalid_anchor_is_reported_not_raised() -> None:
    broken = Candidate("broken", 1, "draft", layout(Section(id="x", anchor=r"(")))
    score = score_type(INVOICE_TEXT, broken)
    assert not score.full and score.error is not None and "x" in score.error


@pytest.mark.parametrize(
    ("pages", "verdict", "matches"),
    [
        (INVOICE_TEXT, "match", ["invoice"]),
        (PROTOCOL_TEXT, "match", ["protocol"]),
        (["nothing to see"], "none", []),
        (
            ["INVOICE 1\nDescription Qty\nPROTOCOL APPROVAL", "1. MANUFACTURING PROCESS"],
            "ambiguous",
            ["invoice", "protocol"],
        ),
    ],
)
def test_detect_verdicts(pages: list[str], verdict: str, matches: list[str]) -> None:
    result = detect(pages, [INVOICE, PROTOCOL, LOOSE])
    assert result.verdict == verdict
    assert result.matches == matches


def test_detect_ranks_the_best_partial_match_first() -> None:
    result = detect(["INVOICE #7\nonly a header"], [PROTOCOL, INVOICE])
    assert result.verdict == "none"
    assert result.ranking[0].type_id == "invoice"


def test_candidate_from_definition_reads_a_template() -> None:
    raw = {
        "id": "inv",
        "version": 3,
        "name": "Invoice",
        "document": {
            "pageMarkers": True,
            "sections": [{"id": "head", "anchor": "^INVOICE"}],
        },
        "outputs": {"fields": [{"id": "number", "type": "text"}]},
        "pipeline": [{"type": "extract", "id": "s", "sections": ["head"], "fields": ["number"]}],
    }
    candidate = candidate_from_definition(raw, "published")
    assert (candidate.type_id, candidate.version, candidate.status) == ("inv", 3, "published")
    assert candidate.page_markers is True
    assert candidate.name == "Invoice"


def test_research_report_counts_outcomes_per_type_and_the_confusions() -> None:
    samples = [
        LabelledSample("invoice", "a.pdf", "dev", INVOICE_TEXT),
        LabelledSample("invoice", "b.pdf", "holdout", ["INVOICE only"]),
        LabelledSample("protocol", "c.pdf", "dev", PROTOCOL_TEXT),
        LabelledSample(
            "protocol",
            "d.pdf",
            "dev",
            ["PROTOCOL APPROVAL\nINVOICE 9\nDescription Qty", "1. MANUFACTURING PROCESS"],
        ),
        # Labelled protocol but reads like an invoice: a confident wrong answer.
        LabelledSample("protocol", "e.pdf", "dev", INVOICE_TEXT),
    ]
    report = research_report(samples, [INVOICE, PROTOCOL, LOOSE])
    by_type = {row.type_id: row for row in report.types}
    assert by_type["invoice"].counts == {
        "correct": 1,
        "ambiguous": 0,
        "none": 1,
        "wrong": 0,
        "unscorable": 0,
        "samples": 2,
    }
    assert by_type["protocol"].counts == {
        "correct": 1,
        "ambiguous": 1,
        "none": 0,
        "wrong": 1,
        "unscorable": 0,
        "samples": 3,
    }
    # protocol samples that also fully matched invoice: d (ambiguous) and e (wrong).
    assert report.confusions == {("protocol", "invoice"): 2}
    assert report.uninformative == ["loose"]
    wrong = next(s for s in report.samples if s.name == "e.pdf")
    assert wrong.outcome == "wrong" and wrong.detected == ["invoice"]
    assert wrong.own_missing == ["approval", "process"]

    text = format_report(report)
    assert "protocol" in text and "e.pdf" in text and "wrong" in text
    assert "loose" in text  # flagged: no distinctive required section

    loose = research_report([LabelledSample("loose", "l.pdf", "dev", ["x"])], [LOOSE])
    assert "l.pdf (dev, 1 p): the type has no distinctive section" in format_report(loose)


def test_a_sample_of_a_type_that_is_no_candidate_is_counted_apart() -> None:
    samples = [LabelledSample("gone", "x.pdf", "dev", INVOICE_TEXT)]
    report = research_report(samples, [INVOICE])
    assert report.types[0].type_id == "gone"
    assert report.samples[0].outcome == "unscorable"


# --- loading the corpus ------------------------------------------------------------------------


def _definition(type_id: str, version: int, anchor: str) -> dict[str, object]:
    return {
        "id": type_id,
        "version": version,
        "name": type_id.title(),
        "document": {"sections": [{"id": "s", "anchor": anchor}]},
    }


class FakeRows:
    def __init__(self) -> None:
        self.template_rows: list[tuple[str, int, str, dict[str, object]]] = [
            ("inv", 1, "published", _definition("inv", 1, "^OLD")),
            ("inv", 2, "published", _definition("inv", 2, "^INVOICE")),
            ("inv", 3, "draft", _definition("inv", 3, "^DRAFT")),
            ("wip", 1, "draft", _definition("wip", 1, "^WIP")),
            ("bad", 1, "draft", {"id": "bad", "version": 1, "document": {"sections": []}}),
        ]
        self.sample_rows: list[tuple[str, str, str, str]] = [
            ("inv", "a.pdf", "dev", "aaa"),
            ("wip", "b.pdf", "holdout", "bbb"),
            ("inv", "c.pdf", "dev", "ccc"),  # not prepared yet
        ]

    def templates(self) -> list[tuple[str, int, str, dict[str, object]]]:
        return self.template_rows

    def samples(self) -> list[tuple[str, str, str, str]]:
        return self.sample_rows


def _store() -> MemoryObjectStore:
    store = MemoryObjectStore()
    for sha, texts in (("aaa", ["INVOICE 1"]), ("bbb", ["WIP", "more"])):
        body = {"sha256": sha, "pages": [{"number": i + 1, "text": t} for i, t in enumerate(texts)]}
        store.put("runs", prepared_text_key(sha), json.dumps(body).encode(), "application/json")
    return store


def test_load_corpus_takes_each_types_newest_published_version_else_its_draft() -> None:
    candidates, samples, skipped = load_corpus(FakeRows(), _store(), "runs")
    by_id = {c.type_id: c for c in candidates}
    assert (by_id["inv"].version, by_id["inv"].status) == (2, "published")
    assert (by_id["wip"].version, by_id["wip"].status) == (1, "draft")
    assert "bad" not in by_id
    assert [(s.type_id, s.name, s.role, s.pages) for s in samples] == [
        ("inv", "a.pdf", "dev", ["INVOICE 1"]),
        ("wip", "b.pdf", "holdout", ["WIP", "more"]),
    ]
    assert any("bad v1" in s for s in skipped)
    assert any("c.pdf" in s and "not prepared" in s for s in skipped)


def test_load_corpus_published_only_leaves_draft_only_types_out() -> None:
    candidates, _, _ = load_corpus(FakeRows(), _store(), "runs", published_only=True)
    assert [c.type_id for c in candidates] == ["inv"]


# --- the coverage rule: every distinctive section counts, required or not ----------------------

#: Like the published types today: every section optional.
REPORT = Candidate(
    "report",
    1,
    "published",
    layout(
        Section(id="front", anchor=r"\A", required=False),
        Section(id="title", anchor=r"^1\s+Title\b", required=False),
        Section(id="summary", anchor=r"^4\s+Summary\b", required=False),
        Section(id="method", anchor=r"^7\s+Test Method\b", required=False),
        Section(id="results", anchor=r"^9\s+Results\b", required=False),
    ),
)
TABLES = Candidate(
    "tables",
    1,
    "published",
    layout(
        Section(id="front", anchor=r"\A", required=False),
        Section(id="items", anchor=r"^8\s+Items\b", required=False),
        Section(id="results", anchor=r"^9\s+Results\b", required=False),
    ),
)
REPORT_TEXT = ["1 Title\nx\n4 Summary\ny", "7 Test Method\nz\n9 Results\nw"]


def test_coverage_counts_every_distinctive_section() -> None:
    score = score_type(REPORT_TEXT, REPORT)
    assert score.coverage == 1.0
    assert score_type(REPORT_TEXT, TABLES).coverage == 0.5  # results, not items


@pytest.mark.parametrize(
    ("pages", "verdict", "matches"),
    [
        (REPORT_TEXT, "match", ["report"]),  # 1.0 against 0.5: clear
        (["8 Items\na\n9 Results\nb"], "match", ["tables"]),  # 1.0 against 0.25
        (["1 Title\n4 Summary\n9 Results"], "ambiguous", ["report", "tables"]),  # 0.75 / 0.5
        (["nothing\nhere"], "none", []),
    ],
)
def test_coverage_verdicts(pages: list[str], verdict: str, matches: list[str]) -> None:
    result = detect(pages, [REPORT, TABLES, LOOSE], rule="coverage")
    assert (result.verdict, result.matches) == (verdict, matches)


def test_the_coverage_report_flags_only_types_without_any_distinctive_section() -> None:
    samples = [LabelledSample("report", "r.pdf", "dev", REPORT_TEXT)]
    report = research_report(samples, [REPORT, TABLES, LOOSE], rule="coverage")
    assert report.rule == "coverage"
    assert report.uninformative == ["loose"]
    assert report.types[0].counts["correct"] == 1


def test_coverage_matrix_shows_how_each_labelled_type_scores_against_every_type() -> None:
    samples = [
        LabelledSample("report", "r1.pdf", "dev", REPORT_TEXT),
        LabelledSample("report", "r2.pdf", "dev", ["1 Title\n4 Summary"]),
        LabelledSample("tables", "t.pdf", "dev", ["8 Items\n9 Results"]),
    ]
    matrix = coverage_matrix(samples, [REPORT, TABLES])
    assert matrix[("report", "report")] == [1.0, 0.5]
    assert matrix[("report", "tables")] == [0.5, 0.0]
    assert matrix[("tables", "report")] == [0.25]
    text = format_matrix(matrix)
    assert "report" in text and "0.75 (0.50-1.00)" in text  # report against itself
