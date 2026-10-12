"""Record OCR text for a PDF using the worker's real OCR path (dev tool, hits a live model).

    uv run python scripts/ocr_pdf.py "../docs/samples/IMAGE process validation protocol.pdf" \
        --out tests/fixtures/samples/pvp-image-ocr.json

Endpoint/model come from env: OCR_BASE_URL and OCR_API_KEY (falling back to LOCAL_LLM_BASE_URL /
LOCAL_LLM_API_KEY), OCR_MODEL (provider/model).
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import openai
from pypdf import PdfReader

from ingest_worker.llm.openai_providers import OpenAIChatProvider
from ingest_worker.ocr import OcrSettings, ocr_page, render_page_png


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", type=pathlib.Path)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    parser.add_argument("--concurrency", type=int, default=4)
    args = parser.parse_args()

    model_ref = os.environ.get("OCR_MODEL", "local/olmocr-2-7b-1025")
    model_id = model_ref.partition("/")[2]
    client = openai.OpenAI(
        base_url=os.environ.get("OCR_BASE_URL") or os.environ["LOCAL_LLM_BASE_URL"],
        api_key=os.environ.get("OCR_API_KEY")
        or os.environ.get("LOCAL_LLM_API_KEY")
        or "not-needed",
        timeout=600,
    )
    provider = OpenAIChatProvider("local", client, max_tokens_param="max_tokens")
    settings = OcrSettings(model=model_ref)
    pdf = args.pdf.read_bytes()
    count = len(PdfReader(args.pdf).pages)

    started = time.time()

    def run(index: int) -> str:
        page = ocr_page(provider, model_id, pdf, index, settings, render_page_png)
        print(
            f"page {index + 1}/{count} rotation={page.rotation} chars={len(page.text)}",
            file=sys.stderr,
        )
        return page.text

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        pages = list(pool.map(run, range(count)))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {"source": args.pdf.name, "ocr_model": model_ref, "pages": pages},
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"{count} pages in {time.time() - started:.0f}s -> {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
