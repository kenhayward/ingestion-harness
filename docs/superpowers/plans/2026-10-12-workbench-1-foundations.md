# Workbench 1/6: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-level **Workbench** page where a user creates a project for a document type, uploads sample PDFs that the worker prepares (text + OCR) in the background, reads the prepared text, writes a structured brief, edits the draft template, and test-runs the draft on the dev samples, with all workbench work queued behind production jobs.

**Architecture:** Three new tables (`workbench_projects`, `workbench_samples`, `workbench_briefs`) behind a new `WorkbenchRepo` port, plus three `jobs` columns/values (`priority`, `project_id`, task `prepare`). A sample is an ordinary `documents` row; uploading one queues a `prepare` job that runs `extract_text` + OCR (mode `auto`) and writes the page text and a small triage summary to the runs bucket, keyed by the PDF's sha256. A sample's state is derived from its prepare job's status (no worker write to workbench tables). Dev test runs are ordinary test jobs (`jobs.test`), like regression runs: a new document row per run pointing at the sample's stored PDF. The web app gets a `#/workbench` list and a `#/workbench/<id>/<tab>` project page that embeds the existing `TemplateEditor`.

**Tech Stack:** Fastify + Zod (API), React + Testing Library + Vitest (web), Python 3.13 + pytest + mypy strict (worker), Postgres migrations.

**Spec:** [docs/design/workbench.md](../../design/workbench.md) (Phase 1) and [ADR 0007](../../adr/0007-workbench.md).

## Global Constraints

- TypeScript: ESM with `.js` import suffixes, Zod at every boundary (request bodies, stored JSON read back), no `any` without a comment.
- Python: `from __future__ import annotations`, `mypy --strict`, ruff.
- Migrations are forward-only: add `db/migrations/0008_workbench.sql`; never edit an applied one.
- `apps/api` stays free of LLM logic and PDF processing; the worker stays free of HTTP serving.
- Unit tests never touch the network, Postgres, SeaweedFS or a real LLM; never call real LLM APIs from tests.
- Cross-language contracts change on both sides in the same PR: job tasks (`prepare`), object keys (`preparedTextKey`/`preparedTriageKey`).
- Queue priority: production jobs `0`, workbench jobs `-10` (`WORKBENCH_PRIORITY`); the claim orders by `priority DESC, run_after, created_at`.
- Project id = template id (`^[a-z][a-z0-9_-]*$`). One long-lived project per document type.
- Sample limit: `MAX_SAMPLES = 12` per project (the design asks for 3–8 dev samples plus a few held out; 12 leaves room for both).
- Every `/api/*` route needs a session (ADR 0006); the sweep in `apps/api/test/access.test.ts` covers new routes automatically once they're registered in `buildApp`.
- Phase 1 does **not** include: segmentation preview, drafting, data policy, step cache, scorecards, holdout runs, publish gate. Holdout samples are only a label in this phase.
- Run `npm run check` and `npm run worker:lint && npm run worker:test` before declaring done.

## Review Focus

1. **A failed preparation is retried as a preparation.** The existing Retry turns any non-cancelled job back into `process`; a failed `prepare` job (OCR server down) must stay `prepare`, or it would run extraction on a draft. (Task 3 test.)
2. **Job housekeeping never destroys a sample.** Deleting a prepare job, or bulk clean-up on the Jobs page, must not delete the sample's `documents` row or its inbox PDF, and prepare jobs must not appear on the Jobs page at all. (Task 3 tests.)
3. **The same PDF twice.** Twice in one project → 409, nothing stored; the same PDF in two projects → allowed, and both read the same prepared text (keyed by sha256). (Task 6 tests.)
4. **A test run that can't work is refused up front.** No open draft, an invalid draft, or no prepared dev samples → a clear 4xx instead of queuing jobs that fail one by one. (Task 7 tests.)
5. **Workbench work never delays production.** An older queued workbench job is claimed after a newer production job. (Task 2 integration test.)

---

## File map

| File | Responsibility |
| --- | --- |
| `db/migrations/0008_workbench.sql` (new) | `jobs.priority`, `jobs.project_id`, task `prepare`, claim index, workbench tables |
| `packages/shared/src/workbench.ts` (new) | Sample roles, `MAX_SAMPLES`, brief schema, prepared-text/triage schemas, view types |
| `packages/shared/src/jobs.ts` | `task` gains `prepare`; `JobSummary.projectId` |
| `packages/shared/src/storage-keys.ts` | `preparedTextKey`, `preparedTriageKey` |
| `worker/src/ingest_worker/storage.py` | Same keys in Python |
| `worker/src/ingest_worker/queue.py` | Claim by priority |
| `worker/src/ingest_worker/pipeline.py` | `_ocr_pages` → public `ocr_pages` |
| `worker/src/ingest_worker/workbench.py` (new) | `prepare_sample` |
| `worker/src/ingest_worker/main.py` | `prepare` branch in `run_once` |
| `apps/api/src/repositories/{types,memory,pg}.ts` | `createWorkbenchJob`, `listProjectJobs`, prepare-job exclusions, sample-document guard |
| `apps/api/src/workbench/repo.ts` (new) | `WorkbenchRepo` port, `MemoryWorkbenchRepo`, `PgWorkbenchRepo` |
| `apps/api/src/templates/drafts.ts` (new) | `skeleton`, `pinned`, `createNextDraft` (moved out of `routes/templates.ts`) |
| `apps/api/src/uploads.ts` (new) | `isPdf`, `multipartField` (moved out of `routes/documents.ts`) |
| `apps/api/src/routes/workbench.ts` (new) | `/api/workbench/*` |
| `apps/api/src/app.ts`, `server.ts`, `test/helpers.ts` | Wire `workbench` dep |
| `apps/web/src/api/client.ts`, `test/fake-api.ts` | Workbench API methods |
| `apps/web/src/router.ts`, `shell/derive.ts`, `shell/AppShell.tsx`, `ui/Icon.tsx`, `App.tsx` | Routes + nav |
| `apps/web/src/workbench/*.tsx` (new) | `WorkbenchPage`, `ProjectPage`, `SamplesTab`, `SampleText`, `BriefTab`, `RunsTab` |
| `apps/web/src/templates/TemplatesPage.tsx` | "Open in workbench" link |
| `apps/web/src/styles.css` | Workbench styles |
| `CLAUDE.md`, `docs/architecture.md` | Document the Workbench |

---

### Task 1: Migration and shared contracts

**Files:**
- Create: `db/migrations/0008_workbench.sql`
- Create: `packages/shared/src/workbench.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/jobs.ts`, `packages/shared/src/storage-keys.ts`
- Test: `packages/shared/test/workbench.test.ts`

**Interfaces:**
- Produces (TypeScript, `@ih/shared`):
  - `SAMPLE_ROLES = ['dev', 'holdout']`, `SampleRoleSchema`, `type SampleRole`
  - `MAX_SAMPLES = 12`
  - `BriefBodySchema` (strict; keys `purpose`, `outputs`, `exampleOutput`, `glossary`, `variants`, `rules`, all strings defaulting to `''`), `type BriefBody`, `EMPTY_BRIEF: BriefBody`
  - `interface Brief { projectId: string; version: number; body: BriefBody; createdAt: string }`
  - `interface WorkbenchProject { id: string; name: string; createdAt: string }`
  - `interface ProjectSummary extends WorkbenchProject { draft: number | null; published: number | null; samples: number }`
  - `interface ProjectView { project: WorkbenchProject; draft: number | null; published: number | null; brief: Brief | null }`
  - `PreparedTextSchema`/`type PreparedText` = `{ sha256: string; pages: { number: number; text: string; ocr: boolean }[] }`
  - `PreparedTriageSchema`/`type PreparedTriage` = `{ sha256: string; pageCount: number; ocrPages: number[]; chars: number; ocrModel: string | null }`
  - `type SampleState = 'preparing' | 'ready' | 'failed'`
  - `interface SampleView { id; projectId; documentId; filename; sizeBytes: number; sha256; role: SampleRole; addedForVersion: number; createdAt; state: SampleState; prepareJobId: string | null; error: string | null; triage: PreparedTriage | null }`
  - `preparedTextKey(sha256)` → `prepared/{sha256}/text.json`; `preparedTriageKey(sha256)` → `prepared/{sha256}/triage.json`
  - `JobSummary.task` includes `'prepare'`; `JobSummary.projectId: string | null`

- [ ] **Step 1: Write the failing test**

`packages/shared/test/workbench.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BriefBodySchema,
  EMPTY_BRIEF,
  JobSummarySchema,
  PreparedTextSchema,
  PreparedTriageSchema,
  preparedTextKey,
  preparedTriageKey,
} from '../src/index.js';

describe('workbench contracts', () => {
  it('keys prepared text and triage by the PDF sha256 (mirrors worker storage.py)', () => {
    expect(preparedTextKey('abc')).toBe('prepared/abc/text.json');
    expect(preparedTriageKey('abc')).toBe('prepared/abc/triage.json');
  });

  it('fills a partial brief with empty strings and rejects unknown keys', () => {
    expect(BriefBodySchema.parse({ purpose: 'Batch records' })).toEqual({
      ...EMPTY_BRIEF,
      purpose: 'Batch records',
    });
    expect(BriefBodySchema.safeParse({ purpose: 'x', colour: 'red' }).success).toBe(false);
  });

  it('parses the prepared text and triage the worker writes', () => {
    expect(
      PreparedTextSchema.parse({
        sha256: 'abc',
        pages: [{ number: 1, text: 'HEADER', ocr: false }],
      }).pages[0]!.ocr,
    ).toBe(false);
    expect(
      PreparedTriageSchema.parse({
        sha256: 'abc',
        pageCount: 2,
        ocrPages: [2],
        chars: 40,
        ocrModel: 'local/olmocr-2-7b-1025',
      }).ocrPages,
    ).toEqual([2]);
  });

  it('accepts prepare jobs with a project', () => {
    const job = JobSummarySchema.shape.task.parse('prepare');
    expect(job).toBe('prepare');
    expect(JobSummarySchema.shape.projectId.parse(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/workbench.test.ts`
Expected: FAIL — `preparedTextKey` / `BriefBodySchema` are not exported.

- [ ] **Step 3: Write the migration**

`db/migrations/0008_workbench.sql`:

```sql
-- Workbench phase 1 (ADR 0007): projects, samples and briefs; the `prepare` task (text + OCR
-- only); queue priority so workbench work never delays production jobs.

ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare'));

-- Higher runs first: production 0, workbench -10.
ALTER TABLE jobs ADD COLUMN priority smallint NOT NULL DEFAULT 0;
DROP INDEX jobs_claim_idx;
CREATE INDEX jobs_claim_idx ON jobs (priority DESC, run_after, created_at) WHERE status = 'queued';

-- One long-lived project per document type: id = template id.
CREATE TABLE workbench_projects (
  id          text        PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]*$'),
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jobs ADD COLUMN project_id text REFERENCES workbench_projects (id);
CREATE INDEX jobs_project_idx ON jobs (project_id, created_at) WHERE project_id IS NOT NULL;

-- A sample is an ordinary document; its prepare job is the job on that document with
-- task = 'prepare'. Deleting jobs never deletes a document a sample still uses.
CREATE TABLE workbench_samples (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         text        NOT NULL REFERENCES workbench_projects (id),
  document_id        uuid        NOT NULL REFERENCES documents (id),
  role               text        NOT NULL DEFAULT 'dev' CHECK (role IN ('dev', 'holdout')),
  added_for_version  integer     NOT NULL CHECK (added_for_version > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, document_id)
);

-- Append-only: every save is a new version.
CREATE TABLE workbench_briefs (
  project_id  text        NOT NULL REFERENCES workbench_projects (id),
  version     integer     NOT NULL CHECK (version > 0),
  body        jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version)
);
```

- [ ] **Step 4: Add the shared contracts**

`packages/shared/src/workbench.ts`:

```ts
import { z } from 'zod';

/** Workbench (ADR 0007): sample roles, brief, prepared text. Mirrors worker/src/ingest_worker/workbench.py. */
export const SAMPLE_ROLES = ['dev', 'holdout'] as const;
export const SampleRoleSchema = z.enum(SAMPLE_ROLES);
export type SampleRole = z.infer<typeof SampleRoleSchema>;

/** Most samples a project holds: 3–8 dev samples plus a few held out. */
export const MAX_SAMPLES = 12;

export const BriefBodySchema = z
  .object({
    purpose: z.string().default(''),
    outputs: z.string().default(''),
    exampleOutput: z.string().default(''),
    glossary: z.string().default(''),
    variants: z.string().default(''),
    rules: z.string().default(''),
  })
  .strict();
export type BriefBody = z.infer<typeof BriefBodySchema>;

export const EMPTY_BRIEF: BriefBody = {
  purpose: '',
  outputs: '',
  exampleOutput: '',
  glossary: '',
  variants: '',
  rules: '',
};

export interface Brief {
  projectId: string;
  version: number;
  body: BriefBody;
  createdAt: string;
}

export interface WorkbenchProject {
  id: string;
  name: string;
  createdAt: string;
}

export interface ProjectSummary extends WorkbenchProject {
  draft: number | null;
  published: number | null;
  samples: number;
}

export interface ProjectView {
  project: WorkbenchProject;
  /** The open draft version being developed; null when every version is published. */
  draft: number | null;
  published: number | null;
  brief: Brief | null;
}

/** Written by the worker's prepare task (runs bucket, preparedTextKey). */
export const PreparedTextSchema = z.object({
  sha256: z.string(),
  pages: z.array(
    z.object({ number: z.number().int().positive(), text: z.string(), ocr: z.boolean() }),
  ),
});
export type PreparedText = z.infer<typeof PreparedTextSchema>;

/** Written by the worker's prepare task (runs bucket, preparedTriageKey). */
export const PreparedTriageSchema = z.object({
  sha256: z.string(),
  pageCount: z.number().int().nonnegative(),
  /** 1-based pages that were OCR'd (no usable text layer). */
  ocrPages: z.array(z.number().int().positive()),
  chars: z.number().int().nonnegative(),
  ocrModel: z.string().nullable(),
});
export type PreparedTriage = z.infer<typeof PreparedTriageSchema>;

/** Derived from the sample's prepare job: queued/running, succeeded, anything else. */
export type SampleState = 'preparing' | 'ready' | 'failed';

export interface SampleView {
  id: string;
  projectId: string;
  documentId: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  role: SampleRole;
  addedForVersion: number;
  createdAt: string;
  state: SampleState;
  prepareJobId: string | null;
  error: string | null;
  triage: PreparedTriage | null;
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './workbench.js';
```

In `packages/shared/src/storage-keys.ts`, extend the header comment with
`runs bucket:    prepared/{sha256}/text.json | triage.json   (workbench prepare task)` and append:

```ts
/** Page text of a PDF after extraction + OCR (workbench prepare task, runs bucket). */
export function preparedTextKey(sha256: string): string {
  return `prepared/${sha256}/text.json`;
}

/** Page count, OCR'd pages and size of a prepared PDF (runs bucket). */
export function preparedTriageKey(sha256: string): string {
  return `prepared/${sha256}/triage.json`;
}
```

In `packages/shared/src/jobs.ts`, change the `task` line and add `projectId` after `referenceId`:

```ts
  /**
   * process: extraction; publish: apply review edits and deliver to the final target;
   * rerun: one step again; prepare: workbench sample text + OCR only (ADR 0007).
   */
  task: z.enum(['process', 'publish', 'rerun', 'prepare']),
```

