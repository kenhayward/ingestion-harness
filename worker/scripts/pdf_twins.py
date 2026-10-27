"""Score the PDF reader against Word: each .docx is converted to PDF, both are decomposed, and the
PDF's reading is compared with the Word reading (a dev tool).

    uv run --directory worker python scripts/pdf_twins.py <docx-folder> <out-dir> \
        --converter-url URL --layout-url URL [--pdfs <pdf-folder>] \
        [--rasterise] [--ocr-url URL [--ocr-model provider/model] [--ocr-cache DIR]]

Every `.docx` directly in the folder is a document; names are the file names as given. The output
is one row per document and a total, and `scores.json` in `out-dir` with the same numbers. A
document that fails is a row with its reason, and is not in the total. `--pdfs` adds a row per
real PDF in that folder: its pages, whether its text check passed (or why not), and its flags by
code. `out-dir` must not exist or must be empty.

`--rasterise` renders each twin's PDF to an image-only PDF first (200 dpi), so the OCR route is
scored on documents whose answer is known (spec section 15.5). Scanned pages, there or among
`--pdfs`, are read by the OCR model at `--ocr-url` (its key from `OCR_API_KEY`), cached in
`--ocr-cache` (default `<out-dir>/../ocr-cache`) so a second run makes no model calls.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import asdict
from pathlib import Path

from ingest_worker.convert import (
    ConversionRejected,
    ConverterUnavailable,
    DocumentConverter,
    GotenbergConverter,
)
from ingest_worker.decompose import (
    DecompositionFailed,
    DecompositionRejected,
    decompose_docx,
)
from ingest_worker.decompose.pdf import decompose_pdf
from ingest_worker.decompose.pdf.dev_ocr import disk_transcriber
from ingest_worker.decompose.pdf.layout import HttpLayoutAnalyser, LayoutAnalyser, LayoutUnavailable
from ingest_worker.decompose.pdf.rasterise import rasterise_pdf
from ingest_worker.decompose.pdf.scoring import Score, score, total
from ingest_worker.decompose.pdf.textlayer import read_text_layer
from ingest_worker.decompose.pdf.transcript import PageTranscriber
from ingest_worker.decompose.render import ConverterRenderer

#: Makes the transcriber for a PDF's bytes (None: no OCR model).
Transcribers = Callable[[bytes], PageTranscriber] | None
#: The OCR model `scripts/ocr_pdf.py` uses too.
DEFAULT_OCR_MODEL = "local/olmocr-2-7b-1025"
#: Rasterised twins' resolution (spec section 15.5).
RASTER_DPI = 200

_FAILURES = (
    DecompositionFailed,
    DecompositionRejected,
    ConversionRejected,
    ConverterUnavailable,
    LayoutUnavailable,
)


def _reason(exc: Exception) -> str:
    if isinstance(exc, DecompositionFailed):
        return f"failed at {exc.at or 'the document'}: {exc.detail}"
    return f"{type(exc).__name__}: {exc}"


def _twin(
    path: Path,
    converter: DocumentConverter,
    layout: LayoutAnalyser,
    transcribers: Transcribers = None,
    *,
    rasterise: bool = False,
) -> Score | str:
    """The score of one document, or why it has none; its PDF rasterised first when
    `rasterise`."""
    data = path.read_bytes()
    try:
        truth = decompose_docx(data, renderer=ConverterRenderer(converter)).document
    except _FAILURES as exc:
        return f"Word reading: {_reason(exc)}"
    try:
        pdf_bytes = converter.to_pdf(data)
    except _FAILURES as exc:
        return f"conversion: {_reason(exc)}"
    if rasterise:
        pdf_bytes = rasterise_pdf(pdf_bytes, dpi=RASTER_DPI)
    transcriber = transcribers(pdf_bytes) if transcribers is not None else None
    try:
        pdf = decompose_pdf(pdf_bytes, layout=layout, transcriber=transcriber).document
    except _FAILURES as exc:
        return f"PDF reading: {_reason(exc)}"
    return score(truth, pdf)


def _real_pdf(
    path: Path, layout: LayoutAnalyser, transcribers: Transcribers = None
) -> dict[str, object]:
    """Pages, the text check's outcome and the flag counts of one real PDF."""
    data = path.read_bytes()
    row: dict[str, object] = {"name": path.name}
    try:
        row["pages"] = len(read_text_layer(data).pages)
    except DecompositionRejected as exc:
        return row | {"pages": None, "check": _reason(exc), "flags": {}}
    try:
        transcriber = transcribers(data) if transcribers is not None else None
        report = decompose_pdf(data, layout=layout, transcriber=transcriber).document.report
    except _FAILURES as exc:
        return row | {"check": _reason(exc), "flags": {}}
    return row | {"check": "text check passed", "flags": dict(Counter(f.code for f in report))}


