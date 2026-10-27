"""The OCR model for the PDF dev tools (`scripts/decompose.py`, `scripts/pdf_twins.py`): a page
transcriber over one OpenAI-compatible endpoint, its transcriptions cached in a folder on disk
by the PDF's SHA-256, the model and the page, so a second run makes no model calls and reads the
same text (spec section 15.5). The worker's own transcriber is `pipeline.JobTranscriber`."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ingest_worker.decompose.pdf.transcript import Transcript
from ingest_worker.llm.base import LLMProvider
from ingest_worker.ocr import OcrSettings, ocr_page, render_page_png

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


class DiskTranscriber:
    """A `PageTranscriber` reading `pdf` through `provider`'s `model_id`."""

    def __init__(
        self,
        pdf: bytes,
        *,
        provider: LLMProvider,
        model_id: str,
        cache_dir: Path,
        settings: OcrSettings | None = None,
        concurrency: int = 4,
    ) -> None:
        self.pdf = pdf
        self.provider = provider
        self.model_id = model_id
        self.settings = settings or OcrSettings(model=f"{provider.name}/{model_id}")
        self.concurrency = concurrency
        model = _UNSAFE.sub("_", f"{provider.name}/{model_id}")
        self.folder = cache_dir / hashlib.sha256(pdf).hexdigest() / model

    def transcribe(self, pages: Sequence[int]) -> dict[int, Transcript]:
        out: dict[int, Transcript] = {}
        todo = []
        for index in pages:
            text = self.folder / f"page-{index + 1}.md"
            if text.exists():
                rotation = self.folder / f"page-{index + 1}.rotation"
                degrees = int(rotation.read_text("ascii")) if rotation.exists() else 0
                out[index] = Transcript(text.read_text("utf-8"), degrees)
            else:
                todo.append(index)

        def run(index: int) -> tuple[int, Transcript]:
            page = ocr_page(
                self.provider, self.model_id, self.pdf, index, self.settings, render_page_png
            )
            self.folder.mkdir(parents=True, exist_ok=True)
            (self.folder / f"page-{index + 1}.md").write_text(page.raw[-1], "utf-8")
            if page.rotation % 360:
                (self.folder / f"page-{index + 1}.rotation").write_text(
                    str(page.rotation % 360), "ascii"
                )
            return index, Transcript(page.raw[-1], page.rotation % 360)

        with ThreadPoolExecutor(max_workers=max(1, self.concurrency)) as pool:
            for index, transcript in pool.map(run, todo):
                out[index] = transcript
        return dict(sorted(out.items()))


def disk_transcriber(
    pdf: bytes, *, base_url: str, model: str, cache_dir: Path, api_key: str | None = None
) -> DiskTranscriber:
    """A transcriber over the OpenAI-compatible endpoint at `base_url`, for `model`
    (`provider/model-id`, as `scripts/ocr_pdf.py` takes it)."""
    import openai

    from ingest_worker.llm.openai_providers import OpenAIChatProvider

    name, _, model_id = model.partition("/")
    client = openai.OpenAI(base_url=base_url, api_key=api_key or "not-needed", timeout=600)
    provider = OpenAIChatProvider(name or "local", client, max_tokens_param="max_tokens")
    return DiskTranscriber(pdf, provider=provider, model_id=model_id or model, cache_dir=cache_dir)
