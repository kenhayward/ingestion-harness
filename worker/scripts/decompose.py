"""Decompose one .docx or PDF into document.json, report.json and its images (a dev tool).

    uv run --directory worker python scripts/decompose.py <file.docx> <out-dir> \
        [--converter-url URL]
    uv run --directory worker python scripts/decompose.py <file.pdf> <out-dir> \
        --layout-url URL [--ocr-url URL [--ocr-model provider/model] [--ocr-cache DIR]]

The source is told apart by its bytes (`%PDF-` is a PDF), not its name. Drawings, equations and
pictures that need converting are rendered through the document converter at `--converter-url`;
without it, a document that needs rendering fails. A PDF's layout comes from the layout service
at `--layout-url`, which a PDF needs. A PDF's scanned pages are read by the OCR model at
`--ocr-url` (an OpenAI-compatible endpoint; its key from `OCR_API_KEY`), its transcriptions
cached in `--ocr-cache` (default `<out-dir>/../ocr-cache`) so a second run makes no model calls;
without it, a PDF with a scanned page fails. `out-dir` must not exist or must be empty. Image
files are named from image ids, never package paths.

Exit codes:
  0  decomposed
  1  the output folder is not empty (or not a folder), or the source can't be read
  2  the decomposition failed (a fidelity failure, or something that couldn't be read or
     rendered); also argparse's usage errors, by its convention
  3  the source was rejected (unreadable or unsafe)
  4  the converter or the layout service is unavailable (transient: run again later)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections.abc import Sequence
from pathlib import Path

from ingest_worker.convert import ConverterUnavailable, GotenbergConverter
from ingest_worker.decompose import (
    DecompositionFailed,
    DecompositionRejected,
    decompose_docx,
)
from ingest_worker.decompose.pdf import decompose_pdf
from ingest_worker.decompose.pdf.dev_ocr import disk_transcriber
from ingest_worker.decompose.pdf.layout import HttpLayoutAnalyser, LayoutAnalyser, LayoutUnavailable
from ingest_worker.decompose.pdf.transcript import PageTranscriber
from ingest_worker.decompose.render import ConverterRenderer, Renderer, RenderFragment

#: The OCR model `scripts/ocr_pdf.py` uses too.
DEFAULT_OCR_MODEL = "local/olmocr-2-7b-1025"

_UNSAFE = re.compile(r"[^a-z0-9._~-]+")
_MAX_NAME = 100
_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
    "image/x-emf": "emf",
    "image/x-wmf": "wmf",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tif",
}


class _NoConverter:
    """A renderer for runs without `--converter-url`: any rendering need fails the document."""

    def render(self, fragment: RenderFragment) -> bytes | None:
        raise DecompositionFailed("rendering needs --converter-url")


def _suffix(element_id: str) -> str:
    return hashlib.sha256(element_id.encode("utf-8")).hexdigest()[:8]


def file_name(element_id: str) -> str:
    """An id as a file name: lower case, runs outside `[a-z0-9._~-]` as `-`, length capped."""
    name = _UNSAFE.sub("-", element_id.lower()).strip("-.") or "image"
    if len(name) > _MAX_NAME:
        name = f"{name[: _MAX_NAME - 9]}-{_suffix(element_id)}"
    return name


def file_names(ids: Sequence[str]) -> dict[str, str]:
    """A file name for each id; ids whose names would collide each get a short suffix from the
    id itself, so the names don't depend on the order the ids come in."""
    names = {i: file_name(i) for i in ids}
    counts: dict[str, int] = {}
    for name in names.values():
        counts[name] = counts.get(name, 0) + 1
    return {i: f"{n}-{_suffix(i)}" if counts[n] > 1 else n for i, n in names.items()}


def _json(value: object) -> str:
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def _extension(content_type: str | None) -> str:
    return _EXTENSIONS.get(content_type or "", "bin")


