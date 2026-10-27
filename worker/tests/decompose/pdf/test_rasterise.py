"""Rasterised twins: a PDF rendered to an image-only PDF (spec section 15.5)."""

from __future__ import annotations

import pytest

from ingest_worker.decompose.pdf.rasterise import rasterise_pdf
from ingest_worker.decompose.pdf.textlayer import read_text_layer
from tests.decompose.pdf.make_pdf import Page, Run, make_pdf


def test_rasterise_pdf() -> None:
    data = make_pdf([Page(runs=[Run("Hello world", 72, 100)]), Page(size=(842, 595))])
    out = read_text_layer(rasterise_pdf(data, dpi=72))
    assert [p.kind for p in out.pages] == ["scanned", "scanned"]
    sizes = [(p.width, p.height) for p in out.pages]
    assert sizes[0] == pytest.approx((595, 842), abs=1)
    assert sizes[1] == pytest.approx((842, 595), abs=1)
    assert all(not c.visible for p in out.pages for c in p.chars)
