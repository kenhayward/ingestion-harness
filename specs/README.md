# Document specs

One directory per document type, one subdirectory per immutable version:

```
specs/<spec-id>/v<N>/spec.yaml
specs/<spec-id>/v<N>/prompts/*.md.j2
```

- `document.ocr` — `auto` (default) OCRs pages whose text layer has fewer than `ocr.minChars`
  non-space characters; `always` OCRs every page; `never` uses the text layer only. OCR'd
  tables are flattened to one line per row (cells separated by two spaces), so anchors should
  tolerate variable whitespace (`\s+`).
- `document.copies` — `{ anchor, select: last|first }` for PDFs that contain several copies of
  the document (e.g. the approved blank protocol followed by the executed copy). The document is
  split at pages where `anchor` matches and one copy is kept.
- `document.sections[].anchor` — multiline regex marking where a section starts in the
  extracted PDF text. Sections run until the next anchor match. If two anchors match at the
  same position, the earlier-declared section is empty (a start-of-text catch-all yields).
- `extractions[]` — one LLM call per extraction: the listed sections are rendered into the
  Jinja2 prompt, and the response must validate against `schema` (JSON Schema). Invalid
  responses are retried with the validation errors fed back, up to `maxAttempts`.
- `extractions[].pageImages` — 1-based PDF pages rendered and sent as images with the prompt
  (vision-capable model required). Use for content OCR drops, e.g. page headers.
- `extractions[].model` — an alias from `config/llm-providers.yaml` (`default`, `fast`, ...)
  or an explicit `provider/model-id`. A job-level model override wins over this.
- `outputs[]` — CSV (flattened via `rowsPath` + `columns[].path`) or JSON files written to the
  outputs bucket at `{specId}/v{version}/{outputId}/{documentId}.{ext}`.

Both the API (Zod, `packages/shared/src/spec.ts`) and the worker (Pydantic,
`worker/src/ingest_worker/specs.py`) validate every spec here in their test suites.