def _pct(n: int, d: int) -> str:
    return f"{n}/{d}"


def _rate(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.3f}"


def _row(name: str, s: Score) -> str:
    return (
        f"{name}  headings {_pct(s.headings_found, s.headings_total)}"
        f" (level {_pct(s.levels_right, s.headings_found)})"
        f"  tables {_pct(s.tables_found, s.tables_total)}"
        f" (shape {_pct(s.shape_right, s.tables_found)}, extra {s.tables_extra})"
        f"  cells {_pct(s.cells_right, s.cells_total)}"
        f"  recall {_rate(s.words_recall)}  precision {_rate(s.words_precision)}"
    )


def main(
    argv: Sequence[str] | None = None,
    *,
    converter: DocumentConverter | None = None,
    layout: LayoutAnalyser | None = None,
    transcribers: Transcribers = None,
) -> int:
    usage = __doc__ or ""
    parser = argparse.ArgumentParser(
        description=usage.splitlines()[0], formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("docx_folder", type=Path)
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--converter-url", help="the document converter's base URL")
    parser.add_argument("--layout-url", help="the PDF layout service's base URL")
    parser.add_argument("--pdfs", type=Path, help="a folder of real PDFs to report on as well")
    parser.add_argument(
        "--rasterise", action="store_true", help="score the OCR route: twins' PDFs as images"
    )
    parser.add_argument("--ocr-url", help="the OCR model's OpenAI-compatible base URL")
    parser.add_argument(
        "--ocr-model",
        default=DEFAULT_OCR_MODEL,
        help=f"provider/model (default {DEFAULT_OCR_MODEL})",
    )
    parser.add_argument("--ocr-cache", type=Path, help="the OCR transcriptions' cache folder")
    args = parser.parse_args(argv)

    if converter is None:
        if not args.converter_url:
            parser.error("--converter-url is required")
        converter = GotenbergConverter(args.converter_url)
    if layout is None:
        if not args.layout_url:
            parser.error("--layout-url is required")
        layout = HttpLayoutAnalyser(args.layout_url)
    out: Path = args.out_dir
    if transcribers is None and args.ocr_url:
        cache = args.ocr_cache or out.resolve().parent / "ocr-cache"

        def transcribers(data: bytes) -> PageTranscriber:
            return disk_transcriber(
                data,
                base_url=args.ocr_url,
                model=args.ocr_model,
                cache_dir=cache,
                api_key=os.environ.get("OCR_API_KEY"),
            )

    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        print(f"{out} must not exist or must be an empty directory", file=sys.stderr)
        return 1
    if not args.docx_folder.is_dir() or (args.pdfs is not None and not args.pdfs.is_dir()):
        print("the document folders must be folders", file=sys.stderr)
        return 1

    documents: list[dict[str, object]] = []
    scores: list[Score] = []
    for path in sorted(args.docx_folder.glob("*.docx")):
        result = _twin(path, converter, layout, transcribers, rasterise=args.rasterise)
        if isinstance(result, str):
            documents.append({"name": path.name, "failed": result})
            print(f"{path.name}  FAILED {result}")
        else:
            scores.append(result)
            documents.append({"name": path.name, **asdict(result)})
            print(_row(path.name, result))
    summary = total(scores)
    route = " rasterised (OCR route)" if args.rasterise else ""
    print(_row(f"TOTAL{route} ({len(scores)} of {len(documents)} documents)", summary))

    pdfs: list[dict[str, object]] = []
    if args.pdfs is not None:
        for path in sorted(args.pdfs.glob("*.pdf")):
            row = _real_pdf(path, layout, transcribers)
            pdfs.append(row)
            flags = ", ".join(f"{c} {n}" for c, n in sorted(dict(row["flags"]).items())) or "none"  # type: ignore[call-overload]
            print(f"{row['name']}  pages {row['pages']}  {row['check']}  flags: {flags}")

    out.mkdir(parents=True, exist_ok=True)
    (out / "scores.json").write_text(
        json.dumps(
            {
                "route": "rasterised (OCR route)" if args.rasterise else "born-digital",
                "documents": documents,
                "total": asdict(summary),
                "pdfs": pdfs,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
