# Workbench 6: Export/Import Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project can be exported as a drafting bundle (zip: the exact drafting context, stage instructions and schemas, brief, draft template, dev sample PDFs) and a bundle can be imported as a new project on another deployment.

**Architecture:** Export is a document-less worker job (new task `export`, migration 0019). It builds the bundle with the same `drafting.build_context` the drafting stages use and writes it to the runs bucket at `exports/{project}/{job}.zip`; the API starts it, lists it and streams the zip. Import is API-only (no LLM logic): it unzips with `fflate`, validates everything first (manifest, template, brief, every PDF's sha256), then creates the template draft v1, the project, the brief and the dev samples (each queues a `prepare` job, as an upload does).

**Tech Stack:** Python 3.13 worker (`zipfile`, Pydantic, mypy strict), Fastify + Zod + `fflate` (already a dependency), React, Postgres migration.

**Spec:** `docs/design/workbench.md` (Context assembly; API sketch `GET /projects/:id/export`, `POST /projects/import`; Phasing item 6) and `docs/adr/0007-workbench.md` ("Export/import of a drafting bundle … shares the context assembly, so a bundle is exactly what the in-harness drafter would see").

## Global Constraints

- Spec: "One function builds the drafting context for every stage, for `revise`, and for the export bundle." The bundle's `context.md` is `drafting.build_context(...)` output, byte for byte.
- Spec: "Holdout text, holdout page images and holdout failure diffs are never included. This is enforced here, in one place, and covered by tests." Bundles hold dev samples only: the API sends only ready dev samples and the worker refuses any other role.
- Data policy (ADR 0007): only the admin token can let a project's data leave through an external model. Ruling for bundles: exporting or downloading the bundle of a `local` project needs the admin token (403 `exporting a local-only project needs the admin token`); `external` projects can be exported by any session.
- Imported projects start `local`, with fresh stage state; holdout samples are never in a bundle, so the importer adds them.
- Migrations are forward-only: `db/migrations/0019_workbench_export.sql`.
- Cross-language contracts change on both sides in the same PR: job task `export` (`packages/shared/src/jobs.ts`, migration, worker `main.py`), `exportKey`/`storage.export_key`, the bundle manifest (`BundleManifestSchema` in TS, written by the worker).
- Unit tests never touch Postgres, S3 or a real LLM. `PgRepo` changes get a case in the opt-in `apps/api/test/integration/workbench-pg.test.ts`, run only on a throwaway container.
- Python: `from __future__ import annotations`, mypy `--strict`, ruff. TS: ESM `.js` suffixes, Zod at boundaries.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `config/llm-providers.yaml`.

## Review Focus

1. A holdout sample never reaches a bundle, even if the API params carried one — pinned in Task 1 (worker refuses) and Task 2 (API sends dev only).
2. A broken or hostile upload (not a zip, a zip bomb, a missing or tampered PDF, an unknown format version) is a 400 and writes nothing — pinned in Task 3 (assert no project and no template afterwards).
3. Importing under an id that already exists (project or document type) is a 409 and writes nothing — pinned in Task 3.
4. A non-admin session cannot export or download a local-only project's bundle — pinned in Task 2.
5. Exporting again replaces the previous export (job row and zip), and an export deleted while running removes its own zip — pinned in Task 2 (API) and Task 1 (worker).

---

## File structure

| File | Responsibility |
| --- | --- |
| `db/migrations/0019_workbench_export.sql` (create) | `export` job task |
| `packages/shared/src/jobs.ts` (modify) | task enum gains `export` |
| `packages/shared/src/storage-keys.ts` (modify) | `exportKey` |
| `packages/shared/src/bundle.ts` (create) | `BUNDLE_FORMAT`, `BundleManifestSchema`, `ExportView` |
| `worker/src/ingest_worker/storage.py` (modify) | `export_key` |
| `worker/src/ingest_worker/drafting.py` (modify) | `DraftParamSample` gains optional `bucket`/`objectKey` |
| `worker/src/ingest_worker/bundle.py` (create) | `ExportParams`, `build_bundle` (pure), `run_export` |
| `worker/src/ingest_worker/main.py` (modify) | dispatch `export` |
| `apps/api/src/repositories/{types,memory,pg}.ts` (modify) | `createExportJob`, `listExportJobs` |
| `apps/api/src/routes/workbench.ts` (modify) | export `sampleViews`, `acceptedSurvey`; extract `addSampleFile` |
| `apps/api/src/routes/workbench-bundle.ts` (create) | export, list, download, import routes |
| `apps/web/src/workbench/ExportPanel.tsx`, `ImportBundle.tsx` (create) | UI |
| Docs | CLAUDE.md, `docs/architecture.md`, `docs/design/workbench.md` |

---

### Task 1: Contracts, migration 0019 and the worker's export task

**Files:**
- Create: `db/migrations/0019_workbench_export.sql`, `packages/shared/src/bundle.ts`, `packages/shared/test/bundle.test.ts`, `worker/src/ingest_worker/bundle.py`, `worker/tests/test_bundle.py`
- Modify: `packages/shared/src/jobs.ts`, `packages/shared/src/storage-keys.ts` (+ its test), `packages/shared/src/index.ts`, `worker/src/ingest_worker/storage.py`, `worker/src/ingest_worker/drafting.py`, `worker/src/ingest_worker/main.py`

**Interfaces:**
- Produces (TS): `exportKey(projectId: string, jobId: string): string` → `exports/${projectId}/${jobId}.zip`; `BUNDLE_FORMAT = 'ih-workbench-bundle'`; `BundleManifestSchema`; `type BundleManifest`; `interface ExportView { jobId: string; status: JobStatus; error: string | null; createdAt: string; updatedAt: string }`; job task `'export'`.
- Produces (Python): `storage.export_key(project_id, job_id)`; `bundle.ExportParams` (a `DraftParams` with `project_name` alias `projectName`; `stage` must be `"export"`); `bundle.build_bundle(...) -> bytes`; `bundle.run_export(job, deps, queue) -> dict[str, Any]` (returns the manifest).
- Bundle layout (both sides rely on it): `manifest.json`, `README.md`, `context.md`, `brief.json`, `template.yaml`, `stages/<id>.md`, `stages/<id>.schema.json` (for each of `survey, outputs, sections, steps, revise`), `samples/<sha256>.pdf`.

- [ ] **Step 1: Failing TS tests (key and manifest)**

In the existing storage-keys test file (find it with `ls packages/shared/test`), add:

```ts
it('names an export bundle in the runs bucket', () => {
  expect(exportKey('letter', 'j1')).toBe('exports/letter/j1.zip');
});
```

`packages/shared/test/bundle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BundleManifestSchema } from '../src/bundle.js';

const sha = 'a'.repeat(64);
// What worker/src/ingest_worker/bundle.py writes (keep in step with test_bundle.py).
const manifest = {
  format: 'ih-workbench-bundle',
  formatVersion: 1,
  project: { id: 'letter', name: 'Letter' },
  templateVersion: 2,
  briefVersion: 3,
  samples: [
    { sampleId: 's1', filename: 'a.pdf', sha256: sha, file: `samples/${sha}.pdf`, inContext: true },
  ],
  stages: ['survey', 'outputs', 'sections', 'steps', 'revise'],
};

describe('BundleManifestSchema', () => {
  it('parses a worker-written manifest', () => {
    expect(BundleManifestSchema.parse(manifest)).toEqual(manifest);
  });
  it.each([
    ['another format', { ...manifest, format: 'zip' }],
    ['a newer format version', { ...manifest, formatVersion: 2 }],
    ['a bad sha256', { ...manifest, samples: [{ ...manifest.samples[0], sha256: 'x' }] }],
    ['a file outside samples/', { ...manifest, samples: [{ ...manifest.samples[0], file: '../a.pdf' }] }],
    ['an unknown key', { ...manifest, extra: 1 }],
  ])('rejects %s', (_name, value) => {
    expect(BundleManifestSchema.safeParse(value).success).toBe(false);
  });
});
```

Run: `npx vitest run --project shared` — Expected: FAIL (missing module/export).

- [ ] **Step 2: Implement the TS contract**

`packages/shared/src/storage-keys.ts`:

```ts
/** A project's exported drafting bundle (runs bucket, export task). */
export function exportKey(projectId: string, jobId: string): string {
  return `exports/${projectId}/${jobId}.zip`;
}
```

`packages/shared/src/bundle.ts`:

```ts
import { z } from 'zod';
import type { JobStatus } from './jobs.js';
import { MAX_SAMPLES } from './workbench.js';

/**
 * Drafting bundle (Workbench phase 6, ADR 0007): what the in-harness drafter sees, for
 * air-gapped drafting or another deployment. Written by the worker's export task
 * (worker/src/ingest_worker/bundle.py), read by the import route. Dev samples only.
 */
export const BUNDLE_FORMAT = 'ih-workbench-bundle';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const BundleManifestSchema = z
  .object({
    format: z.literal(BUNDLE_FORMAT),
    formatVersion: z.literal(1),
    project: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
    templateVersion: z.number().int().positive(),
    briefVersion: z.number().int().positive().nullable(),
    samples: z
      .array(
        z
          .object({
            sampleId: z.string(),
            filename: z.string().min(1).max(255),
            sha256: Sha256,
            file: z.string().regex(/^samples\/[0-9a-f]{64}\.pdf$/),
            /** Its text is in context.md (the drafter reads at most 8 samples). */
            inContext: z.boolean(),
          })
          .strict()
          .refine((s) => s.file === `samples/${s.sha256}.pdf`, { message: 'file must match sha256' }),
      )
      .max(MAX_SAMPLES),
    stages: z.array(z.string()),
  })
  .strict();
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

/** An export job of a project, newest first in lists. */
export interface ExportView {
  jobId: string;
  status: JobStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
```

(If `MAX_SAMPLES` lives elsewhere or importing it creates a cycle, import it from where `packages/shared/src/workbench.ts` exports it.) Export from `index.ts`. Add `'export'` to the task enum in `packages/shared/src/jobs.ts`.

Run: `npx vitest run --project shared` — Expected: PASS. Run `npm run typecheck` (check the exit code) — a new enum member can make exhaustive switches fail; handle each one (document-less tasks behave like `draft`).

- [ ] **Step 3: Migration 0019**

```sql
-- Workbench phase 6: the `export` task builds a project's drafting bundle (document-less, like
-- `draft`); the zip lives at exports/{project}/{job}.zip in the runs bucket.
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export'));
```

Check the latest migration that changed `jobs_task_check` (`grep -ln jobs_task_check db/migrations`) and copy its list, adding `'export'` only.

- [ ] **Step 4: Failing worker tests**

`worker/tests/test_bundle.py` (reuse the shapes from `tests/test_drafting.py`; copy what you need, don't import test modules):

```python
from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest
import yaml

from ingest_worker.bundle import build_bundle, run_export
from ingest_worker.drafting import DraftSample, MAX_CONTEXT_SAMPLES, STAGES, build_context
from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.pipeline import Buckets, DocumentError, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, export_key, prepared_text_key

from .fakes import FakeQueue

PDF = b"%PDF-1.7\n% sample\n%%EOF\n"
SHA = hashlib.sha256(PDF).hexdigest()
BRIEF = {"purpose": "Letters to extract"}
DRAFT = {"id": "letter", "version": 2, "name": "Letter", "outputs": {"fields": [], "tables": []}}


def export_job(**params: Any) -> ClaimedJob:
    base: dict[str, Any] = {
        "stage": "export",
        "dataPolicy": "local",
        "briefVersion": 3,
        "brief": BRIEF,
        "draft": DRAFT,
        "projectName": "Letter",
        "samples": [
            {"sampleId": "s1", "filename": "a.pdf", "sha256": SHA, "role": "dev",
             "bucket": "inbox", "objectKey": "letter/a.pdf"}
        ],
    }
    return ClaimedJob(
        id="job-x", document_id="", spec_id="letter", spec_version=0, bucket="", object_key="",
        model_override=None, attempts=1, max_attempts=3, task="export", test=True,
        project_id="letter", params={**base, **params},
    )


def make(specs_dir: Path) -> tuple[MemoryObjectStore, PipelineDeps]:
    store = MemoryObjectStore()
    text = {"sha256": SHA, "pages": [{"number": 1, "text": "Dear Sir", "ocr": False}]}
    store.put("runs", prepared_text_key(SHA), json.dumps(text).encode(), "application/json")
    store.put("inbox", "letter/a.pdf", PDF, "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        example_template="id: example\n",
    )
    return store, deps


def read_zip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {name: z.read(name) for name in z.namelist()}


def test_export_writes_the_bundle_with_the_drafters_exact_context(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    queue = FakeQueue()
    manifest = run_export(export_job(), deps, queue)  # type: ignore[arg-type]
    files = read_zip(store.get("runs", export_key("letter", "job-x")))
    expected_context = build_context(
        brief=BRIEF, draft=DRAFT, samples=[DraftSample("s1", "a.pdf", "dev", ["Dear Sir"])],
        example_yaml="id: example\n",
    )
    assert files["context.md"].decode() == expected_context
    assert files[f"samples/{SHA}.pdf"] == PDF
    assert json.loads(files["brief.json"]) == BRIEF
    assert yaml.safe_load(files["template.yaml"]) == DRAFT
    for stage in STAGES.values():
        assert files[f"stages/{stage.id}.md"].decode() == stage.instructions
        assert json.loads(files[f"stages/{stage.id}.schema.json"]) == stage.schema
    assert json.loads(files["manifest.json"]) == manifest == {
        "format": "ih-workbench-bundle",
        "formatVersion": 1,
        "project": {"id": "letter", "name": "Letter"},
        "templateVersion": 2,
        "briefVersion": 3,
        "samples": [{"sampleId": "s1", "filename": "a.pdf", "sha256": SHA,
                     "file": f"samples/{SHA}.pdf", "inContext": True}],
        "stages": list(STAGES),
    }
    assert "README.md" in files


def test_export_refuses_holdout_samples(fixture_specs_dir: Path) -> None:
    _, deps = make(fixture_specs_dir)
    job = export_job(samples=[{"sampleId": "h", "filename": "h.pdf", "sha256": SHA,
                               "role": "holdout", "bucket": "inbox", "objectKey": "letter/a.pdf"}])
    with pytest.raises(DocumentError, match="holdout"):
        run_export(job, deps, FakeQueue())  # type: ignore[arg-type]


def test_export_refuses_a_pdf_that_does_not_match_its_sha(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    store.put("inbox", "letter/a.pdf", b"%PDF-other", "application/pdf")
    with pytest.raises(DocumentError, match="a.pdf"):
        run_export(export_job(), deps, FakeQueue())  # type: ignore[arg-type]


def test_only_the_first_samples_are_in_context(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    samples = []
    for i in range(MAX_CONTEXT_SAMPLES + 1):
        pdf = PDF + str(i).encode()
        sha = hashlib.sha256(pdf).hexdigest()
        store.put("inbox", f"letter/{i}.pdf", pdf, "application/pdf")
        text = {"sha256": sha, "pages": [{"number": 1, "text": f"text {i}", "ocr": False}]}
        store.put("runs", prepared_text_key(sha), json.dumps(text).encode(), "application/json")
        samples.append({"sampleId": f"s{i}", "filename": f"{i}.pdf", "sha256": sha,
                        "role": "dev", "bucket": "inbox", "objectKey": f"letter/{i}.pdf"})
    manifest = run_export(export_job(samples=samples), deps, FakeQueue())  # type: ignore[arg-type]
    assert [s["inContext"] for s in manifest["samples"]] == [True] * MAX_CONTEXT_SAMPLES + [False]
    files = read_zip(store.get("runs", export_key("letter", "job-x")))
    assert len([n for n in files if n.startswith("samples/")]) == MAX_CONTEXT_SAMPLES + 1


def test_bundle_bytes_are_deterministic() -> None:
    args: dict[str, Any] = dict(
        manifest={"format": "ih-workbench-bundle"}, context="c", brief=BRIEF, draft=DRAFT,
        pdfs={SHA: PDF},
    )
    assert build_bundle(**args) == build_bundle(**args)


def test_an_export_cancelled_during_the_write_removes_its_zip(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    calls: list[int] = []

    def cancel_after_first_check() -> bool:
        calls.append(1)
        return len(calls) > 1

    queue = FakeQueue(jobs=[export_job()], cancel_when=cancel_after_first_check)
    run_once(queue, deps, "w1")
    assert len(calls) == 2
    assert store.get_optional("runs", export_key("letter", "job-x")) is None
    assert queue.completed == []


def test_run_once_completes_an_export_job(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[export_job()])
    run_once(queue, deps, "w1")
    assert [c[0] for c in queue.completed] == ["job-x"]  # match FakeQueue.completed's shape
    assert store.get_optional("runs", export_key("letter", "job-x")) is not None
```

(Import `run_once` from `ingest_worker.main`; these mirror `test_segment_job_cancelled_during_the_write_removes_its_object` in `tests/test_workbench_segment.py` — check `FakeQueue.completed`'s element shape there and adjust the assertion.)

Adapt names to the real code where they differ (`MemoryObjectStore.get`/`get_optional`, `ModelRegistry` constructor, `FakeQueue` API) and record each adaptation.

Run: `cd worker && uv run pytest tests/test_bundle.py` — Expected: FAIL (`ingest_worker.bundle` missing).

- [ ] **Step 5: Implement the worker side**

`storage.py`:

```python
def export_key(project_id: str, job_id: str) -> str:
    """A project's exported drafting bundle (runs bucket, export task)."""
    return f"exports/{project_id}/{job_id}.zip"
```

`drafting.py` `DraftParamSample` gains (optional, so draft jobs are unchanged):

```python
    bucket: str | None = None
    object_key: str | None = Field(default=None, alias="objectKey")
```

`bundle.py`:

```python
"""Workbench drafting bundle (phase 6, ADR 0007).

The export task writes exactly what the in-harness drafter sees: `context.md` comes from
`drafting.build_context`, the same function every drafting stage uses, plus each stage's
instructions and JSON Schema, the brief, the draft template and the dev sample PDFs. Holdout
samples are refused here as they are in drafting.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from typing import Any

import yaml
from pydantic import Field, ValidationError

from .drafting import MAX_CONTEXT_SAMPLES, STAGES, DraftParams, DraftSample, _pages, build_context
from .pipeline import DocumentError, JobCancelled, PipelineDeps, check_cancelled
from .queue import ClaimedJob, JobQueue
from .storage import export_key

BUNDLE_FORMAT = "ih-workbench-bundle"
#: Fixed timestamp so the same inputs always give the same zip bytes.
_ZIP_TIME = (2020, 1, 1, 0, 0, 0)

README = """\
# Workbench drafting bundle

- `context.md` is exactly what the harness's drafting model reads: harness rules, the brief,
  the current draft, an example template and the dev samples' text (at most 8).
- `stages/<stage>.md` is a stage's instructions and `stages/<stage>.schema.json` the JSON
  Schema its answer must satisfy. Give a model `context.md` followed by one stage's
  instructions, and ask for JSON matching the schema.
- `samples/` holds the dev sample PDFs; `manifest.json` lists them. Holdout samples are never
  included.
- Import the bundle into another deployment from the Workbench page to start a project with
  this brief, draft and these samples.
"""


class ExportParams(DraftParams):
    """jobs.params of an export job (written by the API): a drafting context plus the name."""

    project_name: str = Field(alias="projectName")


def build_bundle(
    *,
    manifest: dict[str, Any],
    context: str,
    brief: dict[str, Any],
    draft: dict[str, Any] | None,
    pdfs: dict[str, bytes],
) -> bytes:
    """The bundle zip. Deterministic: entries in a fixed order with a fixed timestamp."""
    entries: list[tuple[str, bytes]] = [
        ("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False).encode()),
        ("README.md", README.encode()),
        ("context.md", context.encode()),
        ("brief.json", json.dumps(brief, indent=2, ensure_ascii=False).encode()),
        ("template.yaml", yaml.safe_dump(draft or {}, sort_keys=False, allow_unicode=True).encode()),
    ]
    for stage in STAGES.values():
        entries.append((f"stages/{stage.id}.md", stage.instructions.encode()))
        entries.append((f"stages/{stage.id}.schema.json", json.dumps(stage.schema, indent=2).encode()))
    for sha, pdf in pdfs.items():
        entries.append((f"samples/{sha}.pdf", pdf))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    return out.getvalue()


def run_export(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    """Build a project's drafting bundle and write it to the runs bucket; returns the manifest."""
    try:
        params = ExportParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid export parameters: {exc}") from exc
    if params.stage != "export":
        raise DocumentError(f"export job with stage {params.stage!r}")
    if job.project_id is None:
        raise DocumentError("export job without a project")
    holdout = [s.sample_id for s in params.samples if s.role != "dev"]
    if holdout:
        raise DocumentError(f"holdout samples are never exported: {', '.join(holdout)}")

    pdfs: dict[str, bytes] = {}
    for s in params.samples:
        if s.bucket is None or s.object_key is None:
            raise DocumentError(f"sample {s.filename} has no PDF location")
        pdf = deps.store.get_optional(s.bucket, s.object_key)
        if pdf is None or hashlib.sha256(pdf).hexdigest() != s.sha256:
            raise DocumentError(f"sample {s.filename}: PDF is missing or changed")
        pdfs[s.sha256] = pdf
    in_context = params.samples[:MAX_CONTEXT_SAMPLES]
    context = build_context(
        brief=params.brief,
        draft=params.draft,
        samples=[DraftSample(s.sample_id, s.filename, s.role, _pages(deps, s.sha256)) for s in in_context],
        example_yaml=deps.example_template,
        survey=params.survey,
    )
    manifest: dict[str, Any] = {
        "format": BUNDLE_FORMAT,
        "formatVersion": 1,
        "project": {"id": job.project_id, "name": params.project_name},
        "templateVersion": int((params.draft or {}).get("version") or 1),
        "briefVersion": params.brief_version,
        "samples": [
            {
                "sampleId": s.sample_id,
                "filename": s.filename,
                "sha256": s.sha256,
                "file": f"samples/{s.sha256}.pdf",
                "inContext": i < MAX_CONTEXT_SAMPLES,
            }
            for i, s in enumerate(params.samples)
        ],
        "stages": list(STAGES),
    }
    data = build_bundle(manifest=manifest, context=context, brief=params.brief, draft=params.draft, pdfs=pdfs)
    check_cancelled(job, queue)
    key = export_key(job.project_id, job.id)
    deps.store.put(deps.buckets.runs, key, data, "application/zip")
    if queue.is_cancelled(job):
        deps.store.delete(deps.buckets.runs, key)
        raise JobCancelled(job.id)
    queue.event(job.id, "info", "bundle exported", {"samples": [s.sample_id for s in params.samples]})
    return manifest
```

If `_pages` is private and ruff/mypy object, rename it to `prepared_pages` in `drafting.py` (and its callers) rather than suppressing the warning. If `JobCancelled` lives elsewhere, import it from there.

`main.py`: dispatch `job.task == "export"` to `run_export` exactly like the `draft` branch dispatches `run_draft` (same success/failure handling: `DocumentError` → `needs_review`, `JobCancelled` → no status write).

Run: `cd worker && uv run pytest tests/test_bundle.py` — Expected: PASS. Then `npm run worker:lint` (ruff + mypy strict) — Expected: clean.

- [ ] **Step 6: Full check and commit**

Run `npm run check` (prepend uv's directory to PATH if needed) and check the exit code.

```bash
git add db/migrations/0019_workbench_export.sql packages/shared worker
git commit -m "Workbench bundle: export task, manifest contract and migration 0019"
```

---

### Task 2: API — start, list and download exports

**Files:**
- Modify: `apps/api/src/repositories/types.ts`, `memory.ts`, `pg.ts`, `apps/api/src/routes/workbench.ts` (export `sampleViews` and `acceptedSurvey` if they are not exported), `apps/api/src/app.ts` (register the new plugin the way `workbench` routes are registered)
- Create: `apps/api/src/routes/workbench-bundle.ts`, `apps/api/test/workbench-bundle.test.ts`
- Modify: `apps/api/test/integration/workbench-pg.test.ts`, `apps/api/test/access.test.ts` only if its sweep needs the new routes listed

**Interfaces:**
- Consumes: Task 1 (`exportKey`, `ExportView`, task `'export'`).
- Produces:
  - `Repo.createExportJob(projectId: string, params: Record<string, unknown>): Promise<{ job: <the row type createDraftJob returns>; removed: string[] }>` — one export per project: deletes the project's earlier export jobs (returned in `removed`) and inserts the new one, serialized per project with `pg_advisory_xact_lock(hashtext('export:' || projectId))`; `task = 'export'`, `test = true`, workbench priority, `max_attempts = 3` (as `createDraftJob`).
  - `Repo.listExportJobs(projectId: string)` — like `listDraftJobs` for `task = 'export'`.
  - `POST /api/workbench/projects/:id/export` → 202 `ExportView`. Errors: 404 project; 403 `exporting a local-only project needs the admin token` (local project, non-admin); 409 `no prepared dev samples`; 409 `the project has no template version`.
  - `GET /api/workbench/projects/:id/exports` → `ExportView[]` (newest first).
  - `GET /api/workbench/projects/:id/exports/:jobId/bundle` → the zip (`content-type: application/zip`, `content-disposition: attachment; filename="<id>-v<templateVersion>-bundle.zip"`; use the draft/published version the job's params carried). 404 unknown job (or a job of another project or task); 409 `the export has not finished`; same 403 for local projects.

- [ ] **Step 1: Failing tests**

`apps/api/test/workbench-bundle.test.ts` — reuse the `project()`/`add()` pattern from `apps/api/test/workbench-references.test.ts` (copy it in). Cover:

```ts
describe('export', () => {
  it('queues an export with the dev samples only and the drafting context inputs', async () => {
    // add a dev and a holdout sample; save a brief
    // POST /export → 202, { jobId, status: 'queued' }
    // repo.jobs has task 'export', projectId 'letter', document-less
    // params: { stage: 'export', dataPolicy: 'local', projectName: 'Letter', briefVersion: 1,
    //   brief: <saved body>, draft: <draft definition>,
    //   samples: [{ sampleId, filename: 's1.pdf', sha256, role: 'dev', bucket: 'inbox', objectKey }] }
    // — the holdout sample is absent
  });
  it('replaces the previous export and deletes its zip', async () => {
    // first export, mark it succeeded, put a zip at exportKey('letter', first.jobId)
    // second export → first job gone from listExportJobs and its zip deleted from the runs bucket
  });
  it('refuses with no prepared dev samples', async () => { /* 409 'no prepared dev samples' */ });
  it('lists exports newest first', async () => { /* GET /exports */ });
  it('downloads a finished bundle and refuses an unfinished one', async () => {
    // queued → 409 'the export has not finished'; succeeded + object → 200, application/zip,
    // attachment filename 'letter-v1-bundle.zip', body equal to the stored bytes
    // unknown uuid → 404; a draft job id of the same project → 404; 'not-a-uuid' → 404
  });
});

describe('export of a local-only project', () => {
  it('needs the admin token to export or download', async () => {
    // Follow the existing admin-only test for PUT /data-policy (search apps/api/test for
    // 'admins only'): build the app with access enabled, log in with a non-admin token,
    // and assert POST /export and GET /bundle are 403 with
    // 'exporting a local-only project needs the admin token'; the admin session gets 202.
    // Switch the project to external (admin) → the non-admin session gets 202.
  });
});
```

Write each test fully (these comments say what to assert; the code must be real tests with real assertions, built with the helpers the neighbouring test files use).

Run: `npx vitest run --project api apps/api/test/workbench-bundle.test.ts` — Expected: FAIL (404 routes).

- [ ] **Step 2: Implement the repository**

Memory: mirror `createSegmentJob`/`createDraftJob` (delete earlier `export` jobs of the project, return their ids, insert). Pg:

```ts
  async createExportJob(projectId: string, params: Record<string, unknown>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('export:' || $1))`, [projectId]);
      const removed = await client.query<{ id: string }>(
        `DELETE FROM jobs WHERE project_id = $1 AND task = 'export' RETURNING id`,
        [projectId],
      );
      const { rows } = await client.query<SegmentRow>(
        `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params)
         VALUES ($1, 'export', true, $2, 3, $3)
         RETURNING id, project_id, status, error, created_at, updated_at`,
        [projectId, WORKBENCH_PRIORITY, JSON.stringify(params)],
      );
      await client.query('COMMIT');
      return { job: toSegmentJob(rows[0]!), removed: removed.rows.map((r) => r.id) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
```

(Use the names `createSegmentJob` uses — `SegmentRow`, `toSegmentJob`, `WORKBENCH_PRIORITY` — if they differ, adapt.) `listExportJobs` is `listDraftJobs` with `task = 'export'`. Add a Pg integration case: two concurrent `createExportJob` calls leave exactly one export job; `listExportJobs` returns it.

- [ ] **Step 3: Implement the routes**

`apps/api/src/routes/workbench-bundle.ts` (a `FastifyPluginAsync` registered next to the workbench routes in `app.ts`):

```ts
const LOCAL_EXPORT = 'exporting a local-only project needs the admin token';
const JobParams = z.object({ id: z.string(), jobId: z.string().uuid() });

const exportView = (j: { id: string; status: JobStatus; error: string | null; createdAt: string; updatedAt: string }): ExportView => ({
  jobId: j.id, status: j.status, error: j.error, createdAt: j.createdAt, updatedAt: j.updatedAt,
});
```

POST `/workbench/projects/:id/export`:
1. project or 404; `if (project.dataPolicy === 'local' && !isAdmin(app, req)) return 403 LOCAL_EXPORT` (export `isAdmin` from `workbench.ts` or move it to a shared helper module).
2. `const { draft, latest } = await versionsOf(templates, id); const record = draft !== null ? await templates.get(id, draft) : latest;` → 409 `the project has no template version` when null.
3. Dev samples exactly as the stage route builds them (`sampleViews(...).filter(role === 'dev' && state === 'ready')`), plus `bucket: s.record.bucket, objectKey: s.record.objectKey` — read the sample record / document fields that hold the inbox bucket and key (find them in `SampleRecord` or via `repo.getDocument`; add what is missing). 409 `no prepared dev samples` when empty.
4. `const brief = await workbench.latestBrief(id);` then `createExportJob(id, { stage: 'export', dataPolicy: project.dataPolicy, projectName: project.name, briefVersion: brief?.version ?? null, brief: brief?.body ?? EMPTY_BRIEF, draft: record.definition, samples, survey: await acceptedSurvey(app, id) })` — omit `survey` when it is null if `DraftParams` would reject `null` (it accepts `None`; keep it consistent with the change-stage call).
5. Delete each removed job's zip: `await app.deps.store.delete(app.deps.buckets.runs, exportKey(id, removedId))`.
6. `req.log.info({ projectId: id, jobId, samples: samples.length }, 'bundle export queued')`; 202 `exportView(job)`.

GET `/exports`: 404 project; `(await repo.listExportJobs(id)).map(exportView)`.

GET `/exports/:jobId/bundle`: parse params (404 on a bad uuid); project or 404; local + non-admin → 403; the job must be in `listExportJobs(id)` (else 404); not `succeeded` → 409 `the export has not finished`; read `exportKey(id, jobId)` from the runs bucket (missing → 404 `bundle not found`); version from the job params' `draft.version` (read the params through the repo; Task 5b added `getJobParams` — use it); send with the headers above.

- [ ] **Step 4: Run, then the API suite**

Run: `npx vitest run --project api apps/api/test/workbench-bundle.test.ts`, then `npx vitest run --project api` (the `access.test.ts` sweep must cover the three new routes — if it enumerates routes automatically it passes; if it lists them, add them).

Run the Pg integration test on a throwaway container (port 55493; `docker run --rm -d --name ih-6-pg -e POSTGRES_PASSWORD=test -p 55493:5432 postgres:17-alpine`, then `IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55493/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg`, then `docker rm -f ih-6-pg`).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: start, list and download Workbench drafting bundles"
```

---

### Task 3: API — import a bundle as a new project

**Files:**
- Modify: `apps/api/src/routes/workbench.ts` (extract `addSampleFile` from the samples upload route), `apps/api/src/routes/workbench-bundle.ts`
- Test: `apps/api/test/workbench-bundle.test.ts` (new `describe('import')`)

**Interfaces:**
- Consumes: Task 1 `BundleManifestSchema`, `MAX_SAMPLES`; the brief body schema the `PUT /brief` route uses; `pinned` from `apps/api/src/templates/drafts.ts`.
- Produces:
  - `addSampleFile(app, project, { filename, body, role }): Promise<{ record, job } | { error: string; code: 409 | 415 }>` exported from `workbench.ts`; the upload route calls it (behaviour unchanged — its existing tests must pass untouched).
  - `POST /api/workbench/projects/import` (multipart: optional fields `id`, `name` before the `bundle` file part) → 201 `ProjectView`.

- [ ] **Step 1: Failing tests**

Build bundles in the test with `fflate`'s `zipSync` and `strToU8`:

```ts
import { strToU8, zipSync } from 'fflate';
import { createHash } from 'node:crypto';

const pdfBytes = (n: number) => Buffer.from(`%PDF-1.7\n% bundle ${n}\n%%EOF\n`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function bundle(overrides: { manifest?: object; files?: Record<string, Uint8Array> } = {}) {
  const pdf = pdfBytes(1);
  const manifest = {
    format: 'ih-workbench-bundle',
    formatVersion: 1,
    project: { id: 'memo', name: 'Memo' },
    templateVersion: 3,
    briefVersion: 2,
    samples: [{ sampleId: 'x', filename: 'm1.pdf', sha256: sha(pdf), file: `samples/${sha(pdf)}.pdf`, inContext: true }],
    stages: ['survey'],
    ...overrides.manifest,
  };
  return Buffer.from(
    zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'brief.json': strToU8(JSON.stringify({ purpose: 'Memos' })),
      'template.yaml': strToU8('id: memo\nversion: 3\nname: Memo\noutputs:\n  fields: []\n  tables: []\n'),
      [`samples/${sha(pdf)}.pdf`]: new Uint8Array(pdf),
      ...overrides.files,
    }),
  );
}

const importBundle = (app, zip: Buffer, fields: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/workbench/projects/import',
    ...multipart(fields, { filename: 'b.zip', content: zip, field: 'bundle' }) });
```

(`multipart(fields, file)` in `apps/api/test/helpers.ts` takes `{ filename, content, contentType? }` and a fixed file field name; the route uses `req.file()`, which takes the first file part whatever its name, so drop `field: 'bundle'` if you don't extend the helper, and pass `contentType: 'application/zip'`.)

Cases (each a full test):
1. Imports: 201; project `memo` named `Memo`, `dataPolicy: 'local'`; template `memo` v1 is a draft whose definition is the YAML with `id: 'memo', version: 1`; latest brief body `{ purpose: 'Memos' }`; one dev sample `m1.pdf` with a queued `prepare` job; the inbox holds the PDF bytes.
2. `id` and `name` fields override the manifest (import as `memo2` / `Memo copy`; the template definition's `id` is `memo2`).
3. 409 `memo already exists here; import under another id` when a project or a document type `memo` exists — and nothing new is written (template count and project count unchanged).
4. 400 for each of: not a zip (`Buffer.from('nope')`); a manifest with `formatVersion: 2`; a missing `manifest.json`; a PDF whose bytes don't match its sha256 (put other bytes under the listed name) — error names `m1.pdf`; a listed sample file missing from the zip; `template.yaml` that is not a YAML mapping; an invalid `id` field (`'Bad Id'`). After every 400, `GET /api/workbench/projects` has no `memo` and `templates.list()` has no `memo`.
5. 400 `bundle is too large` when the summed uncompressed size exceeds the limit (build one with a large zero-filled extra entry and set a small `maxUploadBytes` through `testApp({ maxUploadBytes: 1024 })` if `testApp` accepts the override; otherwise assert through a unit test of the size guard).
6. The existing sample upload tests pass unchanged after the `addSampleFile` extraction.

Run: `npx vitest run --project api apps/api/test/workbench-bundle.test.ts` — Expected: the import tests FAIL (404).

- [ ] **Step 2: Extract `addSampleFile`**

Move the body of `POST /workbench/projects/:id/samples` after the PDF read (sample count, duplicate sha, version, inbox put, `createWorkbenchJob`, `addSample`) into:

```ts
/** Adds a PDF as a sample (queues its prepare job). Shared by upload and bundle import. */
export async function addSampleFile(
  app: FastifyInstance,
  project: WorkbenchProject,
  input: { filename: string; body: Buffer; role: SampleRole },
): Promise<{ view: SampleView } | { code: 409 | 415; error: string }>
```

The route keeps its multipart parsing and maps the result to the same responses. Run the sample tests: `npx vitest run --project api apps/api/test/workbench-samples.test.ts` — Expected: PASS unchanged.

- [ ] **Step 3: Implement import**

In `workbench-bundle.ts`:

```ts
const MAX_BUNDLE_ENTRIES = MAX_SAMPLES + 32;

/** Unzips with limits: the summed uncompressed size and the entry count (zip bombs). */
function unzipBundle(zip: Buffer, maxBytes: number): Record<string, Uint8Array> | string {
  let total = 0;
  let count = 0;
  try {
    return unzipSync(new Uint8Array(zip), {
      filter: (f) => {
        count += 1;
        total += f.originalSize;
        if (count > MAX_BUNDLE_ENTRIES || total > maxBytes) throw new RangeError('too large');
        return true;
      },
    });
  } catch (err) {
    return err instanceof RangeError ? 'bundle is too large' : 'not a valid bundle (zip)';
  }
}
```

Route `POST /workbench/projects/import`:
1. `const limit = app.deps.maxUploadBytes * MAX_SAMPLES;` `const file = await req.file({ limits: { fileSize: limit } })` → 400 `bundle file part is required` when absent; read `id`/`name` with `multipartField`; `const zip = await file.toBuffer()`.
2. `unzipBundle(zip, limit * 2)` → 400 with the message.
3. Parse `manifest.json` (JSON + `BundleManifestSchema`) → 400 `manifest.json: <first issue>`; `template.yaml` with `parseYaml` → must be a plain object → 400 `template.yaml is not a template mapping`; `brief.json` with the brief schema `PUT /brief` uses → 400 `brief.json: …` (a missing brief is allowed: no brief saved).
4. `id = idField ?? manifest.project.id` validated with the same id schema `CreateProject` uses → 400; `name = nameField ?? manifest.project.name`.
5. 409 `${id} already exists here; import under another id` when `workbench.getProject(id)` or any `templates.list()` row has that id.
6. Every manifest sample: entry present, `isPdf`, `length <= maxUploadBytes`, sha256 equals the manifest's, no duplicate sha → else 400 `sample <filename>: <reason>`.
7. Only now write: `templates.create(id, 1, pinned(definition, id, 1), 'draft')`; `const project = await workbench.createProject(id, name)`; if a brief was given, `workbench.saveBrief(id, brief)`; for each sample `addSampleFile(app, project, { filename, body, role: 'dev' })` (an error here is unexpected after validation: log it and return 500 with the message, leaving the created project for the user to inspect).
8. `req.log.info({ projectId: id, samples: n }, 'bundle imported')`; 201 `projectView(app, project)` (export `projectView` from `workbench.ts` if needed).

- [ ] **Step 4: Run, then the API suite, then commit**

Run: `npx vitest run --project api` — Expected: PASS.

```bash
git add apps/api
git commit -m "API: import a Workbench drafting bundle as a new project"
```

---

### Task 4: Web and docs

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, the Workbench project page (`apps/web/src/workbench/ProjectPage.tsx`, Brief tab) and list page (`WorkbenchPage.tsx`)
- Create: `apps/web/src/workbench/ExportPanel.tsx`, `apps/web/src/workbench/ImportBundle.tsx`, tests `apps/web/test/ExportPanel.test.tsx`, `apps/web/test/ImportBundle.test.tsx`
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md`

**Interfaces:**
- Consumes: Task 2 and 3 routes; `ExportView`.
- Produces (`Api`): `startExport(projectId: string): Promise<ExportView>`; `listExports(projectId: string): Promise<ExportView[]>`; `exportBundleUrl(projectId: string, jobId: string): string`; `importBundle(file: File, fields: { id?: string; name?: string }): Promise<ProjectView>`.

- [ ] **Step 1: Failing tests**

`ExportPanel` (props `{ api, projectId, dataPolicy, pollMs }`):

```tsx
it('starts an export, polls it and offers the download', async () => {
  const api = fakeApi();
  api.listExports
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ jobId: 'j1', status: 'running', error: null, createdAt: 't', updatedAt: 't' }])
    .mockResolvedValue([{ jobId: 'j1', status: 'succeeded', error: null, createdAt: 't', updatedAt: 't' }]);
  api.startExport.mockResolvedValue({ jobId: 'j1', status: 'queued', error: null, createdAt: 't', updatedAt: 't' });
  render(<ExportPanel api={api} projectId="letter" dataPolicy="external" pollMs={10} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Export bundle' }));
  const link = await screen.findByRole('link', { name: 'Download bundle' });
  expect(link).toHaveAttribute('href', api.exportBundleUrl('letter', 'j1'));
});

it('says local-only exports need the admin token', async () => {
  render(<ExportPanel api={fakeApi()} projectId="letter" dataPolicy="local" pollMs={10} />);
  expect(await screen.findByText(/admin token/)).toBeInTheDocument();
});

it('shows a failed export', async () => { /* status 'needs_review', error 'boom' → text 'boom' */ });
```

`ImportBundle` (props `{ api, onImported: (p: ProjectView) => void }`):

```tsx
it('imports a bundle, optionally under another id', async () => {
  const api = fakeApi();
  api.importBundle.mockResolvedValue(projectView /* build with the fake's project factory */);
  const onImported = vi.fn();
  render(<ImportBundle api={api} onImported={onImported} />);
  const file = new File(['zip'], 'b.zip', { type: 'application/zip' });
  await userEvent.upload(screen.getByLabelText('Bundle (.zip)'), file);
  await userEvent.type(screen.getByLabelText('Project id (optional)'), 'memo2');
  await userEvent.click(screen.getByRole('button', { name: 'Import' }));
  await waitFor(() => expect(api.importBundle).toHaveBeenCalledWith(file, { id: 'memo2' }));
  expect(onImported).toHaveBeenCalled();
});
it('shows the server error', async () => { /* importBundle rejects Error('memo already exists here…') → text shown */ });
```

Run: `npx vitest run --project web` — Expected: FAIL.

- [ ] **Step 2: Implement**

- `client.ts`: the four methods (`importBundle` posts `FormData` with `id`/`name` fields **before** the `bundle` file — the server reads fields that precede the file part; follow how the sample upload builds its `FormData`). `exportBundleUrl` returns `${base}/workbench/projects/${projectId}/exports/${jobId}/bundle`.
- `fake-api.ts`: `vi.fn`s for the four, `exportBundleUrl` returning a deterministic string.
- `ExportPanel.tsx`: a section headed "Drafting bundle" with one line explaining it ("The drafting context, stage instructions, brief, draft and dev sample PDFs — never holdout samples — for drafting elsewhere or importing into another deployment."), the admin note for local projects ("Exporting a local-only project needs the admin token."), an "Export bundle" button, the latest export's status, polling every `pollMs` while queued/running, a "Download bundle" link when succeeded, the error when it failed. Render it on the Brief tab of `ProjectPage`.
- `ImportBundle.tsx`: a small form on `WorkbenchPage` (labels "Bundle (.zip)", "Project id (optional)", button "Import"), calling `onImported` with the new project; the page opens the project the way it opens one after "New project".

Run: `npx vitest run --project web` — Expected: PASS.

- [ ] **Step 3: Docs**

- `docs/design/workbench.md`: Phasing item 6 → "**6 (done):** export/import bundle." and a short "Bundle" subsection under Context assembly: the zip layout, dev only, `context.md` = `build_context`, the admin rule for local projects, one export per project, import creates a `local` project with draft v1 and dev samples (re-prepared).
- `docs/architecture.md`: one paragraph on the export task and the import route.
- `CLAUDE.md`: in the Workbench bullet, a "Bundle (phase 6, migration 0019)" sentence block (task `export`, `exportKey`, `bundle.run_export`, routes, admin rule, one per project, import validates everything before writing); add `export` (migration 0019) to the job tasks contract row, and a contracts-table row "Workbench bundle" (`BundleManifestSchema`/`exportKey` in `packages/shared/src/bundle.ts`/`storage-keys.ts` ↔ `bundle.build_bundle`/`run_export`, `storage.export_key`).

- [ ] **Step 4: Full check and commit**

Run `npx prettier --write` on touched TS/TSX/MD, then `npm run check` and `npm run format:check`; check both exit codes.

```bash
git add apps/web CLAUDE.md docs
git commit -m "Web and docs: Workbench drafting bundle export and import"
```
