# Document types

**Templates are stored in the database** and edited in the app (**Document types** page): create a
document type (v1 draft), edit the draft (saved even while invalid, with live validation), publish
it (immutable from then on), and start a new draft from any version. Drafts can be test-run on a
sample PDF (`test` jobs are reviewable but never published). Templates import/export as YAML.

This directory holds **seed and import material**: on startup the API imports any
`*/v<N>/template.yaml` that is not in the database yet (as published) and never touches existing
versions. Database templates use the built-in prompt with step `instructions` only (no custom
prompt files). Legacy `spec.yaml` versions are still read from here.

Two formats live here, one per version directory:

- **`template.yaml` — document templates (preferred, from PVP v3).** Outputs first: atomic
  `fields` and typed `tables`, an ordered `pipeline` of `extract` and `check` steps, and a
  `review` policy. See [Templates](#templates) below.
- `spec.yaml` — the original spec format (PVP v1/v2), still supported by the engine.

## Templates

```yaml
id: my-doc            # directory specs/my-doc/v1/
version: 1
name: My document
preamble: Domain guidance placed at the top of every prompt.
document: { ocr: auto, copies: {...}, pageMarkers: true, dateOrder: DMY, sections: [...] }
outputs:
  fields:   [{ id, name?, type, description?, enum? }]      # atoms: one value per document
  tables:   [{ id, columns: [{ id, type, description?, enum? }] }]
pipeline:
  - { type: extract, id, fields: [..] | table: x, sections: [..], instructions?, prompt?,
      model?, pageImages?, maxAttempts?, maxTokens?, chunkPages? }
  - { type: check, id, values: table.column | field, reference: ..., aliases?, maxDistance? }
review: { required: always | on_warnings | never }
```

- Types: `text | integer | decimal | date | boolean | enum | list`. Every field and table is
  filled by exactly one extract step; a step fills several fields (one prompt) or a single field
  (its own prompt, e.g. Compound or Execution Date) or one table.
- JSON Schemas are generated from the definitions. Fields come back as
  `{value, evidence, page}`; values are normalised by type (`137·8` → `137.8`, `16/02/2023` →
  `2023-02-16`, enum casing). Unparseable values are kept and listed in `issues.csv`.
- Steps use the built-in prompt (`builtin/extract.md.j2`: preamble, definitions, `instructions`,
  section text) unless `prompt` names a custom Jinja2 file.
- Outputs: `fields.csv` (one row, one column per field), `<table>.csv`, `<check>.csv`,
  `issues.csv`, `document.json` (evidence, pages, checks, issues, review decision).
- Review: `on_warnings` requires review when there are normalisation issues or unmatched check
  values; the reasons are recorded in `document.json`.

## Spec format (spec.yaml)

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
- `extractions[].maxTokens` — output token budget per call (default 16000). A truncated response
  sends the job to review instead of retrying.
- `extractions[].chunkPages` + `mergePath` — run the extraction once per N pages of its single
  section and concatenate the `mergePath` array (top-level array property of the schema). Use
  for large tables; prompts get `chunk` = `{index, count}` (else `None`).
- `extractions[].model` — an alias from `config/llm-providers.yaml` (`default`, `fast`, ...)
  or an explicit `provider/model-id`. A job-level model override wins over this.
- `outputs[]` — CSV (flattened via `rowsPath` + `columns[].path`) or JSON files written to the
  outputs bucket at `{specId}/v{version}/{outputId}/{documentId}.{ext}`.
- `checks[]` — deterministic consistency checks between extractions, e.g. batch numbers in
  results vs the batch list: `{ id, values, reference, aliases?, maxDistance }` with dotted paths
  (`extraction.list[*].field`). Each value is `match` / `alias` / `near` (≤ maxDistance edits) /
  `unmatched`; unused references are listed too. Outputs can read a check like an extraction
  (`from: <check id>`, `rowsPath: rows`); unmatched values add a warning job event.

Both the API (Zod, `packages/shared/src/spec.ts`) and the worker (Pydantic,
`worker/src/ingest_worker/specs.py`) validate every spec here in their test suites.
