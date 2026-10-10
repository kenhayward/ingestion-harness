# Ingestion Harness

Ingest PDF documents with a known structure, extract their contents through a spec-driven LLM
prompt harness, and land validated **CSV / JSON** in S3-compatible storage (SeaweedFS).

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
- [docs/runners.md](docs/runners.md) — self-hosted GitHub runner setup
- [deploy/README.md](deploy/README.md) — deployment and operations
- [docs/adr/](docs/adr/) — architecture decision records
