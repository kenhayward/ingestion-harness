"""Docling behind the `Analyser` protocol. Imported only by `app.main`."""

from __future__ import annotations

import os
import threading
from importlib.metadata import version
from io import BytesIO
from pathlib import Path

import pypdfium2
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.io import DocumentStream

# The pins; the Dockerfile downloads exactly these revisions into MODELS_DIR.
LAYOUT_REVISION = "8f39ad3c0b4c58e9c2d2c84a38465abf757272d8"
TABLES_REVISION = "fc0f2d45e2218ea24bce5045f58a389aed16dc23"


class DoclingAnalyser:
    def __init__(self, models_dir: Path | None = None) -> None:
        options = PdfPipelineOptions(
            artifacts_path=models_dir or Path(os.environ.get("MODELS_DIR", "/models")),
            do_ocr=False,
            do_table_structure=True,
        )
        options.table_structure_options.mode = TableFormerMode.ACCURATE
        options.table_structure_options.do_cell_matching = True
        self._converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
        )
        # One conversion at a time: the models are big and the converter is shared.
        self._lock = threading.Lock()

    def page_count(self, pdf: bytes) -> int:
        document = pypdfium2.PdfDocument(pdf)
        try:
            return len(document)
        finally:
            document.close()

    def analyse(self, pdf: bytes, first: int, last: int) -> dict:
        source = DocumentStream(name="document.pdf", stream=BytesIO(pdf))
        with self._lock:
            result = self._converter.convert(source, page_range=(first, last))
        return result.document.export_to_dict()

    def fingerprint(self) -> str:
        return (
            f"docling {version('docling')}; "
            f"layout {LAYOUT_REVISION[:8]}; tables {TABLES_REVISION[:8]}"
        )
