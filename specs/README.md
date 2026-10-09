# Document specs

One directory per document type, one subdirectory per immutable version:

```
specs/<spec-id>/v<N>/spec.yaml
specs/<spec-id>/v<N>/prompts/*.md.j2
```

- `document.sections[].anchor` — multiline regex marking where a section starts in the
  extracted PDF text. Sections run until the next anchor match.
- `extractions[]` — one LLM call per extraction: the listed sections are rendered into the
  Jinja2 prompt, and the response must validate against `schema` (JSON Schema). Invalid
  responses are retried with the validation errors fed back, up to `maxAttempts`.
- `extractions[].model` — an alias from `config/llm-providers.yaml` (`default`, `fast`, ...)
  or an explicit `provider/model-id`. A job-level model override wins over this.
- `outputs[]` — CSV (flattened via `rowsPath` + `columns[].path`) or JSON files written to the
  outputs bucket at `{specId}/v{version}/{outputId}/{documentId}.{ext}`.

Both the API (Zod, `packages/shared/src/spec.ts`) and the worker (Pydantic,
`worker/src/ingest_worker/specs.py`) validate every spec here in their test suites.
