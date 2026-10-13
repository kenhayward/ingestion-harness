# 0009: Word documents are converted to PDF by a local, isolated converter

**Status:** accepted · 2026-10-13 · [design](../design/word-documents.md)

## Context
Content Transformation Studio (CT Studio) ingests PDFs. People also have Word documents
(`.docx`) whose structure is known in advance, and want to upload them directly. Everything after
upload is built around pages:
- **Text and OCR:** the worker reads text page by page and OCRs image-only pages.
- **Page numbers:** `[page N]` markers drive segmentation and each field's `page`.
- **Templates:** they use `document.pages`, `pageImages`, `chunkPages` and multi-copy splitting
  by page.
- **Review:** the review screen shows rendered page images.

Word files have no fixed pages; pagination exists only once something lays the document out.

## Decision
- **Convert, don't parse.** A `.docx` is converted to PDF before the pipeline, and everything
  after that runs unchanged on the PDF. Reading Word's structure directly (python-docx,
  mammoth) would give better tables but no pages. Every page-based feature would need a
  replacement, including the review screen's source view.
- **Gotenberg, LibreOffice only.** The `converter` compose service runs
  `gotenberg/gotenberg:8.37.0-libreoffice`, pinned to an exact tag like SeaweedFS. It includes
  fonts metrically compatible with Word's defaults (Carlito, Caladea, Liberation), so pages
  usually break where Word breaks them.
- **Isolated, because it parses untrusted files.**
  - **Network:** the converter is only on the compose network `converter` (`internal: true`),
    which it shares with the worker. It has no route out and publishes no ports.
  - **Gotenberg:** `downloadFrom` and webhooks are disabled.
  - **LibreOffice:** outbound fetches are denied to private and public addresses alike.
  - **Callers:** only the worker calls the converter (`CONVERTER_URL`); the API never does.
- **The worker converts**, behind a `DocumentConverter` port (`convert.py`):
  - `load_source` reads the inbox object and converts it when its content types say `.docx`.
    It never trusts a file name, because LibreOffice turns arbitrary bytes into a text PDF.
  - **Identity:** the converted PDF is cached per source sha256 and converter version
    (`converted/{sha256}/{fingerprint}.pdf` in the runs bucket), so re-runs and regressions see
    identical pages.
  - **Errors:** a document the converter rejects goes to `needs_review`. An outage is retried,
    like any transient error. Conversion happens before any model call.
- **A document is its uploaded file.** `documents.sha256` stays the hash of what was uploaded,
  the `.docx` itself. LibreOffice writes a creation date into every PDF, so the PDF's hash
  would differ on every conversion. Prepared text and the OCR cache are keyed by the source
  hash, so sample duplicates, references, regression and holdout coverage work for Word files
  as for PDFs.
- **Data policy:** the converter is local infrastructure, not an LLM provider, so nothing
  leaves the deployment.

## Consequences
- **Pagination:** pages are LibreOffice's layout, not Word's, so page counts can differ
  slightly from what the author sees in Word. `[page N]`, each field's `page` and the review
  screen's page images are all from the converted PDF, so they agree with each other.
- **Image size:** the deployment gains a ~440 MB image and a 2 GB memory limit.
- **Formats:** only `.docx` for now. `.docm` (macros), `.dotx` and other OOXML types are not
  `.docx` and are never converted. `.doc`, `.odt` and `.rtf` would need only a source-kind rule
  each.
- **Upload checks:** the API rejects anything else (design PR 2), including documents with
  tracked changes, whose deleted text would otherwise show in the PDF.
