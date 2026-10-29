"""Watched folders: file naming, the source check and the reason file (pure)."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.convert import DOCX_MAIN_TYPE
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
    for word in ("s3", "aws", "seaweed", "sharepoint", "bridge", "gotenberg"):
        assert word not in text