def main(
    argv: Sequence[str] | None = None,
    *,
    renderer: Renderer | None = None,
    layout: LayoutAnalyser | None = None,
    transcriber: PageTranscriber | None = None,
) -> int:
    usage = __doc__ or ""
    parser = argparse.ArgumentParser(
        description=usage.splitlines()[0],
        epilog=usage[usage.index("Exit codes:") :] if "Exit codes:" in usage else None,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("source", type=Path, help="a .docx or PDF file")
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--converter-url", help="the document converter's base URL")
    parser.add_argument("--layout-url", help="the PDF layout service's base URL")
    parser.add_argument("--ocr-url", help="the OCR model's OpenAI-compatible base URL")
    parser.add_argument(
        "--ocr-model",
        default=DEFAULT_OCR_MODEL,
        help=f"provider/model (default {DEFAULT_OCR_MODEL})",
    )
    parser.add_argument("--ocr-cache", type=Path, help="the OCR transcriptions' cache folder")
    args = parser.parse_args(argv)

    out: Path = args.out_dir
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        print(f"{out} must not exist or must be an empty directory", file=sys.stderr)
        return 1

    try:
        data = args.source.read_bytes()
    except OSError as exc:
        print(f"cannot read {args.source}: {exc}", file=sys.stderr)
        return 1
    is_pdf = data.startswith(b"%PDF-")
    if is_pdf and layout is None:
        if not args.layout_url:
            print("a PDF needs --layout-url", file=sys.stderr)
            return 2
        layout = HttpLayoutAnalyser(args.layout_url)
    if is_pdf and transcriber is None and args.ocr_url:
        transcriber = disk_transcriber(
            data,
            base_url=args.ocr_url,
            model=args.ocr_model,
            cache_dir=args.ocr_cache or out.resolve().parent / "ocr-cache",
            api_key=os.environ.get("OCR_API_KEY"),
        )
    if not is_pdf and renderer is None:
        renderer = (
            ConverterRenderer(GotenbergConverter(args.converter_url))
            if args.converter_url
            else _NoConverter()
        )
    try:
        if is_pdf:
            assert layout is not None
            result = decompose_pdf(data, layout=layout, transcriber=transcriber)
        else:
            assert renderer is not None
            result = decompose_docx(data, renderer=renderer)
    except DecompositionRejected as exc:
        print(f"rejected: {exc}", file=sys.stderr)
        return 3
    except DecompositionFailed as exc:
        print(f"failed at {exc.at or 'the document'}: {exc.detail}", file=sys.stderr)
        return 2
    except ConverterUnavailable as exc:
        print(f"converter unavailable: {exc}", file=sys.stderr)
        return 4
    except LayoutUnavailable as exc:
        print(f"layout unavailable: {exc}", file=sys.stderr)
        return 4

    doc = result.document
    images = out / "images"
    images.mkdir(parents=True, exist_ok=True)
    (out / "document.json").write_text(
        _json(doc.model_dump(mode="json", by_alias=True)), encoding="utf-8"
    )
    report = [flag.model_dump(mode="json", by_alias=True) for flag in doc.report]
    (out / "report.json").write_text(_json(report), encoding="utf-8")
    names = file_names([image.id for image in doc.images])
    for image in doc.images:
        name = names[image.id]
        (images / f"{name}.{_extension(image.content_type)}").write_bytes(
            result.image_bytes[image.id]
        )
        original = result.originals.get(image.id)
        if original is not None:
            extension = _extension(image.original_content_type)
            (images / f"{name}.orig.{extension}").write_bytes(original)

    print(
        f"{len(doc.sections)} top-level sections, {len(doc.images)} images, "
        f"{len(doc.equations)} equations, {len(doc.notes)} notes, {len(doc.report)} flags"
    )
    for flag in doc.report:
        print(f"  {flag.severity} {flag.code} at {flag.at or '-'}: {flag.message}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
