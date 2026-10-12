# Workbench 2/6: Segmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Sections** tab to a Workbench project. You edit section anchors (and the copy-selection rule), and a grid shows in under a second where each anchor lands in every prepared sample: hit or miss, page, matched line and section size. You can then save the anchors to the draft template.

**Architecture:**
- A new project-scoped worker task, **`segment`**, applies a candidate `document` block (sections, copies, page markers) to the prepared text of every ready sample. It writes a grid JSON to the runs bucket.
- The segmenter is refactored so the grid and production segmentation share one function (`section_spans`). The preview therefore always agrees with what a real job does.
- Segment jobs are `jobs` rows with `document_id IS NULL` (ADR 0007).
- A Postgres `NOTIFY` on every newly queued job wakes the worker immediately instead of after its poll interval, which makes the preview feel live. This also speeds up every other job.
- The API owns enqueueing and reading the result. The web app debounces edits, starts a preview, polls the result and renders the grid.

**Tech Stack:** Python 3.13 + pytest + mypy strict (worker), psycopg 3.2 `notifies()`, Fastify + Zod (API), React + Testing Library + Vitest (web), Postgres migration.

**Spec:** [docs/design/workbench.md](../../design/workbench.md) (Phase 2 "Segmentation", sections "Worker tasks → `segment`", "UI → Sections") and [ADR 0007](../../adr/0007-workbench.md) ("Segmentation preview runs in the worker", "project-scoped jobs").

