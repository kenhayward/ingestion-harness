# Content Transformation Studio

[![CI](https://github.com/kenhayward/ingestion-harness/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kenhayward/ingestion-harness/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Content Transformation Studio (CT Studio) ingests PDF documents with a known structure, extracts
their contents through a spec-driven LLM prompt harness, and lands validated **CSV / JSON** in S3-compatible storage (SeaweedFS).

The code, packages and images keep the project's original name, `ingestion-harness`; see [docs/brand/BRAND.md](docs/brand/BRAND.md).

```
 app (React/nginx) ──► api (Fastify) ──► Postgres (documents, jobs queue, models)
                          │                    ▲
                          ▼                    │ claim (SKIP LOCKED)
                 SeaweedFS inbox ◄──────── worker (Python) ──► LLM providers
                                               │               (Anthropic / OpenAI / local)
                                               ▼
                               SeaweedFS outputs (CSV/JSON) + runs (audit)
```

## Quick start (local)

Prerequisites: Node 24, Python 3.13 + [uv](https://docs.astral.sh/uv/), Docker.

```bash
npm ci
cd worker && uv sync && cd ..
npm run check                       # lint, typecheck, all tests (TS + Python)
```

Run the full stack in Docker:

```bash
cp deploy/.env.example deploy/.env  # set passwords + ANTHROPIC_API_KEY / OPENAI_API_KEY
deploy/scripts/deploy.sh            # Windows: deploy\scripts\deploy.ps1
```

Then open http://localhost:8081, pick a document type, upload a PDF.

Or run services on the host against containerised infra:

```bash
deploy/scripts/dev-infra.sh up      # Postgres + SeaweedFS, migrations, buckets
npm run dev:api                     # :3000 (export DATABASE_URL / S3_* first)
npm run dev:web                     # :5173, proxies /api
cd worker && uv run ingest-worker
```

## Adding a document type

The shipped example is `specs/process-validation-protocol/v1/`, developed against the two
public samples in [docs/samples/](docs/samples/README.md) (a text-layer template and a 60-page
scanned protocol-cum-report).

1. Copy `specs/process-validation-protocol/v1/` to `specs/<your-id>/v1/`.
2. Define sections (regex anchors), extractions (prompt + JSON Schema), and outputs (CSV/JSON).
3. Put real samples in `docs/samples/` and write tests against them first, like
   `worker/tests/test_pvp_spec.py` (scanned samples: record OCR with `worker/scripts/ocr_pdf.py`).
4. Run `npm run check` — both the API and the worker validate every spec, and every extraction
   schema must be strict-structured-output compatible.

See [specs/README.md](specs/README.md) for the format.

## Docs

- [CLAUDE.md](CLAUDE.md) — working agreement, TDD workflow, commands
- [docs/architecture.md](docs/architecture.md) — components, data flow, failure handling
- [docs/runners.md](docs/runners.md) — CI (GitHub-hosted) and self-hosted deploy runners
- [deploy/README.md](deploy/README.md) — deployment and operations
- [docs/adr/](docs/adr/) — architecture decision records

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the test-first
workflow and the PR process. Please follow the [code of conduct](CODE_OF_CONDUCT.md), and report
security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution,
including the public sample documents in `docs/samples/`.
