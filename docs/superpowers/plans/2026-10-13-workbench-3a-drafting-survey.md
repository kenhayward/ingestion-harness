# Workbench 3a/6: Data Policy, Drafting Foundations and the Survey Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Workbench project gets a **data policy**: local only by default, and only an admin can allow external models. That policy is enforced on every model call the project's jobs make. Then a drafting model can **survey** the dev samples and the brief. The survey reports the document's structure, its variants, and candidate data with where each item lives, and asks the user questions. The user answers the questions into the brief and accepts or rejects the survey.

**Architecture:**
- **Data policy.** Providers in `config/llm-providers.yaml` declare `location: local | external`; a provider that doesn't declare one counts as external. Every job that belongs to a project carries `params.dataPolicy`. The worker checks the policy against the **resolved** provider before any call, in one function (`enforce_data_policy`) used by extraction, OCR and drafting.
- **Drafting jobs.** These are document-less `draft` jobs, like phase 2's segment jobs. The API assembles the inputs: the brief, the current draft, and the **dev** samples only, which is where the holdout rule lives. The worker turns those inputs into a context in one function (`build_context`), which also refuses any non-dev sample. It then calls the `draft` model through the existing validate-and-retry loop and writes the stage body to the runs bucket.
- **Proposals.** A `workbench_proposals` row records the proposal and the user's decision. Its status comes from its job, as with samples in phase 1.

**Tech Stack:** Python 3.13 + pytest + mypy strict + jsonschema (worker), Fastify + Zod (API), React + Testing Library + Vitest (web), Postgres migration.

**Spec:** [docs/design/workbench.md](../../design/workbench.md) (Phase 3 "Drafting", sections "Models and data policy", "Context assembly", "Drafting stages" → `survey`, "The brief" → Answers) and [ADR 0007](../../adr/0007-workbench.md) ("Data policy per project, default local", "Drafting model: a new alias `draft`", "Holdout").