```ts
  /** Workbench project the job belongs to (prepare jobs and dev test runs). */
  projectId: z.string().nullable(),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/shared/test/workbench.test.ts`
Expected: PASS.

- [ ] **Step 6: Fix the JobSummary literals the typecheck now flags**

Run: `npm run typecheck`
Expected: errors where a `JobSummary` is built without `projectId`. Add `projectId: null` in:
- `apps/api/src/repositories/memory.ts` `createDocumentAndJob` (after `referenceId`),
- `apps/web/test/fake-api.ts` `job()` defaults (after `referenceId: null`).

`apps/api/src/repositories/pg.ts` is handled in Task 3 — until then add to `JOB_SELECT` the column `j.project_id`, to `JobRow` `project_id: string | null;` and `task: JobSummary['task'];`, and to `toSummary` `projectId: r.project_id,`.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/0008_workbench.sql packages/shared apps/api/src/repositories apps/web/test/fake-api.ts
git commit -m "Workbench: migration 0008 and shared contracts (prepare task, priority, samples, brief)"
```

---

### Task 2: Worker — priority claim and the prepare task

**Files:**
- Create: `worker/src/ingest_worker/workbench.py`
- Modify: `worker/src/ingest_worker/storage.py`, `worker/src/ingest_worker/queue.py`, `worker/src/ingest_worker/pipeline.py`, `worker/src/ingest_worker/ocr.py` (comment), `worker/src/ingest_worker/main.py`
- Test: `worker/tests/test_workbench.py` (new), `worker/tests/test_storage.py`, `worker/tests/test_queue_integration.py`

**Interfaces:**
- Consumes: object keys from Task 1 (`prepared/{sha256}/text.json`, `prepared/{sha256}/triage.json`); `jobs.priority` from the migration.
- Produces:
  - `storage.prepared_text_key(pdf_sha256: str) -> str`, `storage.prepared_triage_key(pdf_sha256: str) -> str`
  - `pipeline.ocr_pages(job, deps, queue, pdf, pages, mode) -> list[str]` (renamed from `_ocr_pages`, same behaviour)
  - `workbench.prepare_sample(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]` — returns the triage dict; writes text + triage JSON with exactly the keys of `PreparedTextSchema` / `PreparedTriageSchema`
  - `run_once` handles `job.task == "prepare"`: `prepare_sample` then `queue.complete(job, [], outputs bucket)`

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_storage.py`:

```python
def test_prepared_keys_mirror_the_typescript_helpers() -> None:
    from ingest_worker.storage import prepared_text_key, prepared_triage_key

    assert prepared_text_key("abc") == "prepared/abc/text.json"
    assert prepared_triage_key("abc") == "prepared/abc/triage.json"
```

Create `worker/tests/test_workbench.py`:

```python
"""Workbench prepare task: text + OCR only, written to the runs bucket by PDF sha256."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.ocr import OcrSettings
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, prepared_text_key, prepared_triage_key

from .fakes import FakeProvider, FakeQueue

PDF = b"%PDF-workbench-sample"
SHA = hashlib.sha256(PDF).hexdigest()
TEXT_PAGE = "PROCESS VALIDATION PROTOCOL\nProduct: Folic acid tablets 5 mg\n"
OLMOCR_OK = "---\nprimary_language: en\nis_rotation_valid: true\nrotation_correction: 0\n---\n"


def prepare_job(**overrides: object) -> ClaimedJob:
    base = dict(
        id="job-p",
        document_id="doc-s",
        spec_id="letter",
        spec_version=1,
        bucket="inbox",
        object_key="letter/v1/doc-s.pdf",
        model_override=None,
        attempts=1,
        max_attempts=3,
        task="prepare",
        test=True,
    )
    return ClaimedJob(**{**base, **overrides})  # type: ignore[arg-type]


def make_deps(specs_dir: Path, pages: list[str], ocr: FakeProvider | None = None) -> PipelineDeps:
    store = MemoryObjectStore()
    store.put("inbox", "letter/v1/doc-s.pdf", PDF, "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry(
            {"local": ocr} if ocr else {},
            {"local": ProviderConfig(name="local", kind="openai-chat")} if ocr else {},
            {},
        ),
        extract_text=lambda _pdf: pages,
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    if ocr:
        deps.ocr = OcrSettings(model="local/olmocr-2-7b-1025")
        deps.render_page = lambda pdf, index, dim, rotation: b"\x89PNG" + bytes([index])
    return deps


def stored(deps: PipelineDeps, key: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(deps.store.get("runs", key))
    return data


def test_text_layer_pdf_is_prepared_without_ocr(fixture_specs_dir: Path) -> None:
    deps = make_deps(fixture_specs_dir, [TEXT_PAGE, TEXT_PAGE + "page two"])
    queue = FakeQueue(jobs=[prepare_job()])

    assert run_once(queue, deps, "w1") is True

    assert queue.completed == [("job-p", [])]  # no extraction, no outputs
    assert stored(deps, prepared_text_key(SHA)) == {
        "sha256": SHA,
        "pages": [
            {"number": 1, "text": TEXT_PAGE, "ocr": False},
            {"number": 2, "text": TEXT_PAGE + "page two", "ocr": False},
        ],
    }
    assert stored(deps, prepared_triage_key(SHA)) == {
        "sha256": SHA,
        "pageCount": 2,
        "ocrPages": [],
        "chars": len(TEXT_PAGE) * 2 + len("page two"),
        "ocrModel": None,
    }
    assert ("job-p", "info", "prepared") in queue.events


def test_low_text_pages_are_ocrd_and_flagged(fixture_specs_dir: Path) -> None:
    ocr = FakeProvider("local")
    ocr.vision_responses = [OLMOCR_OK + "Scanned batch record"]
    deps = make_deps(fixture_specs_dir, [TEXT_PAGE, ""], ocr)
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    assert queue.completed, queue.reviewed or queue.failed
    pages = stored(deps, prepared_text_key(SHA))["pages"]
    assert pages[0]["ocr"] is False
    assert pages[1]["ocr"] is True and "Scanned batch record" in pages[1]["text"]
    triage = stored(deps, prepared_triage_key(SHA))
    assert triage["ocrPages"] == [2]
    assert triage["ocrModel"] == "local/olmocr-2-7b-1025"


def test_image_only_pdf_without_ocr_needs_review_and_writes_nothing(
    fixture_specs_dir: Path,
) -> None:
    deps = make_deps(fixture_specs_dir, ["", "  "])
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    [(_, reason)] = queue.reviewed
    assert "OCR" in reason
    assert deps.store.get_optional("runs", prepared_text_key(SHA)) is None
```

Append to `worker/tests/test_queue_integration.py`:

```python
def test_production_jobs_are_claimed_before_workbench_jobs(
    queue_with_queued_job: tuple[PgJobQueue, str],
) -> None:
    q, production_job = queue_with_queued_job
    doc, workbench_job = str(uuid.uuid4()), str(uuid.uuid4())
    q._conn.execute(
        """INSERT INTO documents (id, filename, sha256, size_bytes, spec_id, spec_version,
                                  bucket, object_key)
           VALUES (%s, 'b.pdf', 'y', 1, 'demo', 1, 'inbox', %s)""",
        (doc, f"demo/v1/{doc}.pdf"),
    )
    # Queued an hour earlier, but workbench priority (-10) runs after production (0).
    q._conn.execute(
        """INSERT INTO jobs (id, document_id, priority, created_at, run_after)
           VALUES (%s, %s, -10, now() - interval '1 hour', now() - interval '1 hour')""",
        (workbench_job, doc),
    )
    try:
        claimed = q.claim("w1")
        assert claimed is not None and claimed.id == production_job
    finally:
        q._conn.execute("DELETE FROM documents WHERE id = %s", (doc,))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_workbench.py tests/test_storage.py -q`
Expected: FAIL — `ImportError: cannot import name 'prepared_text_key'`.

- [ ] **Step 3: Add the storage keys**

In `worker/src/ingest_worker/storage.py`, after `page_preview_key`:

```python
def prepared_text_key(pdf_sha256: str) -> str:
    """Page text of a PDF after extraction + OCR (workbench prepare task, runs bucket)."""
    return f"prepared/{pdf_sha256}/text.json"


def prepared_triage_key(pdf_sha256: str) -> str:
    """Page count, OCR'd pages and size of a prepared PDF (runs bucket)."""
    return f"prepared/{pdf_sha256}/triage.json"
```

- [ ] **Step 4: Make the OCR step public**

In `worker/src/ingest_worker/pipeline.py` rename `def _ocr_pages(` to `def ocr_pages(` and its call in `prepare_document` (`pages = ocr_pages(job, deps, queue, pdf, pages, document.ocr)`). In `worker/src/ingest_worker/ocr.py` change the comment `(see pipeline._ocr_pages)` to `(see pipeline.ocr_pages)`.

- [ ] **Step 5: Write `prepare_sample`**

`worker/src/ingest_worker/workbench.py`:

```python
"""Workbench tasks (ADR 0007). `prepare`: a sample's page text after extraction and OCR,
before copy selection and segmentation, so anchors can change without re-running OCR.

Output keys and JSON shapes mirror packages/shared/src/workbench.ts (PreparedText,
PreparedTriage)."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from .ocr import pages_needing_ocr
from .pipeline import DocumentError, PipelineDeps, check_cancelled, ocr_pages
from .queue import ClaimedJob, JobQueue
from .storage import prepared_text_key, prepared_triage_key


def prepare_sample(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    """Extract and OCR (mode auto) one sample PDF; write its text and triage to the runs bucket.
    Returns the triage."""
    pdf = deps.store.get(job.bucket, job.object_key)
    sha256 = hashlib.sha256(pdf).hexdigest()
    pages = deps.extract_text(pdf)
    ocr_numbers = (
        [i + 1 for i in pages_needing_ocr(pages, "auto", deps.ocr.min_chars)] if deps.ocr else []
    )
    pages = ocr_pages(job, deps, queue, pdf, pages, "auto")
    if not any(p.strip() for p in pages):
        hint = "OCR is not configured" if deps.ocr is None else "OCR returned no text"
        raise DocumentError(f"no extractable text (scanned/image-only PDF?); {hint}")
    check_cancelled(job, queue)

    text = {
        "sha256": sha256,
        "pages": [
            {"number": i + 1, "text": page, "ocr": i + 1 in ocr_numbers}
            for i, page in enumerate(pages)
        ],
    }
    triage: dict[str, Any] = {
        "sha256": sha256,
        "pageCount": len(pages),
        "ocrPages": ocr_numbers,
        "chars": sum(len(page) for page in pages),
        "ocrModel": deps.ocr.model if deps.ocr and ocr_numbers else None,
    }
    runs = deps.buckets.runs
    deps.store.put(runs, prepared_text_key(sha256), json.dumps(text).encode(), "application/json")
    deps.store.put(
        runs, prepared_triage_key(sha256), json.dumps(triage).encode(), "application/json"
    )
    queue.event(job.id, "info", "prepared", {"pages": len(pages), "ocr_pages": ocr_numbers})
    return triage
```

- [ ] **Step 6: Route `prepare` jobs in `run_once`**

In `worker/src/ingest_worker/main.py` add `from .workbench import prepare_sample` and, inside the `try:` of `run_once` right after the `if job.task == "rerun":` block:

```python
        if job.task == "prepare":
            triage = prepare_sample(job, deps, queue)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s prepared %d pages", job.id, triage["pageCount"])
            return True
```

Update the `run_once` docstring to "Claim and run one job (process, publish, rerun or prepare)." and the `ClaimedJob.task` comment in `queue.py` to `#: "process" (extract), "publish" (apply review edits, deliver), "rerun" (one step) or "prepare" (workbench: text + OCR only).`

- [ ] **Step 7: Claim by priority**

In `worker/src/ingest_worker/queue.py` change the `ORDER BY` in `CLAIM_SQL`:

```python
   ORDER BY priority DESC, run_after, created_at
```

