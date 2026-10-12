# CLAUDE.md

Ingestion harness: ingests PDFs whose structure is known in advance, extracts their contents
through an LLM prompt harness, and writes validated CSV/JSON to S3 (SeaweedFS).

## Architecture in one paragraph

`app` (React, served by nginx) → `api` (Fastify, Node 24/TypeScript) stores the uploaded PDF in
the SeaweedFS **inbox** bucket and inserts a `documents` row + `jobs` row in Postgres. The
`worker` (Python 3.13) claims jobs with `SELECT … FOR UPDATE SKIP LOCKED`, extracts page text
(OCR'ing image-only pages with a vision model, default olmOCR 2), segments it into sections using the document **spec**, runs one LLM call per spec extraction
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
.github/workflows/   CI (GitHub-hosted) + deploy (self-hosted)
```

## Commands

Run from the repo root unless noted. Dev host is Windows; scripts exist in `.sh` and `.ps1`.

| Task | Command |
| --- | --- |
| Install | `npm ci` and `cd worker && uv sync` |
| **Everything CI checks** | `npm run check` |
| TS tests (all / watch / one file) | `npm test` / `npm run test:watch` / `npx vitest run apps/api/test/jobs.test.ts` |
| TS tests for one project | `npx vitest run --project api` (`shared`, `api`, `web`) |
| API integration tests (dev-infra) | `npm run test:integration` |
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
     `@pytest.mark.integration` (excluded by default) or under `apps/api/test/integration/`.
     `npm run test:integration` runs the API ones (own config). The workbench Pg test skips unless `IH_TEST_DATABASE_URL` is set; point it at a throwaway Postgres
     (they apply `db/migrations` and write rows), e.g. `docker run --rm -d --name ih-test-pg -e
     POSTGRES_PASSWORD=test -p 55433:5432 postgres:17-alpine`, then
     `IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg`.
5. **Contract tests stay green**: both `apps/api/test/spec-registry.test.ts` and
   `worker/tests/test_specs.py` load every spec in `specs/`. A new spec is not done until both pass.
6. New pure logic (segmentation, CSV flattening, retry policy, alias resolution) should be
   table-driven/parametrised tests — cheap to extend when a new document quirk turns up.

## Cross-language contracts (change both sides together, in the same PR)

| Contract | TypeScript | Python |
| --- | --- | --- |
| Spec format (incl. `document.ocr`, `copies`, chunking, `checks`) | `packages/shared/src/spec.ts` (Zod, `.strict()`) | `worker/src/ingest_worker/specs.py` (Pydantic, `extra="forbid"`) |
| Template format (fields, tables, steps, review) | `packages/shared/src/template.ts` | `worker/src/ingest_worker/template.py` |
| Object keys | `packages/shared/src/storage-keys.ts` | `worker/src/ingest_worker/storage.py` |
| Job statuses and tasks (incl. `cancelled`, migration 0006; `prepare` + `priority`, migration 0008; `segment`, nullable `document_id`, `params`, migration 0009; `draft`, migration 0011) | `packages/shared/src/jobs.ts` | `db/migrations` `job_status` enum, `queue.py` (`ClaimedJob.project_id/params`) |
| Models table | `ModelInfo` in `packages/shared/src/models.ts`, `PgRepo.listModels` | `PgJobQueue.upsert_models` |
| Workbench prepared text and segmentation | `PreparedTextSchema`/`PreparedTriageSchema`/`SegmentationResultSchema` in `packages/shared/src/workbench.ts`, `preparedTextKey`, `segmentationKey` | `workbench.prepare_sample`/`workbench.segment_samples`, `storage.prepared_text_key`/`storage.segmentation_key` |
| Data policy and drafting | `DataPolicy`, `params.dataPolicy`, `SurveyBodySchema`, `DraftResultSchema`, `draftingKey` in `packages/shared` | `pipeline.enforce_data_policy`, `drafting.DraftParams`, `drafting.SURVEY_SCHEMA`, `storage.drafting_key` |

## Rules of the road

- **Templates live in the database** (`templates` table, migration 0003; `apps/api/src/templates/`, `apps/web/src/templates/`): drafts editable, published immutable (DB triggers too), YAML import/export, `specs/*/template.yaml` seeded on API start. The worker loads a job's template from the DB first (`pipeline.load_definition`), files second. Draft test runs set `jobs.test` and are never published.
- **Document templates (`template.yaml`) are the preferred format** — outputs first (fields + typed tables), steps compile to the engine's `Extraction` (`template.compile_step`), run by `template_pipeline.py`. Legacy `spec.yaml` still runs via `pipeline.py`; both share `prepare_document` (OCR, copies, page markers, sections).
- **Specs are immutable once published.** Change a document type by adding `specs/<id>/v<N+1>/`;
  jobs record the spec id + version they ran with. Prompts are Jinja2 with `StrictUndefined`.
- **Migrations are forward-only**: add `db/migrations/NNNN_description.sql`; never edit an
  applied one.
- **LLM layer** (`worker/src/ingest_worker/llm/`): providers implement the `LLMProvider`
  protocol (`list_models`, `complete_json`). Kinds: `anthropic`, `openai-chat`,
  `openai-responses`; any OpenAI-compatible local server is an `openai-*` provider with
  `baseUrl`. Model refs are `provider/model-id` or an alias from `config/llm-providers.yaml`
  (`default` → `local/qwen3.8-27b-mtp` on the LM Studio endpoint, `fast` →
  `anthropic/claude-haiku-5-5`). Unresolvable refs raise `ModelResolutionError` and are resolved
  for every extraction *before* any LLM call (config error → `needs_review`, never retried).
- **OCR** (`worker/src/ingest_worker/ocr.py`): `ocr:` in `config/llm-providers.yaml` names a
  vision model (default `local/olmocr-2-7b-1025`), optionally on its own endpoint/key (`OCR_BASE_URL`,
  `OCR_API_KEY` → `ocr.baseUrl`/`apiKeyEnv`, resolved via `ModelRegistry.resolve_ocr`); spec `document.ocr` is `auto|always|never`.
  Providers implement `complete_vision`; tests use `PipelineDeps.render_page` fakes, and only
  `test_render_page_png_scales_longest_side` renders a real PDF (pypdfium2, in-memory).
  OCR output is cached per PDF sha256 + OCR settings (`runs/ocr-cache/`), so re-runs and
  regressions see identical page text.
  Job-level model override beats the spec's model. Discovered models land in `llm_models`
  and populate the UI picker.
- **Data policy:** providers declare `location: local | external` (undeclared = external). Every
  project job carries `params.dataPolicy` (missing = local); the worker refuses an external provider
  for a local-only project before any call, in extraction, OCR (after `resolve_ocr`; the OCR clone
  inherits its named provider's `location`, so an `OCR_BASE_URL` pointing a local-marked provider at a
  remote host is the operator's responsibility), template step re-runs and drafting. Switching a
  project to `local` (`setDataPolicy`) also sets `params.dataPolicy = 'local'` on every existing job
  of the project except segment previews (no model call; strict params), so queued jobs, Retry and
  step re-runs (which reuse the row) cannot go external after a revocation; switching to `external`
  never upgrades old jobs. The `draft` alias (`DRAFT_MODEL`, default the local model) is the
  Workbench drafting model; a drafting call's output budget is `drafting.DRAFT_MAX_TOKENS`.
- Anthropic calls use structured outputs (`output_config.format` json_schema) plus
  `output_config.effort`; refusals (`stop_reason == "refusal"`) raise `RefusalError` → job goes to
  `needs_review`. Don't send `temperature`/`top_p`/`budget_tokens` or assistant prefill — current
  Claude models reject them. OpenAI-compatible providers take an optional `temperature` option;
  the local provider and OCR run at 0 so regression scores measure the template, not sampling noise.
- **Review:** template jobs needing review stop in `awaiting_review` (drafts in the outputs bucket); approve → publish task applies `review_edits` (`worker/src/ingest_worker/review.py`) and writes to the final target (`Target`, `TARGET_S3_*`); reject is final. `needs_review` is different: a processing problem for an operator.
- **Results:** `apps/web/src/results/` + `apps/api/src/routes/results.ts` read published outputs from the target store (`AppDeps.targetStore`, `storeFor(stage)`); the API reads `TARGET_S3_*` via `targetConfig` (same fallback as the worker).
- **Workbench ([ADR 0007](docs/adr/0007-workbench.md), [design](docs/design/workbench.md)):** one project per document type (`workbench_projects.id` = template id; `apps/api/src/workbench/`, `apps/api/src/routes/workbench.ts`, `apps/web/src/workbench/`). Samples are ordinary documents; uploading one queues a `prepare` job (text + OCR only, `worker/src/ingest_worker/workbench.py`) writing `prepared/{sha256}/text.json|triage.json` to the runs bucket. Sample state comes from that job. Workbench jobs (prepare and test runs) have `priority = -10` (production 0). Prepare jobs never appear on the Jobs page and are never bulk-deleted; dev test runs are ordinary test jobs. A sample's document is never deleted with a job. Anchor previews are `segment` jobs: project-scoped with no document (`document_id IS NULL`, excluded from every `JobSummary` query by the inner join), `priority = -5`, one per project (a new preview deletes the old; previews for one project serialize via `pg_advisory_xact_lock`). They run `segment.section_spans`, the same code production segmentation uses, in a child process capped at 10 s (`SEGMENT_TIMEOUT_S`); on overrun the child is killed and the job goes to `needs_review` ("…may backtrack catastrophically"), so a runaway anchor regex cannot stall previews or other jobs on the same worker (previews are capped; production segmentation is not, so the Sections tab refuses to save an anchor whose preview timed out). Segment jobs are never retryable or cancellable through the jobs routes: `PgRepo` guards are `document_id IS NOT NULL`, and any query on `jobs` that bypasses `JOB_SELECT` must exclude document-less rows. Idle workers wake on `NOTIFY ih_jobs` (trigger from migration 0009); the poll interval is the fallback (and drives retry backoff). The UI polls a preview every 300 ms with a 30 s deadline. Drafting ([ADR 0007](docs/adr/0007-workbench.md), phase 3a): jobs are document-less `draft` jobs (`priority = -10`, migration 0011). The API sends only ready **dev** samples and `drafting.build_context` refuses anything else; the worker's example template comes from `WORKBENCH_EXAMPLE_TEMPLATE`. Proposals live in `workbench_proposals`, with status derived from the job and the body in `drafting/{project}/{job}.json` (`storage.drafting_key`). Only the admin token can allow external models for a project. External drafting calls are logged as `external model call` job events listing only the samples actually sent (max 8, `MAX_CONTEXT_SAMPLES`).
- **Access ([ADR 0006](docs/adr/0006-token-access.md)):** every `/api/*` route needs a session cookie except `/api/auth/login|logout` (hook in `apps/api/src/access/routes.ts`, decided on the *matched route*); tokens and sessions are SHA-256 hashed (`AccessRepo`, migration 0007); the admin token rotates on every API start and is logged; `buildApp({ access: null })` disables enforcement for unit tests only - new routes are covered by the sweep in `access.test.ts`.
- **S3 keys for the data lake ([ADR 0008](docs/adr/0008-s3-read-keys.md)):** Access page section; `apps/api/src/s3keys/` (`S3KeyService` over an `S3KeyIssuer` port: `SeaweedIamIssuer` = SeaweedFS embedded IAM on the S3 port, `MemoryS3KeyIssuer` in tests) and `routes/s3-keys.ts` (admin only). Consumers are IAM users `lake-<id>` with a read-only policy on the publish bucket; secrets live only in SeaweedFS (shown once), metadata in `s3_consumers`/`s3_access_keys` (migration 0010). The reconciler (every minute) never touches identities without the `lake-` prefix. Needs `-s3.iam.readOnly=false` (compose) and a local publish target (`s3KeysConfig`). SeaweedFS is pinned to an exact 4.x tag. Integration tests: `npm run test:integration` (needs `DATABASE_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` of a dev-infra stack).
- **UI:** design tokens in `apps/web/src/styles/tokens.css` (light/dark; the theme choice is `ih.theme` via `apps/web/src/theme.ts`), shared primitives in `apps/web/src/ui/`, app shell in `apps/web/src/shell/`; the redesign handoff is [docs/design/ui-redesign/](docs/design/ui-redesign/).
- **Error routing in the worker:** `DocumentError` (missing sections, page count, schema never
  satisfied, refusal) → `needs_review`, not retried. Anything else → `fail()` → re-queued with
  backoff until `max_attempts`, then `failed`.
  `JobCancelled` (operator cancel, ADR 0005) → no status write; worker status writes are guarded
  `AND status='running'` so a cancel always wins.
- **Never call real LLM APIs from tests or CI.** No API keys in the repo; secrets live in
  `deploy/.env` locally (git-ignored) and `/etc/ingestion-harness/<env>.env` on deploy hosts.
- TypeScript: ESM with `.js` import suffixes, Zod at every boundary (env, request bodies,
  specs), no `any` without a comment. Python: `mypy --strict`, ruff, dataclasses/Pydantic,
  `from __future__ import annotations`.
- Keep `apps/api` free of LLM logic and `worker` free of HTTP-serving logic.

## CI/CD

Public repo (Apache-2.0). **CI runs on GitHub-hosted runners**; only deploys use self-hosted
runners on the deploy hosts. Never target a self-hosted runner from a `pull_request` workflow
(see [docs/runners.md](docs/runners.md)). `main` is protected: PRs only, CI must be green.
`ci.yml`: node + worker jobs, then images build + compose smoke test. `deploy.yml`: main →
staging after green CI (once repo variable `AUTO_DEPLOY_STAGING=true`); manual dispatch for production / rollbacks (`no_build` + older ref).

## Definition of done

`npm run check` green · new behaviour covered by tests written first · contracts updated on both
sides · docs/ADR updated if architecture changed · no secrets committed.
