"""`FallbackLayoutAnalyser`: a GPU layout service with the CPU one behind it, per document."""

from __future__ import annotations

from typing import Any

import pytest

from ingest_worker.decompose.package import DecompositionRejected
from ingest_worker.decompose.pdf.layout import (
    FallbackLayoutAnalyser,
    HttpLayoutAnalyser,
    LayoutUnavailable,
    analyse_document,
    layout_analyser,
)

from . import docling
from .fakes import FakeLayout


def _page(first: int, last: int) -> dict[str, Any]:
    return docling.doc([(595, 842)], [docling.text("text", 1, (0, 800, 50, 790))])


class Failing(FakeLayout):
    """Answers like FakeLayout, but raises `error` for any chunk starting at `at` or later."""

    def __init__(self, error: Exception, at: int = 1) -> None:
        super().__init__(_page, fingerprint="gpu")
        self.error, self.at = error, at

    def analyse(self, pdf: bytes, first: int, last: int) -> dict[str, Any]:
        self.calls.append((first, last))
        if first >= self.at:
            raise self.error
        return _page(first, last)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_a_healthy_primary_reads_the_document_alone() -> None:
    primary, fallback = FakeLayout(_page, "gpu"), FakeLayout(_page, "cpu")
    analyser = FallbackLayoutAnalyser(primary, fallback)

    result = analyse_document(analyser, b"%PDF-", 45, chunk=20)

    assert primary.calls == [(1, 20), (21, 40), (41, 45)]
    assert fallback.calls == []
    assert [item.page for item in result.items] == [0, 20, 40]


def test_a_primary_failing_part_way_redoes_the_whole_document_on_the_fallback() -> None:
    primary = Failing(LayoutUnavailable("layout service error 500: CUDA out of memory"), at=21)
    fallback = FakeLayout(_page, "cpu")
    analyser = FallbackLayoutAnalyser(primary, fallback)

    result = analyse_document(analyser, b"%PDF-", 45, chunk=20)

    assert primary.calls == [(1, 20), (21, 40)]
    assert fallback.calls == [(1, 20), (21, 40), (41, 45)]
    assert [item.page for item in result.items] == [0, 20, 40]


def test_within_the_cooldown_documents_go_straight_to_the_fallback() -> None:
    clock = Clock()
    primary, fallback = Failing(LayoutUnavailable("unreachable")), FakeLayout(_page, "cpu")
    analyser = FallbackLayoutAnalyser(primary, fallback, cooldown_s=60.0, clock=clock)
    analyse_document(analyser, b"%PDF-", 1)
    primary.calls.clear()

    clock.now += 59.0
    analyse_document(analyser, b"%PDF-", 1)

    assert primary.calls == []
    assert fallback.calls == [(1, 1), (1, 1)]


def test_after_the_cooldown_the_primary_is_tried_again() -> None:
    clock = Clock()
    primary, fallback = Failing(LayoutUnavailable("unreachable")), FakeLayout(_page, "cpu")
    analyser = FallbackLayoutAnalyser(primary, fallback, cooldown_s=60.0, clock=clock)
    analyse_document(analyser, b"%PDF-", 1)
    primary.at = 99  # the GPU service is back

    clock.now += 60.0
    analyse_document(analyser, b"%PDF-", 1)

    assert primary.calls == [(1, 1), (1, 1)]
    assert fallback.calls == [(1, 1)]


def test_a_refused_document_is_not_retried_on_the_fallback() -> None:
    primary = Failing(DecompositionRejected("layout service refused the document: bad PDF"))
    fallback = FakeLayout(_page, "cpu")
    analyser = FallbackLayoutAnalyser(primary, fallback)

    with pytest.raises(DecompositionRejected):
        analyse_document(analyser, b"%PDF-", 1)
    assert fallback.calls == []


def test_both_down_is_layout_unavailable_so_the_job_is_retried() -> None:
    analyser = FallbackLayoutAnalyser(
        Failing(LayoutUnavailable("gpu down")), Failing(LayoutUnavailable("cpu down"))
    )

    with pytest.raises(LayoutUnavailable, match="cpu down"):
        analyse_document(analyser, b"%PDF-", 1)


def test_a_single_chunk_call_falls_back_too() -> None:
    primary, fallback = Failing(LayoutUnavailable("unreachable")), FakeLayout(_page, "cpu")

    FallbackLayoutAnalyser(primary, fallback).analyse(b"%PDF-", 1, 1)

    assert fallback.calls == [(1, 1)]


def test_fingerprint_is_the_primary_s_or_else_the_fallback_s() -> None:
    fallback = FakeLayout(_page, "cpu")
    assert FallbackLayoutAnalyser(FakeLayout(_page, "gpu"), fallback).fingerprint() == "gpu"

    class Down(FakeLayout):
        def fingerprint(self) -> str:
            raise LayoutUnavailable("unreachable")

    assert FallbackLayoutAnalyser(Down(_page), fallback).fingerprint() == "cpu"


def test_layout_analyser_builds_from_the_settings() -> None:
    assert layout_analyser(None, None) is None
    only = layout_analyser("http://layout:8000", None)
    assert isinstance(only, HttpLayoutAnalyser)
    both = layout_analyser("http://layout-gpu:8000", "http://layout:8000")
    assert isinstance(both, FallbackLayoutAnalyser)
    assert isinstance(layout_analyser(None, "http://layout:8000"), HttpLayoutAnalyser)


def test_a_hung_primary_is_given_up_on_sooner_than_the_fallback() -> None:
    both = layout_analyser("http://layout-gpu:8000", "http://layout:8000")
    assert isinstance(both, FallbackLayoutAnalyser)
    assert isinstance(both.primary, HttpLayoutAnalyser)
    assert isinstance(both.fallback, HttpLayoutAnalyser)
    assert both.primary.timeout_s == 120.0
    assert both.fallback.timeout_s == 600.0