**Depends on:** Workbench phase 2 ([kenhayward/ingestion-harness#35](https://github.com/kenhayward/ingestion-harness/pull/35)) merged to `main`. Branch from `main` after it lands.

**Follows:** plan 3b covers the outputs, sections, steps and references stages: per-change proposals applied to the draft, accept or reject for each change, and earlier stages marked stale when a later one changes. It reuses everything built here.

## Global Constraints

- **Providers.** Each provider config gains `location: local | external`. **A provider without `location` is treated as external.** The shipped config sets `local` → `local`, and `anthropic` and `openai` → `external`.
- **Draft alias.** New alias `draft: ${DRAFT_MODEL:-local/qwen3.8-27b-mtp}` in `config/llm-providers.yaml`. The default stays local, so the default project policy works without changes.
- **Policy values.** `data_policy` is `'local' | 'external'` and defaults to `'local'`. Only the admin token can change it (403 for user tokens). The route is still allowed when access enforcement is off (`access: null`, unit tests only).
- **Policy is per job.** Every job with a `project_id` is governed by `params.dataPolicy`. A **missing value counts as `'local'`**. Jobs without a project (production) have no policy.
- **Policy check timing.** The check runs on the **resolved** provider before any model call. A violation raises `DocumentError` (→ `needs_review`) with the message `data policy: project is local-only but <ref> resolves to external provider <name>`. The job is not retried and no provider is called.
- **External calls are logged.** Every drafting call to an external provider writes a job event `external model call` with `{stage, model, samples}`, where `samples` is the list of sample ids sent.
- **Holdout.** Holdout text is **never** sent to the drafting model. The API selects only `role === 'dev'` ready samples. As a second line of defence, the worker's `build_context` raises if handed any other role.
- **Draft job settings.** `task = 'draft'`, `document_id IS NULL`, `priority = -10` (`WORKBENCH_PRIORITY`), `max_attempts = 3` (transient LLM errors retry), `test = true`.
- **Model output.** Drafting output is JSON validated against the stage's JSON Schema by the existing `run_extraction` loop: validation errors are fed back, and there are at most 2 attempts. If it never validates, or the model refuses, the job goes to `needs_review`.
- **Context size.** Each sample is capped at `MAX_SAMPLE_CHARS = 40_000` characters of prepared text, with a visible truncation note. At most `MAX_CONTEXT_SAMPLES = 8` samples are included.
- **Migrations and process.** Migrations are forward-only: `db/migrations/0010_workbench_drafting.sql`. Zod at every boundary, including stored JSON read back. Use `mypy --strict` and ruff. Never call real LLM APIs from tests. CI runs `npm run format:check`.
- **Contract changes, both sides, this PR:** job task `draft`; `params.dataPolicy`; provider `location`; the draft params; the survey body schema; `draftingKey`.

## Review Focus

1. **Holdout leakage:** a project whose only ready samples are holdout gets 409. A project with both dev and holdout samples sends only the dev ones. A worker handed a holdout sample refuses before calling any model. (Tasks 3 and 5 tests.)
2. **A local-only project whose model resolves to an external provider** must be refused before any provider call, with a clear reason. This applies to a survey (via `draft`), a dev test run whose template step uses `fast`, and a prepare job whose OCR model is external. (Task 2 tests.)
3. **A provider config without `location`:** it must be treated as external, never as local. (Task 2 test.)
4. **The drafting model answers with broken or schema-violating JSON:** the errors are fed back once, then the job goes to `needs_review` with the reason. A transient provider error retries the job instead. (Task 3 tests.)
5. **Saving the Brief tab after survey answers were added:** the answers must survive. (Task 7 test.)

---

## File map

| File | Responsibility |
| --- | --- |
| `db/migrations/0010_workbench_drafting.sql` (new) | `workbench_projects.data_policy` (+ changed at/by), task `draft`, `workbench_proposals` |
| `packages/shared/src/workbench.ts`, `jobs.ts`, `storage-keys.ts` | `DataPolicy`, project fields, brief `answers`, `SurveyBodySchema`, `ProposalView`, `draftingKey`, task `draft` |
| `config/llm-providers.yaml` | Provider `location`, `draft` alias |
| `worker/src/ingest_worker/llm/registry.py` | `ProviderConfig.location`, `ModelRegistry.location()` |
| `worker/src/ingest_worker/pipeline.py` | `enforce_data_policy`; called in `resolve_models` and OCR |
| `worker/src/ingest_worker/extract.py` | `run_extraction(..., system=…)` |
| `worker/src/ingest_worker/drafting.py` (new) | `DraftParams`, `build_context`, stages (`SURVEY`), `run_draft` |
| `worker/src/ingest_worker/storage.py`, `config.py`, `main.py` | `drafting_key`; example template path; `draft` branch |
| `apps/api/src/repositories/{types,memory,pg}.ts` | `createWorkbenchJob` params; `createDraftJob`, `listDraftJobs` |
| `apps/api/src/workbench/repo.ts` | Data policy; proposals |
| `apps/api/src/routes/workbench.ts` | Data-policy route; stage start; proposals; policy on prepare and test runs |
| `apps/web/src/api/client.ts`, `test/fake-api.ts`, `router.ts`, `App.tsx` | Client methods; tab `survey`; `role` to ProjectPage |
| `apps/web/src/workbench/ProjectPage.tsx`, `SurveyTab.tsx` (new) | Policy badge + admin toggle; Survey tab |
| `CLAUDE.md`, `docs/architecture.md` | Document it |

---

### Task 1: Migration and shared contracts

**Files:**
- Create: `db/migrations/0010_workbench_drafting.sql`
- Modify: `packages/shared/src/workbench.ts`, `packages/shared/src/jobs.ts`, `packages/shared/src/storage-keys.ts`
- Test: `packages/shared/test/workbench.test.ts`

**Interfaces:**
- Produces (`@ih/shared`):
  - `DATA_POLICIES = ['local', 'external'] as const`, `DataPolicySchema`, `type DataPolicy`
  - `WorkbenchProject` gains `dataPolicy: DataPolicy; dataPolicyChangedAt: string | null; dataPolicyChangedBy: string | null`
  - `BriefBodySchema` gains `answers: z.array(z.object({ question: z.string(), answer: z.string() }).strict()).default([])`; `EMPTY_BRIEF.answers = []`
  - `DRAFT_STAGES = ['survey', 'outputs', 'sections', 'steps', 'references'] as const`, `type DraftStage`; `AVAILABLE_STAGES: readonly DraftStage[] = ['survey']`
  - `SurveyBodySchema`, `type SurveyBody`, matching the worker's `SURVEY_SCHEMA` exactly (Task 3)
  - `DraftResultSchema = z.object({ stage: z.enum(DRAFT_STAGES), model: z.string(), body: z.unknown(), usage: z.object({ inputTokens: z.number().int().nullable(), outputTokens: z.number().int().nullable() }) })`
  - `type ProposalStatus = 'running' | 'ready' | 'failed' | 'accepted' | 'rejected'`
  - `interface ProposalView { id: string; stage: DraftStage; status: ProposalStatus; error: string | null; briefVersion: number | null; model: string | null; body: SurveyBody | null; createdAt: string; decidedAt: string | null }`
  - `draftingKey(projectId, jobId)` → `drafting/{projectId}/{jobId}.json`
  - `JobSummary.task` includes `'draft'`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/workbench.test.ts`:

```ts
import {
  BriefBodySchema,
  DataPolicySchema,
  SurveyBodySchema,
  draftingKey,
} from '../src/index.js';

describe('drafting contracts', () => {
  it('keys a drafting result by project and job (mirrors worker storage.py)', () => {
    expect(draftingKey('letter', 'j1')).toBe('drafting/letter/j1.json');
  });

  it('accepts only the two data policies', () => {
    expect(DataPolicySchema.parse('local')).toBe('local');
    expect(DataPolicySchema.safeParse('cloud').success).toBe(false);
  });

  it('keeps survey answers in the brief, defaulting to none', () => {
    expect(BriefBodySchema.parse({}).answers).toEqual([]);
    expect(
      BriefBodySchema.parse({ answers: [{ question: 'Which copy?', answer: 'Executed' }] }).answers,
    ).toEqual([{ question: 'Which copy?', answer: 'Executed' }]);
  });

  it('parses a survey body and rejects unknown keys', () => {
    const body = {
      summary: 'Process validation protocols, blank and executed.',
      structure: [{ name: 'Approvals', description: 'Signatures', howToFind: 'PROTOCOL APPROVAL heading' }],
      variants: ['Scanned executed copy follows the blank protocol'],
      candidates: [
        { name: 'protocol_number', description: 'Protocol id', where: 'page header', kind: 'field' },
      ],
      questions: [{ question: 'Which copy should be extracted?', why: 'Some PDFs hold two copies' }],
    };
    expect(SurveyBodySchema.parse(body)).toEqual(body);
    expect(SurveyBodySchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });

  it('accepts draft jobs', () => {
    expect(JobSummarySchema.shape.task.parse('draft')).toBe('draft');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/workbench.test.ts`
Expected: FAIL. `draftingKey` is not exported.

- [ ] **Step 3: Write the migration**

`db/migrations/0010_workbench_drafting.sql`:

```sql
-- Workbench phase 3a (ADR 0007): per-project data policy, the `draft` task, and proposals.

ALTER TABLE workbench_projects
  ADD COLUMN data_policy text NOT NULL DEFAULT 'local' CHECK (data_policy IN ('local', 'external')),
  ADD COLUMN data_policy_changed_at timestamptz,
  ADD COLUMN data_policy_changed_by text;

ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft'));

-- One row per drafting run. The id is the draft job's id. Status is derived from that job
-- until the user decides; the body lives in the runs bucket (drafting/{project}/{job}.json).
CREATE TABLE workbench_proposals (
  id             uuid        PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  project_id     text        NOT NULL REFERENCES workbench_projects (id),
  stage          text        NOT NULL CHECK (stage IN ('survey', 'outputs', 'sections', 'steps', 'references')),
  brief_version  integer,
  decision       text        CHECK (decision IN ('accepted', 'rejected')),
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_proposals_project_idx ON workbench_proposals (project_id, created_at DESC);
```

- [ ] **Step 4: Add the shared contracts**

In `packages/shared/src/jobs.ts`, extend the task enum and its comment with `draft` ("workbench drafting stage; no document"):

```ts
  task: z.enum(['process', 'publish', 'rerun', 'prepare', 'segment', 'draft']),
```

In `packages/shared/src/workbench.ts`:

```ts
export const DATA_POLICIES = ['local', 'external'] as const;
export const DataPolicySchema = z.enum(DATA_POLICIES);
export type DataPolicy = z.infer<typeof DataPolicySchema>;
```

Extend `WorkbenchProject`:

```ts
export interface WorkbenchProject {
  id: string;
  name: string;
  createdAt: string;
  /** Where sample text may go (ADR 0007): local models only, or external providers too. */
  dataPolicy: DataPolicy;
  dataPolicyChangedAt: string | null;
  /** Label of the admin token that last changed the policy. */
  dataPolicyChangedBy: string | null;
}
```

Add `answers` to `BriefBodySchema`, inside the `.object({...})` before `.strict()`:

```ts
    /** Survey questions and the user's answers (drafting stage `survey`). */
    answers: z
      .array(z.object({ question: z.string(), answer: z.string() }).strict())
      .default([]),
```

and `answers: []` to `EMPTY_BRIEF`.

Append:

```ts
export const DRAFT_STAGES = ['survey', 'outputs', 'sections', 'steps', 'references'] as const;
export type DraftStage = (typeof DRAFT_STAGES)[number];
/** Stages that can be run in this release (3a); 3b adds the rest. */
export const AVAILABLE_STAGES: readonly DraftStage[] = ['survey'];

/** Body of a `survey` proposal. Mirrors worker drafting.SURVEY_SCHEMA. */
export const SurveyBodySchema = z
  .object({
    summary: z.string(),
    structure: z.array(
      z.object({ name: z.string(), description: z.string(), howToFind: z.string() }).strict(),
    ),
    variants: z.array(z.string()),
    candidates: z.array(
      z
        .object({
          name: z.string(),
          description: z.string(),
          where: z.string(),
          kind: z.enum(['field', 'table']),
        })
        .strict(),
    ),
    questions: z.array(z.object({ question: z.string(), why: z.string() }).strict()),
  })
  .strict();
export type SurveyBody = z.infer<typeof SurveyBodySchema>;

/** Written by the worker's draft task (runs bucket, draftingKey). */
export const DraftResultSchema = z.object({
  stage: z.enum(DRAFT_STAGES),
  model: z.string(),
  body: z.unknown(),
  usage: z.object({
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
  }),
});
export type DraftResult = z.infer<typeof DraftResultSchema>;

export type ProposalStatus = 'running' | 'ready' | 'failed' | 'accepted' | 'rejected';

export interface ProposalView {
  id: string;
  stage: DraftStage;
  status: ProposalStatus;
  error: string | null;
  briefVersion: number | null;
  /** Resolved model that produced it (once ready). */
  model: string | null;
  /** Parsed stage body (survey only in 3a); null until ready. */
  body: SurveyBody | null;
  createdAt: string;
  decidedAt: string | null;
}
```

In `packages/shared/src/storage-keys.ts` (and its header comment `runs bucket: drafting/{projectId}/{jobId}.json (workbench draft task)`):

```ts
/** A drafting stage's result for a workbench project (runs bucket, worker draft task). */
export function draftingKey(projectId: string, jobId: string): string {
  return `drafting/${projectId}/${jobId}.json`;
}
```

- [ ] **Step 5: Run tests, fix fallout**

Run: `npx vitest run packages/shared/test/workbench.test.ts && npm run typecheck`
Expected: the shared tests PASS. The typecheck reports the places that build a `WorkbenchProject` without the new fields. Add `dataPolicy: 'local', dataPolicyChangedAt: null, dataPolicyChangedBy: null` in `apps/api/src/workbench/repo.ts` (`MemoryWorkbenchRepo.createProject`), and in `apps/web/test/fake-api.ts` (`projectView()` and any project literal). Map `PgWorkbenchRepo`'s `toProject` from `data_policy`, `data_policy_changed_at` and `data_policy_changed_by`, and extend `ProjectRow` to match. Fix any test literals the typecheck lists the same way.

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0010_workbench_drafting.sql packages/shared apps
git commit -m "Workbench: migration 0010 (data policy, draft task, proposals) and drafting contracts"
```

---

### Task 2: Worker: provider location and data-policy enforcement

**Files:**
- Modify: `worker/src/ingest_worker/llm/registry.py`, `worker/src/ingest_worker/pipeline.py`, `config/llm-providers.yaml`
- Test: `worker/tests/test_registry.py`, `worker/tests/test_data_policy.py` (new)

**Interfaces:**
- Produces:
  - `ProviderConfig.location: Literal["local", "external"] = "external"`
  - `ModelRegistry.location(provider_name: str) -> Literal["local", "external"]`, which returns `"external"` for unknown names
  - `pipeline.job_data_policy(job: ClaimedJob) -> Literal["local", "external"] | None`. The rule: `None` when `job.project_id is None`; otherwise `job.params.get("dataPolicy")` if it is `"external"`; otherwise `"local"`.
  - `pipeline.enforce_data_policy(job: ClaimedJob, deps: PipelineDeps, provider: LLMProvider, ref: str) -> None`, which raises `DocumentError` on a violation
  - Called in `resolve_models` for every resolved extraction model, and in `ocr_pages` after resolving the OCR model, before any call

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_registry.py`:

```python
def test_provider_location_defaults_to_external() -> None:
    from ingest_worker.llm.registry import ProviderConfig

    assert ProviderConfig(name="x", kind="openai-chat").location == "external"
    assert ProviderConfig(name="x", kind="openai-chat", location="local").location == "local"


def test_shipped_config_marks_local_provider_local_and_has_draft_alias(llm_config_path) -> None:  # type: ignore[no-untyped-def]
    from ingest_worker.llm.registry import load_llm_config

    cfg = load_llm_config(llm_config_path, env={})
    locations = {p.name: p.location for p in cfg.providers}
    assert locations == {"anthropic": "external", "openai": "external", "local": "local"}
    assert cfg.aliases["draft"] == "local/qwen3.8-27b-mtp"
```

Create `worker/tests/test_data_policy.py`:

```python
"""Data policy (ADR 0007): project jobs never reach an external provider unless allowed."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.ocr import OcrSettings
from ingest_worker.pipeline import Buckets, PipelineDeps, job_data_policy
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeProvider, FakeQueue


def make_deps(specs_dir: Path, cloud: FakeProvider, local: FakeProvider) -> PipelineDeps:
    store = MemoryObjectStore()
    store.put("inbox", "example-invoice/v1/doc-1.pdf", b"%PDF-fake", "application/pdf")
    return PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry(
            {"cloud": cloud, "local": local},
            {
                "cloud": ProviderConfig(name="cloud", kind="anthropic"),  # no location: external
                "local": ProviderConfig(name="local", kind="openai-chat", location="local"),
            },
            {"default": "cloud/big", "localdefault": "local/small"},
        ),
        extract_text=lambda _pdf: ["INVOICE INV-001\nAcme\nDate: 2026-03-01\n"],
        buckets=Buckets("inbox", "outputs", "runs"),
    )


def project_job(**overrides: Any) -> ClaimedJob:
    base: dict[str, Any] = dict(
        id="job-1",
        document_id="doc-1",
        spec_id="example-invoice",
        spec_version=1,
        bucket="inbox",
        object_key="example-invoice/v1/doc-1.pdf",
        model_override=None,
        attempts=1,
        max_attempts=3,
        test=True,
        project_id="letter",
        params={"dataPolicy": "local"},
    )
    return ClaimedJob(**{**base, **overrides})


@pytest.mark.parametrize(
    ("project_id", "params", "expected"),
    [
        (None, None, None),
        ("p", None, "local"),
        ("p", {}, "local"),
        ("p", {"dataPolicy": "local"}, "local"),
        ("p", {"dataPolicy": "external"}, "external"),
        ("p", {"dataPolicy": "anything else"}, "local"),
    ],
)
def test_job_data_policy(project_id: str | None, params: dict[str, Any] | None, expected: str | None) -> None:
    job = replace(project_job(), project_id=project_id, params=params)
    assert job_data_policy(job) == expected


def test_local_only_test_run_with_an_external_model_is_refused_before_any_call(
    fixture_specs_dir: Path,
) -> None:
    cloud, local = FakeProvider("cloud", kind="anthropic"), FakeProvider("local")
    queue = FakeQueue(jobs=[project_job()])  # spec models resolve via "default" → cloud
    run_once(queue, make_deps(fixture_specs_dir, cloud, local), "w1")
    [(_, reason)] = queue.reviewed
    assert "data policy" in reason and "external provider cloud" in reason
    assert cloud.calls == [] and local.calls == []


def test_external_policy_allows_external_models(fixture_specs_dir: Path) -> None:
    cloud, local = FakeProvider("cloud", kind="anthropic"), FakeProvider("local")
    cloud.responses = [RuntimeError("called")]  # proves the call is attempted
    queue = FakeQueue(jobs=[project_job(params={"dataPolicy": "external"})])
    run_once(queue, make_deps(fixture_specs_dir, cloud, local), "w1")
    assert len(cloud.calls) == 1 and not queue.reviewed


def test_production_jobs_have_no_policy(fixture_specs_dir: Path) -> None:
    cloud, local = FakeProvider("cloud", kind="anthropic"), FakeProvider("local")
    cloud.responses = [RuntimeError("called")]
    queue = FakeQueue(jobs=[project_job(project_id=None, params=None, test=False)])
    run_once(queue, make_deps(fixture_specs_dir, cloud, local), "w1")
    assert len(cloud.calls) == 1 and not queue.reviewed


def test_local_only_ocr_with_an_external_vision_model_is_refused(fixture_specs_dir: Path) -> None:
    cloud, local = FakeProvider("cloud", kind="anthropic"), FakeProvider("local")
    deps = make_deps(fixture_specs_dir, cloud, local)
    deps.extract_text = lambda _pdf: ["", ""]  # image-only: needs OCR
    deps.ocr = OcrSettings(model="cloud/vision")
    queue = FakeQueue(jobs=[project_job(task="prepare")])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "data policy" in reason
    assert cloud.vision_calls == []
```

(`FakeProvider.responses` may hold exceptions, which it raises. A `RuntimeError` goes through `fail()`, which is enough to prove the call happened. The fixture spec `example-invoice` resolves its extractions through `default`. Check `worker/tests/fixtures/specs` and use whatever alias it uses.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_registry.py tests/test_data_policy.py -q`
Expected: FAIL. `ProviderConfig` has no `location`, and `job_data_policy` cannot be imported.

- [ ] **Step 3: Implement**

`worker/src/ingest_worker/llm/registry.py`:

```python
Location = Literal["local", "external"]
```

(add `Literal` to the `typing` import) and in `ProviderConfig`:

```python
    #: Where requests go (ADR 0007 data policy). Undeclared providers count as external.
    location: Location = "external"
```

and in `ModelRegistry`:

```python
    def location(self, provider_name: str) -> Location:
        """Data-policy location of a configured provider; unknown names count as external."""
        cfg = self._configs.get(provider_name)
        return cfg.location if cfg else "external"
```

`worker/src/ingest_worker/pipeline.py` (import `Literal`):

```python
def job_data_policy(job: ClaimedJob) -> Literal["local", "external"] | None:
    """The data policy governing a job (ADR 0007): None for production jobs; for project jobs,
    params.dataPolicy, where anything but "external" (including a missing value) means local."""
    if job.project_id is None:
        return None
    return "external" if (job.params or {}).get("dataPolicy") == "external" else "local"


def enforce_data_policy(job: ClaimedJob, deps: PipelineDeps, provider: LLMProvider, ref: str) -> None:
    """Refuse, before any call, to send a local-only project's data to an external provider."""
    if job_data_policy(job) == "local" and deps.models.location(provider.name) == "external":
        raise DocumentError(
            f"data policy: project is local-only but {ref} resolves to external provider "
            f"{provider.name}"
        )
```

In `resolve_models`, after each successful `deps.models.resolve(ref)`, call `enforce_data_policy(job, deps, provider, ref)`, where `ref = job.model_override or ex.model`. In `ocr_pages`, after `provider, model_id = deps.models.resolve(deps.ocr.model)`, call `enforce_data_policy(job, deps, provider, deps.ocr.model)`.

`config/llm-providers.yaml`: add `location: external` to `anthropic` and `openai`, and `location: local` to `local`. Document the key in the header comment: `# location: local | external — data policy (ADR 0007); omitted = external`. Add the alias:

```yaml
  # Workbench drafting (ADR 0007). Point at a frontier model (external) or a large local one.
  draft: ${DRAFT_MODEL:-local/qwen3.8-27b-mtp}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run mypy`
Expected: PASS. The phase-1 and phase-2 worker tests are unaffected: their jobs have no `project_id`.

- [ ] **Step 5: Commit**

```bash
git add worker config/llm-providers.yaml
git commit -m "Worker: provider location and per-project data policy on every model call"
```

---

### Task 3: Worker: context assembly and the survey stage

**Files:**
- Create: `worker/src/ingest_worker/drafting.py`
- Modify: `worker/src/ingest_worker/extract.py`, `worker/src/ingest_worker/storage.py`, `worker/src/ingest_worker/config.py`, `worker/src/ingest_worker/pipeline.py` (`PipelineDeps.example_template`), `worker/src/ingest_worker/main.py`
- Test: `worker/tests/test_drafting.py` (new), `worker/tests/test_storage.py`

**Interfaces:**
- Consumes: `enforce_data_policy`, `job_data_policy` (Task 2); `prepared_text_key` (phase 1); `run_extraction`, `ExtractionFailedError`.
- Produces:
  - `extract.run_extraction(..., system: str = SYSTEM_PROMPT)`. The new keyword passes through to `CompletionRequest.system`.
  - `storage.drafting_key(project_id, job_id)` → `drafting/{project_id}/{job_id}.json`
  - `PipelineDeps.example_template: str | None = None`, the YAML text of a worked-example template
  - `Settings.example_template: Path`. It is read from env `WORKBENCH_EXAMPLE_TEMPLATE` and defaults to `<specs_dir>/process-validation-protocol/v3/template.yaml`. `main()` loads its text when the file exists.
  - `drafting.MAX_SAMPLE_CHARS = 40_000`, `drafting.MAX_CONTEXT_SAMPLES = 8`
  - `drafting.DraftSample(sample_id: str, filename: str, role: str, pages: list[str])` (frozen dataclass)
  - `drafting.build_context(*, brief: dict[str, Any], draft: dict[str, Any] | None, samples: list[DraftSample], example_yaml: str | None) -> str`. It raises `ValueError` if any sample's role is not `"dev"`.
  - `drafting.Stage(id: str, instructions: str, schema: dict[str, Any])`; `drafting.SURVEY`; `drafting.STAGES: dict[str, Stage]`
  - `drafting.DraftParams` (pydantic, camelCase aliases): `stage: str`, `data_policy: Literal["local","external"]` (alias `dataPolicy`), `brief_version: int | None` (alias `briefVersion`), `brief: dict[str, Any]`, `draft: dict[str, Any] | None`, `samples: list[DraftParamSample]` (`sampleId`, `filename`, `sha256`, `role`), `model: str | None = None`
  - `drafting.run_draft(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]`. It writes the `DraftResult` JSON (`{stage, model, body, usage: {inputTokens, outputTokens}}`) to `drafting_key` and an audit record per attempt to `run_key(job.id, f"draft-{stage}", n)`, then returns the result.
  - `run_once` handles `job.task == "draft"`: `run_draft`, then `queue.complete(job, [], outputs)`.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_storage.py`:

```python
def test_drafting_key_mirrors_the_typescript_helper() -> None:
    from ingest_worker.storage import drafting_key

    assert drafting_key("letter", "j1") == "drafting/letter/j1.json"
```

Create `worker/tests/test_drafting.py`:

```python
"""Drafting: context assembly (holdout never included) and the survey stage."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.drafting import (
    MAX_SAMPLE_CHARS,
    SURVEY,
    DraftSample,
    build_context,
)
from ingest_worker.llm.base import LLMError
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, drafting_key, prepared_text_key

from .fakes import FakeProvider, FakeQueue

BRIEF = {
    "purpose": "Batch release records for QA",
    "outputs": "Protocol number, product, batches",
    "exampleOutput": "",
    "glossary": "PVP = process validation protocol",
    "variants": "",
    "rules": "Placeholders are null",
    "answers": [{"question": "Which copy?", "answer": "The executed one"}],
}
DRAFT = {"id": "letter", "version": 1, "name": "Letter", "document": {"sections": [{"id": "all", "anchor": "\\A"}]}}
SURVEY_BODY = {
    "summary": "Process validation protocols.",
    "structure": [{"name": "Approvals", "description": "Signatures", "howToFind": "PROTOCOL APPROVAL"}],
    "variants": ["Executed copy follows the blank one"],
    "candidates": [{"name": "protocol_number", "description": "Id", "where": "header", "kind": "field"}],
    "questions": [{"question": "Which copy?", "why": "Two copies"}],
}


def sample(role: str = "dev", text: str = "PROTOCOL APPROVAL\nPVP/23/003") -> DraftSample:
    return DraftSample(sample_id=f"s-{role}", filename=f"{role}.pdf", role=role, pages=[text, "page two"])


def test_context_holds_rules_brief_draft_example_and_dev_text() -> None:
    context = build_context(brief=BRIEF, draft=DRAFT, samples=[sample()], example_yaml="id: example\n")
    assert "Batch release records for QA" in context
    assert "Which copy?" in context and "The executed one" in context
    assert "PVP/23/003" in context and "[page 1]" in context and "[page 2]" in context
    assert "id: example" in context
    assert "anchor" in context  # the current draft as YAML
    assert "Python regular expression" in context  # the rules section explains anchors


def test_context_refuses_holdout_samples() -> None:
    with pytest.raises(ValueError, match="holdout"):
        build_context(brief=BRIEF, draft=None, samples=[sample(), sample("holdout")], example_yaml=None)


def test_long_samples_are_truncated_with_a_note() -> None:
    long = sample(text="x" * (MAX_SAMPLE_CHARS + 500))
    context = build_context(brief={}, draft=None, samples=[long], example_yaml=None)
    assert "truncated: " in context
    assert "x" * MAX_SAMPLE_CHARS not in context  # the sample block itself was cut


# --- the draft job ---------------------------------------------------------------------


def draft_job(**params: Any) -> ClaimedJob:
    base: dict[str, Any] = {
        "stage": "survey",
        "dataPolicy": "local",
        "briefVersion": 3,
        "brief": BRIEF,
        "draft": DRAFT,
        "samples": [{"sampleId": "s1", "filename": "a.pdf", "sha256": "sha-a", "role": "dev"}],
    }
    return ClaimedJob(
        id="job-d",
        document_id="",
        spec_id="letter",
        spec_version=0,
        bucket="",
        object_key="",
        model_override=None,
        attempts=1,
        max_attempts=3,
        task="draft",
        test=True,
        project_id="letter",
        params={**base, **params},
    )


def make(specs_dir: Path, location: str = "local") -> tuple[FakeProvider, MemoryObjectStore, PipelineDeps]:
    provider = FakeProvider("drafter")
    store = MemoryObjectStore()
    text = {"sha256": "sha-a", "pages": [{"number": 1, "text": "PROTOCOL APPROVAL\nPVP/23/003", "ocr": False}]}
    store.put("runs", prepared_text_key("sha-a"), json.dumps(text).encode(), "application/json")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry(
            {"drafter": provider},
            {"drafter": ProviderConfig(name="drafter", kind="openai-chat", location=location)},  # type: ignore[arg-type]
            {"draft": "drafter/big"},
        ),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        example_template="id: example\n",
    )
    return provider, store, deps


def test_survey_job_writes_the_validated_body(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [SURVEY_BODY]
    queue = FakeQueue(jobs=[draft_job()])

    run_once(queue, deps, "w1")

    assert queue.completed == [("job-d", [])]
    result = json.loads(store.get("runs", drafting_key("letter", "job-d")))
    assert result == {
        "stage": "survey",
        "model": "drafter/big",
        "body": SURVEY_BODY,
        "usage": {"inputTokens": 10, "outputTokens": 5},
    }
    [(model, request)] = provider.calls
    assert model == "big"
    assert "PVP/23/003" in request.prompt and SURVEY.instructions in request.prompt
    assert request.json_schema == SURVEY.schema
    assert store.get_optional("runs", "job-d/draft-survey/attempt-1.json") is not None
    assert not any(msg == "external model call" for _, _, msg in queue.events)  # local provider


def test_external_drafting_is_logged_with_the_samples_sent(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir, location="external")
    provider.responses = [SURVEY_BODY]
    queue = FakeQueue(jobs=[draft_job(dataPolicy="external")])
    run_once(queue, deps, "w1")
    [details] = [d for _, _, msg, d in queue.event_details if msg == "external model call"]
    assert details == {"stage": "survey", "model": "drafter/big", "samples": ["s1"]}


def test_local_only_project_never_reaches_an_external_drafter(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir, location="external")
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "data policy" in reason
    assert provider.calls == []


def test_holdout_sample_in_params_is_refused_before_any_call(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    samples = [{"sampleId": "h1", "filename": "h.pdf", "sha256": "sha-a", "role": "holdout"}]
    queue = FakeQueue(jobs=[draft_job(samples=samples)])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "holdout" in reason
    assert provider.calls == []


def test_invalid_output_is_fed_back_then_needs_review(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    provider.responses = ["not json", {"summary": "only this"}]
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert len(provider.calls) == 2
    assert "previous response was rejected" in provider.calls[1][1].prompt
    [(_, reason)] = queue.reviewed
    assert "draft-survey" in reason


def test_transient_provider_errors_retry_the_job(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    provider.responses = [LLMError("503 overloaded")]
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert queue.failed and "503" in queue.failed[0][1]


def test_unknown_stage_needs_review(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[draft_job(stage="outputs")])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "stage" in reason and provider.calls == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_drafting.py tests/test_storage.py -q`
Expected: FAIL. `ingest_worker.drafting` does not exist.

- [ ] **Step 3: Small enabling changes**

In `extract.py`, add the keyword-only parameter `system: str = SYSTEM_PROMPT` to `run_extraction` and pass `system=system` to `CompletionRequest`.

In `storage.py`, after `segmentation_key`:

```python
def drafting_key(project_id: str, job_id: str) -> str:
    """A drafting stage's result for a workbench project (runs bucket, draft task)."""
    return f"drafting/{project_id}/{job_id}.json"
```

In `pipeline.py` `PipelineDeps`, add the last field:

```python
    #: YAML of a worked-example template shown to drafting models (None: no example).
    example_template: str | None = None
```

In `config.py` `Settings`, add `example_template: Path`, read in `from_env` as `Path(env.get("WORKBENCH_EXAMPLE_TEMPLATE", specs_dir / "process-validation-protocol" / "v3" / "template.yaml"))`. Compute `specs_dir` first if it is currently inline. In `main()`, pass `example_template=settings.example_template.read_text(encoding="utf-8") if settings.example_template.is_file() else None` to `PipelineDeps`.

- [ ] **Step 4: Write `drafting.py`**

`worker/src/ingest_worker/drafting.py`:

```python
"""Workbench drafting (ADR 0007): turn the brief, the current draft and the dev samples into
one context, ask the `draft` model for a stage body, validate it, write it to the runs bucket.

build_context is the single place that decides what a drafting model sees. Holdout samples
are refused here even though the API never sends them."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .extract import ExtractionFailedError, run_extraction
from .llm.base import RefusalError
from .llm.registry import ModelResolutionError
from .pipeline import DocumentError, PipelineDeps, check_cancelled, enforce_data_policy
from .queue import ClaimedJob, JobQueue
from .storage import drafting_key, prepared_text_key, run_key

MAX_SAMPLE_CHARS = 40_000
MAX_CONTEXT_SAMPLES = 8

DRAFT_SYSTEM = (
    "You help configure a document ingestion harness. You read sample documents and a user's "
    "brief and describe how to extract structured data from documents of this type. Respond "
    "only with JSON that satisfies the provided schema. Base every statement on the samples; "
    "say when something is uncertain instead of guessing."
)

RULES = """\
How the ingestion harness reads a document:
- Each PDF's text is extracted page by page; pages without a text layer are OCR'd, and OCR'd
  tables are flattened to one line per row with cells separated by two spaces.
- Pages are prefixed with a line "[page N]" (the original PDF page number).
- Some PDFs hold several copies of the document (e.g. a blank protocol followed by the executed
  one); a copy-selection anchor can keep only the first or last copy.
- The text is split into sections: each section starts at the first match of its anchor, a
  Python regular expression evaluated in multiline mode, and runs to the next section's start.
- A template declares outputs first: single-value fields (text, integer, decimal, date, boolean,
  enum, list) and typed tables; extraction steps then fill each output from chosen sections.
"""


@dataclass(frozen=True)
class DraftSample:
    sample_id: str
    filename: str
    role: str
    pages: list[str]


@dataclass(frozen=True)
class Stage:
    id: str
    instructions: str
    schema: dict[str, Any]


def _object(required: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(required),
        "properties": required,
    }


_STRING: dict[str, Any] = {"type": "string"}

#: Mirrors packages/shared/src/workbench.ts SurveyBodySchema.
SURVEY_SCHEMA: dict[str, Any] = _object(
    {
        "summary": _STRING,
        "structure": {
            "type": "array",
            "items": _object({"name": _STRING, "description": _STRING, "howToFind": _STRING}),
        },
        "variants": {"type": "array", "items": _STRING},
        "candidates": {
            "type": "array",
            "items": _object(
                {
                    "name": _STRING,
                    "description": _STRING,
                    "where": _STRING,
                    "kind": {"type": "string", "enum": ["field", "table"]},
                }
            ),
        },
        "questions": {
            "type": "array",
            "items": _object({"question": _STRING, "why": _STRING}),
        },
    }
)

SURVEY = Stage(
    "survey",
    """\
Task: survey these documents before anyone designs a template.
- summary: what kind of document this is and what the samples have in common, in 2-4 sentences.
- structure: the parts every (or most) sample has, in reading order, with howToFind = the
  heading or wording that marks where each part starts.
- variants: how the samples differ (issuers, layouts, scanned vs text, blank vs executed copies,
  missing parts).
- candidates: data worth extracting, guided by the brief: name (lowercase_snake_case), what it
  is, where it is found, and kind = field (one value per document) or table (repeating rows).
- questions: what you need the user to decide or explain before the outputs can be designed.
Return JSON only.""",
    SURVEY_SCHEMA,
)

STAGES: dict[str, Stage] = {SURVEY.id: SURVEY}

_BRIEF_LABELS = [
    ("purpose", "Purpose"),
    ("outputs", "Outputs wanted"),
    ("exampleOutput", "Example output"),
    ("glossary", "Glossary"),
    ("variants", "Known variants"),
    ("rules", "Rules"),
]


def _brief_text(brief: dict[str, Any]) -> str:
    parts = [
        f"{label}:\n{str(brief.get(key, '')).strip()}"
        for key, label in _BRIEF_LABELS
        if str(brief.get(key, "")).strip()
    ]
    for qa in brief.get("answers") or []:
        parts.append(f"Q: {qa.get('question', '')}\nA: {qa.get('answer', '')}")
    return "\n\n".join(parts) or "(no brief yet)"


def _sample_text(sample: DraftSample) -> str:
    text = "\n".join(f"[page {i + 1}]\n{page}" for i, page in enumerate(sample.pages))
    if len(text) > MAX_SAMPLE_CHARS:
        omitted = len(text) - MAX_SAMPLE_CHARS
        text = f"{text[:MAX_SAMPLE_CHARS]}\n[... truncated: {omitted} more characters]"
    return text


def build_context(
    *,
    brief: dict[str, Any],
    draft: dict[str, Any] | None,
    samples: list[DraftSample],
    example_yaml: str | None,
) -> str:
    """Everything a drafting model sees, in one string. Refuses holdout (non-dev) samples."""
    for s in samples:
        if s.role != "dev":
            raise ValueError(f"sample {s.sample_id} is {s.role}: holdout text is never sent to drafting")
    blocks = [f"<harness>\n{RULES}</harness>", f"<brief>\n{_brief_text(brief)}\n</brief>"]
    if example_yaml:
        blocks.append(f"<example_template>\n{example_yaml.strip()}\n</example_template>")
    if draft:
        blocks.append(
            f"<current_draft>\n{yaml.safe_dump(draft, sort_keys=False).strip()}\n</current_draft>"
        )
    for s in samples[:MAX_CONTEXT_SAMPLES]:
        blocks.append(f'<sample id="{s.sample_id}" file="{s.filename}">\n{_sample_text(s)}\n</sample>')
    return "\n\n".join(blocks)


class DraftParamSample(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    sample_id: str = Field(alias="sampleId")
    filename: str
    sha256: str
    role: str


class DraftParams(BaseModel):
    """jobs.params of a draft job (written by the API)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    stage: str
    data_policy: Literal["local", "external"] = Field(alias="dataPolicy")
    brief_version: int | None = Field(default=None, alias="briefVersion")
    brief: dict[str, Any]
    draft: dict[str, Any] | None = None
    samples: list[DraftParamSample]
    model: str | None = None


def _pages(deps: PipelineDeps, sha256: str) -> list[str]:
    raw = deps.store.get_optional(deps.buckets.runs, prepared_text_key(sha256))
    if raw is None:
        raise DocumentError(f"prepared text for {sha256} is missing")
    return [str(p["text"]) for p in json.loads(raw)["pages"]]


def run_draft(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    """Run one drafting stage and write its result (TS: DraftResult) to the runs bucket."""
    try:
        params = DraftParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid draft parameters: {exc}") from exc
    stage = STAGES.get(params.stage)
    if stage is None:
        raise DocumentError(f"drafting stage {params.stage!r} is not available")
    if job.project_id is None:
        raise DocumentError("draft job without a project")
    holdout = [s.sample_id for s in params.samples if s.role != "dev"]
    if holdout:
        raise DocumentError(f"holdout samples are never sent to drafting: {', '.join(holdout)}")

    ref = params.model or "draft"
    try:
        provider, model_id = deps.models.resolve(ref)
    except ModelResolutionError as exc:
        raise DocumentError(f"drafting model: {exc}") from exc
    enforce_data_policy(job, deps, provider, ref)
    model_ref = f"{provider.name}/{model_id}"

    samples = [DraftSample(s.sample_id, s.filename, s.role, _pages(deps, s.sha256)) for s in params.samples]
    context = build_context(
        brief=params.brief, draft=params.draft, samples=samples, example_yaml=deps.example_template
    )
    if deps.models.location(provider.name) == "external":
        queue.event(
            job.id,
            "info",
            "external model call",
            {"stage": stage.id, "model": model_ref, "samples": [s.sample_id for s in samples]},
        )
    check_cancelled(job, queue)
    try:
        result = run_extraction(
            extraction_id=f"draft-{stage.id}",
            provider=provider,
            model_id=model_id,
            prompt=f"{context}\n\n{stage.instructions}",
            schema=stage.schema,
            max_attempts=2,
            system=DRAFT_SYSTEM,
        )
    except ExtractionFailedError as exc:
        _audit(deps, job, stage, exc.attempts)
        raise DocumentError(str(exc)) from exc
    except RefusalError as exc:
        raise DocumentError(f"drafting model refused: {exc}") from exc
    _audit(deps, job, stage, result.attempts)

    last = result.attempts[-1]
    output = {
        "stage": stage.id,
        "model": result.model_ref,
        "body": result.data,
        "usage": {"inputTokens": last.input_tokens, "outputTokens": last.output_tokens},
    }
    check_cancelled(job, queue)
    deps.store.put(
        deps.buckets.runs,
        drafting_key(job.project_id, job.id),
        json.dumps(output).encode(),
        "application/json",
    )
    return output


def _audit(deps: PipelineDeps, job: ClaimedJob, stage: Stage, attempts: list[Any]) -> None:
    for a in attempts:
        record = {"prompt": a.prompt, "response": a.response, "errors": a.errors}
        deps.store.put(
            deps.buckets.runs,
            run_key(job.id, f"draft-{stage.id}", a.n),
            json.dumps(record).encode(),
            "application/json",
        )
```

Notes for the implementer:
- `run_key(job_id, extraction_id, attempt)` already exists in `storage.py` and returns `{job}/{extraction}/attempt-{n}.json`.
- `ExtractionFailedError.attempts` holds the attempts. Check `extract.py`. `OutputTruncatedError` is a subclass and is caught the same way.
- `usage` uses the last attempt's tokens. The test expects `{"inputTokens": 10, "outputTokens": 5}` from `FakeProvider`.
- If mypy rejects `list[Any]` in `_audit`, import `Attempt` from `.extract` and type the parameter `list[Attempt]`.

In `main.py`, import `run_draft` from `.drafting` and add a branch after `segment`:

```python
        if job.task == "draft":
            result = run_draft(job, deps, queue)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s drafted stage %s with %s", job.id, result["stage"], result["model"])
            return True
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run mypy`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker
git commit -m "Worker: drafting context (dev samples only) and the survey stage"
```

---

### Task 4: API repos: policy, job params, draft jobs, proposals

**Files:**
- Modify: `apps/api/src/repositories/{types,memory,pg}.ts`, `apps/api/src/workbench/repo.ts`
- Test: `apps/api/test/workbench-drafting-repo.test.ts` (new)

**Interfaces:**
- Consumes: migration 0010; `SegmentJob` from phase 2 (`{ id, projectId, status, error, createdAt, updatedAt }`).
- Produces:
  - In `types.ts`: `export type ProjectJob = SegmentJob;`
  - `WorkbenchJobOptions` gains `params?: Record<string, unknown>`. Memory stores it in `MemoryRepo.jobParams: Map<string, Record<string, unknown>>`, and Pg writes `jobs.params`.
  - `IngestionRepo.createDraftJob(projectId: string, params: Record<string, unknown>): Promise<ProjectJob>`. The job is document-less, with `task 'draft'`, `test true`, `priority WORKBENCH_PRIORITY`, `max_attempts 3`. It **does not** delete earlier draft jobs.
  - `IngestionRepo.listDraftJobs(projectId: string): Promise<ProjectJob[]>`, newest first. Memory keeps a separate `draftJobs: Map<string, ProjectJob & { params: Record<string, unknown> }>`, so draft jobs never show up as a `JobSummary`.
  - `WorkbenchRepo.setDataPolicy(id: string, policy: DataPolicy, by: string | null): Promise<WorkbenchProject | null>`
  - `interface ProposalRecord { id: string; projectId: string; stage: DraftStage; briefVersion: number | null; decision: 'accepted' | 'rejected' | null; decidedAt: string | null; createdAt: string }`
  - `WorkbenchRepo.createProposal(p: { id: string; projectId: string; stage: DraftStage; briefVersion: number | null }): Promise<ProposalRecord>`
  - `WorkbenchRepo.listProposals(projectId: string): Promise<ProposalRecord[]>`, newest first
  - `WorkbenchRepo.decideProposal(projectId: string, id: string, decision: 'accepted' | 'rejected'): Promise<ProposalRecord | null>`. It returns null if the proposal is unknown or already decided.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-drafting-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { WORKBENCH_PRIORITY } from '../src/repositories/types.js';
import { testApp } from './helpers.js';

async function setup() {
  const ctx = await testApp();
  await ctx.workbench.createProject('letter', 'Letter');
  return ctx;
}

describe('drafting persistence', () => {
  it('defaults projects to local-only and records who allows external models', async () => {
    const { workbench } = await setup();
    expect(await workbench.getProject('letter')).toMatchObject({
      dataPolicy: 'local',
      dataPolicyChangedAt: null,
      dataPolicyChangedBy: null,
    });
    const changed = await workbench.setDataPolicy('letter', 'external', 'admin');
    expect(changed).toMatchObject({ dataPolicy: 'external', dataPolicyChangedBy: 'admin' });
    expect(changed?.dataPolicyChangedAt).not.toBeNull();
    expect(await workbench.setDataPolicy('nope', 'external', 'admin')).toBeNull();
  });

  it('queues draft jobs without pruning earlier ones, and keeps them out of job lists', async () => {
    const { app, repo } = await setup();
    const first = await repo.createDraftJob('letter', { stage: 'survey' });
    const second = await repo.createDraftJob('letter', { stage: 'survey' });
    expect((await repo.listDraftJobs('letter')).map((j) => j.id)).toEqual([second.id, first.id]);
    expect(repo.draftJobs.get(first.id)?.params).toEqual({ stage: 'survey' });
    expect((await app.inject('/api/jobs')).json()).toEqual([]);
    expect(await repo.getJob(first.id)).toBeNull();
  });

  it('stores params on workbench jobs', async () => {
    const { repo } = await setup();
    const job = await repo.createWorkbenchJob(
      {
        id: 'd1',
        filename: 'a.pdf',
        sha256: 'x',
        sizeBytes: 1,
        specId: 'letter',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: 'k',
      },
      { projectId: 'letter', task: 'prepare', params: { dataPolicy: 'local' } },
    );
    expect(repo.jobParams.get(job.id)).toEqual({ dataPolicy: 'local' });
    expect(repo.priorities.get(job.id)).toBe(WORKBENCH_PRIORITY);
  });

  it('records proposals and one decision each', async () => {
    const { repo, workbench } = await setup();
    const job = await repo.createDraftJob('letter', {});
    await workbench.createProposal({ id: job.id, projectId: 'letter', stage: 'survey', briefVersion: 2 });
    expect(await workbench.listProposals('letter')).toEqual([
      expect.objectContaining({ id: job.id, stage: 'survey', briefVersion: 2, decision: null }),
    ]);
    expect(await workbench.decideProposal('letter', job.id, 'accepted')).toMatchObject({
      decision: 'accepted',
    });
    expect(await workbench.decideProposal('letter', job.id, 'rejected')).toBeNull();
    expect(await workbench.decideProposal('other', job.id, 'accepted')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-drafting-repo.test.ts`
Expected: FAIL. `workbench.setDataPolicy` is not a function.

- [ ] **Step 3: Implement the ingestion repo parts**

`types.ts`: add `params?: Record<string, unknown>` to `WorkbenchJobOptions` with a doc comment ("jobs.params, e.g. `{ dataPolicy }`; the worker enforces it, ADR 0007"). Add `export type ProjectJob = SegmentJob;` and the two port methods with doc comments.

`MemoryRepo`:

```ts
  /** jobs.params of workbench jobs. */
  readonly jobParams = new Map<string, Record<string, unknown>>();
  /** Draft jobs (document-less, ADR 0007): kept apart so no JobSummary path sees them. */
  readonly draftJobs = new Map<string, ProjectJob & { params: Record<string, unknown> }>();
```

In `createWorkbenchJob`, after creating the job, add `if (params) this.jobParams.set(job.id, params);`. Destructure `params` from the options.

```ts
  async createDraftJob(projectId: string, params: Record<string, unknown>) {
    const now = new Date().toISOString();
    const job: ProjectJob = {
      id: randomUUID(),
      projectId,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.draftJobs.set(job.id, { ...job, params });
    return job;
  }

  async listDraftJobs(projectId: string) {
    return [...this.draftJobs.values()]
      .filter((j) => j.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : -1))
      .map(({ id, projectId: p, status, error, createdAt, updatedAt }) => ({
        id,
        projectId: p,
        status,
        error,
        createdAt,
        updatedAt,
      }));
  }
```

(Two jobs created in the same millisecond tie on `createdAt`. Memory insertion order is the reliable order, so instead of the id tie-break you may track a sequence number. The test expects newest first.)

`PgRepo`:
- `insertDocumentAndJob` takes `params: Record<string, unknown> | null` and writes it as an extra `params` column (`JSON.stringify` or null).
- `createWorkbenchJob` passes `params ?? null`, and `createDocumentAndJob` passes `null`.
- Add:

```ts
  async createDraftJob(projectId: string, params: Record<string, unknown>) {
    const { rows } = await this.pool.query<SegmentRow>(
      `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params)
       VALUES ($1, 'draft', true, $2, 3, $3)
       RETURNING id, project_id, status, error, created_at, updated_at`,
      [projectId, WORKBENCH_PRIORITY, JSON.stringify(params)],
    );
    return toSegmentJob(rows[0]!);
  }

  async listDraftJobs(projectId: string) {
    const { rows } = await this.pool.query<SegmentRow>(
      `SELECT id, project_id, status, error, created_at, updated_at FROM jobs
        WHERE project_id = $1 AND task = 'draft' ORDER BY created_at DESC, id DESC`,
      [projectId],
    );
    return rows.map(toSegmentJob);
  }
```

- [ ] **Step 4: Implement the workbench repo parts**

In `apps/api/src/workbench/repo.ts`, add `ProposalRecord` and the four methods to the port.

`MemoryWorkbenchRepo`:
- `setDataPolicy` updates the stored project (`dataPolicy`, `dataPolicyChangedAt = now`, `dataPolicyChangedBy = by`) and returns it, or null.
- `proposals: ProposalRecord[]`.
- `createProposal` pushes `{ ...p, decision: null, decidedAt: null, createdAt: now }`.
- `listProposals` filters by project, newest first (by insertion order).
- `decideProposal` returns null when the proposal is unknown, belongs to another project, or is already decided. Otherwise it sets `decision` and `decidedAt`.

`PgWorkbenchRepo`:

```ts
  async setDataPolicy(id: string, policy: DataPolicy, by: string | null) {
    const { rows } = await this.pool.query<ProjectRow>(
      `UPDATE workbench_projects SET data_policy = $2, data_policy_changed_at = now(),
              data_policy_changed_by = $3 WHERE id = $1 RETURNING *`,
      [id, policy, by],
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async createProposal(p: { id: string; projectId: string; stage: DraftStage; briefVersion: number | null }) {
    const { rows } = await this.pool.query<ProposalRow>(
      `INSERT INTO workbench_proposals (id, project_id, stage, brief_version)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [p.id, p.projectId, p.stage, p.briefVersion],
    );
    return toProposal(rows[0]!);
  }

  async listProposals(projectId: string) {
    const { rows } = await this.pool.query<ProposalRow>(
      `SELECT * FROM workbench_proposals WHERE project_id = $1 ORDER BY created_at DESC, id DESC`,
      [projectId],
    );
    return rows.map(toProposal);
  }

  async decideProposal(projectId: string, id: string, decision: 'accepted' | 'rejected') {
    const { rows } = await this.pool.query<ProposalRow>(
      `UPDATE workbench_proposals SET decision = $3, decided_at = now()
        WHERE project_id = $1 AND id = $2 AND decision IS NULL RETURNING *`,
      [projectId, id, decision],
    );
    return rows[0] ? toProposal(rows[0]) : null;
  }
```

with `ProposalRow` (`id, project_id, stage, brief_version, decision, decided_at: Date | null, created_at: Date`) and `toProposal` converting to `ProposalRecord`. The `id` column is a uuid: callers validate ids before querying (Task 5).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "API: data policy, job params, draft jobs and proposals persistence"
```

---

### Task 5: API routes: data policy, the survey stage, proposals

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`
- Test: `apps/api/test/workbench-drafting.test.ts` (new)

**Interfaces:**
- Consumes: Task 4 repos; `sampleViews`, `versionsOf`, `readJson` (phases 1–2); `DataPolicySchema`, `DraftResultSchema`, `SurveyBodySchema`, `draftingKey`, `AVAILABLE_STAGES`, `DRAFT_STAGES` (Task 1).
- Produces:
  - `PUT /api/workbench/projects/:id/data-policy` with body `{ dataPolicy }`. It returns 200 with the `ProjectView`. It returns 400 for a bad body and 404 for an unknown project. When access enforcement is on, it returns **403 unless the session role is `admin`**; when `deps.access === null` it is allowed. `by` is set to the session label.
  - Phase-1 prepare jobs (sample upload) and dev test runs now pass `params: { dataPolicy: project.dataPolicy }`.
  - `POST /api/workbench/projects/:id/stages/:stage`:
    - It returns 400 for a stage not in `AVAILABLE_STAGES` (`stage <x> is not available yet`), 404 for an unknown project, 409 when there is no open draft or published version, and 409 when there are no ready dev samples.
    - Otherwise it builds the params `{ stage, dataPolicy, briefVersion, brief, draft, samples }`. `samples` contains only the **ready dev** samples, oldest first, each `{ sampleId, filename, sha256, role: 'dev' }`. `draft` is the open draft's definition, or else the latest version's. `brief` is the latest brief body, or `EMPTY_BRIEF`.
    - It creates the draft job and the proposal (`id = job.id`) and returns 202 with a `ProposalView` (status `running`).
  - `GET /api/workbench/projects/:id/proposals` returns `ProposalView[]`, newest first. The status is:
    - the decision, when one has been made;
    - otherwise `running` if the job is queued or running;
    - `ready` if the job succeeded and its result parses;
    - otherwise `failed`, with the job's error, or `'result missing'`, or `'result unreadable'`.

    `model` and `body` are set only for `ready`, `accepted` and `rejected`. `body` is parsed with `SurveyBodySchema` when `stage === 'survey'`.
  - `POST /api/workbench/projects/:id/proposals/:pid/decision` with body `{ decision: 'accepted' | 'rejected' }`. It returns the `ProposalView`. It returns 404 for an unknown or malformed id, and 409 unless the status is `ready`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-drafting.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  EMPTY_BRIEF,
  draftingKey,
  preparedTriageKey,
  type ProposalView,
  type SampleView,
} from '@ih/shared';
import { MemoryAccessRepo } from '../src/access/repo.js';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);
const survey = {
  summary: 'Letters.',
  structure: [],
  variants: [],
  candidates: [],
  questions: [{ question: 'Which date?', why: 'Two dates' }],
};

async function project(overrides = {}) {
  const ctx = await testApp(overrides);
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const add = async (n: number, role = 'dev', ready = true) => {
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    if (ready) {
      const job = ctx.repo.jobs.get(s.prepareJobId!)!;
      ctx.repo.jobs.set(job.id, { ...job, status: 'succeeded' });
      const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
      await ctx.store.put('runs', preparedTriageKey(s.sha256), Buffer.from(JSON.stringify(triage)), 'application/json');
    }
    return s;
  };
  const start = (stage = 'survey') =>
    ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/stages/${stage}` });
  return { ...ctx, add, start };
}

describe('data policy', () => {
  it('lets an admin allow external models', async () => {
    const { app } = await project();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/data-policy',
      payload: { dataPolicy: 'external' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().project).toMatchObject({ dataPolicy: 'external' });
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/data-policy',
      payload: { dataPolicy: 'cloud' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses user tokens', async () => {
    const access = new MemoryAccessRepo();
    const { app } = await project({ access });
    const { token } = await access.createToken('user', null);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token } });
    const cookie = /ih_session=([^;]*)/.exec(String(login.headers['set-cookie']))![1];
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/data-policy',
      payload: { dataPolicy: 'external' },
      headers: { cookie: `ih_session=${cookie}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('is carried by prepare jobs and test runs', async () => {
    const { app, repo, add } = await project();
    const s = await add(1);
    expect(repo.jobParams.get(s.prepareJobId!)).toEqual({ dataPolicy: 'local' });
    const run = await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/test-runs' });
    const [job] = run.json().jobs as { id: string }[];
    expect(repo.jobParams.get(job!.id)).toEqual({ dataPolicy: 'local' });
  });
});

describe('survey stage', () => {
  it('sends the brief, the draft and only the ready dev samples', async () => {
    const { repo, add, start } = await project();
    const dev = await add(1);
    await add(2, 'holdout');
    await add(3, 'dev', false);
    const res = await start();
    expect(res.statusCode).toBe(202);
    const view = res.json() as ProposalView;
    expect(view).toMatchObject({ stage: 'survey', status: 'running', body: null });
    expect(repo.draftJobs.get(view.id)!.params).toEqual({
      stage: 'survey',
      dataPolicy: 'local',
      briefVersion: null,
      brief: EMPTY_BRIEF,
      draft: letter(1),
      samples: [{ sampleId: dev.id, filename: 's1.pdf', sha256: dev.sha256, role: 'dev' }],
    });
  });

  it('refuses when only holdout samples are ready, and unavailable stages', async () => {
    const { add, start } = await project();
    await add(1, 'holdout');
    expect((await start()).statusCode).toBe(409);
    expect((await start('outputs')).statusCode).toBe(400);
    expect((await start('bogus')).statusCode).toBe(400);
  });

  it('shows the survey once ready and records one decision', async () => {
    const { app, repo, store, add, start } = await project();
    await add(1);
    const { id } = (await start()).json() as ProposalView;
    const list = async () => (await app.inject('/api/workbench/projects/letter/proposals')).json();
    expect((await list())[0]).toMatchObject({ id, status: 'running' });

    repo.draftJobs.set(id, { ...repo.draftJobs.get(id)!, status: 'succeeded' });
    const result = { stage: 'survey', model: 'local/big', body: survey, usage: { inputTokens: 1, outputTokens: 2 } };
    await store.put('runs', draftingKey('letter', id), Buffer.from(JSON.stringify(result)), 'application/json');
    expect((await list())[0]).toMatchObject({ status: 'ready', model: 'local/big', body: survey });

    const decide = (decision: string) =>
      app.inject({
        method: 'POST',
        url: `/api/workbench/projects/letter/proposals/${id}/decision`,
        payload: { decision },
      });
    expect((await decide('accepted')).json()).toMatchObject({ status: 'accepted', body: survey });
    expect((await decide('rejected')).statusCode).toBe(409);
  });

  it('reports a failed draft with its reason', async () => {
    const { app, repo, add, start } = await project();
    await add(1);
    const { id } = (await start()).json() as ProposalView;
    repo.draftJobs.set(id, {
      ...repo.draftJobs.get(id)!,
      status: 'needs_review',
      error: 'data policy: project is local-only but draft resolves to external provider anthropic',
    });
    const [view] = (await app.inject('/api/workbench/projects/letter/proposals')).json();
    expect(view).toMatchObject({ status: 'failed', error: expect.stringContaining('data policy') });
    const decide = await app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/proposals/${id}/decision`,
      payload: { decision: 'accepted' },
    });
    expect(decide.statusCode).toBe(409);
  });
});
```

(`access.createToken(label, expiresInDays)` returns `{ token, record }`; check `apps/api/src/access/repo.ts` and adapt the destructuring if needed. The login flow mirrors `apps/api/test/access.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-drafting.test.ts`
Expected: FAIL. The data-policy route returns 404.

- [ ] **Step 3: Implement the routes**

In `apps/api/src/routes/workbench.ts`:

```ts
const PolicyBody = z.object({ dataPolicy: DataPolicySchema }).strict();
const StageParams = z.object({ id: Id, stage: z.enum(DRAFT_STAGES) });
const ProposalParams = z.object({ id: Id, pid: z.string().uuid() });
const DecisionBody = z.object({ decision: z.enum(['accepted', 'rejected']) }).strict();

const isAdmin = (app: FastifyInstance, req: FastifyRequest) =>
  app.deps.access === null || req.auth?.role === 'admin';
```

Phase 1 calls `createWorkbenchJob` in the sample upload and test-run routes. Add `params: { dataPolicy: project.dataPolicy }` at both call sites. The test-run route must fetch the project, which it already does for its 404 check, so reuse that value.

```ts
  app.put<{ Params: ProjectParams }>('/workbench/projects/:id/data-policy', async (req, reply) => {
    if (!isAdmin(app, req)) return reply.code(403).send({ error: 'admins only' });
    const body = PolicyBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const project = await workbench.setDataPolicy(
      req.params.id,
      body.data.dataPolicy,
      req.auth?.label ?? null,
    );
    if (!project) return reply.code(404).send({ error: 'project not found' });
    req.log.info({ projectId: project.id, dataPolicy: project.dataPolicy }, 'data policy changed');
    return projectView(app, project);
  });

  app.post<{ Params: { id: string; stage: string } }>(
    '/workbench/projects/:id/stages/:stage',
    async (req, reply) => {
      const params = StageParams.safeParse(req.params);
      if (!params.success || !AVAILABLE_STAGES.includes(params.data.stage)) {
        return reply.code(400).send({ error: `stage ${req.params.stage} is not available yet` });
      }
      const { id: projectId, stage } = params.data;
      const project = await workbench.getProject(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const { draft, latest } = await versionsOf(templates, projectId);
      const record = draft !== null ? await templates.get(projectId, draft) : latest;
      if (!record) return reply.code(409).send({ error: 'the project has no template version' });
      // Holdout rule (ADR 0007): only dev samples ever reach a drafting model.
      const samples = (await sampleViews(app, projectId))
        .filter((s) => s.view.role === 'dev' && s.view.state === 'ready')
        .map((s) => ({
          sampleId: s.record.id,
          filename: s.record.filename,
          sha256: s.record.sha256,
          role: 'dev' as const,
        }));
      if (!samples.length) return reply.code(409).send({ error: 'no prepared dev samples' });
      const brief = await workbench.latestBrief(projectId);
      const job = await app.deps.repo.createDraftJob(projectId, {
        stage,
        dataPolicy: project.dataPolicy,
        briefVersion: brief?.version ?? null,
        brief: brief?.body ?? EMPTY_BRIEF,
        draft: record.definition,
        samples,
      });
      const proposal = await workbench.createProposal({
        id: job.id,
        projectId,
        stage,
        briefVersion: brief?.version ?? null,
      });
      return reply.code(202).send(await proposalView(app, proposal, job));
    },
  );

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/proposals', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const jobs = new Map((await app.deps.repo.listDraftJobs(req.params.id)).map((j) => [j.id, j]));
    const proposals = await workbench.listProposals(req.params.id);
    return Promise.all(proposals.map((p) => proposalView(app, p, jobs.get(p.id) ?? null)));
  });

  app.post<{ Params: { id: string; pid: string } }>(
    '/workbench/projects/:id/proposals/:pid/decision',
    async (req, reply) => {
      const params = ProposalParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'proposal not found' });
      const body = DecisionBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { id: projectId, pid } = params.data;
      const record = (await workbench.listProposals(projectId)).find((p) => p.id === pid);
      if (!record) return reply.code(404).send({ error: 'proposal not found' });
      const job = (await app.deps.repo.listDraftJobs(projectId)).find((j) => j.id === pid) ?? null;
      const current = await proposalView(app, record, job);
      if (current.status !== 'ready') {
        return reply.code(409).send({ error: `proposal is ${current.status}` });
      }
      const decided = await workbench.decideProposal(projectId, pid, body.data.decision);
      if (!decided) return reply.code(409).send({ error: 'proposal was already decided' });
      return proposalView(app, decided, job);
    },
  );
```

and the module-level helper:

```ts
async function proposalView(
  app: FastifyInstance,
  p: ProposalRecord,
  job: ProjectJob | null,
): Promise<ProposalView> {
  const base = {
    id: p.id,
    stage: p.stage,
    briefVersion: p.briefVersion,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
  };
  const empty = { ...base, model: null, body: null };
  if (!job || job.status === 'queued' || job.status === 'running') {
    return { ...empty, status: p.decision ?? 'running', error: null };
  }
  if (job.status !== 'succeeded') {
    return { ...empty, status: p.decision ?? 'failed', error: job.error ?? job.status };
  }
  const raw = await readJson(app, draftingKey(job.projectId, job.id));
  const parsed = raw === null ? null : DraftResultSchema.safeParse(raw);
  const body = parsed?.success && p.stage === 'survey' ? SurveyBodySchema.safeParse(parsed.data.body) : null;
  if (!parsed?.success || !body?.success) {
    return {
      ...empty,
      status: p.decision ?? 'failed',
      error: raw === null ? 'result missing' : 'result unreadable',
    };
  }
  return { ...base, status: p.decision ?? 'ready', error: null, model: parsed.data.model, body: body.data };
}
```

Wrap the body of `readJson`'s `JSON.parse` in try/catch returning a sentinel, or catch around the call here, so a corrupt object gives `'result unreadable'` and not a 500. Imports needed: `DataPolicySchema`, `DRAFT_STAGES`, `AVAILABLE_STAGES`, `EMPTY_BRIEF`, `DraftResultSchema`, `SurveyBodySchema`, `draftingKey` and the `ProposalView` type from `@ih/shared`; `FastifyRequest` from fastify; `ProjectJob` from `../repositories/types.js`; `ProposalRecord` from `../workbench/repo.js`.

`projectView` already returns `project`, which now carries `dataPolicy`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`
Expected: PASS, including the `access.test.ts` sweep over the new routes.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: data policy route, survey stage (dev samples only) and proposals"
```

---

### Task 6: Web: client, routes, policy badge and admin toggle

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/src/router.ts`, `apps/web/src/App.tsx`, `apps/web/src/workbench/ProjectPage.tsx`
- Test: `apps/web/test/client.test.ts`, `apps/web/test/router.test.ts`, `apps/web/test/ProjectPage.test.tsx`

**Interfaces:**
- Produces:
  - Api methods:
    - `setDataPolicy(projectId: string, dataPolicy: DataPolicy): Promise<ProjectView>` (PUT)
    - `startStage(projectId: string, stage: DraftStage): Promise<ProposalView>` (POST)
    - `listProposals(projectId: string): Promise<ProposalView[]>`
    - `decideProposal(projectId: string, proposalId: string, decision: 'accepted' | 'rejected'): Promise<ProposalView>`
  - `PROJECT_TABS = ['samples', 'brief', 'survey', 'sections', 'template', 'runs']`
  - `ProjectPage` takes `role: 'admin' | 'user'` (from `App`'s `me.role`). Its header shows a policy badge, "Local models only" or "External models allowed". Admins also get a button, "Allow external models" or "Restrict to local models". Turning external on asks `window.confirm('Sample text from dev samples may be sent to external model providers. Allow?')` first.
  - fake-api defaults: `setDataPolicy`, `startStage` and `decideProposal` throw "not stubbed"; `listProposals` returns `[]`. Builder `proposalView(overrides?)`.

- [ ] **Step 1: Write the failing tests**

`router.test.ts` row: `['#/workbench/letter/survey', { name: 'project', projectId: 'letter', tab: 'survey' }]`.

`client.test.ts`:

```ts
describe('http api: drafting', () => {
  it('changes the data policy and starts a stage', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.setDataPolicy('letter', 'external');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/workbench/projects/letter/data-policy');
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('PUT');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ dataPolicy: 'external' });
    await api.startStage('letter', 'survey');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/workbench/projects/letter/stages/survey');
    await api.decideProposal('letter', 'p1', 'accepted');
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/workbench/projects/letter/proposals/p1/decision');
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body))).toEqual({ decision: 'accepted' });
  });
});
```

`ProjectPage.test.tsx`. The existing `page()` helper must now pass `role`; add `role="admin"` to it. Then add:

```tsx
  it('shows the data policy and lets an admin allow external models after confirming', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      setDataPolicy: vi.fn(async () =>
        projectView({ project: { ...projectView().project, dataPolicy: 'external' } }),
      ),
    });
    render(<ProjectPage api={api} projectId="letter" tab="samples" onNavigate={vi.fn()} role="admin" />);
    expect(await screen.findByText('Local models only')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow external models' }));
    expect(confirm).toHaveBeenCalled();
    expect(api.setDataPolicy).toHaveBeenCalledWith('letter', 'external');
    expect(await screen.findByText('External models allowed')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('hides the policy switch from users', async () => {
    render(
      <ProjectPage
        api={fakeApi({ getProject: vi.fn(async () => projectView()) })}
        projectId="letter"
        tab="samples"
        onNavigate={vi.fn()}
        role="user"
      />,
    );
    expect(await screen.findByText('Local models only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /external models/i })).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/router.test.ts apps/web/test/client.test.ts apps/web/test/ProjectPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `router.ts`: `PROJECT_TABS = ['samples', 'brief', 'survey', 'sections', 'template', 'runs'] as const`.
- `ProjectPage.tsx`:
  - Add `survey: 'Survey'` to `TAB_LABEL`.
  - Add the prop `role: 'admin' | 'user'`.
  - Next to the header's meta line, render:

```tsx
      <p className="policy">
        <span className={`pill ${view.project.dataPolicy === 'external' ? 'tone-warn' : 'tone-ok'}`}>
          {view.project.dataPolicy === 'external' ? 'External models allowed' : 'Local models only'}
        </span>
        {role === 'admin' && (
          <button type="button" onClick={() => void togglePolicy()}>
            {view.project.dataPolicy === 'external' ? 'Restrict to local models' : 'Allow external models'}
          </button>
        )}
      </p>
```

with

```tsx
  const togglePolicy = async () => {
    if (!view) return;
    const next = view.project.dataPolicy === 'external' ? 'local' : 'external';
    if (
      next === 'external' &&
      !window.confirm('Sample text from dev samples may be sent to external model providers. Allow?')
    ) {
      return;
    }
    await act(async () => setView(await api.setDataPolicy(view.project.id, next)));
  };
```

(`act` here is the page's existing error-catching helper. Rename it if it clashes with Testing Library's `act`; the page module doesn't import that. Use the pill or tone classes that exist in `styles.css`; check with grep. If there is no `tone-warn`, use the closest existing tone and say so in the report.)

- `App.tsx`: pass `role={me.role}` to `ProjectPage`.
- `client.ts`, `fake-api.ts`: add the four methods. They follow the existing patterns: `post<T>(url, body, 'PUT')` for the policy, `post` for the stage start (body `{}`) and the decision, and `apiFetch(...).then(json<T>)` for the list. Builder:

```ts
export function proposalView(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id: crypto.randomUUID(),
    stage: 'survey',
    status: 'ready',
    error: null,
    briefVersion: 1,
    model: 'local/qwen',
    body: {
      summary: 'Process validation protocols, blank and executed.',
      structure: [{ name: 'Approvals', description: 'Signatures', howToFind: 'PROTOCOL APPROVAL' }],
      variants: ['Executed copy follows the blank one'],
      candidates: [
        { name: 'protocol_number', description: 'Protocol id', where: 'page header', kind: 'field' },
      ],
      questions: [{ question: 'Which copy should be extracted?', why: 'Some PDFs hold two copies' }],
    },
    createdAt: '2026-10-13T00:00:00.000Z',
    decidedAt: null,
    ...overrides,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: drafting client, Survey tab route, data-policy badge and admin switch"
```

---

### Task 7: Web: Survey tab

**Files:**
- Create: `apps/web/src/workbench/SurveyTab.tsx`
- Modify: `apps/web/src/workbench/ProjectPage.tsx`
- Test: `apps/web/test/SurveyTab.test.tsx` (new), `apps/web/test/BriefTab.test.tsx`

**Interfaces:**
- Consumes: `startStage`, `listProposals`, `decideProposal`, `saveBrief` (Api); `proposalView()` (fake-api).
- Produces: `SurveyTab({ api, projectId, dataPolicy, brief, onBriefSaved, pollMs })`.
  - It shows the latest survey proposal.
  - A **Run survey** button sits beside a policy note:
    - local: "Runs on local models; holdout samples are never sent."
    - external: "Dev sample text may be sent to an external model provider; holdout samples are never sent."
  - While the latest proposal is `running`, the tab polls `listProposals` every `pollMs`.
  - A failed proposal shows its error (`role="alert"`).
  - A ready, accepted or rejected proposal shows:
    - the summary;
    - the structure as a list;
    - the variants;
    - the candidates as a table labelled "Candidate data";
    - each question with a labelled textarea (`aria-label` = the question).
  - **Save answers to brief** appends the answered questions to `brief.answers`, replacing any existing answer to the same question, and calls `saveBrief` with the whole body.
  - **Accept** and **Reject** appear only for `ready` proposals.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/SurveyTab.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BRIEF } from '@ih/shared';
import { SurveyTab } from '../src/workbench/SurveyTab.js';
import { fakeApi, proposalView } from './fake-api.js';

const brief = { projectId: 'letter', version: 2, body: { ...EMPTY_BRIEF, purpose: 'QA' }, createdAt: '' };

function tab(overrides = {}, dataPolicy: 'local' | 'external' = 'local') {
  const api = fakeApi(overrides);
  const onBriefSaved = vi.fn();
  render(
    <SurveyTab
      api={api}
      projectId="letter"
      dataPolicy={dataPolicy}
      brief={brief}
      onBriefSaved={onBriefSaved}
      pollMs={1}
    />,
  );
  return { api, onBriefSaved };
}

describe('SurveyTab', () => {
  it('runs a survey and polls until it is ready', async () => {
    const listProposals = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([proposalView({ status: 'running', body: null })])
      .mockResolvedValue([proposalView()]);
    const { api } = tab({
      listProposals,
      startStage: vi.fn(async () => proposalView({ status: 'running', body: null })),
    });
    expect(await screen.findByText(/holdout samples are never sent/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run survey' }));
    expect(api.startStage).toHaveBeenCalledWith('letter', 'survey');
    expect(await screen.findByText('Process validation protocols, blank and executed.')).toBeInTheDocument();
    const candidates = screen.getByRole('table', { name: 'Candidate data' });
    expect(within(candidates).getByText('protocol_number')).toBeInTheDocument();
  });

  it('warns that external models may receive dev sample text', async () => {
    tab({}, 'external');
    expect(await screen.findByText(/may be sent to an external model provider/)).toBeInTheDocument();
  });

  it('shows why a survey failed', async () => {
    tab({
      listProposals: vi.fn(async () => [
        proposalView({ status: 'failed', body: null, error: 'data policy: project is local-only' }),
      ]),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('data policy');
  });

  it('saves answers into the brief, keeping the rest of it', async () => {
    const saved = { ...brief, version: 3 };
    const { api, onBriefSaved } = tab({
      listProposals: vi.fn(async () => [proposalView()]),
      saveBrief: vi.fn(async () => saved),
    });
    await userEvent.type(
      await screen.findByLabelText('Which copy should be extracted?'),
      'The executed copy',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save answers to brief' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', {
      ...brief.body,
      answers: [{ question: 'Which copy should be extracted?', answer: 'The executed copy' }],
    });
    expect(onBriefSaved).toHaveBeenCalledWith(saved);
  });

  it('accepts a ready survey', async () => {
    const p = proposalView();
    const { api } = tab({
      listProposals: vi.fn(async () => [p]),
      decideProposal: vi.fn(async () => ({ ...p, status: 'accepted' as const })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', p.id, 'accepted');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull());
    expect(screen.getByText(/accepted/i)).toBeInTheDocument();
  });
});
```

Append to `apps/web/test/BriefTab.test.tsx` (Review Focus 5):

```tsx
  it('keeps survey answers when the brief is edited and saved', async () => {
    const answers = [{ question: 'Which copy?', answer: 'Executed' }];
    const api = fakeApi({
      saveBrief: vi.fn(async () => ({ projectId: 'letter', version: 4, body: { ...EMPTY_BRIEF, answers }, createdAt: '' })),
    });
    render(
      <BriefTab
        api={api}
        projectId="letter"
        brief={{ projectId: 'letter', version: 3, body: { ...EMPTY_BRIEF, answers }, createdAt: '' }}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Purpose'), 'QA');
    await userEvent.click(screen.getByRole('button', { name: 'Save brief' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', { ...EMPTY_BRIEF, purpose: 'QA', answers });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/SurveyTab.test.tsx apps/web/test/BriefTab.test.tsx`
Expected: FAIL. `SurveyTab` does not exist. The BriefTab test may already pass, because the tab keeps the whole body. If it does, keep it as a regression guard.

- [ ] **Step 3: Write `SurveyTab`**

`apps/web/src/workbench/SurveyTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { Brief, DataPolicy, ProposalView } from '@ih/shared';
import { EMPTY_BRIEF } from '@ih/shared';
import type { Api } from '../api/client.js';

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

/** Drafting stage 1: the model surveys the dev samples and asks questions (ADR 0007). */
export function SurveyTab({
  api,
  projectId,
  dataPolicy,
  brief,
  onBriefSaved,
  pollMs,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  brief: Brief | null;
  onBriefSaved: (brief: Brief) => void;
  pollMs: number;
}) {
  const [proposal, setProposal] = useState<ProposalView | null | undefined>(undefined);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await api.listProposals(projectId);
      setProposal(all.find((p) => p.stage === 'survey') ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = proposal?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, refresh]);

  const act = async (action: () => Promise<void>) => {
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const run = () =>
    act(async () => {
      setProposal(await api.startStage(projectId, 'survey'));
    });

  const decide = (decision: 'accepted' | 'rejected') =>
    act(async () => {
      setProposal(await api.decideProposal(projectId, proposal!.id, decision));
    });

  const saveAnswers = () =>
    act(async () => {
      const body = brief?.body ?? EMPTY_BRIEF;
      const given = Object.entries(answers).filter(([, a]) => a.trim());
      const kept = body.answers.filter((qa) => !given.some(([q]) => q === qa.question));
      const saved = await api.saveBrief(projectId, {
        ...body,
        answers: [...kept, ...given.map(([question, answer]) => ({ question, answer: answer.trim() }))],
      });
      onBriefSaved(saved);
      setMessage(`Answers saved to brief version ${saved.version}`);
    });

  if (proposal === undefined) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;
  const body = proposal?.body ?? null;

  return (
    <div className="survey-tab">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      <button type="button" className="primary" disabled={running} onClick={() => void run()}>
        {proposal ? 'Run survey again' : 'Run survey'}
      </button>
      {running && <span className="muted"> Surveying the dev samples…</span>}
      {error && <p role="alert">{error}</p>}
      {proposal?.status === 'failed' && <p role="alert">{proposal.error}</p>}
      {message && <p role="status">{message}</p>}
      {body && proposal && (
        <section aria-label="Survey">
          <p className="muted">
            {proposal.model} · brief v{proposal.briefVersion ?? '–'} · {proposal.status}
          </p>
          <h3>Summary</h3>
          <p>{body.summary}</p>
          <h3>Structure</h3>
          <ol>
            {body.structure.map((s) => (
              <li key={s.name}>
                <strong>{s.name}</strong>: {s.description} <small className="muted">({s.howToFind})</small>
              </li>
            ))}
          </ol>
          <h3>Variants</h3>
          <ul>
            {body.variants.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
          <table aria-label="Candidate data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>What</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {body.candidates.map((c) => (
                <tr key={c.name}>
                  <td>
                    <code>{c.name}</code>
                  </td>
                  <td>{c.kind}</td>
                  <td>{c.description}</td>
                  <td>{c.where}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {body.questions.length > 0 && (
            <>
              <h3>Questions</h3>
              {body.questions.map((q) => (
                <div key={q.question} className="question">
                  <p>
                    {q.question} <small className="muted">{q.why}</small>
                  </p>
                  <textarea
                    aria-label={q.question}
                    rows={2}
                    value={answers[q.question] ?? ''}
                    onChange={(e) => setAnswers({ ...answers, [q.question]: e.target.value })}
                  />
                </div>
              ))}
              <button
                type="button"
                disabled={!Object.values(answers).some((a) => a.trim())}
                onClick={() => void saveAnswers()}
              >
                Save answers to brief
              </button>
            </>
          )}
          {proposal.status === 'ready' && (
            <div className="actions">
              <button type="button" className="primary" onClick={() => void decide('accepted')}>
                Accept
              </button>
              <button type="button" onClick={() => void decide('rejected')}>
                Reject
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
```

In `ProjectPage.tsx`, render after the Brief branch:

```tsx
      {tab === 'survey' && (
        <SurveyTab
          api={api}
          projectId={project.id}
          dataPolicy={project.dataPolicy}
          brief={view.brief}
          onBriefSaved={(brief) => setView({ ...view, brief })}
          pollMs={pollMs}
        />
      )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: Survey tab (run, poll, answers into the brief, accept or reject)"
```

---

### Task 8: Docs, full check and smoke test

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md`, `deploy/.env.example` (if it lists LLM env vars)

- [ ] **Step 1: Document it**

`CLAUDE.md`:
- Contracts table:
  - Add a row for **Data policy and drafting**. TypeScript side: `DataPolicy`, `params.dataPolicy`, `SurveyBodySchema`, `DraftResultSchema`, `draftingKey`. Python side: `pipeline.enforce_data_policy`, `drafting.DraftParams`, `drafting.SURVEY_SCHEMA`, `storage.drafting_key`.
  - Extend the job tasks row with `draft`.
- LLM layer bullet:
  - Providers declare `location: local | external` (undeclared = external).
  - Add the `draft` alias.
  - Every project job carries `params.dataPolicy` (missing = local). The worker refuses an external provider for a local-only project before any call, in extraction, OCR and drafting.
- Workbench bullet:
  - Drafting jobs are document-less `draft` jobs.
  - The API sends only ready **dev** samples; `drafting.build_context` refuses anything else.
  - Proposals live in `workbench_proposals`, with status derived from the job and the body in `drafting/{project}/{job}.json`.
  - Only the admin token can allow external models.
  - External drafting calls are logged as `external model call` job events.

`docs/architecture.md`: in the Workbench section, add a short paragraph on drafting and the data policy.

`docs/design/workbench.md`: under Phasing, mark phase 3 as split into 3a (data policy and survey, this plan) and 3b (outputs, sections, steps, references).

`deploy/.env.example`: if it lists model env vars, add `DRAFT_MODEL=` with a comment.

- [ ] **Step 2: Full check**

Run `npm run check` and `npm run format:check`. If `uv` is not on PATH, run the parts separately.
Expected: PASS.

- [ ] **Step 3: Smoke test (throwaway infra only)**

1. Start the stack against a throwaway Postgres; 0010 applies on API start.
2. Create a project and add two dev samples and one holdout sample. Fill in the brief.
3. As a **user** token: the project shows "Local models only" and has no switch.
4. Survey tab → Run survey, with `draft` pointing at the local model. The survey appears.
5. Answer a question and save it to the brief. The Brief tab still shows the other fields, and the answers persist across a Brief save.
6. Set `DRAFT_MODEL=anthropic/claude-opus-5-5` and restart the worker. Run the survey again: it fails with "data policy: …", and no Anthropic call is made (check the worker log).
7. As **admin**, allow external models and re-run. It succeeds.
8. `job_events` holds `external model call` with the dev sample ids only.

Record anything you couldn't run in the PR description.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs deploy/.env.example
git commit -m "Workbench: document phase 3a (data policy, drafting, survey)"
```
