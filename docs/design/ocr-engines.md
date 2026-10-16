# OCR engines: a benchmark on a real scan

Is a non-LLM OCR engine a faster replacement for the vision model that reads image-only pages
(`worker/src/ingest_worker/ocr.py`, default olmOCR 2)? Measured on 16 October 2026 against a real
scanned document, on the development host. The short answer: the vision model was slow because of
how LM Studio had loaded it, not because it is an LLM. Loaded properly, olmOCR reads a page in
4-6 s, as fast as the CPU engines, and it was the only engine with no mistakes.

## Setup

- **Document:** a 52-page scanned document, images only (no text layer): prose, dense numeric
  tables, charts. Word sources never need OCR (they are converted to PDF with a full text layer),
  so scans like this are what OCR is for.
- **Host:** Intel Core Ultra 7 270K Plus (24 threads), 127 GB RAM, RTX 5090 (32 GB). The CPU
  engines ran in Linux containers on Docker Desktop with **8 CPUs and 10 GB**, the same VM the
  worker runs in, so these are the figures a CPU engine inside the worker would get.
- **Pages:** rendered at 200 dpi for the CPU engines, and at 1288 px on the longest side for the
  vision models (as production sends them), with production's olmOCR prompt, temperature 0.
- **Accuracy**, scored by hand against the page images:
  - *Table* (one page): the 156 numbers of a dense numeric table (4 groups of 6 rows × 3 value
    columns, plus summary rows) in row order. A value in the wrong row or column counts as wrong.
  - *Prose* (one page): the share of a paragraph's words read correctly, in order.
  - *Symbols* (one page): the 24 ≤, 12 ≥ and 6 r² signs of a table.

## Results

| Engine | Runs on | s / page | Memory | Table | Prose | ≤ / ≥ / r² | Output |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **olmOCR 2 7B** (Q4_K_M), loaded fully on the GPU, 32k context, 4 slots | RTX 5090 | **5.5** one at a time, **4.1** four at once | ~10.5 GB VRAM | **156/156** | **100%** | **24/24 12/12 6/6** | HTML tables, merged cells kept |
| olmOCR 2 7B, as LM Studio had loaded it (8k context, automatic GPU offload) | RTX 5090 | 35.4 one at a time; **every request fails** four at once | 6 GB | 156/156 | 100% | all | as above |
| qwen3.8-27b-mtp (the current OCR setting), as loaded | RTX 5090 | 53.4 (3 pages) | 18.5 GB | 156/156 | 100% | all | HTML tables |
| PaddleOCR 3.7, PP-OCRv6 text lines | 8 Linux CPUs | 5.4 | 3.0 GB | 156/156 | 100% | all | text lines, no table structure |
| PaddleOCR 3.7, PP-StructureV3 (layout + tables) | 8 Linux CPUs | 9.0 | 5.8 GB | 147/156 | 94.8% | all | HTML tables, columns shifted |
| Docling 2.140 (RapidOCR + TableFormer, accurate) | 8 Linux CPUs | 7.7 | 2.6 GB | 147/156 | 98.9% | 23/24 12/12 6/6 | markdown tables, right structure |
| Docling 2.140, same | 16 Windows threads | 3.9 | 2.7 GB | same | same | same | same |

Tesseract was left out at the user's request.

### What went wrong where

- **LM Studio's load of olmOCR** caused both the slowness and the production failures:
  - **Speed:** generation ran at 32 tokens/s. Reloaded with `--gpu max`, the same model ran at
    216 tokens/s alone, and about 115 tokens/s per request with four at once. Reading the image
    took about 1 s either way; generation was the bottleneck.
  - **Failures:** a page needs about 1,800 tokens for the image plus up to ~2,400 of output.
    llama.cpp splits a model's context across its parallel slots, so 8,192 tokens over 4 slots
    leaves about 2,048 per request. With `OCR_CONCURRENCY` 4, every request fails with
    *Context size has been exceeded*, the error behind the OCR jobs that went to review today.
  - **Other models:** unloading the other local models changed nothing (35.4 s per page either
    way), so memory pressure from them was not the cause.
- **Docling** keeps the table structure, but silently misreads one value: a two-decimal number
  (`d.dd`) came out four different wrong ways in different rows of the scored table (decimal point
  dropped, digits doubled or lost). Every other cell was right. A plausible wrong number in a
  results table is the worst kind of error, because nothing flags it.
- **PP-StructureV3** builds tables, but some rows shift one column, putting a value under the
  wrong heading, and 9 cells are lost.
- **PaddleOCR text lines** read every value and symbol correctly, in reading order. There is no
  table structure, so the extraction model has to rebuild rows from lines. That works for
  regular grids like the scored table, and is risky for merged or ragged tables.
- **PaddlePaddle 3.3.1** fails on CPU with oneDNN (`ConvertPirAttribute2RuntimeAttribute not
  support`), on Linux and Windows alike. 3.2.2 works. Without oneDNN, on Windows, PaddleOCR
  takes about 40 s per page.

## Recommendation

1. **Fix the OCR model's load in LM Studio first:**
   - GPU offload `max`.
   - Context at least 6,000 × `OCR_CONCURRENCY` (32,768 for 4).
   - Parallel slots equal to `OCR_CONCURRENCY`.

   Then point the OCR setting (Administration > Models > Pipeline models) back at olmOCR 2. That
   makes LLM OCR about 7× faster than today (35 s to 4-5 s per page) and stops the context
   failures. qwen3.8-27b was just as accurate on the scored pages, but about 10× slower and three
   times the memory. The `lms` equivalent:

   ```bash
   lms load allenai/olmocr-2-7b --gpu max --context-length 32768 --parallel 4
   ```

   Save the same settings as the model's defaults in LM Studio, so a just-in-time load uses them
   too.
2. **No CPU engine as the default.** On this host, tuned olmOCR is as fast as the best CPU engine
   and the only one with no errors. A hybrid (a CPU engine first, the vision model for tables)
   saves little when the vision model already takes 4-5 s per page.
3. **A CPU engine is worth adding only for hosts without a usable GPU, or as a fallback when the
   OCR endpoint is down.** In that case, use PaddleOCR text lines (most accurate on CPU, 5.4 s per
   page on 8 cores, 3 GB), with paddlepaddle pinned to 3.2.2. Run it as a sidecar service like the
   Word converter (`converter`, Gotenberg), and register it as a second OCR backend beside
   `complete_vision`. Its output must be cached under its own key: the OCR cache is keyed by
   source sha256 plus OCR settings, so the engine has to be part of those settings. Docling only
   if its table structure matters more than its digit errors, and only with a check that values
   are plausible.

## Not covered

- One document, and a clean print scan. Faxes, skewed pages, handwriting and stamps would hurt
  the CPU engines more than the vision models.
- Only a few pages were scored by hand. The vision models' 100% means no errors on those pages,
  not none anywhere.
- GPU builds of PaddleOCR and Docling were not tried: the worker has no GPU.
- The benchmark scripts are not committed. They were throwaway (`C:\ob\scripts` on the
  development host): render, run each engine, score against hand-made keys.
