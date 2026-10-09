# CLAUDE.md

Ingestion harness: ingests PDFs whose structure is known in advance, extracts their contents
through an LLM prompt harness, and writes validated CSV/JSON to S3 (SeaweedFS).

## Architecture in one paragraph

`app` (React, served by nginx) → `api` (Fastify, Node 24/TypeScript) stores the uploaded PDF in
the SeaweedFS **inbox** bucket and inserts a `documents` row + `jobs` row in Postgres. The
`worker` (Python 3.13) claims jobs with `SELECT … FOR UPDATE SKIP LOCKED`, extracts page text,
segments it into sections using the document **spec**, runs one LLM call per spec extraction
(JSON Schema-constrained, validated, retried with errors fed back), and writes CSV/JSON to the
**outputs** bucket plus a prompt/response audit trail to the **runs** bucket. Full detail:
[docs/architecture.md](docs/architecture.md). Decisions: [docs/adr/](docs/adr/).

## Layout

```
apps/api/            Fastify API          src/app.ts = composition root (buildApp(deps))
apps/web/            React + Vite UI      components take an `Api` port as a prop
packages/shared/     Zod schemas + types shared by api & web (spec format, job DTOs, key helpers)
worker/              Python worker (uv)   src/ingest_worker/{pipeline,extract,segment,outputs,queue,llm/}
specs/<id>/v<N>/     Document specs: spec.yaml + prompts/*.md.j2 (immutable once published)
config/              llm-providers.yaml (providers, discovery, model aliases)
db/migrations/       Forward-only SQL migrations (shared by api and worker)
deploy/              docker compose, Dockerfiles, deploy/dev scripts (.sh + .ps1)
.github/workflows/   CI + deploy, on self-hosted runners only
```

## Commands

Run from the repo root unless noted. Dev host is Windows; scripts exist in `.sh` and `.ps1`.

| Task | Command |
| --- | --- |
| Install | `npm ci` and `cd worker && uv sync` |
| **Everything CI checks** | `npm run check` |
| TS tests (all / watch / one file) | `npm test` / `npm run test:watch` / `npx vitest run apps/api/test/jobs.test.ts` |
| TS tests for one project | `npx vitest run --project api` (`shared`, `api`, `web`) |
| Typecheck / lint / format | `npm run typecheck` / `npm run lint` / `npm run format` |
| Worker tests (all / one) | `npm run worker:test` / `cd worker && uv run pytest tests/test_extract.py -k retries` |
| Worker lint + types | `npm run worker:lint` (ruff check, ruff format --check, mypy --strict) |
| Local infra (Postgres + SeaweedFS) | `deploy/scripts/dev-infra.ps1 up` (or `.sh`) |
| Run services on host | `npm run dev:api`, `npm run dev:web`, `cd worker && uv run ingest-worker` |
| Full stack in Docker | `deploy/scripts/deploy.sh` (needs `deploy/.env`, copy from `.env.example`) |

## Test-driven development — how we work here

1. **Red first.** For every behaviour change, write or extend a failing test, run it, and see
   it fail for the expected reason before touching implementation. Bug fixes start with a test
   that reproduces the bug.
2. **Green minimally**, then refactor with the suite green. Run the narrowest test command while
   iterating, and `npm run check` before declaring work done.
3. **Never weaken a test to make it pass** (deleting assertions, loosening matchers, adding
   skips). If a test is wrong, say why and fix it deliberately.
4. **Ports and adapters keep tests fast and offline.** Unit tests never touch the network,
   Postgres, SeaweedFS, or a real LLM:
   - API: `buildApp({ repo, store, specs, … })` with `MemoryRepo` + `MemoryObjectStore`;
     exercise routes with `app.inject()` (see `apps/api/test/helpers.ts`).
   - Web: components receive an `Api` prop; tests use `fakeApi()` from `apps/web/test/fake-api.ts`
     and Testing Library queries by role/label (not class names).
   - Worker: `PipelineDeps` takes `MemoryObjectStore`, a `TextExtractor` lambda (no real PDFs
     needed), and a `ModelRegistry` of `FakeProvider`s; queue behaviour via `FakeQueue`
     (`worker/tests/fakes.py`). Provider adapters are tested against stub SDK clients
     (`tests/test_providers.py`) that assert the exact request shape.
   - Code needing real infra (PgRepo, PgJobQueue, S3 stores) gets integration tests marked
     `@pytest.mark.integration` (excluded by default) or under `apps/api/test/integration/`,
     run against `dev-infra`.