and add to the module docstring: `Claims take higher jobs.priority first (production 0, workbench -10; ADR 0007).`

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd worker && uv run pytest tests/test_workbench.py tests/test_storage.py tests/test_pipeline.py -q`
Expected: PASS.

Integration (with `deploy/scripts/dev-infra.ps1 up` and migrations applied, e.g. by starting the API once with `npm run dev:api`):
Run: `cd worker && uv run pytest -m integration tests/test_queue_integration.py -q`
Expected: PASS (or all skipped if `DATABASE_URL` is unset — then note that in the PR).

- [ ] **Step 9: Lint and commit**

Run: `npm run worker:lint`
Expected: PASS.

```bash
git add worker
git commit -m "Worker: prepare task (text + OCR to runs bucket) and priority claim"
```

---

### Task 3: API jobs repo — workbench jobs, exclusions, sample guard

**Files:**
- Modify: `apps/api/src/repositories/types.ts`, `apps/api/src/repositories/memory.ts`, `apps/api/src/repositories/pg.ts`
- Test: `apps/api/test/workbench-jobs.test.ts` (new)

**Interfaces:**
- Consumes: `JobSummary.task`/`projectId` (Task 1).
- Produces (in `types.ts`):
  - `export const WORKBENCH_PRIORITY = -10;`
  - `export interface WorkbenchJobOptions { projectId: string; task: 'prepare' | 'process' }`
  - `IngestionRepo.createWorkbenchJob(doc: NewDocument, opts: WorkbenchJobOptions): Promise<JobSummary>` — test job, priority `WORKBENCH_PRIORITY`
  - `IngestionRepo.listProjectJobs(projectId: string): Promise<JobSummary[]>` — newest first, all tasks
  - `MemoryRepo.priorities: Map<string, number>` (job id → priority; absent = 0) and `MemoryRepo.sampleDocuments: Set<string>` (document ids pinned by workbench samples; filled by `MemoryWorkbenchRepo` in Task 4)
  - `listJobs` and `finishedJobIdsBefore` never return `prepare` jobs; `retryJob` keeps task `prepare`; `deleteJob` keeps a document a sample uses.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-jobs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { WORKBENCH_PRIORITY, type NewDocument } from '../src/repositories/types.js';
import { testApp } from './helpers.js';

const doc = (id: string): NewDocument => ({
  id,
  filename: `${id}.pdf`,
  sha256: `sha-${id}`,
  sizeBytes: 10,
  specId: 'tdemo',
  specVersion: 1,
  bucket: 'inbox',
  objectKey: `tdemo/v1/${id}.pdf`,
});

describe('workbench jobs', () => {
  it('queues workbench jobs as test jobs behind production work', async () => {
    const { repo } = await testApp();
    const job = await repo.createWorkbenchJob(doc('d1'), { projectId: 'tdemo', task: 'prepare' });
    expect(job).toMatchObject({ task: 'prepare', test: true, projectId: 'tdemo', status: 'queued' });
    expect(repo.priorities.get(job.id)).toBe(WORKBENCH_PRIORITY);
    expect((await repo.listProjectJobs('tdemo')).map((j) => j.id)).toEqual([job.id]);
    expect(await repo.listProjectJobs('other')).toEqual([]);
  });

  it('keeps prepare jobs off the Jobs page and out of bulk clean-up', async () => {
    const { app, repo } = await testApp();
    const prepare = await repo.createWorkbenchJob(doc('d1'), {
      projectId: 'tdemo',
      task: 'prepare',
    });
    const run = await repo.createWorkbenchJob(doc('d2'), { projectId: 'tdemo', task: 'process' });
    for (const id of [prepare.id, run.id]) {
      repo.jobs.set(id, { ...repo.jobs.get(id)!, status: 'succeeded' });
    }
    const listed = (await app.inject('/api/jobs')).json() as { id: string }[];
    expect(listed.map((j) => j.id)).toEqual([run.id]);
    expect(await repo.finishedJobIdsBefore('2999-01-01T00:00:00.000Z', true)).toEqual([run.id]);
  });

  it('retries a failed preparation as a preparation', async () => {
    const { app, repo } = await testApp();
    const job = await repo.createWorkbenchJob(doc('d1'), { projectId: 'tdemo', task: 'prepare' });
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'failed', error: 'OCR down' });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'queued', task: 'prepare', error: null });
  });

  it('never deletes a document a sample still uses', async () => {
    const { app, repo } = await testApp();
    const job = await repo.createWorkbenchJob(doc('d1'), { projectId: 'tdemo', task: 'prepare' });
    repo.sampleDocuments.add('d1');
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'failed' });
    const res = await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` });
    expect(res.statusCode).toBe(204);
    expect(repo.documents.has('d1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-jobs.test.ts`
Expected: FAIL — `repo.createWorkbenchJob is not a function` / `WORKBENCH_PRIORITY` not exported.

- [ ] **Step 3: Extend the port**

In `apps/api/src/repositories/types.ts`, after `RetryOptions`:

```ts
/** Workbench jobs run after production work (jobs.priority; ADR 0007). */
export const WORKBENCH_PRIORITY = -10;

export interface WorkbenchJobOptions {
  projectId: string;
  /** prepare: sample text + OCR only; process: a test run of the project's draft. */
  task: 'prepare' | 'process';
}
```

and in `IngestionRepo`, after `createDocumentAndJob`:

```ts
  /** A test job of a workbench project, queued behind production work. */
  createWorkbenchJob(doc: NewDocument, opts: WorkbenchJobOptions): Promise<JobSummary>;
  /** Jobs of a workbench project (prepare jobs and test runs), newest first. */
  listProjectJobs(projectId: string): Promise<JobSummary[]>;
```

Update the `listJobs` and `finishedJobIdsBefore` doc comments to say prepare jobs are excluded (they belong to the Workbench).

- [ ] **Step 4: Implement in `MemoryRepo`**

In `apps/api/src/repositories/memory.ts` import `WORKBENCH_PRIORITY` and `type WorkbenchJobOptions` from `./types.js`, then add fields after `reruns`:

```ts
  /** jobs.priority; absent = 0 (production). */
  readonly priorities = new Map<string, number>();
  /** Documents pinned by workbench samples (workbench_samples in Postgres). */
  readonly sampleDocuments = new Set<string>();
```

Add methods after `createDocumentAndJob`:

```ts
  async createWorkbenchJob(doc: NewDocument, { projectId, task }: WorkbenchJobOptions) {
    const job = await this.createDocumentAndJob(doc, null, true);
    this.priorities.set(job.id, WORKBENCH_PRIORITY);
    return this.update(job.id, { projectId, task });
  }

  async listProjectJobs(projectId: string): Promise<JobSummary[]> {
    return [...this.jobs.values()]
      .filter((j) => j.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((j) => this.withModels(j));
  }
```

Change `listJobs`' filter to `.filter((j) => j.task !== 'prepare' && (!status || j.status === status))`.

In `finishedJobIdsBefore` add `j.task !== 'prepare' &&` to the filter.

In `retryJob` change the task line and its comment:

```ts
    // A cancelled publish/rerun resumes as that task (keeps the approval / re-run request); a
    // preparation stays a preparation; other failures re-run processing.
    const task = job.status === 'cancelled' || job.task === 'prepare' ? job.task : 'process';
```

In `deleteJob` extend `stillUsed`:

```ts
    const stillUsed =
      [...this.jobs.values()].some((j) => j.documentId === job.documentId) ||
      [...this.references.values()].some((r) => r.documentId === job.documentId) ||
      this.sampleDocuments.has(job.documentId);
```

- [ ] **Step 5: Implement in `PgRepo`**

In `apps/api/src/repositories/pg.ts`:

1. Import `WORKBENCH_PRIORITY` and `type WorkbenchJobOptions` from `./types.js`.
2. Replace the body of `createDocumentAndJob` with a call to a private helper, and add the helper plus the two new methods:

```ts
  async createDocumentAndJob(
    doc: NewDocument,
    modelOverride: string | null,
    test = false,
    referenceId: string | null = null,
  ): Promise<JobSummary> {
    return this.insertDocumentAndJob(doc, {
      modelOverride,
      test,
      referenceId,
      projectId: null,
      task: 'process',
      priority: 0,
    });
  }

  async createWorkbenchJob(doc: NewDocument, { projectId, task }: WorkbenchJobOptions) {
    return this.insertDocumentAndJob(doc, {
      modelOverride: null,
      test: true,
      referenceId: null,
      projectId,
      task,
      priority: WORKBENCH_PRIORITY,
    });
  }

  async listProjectJobs(projectId: string): Promise<JobSummary[]> {
    const { rows } = await this.pool.query<JobRow>(
      `${JOB_SELECT} WHERE j.project_id = $1 ORDER BY j.created_at DESC`,
      [projectId],
    );
    return rows.map(toSummary);
  }

  private async insertDocumentAndJob(
    doc: NewDocument,
    job: {
      modelOverride: string | null;
      test: boolean;
      referenceId: string | null;
      projectId: string | null;
      task: 'process' | 'prepare';
      priority: number;
    },
  ): Promise<JobSummary> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO documents (id, filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          doc.id,
          doc.filename,
          doc.sha256,
          doc.sizeBytes,
          doc.specId,
          doc.specVersion,
          doc.bucket,
          doc.objectKey,
        ],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO jobs (document_id, model_override, test, reference_id, project_id, task, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          doc.id,
          job.modelOverride,
          job.test,
          job.referenceId,
          job.projectId,
          job.task,
          job.priority,
        ],
      );
      await client.query('COMMIT');
      return (await this.getJob(rows[0]!.id))!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
```

3. `listJobs`: `WHERE ($1::job_status IS NULL OR j.status = $1) AND j.task <> 'prepare'`.
4. `finishedJobIdsBefore`: add `AND task <> 'prepare'` after the `reference_id` condition.
5. `retryJob`: `UPDATE jobs SET task = CASE WHEN status = 'cancelled' OR task = 'prepare' THEN task ELSE 'process' END,` and update the comment above it the same way as the memory repo's.
6. `deleteJob`'s document delete gains a third condition:

```sql
            AND NOT EXISTS (SELECT 1 FROM workbench_samples WHERE document_id = d.id)
```

(`JOB_SELECT`/`JobRow`/`toSummary` already carry `project_id` from Task 1 Step 6.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project api`
Expected: PASS (new file and all existing API tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/repositories apps/api/test/workbench-jobs.test.ts
git commit -m "API: workbench jobs (priority, project), keep prepare jobs and sample documents safe"
```

---

### Task 4: `WorkbenchRepo` port, adapters and wiring

**Files:**
- Create: `apps/api/src/workbench/repo.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/workbench-repo.test.ts` (new)

**Interfaces:**
- Consumes: `MemoryRepo.documents`, `MemoryRepo.sampleDocuments` (Task 3); `Brief`, `BriefBody`, `SampleRole`, `WorkbenchProject` (Task 1).
- Produces:

```ts
export interface SampleRecord {
  id: string;
  projectId: string;
  documentId: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  bucket: string;
  objectKey: string;
  role: SampleRole;
  addedForVersion: number;
  createdAt: string;
}
export interface NewSample { projectId: string; documentId: string; role: SampleRole; addedForVersion: number }
export class WorkbenchConflictError extends Error {}
export interface WorkbenchRepo {
  listProjects(): Promise<WorkbenchProject[]>;
  getProject(id: string): Promise<WorkbenchProject | null>;
  createProject(id: string, name: string): Promise<WorkbenchProject>; // throws WorkbenchConflictError
  addSample(sample: NewSample): Promise<SampleRecord>;
  listSamples(projectId: string): Promise<SampleRecord[]>; // oldest first
  setSampleRole(projectId: string, sampleId: string, role: SampleRole): Promise<SampleRecord | null>;
  removeSample(projectId: string, sampleId: string): Promise<boolean>;
  latestBrief(projectId: string): Promise<Brief | null>;
  saveBrief(projectId: string, body: BriefBody): Promise<Brief>; // appends version n+1
}
export class MemoryWorkbenchRepo implements WorkbenchRepo { constructor(jobs: MemoryRepo) }
export class PgWorkbenchRepo implements WorkbenchRepo { constructor(pool: pg.Pool) }
```
  - `AppDeps.workbench: WorkbenchRepo`; `testApp()` returns `workbench` too.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_BRIEF } from '@ih/shared';
import { MemoryRepo } from '../src/repositories/memory.js';
import { MemoryWorkbenchRepo, WorkbenchConflictError } from '../src/workbench/repo.js';

async function setup() {
  const jobs = new MemoryRepo();
  const repo = new MemoryWorkbenchRepo(jobs);
  await repo.createProject('letter', 'Letter');
  await jobs.createDocumentAndJob(
    {
      id: 'd1',
      filename: 'a.pdf',
      sha256: 'sha-a',
      sizeBytes: 3,
      specId: 'letter',
      specVersion: 1,
      bucket: 'inbox',
      objectKey: 'letter/v1/d1.pdf',
    },
    null,
  );
  return { jobs, repo };
}

describe('MemoryWorkbenchRepo', () => {
  it('creates projects once', async () => {
    const { repo } = await setup();
    expect(await repo.getProject('letter')).toMatchObject({ id: 'letter', name: 'Letter' });
    expect(await repo.getProject('nope')).toBeNull();
    await expect(repo.createProject('letter', 'Again')).rejects.toBeInstanceOf(
      WorkbenchConflictError,
    );
    expect((await repo.listProjects()).map((p) => p.id)).toEqual(['letter']);
  });

  it('links samples to documents and pins them', async () => {
    const { jobs, repo } = await setup();
    const sample = await repo.addSample({
      projectId: 'letter',
      documentId: 'd1',
      role: 'dev',
      addedForVersion: 1,
    });
    expect(sample).toMatchObject({ filename: 'a.pdf', sha256: 'sha-a', objectKey: 'letter/v1/d1.pdf' });
    expect(jobs.sampleDocuments.has('d1')).toBe(true);
    expect((await repo.setSampleRole('letter', sample.id, 'holdout'))?.role).toBe('holdout');
    expect(await repo.setSampleRole('other', sample.id, 'dev')).toBeNull();
    expect(await repo.removeSample('letter', sample.id)).toBe(true);
    expect(await repo.removeSample('letter', sample.id)).toBe(false);
    expect(jobs.sampleDocuments.has('d1')).toBe(false);
    expect(await repo.listSamples('letter')).toEqual([]);
  });

  it('versions briefs', async () => {
    const { repo } = await setup();
    expect(await repo.latestBrief('letter')).toBeNull();
    await repo.saveBrief('letter', { ...EMPTY_BRIEF, purpose: 'one' });
    const second = await repo.saveBrief('letter', { ...EMPTY_BRIEF, purpose: 'two' });
    expect(second).toMatchObject({ projectId: 'letter', version: 2 });
    expect((await repo.latestBrief('letter'))?.body.purpose).toBe('two');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-repo.test.ts`
Expected: FAIL — cannot resolve `../src/workbench/repo.js`.

- [ ] **Step 3: Write the port and both adapters**

`apps/api/src/workbench/repo.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Brief, BriefBody, SampleRole, WorkbenchProject } from '@ih/shared';
import type { MemoryRepo } from '../repositories/memory.js';

/** A workbench sample joined with its document row. */
export interface SampleRecord {
  id: string;
  projectId: string;
  documentId: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  bucket: string;
  objectKey: string;
  role: SampleRole;
  addedForVersion: number;
  createdAt: string;
}

export interface NewSample {
  projectId: string;
  /** The document row must exist already (IngestionRepo.createWorkbenchJob). */
  documentId: string;
  role: SampleRole;
  addedForVersion: number;
}

export class WorkbenchConflictError extends Error {}

/** Persistence for workbench projects, samples and briefs (ADR 0007; migration 0008). */
export interface WorkbenchRepo {
  listProjects(): Promise<WorkbenchProject[]>;
  getProject(id: string): Promise<WorkbenchProject | null>;
  /** Throws WorkbenchConflictError when the id is taken. */
  createProject(id: string, name: string): Promise<WorkbenchProject>;
  addSample(sample: NewSample): Promise<SampleRecord>;
  /** Oldest first. */
  listSamples(projectId: string): Promise<SampleRecord[]>;
  setSampleRole(projectId: string, sampleId: string, role: SampleRole): Promise<SampleRecord | null>;
  /** Unlinks the sample; its document and PDF stay (retention is a later phase). */
  removeSample(projectId: string, sampleId: string): Promise<boolean>;
  latestBrief(projectId: string): Promise<Brief | null>;
  /** Appends version n+1. */
  saveBrief(projectId: string, body: BriefBody): Promise<Brief>;
}

/** In-memory adapter: reads documents from, and pins them in, the MemoryRepo it's given. */
export class MemoryWorkbenchRepo implements WorkbenchRepo {
  readonly projects = new Map<string, WorkbenchProject>();
  readonly samples = new Map<string, NewSample & { id: string; createdAt: string }>();
  readonly briefs: Brief[] = [];

  constructor(private readonly jobs: MemoryRepo) {}

  async listProjects() {
    return [...this.projects.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async getProject(id: string) {
    return this.projects.get(id) ?? null;
  }

  async createProject(id: string, name: string) {
    if (this.projects.has(id)) throw new WorkbenchConflictError(`project ${id} already exists`);
    const project = { id, name, createdAt: new Date().toISOString() };
    this.projects.set(id, project);
    return project;
  }

  async addSample(sample: NewSample) {
    const row = { ...sample, id: randomUUID(), createdAt: new Date().toISOString() };
    this.samples.set(row.id, row);
    this.jobs.sampleDocuments.add(sample.documentId);
    return this.record(row);
  }

  async listSamples(projectId: string) {
    return [...this.samples.values()]
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((s) => this.record(s));
  }

  async setSampleRole(projectId: string, sampleId: string, role: SampleRole) {
    const row = this.samples.get(sampleId);
    if (row?.projectId !== projectId) return null;
    const updated = { ...row, role };
    this.samples.set(sampleId, updated);
    return this.record(updated);
  }

  async removeSample(projectId: string, sampleId: string) {
    const row = this.samples.get(sampleId);
    if (row?.projectId !== projectId) return false;
    this.samples.delete(sampleId);
    const stillLinked = [...this.samples.values()].some((s) => s.documentId === row.documentId);
    if (!stillLinked) this.jobs.sampleDocuments.delete(row.documentId);
    return true;
  }

  async latestBrief(projectId: string) {
    return this.briefs.filter((b) => b.projectId === projectId).at(-1) ?? null;
  }

  async saveBrief(projectId: string, body: BriefBody) {
    const version = ((await this.latestBrief(projectId))?.version ?? 0) + 1;
    const brief = { projectId, version, body, createdAt: new Date().toISOString() };
    this.briefs.push(brief);
    return brief;
  }

  private record(row: NewSample & { id: string; createdAt: string }): SampleRecord {
    const doc = this.jobs.documents.get(row.documentId)!;
    return {
      id: row.id,
      projectId: row.projectId,
      documentId: row.documentId,
      filename: doc.filename,
      sha256: doc.sha256,
      sizeBytes: doc.sizeBytes,
      bucket: doc.bucket,
      objectKey: doc.objectKey,
      role: row.role,
      addedForVersion: row.addedForVersion,
      createdAt: row.createdAt,
    };
  }
}

interface ProjectRow {
  id: string;
  name: string;
  created_at: Date;
}

interface SampleRow {
  id: string;
  project_id: string;
  document_id: string;
  filename: string;
  sha256: string;
  size_bytes: string;
  bucket: string;
  object_key: string;
  role: SampleRole;
  added_for_version: number;
  created_at: Date;
}

interface BriefRow {
  project_id: string;
  version: number;
  body: BriefBody;
  created_at: Date;
}

const toProject = (r: ProjectRow): WorkbenchProject => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at.toISOString(),
});

const toSample = (r: SampleRow): SampleRecord => ({
  id: r.id,
  projectId: r.project_id,
  documentId: r.document_id,
  filename: r.filename,
  sha256: r.sha256,
  sizeBytes: Number(r.size_bytes),
  bucket: r.bucket,
  objectKey: r.object_key,
  role: r.role,
  addedForVersion: r.added_for_version,
  createdAt: r.created_at.toISOString(),
});

const toBrief = (r: BriefRow): Brief => ({
  projectId: r.project_id,
  version: r.version,
  body: r.body,
  createdAt: r.created_at.toISOString(),
});

const SAMPLE_SELECT = `
  SELECT s.id, s.project_id, s.document_id, d.filename, d.sha256, d.size_bytes, d.bucket,
         d.object_key, s.role, s.added_for_version, s.created_at
    FROM workbench_samples s JOIN documents d ON d.id = s.document_id`;

/** Postgres adapter (migration 0008). */
export class PgWorkbenchRepo implements WorkbenchRepo {
  constructor(private readonly pool: pg.Pool) {}

  async listProjects() {
    const { rows } = await this.pool.query<ProjectRow>(
      'SELECT * FROM workbench_projects ORDER BY id',
    );
    return rows.map(toProject);
  }

  async getProject(id: string) {
    const { rows } = await this.pool.query<ProjectRow>(
      'SELECT * FROM workbench_projects WHERE id = $1',
      [id],
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async createProject(id: string, name: string) {
    const { rows } = await this.pool.query<ProjectRow>(
      `INSERT INTO workbench_projects (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [id, name],
    );
    if (!rows[0]) throw new WorkbenchConflictError(`project ${id} already exists`);
    return toProject(rows[0]);
  }

  async addSample(sample: NewSample) {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO workbench_samples (project_id, document_id, role, added_for_version)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [sample.projectId, sample.documentId, sample.role, sample.addedForVersion],
    );
    return (await this.sample(rows[0]!.id))!;
  }

  async listSamples(projectId: string) {
    const { rows } = await this.pool.query<SampleRow>(
      `${SAMPLE_SELECT} WHERE s.project_id = $1 ORDER BY s.created_at, s.id`,
      [projectId],
    );
    return rows.map(toSample);
  }

  async setSampleRole(projectId: string, sampleId: string, role: SampleRole) {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE workbench_samples SET role = $3 WHERE project_id = $1 AND id = $2 RETURNING id`,
      [projectId, sampleId, role],
    );
    return rows[0] ? this.sample(rows[0].id) : null;
  }

  async removeSample(projectId: string, sampleId: string) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM workbench_samples WHERE project_id = $1 AND id = $2',
      [projectId, sampleId],
    );
    return (rowCount ?? 0) > 0;
  }

  async latestBrief(projectId: string) {
    const { rows } = await this.pool.query<BriefRow>(
      `SELECT * FROM workbench_briefs WHERE project_id = $1 ORDER BY version DESC LIMIT 1`,
      [projectId],
    );
    return rows[0] ? toBrief(rows[0]) : null;
  }

  async saveBrief(projectId: string, body: BriefBody) {
    const { rows } = await this.pool.query<BriefRow>(
      `INSERT INTO workbench_briefs (project_id, version, body)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2 FROM workbench_briefs WHERE project_id = $1
       RETURNING *`,
      [projectId, JSON.stringify(body)],
    );
    return toBrief(rows[0]!);
  }

  private async sample(id: string) {
    const { rows } = await this.pool.query<SampleRow>(`${SAMPLE_SELECT} WHERE s.id = $1`, [id]);
    return rows[0] ? toSample(rows[0]) : null;
  }
}
```

- [ ] **Step 4: Wire it in**

`apps/api/src/app.ts`: `import type { WorkbenchRepo } from './workbench/repo.js';` and add to `AppDeps` after `templates`:

```ts
  /** Workbench projects, samples and briefs (ADR 0007). */
  workbench: WorkbenchRepo;
```

`apps/api/src/server.ts`: import `PgWorkbenchRepo` from `./workbench/repo.js`, create it after `templates`:

```ts
const workbench = new PgWorkbenchRepo(
  new pg.Pool({ connectionString: config.DATABASE_URL, max: 3 }),
);
```

and pass `workbench,` to `buildApp` after `templates,`.

`apps/api/test/helpers.ts`: import `MemoryWorkbenchRepo` from `../src/workbench/repo.js`; in `testApp` create `const workbench = new MemoryWorkbenchRepo(repo);`, pass `workbench,` to `buildApp` (before `...overrides`), and return `{ app, repo, store, targetStore, templates, workbench }`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/workbench apps/api/src/app.ts apps/api/src/server.ts apps/api/test/helpers.ts apps/api/test/workbench-repo.test.ts
git commit -m "API: WorkbenchRepo port with memory and Postgres adapters"
```

---

### Task 5: Project routes ("Open in workbench" on the API side)

**Files:**
- Create: `apps/api/src/templates/drafts.ts`, `apps/api/src/routes/workbench.ts`
- Modify: `apps/api/src/routes/templates.ts`, `apps/api/src/app.ts`, `apps/api/test/helpers.ts` (`letter` fixture)
- Test: `apps/api/test/workbench.test.ts` (new)

**Interfaces:**
- Consumes: `WorkbenchRepo` (Task 4), `TemplateRepo`.
- Produces:
  - `templates/drafts.ts`: `skeleton(id: string, name: string): Record<string, unknown>`; `pinned(definition, id, version)`; `createNextDraft(repo: TemplateRepo, id: string, from?: number): Promise<TemplateRecord | 'not-found' | 'draft-exists'>`
  - `routes/workbench.ts` exports `workbenchRoutes: FastifyPluginAsync` and the helper `versionsOf(templates: TemplateRepo, id: string): Promise<{ draft: number | null; published: number | null; latest: TemplateRecord | null }>`
  - `GET /api/workbench/projects` → `ProjectSummary[]`
  - `POST /api/workbench/projects` `{ id, name? }` → 201 `ProjectView`; 409 when the project exists; 400 when `name` is missing for a new type
  - `GET /api/workbench/projects/:id` → `ProjectView` or 404

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench.test.ts`:

First add to `apps/api/test/helpers.ts` (shared by Tasks 5 and 7 — test files must not import each other, or their tests register twice):

```ts
/** A minimal valid `letter` template definition (workbench tests). */
export const letter = (version = 1) => ({
  id: 'letter',
  version,
  name: 'Letter',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: 'sender', type: 'text' }] },
  pipeline: [{ type: 'extract', id: 'head', fields: ['sender'], sections: ['all'] }],
});
```

```ts
import { describe, expect, it } from 'vitest';
import { letter, testApp } from './helpers.js';

const post = (url: string, payload: object) => ({ method: 'POST' as const, url, payload });

describe('workbench projects', () => {
  it('creates a project and a v1 draft for a new document type', async () => {
    const { app, templates } = await testApp();
    const res = await app.inject(post('/api/workbench/projects', { id: 'letter', name: 'Letter' }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      project: { id: 'letter', name: 'Letter' },
      draft: 1,
      published: null,
      brief: null,
    });
    expect((await templates.get('letter', 1))?.status).toBe('draft');
    expect((await app.inject('/api/workbench/projects')).json()).toEqual([
      expect.objectContaining({ id: 'letter', draft: 1, published: null, samples: 0 }),
    ]);
    expect(
      (await app.inject(post('/api/workbench/projects', { id: 'letter', name: 'x' }))).statusCode,
    ).toBe(409);
  });

  it('needs a name for a new type and a valid id', async () => {
    const { app } = await testApp();
    expect((await app.inject(post('/api/workbench/projects', { id: 'memo' }))).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject(post('/api/workbench/projects', { id: 'Bad Id', name: 'x' }))).statusCode,
    ).toBe(400);
  });

  it('opens a published type by starting its next draft', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, letter(1), 'published');
    const res = await app.inject(post('/api/workbench/projects', { id: 'letter' }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ project: { name: 'Letter' }, draft: 2, published: 1 });
    expect((await templates.get('letter', 2))?.definition).toMatchObject({ version: 2 });
  });

  it('reuses an open draft', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, letter(1), 'published');
    await templates.create('letter', 2, letter(2), 'draft');
    const res = await app.inject(post('/api/workbench/projects', { id: 'letter' }));
    expect(res.json()).toMatchObject({ draft: 2, published: 1 });
    expect(await templates.get('letter', 3)).toBeNull();
  });

  it('404s an unknown project', async () => {
    const { app } = await testApp();
    expect((await app.inject('/api/workbench/projects/nope')).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench.test.ts`
Expected: FAIL — 404 for `POST /api/workbench/projects` (route not registered).

- [ ] **Step 3: Move draft helpers out of the templates route**

`apps/api/src/templates/drafts.ts`:

```ts
import type { TemplateRecord, TemplateRepo } from './repo.js';

/** v1 draft of a new document type, to fill in with the editor. */
export function skeleton(id: string, name: string): Record<string, unknown> {
  return {
    id,
    version: 1,
    name,
    document: { ocr: 'auto', sections: [{ id: 'all', anchor: '\\A' }] },
    outputs: { fields: [], tables: [] },
    pipeline: [],
    review: { required: 'on_warnings' },
  };
}

/** Definition with id/version pinned to the record it is stored under. */
export const pinned = (definition: Record<string, unknown>, id: string, version: number) => ({
  ...definition,
  id,
  version,
});

/** The next version as a draft copied from `from` (default: the latest version). */
export async function createNextDraft(
  repo: TemplateRepo,
  id: string,
  from?: number,
): Promise<TemplateRecord | 'not-found' | 'draft-exists'> {
  const versions = (await repo.list()).filter((r) => r.id === id);
  if (!versions.length) return 'not-found';
  if (versions.some((v) => v.status === 'draft')) return 'draft-exists';
  const source = from ? versions.find((v) => v.version === from) : versions.at(-1);
  if (!source) return 'not-found';
  const next = versions.at(-1)!.version + 1;
  return repo.create(id, next, pinned(source.definition, id, next), 'draft');
}
```

In `apps/api/src/routes/templates.ts`: delete the local `pinned`, import `{ createNextDraft, pinned, skeleton }` from `../templates/drafts.js`, replace the inline skeleton object in `POST /templates` with `const record = await repo().create(body.data.id, 1, skeleton(body.data.id, body.data.name), 'draft');`, and replace the body of `POST /templates/:id/drafts` after the body parse with:

```ts
    const created = await createNextDraft(repo(), req.params.id, body.data.from);
    if (created === 'not-found') return notFound(reply);
    if (created === 'draft-exists') {
      return reply.code(409).send({ error: 'a draft already exists; edit or delete it first' });
    }
    return reply.code(201).send(withIssues(created));
```

Run: `npx vitest run apps/api/test/templates.test.ts`
Expected: PASS (behaviour unchanged).

- [ ] **Step 4: Write the project routes**

`apps/api/src/routes/workbench.ts`:

```ts
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ProjectSummary, ProjectView, WorkbenchProject } from '@ih/shared';
import { createNextDraft, skeleton } from '../templates/drafts.js';
import type { TemplateRecord, TemplateRepo } from '../templates/repo.js';
import { WorkbenchConflictError } from '../workbench/repo.js';

const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase id: [a-z][a-z0-9_-]*');
const CreateProject = z.object({ id: Id, name: z.string().min(1).optional() }).strict();

type ProjectParams = { id: string };

/** The open draft, the latest published version and the newest record of a document type. */
export async function versionsOf(templates: TemplateRepo, id: string) {
  const versions = (await templates.list()).filter((r) => r.id === id);
  return {
    draft: versions.find((v) => v.status === 'draft')?.version ?? null,
    published: versions.filter((v) => v.status === 'published').at(-1)?.version ?? null,
    latest: (versions.at(-1) ?? null) as TemplateRecord | null,
  };
}

async function projectView(app: FastifyInstance, project: WorkbenchProject): Promise<ProjectView> {
  const { draft, published } = await versionsOf(app.deps.templates, project.id);
  return { project, draft, published, brief: await app.deps.workbench.latestBrief(project.id) };
}

/** /api/workbench (ADR 0007, phase 1): projects, samples, brief, dev test runs. */
export const workbenchRoutes: FastifyPluginAsync = async (app) => {
  const { workbench, templates } = app.deps;

  app.get('/workbench/projects', async (): Promise<ProjectSummary[]> => {
    const projects = await workbench.listProjects();
    return Promise.all(
      projects.map(async (p) => {
        const { draft, published } = await versionsOf(templates, p.id);
        return { ...p, draft, published, samples: (await workbench.listSamples(p.id)).length };
      }),
    );
  });

  /** New project. An existing document type is opened: its open draft, or a new next draft. */
  app.post('/workbench/projects', async (req, reply) => {
    const body = CreateProject.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const { id } = body.data;
    if (await workbench.getProject(id)) {
      return reply.code(409).send({ error: `a workbench project for ${id} already exists` });
    }
    const { draft, latest } = await versionsOf(templates, id);
    let name = body.data.name;
    if (latest === null) {
      if (!name) return reply.code(400).send({ error: 'name is required for a new document type' });
      await templates.create(id, 1, skeleton(id, name), 'draft');
    } else {
      name = String(latest.definition.name ?? id);
      if (draft === null) await createNextDraft(templates, id);
    }
    try {
      const project = await workbench.createProject(id, name);
      return reply.code(201).send(await projectView(app, project));
    } catch (err) {
      if (err instanceof WorkbenchConflictError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id', async (req, reply) => {
    const project = await workbench.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return projectView(app, project);
  });
};
```

Register it in `apps/api/src/app.ts`: `import { workbenchRoutes } from './routes/workbench.js';` and after the results routes:

```ts
  await app.register(workbenchRoutes, { prefix: '/api' });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project api`
Expected: PASS, including `access.test.ts` (its sweep now also checks the new routes need a session).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test/workbench.test.ts apps/api/test/helpers.ts
git commit -m "API: workbench projects (new type or open an existing one)"
```

---

### Task 6: Sample routes (upload, state, text, role, remove)

**Files:**
- Create: `apps/api/src/uploads.ts`
- Modify: `apps/api/src/routes/documents.ts`, `apps/api/src/routes/workbench.ts`
- Test: `apps/api/test/workbench-samples.test.ts` (new)

**Interfaces:**
- Consumes: `createWorkbenchJob`/`listProjectJobs` (Task 3), `WorkbenchRepo` (Task 4), `versionsOf` (Task 5), `preparedTextKey`/`preparedTriageKey`/`PreparedTextSchema`/`PreparedTriageSchema`/`MAX_SAMPLES`/`SampleRoleSchema`/`SampleView` (Task 1).
- Produces:
  - `uploads.ts`: `isPdf(body: Buffer): boolean`; `multipartField(file: MultipartFile, name: string): string | undefined`
  - `routes/workbench.ts`: `sampleViews(app, projectId): Promise<{ record: SampleRecord; view: SampleView }[]>`
  - `POST /api/workbench/projects/:id/samples` (multipart: `role?` field, then `file`) → 201 `SampleView`; 404 project; 400 role; 415 not a PDF; 409 duplicate or full
  - `GET /api/workbench/projects/:id/samples` → `SampleView[]`
  - `PATCH /api/workbench/projects/:id/samples/:sid` `{ role }` → `SampleView`
  - `DELETE /api/workbench/projects/:id/samples/:sid` → 204 / 404
  - `GET /api/workbench/projects/:id/samples/:sid/text` → `PreparedText`; 409 until ready

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-samples.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_SAMPLES, preparedTextKey, preparedTriageKey, type SampleView } from '@ih/shared';
import { WORKBENCH_PRIORITY } from '../src/repositories/types.js';
import { multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

async function withProject(id = 'letter') {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id, name: 'Letter' },
  });
  const upload = async (content: Buffer, fields: Record<string, string> = {}, project = id) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/workbench/projects/${project}/samples`,
      ...multipart(fields, { filename: 'a.pdf', content }),
    });
  /** Simulate the worker finishing the sample's prepare job. */
  const prepared = async (sample: SampleView, pages = ['HEADER\nbody', 'page two']) => {
    ctx.repo.jobs.set(sample.prepareJobId!, {
      ...ctx.repo.jobs.get(sample.prepareJobId!)!,
      status: 'succeeded',
    });
    const text = { sha256: sample.sha256, pages: pages.map((t, i) => ({ number: i + 1, text: t, ocr: i === 1 })) };
    const triage = { sha256: sample.sha256, pageCount: pages.length, ocrPages: [2], chars: 18, ocrModel: 'local/olmocr' };
    await ctx.store.put('runs', preparedTextKey(sample.sha256), Buffer.from(JSON.stringify(text)), 'application/json');
    await ctx.store.put('runs', preparedTriageKey(sample.sha256), Buffer.from(JSON.stringify(triage)), 'application/json');
  };
  return { ...ctx, upload, prepared };
}

describe('workbench samples', () => {
  it('stores the PDF and queues its preparation behind production work', async () => {
    const { app, repo, store, upload } = await withProject();
    const res = await upload(pdf(1));
    expect(res.statusCode).toBe(201);
    const sample = res.json() as SampleView;
    expect(sample).toMatchObject({
      filename: 'a.pdf',
      role: 'dev',
      addedForVersion: 1,
      state: 'preparing',
      triage: null,
      error: null,
    });
    const job = repo.jobs.get(sample.prepareJobId!)!;
    expect(job).toMatchObject({ task: 'prepare', test: true, projectId: 'letter', specVersion: 1 });
    expect(repo.priorities.get(job.id)).toBe(WORKBENCH_PRIORITY);
    expect(await store.get('inbox', `letter/v1/${sample.documentId}.pdf`)).not.toBeNull();
    expect((await app.inject('/api/jobs')).json()).toEqual([]); // prepare jobs stay off the Jobs page
  });

  it('takes a holdout role at upload and rejects a bad one', async () => {
    const { upload } = await withProject();
    expect((await upload(pdf(1), { role: 'holdout' })).json().role).toBe('holdout');
    expect((await upload(pdf(2), { role: 'gold' })).statusCode).toBe(400);
  });

  it('refuses non-PDFs, duplicates, full projects and unknown projects', async () => {
    const { upload, store } = await withProject();
    expect((await upload(Buffer.from('hello'))).statusCode).toBe(415);
    expect((await upload(pdf(1))).statusCode).toBe(201);
    const duplicate = await upload(pdf(1));
    expect(duplicate.statusCode).toBe(409);
    expect(store.objects.size).toBe(1); // nothing stored for the refused uploads
    for (let n = 2; n <= MAX_SAMPLES; n++) expect((await upload(pdf(n))).statusCode).toBe(201);
    expect((await upload(pdf(99))).statusCode).toBe(409);
    expect((await upload(pdf(100), {}, 'nope')).statusCode).toBe(404);
  });

  it('allows the same PDF in two projects', async () => {
    const { app, upload } = await withProject();
    await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'memo', name: 'Memo' },
    });
    expect((await upload(pdf(1))).statusCode).toBe(201);
    expect((await upload(pdf(1), {}, 'memo')).statusCode).toBe(201);
  });

  it('shows triage and serves text once prepared', async () => {
    const { app, upload, prepared } = await withProject();
    const sample = (await upload(pdf(1))).json() as SampleView;
    const base = `/api/workbench/projects/letter/samples/${sample.id}`;
    expect((await app.inject(`${base}/text`)).statusCode).toBe(409);
    await prepared(sample);
    const [listed] = (await app.inject('/api/workbench/projects/letter/samples')).json();
    expect(listed).toMatchObject({ state: 'ready', triage: { pageCount: 2, ocrPages: [2] } });
    const text = (await app.inject(`${base}/text`)).json();
    expect(text.pages.map((p: { text: string }) => p.text)).toEqual(['HEADER\nbody', 'page two']);
  });

  it('reports a failed preparation with its error', async () => {
    const { app, repo, upload } = await withProject();
    const sample = (await upload(pdf(1))).json() as SampleView;
    repo.jobs.set(sample.prepareJobId!, {
      ...repo.jobs.get(sample.prepareJobId!)!,
      status: 'failed',
      error: 'OCR server unreachable',
    });
    const [listed] = (await app.inject('/api/workbench/projects/letter/samples')).json();
    expect(listed).toMatchObject({ state: 'failed', error: 'OCR server unreachable' });
  });

  it('changes roles and removes samples', async () => {
    const { app, upload } = await withProject();
    const sample = (await upload(pdf(1))).json() as SampleView;
    const url = `/api/workbench/projects/letter/samples/${sample.id}`;
    const patched = await app.inject({ method: 'PATCH', url, payload: { role: 'holdout' } });
    expect(patched.json()).toMatchObject({ role: 'holdout' });
    expect((await app.inject({ method: 'PATCH', url, payload: { role: 'x' } })).statusCode).toBe(400);
    const missing = '/api/workbench/projects/letter/samples/not-a-uuid';
    expect((await app.inject({ method: 'PATCH', url: missing, payload: { role: 'dev' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(404);
    expect((await app.inject('/api/workbench/projects/letter/samples')).json()).toEqual([]);
  });
});
```

(`MemoryObjectStore.objects` is the store's existing `Map`, keyed `bucket/key`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-samples.test.ts`
Expected: FAIL — 404 on `POST .../samples`.

- [ ] **Step 3: Share the upload helpers**

`apps/api/src/uploads.ts`:

```ts
import type { MultipartFile } from '@fastify/multipart';

const PDF_MAGIC = Buffer.from('%PDF-');

export function isPdf(body: Buffer): boolean {
  return body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/** A text field sent before the file part. */
export function multipartField(file: MultipartFile, name: string): string | undefined {
  const f = file.fields[name];
  const one = Array.isArray(f) ? f[0] : f;
  return one && one.type === 'field' ? String(one.value) : undefined;
}
```

In `apps/api/src/routes/documents.ts` delete `PDF_MAGIC` and the local `field` closure; import `{ isPdf, multipartField }` from `../uploads.js`; replace `field('x')` calls with `multipartField(file, 'x')` and the magic check with `if (!isPdf(body))`.

Run: `npx vitest run apps/api/test/jobs.test.ts`
Expected: PASS.

- [ ] **Step 4: Add the sample routes**

In `apps/api/src/routes/workbench.ts` add imports:

```ts
import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_SAMPLES,
  PreparedTextSchema,
  PreparedTriageSchema,
  SampleRoleSchema,
  inboxKey,
  preparedTextKey,
  preparedTriageKey,
  type JobSummary,
  type SampleState,
  type SampleView,
} from '@ih/shared';
import { isPdf, multipartField } from '../uploads.js';
import type { SampleRecord } from '../workbench/repo.js';
```

Module-level helpers (after `projectView`):

```ts
const SampleParams = z.object({ id: Id, sid: z.string().uuid() });
const RoleBody = z.object({ role: SampleRoleSchema }).strict();

function stateOf(job: JobSummary | null): SampleState {
  if (job?.status === 'succeeded') return 'ready';
  if (job?.status === 'queued' || job?.status === 'running') return 'preparing';
  return 'failed';
}

async function readJson(app: FastifyInstance, key: string): Promise<unknown | null> {
  const raw = await app.deps.store.get(app.deps.buckets.runs, key);
  return raw ? (JSON.parse(raw.toString('utf8')) as unknown) : null;
}

/** Samples with their state, derived from each one's latest prepare job. */
export async function sampleViews(app: FastifyInstance, projectId: string) {
  const prepares = (await app.deps.repo.listProjectJobs(projectId)).filter(
    (j) => j.task === 'prepare',
  );
  const records = await app.deps.workbench.listSamples(projectId);
  return Promise.all(
    records.map(async (record) => ({
      record,
      view: await toView(
        app,
        record,
        prepares.find((j) => j.documentId === record.documentId) ?? null,
      ),
    })),
  );
}

async function toView(
  app: FastifyInstance,
  s: SampleRecord,
  job: JobSummary | null,
): Promise<SampleView> {
  const state = stateOf(job);
  const triage =
    state === 'ready' ? await readJson(app, preparedTriageKey(s.sha256)) : null;
  return {
    id: s.id,
    projectId: s.projectId,
    documentId: s.documentId,
    filename: s.filename,
    sizeBytes: s.sizeBytes,
    sha256: s.sha256,
    role: s.role,
    addedForVersion: s.addedForVersion,
    createdAt: s.createdAt,
    state,
    prepareJobId: job?.id ?? null,
    error: state === 'failed' ? (job?.error ?? job?.status ?? 'preparation job missing') : null,
    triage: triage === null ? null : PreparedTriageSchema.parse(triage),
  };
}
```

Routes (inside `workbenchRoutes`, after the project routes):

```ts
  const findSample = async (projectId: string, sampleId: string) =>
    (await sampleViews(app, projectId)).find((s) => s.record.id === sampleId) ?? null;

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/samples', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    return (await sampleViews(app, req.params.id)).map((s) => s.view);
  });

  /** Upload one sample PDF (multipart: `role` field first, then the file). */
  app.post<{ Params: ProjectParams }>('/workbench/projects/:id/samples', async (req, reply) => {
    const projectId = req.params.id;
    if (!(await workbench.getProject(projectId))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'file part is required' });
    const role = SampleRoleSchema.safeParse(multipartField(file, 'role') ?? 'dev');
    if (!role.success) return reply.code(400).send({ error: 'role must be dev or holdout' });
    const body = await file.toBuffer(); // throws RequestFileTooLargeError (413) past the limit
    if (!isPdf(body)) return reply.code(415).send({ error: 'file is not a PDF' });

    const samples = await workbench.listSamples(projectId);
    if (samples.length >= MAX_SAMPLES) {
      return reply.code(409).send({ error: `a project holds at most ${MAX_SAMPLES} samples` });
    }
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (samples.some((s) => s.sha256 === sha256)) {
      return reply.code(409).send({ error: 'this PDF is already a sample of the project' });
    }

    const { draft, published } = await versionsOf(templates, projectId);
    const version = draft ?? published ?? 1;
    const documentId = randomUUID();
    const key = inboxKey(projectId, version, documentId);
    await app.deps.store.put(app.deps.buckets.inbox, key, body, 'application/pdf');
    const job = await app.deps.repo.createWorkbenchJob(
      {
        id: documentId,
        filename: file.filename,
        sha256,
        sizeBytes: body.length,
        specId: projectId,
        specVersion: version,
        bucket: app.deps.buckets.inbox,
        objectKey: key,
      },
      { projectId, task: 'prepare' },
    );
    const record = await workbench.addSample({
      projectId,
      documentId,
      role: role.data,
      addedForVersion: version,
    });
    return reply.code(201).send(await toView(app, record, job));
  });

  app.patch<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/samples/:sid',
    async (req, reply) => {
      const params = SampleParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'sample not found' });
      const body = RoleBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const updated = await workbench.setSampleRole(params.data.id, params.data.sid, body.data.role);
      if (!updated) return reply.code(404).send({ error: 'sample not found' });
      return (await findSample(params.data.id, params.data.sid))!.view;
    },
  );

  app.delete<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/samples/:sid',
    async (req, reply) => {
      const params = SampleParams.safeParse(req.params);
      const removed =
        params.success && (await workbench.removeSample(params.data.id, params.data.sid));
      return removed
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'sample not found' });
    },
  );

  app.get<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/samples/:sid/text',
    async (req, reply) => {
      const params = SampleParams.safeParse(req.params);
      const sample = params.success ? await findSample(params.data.id, params.data.sid) : null;
      if (!sample) return reply.code(404).send({ error: 'sample not found' });
      if (sample.view.state !== 'ready') {
        return reply.code(409).send({ error: `sample is ${sample.view.state}, not ready` });
      }
      const text = await readJson(app, preparedTextKey(sample.record.sha256));
      if (text === null) return reply.code(409).send({ error: 'prepared text is missing' });
      return PreparedTextSchema.parse(text);
    },
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test/workbench-samples.test.ts
git commit -m "API: workbench samples (upload, prepared state and text, role, remove)"
```

---

### Task 7: Brief and dev test-run routes

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`
- Test: `apps/api/test/workbench-runs.test.ts` (new)

**Interfaces:**
- Consumes: `sampleViews`, `versionsOf` (Tasks 5–6), `validateTemplate` from `../templates/definitions.js`, `BriefBodySchema` (Task 1).
- Produces:
  - `PUT /api/workbench/projects/:id/brief` (`BriefBody`) → 201 new `Brief`, or 200 the latest one when nothing changed; 400 unknown keys; 404 project
  - `POST /api/workbench/projects/:id/test-runs` → 201 `{ jobs: JobSummary[] }` (one test job per ready **dev** sample on the open draft); 409 no draft / no ready dev samples; 400 invalid draft (`{ error, issues }`)
  - `GET /api/workbench/projects/:id/test-runs` → `JobSummary[]` (project jobs except `prepare`), newest first

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-runs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_BRIEF, preparedTriageKey, type SampleView } from '@ih/shared';
import { WORKBENCH_PRIORITY } from '../src/repositories/types.js';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  const add = async (n: number, role = 'dev', ready = true) => {
    const sample = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    if (ready) {
      const job = ctx.repo.jobs.get(sample.prepareJobId!)!;
      ctx.repo.jobs.set(job.id, { ...job, status: 'succeeded' });
      const triage = { sha256: sample.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
      await ctx.store.put('runs', preparedTriageKey(sample.sha256), Buffer.from(JSON.stringify(triage)), 'application/json');
    }
    return sample;
  };
  const run = () =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/test-runs', payload: {} });
  return { ...ctx, add, run };
}

describe('workbench brief', () => {
  it('saves a new version only when the brief changes', async () => {
    const { app } = await project();
    const put = (payload: object) =>
      app.inject({ method: 'PUT', url: '/api/workbench/projects/letter/brief', payload });
    const first = await put({ purpose: 'Batch records for QA' });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ version: 1, body: { ...EMPTY_BRIEF, purpose: 'Batch records for QA' } });
    const same = await put({ purpose: 'Batch records for QA' });
    expect(same.statusCode).toBe(200);
    expect(same.json().version).toBe(1);
    expect((await put({ purpose: 'changed' })).json().version).toBe(2);
    expect((await app.inject('/api/workbench/projects/letter')).json().brief.version).toBe(2);
    expect((await put({ colour: 'red' })).statusCode).toBe(400);
    const missing = await app.inject({ method: 'PUT', url: '/api/workbench/projects/nope/brief', payload: {} });
    expect(missing.statusCode).toBe(404);
  });
});

describe('workbench dev test runs', () => {
  it('refuses an invalid draft', async () => {
    const { add, run } = await project();
    await add(1);
    const res = await run(); // the v1 skeleton has no steps yet
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.length).toBeGreaterThan(0);
  });

  it('refuses when no dev sample is prepared', async () => {
    const { add, run, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    await add(1, 'dev', false);
    await add(2, 'holdout');
    expect((await run()).statusCode).toBe(409);
  });

  it('refuses when there is no open draft', async () => {
    const { add, run, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    await add(1);
    await templates.publish('letter', 1);
    expect((await run()).statusCode).toBe(409);
  });

  it('runs the draft on every prepared dev sample, behind production work', async () => {
    const { app, repo, add, run, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    const dev1 = await add(1);
    const dev2 = await add(2);
    await add(3, 'holdout');
    await add(4, 'dev', false);

    const res = await run();
    expect(res.statusCode).toBe(201);
    const jobs = res.json().jobs as { id: string; filename: string; objectKey?: string }[];
    expect(jobs.map((j) => j.filename).sort()).toEqual(['s1.pdf', 's2.pdf']);
    for (const j of jobs) {
      expect(repo.jobs.get(j.id)).toMatchObject({
        task: 'process',
        test: true,
        projectId: 'letter',
        specVersion: 1,
      });
      expect(repo.priorities.get(j.id)).toBe(WORKBENCH_PRIORITY);
      const doc = repo.documents.get(repo.jobs.get(j.id)!.documentId)!;
      const source = [dev1, dev2].find((s) => s.filename === j.filename)!;
      expect(doc.objectKey).toBe(repo.documents.get(source.documentId)!.objectKey); // same PDF
    }
    const listed = (await app.inject('/api/workbench/projects/letter/test-runs')).json();
    expect(listed.map((j: { id: string }) => j.id).sort()).toEqual(jobs.map((j) => j.id).sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-runs.test.ts`
Expected: FAIL — 404 on `PUT .../brief`.

- [ ] **Step 3: Add the routes**

In `apps/api/src/routes/workbench.ts` add `BriefBodySchema` to the `@ih/shared` import and `import { validateTemplate } from '../templates/definitions.js';`. Inside `workbenchRoutes`:

```ts
  /** Save the brief: a new version when it changed, else the latest one (200). */
  app.put<{ Params: ProjectParams }>('/workbench/projects/:id/brief', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const body = BriefBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const latest = await workbench.latestBrief(req.params.id);
    if (latest && JSON.stringify(latest.body) === JSON.stringify(body.data)) return latest;
    return reply.code(201).send(await workbench.saveBrief(req.params.id, body.data));
  });

  /** Test-run the open draft on every prepared dev sample (holdout samples are not used). */
  app.post<{ Params: ProjectParams }>('/workbench/projects/:id/test-runs', async (req, reply) => {
    const projectId = req.params.id;
    if (!(await workbench.getProject(projectId))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const { draft } = await versionsOf(templates, projectId);
    if (draft === null) {
      return reply.code(409).send({ error: 'no open draft to test; start the next version first' });
    }
    const issues = validateTemplate((await templates.get(projectId, draft))!.definition);
    if (issues.length) return reply.code(400).send({ error: 'the draft is not valid', issues });
    const ready = (await sampleViews(app, projectId)).filter(
      (s) => s.view.role === 'dev' && s.view.state === 'ready',
    );
    if (!ready.length) return reply.code(409).send({ error: 'no prepared dev samples to run' });
    const jobs = await Promise.all(
      ready.map(({ record }) =>
        app.deps.repo.createWorkbenchJob(
          {
            id: randomUUID(),
            filename: record.filename,
            sha256: record.sha256,
            sizeBytes: record.sizeBytes,
            specId: projectId,
            specVersion: draft,
            bucket: record.bucket,
            objectKey: record.objectKey,
          },
          { projectId, task: 'process' },
        ),
      ),
    );
    return reply.code(201).send({ jobs });
  });

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/test-runs', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    return (await app.deps.repo.listProjectJobs(req.params.id)).filter(
      (j) => j.task !== 'prepare',
    );
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/test/workbench-runs.test.ts
git commit -m "API: workbench brief versions and dev test runs"
```

---

### Task 8: Web client, routes and navigation

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/src/router.ts`, `apps/web/src/shell/derive.ts`, `apps/web/src/shell/AppShell.tsx`, `apps/web/src/ui/Icon.tsx`
- Test: `apps/web/test/router.test.ts`, `apps/web/test/AppShell.test.tsx`, `apps/web/test/client.test.ts`

**Interfaces:**
- Consumes: shared workbench types (Task 1), routes (Tasks 5–7).
- Produces:
  - `Api` methods: `listProjects(): Promise<ProjectSummary[]>`, `createProject(id: string, name?: string): Promise<ProjectView>`, `getProject(id: string): Promise<ProjectView>`, `listSamples(projectId: string): Promise<SampleView[]>`, `uploadSample(projectId: string, file: File, role: SampleRole): Promise<SampleView>`, `setSampleRole(projectId: string, sampleId: string, role: SampleRole): Promise<SampleView>`, `removeSample(projectId: string, sampleId: string): Promise<void>`, `getSampleText(projectId: string, sampleId: string): Promise<PreparedText>`, `saveBrief(projectId: string, body: BriefBody): Promise<Brief>`, `runDevTests(projectId: string): Promise<{ jobs: JobSummary[] }>`, `listTestRuns(projectId: string): Promise<JobSummary[]>`
  - `router.ts`: `PROJECT_TABS = ['samples', 'brief', 'template', 'runs'] as const`, `type ProjectTab`, routes `{ name: 'workbench' }` (`#/workbench`) and `{ name: 'project'; projectId: string; tab: ProjectTab }` (`#/workbench/<id>[/<tab>]`, default tab `samples`)
  - `Section` gains `'workbench'`; nav link "Workbench" → `#/workbench`; icon `workbench`

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/router.test.ts` add rows to the `it.each` table:

```ts
    ['#/workbench', { name: 'workbench' }],
    ['#/workbench/letter', { name: 'project', projectId: 'letter', tab: 'samples' }],
    ['#/workbench/letter/brief', { name: 'project', projectId: 'letter', tab: 'brief' }],
    ['#/workbench/letter/bogus', { name: 'project', projectId: 'letter', tab: 'samples' }],
```

In `apps/web/test/AppShell.test.tsx`, next to the existing `'Document types'` link assertion (line ~66), add:

```ts
    expect(within(nav).getByRole('link', { name: 'Workbench' })).toHaveAttribute(
      'href',
      '#/workbench',
    );
```

Append to `apps/web/test/client.test.ts` (it already defines `respond` and unstubs globals after each test):

```ts
describe('http api: workbench', () => {
  it('uploads a sample as multipart with its role before the file', async () => {
    const fetchMock = vi.fn(async () => respond(201, { id: 's1' }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' });
    await createHttpApi('/api').uploadSample('letter', file, 'holdout');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/workbench/projects/letter/samples');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(['role', 'file']);
    expect(form.get('role')).toBe('holdout');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/router.test.ts apps/web/test/AppShell.test.tsx apps/web/test/client.test.ts`
Expected: FAIL — workbench routes parse as `jobs`, no Workbench link, `uploadSample` missing.

- [ ] **Step 3: Router, section, nav, icon**

`apps/web/src/router.ts`: add to the `Route` union

```ts
  | { name: 'workbench' }
  | { name: 'project'; projectId: string; tab: ProjectTab }
```

export the tabs above `Route`:

```ts
export const PROJECT_TABS = ['samples', 'brief', 'template', 'runs'] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
```

and in `parseHash`, before `if (hash === '#/results')`:

```ts
  const project = /^#\/workbench\/([^/]+)(?:\/([a-z]+))?$/.exec(hash);
  if (project) {
    const tab = PROJECT_TABS.find((t) => t === project[2]) ?? 'samples';
    return { name: 'project', projectId: decodeURIComponent(project[1]!), tab };
  }
  if (hash === '#/workbench') return { name: 'workbench' };
```

Update the routing doc comment to list `#/workbench, #/workbench/<id>[/<tab>]`.

`apps/web/src/shell/derive.ts`: `export type Section = 'jobs' | 'results' | 'templates' | 'workbench' | 'access';` and add `workbench: 'workbench', project: 'workbench',` to `SECTION`.

`apps/web/src/ui/Icon.tsx`: add after `types`:

```tsx
  workbench: (
    <>
      <path d="M3 20h18" />
      <path d="M5 20v-8h14v8" />
      <path d="M9 12V7h6v5" />
    </>
  ),
```

`apps/web/src/shell/AppShell.tsx`: after the Document types `NavLink`:

```tsx
          <NavLink
            href="#/workbench"
            icon="workbench"
            label="Workbench"
            current={section === 'workbench'}
          />
```

- [ ] **Step 4: Client methods**

In `apps/web/src/api/client.ts` import from `@ih/shared`: `Brief, BriefBody, PreparedText, ProjectSummary, ProjectView, SampleRole, SampleView`. Add to the `Api` interface (after `testRun`):

```ts
  // --- workbench (ADR 0007) ---
  listProjects(): Promise<ProjectSummary[]>;
  /** New project; omit `name` to open an existing document type. */
  createProject(id: string, name?: string): Promise<ProjectView>;
  /** Rejects with an ApiError (404 when there is no project yet). */
  getProject(id: string): Promise<ProjectView>;
  listSamples(projectId: string): Promise<SampleView[]>;
  uploadSample(projectId: string, file: File, role: SampleRole): Promise<SampleView>;
  setSampleRole(projectId: string, sampleId: string, role: SampleRole): Promise<SampleView>;
  removeSample(projectId: string, sampleId: string): Promise<void>;
  getSampleText(projectId: string, sampleId: string): Promise<PreparedText>;
  saveBrief(projectId: string, body: BriefBody): Promise<Brief>;
  /** Test-run the open draft on every prepared dev sample. */
  runDevTests(projectId: string): Promise<{ jobs: JobSummary[] }>;
  listTestRuns(projectId: string): Promise<JobSummary[]>;
```

and to `createHttpApi` (after `testRun`):

```ts
    listProjects: () => apiFetch(`${base}/workbench/projects`).then(json<ProjectSummary[]>),
    createProject: (id, name) =>
      post<ProjectView>(`${base}/workbench/projects`, name ? { id, name } : { id }),
    getProject: (id) => apiFetch(`${base}/workbench/projects/${id}`).then(json<ProjectView>),
    listSamples: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/samples`).then(json<SampleView[]>),
    uploadSample: (id, file, role) => {
      const form = new FormData();
      form.append('role', role); // fields before the file part
      form.append('file', file);
      return apiFetch(`${base}/workbench/projects/${id}/samples`, {
        method: 'POST',
        body: form,
      }).then(json<SampleView>);
    },
    setSampleRole: (id, sampleId, role) =>
      post<SampleView>(`${base}/workbench/projects/${id}/samples/${sampleId}`, { role }, 'PATCH'),
    removeSample: (id, sampleId) =>
      noContent(
        apiFetch(`${base}/workbench/projects/${id}/samples/${sampleId}`, { method: 'DELETE' }),
      ),
    getSampleText: (id, sampleId) =>
      apiFetch(`${base}/workbench/projects/${id}/samples/${sampleId}/text`).then(
        json<PreparedText>,
      ),
    saveBrief: (id, body) => post<Brief>(`${base}/workbench/projects/${id}/brief`, body, 'PUT'),
    runDevTests: (id) =>
      post<{ jobs: JobSummary[] }>(`${base}/workbench/projects/${id}/test-runs`, {}),
    listTestRuns: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/test-runs`).then(json<JobSummary[]>),
```

In `apps/web/test/fake-api.ts` add defaults to `fakeApi` (before `...overrides`):

```ts
    listProjects: vi.fn(async () => []),
    createProject: vi.fn(async () => {
      throw new Error('createProject not stubbed');
    }),
    getProject: vi.fn(async () => {
      throw new Error('getProject not stubbed');
    }),
    listSamples: vi.fn(async () => []),
    uploadSample: vi.fn(async () => {
      throw new Error('uploadSample not stubbed');
    }),
    setSampleRole: vi.fn(async () => {
      throw new Error('setSampleRole not stubbed');
    }),
    removeSample: vi.fn(async () => undefined),
    getSampleText: vi.fn(async () => ({ sha256: '', pages: [] })),
    saveBrief: vi.fn(async () => {
      throw new Error('saveBrief not stubbed');
    }),
    runDevTests: vi.fn(async () => ({ jobs: [] })),
    listTestRuns: vi.fn(async () => []),
```

and two fixture builders at the bottom of the file:

```ts
export function projectView(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    project: { id: 'letter', name: 'Letter', createdAt: '2026-10-12T00:00:00.000Z' },
    draft: 1,
    published: null,
    brief: null,
    ...overrides,
  };
}

export function sampleView(overrides: Partial<SampleView> = {}): SampleView {
  return {
    id: crypto.randomUUID(),
    projectId: 'letter',
    documentId: crypto.randomUUID(),
    filename: 'sample.pdf',
    sizeBytes: 1000,
    sha256: 'abc',
    role: 'dev',
    addedForVersion: 1,
    createdAt: '2026-10-12T00:00:00.000Z',
    state: 'ready',
    prepareJobId: crypto.randomUUID(),
    error: null,
    triage: { sha256: 'abc', pageCount: 3, ocrPages: [2], chars: 900, ocrModel: 'local/olmocr' },
    ...overrides,
  };
}
```

(import `ProjectView`, `SampleView` types from `@ih/shared`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck`
Expected: PASS. (`App.tsx` compiles because unknown route names fall through to Jobs until Task 9 adds the pages.)

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "Web: workbench API client, routes and nav link"
```

---

### Task 9: Workbench list page and project page shell

**Files:**
- Create: `apps/web/src/workbench/WorkbenchPage.tsx`, `apps/web/src/workbench/ProjectPage.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/test/WorkbenchPage.test.tsx`, `apps/web/test/ProjectPage.test.tsx` (new)

**Interfaces:**
- Consumes: `Api` workbench methods, `projectView`/`sampleView` fixtures (Task 8), `TemplateEditor` (existing: props `api, templateId, version, onNavigate`).
- Produces:
  - `WorkbenchPage({ api, onNavigate, query? })`
  - `ProjectPage({ api, projectId, tab, onNavigate, pollMs? })` — renders tab nav links `#/workbench/<id>/<tab>` and the tab body; the Template tab embeds `TemplateEditor` on the open draft or offers "Start v{published+1}"; a 404 project offers "Open in workbench" (calls `createProject(id)` with no name).
  - This task renders only the Template tab body; Task 10 adds the Samples tab and Task 11 the Brief and Test runs tabs (each adds its import and one line to `ProjectPage`).

- [ ] **Step 1: Write the failing tests**

`apps/web/test/WorkbenchPage.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchPage } from '../src/workbench/WorkbenchPage.js';
import { fakeApi, projectView } from './fake-api.js';

describe('WorkbenchPage', () => {
  it('lists projects with their versions and sample counts', async () => {
    const api = fakeApi({
      listProjects: vi.fn(async () => [
        { id: 'letter', name: 'Letter', createdAt: '', draft: 2, published: 1, samples: 5 },
      ]),
    });
    render(<WorkbenchPage api={api} onNavigate={vi.fn()} />);
    const table = await screen.findByRole('table', { name: 'Projects' });
    const row = within(table).getByRole('link', { name: 'Letter' }).closest('tr')!;
    expect(within(row).getByRole('link', { name: 'Letter' })).toHaveAttribute(
      'href',
      '#/workbench/letter',
    );
    expect(row).toHaveTextContent('v2');
    expect(row).toHaveTextContent('v1');
    expect(row).toHaveTextContent('5');
  });

  it('creates a project and opens it', async () => {
    const onNavigate = vi.fn();
    const api = fakeApi({ createProject: vi.fn(async () => projectView()) });
    render(<WorkbenchPage api={api} onNavigate={onNavigate} />);
    await userEvent.type(screen.getByLabelText('Id'), 'letter');
    await userEvent.type(screen.getByLabelText('Name'), 'Letter');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(api.createProject).toHaveBeenCalledWith('letter', 'Letter');
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/letter');
  });

  it('opens an existing document type without a name', async () => {
    const api = fakeApi({ createProject: vi.fn(async () => projectView()) });
    render(<WorkbenchPage api={api} onNavigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Id'), 'letter');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(api.createProject).toHaveBeenCalledWith('letter', undefined);
  });
});
```

`apps/web/test/ProjectPage.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { ProjectPage } from '../src/workbench/ProjectPage.js';
import { fakeApi, projectView } from './fake-api.js';

const page = (api = fakeApi(), tab: 'samples' | 'brief' | 'template' | 'runs' = 'samples') =>
  render(<ProjectPage api={api} projectId="letter" tab={tab} onNavigate={vi.fn()} pollMs={60_000} />);

describe('ProjectPage', () => {
  it('shows the project with tab links', async () => {
    page(fakeApi({ getProject: vi.fn(async () => projectView({ draft: 2, published: 1 })) }));
    expect(await screen.findByRole('heading', { name: 'Letter' })).toBeInTheDocument();
    expect(screen.getByText(/developing v2/)).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Project' });
    expect(screen.getByRole('link', { name: 'Brief' })).toHaveAttribute(
      'href',
      '#/workbench/letter/brief',
    );
    expect(nav).toContainElement(screen.getByRole('link', { name: 'Samples' }));
    expect(screen.getByRole('link', { name: 'Samples' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers to open a document type that has no project yet', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => {
        throw new ApiError('project not found', 404);
      }),
      createProject: vi.fn(async () => projectView()),
    });
    page(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Open in workbench' }));
    expect(api.createProject).toHaveBeenCalledWith('letter');
    expect(await screen.findByRole('heading', { name: 'Letter' })).toBeInTheDocument();
  });

  it('starts the next version when every version is published', async () => {
    const getProject = vi
      .fn()
      .mockResolvedValueOnce(projectView({ draft: null, published: 1 }))
      .mockResolvedValue(projectView({ draft: 2, published: 1 }));
    const api = fakeApi({ getProject, newDraft: vi.fn(async () => ({}) as never) });
    page(api, 'template');
    await userEvent.click(await screen.findByRole('button', { name: 'Start v2' }));
    expect(api.newDraft).toHaveBeenCalledWith('letter', 1);
    expect(getProject).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/WorkbenchPage.test.tsx apps/web/test/ProjectPage.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `WorkbenchPage`**

`apps/web/src/workbench/WorkbenchPage.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import type { ProjectSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { matchesQuery } from '../shell/derive.js';

/** Workbench projects (one per document type) and "New project". */
export function WorkbenchPage({
  api,
  onNavigate,
  query = '',
}: {
  api: Api;
  onNavigate: (hash: string) => void;
  query?: string;
}) {
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    api.listProjects().then(setItems, (err: Error) => setError(err.message));
  }, [api]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { project } = await api.createProject(id.trim(), name.trim() || undefined);
      onNavigate(`#/workbench/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const shown = (items ?? []).filter((p) => matchesQuery(query, p.id, p.name));
  const version = (v: number | null) => (v === null ? '—' : `v${v}`);

  return (
    <section className="workbench">
      <h2>Workbench</h2>
      <p className="muted">
        Build a document type from sample PDFs: prepare their text, describe what you need, and
        test the draft on the samples.
      </p>
      {error && <p role="alert">{error}</p>}
      {items === null ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p>No projects yet.</p>
      ) : (
        <table aria-label="Projects">
          <thead>
            <tr>
              <th>Name</th>
              <th>Id</th>
              <th>Draft</th>
              <th>Published</th>
              <th>Samples</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={`#/workbench/${p.id}`}>{p.name}</a>
                </td>
                <td>
                  <code>{p.id}</code>
                </td>
                <td>{version(p.draft)}</td>
                <td>{version(p.published)}</td>
                <td>{p.samples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={(e) => void create(e)} aria-label="New project" className="card">
        <h3>New project</h3>
        <label>
          Id
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. supplier-invoice" />
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="muted">Leave the name empty to open an existing document type.</p>
        <button type="submit" className="primary" disabled={!id.trim()}>
          Create project
        </button>
      </form>
    </section>
  );
}
```

- [ ] **Step 4: Write `ProjectPage` (Template tab and shell)**

`apps/web/src/workbench/ProjectPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { ProjectView } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';
import { PROJECT_TABS, type ProjectTab } from '../router.js';
import { TemplateEditor } from '../templates/TemplateEditor.js';

const TAB_LABEL: Record<ProjectTab, string> = {
  samples: 'Samples',
  brief: 'Brief',
  template: 'Template',
  runs: 'Test runs',
};

/** One workbench project: samples, brief, the draft template and dev test runs. */
export function ProjectPage({
  api,
  projectId,
  tab,
  onNavigate,
  pollMs = 3000,
}: {
  api: Api;
  projectId: string;
  tab: ProjectTab;
  onNavigate: (hash: string) => void;
  pollMs?: number;
}) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getProject(projectId).then(
      (v) => {
        setView(v);
        setMissing(false);
      },
      (err: Error) => {
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(err.message);
      },
    );
  }, [api, projectId]);
  useEffect(load, [load]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (missing) {
    return (
      <section className="workbench">
        <h2>Workbench</h2>
        {error && <p role="alert">{error}</p>}
        <p>
          No workbench project for <code>{projectId}</code> yet.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() =>
            void act(async () => {
              setView(await api.createProject(projectId));
              setMissing(false);
            })
          }
        >
          Open in workbench
        </button>
      </section>
    );
  }
  if (!view) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;

  const { project, draft, published } = view;
  return (
    <section className="workbench">
      <h2>{project.name}</h2>
      <p className="muted">
        <code>{project.id}</code> · {draft !== null ? `developing v${draft}` : 'no open draft'}
        {published !== null && ` · v${published} published`}
      </p>
      {error && <p role="alert">{error}</p>}
      <nav aria-label="Project" className="workbench-tabs">
        {PROJECT_TABS.map((t) => (
          <a
            key={t}
            href={`#/workbench/${project.id}/${t}`}
            aria-current={t === tab ? 'page' : undefined}
          >
            {TAB_LABEL[t]}
          </a>
        ))}
      </nav>
      {tab === 'template' &&
        (draft !== null ? (
          <TemplateEditor
            key={draft}
            api={api}
            templateId={project.id}
            version={draft}
            onNavigate={onNavigate}
          />
        ) : (
          <div className="card">
            <p>Every version is published; start the next one to keep developing.</p>
            <button
              type="button"
              className="primary"
              onClick={() =>
                void act(async () => {
                  await api.newDraft(project.id, published!);
                  load();
                })
              }
            >
              Start v{(published ?? 0) + 1}
            </button>
          </div>
        ))}
    </section>
  );
}
```

`pollMs` is consumed by the Samples and Runs tabs (Tasks 10–11). If lint flags it as unused in this task, keep it in the props type but leave it out of the destructuring until Task 10.

- [ ] **Step 5: Route the pages in `App.tsx`**

Import `WorkbenchPage` and `ProjectPage` from `./workbench/...js`; in `SignedInApp` add before the final `else`:

```tsx
  } else if (route.name === 'workbench') {
    page = <WorkbenchPage api={api} onNavigate={navigate} query={query} />;
  } else if (route.name === 'project') {
    page = (
      <ProjectPage
        key={route.projectId}
        api={api}
        projectId={route.projectId}
        tab={route.tab}
        onNavigate={navigate}
        pollMs={pollMs}
      />
    );
```

- [ ] **Step 6: Styles**

Append to `apps/web/src/styles.css`:

```css
/* Workbench */
.workbench .muted {
  color: var(--ih-muted);
}
.workbench-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--ih-border);
  margin: 12px 0 16px;
}
.workbench-tabs a {
  padding: 8px 12px;
  color: var(--ih-muted);
  text-decoration: none;
  border-bottom: 2px solid transparent;
}
.workbench-tabs a[aria-current='page'] {
  color: var(--ih-accent-text);
  border-bottom-color: var(--ih-accent);
}
.sample-text section {
  border: 1px solid var(--ih-border-soft);
  border-radius: var(--ih-radius-md);
  margin: 8px 0;
  padding: 8px 12px;
  background: var(--ih-surface);
}
.sample-text pre {
  white-space: pre-wrap;
  font-family: var(--ih-font-mono);
  margin: 0;
}
.brief-form label {
  display: block;
  margin-top: 12px;
  font-weight: 600;
}
.brief-form textarea {
  width: 100%;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "Web: Workbench list and project page with the embedded template editor"
```

---

### Task 10: Samples tab and prepared-text viewer

**Files:**
- Create: `apps/web/src/workbench/SamplesTab.tsx`, `apps/web/src/workbench/SampleText.tsx`
- Modify: `apps/web/src/workbench/ProjectPage.tsx`
- Test: `apps/web/test/SamplesTab.test.tsx` (new)

**Interfaces:**
- Consumes: `listSamples`, `uploadSample`, `setSampleRole`, `removeSample`, `getSampleText`, `retryJob` (existing), `sampleView` fixture, `MAX_SAMPLES`.
- Produces: `SamplesTab({ api, projectId, pollMs })`; `SampleText({ api, projectId, sampleId })` (regions named `Page N`).

- [ ] **Step 1: Write the failing test**

`apps/web/test/SamplesTab.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SamplesTab } from '../src/workbench/SamplesTab.js';
import { fakeApi, sampleView } from './fake-api.js';

const tab = (api = fakeApi()) =>
  render(<SamplesTab api={api} projectId="letter" pollMs={60_000} />);
const row = (filename: string) => screen.getByRole('cell', { name: filename }).closest('tr')!;

describe('SamplesTab', () => {
  it('lists samples with triage and state', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'a.pdf' }),
          sampleView({ filename: 'b.pdf', state: 'preparing', triage: null }),
        ]),
      }),
    );
    await screen.findByRole('table', { name: 'Samples' });
    expect(row('a.pdf')).toHaveTextContent('ready');
    expect(row('a.pdf')).toHaveTextContent('3'); // pages
    expect(row('b.pdf')).toHaveTextContent('preparing');
  });

  it('uploads each chosen PDF as a dev sample and reports failures', async () => {
    const uploadSample = vi
      .fn()
      .mockResolvedValueOnce(sampleView())
      .mockRejectedValueOnce(new Error('this PDF is already a sample of the project'));
    const api = fakeApi({ uploadSample });
    tab(api);
    const files = [
      new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' }),
      new File(['%PDF-2'], 'two.pdf', { type: 'application/pdf' }),
    ];
    await userEvent.upload(screen.getByLabelText('Add sample PDFs'), files);
    expect(uploadSample).toHaveBeenCalledWith('letter', files[0], 'dev');
    expect(uploadSample).toHaveBeenCalledWith('letter', files[1], 'dev');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'two.pdf: this PDF is already a sample of the project',
    );
  });

  it('changes a role, retries a failed preparation and removes a sample', async () => {
    const failed = sampleView({ filename: 'bad.pdf', state: 'failed', error: 'OCR down', triage: null });
    const good = sampleView({ filename: 'good.pdf' });
    const api = fakeApi({
      listSamples: vi.fn(async () => [good, failed]),
      setSampleRole: vi.fn(async () => ({ ...good, role: 'holdout' as const })),
    });
    tab(api);
    await screen.findByRole('table', { name: 'Samples' });
    expect(row('bad.pdf')).toHaveTextContent('OCR down');

    await userEvent.selectOptions(screen.getByLabelText('Role of good.pdf'), 'holdout');
    expect(api.setSampleRole).toHaveBeenCalledWith('letter', good.id, 'holdout');

    await userEvent.click(within(row('bad.pdf')).getByRole('button', { name: 'Retry bad.pdf' }));
    expect(api.retryJob).toHaveBeenCalledWith(failed.prepareJobId);

    await userEvent.click(within(row('good.pdf')).getByRole('button', { name: 'Remove good.pdf' }));
    expect(api.removeSample).toHaveBeenCalledWith('letter', good.id);
  });

  it('shows the prepared text page by page, marking OCR pages', async () => {
    const s = sampleView({ filename: 'a.pdf' });
    const api = fakeApi({
      listSamples: vi.fn(async () => [s]),
      getSampleText: vi.fn(async () => ({
        sha256: 'abc',
        pages: [
          { number: 1, text: 'PROTOCOL APPROVAL', ocr: false },
          { number: 2, text: 'Batch 1 results', ocr: true },
        ],
      })),
    });
    tab(api);
    await userEvent.click(await screen.findByRole('button', { name: 'View text of a.pdf' }));
    const page2 = await screen.findByRole('region', { name: 'Page 2' });
    expect(page2).toHaveTextContent('Batch 1 results');
    expect(page2).toHaveTextContent('OCR');
    expect(screen.getByRole('region', { name: 'Page 1' })).not.toHaveTextContent('OCR');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/test/SamplesTab.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `SampleText`**

`apps/web/src/workbench/SampleText.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { PreparedText } from '@ih/shared';
import type { Api } from '../api/client.js';

/** A sample's prepared text (after extraction and OCR), one region per page. */
export function SampleText({
  api,
  projectId,
  sampleId,
}: {
  api: Api;
  projectId: string;
  sampleId: string;
}) {
  const [text, setText] = useState<PreparedText | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSampleText(projectId, sampleId).then(setText, (err: Error) => setError(err.message));
  }, [api, projectId, sampleId]);

  if (error) return <p role="alert">{error}</p>;
  if (!text) return <p>Loading text…</p>;
  return (
    <div className="sample-text">
      {text.pages.map((p) => (
        <section key={p.number} aria-label={`Page ${p.number}`}>
          <h4>
            Page {p.number}
            {p.ocr && <small className="badge"> OCR</small>}
          </h4>
          <pre>{p.text}</pre>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Write `SamplesTab`**

`apps/web/src/workbench/SamplesTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { MAX_SAMPLES, type SampleRole, type SampleView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { SampleText } from './SampleText.js';

/** Upload, triage and roles of a project's sample PDFs. Polls while any is preparing. */
export function SamplesTab({
  api,
  projectId,
  pollMs,
}: {
  api: Api;
  projectId: string;
  pollMs: number;
}) {
  const [samples, setSamples] = useState<SampleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSamples(await api.listSamples(projectId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const preparing = samples?.some((s) => s.state === 'preparing') ?? false;
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [preparing, pollMs, refresh]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
    await refresh();
  };

  const upload = async (files: File[]) => {
    setUploading(true);
    const failures: string[] = [];
    for (const file of files) {
      try {
        await api.uploadSample(projectId, file, 'dev');
      } catch (err) {
        failures.push(`${file.name}: ${(err as Error).message}`);
      }
    }
    setUploading(false);
    setError(failures.length ? failures.join('; ') : null);
    await refresh();
  };

  return (
    <div className="samples">
      <p className="muted">
        Add 3–8 sample PDFs to develop with, plus a few held out for testing (at most{' '}
        {MAX_SAMPLES}). Each is prepared in the background: text extraction, then OCR for pages
        without a text layer.
      </p>
      <label className="file-pick">
        Add sample PDFs
        <input
          type="file"
          accept="application/pdf"
          multiple
          disabled={uploading}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) void upload(files);
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {samples === null ? (
        <p>Loading…</p>
      ) : samples.length === 0 ? (
        <p>No samples yet.</p>
      ) : (
        <table aria-label="Samples">
          <thead>
            <tr>
              <th>File</th>
              <th>Role</th>
              <th>Pages</th>
              <th>OCR pages</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {samples.map((s) => (
              <tr key={s.id}>
                <td>{s.filename}</td>
                <td>
                  <select
                    aria-label={`Role of ${s.filename}`}
                    value={s.role}
                    onChange={(e) =>
                      void act(() =>
                        api.setSampleRole(projectId, s.id, e.target.value as SampleRole),
                      )
                    }
                  >
                    <option value="dev">dev</option>
                    <option value="holdout">holdout</option>
                  </select>
                </td>
                <td>{s.triage?.pageCount ?? '—'}</td>
                <td>{s.triage ? s.triage.ocrPages.length : '—'}</td>
                <td>
                  {s.state}
                  {s.error && <small> — {s.error}</small>}
                </td>
                <td>
                  {s.state === 'ready' && (
                    <button
                      type="button"
                      aria-label={`${viewing === s.id ? 'Hide' : 'View'} text of ${s.filename}`}
                      onClick={() => setViewing(viewing === s.id ? null : s.id)}
                    >
                      {viewing === s.id ? 'Hide text' : 'View text'}
                    </button>
                  )}
                  {s.state === 'failed' && s.prepareJobId && (
                    <button
                      type="button"
                      aria-label={`Retry ${s.filename}`}
                      onClick={() => void act(() => api.retryJob(s.prepareJobId!))}
                    >
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${s.filename}`}
                    onClick={() => void act(() => api.removeSample(projectId, s.id))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {viewing && <SampleText key={viewing} api={api} projectId={projectId} sampleId={viewing} />}
    </div>
  );
}
```

- [ ] **Step 5: Show it in the project page**

In `ProjectPage.tsx` import `SamplesTab` and render, right after the `<nav>`:

```tsx
      {tab === 'samples' && <SamplesTab api={api} projectId={project.id} pollMs={pollMs} />}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "Web: workbench samples tab and prepared-text viewer"
```

---

### Task 11: Brief tab and Test runs tab

**Files:**
- Create: `apps/web/src/workbench/BriefTab.tsx`, `apps/web/src/workbench/RunsTab.tsx`
- Modify: `apps/web/src/workbench/ProjectPage.tsx`
- Test: `apps/web/test/BriefTab.test.tsx`, `apps/web/test/RunsTab.test.tsx` (new)

**Interfaces:**
- Consumes: `saveBrief`, `runDevTests`, `listTestRuns`, `EMPTY_BRIEF`, `job()` fixture.
- Produces: `BriefTab({ api, projectId, brief, onSaved })`; `RunsTab({ api, projectId, draft, pollMs })`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/BriefTab.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BRIEF } from '@ih/shared';
import { BriefTab } from '../src/workbench/BriefTab.js';
import { fakeApi } from './fake-api.js';

describe('BriefTab', () => {
  it('saves the brief as a new version', async () => {
    const saved = {
      projectId: 'letter',
      version: 3,
      body: { ...EMPTY_BRIEF, purpose: 'QA batch records' },
      createdAt: '',
    };
    const onSaved = vi.fn();
    const api = fakeApi({ saveBrief: vi.fn(async () => saved) });
    render(<BriefTab api={api} projectId="letter" brief={null} onSaved={onSaved} />);
    const save = screen.getByRole('button', { name: 'Save brief' });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Purpose'), 'QA batch records');
    await userEvent.click(save);
    expect(api.saveBrief).toHaveBeenCalledWith('letter', { ...EMPTY_BRIEF, purpose: 'QA batch records' });
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(await screen.findByRole('status')).toHaveTextContent('Saved as version 3');
  });

  it('starts from the latest version', () => {
    render(
      <BriefTab
        api={fakeApi()}
        projectId="letter"
        brief={{ projectId: 'letter', version: 2, body: { ...EMPTY_BRIEF, rules: 'Dates are DMY' }, createdAt: '' }}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Rules')).toHaveValue('Dates are DMY');
    expect(screen.getByText('Version 2')).toBeInTheDocument();
  });
});
```

`apps/web/test/RunsTab.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { RunsTab } from '../src/workbench/RunsTab.js';
import { fakeApi, job } from './fake-api.js';

describe('RunsTab', () => {
  it('runs the draft on the dev samples and lists the runs with review links', async () => {
    const done = job({ filename: 's1.pdf', status: 'awaiting_review', test: true, specVersion: 2 });
    const queued = job({ filename: 's2.pdf', status: 'queued', test: true, specVersion: 2 });
    const listTestRuns = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([done, queued]);
    const api = fakeApi({ listTestRuns, runDevTests: vi.fn(async () => ({ jobs: [done, queued] })) });
    render(<RunsTab api={api} projectId="letter" draft={2} pollMs={60_000} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run on dev samples' }));
    expect(api.runDevTests).toHaveBeenCalledWith('letter');
    const table = await screen.findByRole('table', { name: 'Test runs' });
    const row = within(table).getByRole('cell', { name: 's1.pdf' }).closest('tr')!;
    expect(within(row).getByRole('link', { name: 'Review' })).toHaveAttribute('href', `#/review/${done.id}`);
    const pending = within(table).getByRole('cell', { name: 's2.pdf' }).closest('tr')!;
    expect(within(pending).queryByRole('link')).toBeNull();
  });

  it('shows why a run was refused', async () => {
    const api = fakeApi({
      runDevTests: vi.fn(async () => {
        throw new ApiError('no prepared dev samples to run', 409);
      }),
    });
    render(<RunsTab api={api} projectId="letter" draft={1} pollMs={60_000} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run on dev samples' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no prepared dev samples to run');
  });

  it('cannot run without an open draft', async () => {
    render(<RunsTab api={fakeApi()} projectId="letter" draft={null} pollMs={60_000} />);
    expect(await screen.findByRole('button', { name: 'Run on dev samples' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/BriefTab.test.tsx apps/web/test/RunsTab.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `BriefTab`**

`apps/web/src/workbench/BriefTab.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { EMPTY_BRIEF, type Brief, type BriefBody } from '@ih/shared';
import type { Api } from '../api/client.js';

const FIELDS: { key: keyof BriefBody; label: string; hint: string }[] = [
  { key: 'purpose', label: 'Purpose', hint: 'What the outputs are for and who consumes them.' },
  { key: 'outputs', label: 'Outputs wanted', hint: 'Must-have and nice-to-have values, in plain words.' },
  { key: 'exampleOutput', label: 'Example output', hint: 'A mock CSV or a few example rows.' },
  { key: 'glossary', label: 'Glossary', hint: 'Domain terms and abbreviations.' },
  { key: 'variants', label: 'Variants', hint: 'Known issuers, layouts, languages, blank vs executed copies.' },
  { key: 'rules', label: 'Rules', hint: 'For example: placeholders are null; use the executed copy; dates are DMY.' },
];

/** The user's product knowledge for this document type; every save is a new version. */
export function BriefTab({
  api,
  projectId,
  brief,
  onSaved,
}: {
  api: Api;
  projectId: string;
  brief: Brief | null;
  onSaved: (brief: Brief) => void;
}) {
  const [body, setBody] = useState<BriefBody>(brief?.body ?? EMPTY_BRIEF);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(body) !== JSON.stringify(brief?.body ?? EMPTY_BRIEF);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const saved = await api.saveBrief(projectId, body);
      onSaved(saved);
      setMessage(`Saved as version ${saved.version}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form aria-label="Brief" className="brief-form" onSubmit={(e) => void save(e)}>
      {FIELDS.map((f) => (
        <div key={f.key}>
          <label htmlFor={`brief-${f.key}`}>{f.label}</label>
          <small id={`brief-${f.key}-hint`} className="muted">
            {f.hint}
          </small>
          <textarea
            id={`brief-${f.key}`}
            aria-describedby={`brief-${f.key}-hint`}
            rows={4}
            value={body[f.key]}
            onChange={(e) => setBody({ ...body, [f.key]: e.target.value })}
          />
        </div>
      ))}
      {brief && <p className="muted">Version {brief.version}</p>}
      <button type="submit" className="primary" disabled={!dirty}>
        Save brief
      </button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 4: Write `RunsTab`**

`apps/web/src/workbench/RunsTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api } from '../api/client.js';

const REVIEWABLE = new Set(['awaiting_review', 'succeeded']);

/** Test runs of the open draft on the dev samples. Polls while any run is unfinished. */
export function RunsTab({
  api,
  projectId,
  draft,
  pollMs,
}: {
  api: Api;
  projectId: string;
  draft: number | null;
  pollMs: number;
}) {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setJobs(await api.listTestRuns(projectId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = jobs?.some((j) => j.status === 'queued' || j.status === 'running') ?? false;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [active, pollMs, refresh]);

  const run = async () => {
    setError(null);
    try {
      await api.runDevTests(projectId);
    } catch (err) {
      setError((err as Error).message);
    }
    await refresh();
  };

  return (
    <div className="runs">
      <p className="muted">
        Runs the draft{draft !== null ? ` v${draft}` : ''} on every prepared dev sample. Holdout
        samples are not used. Workbench runs queue behind production jobs.
      </p>
      <button type="button" className="primary" disabled={draft === null} onClick={() => void run()}>
        Run on dev samples
      </button>
      {error && <p role="alert">{error}</p>}
      {jobs !== null && jobs.length > 0 && (
        <table aria-label="Test runs">
          <thead>
            <tr>
              <th>File</th>
              <th>Version</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.filename}</td>
                <td>v{j.specVersion}</td>
                <td>
                  {j.status}
                  {j.error && <small> — {j.error}</small>}
                </td>
                <td>{REVIEWABLE.has(j.status) && <a href={`#/review/${j.id}`}>Review</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Show them in the project page**

In `ProjectPage.tsx` import both and render after the Samples line:

```tsx
      {tab === 'brief' && (
        <BriefTab
          api={api}
          projectId={project.id}
          brief={view.brief}
          onSaved={(brief) => setView({ ...view, brief })}
        />
      )}
      {tab === 'runs' && (
        <RunsTab api={api} projectId={project.id} draft={draft} pollMs={pollMs} />
      )}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "Web: workbench brief and dev test runs tabs"
```

---

### Task 12: "Open in workbench", docs, full check and smoke test

**Files:**
- Modify: `apps/web/src/templates/TemplatesPage.tsx`, `CLAUDE.md`, `docs/architecture.md`
- Test: `apps/web/test/TemplatesPage.test.tsx`

**Interfaces:**
- Consumes: the `#/workbench/<id>` route (Task 8), `ProjectPage`'s 404 → "Open in workbench" flow (Task 9).
- Produces: a "Workbench" column on Document types linking every type to `#/workbench/<id>`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/TemplatesPage.test.tsx` (reuse the file's existing way of stubbing `listTemplates`):

```tsx
  it('links each document type to its workbench project', async () => {
    const api = fakeApi({
      listTemplates: vi.fn(async () => [
        { id: 'letter', name: 'Letter', description: null, published: 1, draft: null, versions: [] },
      ]),
    });
    render(<TemplatesPage api={api} onNavigate={vi.fn()} />);
    expect(await screen.findByRole('link', { name: 'Open in workbench' })).toHaveAttribute(
      'href',
      '#/workbench/letter',
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/test/TemplatesPage.test.tsx`
Expected: FAIL — no such link.

- [ ] **Step 3: Add the column**

In `TemplatesPage.tsx` add `<th>Workbench</th>` after `<th>Draft</th>` and, after the draft cell:

```tsx
                <td>
                  <a href={`#/workbench/${t.id}`}>Open in workbench</a>
                </td>
```

(Draft editing stays reachable from this page until the publish gate moves into the Workbench in phase 5.)

Run: `npx vitest run --project web`
Expected: PASS.

- [ ] **Step 4: Document it**

`CLAUDE.md`:
- In **Cross-language contracts**, change the job statuses row's left cell to `Job statuses and tasks (incl. \`cancelled\`, migration 0006; \`prepare\` + \`priority\`, migration 0008)` and add a row: `| Workbench prepared text | \`PreparedTextSchema\`/\`PreparedTriageSchema\` in \`packages/shared/src/workbench.ts\`, \`preparedTextKey\` | \`workbench.prepare_sample\`, \`storage.prepared_text_key\` |`.
- In **Rules of the road** add:

```markdown
- **Workbench ([ADR 0007](docs/adr/0007-workbench.md), [design](docs/design/workbench.md)):** one project per document type (`workbench_projects.id` = template id; `apps/api/src/workbench/`, `apps/api/src/routes/workbench.ts`, `apps/web/src/workbench/`). Samples are ordinary documents; uploading one queues a `prepare` job (text + OCR only, `worker/src/ingest_worker/workbench.py`) writing `prepared/{sha256}/text.json|triage.json` to the runs bucket. Sample state comes from that job. Workbench jobs have `priority = -10` (production 0) and never appear on the Jobs page (prepare) or get bulk-deleted; a sample's document is never deleted with a job.
```

`docs/architecture.md`: add a short "Workbench" subsection (3–5 sentences) after the section that describes templates/review, saying the same as the CLAUDE.md bullet and linking the design doc.

- [ ] **Step 5: Full check**

Run: `npm run check`
Expected: PASS.

Run: `npm run worker:lint && npm run worker:test`
Expected: PASS.

- [ ] **Step 6: Smoke test against real infra**

1. `deploy/scripts/dev-infra.ps1 up`
2. `npm run dev:api` (applies migration 0008 on start; note the admin token it prints), `npm run dev:web`, and `cd worker && uv run ingest-worker`.
3. In the browser: sign in → Workbench → create `pvp-test` / "PVP test" → Samples → add `docs/samples/TEXT process_validation_protocol.pdf` → state goes `preparing` → `ready` with 5 pages → View text shows 5 page regions.
4. Brief → fill Purpose → Save brief → "Saved as version 1".
5. Template → the embedded editor opens v1; paste/import a valid definition (e.g. via the editor's YAML tab, adapting `specs/process-validation-protocol/v3/template.yaml` with `id: pvp-test`, `version: 1`) and save.
6. Test runs → Run on dev samples → a run appears, is processed, and its Review link opens the review screen.
7. Jobs page: the test run is listed; the prepare job is not.
8. Run the worker integration test from Task 2 Step 8 and confirm it passes.

Record any step that could not be run (e.g. no local LLM for step 6) in the PR description.

- [ ] **Step 7: Commit**

```bash
git add apps/web CLAUDE.md docs/architecture.md
git commit -m "Workbench: Open in workbench from Document types; document phase 1"
```