**Depends on:** Workbench phase 1 ([kenhayward/ingestion-harness#31](https://github.com/kenhayward/ingestion-harness/pull/31)) merged to `main`. Branch from `main` after it lands.

## Global Constraints

- Anchors are Python regexes evaluated by the worker. The browser never runs them (ADR 0007: one regex dialect, preview matches production).
- Preview and production must share the segmentation code: `segment()` and the grid both use `section_spans()`.
- Segment jobs: `task = 'segment'`, `document_id IS NULL`, `project_id` set, `priority = -5` (`SEGMENT_PRIORITY`; above other workbench jobs at -10, below production at 0), `max_attempts = 1`, `test = true`.
- A new preview for a project deletes that project's earlier segment jobs and their result objects. Only the latest preview matters.
- An invalid regex is a per-anchor error shown in the grid. It never fails the job.
- Migrations are forward-only: add `db/migrations/0009_workbench_segment.sql`.
- `apps/api` stays free of regex evaluation of anchors and of PDF/LLM logic. The worker stays free of HTTP serving.
- Zod at every boundary, including stored JSON read back (the grid result). Python: `from __future__ import annotations`, `mypy --strict`, ruff.
- Unit tests never touch Postgres, SeaweedFS or an LLM. Postgres-only behaviour (claim of document-less jobs, NOTIFY) gets `@pytest.mark.integration` tests. **Run them only against a throwaway database, never one holding real jobs.**
- CI runs `npm run format:check`, so keep every changed file Prettier-clean.
- Cross-language contracts change on both sides in this PR: job task `segment`; `params`; the segmentation result JSON and its key.

## Review Focus

1. **A typo'd anchor while typing:** an unclosed `(` or `[` must show as an error on that anchor only. The other anchors and samples keep their results, and the job succeeds. (Task 2 test.)
2. **Preview and production disagree:** the grid's section boundaries must equal what `segment()` produces for the same text. (Task 2 parity test.)
3. **Rapid edits:** typing fires many previews. Older queued or running ones must be dropped, stale responses must never overwrite the grid, and job rows must not pile up. (Task 5 test for pruning; Task 9 test for stale responses.)
4. **Document-less jobs breaking existing job code:** the Jobs page, clean-up, metrics and `getJob` must keep working when `jobs.document_id` is null. Segment jobs must never appear in any `JobSummary` list. (Task 5 tests; Task 3 integration test.)
5. **Samples not ready, or none at all:** a preview with no prepared samples gets a clear 409. A sample whose text is missing shows "not prepared" in its row, and the other rows still show. (Task 6 and Task 2 tests.)

---

## File map

| File | Responsibility |
| --- | --- |
| `db/migrations/0009_workbench_segment.sql` (new) | Nullable `jobs.document_id` with a check, task `segment`, `jobs.params`, NOTIFY trigger |
| `packages/shared/src/workbench.ts` | `SegmentDocumentSchema`, `SegmentationResultSchema`, `SegmentationView` |
| `packages/shared/src/jobs.ts` | Task enum gains `segment` |
| `packages/shared/src/storage-keys.ts`, `worker/src/ingest_worker/storage.py` | `segmentationKey(projectId, jobId)` |
| `worker/src/ingest_worker/segment.py` | `SectionSpan`, `section_spans()`; `segment()` rebuilt on top of them |
| `worker/src/ingest_worker/workbench.py` | `SegmentParams`, `segment_samples()` (pure), `run_segment()` |
| `worker/src/ingest_worker/queue.py` | Claim document-less jobs; `ClaimedJob.project_id/params`; `wait_for_work()` |
| `worker/src/ingest_worker/main.py` | `segment` branch; idle wait via `wait_for_work` |
| `apps/api/src/repositories/{types,memory,pg}.ts` | `createSegmentJob`, `getSegmentJob`; clean-up ignores document-less jobs |
| `apps/api/src/routes/workbench.ts` | `POST/GET /workbench/projects/:id/segmentations[/:jobId]` |
| `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts` | `startSegmentation`, `getSegmentation` |
| `apps/web/src/router.ts` | Tab `sections` |
| `apps/web/src/workbench/segmentation.ts` (new) | Pure grid helpers (`sectionHits`, `cellFlag`) |
| `apps/web/src/workbench/SegmentationGrid.tsx` (new) | Samples × sections table |
| `apps/web/src/workbench/useSegmentPreview.ts` (new) | Start, poll and drop stale previews |
| `apps/web/src/workbench/SectionsTab.tsx` (new) | Anchor editor, preview, save to draft, text with marks |
| `apps/web/src/workbench/SampleText.tsx`, `ProjectPage.tsx` | Section-start marks; Sections tab |
| `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md` | Document it; resolve the design's NOTIFY-vs-poll open question |

---

### Task 1: Migration and shared contracts

**Files:**
- Create: `db/migrations/0009_workbench_segment.sql`
- Modify: `packages/shared/src/jobs.ts`, `packages/shared/src/workbench.ts`, `packages/shared/src/storage-keys.ts`
- Test: `packages/shared/test/workbench.test.ts`

**Interfaces:**
- Produces (TypeScript, `@ih/shared`):
  - `JobSummary.task` includes `'segment'`.
  - `SegmentDocumentSchema` / `type SegmentDocument = { sections: Section[] (min 1); copies?: { anchor: string; select: 'first' | 'last' }; pageMarkers: boolean (default true) }`. It reuses `SectionSchema` and `CopySelectionSchema` from `spec.ts`.
  - `SegmentationResultSchema` / `type SegmentationResult = { anchorErrors: Record<string, string>; samples: SegmentedSample[] }`.
  - `SegmentedSample = { sampleId: string; firstPage: number; pageCount: number; error: string | null; missingRequired: string[]; sections: SectionCell[] }`.
  - `SectionCell = { id: string; found: boolean; page: number | null; line: string | null; chars: number }`.
  - `interface SegmentationView { jobId: string; status: JobStatus; error: string | null; result: SegmentationResult | null }`.
  - `segmentationKey(projectId, jobId)` returns `segmentation/{projectId}/{jobId}.json` (runs bucket).
  - `anchorErrors` keys are section ids, plus the literal key `copies` for the copy-selection anchor.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/workbench.test.ts`:

```ts
import {
  SegmentDocumentSchema,
  SegmentationResultSchema,
  segmentationKey,
} from '../src/index.js';

describe('segmentation contracts', () => {
  it('keys a segmentation result by project and job (mirrors worker storage.py)', () => {
    expect(segmentationKey('letter', 'j1')).toBe('segmentation/letter/j1.json');
  });

  it('defaults page markers on and requires at least one section', () => {
    expect(
      SegmentDocumentSchema.parse({ sections: [{ id: 'all', anchor: '\\A' }] }),
    ).toEqual({ sections: [{ id: 'all', anchor: '\\A', required: true }], pageMarkers: true });
    expect(SegmentDocumentSchema.safeParse({ sections: [] }).success).toBe(false);
    expect(
      SegmentDocumentSchema.safeParse({ sections: [{ id: 'Bad Id', anchor: 'x' }] }).success,
    ).toBe(false);
  });

  it('parses the grid the worker writes', () => {
    const result = SegmentationResultSchema.parse({
      anchorErrors: { totals: 'missing ), unterminated subpattern at position 0' },
      samples: [
        {
          sampleId: 's1',
          firstPage: 1,
          pageCount: 2,
          error: null,
          missingRequired: [],
          sections: [{ id: 'header', found: true, page: 1, line: 'INVOICE 42', chars: 30 }],
        },
      ],
    });
    expect(result.samples[0]!.sections[0]!.page).toBe(1);
  });

  it('accepts segment jobs', () => {
    expect(JobSummarySchema.shape.task.parse('segment')).toBe('segment');
  });
});
```

(`JobSummarySchema` is already imported at the top of this file by phase 1. If it is not, add it to the existing import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/workbench.test.ts`
Expected: FAIL. `segmentationKey` and `SegmentDocumentSchema` are not exported.

- [ ] **Step 3: Write the migration**

`db/migrations/0009_workbench_segment.sql`:

```sql
-- Workbench phase 2 (ADR 0007): project-scoped jobs without a document (the `segment` task),
-- task parameters, and a NOTIFY so the worker wakes as soon as a job is queued.

ALTER TABLE jobs ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE jobs ADD CONSTRAINT jobs_document_or_project
  CHECK (document_id IS NOT NULL OR project_id IS NOT NULL);

ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment'));

-- Task parameters (segment: candidate sections/copies/pageMarkers and the samples to apply them to).
ALTER TABLE jobs ADD COLUMN params jsonb;

-- Wake idle workers immediately (worker: LISTEN ih_jobs). Payload: the job id.
CREATE FUNCTION jobs_notify_queued() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ih_jobs', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_notify_queued AFTER INSERT OR UPDATE OF status ON jobs
  FOR EACH ROW WHEN (NEW.status = 'queued') EXECUTE FUNCTION jobs_notify_queued();
```

- [ ] **Step 4: Add the shared contracts**

In `packages/shared/src/jobs.ts`, extend the task enum and its comment:

```ts
  /**
   * process: extraction; publish: apply review edits and deliver to the final target;
   * rerun: one step again; prepare: workbench sample text + OCR only; segment: workbench
   * anchor preview over a project's prepared samples (no document; ADR 0007).
   */
  task: z.enum(['process', 'publish', 'rerun', 'prepare', 'segment']),
```

Append to `packages/shared/src/workbench.ts`:

```ts
import { CopySelectionSchema, SectionSchema } from './spec.js';
import type { JobStatus } from './jobs.js';

/** The part of a template's `document` block the segmentation preview applies. */
export const SegmentDocumentSchema = z
  .object({
    sections: z.array(SectionSchema).min(1),
    copies: CopySelectionSchema.optional(),
    pageMarkers: z.boolean().default(true),
  })
  .strict();
export type SegmentDocument = z.infer<typeof SegmentDocumentSchema>;

/** One sample × section cell of the preview grid. */
export const SectionCellSchema = z.object({
  id: z.string(),
  found: z.boolean(),
  /** 1-based PDF page where the section starts (null when not found). */
  page: z.number().int().positive().nullable(),
  /** The line the anchor matched, trimmed to 200 characters. */
  line: z.string().nullable(),
  /** Characters of section text (0 when not found or empty). */
  chars: z.number().int().nonnegative(),
});
export type SectionCell = z.infer<typeof SectionCellSchema>;

export const SegmentedSampleSchema = z.object({
  sampleId: z.string(),
  /** 1-based first page of the kept copy (copy selection). */
  firstPage: z.number().int().positive(),
  pageCount: z.number().int().nonnegative(),
  /** e.g. "not prepared" or a copies-anchor problem; sections are empty when set. */
  error: z.string().nullable(),
  missingRequired: z.array(z.string()),
  sections: z.array(SectionCellSchema),
});
export type SegmentedSample = z.infer<typeof SegmentedSampleSchema>;

/** Written by the worker's segment task (runs bucket, segmentationKey). */
export const SegmentationResultSchema = z.object({
  /** Invalid regexes: section id (or "copies") -> message. Those anchors are skipped. */
  anchorErrors: z.record(z.string(), z.string()),
  samples: z.array(SegmentedSampleSchema),
});
export type SegmentationResult = z.infer<typeof SegmentationResultSchema>;

export interface SegmentationView {
  jobId: string;
  status: JobStatus;
  error: string | null;
  /** Present once the job succeeded. */
  result: SegmentationResult | null;
}
```

Move the two new `import` lines to the top of the file, next to the existing `import { z } from 'zod';`.

Append to `packages/shared/src/storage-keys.ts` and extend its header comment with `runs bucket:    segmentation/{projectId}/{jobId}.json   (workbench segment task)`:

```ts
/** Section-anchor preview grid of a workbench project (runs bucket, worker segment task). */
export function segmentationKey(projectId: string, jobId: string): string {
  return `segmentation/${projectId}/${jobId}.json`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/shared/test/workbench.test.ts && npm run typecheck`
Expected: PASS. If the typecheck flags an exhaustive `Record<JobSummary['task'], …>` or a switch over tasks somewhere, add a `segment` entry next to the `prepare` one, mirroring it.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0009_workbench_segment.sql packages/shared
git commit -m "Workbench: migration 0009 (document-less jobs, segment task, params, NOTIFY) and segmentation contracts"
```

---

### Task 2: Worker: shared section spans and the preview grid

**Files:**
- Modify: `worker/src/ingest_worker/segment.py`, `worker/src/ingest_worker/workbench.py`, `worker/src/ingest_worker/storage.py`
- Test: `worker/tests/test_segment.py`, `worker/tests/test_workbench_segment.py` (new), `worker/tests/test_storage.py`

**Interfaces:**
- Consumes: the result JSON shape from Task 1 (`SegmentationResultSchema`); `pipeline.mark_pages`, `pipeline.PAGE_MARKER`, `segment.PAGE_BREAK`, `segment.select_copy`, `specs.Section`, `specs.CopySelection`.
- Produces:
  - `segment.SectionSpan(id: str, start: int, end: int)` (frozen dataclass; offsets into the joined text).
  - `segment.section_spans(text: str, sections: list[Section]) -> tuple[list[SectionSpan], list[str]]`. Returns the matched spans in document order and the ids of unmatched sections. It raises `re.error` for an invalid anchor (callers validate first).
  - `segment()` keeps its signature and behaviour and is rebuilt on `section_spans`.
  - `storage.segmentation_key(project_id: str, job_id: str) -> str`.
  - `workbench.segment_samples(samples: list[tuple[str, list[str] | None]], document: SegmentDocument) -> dict[str, Any]`. `samples` holds `(sample_id, pages or None when not prepared)`. It returns the `SegmentationResult` dict (camelCase keys) and is pure, with no I/O.
  - `workbench.SegmentDocument` (pydantic: `sections: list[Section]` min 1, `copies: CopySelection | None`, `page_markers: bool` alias `pageMarkers`, default True). It parses the same JSON as the TS `SegmentDocumentSchema`.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_segment.py`:

```python
from ingest_worker.segment import PAGE_BREAK, SectionSpan, section_spans


def test_section_spans_are_in_document_order_with_unmatched_ids() -> None:
    text = "Subtotal 1\nINVOICE 1\nDescription Qty\nx"
    spans, unmatched = section_spans(text, SECTIONS)
    assert [s.id for s in spans] == ["totals", "header", "lines"]
    assert unmatched == ["notes"]
    assert spans[0] == SectionSpan("totals", 0, text.index("INVOICE"))
    assert spans[-1].end == len(text)


def test_segment_bodies_equal_their_spans() -> None:
    pages = ["INVOICE #42\nAcme\nDescription Qty\nWidget", "Subtotal 13.00"]
    text = PAGE_BREAK.join(pages)
    spans, _ = section_spans(text, SECTIONS)
    result = segment(pages, SECTIONS)
    for span in spans:
        assert result[span.id] == text[span.start : span.end].strip()
```

Create `worker/tests/test_workbench_segment.py`:

```python
"""Segmentation preview grid: the same spans as production segment(), per-anchor errors."""

from __future__ import annotations

from typing import Any

import pytest

from ingest_worker.segment import segment
from ingest_worker.specs import Section
from ingest_worker.workbench import SegmentDocument, segment_samples

PAGES = [
    "PROTOCOL APPROVAL\nPrepared by: A\n",
    "1.0 PURPOSE\nValidate the blend\n2.0 PRODUCT DETAILS\nFolic acid 5 mg tablets\n",
]


def doc(**overrides: Any) -> SegmentDocument:
    base: dict[str, Any] = {
        "sections": [
            {"id": "approvals", "anchor": r"(?i)^PROTOCOL APPROVAL"},
            {"id": "purpose", "anchor": r"^\d+\.0 PURPOSE"},
            {"id": "product", "anchor": r"^\d+\.0 PRODUCT DETAILS"},
            {"id": "references", "anchor": r"^\d+\.0 REFERENCES", "required": False},
        ]
    }
    return SegmentDocument.model_validate({**base, **overrides})


def cells(result: dict[str, Any], sample: int = 0) -> dict[str, dict[str, Any]]:
    return {c["id"]: c for c in result["samples"][sample]["sections"]}


def test_grid_reports_page_line_and_size_per_section() -> None:
    result = segment_samples([("s1", PAGES)], doc())
    assert result["anchorErrors"] == {}
    sample = result["samples"][0]
    assert sample["sampleId"] == "s1"
    assert sample["firstPage"] == 1 and sample["pageCount"] == 2
    assert sample["error"] is None and sample["missingRequired"] == []
    c = cells(result)
    assert c["approvals"]["page"] == 1 and c["approvals"]["line"] == "PROTOCOL APPROVAL"
    assert c["purpose"]["page"] == 2 and c["purpose"]["line"] == "1.0 PURPOSE"
    assert c["product"]["found"] is True and c["product"]["chars"] > 0
    assert c["references"] == {"id": "references", "found": False, "page": None, "line": None, "chars": 0}


def test_grid_sizes_match_production_segmentation() -> None:
    document = doc(pageMarkers=False)
    result = segment_samples([("s1", PAGES)], document)
    production = segment(PAGES, list(document.sections))
    for section_id, cell in cells(result).items():
        assert cell["chars"] == len(production[section_id])


def test_invalid_anchor_is_reported_and_skipped_not_fatal() -> None:
    broken = doc(
        sections=[
            {"id": "approvals", "anchor": r"(?i)^PROTOCOL APPROVAL"},
            {"id": "purpose", "anchor": r"^(\d+\.0 PURPOSE"},  # unclosed group
        ]
    )
    result = segment_samples([("s1", PAGES)], broken)
    assert "purpose" in result["anchorErrors"]
    assert "unterminated" in result["anchorErrors"]["purpose"]
    c = cells(result)
    assert c["approvals"]["found"] is True
    assert c["purpose"]["found"] is False


def test_missing_required_sections_are_listed() -> None:
    result = segment_samples([("s1", ["PROTOCOL APPROVAL\nonly"])], doc())
    assert result["samples"][0]["missingRequired"] == ["purpose", "product"]


def test_unprepared_samples_get_an_error_row_and_others_still_segment() -> None:
    result = segment_samples([("s0", None), ("s1", PAGES)], doc())
    assert result["samples"][0] == {
        "sampleId": "s0",
        "firstPage": 1,
        "pageCount": 0,
        "error": "not prepared",
        "missingRequired": [],
        "sections": [],
    }
    assert cells(result, 1)["purpose"]["found"] is True


def test_copy_selection_keeps_the_last_copy_and_numbers_original_pages() -> None:
    pages = ["PROTOCOL APPROVAL\nblank", "1.0 PURPOSE\nx", "PROTOCOL APPROVAL\nexecuted", "1.0 PURPOSE\ny"]
    result = segment_samples(
        [("s1", pages)],
        doc(
            sections=[
                {"id": "approvals", "anchor": r"^PROTOCOL APPROVAL"},
                {"id": "purpose", "anchor": r"^\d+\.0 PURPOSE"},
            ],
            copies={"anchor": r"^PROTOCOL APPROVAL", "select": "last"},
        ),
    )
    sample = result["samples"][0]
    assert sample["firstPage"] == 3 and sample["pageCount"] == 2
    assert cells(result)["purpose"]["page"] == 4


def test_invalid_copies_anchor_is_an_anchor_error_and_copies_are_ignored() -> None:
    result = segment_samples([("s1", PAGES)], doc(copies={"anchor": "(", "select": "last"}))
    assert "copies" in result["anchorErrors"]
    assert result["samples"][0]["firstPage"] == 1


@pytest.mark.parametrize("long_line", ["X" * 500])
def test_matched_lines_are_trimmed(long_line: str) -> None:
    result = segment_samples(
        [("s1", [long_line])], doc(sections=[{"id": "all", "anchor": r"\A"}], pageMarkers=False)
    )
    assert len(cells(result)["all"]["line"]) == 200
```

Append to `worker/tests/test_storage.py`:

```python
def test_segmentation_key_mirrors_the_typescript_helper() -> None:
    from ingest_worker.storage import segmentation_key

    assert segmentation_key("letter", "j1") == "segmentation/letter/j1.json"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_segment.py tests/test_workbench_segment.py tests/test_storage.py -q`
Expected: FAIL with `ImportError: cannot import name 'SectionSpan'`.

- [ ] **Step 3: Refactor the segmenter onto `section_spans`**

Replace the body of `segment()` in `worker/src/ingest_worker/segment.py` and add the new pieces (keep `select_copy` unchanged):

```python
from __future__ import annotations

import re
from dataclasses import dataclass

from .specs import CopySelection, Section

PAGE_BREAK = "\n\f\n"


class MissingSectionsError(Exception):
    def __init__(self, missing: list[str]) -> None:
        super().__init__(f"required sections not found: {', '.join(missing)}")
        self.missing = missing


@dataclass(frozen=True)
class SectionSpan:
    """A matched section: [start, end) offsets into the joined document text."""

    id: str
    start: int
    end: int


def section_spans(text: str, sections: list[Section]) -> tuple[list[SectionSpan], list[str]]:
    """Where each section lies in `text`, in document order, plus the ids of unmatched sections.

    Each section starts at the first match of its anchor (multiline regex) and runs until the
    next matched anchor. When anchors match at the same position, the section declared earlier
    gets an empty span and the later one the text, so a catch-all start-of-text section yields to
    a more specific one. Shared by production segmentation and the workbench preview grid.
    Raises re.error for an invalid anchor.
    """
    starts: list[tuple[int, int, str]] = []
    unmatched: list[str] = []
    for order, section in enumerate(sections):
        match = re.search(section.anchor, text, re.MULTILINE)
        if match:
            starts.append((match.start(), order, section.id))
        else:
            unmatched.append(section.id)
    starts.sort()
    spans = [
        SectionSpan(section_id, start, starts[i + 1][0] if i + 1 < len(starts) else len(text))
        for i, (start, _, section_id) in enumerate(starts)
    ]
    return spans, unmatched


def segment(
    pages: list[str], sections: list[Section], page_marker: str | None = None
) -> dict[str, str]:
    """Split document text into sections (see section_spans). Missing optional sections map to
    "". With `page_marker` (a multiline regex such as the "[page N]" lines added to each page), a
    section starting mid-page is prefixed with that page's marker so its page stays known."""
    text = PAGE_BREAK.join(pages)
    spans, unmatched = section_spans(text, sections)
    required = {s.id for s in sections if s.required}
    missing = [section_id for section_id in unmatched if section_id in required]
    if missing:
        raise MissingSectionsError(missing)

    markers = (
        [(m.start(), m.group(0)) for m in re.finditer(page_marker, text, re.MULTILINE)]
        if page_marker
        else []
    )
    result = {s.id: "" for s in sections}
    for span in spans:
        body = text[span.start : span.end].strip()
        marker = next((m for pos, m in reversed(markers) if pos <= span.start), None)
        if body and marker and not body.startswith(marker):
            body = f"{marker}\n{body}"
        result[span.id] = body
    return result
```

Run: `cd worker && uv run pytest tests/test_segment.py tests/test_pipeline.py tests/test_template_pipeline.py tests/test_pvp_spec.py -q`
Expected: PASS. Production segmentation is unchanged.

- [ ] **Step 4: Add the storage key**

In `worker/src/ingest_worker/storage.py`, after `prepared_triage_key`:

```python
def segmentation_key(project_id: str, job_id: str) -> str:
    """Section-anchor preview grid of a workbench project (runs bucket, segment task)."""
    return f"segmentation/{project_id}/{job_id}.json"
```

- [ ] **Step 5: Write the grid builder**

Add to `worker/src/ingest_worker/workbench.py`. Merge the imports with the existing ones and keep `prepare_sample` unchanged.

```python
import re
from bisect import bisect_right

from pydantic import BaseModel, ConfigDict, Field

from .pipeline import PAGE_MARKER, mark_pages
from .segment import PAGE_BREAK, section_spans, select_copy
from .specs import CopySelection, Section

#: Longest matched line returned to the UI.
LINE_LIMIT = 200


class SegmentDocument(BaseModel):
    """The candidate `document` block a preview applies (TS: SegmentDocumentSchema)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    sections: list[Section] = Field(min_length=1)
    copies: CopySelection | None = None
    page_markers: bool = Field(default=True, alias="pageMarkers")


def _regex_error(pattern: str) -> str | None:
    try:
        re.compile(pattern, re.MULTILINE)
    except re.error as exc:
        return str(exc)
    return None


def _line_at(text: str, pos: int) -> str:
    start = text.rfind("\n", 0, pos) + 1
    end = text.find("\n", pos)
    return text[start : len(text) if end == -1 else end].strip()[:LINE_LIMIT]


def segment_samples(
    samples: list[tuple[str, list[str] | None]], document: SegmentDocument
) -> dict[str, Any]:
    """The preview grid (TS: SegmentationResult) for (sample id, prepared pages or None).

    Same steps as prepare_document: copy selection, page markers, then section_spans, so the
    grid shows exactly where production segmentation would cut. Invalid anchors are reported in
    anchorErrors and skipped; they never fail the preview."""
    anchor_errors: dict[str, str] = {}
    for section in document.sections:
        if (error := _regex_error(section.anchor)) is not None:
            anchor_errors[section.id] = error
    copies = document.copies
    if copies is not None and (error := _regex_error(copies.anchor)) is not None:
        anchor_errors["copies"] = error
        copies = None
    valid = [s for s in document.sections if s.id not in anchor_errors]
    required = [s.id for s in valid if s.required]

    rows: list[dict[str, Any]] = []
    for sample_id, pages in samples:
        if pages is None:
            rows.append(
                {
                    "sampleId": sample_id,
                    "firstPage": 1,
                    "pageCount": 0,
                    "error": "not prepared",
                    "missingRequired": [],
                    "sections": [],
                }
            )
            continue
        first, kept = select_copy(pages, copies) if copies else (0, pages)
        if document.page_markers:
            kept = mark_pages(kept, first + 1)
        text = PAGE_BREAK.join(kept)
        page_starts: list[int] = []
        offset = 0
        for page in kept:
            page_starts.append(offset)
            offset += len(page) + len(PAGE_BREAK)
        spans, unmatched = section_spans(text, valid)
        by_id = {span.id: span for span in spans}
        cells: list[dict[str, Any]] = []
        for section in document.sections:
            span = by_id.get(section.id)
            if span is None:
                cells.append(
                    {"id": section.id, "found": False, "page": None, "line": None, "chars": 0}
                )
                continue
            body = text[span.start : span.end].strip()
            cells.append(
                {
                    "id": section.id,
                    "found": True,
                    "page": first + bisect_right(page_starts, span.start),
                    "line": _line_at(text, span.start),
                    "chars": len(body),
                }
            )
        rows.append(
            {
                "sampleId": sample_id,
                "firstPage": first + 1,
                "pageCount": len(kept),
                "error": None,
                "missingRequired": [i for i in unmatched if i in required],
                "sections": cells,
            }
        )
    return {"anchorErrors": anchor_errors, "samples": rows}
```

`PAGE_MARKER` is imported for the docstring cross-reference only. If ruff flags it as unused, drop the import. The page arithmetic works because `bisect_right(page_starts, pos)` is the 1-based index of the page containing `pos` within the kept copy, and `first` is the 0-based index of that copy's first page.

Note: with page markers on, a section's `chars` includes its own `[page N]` line when the section starts at a page top. That is acceptable for a size indicator. The parity test therefore runs with `pageMarkers: false`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd worker && uv run pytest tests/test_segment.py tests/test_workbench_segment.py tests/test_storage.py -q`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

Run: `cd worker && uv run ruff check . && uv run ruff format --check . && uv run mypy`
Expected: PASS.

```bash
git add worker
git commit -m "Worker: shared section spans and the segmentation preview grid"
```

---

### Task 3: Worker: claim project jobs and run `segment`

**Files:**
- Modify: `worker/src/ingest_worker/queue.py`, `worker/src/ingest_worker/main.py`, `worker/src/ingest_worker/workbench.py`, `worker/tests/fakes.py`
- Test: `worker/tests/test_workbench_segment.py`, `worker/tests/test_queue_integration.py`

**Interfaces:**
- Consumes: `segment_samples`, `SegmentDocument`, `segmentation_key` (Task 2); `prepared_text_key` (phase 1); migration 0009.
- Produces:
  - `ClaimedJob` gains `project_id: str | None = None` and `params: dict[str, Any] | None = None`, placed after `claimed_at`. For a document-less job, the claim fills `document_id`, `bucket` and `object_key` with `""`, `spec_id` with the project id, and `spec_version` with `0`.
  - `workbench.SegmentParams` (pydantic): `samples: list[SegmentSample]` (each `sampleId` alias `sample_id`, `sha256`), `document: SegmentDocument`.
  - `workbench.run_segment(job: ClaimedJob, deps: PipelineDeps) -> dict[str, Any]`. Reads each sample's prepared text, builds the grid, writes it to `segmentation_key(job.project_id, job.id)`, and returns it. Invalid params raise `DocumentError`.
  - `run_once` handles `job.task == "segment"`: `run_segment`, then `queue.complete(job, [], outputs bucket)`.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_workbench_segment.py`:

```python
import hashlib
import json
from pathlib import Path

from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, prepared_text_key, segmentation_key

from .fakes import FakeQueue


def segment_job(params: dict[str, Any]) -> ClaimedJob:
    return ClaimedJob(
        id="job-seg",
        document_id="",
        spec_id="letter",
        spec_version=0,
        bucket="",
        object_key="",
        model_override=None,
        attempts=1,
        max_attempts=1,
        task="segment",
        test=True,
        project_id="letter",
        params=params,
    )


def deps_with(store: MemoryObjectStore, specs_dir: Path) -> PipelineDeps:
    return PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
    )


def put_prepared(store: MemoryObjectStore, sha: str, pages: list[str]) -> None:
    text = {"sha256": sha, "pages": [{"number": i + 1, "text": t, "ocr": False} for i, t in enumerate(pages)]}
    store.put("runs", prepared_text_key(sha), json.dumps(text).encode(), "application/json")


def test_segment_job_writes_the_grid_and_completes(fixture_specs_dir: Path) -> None:
    store = MemoryObjectStore()
    sha = hashlib.sha256(b"a").hexdigest()
    put_prepared(store, sha, PAGES)
    params = {
        "samples": [{"sampleId": "s1", "sha256": sha}, {"sampleId": "s2", "sha256": "missing"}],
        "document": {"sections": [{"id": "purpose", "anchor": r"^\d+\.0 PURPOSE"}]},
    }
    queue = FakeQueue(jobs=[segment_job(params)])

    assert run_once(queue, deps_with(store, fixture_specs_dir), "w1") is True

    assert queue.completed == [("job-seg", [])]
    grid = json.loads(store.get("runs", segmentation_key("letter", "job-seg")))
    assert grid["samples"][0]["sections"][0]["page"] == 2
    assert grid["samples"][1]["error"] == "not prepared"


def test_segment_job_with_bad_params_needs_review(fixture_specs_dir: Path) -> None:
    queue = FakeQueue(jobs=[segment_job({"samples": [], "document": {"sections": []}})])
    run_once(queue, deps_with(MemoryObjectStore(), fixture_specs_dir), "w1")
    [(_, reason)] = queue.reviewed
    assert "segment parameters" in reason
```

Append to `worker/tests/test_queue_integration.py`:

```python
def test_a_document_less_project_job_is_claimed_with_its_params(
    queue_with_queued_job: tuple[PgJobQueue, str],
) -> None:
    q, production_job = queue_with_queued_job
    # Push the fixture's production job back so the segment job is next.
    q._conn.execute("UPDATE jobs SET run_after = now() + interval '1 day' WHERE id = %s", (production_job,))
    project = f"p{uuid.uuid4().hex[:8]}"
    q._conn.execute("INSERT INTO workbench_projects (id, name) VALUES (%s, 'P')", (project,))
    job_id = str(uuid.uuid4())
    q._conn.execute(
        """INSERT INTO jobs (id, project_id, task, test, priority, max_attempts, params)
           VALUES (%s, %s, 'segment', true, -5, 1, %s)""",
        (job_id, project, json.dumps({"samples": [], "document": {"sections": []}})),
    )
    try:
        claimed = q.claim("w1")
        assert claimed is not None and claimed.id == job_id
        assert claimed.task == "segment" and claimed.document_id == ""
        assert claimed.project_id == project and claimed.params == {"samples": [], "document": {"sections": []}}
    finally:
        q._conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))
        q._conn.execute("DELETE FROM workbench_projects WHERE id = %s", (project,))