5. **Contract tests stay green**: both `apps/api/test/spec-registry.test.ts` and
   `worker/tests/test_specs.py` load every spec in `specs/`. A new spec is not done until both pass.
6. New pure logic (segmentation, CSV flattening, retry policy, alias resolution) should be
   table-driven/parametrised tests — cheap to extend when a new document quirk turns up.

## Cross-language contracts (change both sides together, in the same PR)

| Contract | TypeScript | Python |
| --- | --- | --- |
| Spec format | `packages/shared/src/spec.ts` (Zod, `.strict()`) | `worker/src/ingest_worker/specs.py` (Pydantic, `extra="forbid"`) |
| Object keys | `packages/shared/src/storage-keys.ts` | `worker/src/ingest_worker/storage.py` |
| Job statuses | `packages/shared/src/jobs.ts` | `db/migrations` `job_status` enum, `queue.py` |
| Models table | `ModelInfo` in `packages/shared/src/models.ts`, `PgRepo.listModels` | `PgJobQueue.upsert_models` |

## Rules of the road

- **Specs are immutable once published.** Change a document type by adding `specs/<id>/v<N+1>/`;
  jobs record the spec id + version they ran with. Prompts are Jinja2 with `StrictUndefined`.
- **Migrations are forward-only**: add `db/migrations/NNNN_description.sql`; never edit an
  applied one.
- **LLM layer** (`worker/src/ingest_worker/llm/`): providers implement the `LLMProvider`
  protocol (`list_models`, `complete_json`). Kinds: `anthropic`, `openai-chat`,
  `openai-responses`; any OpenAI-compatible local server is an `openai-*` provider with
  `baseUrl`. Model refs are `provider/model-id` or an alias from `config/llm-providers.yaml`
  (`default` → `anthropic/claude-opus-5-5`, `fast` → `anthropic/claude-haiku-5-5`).
  Job-level model override beats the spec's model. Discovered models land in `llm_models`
  and populate the UI picker.
- Anthropic calls use structured outputs (`output_config.format` json_schema) plus
  `output_config.effort`; refusals (`stop_reason == "refusal"`) raise `RefusalError` → job goes to
  `needs_review`. Don't send `temperature`/`top_p`/`budget_tokens` or assistant prefill — current
  Claude models reject them.
- **Error routing in the worker:** `DocumentError` (missing sections, page count, schema never
  satisfied, refusal) → `needs_review`, not retried. Anything else → `fail()` → re-queued with
  backoff until `max_attempts`, then `failed`.
- **Never call real LLM APIs from tests or CI.** No API keys in the repo; secrets live in
  `deploy/.env` locally (git-ignored) and `/etc/ingestion-harness/<env>.env` on deploy hosts.
- TypeScript: ESM with `.js` import suffixes, Zod at every boundary (env, request bodies,
  specs), no `any` without a comment. Python: `mypy --strict`, ruff, dataclasses/Pydantic,
  `from __future__ import annotations`.
- Keep `apps/api` free of LLM logic and `worker` free of HTTP-serving logic.

## CI/CD

GitHub Actions on **self-hosted runners only** (private repo; see [docs/runners.md](docs/runners.md)).
`ci.yml`: node + worker jobs, then images build + compose smoke test. `deploy.yml`: main →
staging after green CI; manual dispatch for production / rollbacks (`no_build` + older ref).

## Definition of done

`npm run check` green · new behaviour covered by tests written first · contracts updated on both
sides · docs/ADR updated if architecture changed · no secrets committed.
