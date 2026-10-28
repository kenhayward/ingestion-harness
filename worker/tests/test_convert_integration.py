"""A real conversion through Gotenberg (deploy/docker-compose.yml `converter`).

Needs CONVERTER_URL, e.g. after `deploy/scripts/dev-infra.sh up`:
    CONVERTER_URL=http://localhost:3010 uv run pytest -m integration tests/test_convert_integration.py
"""

from __future__ import annotations

import io
import os
import zipfile

import pytest

from ingest_worker.convert import ConversionRejected, GotenbergConverter, is_docx
from ingest_worker.pdf import extract_pages

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not os.environ.get("CONVERTER_URL"), reason="CONVERTER_URL not set"),
]

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def two_page_docx(document_xml: str | None = None) -> bytes:
    def para(text: str) -> str:
        return f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"

    page_break = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
    body = para("HEADER Acme protocol") + para("Batch 42") + page_break + para("RESULTS")
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/'
            '2006/content-types"><Default Extension="rels" ContentType="application/'
            'vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" '
            'ContentType="application/xml"/><Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.'
            'document.main+xml"/></Types>',
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/'
            'package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.'
            'openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/></Relationships>',
        )
        z.writestr(
            "word/document.xml",
            document_xml or f"<w:document {W}><w:body>{body}</w:body></w:document>",
        )
    return out.getvalue()


def test_a_docx_converts_to_a_pdf_with_its_pages() -> None:
    converter = GotenbergConverter(os.environ["CONVERTER_URL"])
    docx = two_page_docx()
    assert is_docx(docx)
    pages = extract_pages(converter.to_pdf(docx))
    assert len(pages) == 2
    assert "HEADER Acme protocol" in pages[0] and "Batch 42" in pages[0]
    assert "RESULTS" in pages[1]
    assert converter.fingerprint().startswith("gotenberg-8.38.1-")


def test_a_broken_docx_is_rejected() -> None:
    converter = GotenbergConverter(os.environ["CONVERTER_URL"])
    with pytest.raises(ConversionRejected):
        converter.to_pdf(two_page_docx("<w:document><<<broken"))