```

Add `import json` to that file's imports if it is not already there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_workbench_segment.py -q`
Expected: FAIL with `TypeError: ClaimedJob.__init__() got an unexpected keyword argument 'project_id'`.

- [ ] **Step 3: Claim document-less jobs**

In `worker/src/ingest_worker/queue.py`, add to `ClaimedJob` after `claimed_at`:

```python
    #: Workbench project of a project-scoped job (prepare, test runs, segment).
    project_id: str | None = None
    #: Task parameters (segment: samples + candidate document block).
    params: dict[str, Any] | None = None
```

Update the `task` comment to include `"segment" (workbench anchor preview; no document)`. Replace the final `SELECT` of `CLAIM_SQL`:

```python
SELECT c.id::text, COALESCE(c.document_id::text, ''), COALESCE(d.spec_id, c.project_id, ''),
       COALESCE(d.spec_version, 0), COALESCE(d.bucket, ''), COALESCE(d.object_key, ''),
       c.model_override, c.attempts, c.max_attempts, c.task, c.test, c.rerun, c.locked_at,
       c.project_id, c.params
  FROM claimed c LEFT JOIN documents d ON d.id = c.document_id
```

Add a comment above `CLAIM_SQL`: `# Project-scoped jobs (task segment) have no document: its columns come back as ''/0.`

