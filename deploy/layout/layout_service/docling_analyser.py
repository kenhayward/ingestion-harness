"""Docling behind the `Analyser` protocol. Imported only by `app.main`."""

from __future__ import annotations

import os
import threading
from importlib.metadata import version
from io import BytesIO
from pathlib import Path

import pypdfium2
import torch
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.io import DocumentStream

from layout_service.app import AnalysisFailed, require_success
from layout_service.device import failure, prepare

# The pins; the Dockerfile downloads exactly these revisions into MODELS_DIR.
LAYOUT_REVISION = "8f39ad3c0b4c58e9c2d2c84a38465abf757272d8"
TABLES_REVISION = "fc0f2d45e2218ea24bce5045f58a389aed16dc23"


class DoclingAnalyser:
    def __init__(self, models_dir: Path | None = None) -> None:
        # Before the models load: on a GPU, full precision (`prepare`).
        self._device = prepare(torch)
        options = PdfPipelineOptions(
            artifacts_path=models_dir or Path(os.environ.get("MODELS_DIR", "/models")),
            do_ocr=False,
            do_table_structure=True,
        )
        options.table_structure_options.mode = TableFormerMode.ACCURATE
        options.table_structure_options.do_cell_matching = True
        self._options = options
        self._converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
        )
        # One conversion at a time: the models are big and the converter is shared.
        self._lock = threading.Lock()

    def page_count(self, pdf: bytes) -> int:
        # pdfium is not thread-safe, and Docling's PDF backend uses it inside `analyse`.
        with self._lock:
            document = pypdfium2.PdfDocument(pdf)
            try:
                return len(document)
            finally:
                document.close()

    def analyse(self, pdf: bytes, first: int, last: int, timeout: float) -> dict:
        source = DocumentStream(name="document.pdf", stream=BytesIO(pdf))
        with self._lock:
            try:
                # Loads the models on the first request: on a GPU, out of memory can be here too.
                self._set_timeout(timeout)
                result = self._converter.convert(source, page_range=(first, last))
            except Exception as error:
                self._free()
                raise failure(self._device, error) from error
        # A timeout ends the conversion early with a partial document: it is refused, as is
        # anything short of full success (on a GPU, left to the CPU service: `failure`).
        try:
            require_success(result.status.value, timed_out=result.has_timeout_errors())
        except AnalysisFailed as error:
            self._free()
            raise failure(self._device, str(error)) from error
        return result.document.export_to_dict()

    def _free(self) -> None:
        """After a failure on a GPU, the memory the failed conversion held is given back."""
        if self._device == "cuda":
            torch.cuda.empty_cache()

    def _set_timeout(self, timeout: float) -> None:
        """Docling's `document_timeout` for the next conversion. It is set on the cached
        pipeline's own copy of the options: the converter caches pipelines by a hash of the
        options it was given, so changing those would load the models again for each limit."""
        pipeline = self._converter._get_pipeline(InputFormat.PDF)
        assert pipeline is not None
        pipeline.pipeline_options = self._options.model_copy(update={"document_timeout": timeout})

    def fingerprint(self) -> str:
        return (
            f"docling {version('docling')}; "
            f"layout {LAYOUT_REVISION[:8]}; tables {TABLES_REVISION[:8]}; {self._device}"
        )

