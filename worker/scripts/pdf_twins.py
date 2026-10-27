"""Score the PDF reader against Word: each .docx is converted to PDF, both are decomposed, and the
PDF's reading is compared with the Word reading (a dev tool).

    uv run --directory worker python scripts/pdf_twins.py <docx-folder> <out-dir> \
        --converter-url URL --layout-url URL [--pdfs <pdf-folder>]

Every `.docx` directly in the folder is a document; names are the file names as given. The output
is one row per document and a total, and `scores.json` in `out-dir` with the same numbers. A
document that fails is a row with its reason, and is not in the total. `--pdfs` adds a row per
real PDF in that folder: its pages, whether its text check passed (or why not), and its flags by
code. `out-dir` must not exist or must be empty.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from collections.abc import Sequence
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
from ingest_worker.decompose.pdf.layout import HttpLayoutAnalyser, LayoutAnalyser, LayoutUnavailable
from ingest_worker.decompose.pdf.scoring import Score, score, total
from ingest_worker.decompose.pdf.textlayer import read_text_layer
from ingest_worker.decompose.render import ConverterRenderer

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


def _twin(path: Path, converter: DocumentConverter, layout: LayoutAnalyser) -> Score | str:
    """The score of one document, or why it has none."""
    data = path.read_bytes()
    try:
        truth = decompose_docx(data, renderer=ConverterRenderer(converter)).document
    except _FAILURES as exc:
        return f"Word reading: {_reason(exc)}"
    try:
        pdf_bytes = converter.to_pdf(data)
    except _FAILURES as exc:
        return f"conversion: {_reason(exc)}"
    try:
        pdf = decompose_pdf(pdf_bytes, layout=layout).document
    except _FAILURES as exc:
        return f"PDF reading: {_reason(exc)}"
    return score(truth, pdf)


def _real_pdf(path: Path, layout: LayoutAnalyser) -> dict[str, object]:
    """Pages, the text check's outcome and the flag counts of one real PDF."""
    data = path.read_bytes()
    row: dict[str, object] = {"name": path.name}
    try:
        row["pages"] = len(read_text_layer(data).pages)
    except DecompositionRejected as exc:
        return row | {"pages": None, "check": _reason(exc), "flags": {}}
    try:
        report = decompose_pdf(data, layout=layout).document.report
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
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        print(f"{out} must not exist or must be an empty directory", file=sys.stderr)
        return 1
    if not args.docx_folder.is_dir() or (args.pdfs is not None and not args.pdfs.is_dir()):
        print("the document folders must be folders", file=sys.stderr)
        return 1

    documents: list[dict[str, object]] = []
    scores: list[Score] = []
    for path in sorted(args.docx_folder.glob("*.docx")):
        result = _twin(path, converter, layout)
        if isinstance(result, str):
            documents.append({"name": path.name, "failed": result})
            print(f"{path.name}  FAILED {result}")
        else:
            scores.append(result)
            documents.append({"name": path.name, **asdict(result)})
            print(_row(path.name, result))
    summary = total(scores)
    print(_row(f"TOTAL ({len(scores)} of {len(documents)} documents)", summary))

    pdfs: list[dict[str, object]] = []
    if args.pdfs is not None:
        for path in sorted(args.pdfs.glob("*.pdf")):
            row = _real_pdf(path, layout)
            pdfs.append(row)
            flags = ", ".join(f"{c} {n}" for c, n in sorted(dict(row["flags"]).items())) or "none"  # type: ignore[call-overload]
            print(f"{row['name']}  pages {row['pages']}  {row['check']}  flags: {flags}")

    out.mkdir(parents=True, exist_ok=True)
    (out / "scores.json").write_text(
        json.dumps(
            {"documents": documents, "total": asdict(summary), "pdfs": pdfs},
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