- [ ] **Step 4: Run the segment task**

Add to `worker/src/ingest_worker/workbench.py`:

```python
from pydantic import ValidationError

from .queue import ClaimedJob
from .storage import segmentation_key


class SegmentSample(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    sample_id: str = Field(alias="sampleId")
    sha256: str


class SegmentParams(BaseModel):
    """jobs.params of a segment job (written by the API)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    samples: list[SegmentSample]
    document: SegmentDocument


def _prepared_pages(deps: PipelineDeps, sha256: str) -> list[str] | None:
    raw = deps.store.get_optional(deps.buckets.runs, prepared_text_key(sha256))
    if raw is None:
        return None
    pages: list[dict[str, Any]] = json.loads(raw)["pages"]
    return [str(p["text"]) for p in pages]


def run_segment(job: ClaimedJob, deps: PipelineDeps) -> dict[str, Any]:
    """Apply the job's candidate anchors to every listed sample; write and return the grid."""
    try:
        params = SegmentParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid segment parameters: {exc}") from exc
    if job.project_id is None:
        raise DocumentError("segment job without a project")
    grid = segment_samples(
        [(s.sample_id, _prepared_pages(deps, s.sha256)) for s in params.samples], params.document
    )
    deps.store.put(
        deps.buckets.runs,
        segmentation_key(job.project_id, job.id),
        json.dumps(grid).encode(),
        "application/json",
    )
    return grid
```

Add `prepared_text_key` to the existing storage import if it is not there.

In `worker/src/ingest_worker/main.py`, import `run_segment` from `.workbench` and add the branch after the `prepare` one:

```python
        if job.task == "segment":
            grid = run_segment(job, deps)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s segmented %d samples", job.id, len(grid["samples"]))
            return True
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && uv run pytest -q`
Expected: PASS (all unit tests; integration tests deselected).

With a **throwaway** Postgres at migration 0009 (`DATABASE_URL` set):
Run: `cd worker && uv run pytest -m integration tests/test_queue_integration.py -q`
Expected: PASS. If no throwaway database is available, record that in the PR description. Never point it at a database with real jobs: the `queue_with_queued_job` fixture defers every queued job by a day.

- [ ] **Step 6: Lint and commit**

Run: `cd worker && uv run ruff check . && uv run ruff format --check . && uv run mypy`

```bash
git add worker
git commit -m "Worker: claim document-less project jobs and run segment previews"
```

---

### Task 4: Worker: wake on NOTIFY instead of polling

**Files:**
- Modify: `worker/src/ingest_worker/queue.py`, `worker/src/ingest_worker/main.py`, `worker/tests/fakes.py`
- Test: `worker/tests/test_queue.py`, `worker/tests/test_queue_integration.py`

**Interfaces:**
- Consumes: the `jobs_notify_queued` trigger (channel `ih_jobs`) from migration 0009.
- Produces:
  - `JobQueue.wait_for_work(timeout_s: float) -> None`. It blocks until a job is queued or `timeout_s` passes.
  - `FakeQueue.wait_for_work` records each timeout in `waits: list[float]` and returns immediately.
  - `main.idle(queue: JobQueue, stop: threading.Event, timeout_s: float) -> None` is the idle step of the main loop.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_queue.py`:

```python
import threading

from ingest_worker.main import idle

from .fakes import FakeQueue


def test_idle_waits_for_work_with_the_poll_interval() -> None:
    queue = FakeQueue()
    idle(queue, threading.Event(), 2.0)
    assert queue.waits == [2.0]


def test_idle_does_not_wait_once_stopping() -> None:
    queue = FakeQueue()
    stop = threading.Event()
    stop.set()
    idle(queue, stop, 2.0)
    assert queue.waits == []
```

Append to `worker/tests/test_queue_integration.py`:

```python
def test_wait_for_work_returns_as_soon_as_a_job_is_queued() -> None:
    import time

    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL not set")
    listener, writer = PgJobQueue(url), PgJobQueue(url)
    doc = str(uuid.uuid4())
    try:
        listener.wait_for_work(0.01)  # starts LISTEN
        writer._conn.execute(
            """INSERT INTO documents (id, filename, sha256, size_bytes, spec_id, spec_version,
                                      bucket, object_key)
               VALUES (%s, 'n.pdf', 'z', 1, 'demo', 1, 'inbox', %s)""",
            (doc, f"demo/v1/{doc}.pdf"),
        )
        writer._conn.execute(
            "INSERT INTO jobs (document_id, run_after) VALUES (%s, now() + interval '1 day')", (doc,)
        )
        started = time.monotonic()
        listener.wait_for_work(10.0)
        assert time.monotonic() - started < 2.0
    finally:
        writer._conn.execute("DELETE FROM documents WHERE id = %s", (doc,))
        listener.close()
        writer.close()
```

(The job is queued with `run_after` tomorrow, so no other worker claims it. Its insert still fires the NOTIFY.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_queue.py -q`
Expected: FAIL with `ImportError: cannot import name 'idle'`.

- [ ] **Step 3: Implement**

In `worker/src/ingest_worker/queue.py`, add to the `JobQueue` protocol:

```python
    def wait_for_work(self, timeout_s: float) -> None:
        """Block until a job is queued (NOTIFY ih_jobs) or `timeout_s` passes."""
        ...
```

In `PgJobQueue.__init__` add `self._listening = False`, and add the method:

```python
    def wait_for_work(self, timeout_s: float) -> None:
        if not self._listening:
            self._conn.execute("LISTEN ih_jobs")
            self._listening = True
        for _ in self._conn.notifies(timeout=timeout_s, stop_after=1):
            pass
```

Update the module docstring with: `Idle workers LISTEN on ih_jobs (trigger jobs_notify_queued, migration 0009) and wake as soon as a job is queued; the poll interval is only a fallback.`

In `worker/tests/fakes.py`, add the field `waits: list[float] = field(default_factory=list)` to `FakeQueue` and the method:

```python
    def wait_for_work(self, timeout_s: float) -> None:
        self.waits.append(timeout_s)
```

In `worker/src/ingest_worker/main.py`, add:

```python
def idle(queue: JobQueue, stop: threading.Event, timeout_s: float) -> None:
    """Nothing to claim: wait for a NOTIFY (or the poll interval), unless shutting down."""
    if not stop.is_set():
        queue.wait_for_work(timeout_s)
```

In `main()`, replace `stop.wait(settings.poll_interval_s)` with `idle(queue, stop, settings.poll_interval_s)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && uv run pytest -q`, then the integration file against a throwaway database as in Task 3 Step 5.
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `cd worker && uv run ruff check . && uv run ruff format --check . && uv run mypy`

```bash
git add worker
git commit -m "Worker: wake on NOTIFY ih_jobs instead of sleeping the poll interval"
```

---

### Task 5: API repo: segment jobs

**Files:**
- Modify: `apps/api/src/repositories/types.ts`, `apps/api/src/repositories/memory.ts`, `apps/api/src/repositories/pg.ts`
- Test: `apps/api/test/workbench-segment-repo.test.ts` (new)

**Interfaces:**
- Consumes: migration 0009; `SegmentDocument` (Task 1).
- Produces (in `types.ts`):
  - `export const SEGMENT_PRIORITY = -5;`
  - `export interface SegmentJob { id: string; projectId: string; status: JobStatus; error: string | null; createdAt: string; updatedAt: string }`
  - `export interface SegmentJobParams { samples: { sampleId: string; sha256: string }[]; document: SegmentDocument }`
  - `IngestionRepo.createSegmentJob(projectId: string, params: SegmentJobParams): Promise<{ job: SegmentJob; removed: string[] }>`. It deletes the project's earlier segment jobs (any status), returns their ids in `removed`, and inserts a queued job with `task 'segment'`, no document, `test true`, `priority SEGMENT_PRIORITY`, `max_attempts 1` and `params`.
  - `IngestionRepo.getSegmentJob(projectId: string, id: string): Promise<SegmentJob | null>`
  - `MemoryRepo.segmentJobs: Map<string, SegmentJob & { params: SegmentJobParams }>`. Segment jobs never enter `MemoryRepo.jobs`, so no `JobSummary` path can see them.
  - `finishedJobIdsBefore` never returns document-less jobs.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-segment-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SEGMENT_PRIORITY, type SegmentJobParams } from '../src/repositories/types.js';
import { testApp } from './helpers.js';

const params: SegmentJobParams = {
  samples: [{ sampleId: 's1', sha256: 'abc' }],
  document: { sections: [{ id: 'all', anchor: '\\A', required: true }], pageMarkers: true },
};

