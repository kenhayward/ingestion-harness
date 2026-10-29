"""Watched folders: file naming, the source check and the reason file (pure)."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.convert import DOCX_MAIN_TYPE, is_docx
from ingest_worker.watch.naming import (
    is_candidate,
    source_key,
    watch_source_path,
    working_name,
)
from ingest_worker.watch.reason import ReasonFacts, advice_for, reason_markdown
from ingest_worker.watch.sources import source_problem

FIXTURE: dict[str, Any] = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "shared"
        / "test"
        / "fixtures"
        / "watch-naming.json"
    ).read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", FIXTURE["candidates"], ids=lambda c: repr(c["name"]))
def test_is_candidate(case: dict[str, Any]) -> None:
    assert is_candidate(case["name"]) is case["expected"]


def test_is_candidate_name_length() -> None:
    assert is_candidate("a" * 251 + ".pdf") is True  # 255
    assert is_candidate("a" * 252 + ".pdf") is False  # 256


@pytest.mark.parametrize("case", FIXTURE["workingNames"], ids=lambda c: c["expected"])
def test_working_name(case: dict[str, Any]) -> None:
    assert working_name(case["original"], set(case["taken"])) == case["expected"]


@pytest.mark.parametrize("case", FIXTURE["sourcePaths"], ids=lambda c: c["expected"] or "empty")
def test_watch_source_path(case: dict[str, Any]) -> None:
    assert watch_source_path(case["fields"], case["source"]) == case["expected"]


def test_source_key() -> None:
    assert source_key("Plant A/Intake", "report.docx") == "Plant A/Intake/report.docx"


# --- source_problem ---------------------------------------------------------------------------

NOT_A_SOURCE = "file is not a PDF or Word document (.docx)"
TRACKED = "the Word document has tracked changes: accept or reject them in Word, then upload again"


def docx(body: str = "<w:body><w:p/></w:body>", header: str | None = None) -> bytes:
    types = (
        f'<Types><Override PartName="/word/document.xml" ContentType="{DOCX_MAIN_TYPE}"/></Types>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("word/document.xml", f"<w:document>{body}</w:document>")
        if header is not None:
            z.writestr("word/header1.xml", header)
    return buf.getvalue()


def test_a_pdf_is_a_source() -> None:
    assert source_problem(b"%PDF-1.7\n%%EOF", "a.pdf", 1000) is None


def test_a_docx_is_a_source() -> None:
    assert source_problem(docx(), "a.docx", 10**7) is None


def test_random_bytes_are_not_a_source() -> None:
    assert source_problem(b"hello world", "a.pdf", 1000) == NOT_A_SOURCE


def test_other_zip_is_not_a_source() -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("x.txt", "x")
    assert source_problem(buf.getvalue(), "a.docx", 10**7) == NOT_A_SOURCE


@pytest.mark.parametrize(
    "markup", ["<w:ins w:id='1'>x</w:ins>", "<w:del w:id='1'/>", "<w:moveFrom>x</w:moveFrom>"]
)
def test_tracked_changes_in_the_body_are_refused(markup: str) -> None:
    assert source_problem(docx(f"<w:body>{markup}</w:body>"), "a.docx", 10**7) == TRACKED


def test_tracked_changes_in_a_header_are_refused() -> None:
    assert source_problem(docx(header="<w:ins>x</w:ins>"), "a.docx", 10**7) == TRACKED


def test_lookalike_elements_are_not_tracked_changes() -> None:
    body = "<w:body><w:insideH/><w:delText>x</w:delText></w:body>"
    assert source_problem(docx(body), "a.docx", 10**7) is None


def test_an_oversized_file_is_refused() -> None:
    blob = b"%PDF-" + b"x" * 2048
    assert source_problem(blob, "a.pdf", 1024) == "file is larger than the upload limit"


# --- reason file ------------------------------------------------------------------------------

FACTS = ReasonFacts(
    original_name="report.docx",
    working_name="report_1.docx",
    uploaded_at="2026-10-29 09:00 UTC",
    picked_up_at="2026-10-29 09:05 UTC",
    finished_at="2026-10-29 09:06 UTC",
    outcome_label="Failed",
    detail="The Word document has tracked changes.",
    advice=advice_for("failed"),
    link="https://studio.example.com/#/conversion/b1",
)


def test_advice() -> None:
    assert advice_for("failed") == "Correct the document and upload it to the folder again."
    assert advice_for("changed_in_target") == (
        "An administrator must detach or accept it in CT Studio before it can be loaded again."
    )


def test_reason_markdown_with_a_link() -> None:
    assert reason_markdown(FACTS) == (
        "# report.docx could not be loaded\n"
        "\n"
        "**Result:** Failed\n"
        "\n"
        "The Word document has tracked changes.\n"
        "\n"
        "**What to do:** Correct the document and upload it to the folder again.\n"
        "\n"
        "| | |\n"
        "|---|---|\n"
        "| Original file name | report.docx |\n"
        "| Kept as | report_1.docx |\n"
        "| Uploaded | 2026-10-29 09:00 UTC |\n"
        "| Picked up | 2026-10-29 09:05 UTC |\n"
        "| Finished | 2026-10-29 09:06 UTC |\n"
        "\n"
        "[See the details in CT Studio](https://studio.example.com/#/conversion/b1)\n"
    )


def test_reason_markdown_without_a_link_or_detail() -> None:
    from dataclasses import replace

    text = reason_markdown(replace(FACTS, link=None, detail=None, working_name="report.docx"))
    assert "CT Studio](" not in text
    assert "The Word document" not in text
    assert "Kept as" not in text
    assert text.endswith("| Finished | 2026-10-29 09:06 UTC |\n")


def test_reason_names_no_vendor() -> None:
    text = reason_markdown(FACTS).lower()
    for word in ("s3", "aws", "seaweed", "sink", "endpoint", "bridge", "gotenberg"):
        assert word not in text


# --- fix round 1 ------------------------------------------------------------------------------


def test_working_name_is_case_sensitive() -> None:
    # Object keys are case-sensitive, so `Report.docx` does not clash with `report.docx`.
    assert working_name("Report.docx", {"report.docx"}) == "Report.docx"


def test_working_name_fits_the_name_limit() -> None:
    original = "a" * 251 + ".pdf"  # 255
    name = working_name(original, {original})
    assert name == "a" * 249 + "_1.pdf"
    assert is_candidate(name)
    bigger = working_name(original, {original, name})
    assert bigger == "a" * 249 + "_2.pdf" and len(bigger) == 255


def _docx_with_corrupt(part: str) -> bytes:
    buf = io.BytesIO()
    types = (
        f'<Types><Override PartName="/word/document.xml" ContentType="{DOCX_MAIN_TYPE}"/></Types>'
    )
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types + " " * 3000)
        z.writestr("word/document.xml", "<w:document>" + "<w:p>hello</w:p>" * 500 + "</w:document>")
    raw = bytearray(buf.getvalue())
    with zipfile.ZipFile(io.BytesIO(bytes(raw))) as z:
        info = z.getinfo(part)
    start = info.header_offset + 30 + len(info.filename.encode()) + 0
    raw[start + 4 : start + 24] = bytes([255]) * 20
    return bytes(raw)


def test_a_corrupt_deflate_stream_is_refused_not_raised() -> None:
    assert source_problem(_docx_with_corrupt("word/document.xml"), "a.docx", 10**7) == NOT_A_SOURCE


def test_a_corrupt_content_types_stream_is_no_docx_and_does_not_raise() -> None:
    from ingest_worker.convert import is_docx

    data = _docx_with_corrupt("[Content_Types].xml")
    assert is_docx(data) is False
    assert source_problem(data, "a.docx", 10**7) == NOT_A_SOURCE


def test_an_encrypted_entry_is_refused() -> None:
    raw = bytearray(docx())
    # set the "encrypted" flag (bit 0) on every central directory entry
    at = raw.find(b"PK")
    while at != -1:
        raw[at + 8] |= 1
        at = raw.find(b"PK", at + 4)
    assert source_problem(bytes(raw), "a.docx", 10**7) == NOT_A_SOURCE


def test_a_docx_without_its_main_part_is_refused() -> None:
    buf = io.BytesIO()
    types = (
        f'<Types><Override PartName="/word/document.xml" ContentType="{DOCX_MAIN_TYPE}"/></Types>'
    )
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", types)
    assert source_problem(buf.getvalue(), "a.docx", 10**7) == NOT_A_SOURCE


def test_a_docx_with_pdf_magic_in_its_first_kib_is_refused() -> None:
    # Deliberately stricter than the API's checkSource: the decomposer reads anything with
    # "%PDF-" in its first KiB as a PDF, so such a Word file would be decomposed wrongly.
    types = (
        f'<Types><Override PartName="/word/document.xml" ContentType="{DOCX_MAIN_TYPE}"/></Types>'
    )
    comment_buf = io.BytesIO()
    with zipfile.ZipFile(comment_buf, "w") as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("word/document.xml", "<w:document/>")
        z.writestr("%PDF-.txt", "x")  # the name sits in the first KiB
    data = comment_buf.getvalue()
    assert is_docx(data) and b"%PDF-" in data[:1024]
    assert source_problem(data, "a.docx", 10**7) == NOT_A_SOURCE


def test_the_inflated_budget_counts_every_inspected_part() -> None:
    from ingest_worker.watch.sources import TOO_LARGE_TO_CHECK

    data = docx()
    assert source_problem(data, "a.docx", 10**7, max_inflated=10) == TOO_LARGE_TO_CHECK
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        types_size = z.getinfo("[Content_Types].xml").file_size
        document_size = z.getinfo("word/document.xml").file_size
    total = types_size + document_size
    assert source_problem(data, "a.docx", 10**7, max_inflated=total) is None
    # the content types alone fit, so the budget must count the document too
    assert source_problem(data, "a.docx", 10**7, max_inflated=total - 1) == TOO_LARGE_TO_CHECK
