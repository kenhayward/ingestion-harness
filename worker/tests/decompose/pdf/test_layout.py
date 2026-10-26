"""The layout client and the Docling subset.

`fixtures/two-pages.pdf` and `fixtures/two-pages.docling.json` were captured with these lines
(from `worker/`, with `PYTHONPATH=.`), against `ingestion-harness/layout:dev` run as
`docker run --rm -d --name pdf5a-layout -p 127.0.0.1:8099:8000 --read-only --tmpfs /tmp <image>`:

    from tests.decompose.pdf.make_pdf import Img, Page, Run, make_pdf

    def grid(x0, y0, cw, rh, n=3):
        out = []
        for i in range(n + 1):
            out.append((x0, y0 + i * rh, x0 + n * cw, y0 + i * rh))
            out.append((x0 + i * cw, y0, x0 + i * cw, y0 + n * rh))
        return out

    cells = [Run(f"R{r}C{c}", 72 + c * 120 + 6, 190 + r * 30 + 19) for r in range(3) for c in range(3)]
    p1 = Page(runs=[Run("1 Scope of the plan", 72, 90, 18, "Helvetica-Bold"),
                    Run("This plan describes how the pilot line is checked before it is released.", 72, 130),
                    Run("Each stage is signed off by the person who ran it, then reviewed.", 72, 148),
                    *cells, Run("Page 1", 270, 800, 10)], lines=grid(72, 190, 120, 30))
    p2 = Page(runs=[Run("2 Records", 72, 90, 18, "Helvetica-Bold"),
                    Run("Records are kept for as long as the product is supplied.", 72, 130),
                    Run("A picture of the line layout follows.", 72, 148),
                    Run("Page 2", 270, 800, 10)], images=[Img(72, 200, 300, 200)])
    open("two-pages.pdf", "wb").write(make_pdf([p1, p2]))

    curl -F file=@two-pages.pdf -F first=1 -F last=2 http://127.0.0.1:8099/layout
    # the response "document", saved with json.dump(indent=1, sort_keys=True)

Docling reads the heading of page 1 as a picture holding the heading text (so the fixture has
two pictures), and numbers pages from the PDF's own first page whatever range was asked for.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from ingest_worker.decompose.package import DecompositionRejected
from ingest_worker.decompose.pdf.layout import (
    HttpLayoutAnalyser,
    LayoutTable,
    LayoutText,
    LayoutUnavailable,
    analyse_document,
    parse_docling,
)

from . import docling
from .fakes import FakeLayout

FIXTURES = Path(__file__).parent / "fixtures"


def test_parses_the_captured_fixture() -> None:
    parsed = parse_docling(json.loads((FIXTURES / "two-pages.docling.json").read_text("utf-8")))
    texts = [item for item in parsed.items if isinstance(item, LayoutText)]
    assert {"section_header", "text", "page_footer"} <= {t.label for t in texts}
    tables = [item for item in parsed.items if isinstance(item, LayoutTable)]
    assert len(tables) == 1
    table = tables[0]
    assert (table.rows, table.cols, len(table.cells)) == (3, 3, 9)
    assert {(c.row, c.col) for c in table.cells} == {(r, c) for r in range(3) for c in range(3)}
    footers = [t for t in texts if t.label == "page_footer"]
    assert [f.page for f in footers] == [0, 1]
    assert all(f.layer == "furniture" for f in footers)
    for item in parsed.items:
        x0, y0, x1, y1 = item.bbox
        assert 0 <= x0 < x1 <= 595
        assert 0 <= y0 < y1 <= 842
    assert max(item.page for item in parsed.items) == 1


def test_bottom_left_boxes_are_flipped() -> None:
    parsed = parse_docling(docling.doc([(595, 842)], [docling.text("text", 1, (10, 800, 50, 790))]))
    assert parsed.items[0].bbox == (10, 42, 50, 52)


def test_table_cell_boxes_are_already_top_left() -> None:
    table_item = docling.table(1, (0, 800, 100, 700), [(0, 0), (0, 1)], rows=1, cols=2)
    parsed = parse_docling(docling.doc([(595, 842)], [table_item]))
    table = parsed.items[0]
    assert isinstance(table, LayoutTable)
    assert table.bbox == (0, 42, 100, 142)
    assert table.cells[1].bbox == (10, 0, 19, 9)
    assert table.cells[0].header


def test_unknown_labels_parse_as_text() -> None:
    parsed = parse_docling(docling.doc([(595, 842)], [docling.text("mystery", 1, (0, 10, 5, 5))]))
    item = parsed.items[0]
    assert isinstance(item, LayoutText)
    assert item.label == "text"


def test_groups_flatten_in_order() -> None:
    parsed = parse_docling(
        docling.doc(
            [(595, 842)],
            [
                docling.text("section_header", 1, (0, 800, 50, 790), level=1),
                docling.group(
                    [
                        docling.text("list_item", 1, (0, 780, 50, 770)),
                        docling.text("list_item", 1, (0, 760, 50, 750)),
                    ]
                ),
                docling.text("text", 1, (0, 740, 50, 730)),
            ],
        )
    )
    items = [i for i in parsed.items if isinstance(i, LayoutText)]
    assert [i.ref for i in items] == ["#/texts/0", "#/texts/1", "#/texts/2", "#/texts/3"]
    assert [i.group for i in items] == [None, "#/groups/0", "#/groups/0", None]
    assert items[0].level == 1


def test_chunks_cover_all_pages_and_offset() -> None:
    def respond(first: int, last: int) -> dict[str, Any]:
        # an analyser numbers each chunk from page 1
        return docling.doc([(595, 842)], [docling.text("text", 1, (0, 800, 50, 790))])

    fake = FakeLayout(respond)
    result = analyse_document(fake, b"%PDF-", 45, chunk=20)
    assert fake.calls == [(1, 20), (21, 40), (41, 45)]
    assert [item.page for item in result.items] == [0, 20, 40]


Handler = Callable[[httpx.Request], httpx.Response]


def _analyser(handler: Handler) -> HttpLayoutAnalyser:
    return HttpLayoutAnalyser(
        "http://layout:8000/", client=httpx.Client(transport=httpx.MockTransport(handler))
    )


def test_unreachable_is_layout_unavailable() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    with pytest.raises(LayoutUnavailable):
        _analyser(refuse).analyse(b"%PDF-", 1, 1)


@pytest.mark.parametrize("status", [500, 502, 503])
def test_5xx_is_layout_unavailable(status: int) -> None:
    with pytest.raises(LayoutUnavailable):
        _analyser(lambda r: httpx.Response(status, text="busy")).analyse(b"%PDF-", 1, 1)


def test_timeout_is_layout_unavailable() -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(LayoutUnavailable):
        _analyser(slow).analyse(b"%PDF-", 1, 1)


@pytest.mark.parametrize("status", [400, 413, 422])
def test_4xx_is_rejected(status: int) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": "layout analysis failed: bad page"})

    with pytest.raises(DecompositionRejected, match="layout analysis failed: bad page"):
        _analyser(refuse).analyse(b"%PDF-", 1, 1)


def test_analyse_sends_the_range_and_numbers_the_document_from_one() -> None:
    seen: dict[str, bytes] = {}
    document = docling.doc([(595, 842)], [docling.text("text", 5, (0, 800, 50, 790))])
    document["pages"] = {"5": {"page_no": 5, "size": {"width": 595, "height": 842}}}

    def respond(request: httpx.Request) -> httpx.Response:
        seen["body"] = request.read()
        return httpx.Response(200, json={"pages": 9, "document": document})

    result = _analyser(respond).analyse(b"%PDF-", 5, 6)
    assert b'name="first"\r\n\r\n5' in seen["body"]
    assert b'name="last"\r\n\r\n6' in seen["body"]
    assert list(result["pages"]) == ["1"]
    assert parse_docling(result).items[0].page == 0


def test_fingerprint_comes_from_health_and_is_cached() -> None:
    calls: list[str] = []

    def health(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json={"status": "ok", "fingerprint": "docling 2.142.1"})

    analyser = _analyser(health)
    assert analyser.fingerprint() == "docling 2.142.1"
    assert analyser.fingerprint() == "docling 2.142.1"
    assert calls == ["/health"]