describe('segment jobs', () => {
  it('queues one preview per project, replacing the earlier ones', async () => {
    const { repo } = await testApp();
    const first = await repo.createSegmentJob('letter', params);
    expect(first.removed).toEqual([]);
    expect(first.job).toMatchObject({ projectId: 'letter', status: 'queued', error: null });
    const other = await repo.createSegmentJob('memo', params);
    const second = await repo.createSegmentJob('letter', params);
    expect(second.removed).toEqual([first.job.id]);
    expect(await repo.getSegmentJob('letter', first.job.id)).toBeNull();
    expect(await repo.getSegmentJob('letter', second.job.id)).toMatchObject({ status: 'queued' });
    expect(await repo.getSegmentJob('memo', other.job.id)).not.toBeNull();
    expect(await repo.getSegmentJob('letter', other.job.id)).toBeNull(); // scoped by project
    expect(repo.segmentJobs.get(second.job.id)?.params).toEqual(params);
  });

  it('keeps segment jobs out of every job listing', async () => {
    const { app, repo } = await testApp();
    const { job } = await repo.createSegmentJob('letter', params);
    repo.segmentJobs.set(job.id, { ...repo.segmentJobs.get(job.id)!, status: 'succeeded' });
    expect((await app.inject('/api/jobs')).json()).toEqual([]);
    expect(await repo.listProjectJobs('letter')).toEqual([]);
    expect(await repo.finishedJobIdsBefore('2999-01-01T00:00:00.000Z', true)).toEqual([]);
    expect(await repo.getJob(job.id)).toBeNull();
  });

  it('documents the priority between production and other workbench work', () => {
    expect(SEGMENT_PRIORITY).toBe(-5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-segment-repo.test.ts`
Expected: FAIL. `SEGMENT_PRIORITY` is not exported and `repo.createSegmentJob` is not a function.

- [ ] **Step 3: Extend the port**

In `apps/api/src/repositories/types.ts` (import `SegmentDocument` and `JobStatus` types from `@ih/shared`):

```ts
/** Segment previews run before other workbench work, still after production (ADR 0007). */
export const SEGMENT_PRIORITY = -5;

export interface SegmentJob {
  id: string;
  projectId: string;
  status: JobStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** jobs.params of a segment job (worker: workbench.SegmentParams). */
export interface SegmentJobParams {
  samples: { sampleId: string; sha256: string }[];
  document: SegmentDocument;
}
```

and in `IngestionRepo`:

```ts
  /**
   * Queue a segmentation preview for a project (no document). Earlier segment jobs of the project
   * are deleted first (only the latest preview matters); their ids are returned in `removed`.
   */
  createSegmentJob(
    projectId: string,
    params: SegmentJobParams,
  ): Promise<{ job: SegmentJob; removed: string[] }>;
  getSegmentJob(projectId: string, id: string): Promise<SegmentJob | null>;
```

- [ ] **Step 4: Implement in `MemoryRepo`**

```ts
  /** Segment jobs (document-less, ADR 0007): kept apart so no JobSummary path sees them. */
  readonly segmentJobs = new Map<string, SegmentJob & { params: SegmentJobParams }>();

  async createSegmentJob(projectId: string, params: SegmentJobParams) {
    const removed = [...this.segmentJobs.values()]
      .filter((j) => j.projectId === projectId)
      .map((j) => j.id);
    for (const id of removed) this.segmentJobs.delete(id);
    const now = new Date().toISOString();
    const job: SegmentJob = {
      id: randomUUID(),
      projectId,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.segmentJobs.set(job.id, { ...job, params });
    return { job, removed };
  }

  async getSegmentJob(projectId: string, id: string) {
    const stored = this.segmentJobs.get(id);
    if (stored?.projectId !== projectId) return null;
    const { params: _params, ...job } = stored;
    return job;
  }
```

Import `SegmentJob` and `SegmentJobParams` types from `./types.js`. If lint rejects the unused `_params`, destructure with a different approach: build the `SegmentJob` object field by field.

- [ ] **Step 5: Implement in `PgRepo`**

```ts
  async createSegmentJob(projectId: string, params: SegmentJobParams) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Deleting a running job is safe: its worker finds the claim gone and writes nothing.
      const removed = await client.query<{ id: string }>(
        `DELETE FROM jobs WHERE project_id = $1 AND task = 'segment' RETURNING id`,
        [projectId],
      );
      const { rows } = await client.query<SegmentRow>(
        `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params)
         VALUES ($1, 'segment', true, $2, 1, $3)
         RETURNING id, project_id, status, error, created_at, updated_at`,
        [projectId, SEGMENT_PRIORITY, JSON.stringify(params)],
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

  async getSegmentJob(projectId: string, id: string) {
    const { rows } = await this.pool.query<SegmentRow>(
      `SELECT id, project_id, status, error, created_at, updated_at FROM jobs
        WHERE id = $1 AND project_id = $2 AND task = 'segment'`,
      [id, projectId],
    );
    return rows[0] ? toSegmentJob(rows[0]) : null;
  }
```

with, at module level:

```ts
interface SegmentRow {
  id: string;
  project_id: string;
  status: JobStatus;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

const toSegmentJob = (r: SegmentRow): SegmentJob => ({
  id: r.id,
  projectId: r.project_id,
  status: r.status,
  error: r.error,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
```

In `finishedJobIdsBefore` add `AND document_id IS NOT NULL` to the `WHERE`. Every `JOB_SELECT`-based query already inner-joins `documents`, so document-less jobs never become `JobSummary`s. Add that sentence as a comment above `JOB_SELECT`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/repositories apps/api/test/workbench-segment-repo.test.ts
git commit -m "API: segment jobs (document-less, one preview per project)"
```

---

### Task 6: API routes: start and read a segmentation

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`
- Test: `apps/api/test/workbench-segment.test.ts` (new)

**Interfaces:**
- Consumes: `createSegmentJob`/`getSegmentJob` (Task 5); `sampleViews`, `versionsOf` (phase 1); `SegmentDocumentSchema`, `SegmentationResultSchema`, `segmentationKey`, `SegmentationView` (Task 1).
- Produces:
  - `POST /api/workbench/projects/:id/segmentations` with body `{ document?: SegmentDocument }`. When `document` is omitted, the open draft's (else the latest version's) `document` block is used. It returns 202 `SegmentationView` (status `queued`, result null). It returns 404 for an unknown project, 400 for an invalid document (`{ error, issues }`), and 409 when no sample is prepared.
  - The samples sent to the worker are all **ready** samples, dev and holdout alike, oldest first. Holdout text is shown to the user (ADR 0007); only drafting excludes it.
  - `GET /api/workbench/projects/:id/segmentations/:jobId` returns `SegmentationView`. `result` is set when the status is `succeeded` and the stored grid parses. It returns 404 for an unknown project, job, or malformed job id.
  - Starting a preview deletes the result objects of the removed earlier jobs (best effort).

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-segment.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { preparedTriageKey, segmentationKey, type SampleView } from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);
const doc = { sections: [{ id: 'all', anchor: '\\A' }] };

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, letter(1));
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
  const start = (payload: object = {}) =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/segmentations', payload });
  return { ...ctx, add, start };
}

describe('workbench segmentation', () => {
  it('queues a preview of the draft anchors over every prepared sample', async () => {
    const { repo, add, start } = await project();
    const dev = await add(1);
    const holdout = await add(2, 'holdout');
    await add(3, 'dev', false);
    const res = await start();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'queued', error: null, result: null });
    const stored = repo.segmentJobs.get(res.json().jobId)!;
    expect(stored.params.samples).toEqual([
      { sampleId: dev.id, sha256: dev.sha256 },
      { sampleId: holdout.id, sha256: holdout.sha256 },
    ]);
    expect(stored.params.document.sections).toEqual(letter(1).document.sections.map((s) => ({ ...s, required: true })));
  });

  it('previews candidate anchors and validates them', async () => {
    const { repo, add, start } = await project();
    await add(1);
    const res = await start({ document: doc });
    expect(repo.segmentJobs.get(res.json().jobId)!.params.document).toEqual({
      sections: [{ id: 'all', anchor: '\\A', required: true }],
      pageMarkers: true,
    });
    expect((await start({ document: { sections: [] } })).statusCode).toBe(400);
  });

  it('refuses without prepared samples, and for unknown projects', async () => {
    const { app, add, start } = await project();
    await add(1, 'dev', false);
    expect((await start()).statusCode).toBe(409);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/nope/segmentations',
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('returns the grid once the worker has written it, and drops replaced previews', async () => {
    const { app, repo, store, add, start } = await project();
    const sample = await add(1);
    const first = (await start({ document: doc })).json().jobId as string;
    const grid = {
      anchorErrors: {},
      samples: [
        {
          sampleId: sample.id,
          firstPage: 1,
          pageCount: 1,
          error: null,
          missingRequired: [],
          sections: [{ id: 'all', found: true, page: 1, line: 'HEADER', chars: 10 }],
        },
      ],
    };
    repo.segmentJobs.set(first, { ...repo.segmentJobs.get(first)!, status: 'succeeded' });
    await store.put('runs', segmentationKey('letter', first), Buffer.from(JSON.stringify(grid)), 'application/json');
    const url = (id: string) => `/api/workbench/projects/letter/segmentations/${id}`;
    expect((await app.inject(url(first))).json()).toEqual({
      jobId: first,
      status: 'succeeded',
      error: null,
      result: grid,
    });

    const second = (await start({ document: doc })).json().jobId as string;
    expect((await app.inject(url(first))).statusCode).toBe(404);
    expect(await store.get('runs', segmentationKey('letter', first))).toBeNull();
    expect((await app.inject(url(second))).json()).toMatchObject({ status: 'queued', result: null });
    expect((await app.inject(url('not-a-uuid'))).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-segment.test.ts`
Expected: FAIL with 404 on `POST …/segmentations`.

- [ ] **Step 3: Add the routes**

In `apps/api/src/routes/workbench.ts` add `SegmentDocumentSchema`, `SegmentationResultSchema`, `segmentationKey` and the `SegmentationView` type to the `@ih/shared` import, and `type SegmentJob` from `../repositories/types.js`. Add the module-level helpers:

```ts
const StartSegmentation = z.object({ document: z.unknown().optional() }).strict();
const SegmentationParams = z.object({ id: Id, jobId: z.string().uuid() });

function segmentationView(job: SegmentJob, result: SegmentationView['result']): SegmentationView {
  return { jobId: job.id, status: job.status, error: job.error, result };
}
```

and the routes inside `workbenchRoutes`:

```ts
  /** Preview anchors over every prepared sample (worker task `segment`; ADR 0007). */
  app.post<{ Params: ProjectParams }>(
    '/workbench/projects/:id/segmentations',
    async (req, reply) => {
      const projectId = req.params.id;
      if (!(await workbench.getProject(projectId))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const body = StartSegmentation.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      let candidate = body.data.document;
      if (candidate === undefined) {
        const { draft, latest } = await versionsOf(templates, projectId);
        const record = draft !== null ? await templates.get(projectId, draft) : latest;
        const block = (record?.definition.document ?? {}) as Record<string, unknown>;
        candidate = {
          sections: block.sections,
          ...(block.copies !== undefined ? { copies: block.copies } : {}),
          ...(block.pageMarkers !== undefined ? { pageMarkers: block.pageMarkers } : {}),
        };
      }
      const document = SegmentDocumentSchema.safeParse(candidate);
      if (!document.success) {
        return reply.code(400).send({ error: 'invalid sections', issues: document.error.issues });
      }
      const samples = (await sampleViews(app, projectId))
        .filter((s) => s.view.state === 'ready')
        .map((s) => ({ sampleId: s.record.id, sha256: s.record.sha256 }));
      if (!samples.length) return reply.code(409).send({ error: 'no prepared samples to segment' });
      const { job, removed } = await app.deps.repo.createSegmentJob(projectId, {
        samples,
        document: document.data,
      });
      await Promise.all(
        removed.map((id) =>
          app.deps.store
            .delete(app.deps.buckets.runs, segmentationKey(projectId, id))
            .catch((err: unknown) => req.log.warn({ err, id }, 'old segmentation not deleted')),
        ),
      );
      return reply.code(202).send(segmentationView(job, null));
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    '/workbench/projects/:id/segmentations/:jobId',
    async (req, reply) => {
      const params = SegmentationParams.safeParse(req.params);
      const job = params.success
        ? await app.deps.repo.getSegmentJob(params.data.id, params.data.jobId)
        : null;
      if (!job) return reply.code(404).send({ error: 'segmentation not found' });
      if (job.status !== 'succeeded') return segmentationView(job, null);
      const raw = await readJson(app, segmentationKey(job.projectId, job.id));
      if (raw === null) return { ...segmentationView(job, null), error: 'result missing' };
      return segmentationView(job, SegmentationResultSchema.parse(raw));
    },
  );
```

(`readJson` already exists in this file from phase 1. The memory store's `delete` of a missing key is a no-op.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`
Expected: PASS. The `access.test.ts` sweep covers the two new routes.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: start and read workbench segmentation previews"
```

---

### Task 7: Web client, fakes and the Sections tab route

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/src/router.ts`
- Test: `apps/web/test/client.test.ts`, `apps/web/test/router.test.ts`

**Interfaces:**
- Consumes: the routes from Task 6.
- Produces:
  - `Api.startSegmentation(projectId: string, document?: SegmentDocument): Promise<SegmentationView>` (POST; the body is `{ document }` when given, else `{}`).
  - `Api.getSegmentation(projectId: string, jobId: string): Promise<SegmentationView>`.
  - `PROJECT_TABS` becomes `['samples', 'brief', 'sections', 'template', 'runs']`, and `#/workbench/<id>/sections` parses to that tab.
  - fake-api adds default `startSegmentation` (throws "not stubbed") and `getSegmentation` (throws), plus a fixture builder `segmentationView(overrides?)`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/router.test.ts` add the row:

```ts
    ['#/workbench/letter/sections', { name: 'project', projectId: 'letter', tab: 'sections' }],
```

Append to `apps/web/test/client.test.ts`:

```ts
describe('http api: segmentation', () => {
  it('posts candidate anchors and reads a preview', async () => {
    const fetchMock = vi.fn(async () => respond(202, { jobId: 'j1', status: 'queued', error: null, result: null }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    const document = { sections: [{ id: 'all', anchor: '\\A', required: true }], pageMarkers: true };
    await api.startSegmentation('letter', document);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/workbench/projects/letter/segmentations');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ document });
    await api.getSegmentation('letter', 'j1');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/workbench/projects/letter/segmentations/j1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/router.test.ts apps/web/test/client.test.ts`
Expected: FAIL. `sections` parses as `samples`, and `startSegmentation` is missing.

- [ ] **Step 3: Implement**

`apps/web/src/router.ts`: `export const PROJECT_TABS = ['samples', 'brief', 'sections', 'template', 'runs'] as const;`

`apps/web/src/api/client.ts`: import `SegmentDocument` and `SegmentationView` types from `@ih/shared`. Add to `Api` (after `listTestRuns`):

```ts
  /** Preview anchors over the prepared samples; omit `document` to use the draft's. */
  startSegmentation(projectId: string, document?: SegmentDocument): Promise<SegmentationView>;
  getSegmentation(projectId: string, jobId: string): Promise<SegmentationView>;
```

and to `createHttpApi`:

```ts
    startSegmentation: (id, document) =>
      post<SegmentationView>(
        `${base}/workbench/projects/${id}/segmentations`,
        document ? { document } : {},
      ),
    getSegmentation: (id, jobId) =>
      apiFetch(`${base}/workbench/projects/${id}/segmentations/${jobId}`).then(
        json<SegmentationView>,
      ),
```

`apps/web/test/fake-api.ts`: add the defaults to `fakeApi`:

```ts
    startSegmentation: vi.fn(async () => {
      throw new Error('startSegmentation not stubbed');
    }),
    getSegmentation: vi.fn(async () => {
      throw new Error('getSegmentation not stubbed');
    }),
```

and a builder at the bottom (import the `SegmentationView` type):

```ts
export function segmentationView(overrides: Partial<SegmentationView> = {}): SegmentationView {
  return { jobId: 'seg-1', status: 'succeeded', error: null, result: null, ...overrides };
}
```

`ProjectPage.tsx` has `TAB_LABEL: Record<ProjectTab, string>`, so the typecheck now demands a `sections` entry. Add `sections: 'Sections',` there; Task 9 renders the tab body.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: segmentation API client and the Sections tab route"
```

---

### Task 8: Web: grid helpers and the segmentation grid

**Files:**
- Create: `apps/web/src/workbench/segmentation.ts`, `apps/web/src/workbench/SegmentationGrid.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/test/segmentation.test.ts`, `apps/web/test/SegmentationGrid.test.tsx` (new)

**Interfaces:**
- Consumes: `SegmentationResult`, `SegmentedSample`, `SectionCell`, `SampleView`.
- Produces:
  - `segmentation.ts`:
    - `LARGE_SHARE = 0.6`.
    - `type CellFlag = 'missing-required' | 'missing' | 'empty' | 'large' | null`.
    - `cellFlag(cell: SectionCell, required: boolean, sample: SegmentedSample, sectionCount: number): CellFlag`.
    - `sectionHits(result: SegmentationResult, sectionId: string): { hits: number; of: number }`, counting only samples without an error.
  - `SegmentationGrid({ result, sections, samples, onOpen })`:
    - `sections: { id: string; required: boolean }[]`; `samples: SampleView[]`, used for file names and roles; `onOpen(sampleId: string, sectionId: string)`.
    - Renders `table` "Section anchors". There is one row per sample, and the header cell for each section shows `hits/of`.
    - Each cell is a button labelled `${filename} · ${sectionId}` that shows `p.N · chars` or the flag text.
    - Anchor errors are listed above the table (`role="alert"`, one item per id).

- [ ] **Step 1: Write the failing tests**

`apps/web/test/segmentation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SectionCell, SegmentedSample } from '@ih/shared';
import { cellFlag, sectionHits } from '../src/workbench/segmentation.js';

const cell = (o: Partial<SectionCell> = {}): SectionCell => ({
  id: 'a',
  found: true,
  page: 1,
  line: 'A',
  chars: 100,
  ...o,
});
const sample = (sections: SectionCell[], o: Partial<SegmentedSample> = {}): SegmentedSample => ({
  sampleId: 's',
  firstPage: 1,
  pageCount: 1,
  error: null,
  missingRequired: [],
  sections,
  ...o,
});

describe('cellFlag', () => {
  it.each([
    ['required and not found', cell({ found: false, chars: 0, page: null, line: null }), true, 'missing-required'],
    ['optional and not found', cell({ found: false, chars: 0, page: null, line: null }), false, 'missing'],
    ['found but empty', cell({ chars: 0 }), true, 'empty'],
    ['normal size', cell({ chars: 100 }), true, null],
  ])('%s', (_name, c, required, flag) => {
    const s = sample([c, cell({ id: 'b', chars: 100 })]);
    expect(cellFlag(c, required, s, 2)).toBe(flag);
  });

  it('flags a section holding most of the document when there are several sections', () => {
    const big = cell({ id: 'a', chars: 700 });
    const s = sample([big, cell({ id: 'b', chars: 300 })]);
    expect(cellFlag(big, true, s, 2)).toBe('large');
    expect(cellFlag(big, true, sample([big]), 1)).toBeNull(); // a single catch-all is fine
  });
});

describe('sectionHits', () => {
  it('counts samples where the anchor matched, ignoring unprepared samples', () => {
    const result = {
      anchorErrors: {},
      samples: [
        sample([cell({ id: 'a' })], { sampleId: '1' }),
        sample([cell({ id: 'a', found: false, chars: 0, page: null, line: null })], { sampleId: '2' }),
        sample([], { sampleId: '3', error: 'not prepared' }),
      ],
    };
    expect(sectionHits(result, 'a')).toEqual({ hits: 1, of: 2 });
  });
});
```

`apps/web/test/SegmentationGrid.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SegmentationResult } from '@ih/shared';
import { SegmentationGrid } from '../src/workbench/SegmentationGrid.js';
import { sampleView } from './fake-api.js';

const a = sampleView({ id: 's1', filename: 'a.pdf' });
const b = sampleView({ id: 's2', filename: 'b.pdf', role: 'holdout' });
const result: SegmentationResult = {
  anchorErrors: { totals: 'missing ), unterminated subpattern at position 0' },
  samples: [
    {
      sampleId: 's1',
      firstPage: 1,
      pageCount: 3,
      error: null,
      missingRequired: ['totals'],
      sections: [
        { id: 'header', found: true, page: 1, line: 'INVOICE 42', chars: 120 },
        { id: 'totals', found: false, page: null, line: null, chars: 0 },
      ],
    },
    { sampleId: 's2', firstPage: 1, pageCount: 0, error: 'not prepared', missingRequired: [], sections: [] },
  ],
};
const sections = [
  { id: 'header', required: true },
  { id: 'totals', required: true },
];

describe('SegmentationGrid', () => {
  it('shows each sample × section with page and size, hits per section, and anchor errors', () => {
    render(<SegmentationGrid result={result} sections={sections} samples={[a, b]} onOpen={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('totals: missing ), unterminated subpattern');
    const table = screen.getByRole('table', { name: 'Section anchors' });
    expect(within(table).getByRole('columnheader', { name: /header 1\/1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'a.pdf · header' })).toHaveTextContent('p.1 · 120');
    expect(screen.getByRole('button', { name: 'a.pdf · totals' })).toHaveTextContent('missing');
    expect(within(table).getByRole('row', { name: /b\.pdf/ })).toHaveTextContent('not prepared');
    expect(within(table).getByRole('row', { name: /b\.pdf/ })).toHaveTextContent('holdout');
  });

  it('opens a cell', async () => {
    const onOpen = vi.fn();
    render(<SegmentationGrid result={result} sections={sections} samples={[a, b]} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'a.pdf · header' }));
    expect(onOpen).toHaveBeenCalledWith('s1', 'header');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/segmentation.test.ts apps/web/test/SegmentationGrid.test.tsx`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write the helpers**

`apps/web/src/workbench/segmentation.ts`:

```ts
import type { SectionCell, SegmentationResult, SegmentedSample } from '@ih/shared';

/** A section holding more than this share of a sample's text probably swallowed its neighbours. */
export const LARGE_SHARE = 0.6;

export type CellFlag = 'missing-required' | 'missing' | 'empty' | 'large' | null;

/** What deserves attention in one sample × section cell of the preview grid. */
export function cellFlag(
  cell: SectionCell,
  required: boolean,
  sample: SegmentedSample,
  sectionCount: number,
): CellFlag {
  if (!cell.found) return required ? 'missing-required' : 'missing';
  if (cell.chars === 0) return 'empty';
  const total = sample.sections.reduce((sum, c) => sum + c.chars, 0);
  if (sectionCount > 1 && total > 0 && cell.chars / total > LARGE_SHARE) return 'large';
  return null;
}

/** In how many segmented samples (no error) the section's anchor matched. */
export function sectionHits(
  result: SegmentationResult,
  sectionId: string,
): { hits: number; of: number } {
  const segmented = result.samples.filter((s) => s.error === null);
  const hits = segmented.filter((s) => s.sections.some((c) => c.id === sectionId && c.found));
  return { hits: hits.length, of: segmented.length };
}
```

- [ ] **Step 4: Write the grid**

`apps/web/src/workbench/SegmentationGrid.tsx`:

```tsx
import type { SampleView, SegmentationResult } from '@ih/shared';
import { cellFlag, sectionHits, type CellFlag } from './segmentation.js';

const FLAG_TEXT: Record<Exclude<CellFlag, null>, string> = {
  'missing-required': 'missing (required)',
  missing: 'missing',
  empty: 'empty',
  large: 'very large',
};

/** Samples × sections: where each anchor lands (page · characters), with problems flagged. */
export function SegmentationGrid({
  result,
  sections,
  samples,
  onOpen,
}: {
  result: SegmentationResult;
  sections: { id: string; required: boolean }[];
  samples: SampleView[];
  onOpen: (sampleId: string, sectionId: string) => void;
}) {
  const byId = new Map(samples.map((s) => [s.id, s]));
  const errors = Object.entries(result.anchorErrors);
  return (
    <div className="segmentation-grid">
      {errors.length > 0 && (
        <ul role="alert" className="anchor-errors">
          {errors.map(([id, message]) => (
            <li key={id}>
              <code>{id}</code>: {message}
            </li>
          ))}
        </ul>
      )}
      <table aria-label="Section anchors">
        <thead>
          <tr>
            <th>Sample</th>
            {sections.map((s) => {
              const { hits, of } = sectionHits(result, s.id);
              return (
                <th key={s.id} aria-label={`${s.id} ${hits}/${of}`}>
                  <code>{s.id}</code> <small>{`${hits}/${of}`}</small>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {result.samples.map((row) => {
            const view = byId.get(row.sampleId);
            const name = view?.filename ?? row.sampleId;
            return (
              <tr key={row.sampleId} aria-label={name}>
                <th scope="row">
                  {name} <small className="muted">{view?.role}</small>
                </th>
                {row.error !== null ? (
                  <td colSpan={sections.length} className="muted">
                    {row.error}
                  </td>
                ) : (
                  sections.map((s) => {
                    const cell = row.sections.find((c) => c.id === s.id);
                    const flag = cell ? cellFlag(cell, s.required, row, sections.length) : 'missing';
                    return (
                      <td key={s.id} className={flag ? `cell-${flag}` : undefined}>
                        <button
                          type="button"
                          className="link"
                          aria-label={`${name} · ${s.id}`}
                          title={cell?.line ?? undefined}
                          onClick={() => onOpen(row.sampleId, s.id)}
                        >
                          {cell?.found ? `p.${cell.page} · ${cell.chars}` : ''}
                          {flag && <span className="flag"> {FLAG_TEXT[flag]}</span>}
                        </button>
                      </td>
                    );
                  })
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

Append to `apps/web/src/styles.css`, using only tokens from `apps/web/src/styles/tokens.css`:

```css
.segmentation-grid td.cell-missing-required,
.segmentation-grid td.cell-empty {
  background: var(--ih-danger-bg);
  color: var(--ih-danger-fg);
}
.segmentation-grid td.cell-large,
.segmentation-grid td.cell-missing {
  background: var(--ih-info-bg);
  color: var(--ih-info-fg);
}
.segmentation-grid .anchor-errors {
  background: var(--ih-alert-bg);
  color: var(--ih-alert-fg);
  border-radius: var(--ih-radius-md);
  padding: 8px 12px 8px 28px;
}
```

(If the existing stylesheet already has a link-style button class, use it instead of `className="link"`, and say so in the report.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "Web: segmentation grid with hits per section and flagged cells"
```

---

### Task 9: Web: Sections tab (anchor editor, live preview, save to draft)

**Files:**
- Create: `apps/web/src/workbench/useSegmentPreview.ts`, `apps/web/src/workbench/SectionsTab.tsx`
- Modify: `apps/web/src/workbench/SampleText.tsx`, `apps/web/src/workbench/ProjectPage.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/test/useSegmentPreview.test.tsx`, `apps/web/test/SectionsTab.test.tsx` (new), `apps/web/test/SamplesTab.test.tsx` (SampleText marks)

**Interfaces:**
- Consumes: `startSegmentation`, `getSegmentation`, `getTemplate`, `saveTemplate`, `listSamples` (Api); `SegmentationGrid` (Task 8); `SampleText` (phase 1).
- Produces:
  - `useSegmentPreview(api, projectId, pollMs)` returns `{ view: SegmentationView | null; running: boolean; error: string | null; preview(document?: SegmentDocument): void }`.
    - Each `preview()` supersedes the previous one. Responses for superseded previews are ignored.
    - It polls `getSegmentation` every `pollMs` until the status is `succeeded`, `failed`, `needs_review` or `cancelled`. A 404 while polling means the preview was superseded and is ignored.
    - It gives up after 60 polls with error "Preview timed out — is the worker running?".
  - `SampleText` gains an optional `marks?: { page: number; line: string; label: string }[]`. On page `page`, the first line equal to `line` (trimmed) gets a note `role="note"` labelled `${label} starts here` before it.
  - `SectionsTab({ api, projectId, draft, pollMs })`:
    - It loads the draft's `document` block into an editor (rows: id, anchor, required, remove; "Add section"; an optional copies anchor and select).
    - It previews on load and 600 ms after the last edit (`PREVIEW_DEBOUNCE_MS = 600`) and shows the grid.
    - Clicking a cell opens that sample's text with the section starts marked.
    - "Save to draft" writes `sections`, `copies` and existing `pageMarkers` into the draft definition via `saveTemplate`, keeping every other field.
    - With `draft === null` it shows "Start the next version on the Template tab to edit anchors."

- [ ] **Step 1: Write the failing tests**

`apps/web/test/useSegmentPreview.test.tsx`:

```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { useSegmentPreview } from '../src/workbench/useSegmentPreview.js';
import { fakeApi, segmentationView } from './fake-api.js';

const grid = { anchorErrors: {}, samples: [] };

describe('useSegmentPreview', () => {
  it('starts a preview and polls until it finishes', async () => {
    const api = fakeApi({
      startSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', status: 'queued' })),
      getSegmentation: vi
        .fn()
        .mockResolvedValueOnce(segmentationView({ jobId: 'j1', status: 'running' }))
        .mockResolvedValue(segmentationView({ jobId: 'j1', status: 'succeeded', result: grid })),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    await waitFor(() => expect(result.current.view?.status).toBe('succeeded'));
    expect(result.current.running).toBe(false);
    expect(result.current.view?.result).toEqual(grid);
  });

  it('ignores a superseded preview', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    const api = fakeApi({
      startSegmentation: vi
        .fn()
        .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
        .mockResolvedValueOnce(segmentationView({ jobId: 'j2', status: 'queued' })),
      getSegmentation: vi.fn(async (_p: string, jobId: string) => {
        if (jobId === 'j1') throw new ApiError('segmentation not found', 404);
        return segmentationView({ jobId: 'j2', status: 'succeeded', result: grid });
      }),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    act(() => result.current.preview());
    await waitFor(() => expect(result.current.view?.jobId).toBe('j2'));
    await act(async () => resolveFirst(segmentationView({ jobId: 'j1', status: 'queued' })));
    expect(result.current.view?.jobId).toBe('j2');
    expect(result.current.error).toBeNull();
  });

  it('reports a refused preview', async () => {
    const api = fakeApi({
      startSegmentation: vi.fn(async () => {
        throw new ApiError('no prepared samples to segment', 409);
      }),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    await waitFor(() => expect(result.current.error).toBe('no prepared samples to segment'));
  });
});
```

`apps/web/test/SectionsTab.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SectionsTab } from '../src/workbench/SectionsTab.js';
import { fakeApi, sampleView, segmentationView, templateView } from './fake-api.js';

const definition = {
  id: 'letter',
  version: 2,
  name: 'Letter',
  document: { ocr: 'auto', pageMarkers: true, sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [] },
  pipeline: [],
};
const sample = sampleView({ id: 's1', filename: 'a.pdf' });
const grid = {
  anchorErrors: {},
  samples: [
    {
      sampleId: 's1',
      firstPage: 1,
      pageCount: 1,
      error: null,
      missingRequired: [],
      sections: [{ id: 'all', found: true, page: 1, line: 'HEADER', chars: 40 }],
    },
  ],
};

function setup(overrides = {}) {
  const api = fakeApi({
    getTemplate: vi.fn(async () => templateView(definition)),
    saveTemplate: vi.fn(async (_id: string, _v: number, d: Record<string, unknown>) => templateView(d)),
    listSamples: vi.fn(async () => [sample]),
    startSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', status: 'queued' })),
    getSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', result: grid })),
    getSampleText: vi.fn(async () => ({
      sha256: 'abc',
      pages: [{ number: 1, text: 'intro\nHEADER\nbody', ocr: false }],
    })),
    ...overrides,
  });
  render(<SectionsTab api={api} projectId="letter" draft={2} pollMs={1} />);
  return api;
}

describe('SectionsTab', () => {
  it('previews the draft anchors on load', async () => {
    const api = setup();
    expect(await screen.findByRole('button', { name: 'a.pdf · all' })).toHaveTextContent('p.1 · 40');
    expect(api.startSegmentation).toHaveBeenCalledWith('letter', {
      sections: [{ id: 'all', anchor: '\\A', required: true }],
      pageMarkers: true,
    });
  });

  it('previews edited anchors and saves them to the draft', async () => {
    const api = setup();
    await screen.findByRole('button', { name: 'a.pdf · all' });
    await userEvent.click(screen.getByRole('button', { name: 'Add section' }));
    await userEvent.type(screen.getByLabelText('Id of section 2'), 'totals');
    await userEvent.type(screen.getByLabelText('Anchor of section 2'), '^Total');
    await waitFor(() =>
      expect(api.startSegmentation).toHaveBeenLastCalledWith('letter', {
        sections: [
          { id: 'all', anchor: '\\A', required: true },
          { id: 'totals', anchor: '^Total', required: true },
        ],
        pageMarkers: true,
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save to draft' }));
    expect(api.saveTemplate).toHaveBeenCalledWith('letter', 2, {
      ...definition,
      document: {
        ...definition.document,
        sections: [
          { id: 'all', anchor: '\\A', required: true },
          { id: 'totals', anchor: '^Total', required: true },
        ],
      },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Saved to v2');
  });

  it('opens the sample text with the section start marked', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'a.pdf · all' }));
    expect(await screen.findByRole('note', { name: 'all starts here' })).toBeInTheDocument();
  });

  it('asks for a draft when every version is published', () => {
    render(<SectionsTab api={fakeApi()} projectId="letter" draft={null} pollMs={1} />);
    expect(screen.getByText(/Start the next version on the Template tab/)).toBeInTheDocument();
  });
});
```

(`templateView` already exists in `fake-api.ts`. If `saveTemplate`'s fake signature differs, match the `Api` type.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/useSegmentPreview.test.tsx apps/web/test/SectionsTab.test.tsx`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write the preview hook**

`apps/web/src/workbench/useSegmentPreview.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SegmentDocument, SegmentationView } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';

const MAX_POLLS = 60;
const DONE = new Set(['succeeded', 'failed', 'needs_review', 'cancelled']);

/** Latest-wins segmentation preview: start, poll, and ignore anything superseded. */
export function useSegmentPreview(api: Api, projectId: string, pollMs: number) {
  const [view, setView] = useState<SegmentationView | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => () => void (generation.current += 1), []); // stop polling on unmount

  const preview = useCallback(
    (document?: SegmentDocument) => {
      const mine = ++generation.current;
      const current = () => generation.current === mine;
      setRunning(true);
      setError(null);
      void (async () => {
        try {
          let next = await api.startSegmentation(projectId, document);
          for (let poll = 0; current() && !DONE.has(next.status); poll++) {
            if (poll >= MAX_POLLS) throw new Error('Preview timed out — is the worker running?');
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            if (!current()) return;
            next = await api.getSegmentation(projectId, next.jobId);
          }
          if (!current()) return;
          setView(next);
          if (next.status !== 'succeeded') setError(next.error ?? `preview ${next.status}`);
        } catch (err) {
          if (!current()) return;
          if (err instanceof ApiError && err.status === 404) return; // superseded on the server
          setError((err as Error).message);
        } finally {
          if (current()) setRunning(false);
        }
      })();
    },
    [api, projectId, pollMs],
  );

  return { view, running, error, preview };
}
```

- [ ] **Step 4: Add marks to `SampleText`**

In `apps/web/src/workbench/SampleText.tsx`, add the optional prop `marks?: { page: number; line: string; label: string }[]` and render each page's text as lines when that page has marks:

```tsx
function PageBody({ text, marks }: { text: string; marks: { line: string; label: string }[] }) {
  if (!marks.length) return <pre>{text}</pre>;
  const lines = text.split('\n');
  const used = new Set<string>();
  return (
    <pre>
      {lines.map((line, i) => {
        const mark = marks.find((m) => !used.has(m.label) && line.trim() === m.line.trim());
        if (mark) used.add(mark.label);
        return (
          <span key={i}>
            {mark && (
              <span role="note" aria-label={`${mark.label} starts here`} className="section-start">
                {`▶ ${mark.label}\n`}
              </span>
            )}
            {line}
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        );
      })}
    </pre>
  );
}
```

Replace `<pre>{p.text}</pre>` with `<PageBody text={p.text} marks={(marks ?? []).filter((m) => m.page === p.number)} />`.

Add to `apps/web/test/SamplesTab.test.tsx` (or a new `SampleText.test.tsx`):

```tsx
import { SampleText } from '../src/workbench/SampleText.js';

it('marks where a section starts on its page', async () => {
  const api = fakeApi({
    getSampleText: vi.fn(async () => ({
      sha256: 'abc',
      pages: [
        { number: 1, text: 'intro\nTOTALS\n13.00', ocr: false },
        { number: 2, text: 'TOTALS again', ocr: false },
      ],
    })),
  });
  render(
    <SampleText api={api} projectId="letter" sampleId="s1" marks={[{ page: 1, line: 'TOTALS', label: 'totals' }]} />,
  );
  const note = await screen.findByRole('note', { name: 'totals starts here' });
  expect(screen.getByRole('region', { name: 'Page 1' })).toContainElement(note);
  expect(screen.getByRole('region', { name: 'Page 2' })).not.toContainElement(note);
});
```

- [ ] **Step 5: Write `SectionsTab`**

`apps/web/src/workbench/SectionsTab.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { SampleView, SegmentDocument } from '@ih/shared';
import type { Api } from '../api/client.js';
import { SampleText } from './SampleText.js';
import { SegmentationGrid } from './SegmentationGrid.js';
import { useSegmentPreview } from './useSegmentPreview.js';

export const PREVIEW_DEBOUNCE_MS = 600;

type Row = { id: string; anchor: string; required: boolean };
type Copies = { anchor: string; select: 'first' | 'last' } | null;

function candidate(rows: Row[], copies: Copies, pageMarkers: boolean): SegmentDocument {
  return {
    sections: rows.map((r) => ({ id: r.id, anchor: r.anchor, required: r.required })),
    ...(copies && copies.anchor ? { copies } : {}),
    pageMarkers,
  };
}

/** Edit section anchors and see, live, where they land in every prepared sample. */
export function SectionsTab({
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
  const [rows, setRows] = useState<Row[] | null>(null);
  const [copies, setCopies] = useState<Copies>(null);
  const [pageMarkers, setPageMarkers] = useState(true);
  const [saved, setSaved] = useState('');
  const [samples, setSamples] = useState<SampleView[]>([]);
  const [open, setOpen] = useState<{ sampleId: string; sectionId: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { view, running, error: previewError, preview } = useSegmentPreview(api, projectId, pollMs);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (draft === null) return;
    void (async () => {
      try {
        const [{ record }, list] = await Promise.all([
          api.getTemplate(projectId, draft),
          api.listSamples(projectId),
        ]);
        const block = (record.definition.document ?? {}) as {
          sections?: { id: string; anchor: string; required?: boolean }[];
          copies?: Copies;
          pageMarkers?: boolean;
        };
        const loaded = (block.sections ?? []).map((s) => ({
          id: s.id,
          anchor: s.anchor,
          required: s.required ?? true,
        }));
        setRows(loaded);
        setCopies(block.copies ?? null);
        setPageMarkers(block.pageMarkers ?? true);
        setSaved(JSON.stringify(candidate(loaded, block.copies ?? null, block.pageMarkers ?? true)));
        setSamples(list);
        if (loaded.length) preview(candidate(loaded, block.copies ?? null, block.pageMarkers ?? true));
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [api, projectId, draft, preview]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  if (draft === null) {
    return <p className="muted">Start the next version on the Template tab to edit anchors.</p>;
  }
  if (rows === null) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;

  const current = candidate(rows, copies, pageMarkers);
  const dirty = JSON.stringify(current) !== saved;
  const complete = rows.length > 0 && rows.every((r) => r.id && r.anchor);

  const edit = (nextRows: Row[], nextCopies: Copies = copies) => {
    setRows(nextRows);
    setCopies(nextCopies);
    setMessage(null);
    if (timer.current) clearTimeout(timer.current);
    if (nextRows.length && nextRows.every((r) => r.id && r.anchor)) {
      timer.current = setTimeout(
        () => preview(candidate(nextRows, nextCopies, pageMarkers)),
        PREVIEW_DEBOUNCE_MS,
      );
    }
  };
  const setRow = (i: number, patch: Partial<Row>) =>
    edit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setError(null);
    try {
      const { record } = await api.getTemplate(projectId, draft);
      const definition = record.definition;
      const { copies: _old, ...document } = (definition.document ?? {}) as Record<string, unknown>;
      await api.saveTemplate(projectId, draft, {
        ...definition,
        document: { ...document, sections: current.sections, ...(current.copies ? { copies: current.copies } : {}) },
      });
      setSaved(JSON.stringify(current));
      setMessage(`Saved to v${draft}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openSample = open ? samples.find((s) => s.id === open.sampleId) : undefined;
  const marks =
    open && view?.result
      ? (view.result.samples
          .find((s) => s.sampleId === open.sampleId)
          ?.sections.filter((c) => c.found && c.page !== null && c.line !== null)
          .map((c) => ({ page: c.page!, line: c.line!, label: c.id })) ?? [])
      : [];

  return (
    <div className="sections-tab">
      <p className="muted">
        Each section starts at the first match of its anchor (a Python regular expression,
        multiline) and runs to the next one. The grid shows where every anchor lands in each
        prepared sample.
      </p>
      <table aria-label="Sections">
        <thead>
          <tr>
            <th>Id</th>
            <th>Anchor</th>
            <th>Required</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input
                  aria-label={`Id of section ${i + 1}`}
                  value={r.id}
                  onChange={(e) => setRow(i, { id: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="mono"
                  aria-label={`Anchor of section ${i + 1}`}
                  value={r.anchor}
                  onChange={(e) => setRow(i, { anchor: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Section ${i + 1} required`}
                  checked={r.required}
                  onChange={(e) => setRow(i, { required: e.target.checked })}
                />
              </td>
              <td>
                <button
                  type="button"
                  aria-label={`Remove section ${i + 1}`}
                  onClick={() => edit(rows.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => edit([...rows, { id: '', anchor: '', required: true }])}>
        Add section
      </button>
      <fieldset className="copies">
        <legend>Several copies in one PDF</legend>
        <label>
          Copy anchor
          <input
            className="mono"
            value={copies?.anchor ?? ''}
            onChange={(e) =>
              edit(rows, e.target.value ? { anchor: e.target.value, select: copies?.select ?? 'last' } : null)
            }
          />
        </label>
        <label>
          Keep
          <select
            value={copies?.select ?? 'last'}
            disabled={!copies}
            onChange={(e) =>
              copies && edit(rows, { ...copies, select: e.target.value as 'first' | 'last' })
            }
          >
            <option value="last">last copy</option>
            <option value="first">first copy</option>
          </select>
        </label>
      </fieldset>
      <div className="actions">
        <button type="button" onClick={() => preview(current)} disabled={!complete}>
          Preview
        </button>
        <button type="button" className="primary" onClick={() => void save()} disabled={!dirty || !complete}>
          Save to draft
        </button>
        {running && <span className="muted">Previewing…</span>}
        {message && <span role="status">{message}</span>}
      </div>
      {(error ?? previewError) && <p role="alert">{error ?? previewError}</p>}
      {view?.result && (
        <SegmentationGrid
          result={view.result}
          sections={rows.map((r) => ({ id: r.id, required: r.required }))}
          samples={samples}
          onOpen={(sampleId, sectionId) => setOpen({ sampleId, sectionId })}
        />
      )}
      {open && openSample && (
        <section aria-label={`Text of ${openSample.filename}`}>
          <h3>{openSample.filename}</h3>
          <SampleText key={open.sampleId} api={api} projectId={projectId} sampleId={open.sampleId} marks={marks} />
        </section>
      )}
    </div>
  );
}
```

Notes for the implementer:
- "Save to draft" removes `copies` from the definition when the copy anchor is cleared, and keeps every other `document` key (ocr, pages, pageMarkers, dateOrder).
- The copy selection's `<select>` has no visible `<label>` text of its own beyond "Keep". Keep it that way so `getByLabelText` works.

In `ProjectPage.tsx` import `SectionsTab` and render, after the Brief branch:

```tsx
      {tab === 'sections' && (
        <SectionsTab api={api} projectId={project.id} draft={draft} pollMs={300} />
      )}
```

The Sections tab polls every 300 ms regardless of the page's `pollMs`, because previews are expected to finish in under a second. Append `.section-start { color: var(--ih-accent); font-weight: 600; }` and `.sections-tab input.mono { width: 100%; font-family: var(--ih-font-mono); }` to `styles.css`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "Web: Sections tab with live anchor preview, section marks and save to draft"
```

---

### Task 10: Docs, full check and smoke test

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md`

- [ ] **Step 1: Document it**

`CLAUDE.md`:
- In the cross-language contracts table, extend the job statuses and tasks row with `\`segment\`, nullable \`document_id\`, \`params\` (migration 0009)`. Add the Python side `ClaimedJob.project_id/params` to that row. Extend the Workbench prepared-text row with `SegmentationResultSchema`/`segmentationKey` on the TypeScript side and `workbench.segment_samples`/`storage.segmentation_key` on the Python side.
- Extend the Workbench bullet in "Rules of the road" with this sentence: "Anchor previews are `segment` jobs: project-scoped with no document (`document_id IS NULL`, excluded from every `JobSummary` query by the inner join), `priority = -5`, one per project (a new preview deletes the old). They run `segment.section_spans`, the same code production segmentation uses. Idle workers wake on `NOTIFY ih_jobs` (trigger from migration 0009)."

`docs/architecture.md`: in the Workbench section add two sentences on the segment task and the NOTIFY wake-up. In the worker/queue description, note that idle workers now LISTEN instead of only polling.

`docs/design/workbench.md`: under "Risks and open questions", replace the open item about NOTIFY versus a 300 ms poll with: "Decided in phase 2: the worker wakes on `NOTIFY ih_jobs`; the UI polls the preview every 300 ms."

- [ ] **Step 2: Full check**

Run: `npm run check` (with `uv` on PATH; otherwise run its parts: `npm run lint && npm run typecheck && npm test`, then from `worker/`: `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q`) and `npm run format:check`.
Expected: PASS.

- [ ] **Step 3: Smoke test (throwaway infra only)**

Use a dev-infra stack whose Postgres holds no real jobs, on ports that don't clash with any running deployment.

1. Start the API (it applies 0008 and 0009), the web app and the worker against that stack.
2. In a Workbench project with two prepared samples (e.g. `docs/samples/TEXT process_validation_protocol.pdf` and one other), open **Sections**. The grid appears within about a second.
3. Type an unclosed `(` into one anchor. That anchor shows an error, and the rest of the grid still updates.
4. Fix it, add a section, and "Save to draft". The Template tab shows the new section.
5. Click a grid cell. The sample text opens with the section start marked.
6. Jobs page: no segment jobs are listed. Run `SELECT count(*) FROM jobs WHERE task='segment'`; it is at most 1 per project.
7. Run the worker integration tests: `cd worker && uv run pytest -m integration tests/test_queue_integration.py -q`.

Record anything you couldn't run in the PR description.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs
git commit -m "Workbench: document phase 2 (segment previews, NOTIFY wake-up)"
```
