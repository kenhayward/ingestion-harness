# Workbench tabs 2/8: Samples and Brief — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Samples and Brief tabs (handoff §1, §2) and land the API they need: live preparation progress (SM1) and a plain-language failure reason (SM2) on `SampleView`, brief version history and one version's body (BR1, BR2), and the bundle facts on `ExportView` (BR3). Samples gets four summary cards, a drop zone with an *Add as Dev / Holdout* switch, Dev and Holdout groups of rows (page badge, status, meta, segmented role switch, one-line note, live "OCR page 2 of 3", "Used in N holdout evaluations · never sent to a model") and a paged text preview. Brief gets a status line with the unsaved bar (*Discard* / *Save as vN+1*), a section nav, cards with char counts and an "edited" tag, a CSV preview of the example output, the survey answers card, a Versions list with *Compare*, and the restyled drafting bundle panel.

**Architecture:** No migration. The worker already writes `job_events`; it now also writes `prepare progress` (`{stage, page, of}`) and `prepare failed` (`{code, message}`) events during `prepare`, and `bytes` on the existing `bundle exported` event. The API gains one read port, `IngestionRepo.latestEvents(jobIds, messages)` (newest event per job and message; Memory + Pg), and derives `SampleView.prepare` / `prepareError` in `sampleViews` with two small pure helpers (`apps/api/src/workbench/prepare.ts`), and `ExportView.briefVersion` / `devSamples` / `bytes` from the export job's params plus that event. Brief history is pure shared logic (`packages/shared/src/brief.ts`: `BRIEF_SECTIONS`, `briefDiff`, `briefVersions`) over two new `WorkbenchRepo` reads (`listBriefs`, `getBrief`) and two documented routes; *Compare* diffs client-side with the same `briefDiff`. The web adds pure helpers (`workbench/samples.ts`, `workbench/brief.ts`), rewrites `SamplesTab`, `BriefTab` and `ExportPanel` on the PR 1 primitives (`TabHeader` `description`/`actions`, `SampleTag`, `Meter`, `Segmented`) and gives `SampleText` a `paged` mode.

**Tech Stack:** React 19, Vitest + Testing Library, Zod (shared), Fastify + OpenAPI route docs, Python 3.13 worker (pytest, mypy --strict, ruff), pypdf errors, CSS on existing `--ih-*` tokens.

**Spec:** `docs/design/workbench-tabs/WORKBENCH-TABS-HANDOFF.md` §0 (rules shared by every tab), §1 Samples, §2 Brief, rows **SM1, SM2, BR1, BR2, BR3** of "New API"; screens `docs/design/workbench-tabs/screenshots/light/01-samples.png`, `02-brief.png` (dark variants in `screenshots/dark/`).

## Global Constraints

- **No migration.** Progress and failure reasons are `job_events` rows (table from migration 0001: `job_id, at, level, message, data jsonb`, indexed on `(job_id, at)`), written by the worker's `queue.event` and read by the new `latestEvents`. Event names are a cross-language contract: TS `PREPARE_PROGRESS_EVENT = 'prepare progress'`, `PREPARE_FAILED_EVENT = 'prepare failed'` (`packages/shared/src/workbench.ts`), `BUNDLE_EXPORTED_EVENT = 'bundle exported'` (`packages/shared/src/bundle.ts`); Python `workbench.PREPARE_PROGRESS`, `workbench.PREPARE_FAILED`, and the literal in `bundle.run_export`.
- **Progress is current-attempt only:** `prepare` is non-null only while the prepare job is `running` and the newest `prepare progress` event is at or after the job's `updatedAt` (the claim sets `updated_at = now()`), so an earlier attempt's progress never shows. `page` counts OCR pages *finished*; the UI says the page in progress (`min(page + 1, of)`).
- **A failure code is trusted only when it explains the job's current error:** the newest `prepare failed` event counts when its `message` equals `job.error` (the worker sends `str(exc)` as both the event message and the `needs_review` reason). Anything else (retries exhausted → `failed`, cancelled, missing job, a Retry that later failed differently) is `{ code: 'other', message: <the existing error> }`. `SampleView.error` is unchanged.
- **Codes:** `password` (pypdf `FileNotDecryptedError` / `WrongPasswordError`), `corrupt` (any other pypdf `PdfReadError`, or a converter `ConversionRejected` that is not a 413), `too_large` (`ConversionRejected` starting `413`), `other` (everything else, e.g. "no extractable text"). An unreadable PDF now goes to `needs_review` at once instead of being retried three times (prepare only; production `prepare_document` is unchanged).
- **Data used only if it exists:** a row's note says how OCR read it from `triage.ocrPages`/`ocrModel`; the mock's "line table runs across pages 2–4" is not shown (it needs segmentation against the draft's sections, which Samples does not run). The 3–8 dev / ≥ 2 holdout figures are copy guidance in `workbench/samples.ts`, not enforced anywhere. The Samples status line stays the overview's text (rail parity, §0.1).
- **`holdoutEvaluations` is `holdoutRuns`** (exists since migration 0017): reused, not duplicated.
- **Brief versions (BR1):** `changedSections` = `briefDiff(previous version's body, this body)` in `BRIEF_SECTIONS` order (`purpose, outputs, glossary, exampleOutput, variants, rules, answers`); v1 compares with an empty brief. `usedBy` = the stages (in `DRAFT_STAGES` order) whose newest *accepted or partially accepted* proposal recorded that `briefVersion` (`ProposalRecord.briefVersion`); undecided, rejected and failed proposals use nothing.
- **Compare (BR2):** `GET …/briefs/:version` plus client-side `briefDiff`. *Compare* on an older row compares it with the current version; on the CURRENT row it compares the previous version with it; with one version it is disabled with the reason "Nothing to compare yet".
- **BR3 field names:** `ExportView.briefVersion: number | null`, `devSamples: number | null` (named for what it counts: dev samples carried, PDF or Word — the handoff's `devPdfs`), `bytes: number | null` (zip size from the `bundle exported` event, only once the export `succeeded`).
- **Holdout is sealed (§0.3):** nothing here sends text anywhere; holdout rows say "never sent to a model"; the bundle copy says "never holdout samples". Status-line text stays the overview's (`TabHeader` `item.status`) except Brief, whose line adds the save age and the unsaved count (handoff §2).
- **Accessibility (§0.7):** row selection is a button with `aria-pressed`; roles are a `Segmented` group named "Role of <file>"; meters are `Meter` (`role="img"` with the numbers); tables are real tables with `scope="col"`; status pills carry text; disabled controls carry a reason in `title`.
- **Polling (§0.8):** Samples polls only while a sample is `preparing` (unchanged); ExportPanel polls only while its export is queued/running (unchanged).
- Tests first (red, then green); `npm run check` green at the end; never stage `config/llm-providers.yaml` (unrelated local edit); never `git add -A`; commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Stale progress or a stale failure code never shows** — `prepareProgress` requires `running` and `at >= updatedAt`; `prepareError` requires `message === job.error` (Task 3 tests "an event left by an earlier attempt" and "a later failure with another reason").
2. **`sampleViews` stays cheap** — it asks for events only for prepare jobs that are `running` or `needs_review`, in one query; nothing is read for ready samples. No `LIST_CACHE_VERSION` bump: list rows count samples, they never carry progress.
3. **Worker behaviour change** — a pypdf read error in `prepare` is a `DocumentError` (needs review, not retried). `ocr_pages`' new `progress` callback is called from the main thread (the `pool.map` loop), never from the OCR threads, so `PgJobQueue`'s single connection is not shared across threads.
4. **`usedBy` semantics** — only applied proposals count, and only each stage's newest applied one (Task 1 table rows).
5. **Existing web tests are rewritten deliberately, not weakened** — Samples' table/`<select>` assertions become row/segmented-group assertions with the same behaviours (upload, role change, retry, remove, onChanged counts, holdout usage, OCR page flags); Brief's "Save brief" becomes "Save as vN" shown only when dirty; ExportPanel keeps its accessible names ("Export bundle", "Download bundle") and its non-admin sentence.
6. **Contract parity** — event names and payload keys equal on both sides; `ExportView`/`SampleView` fixtures updated in `packages/shared/test/dto.test.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/ExportPanel.test.tsx`; `docs/openapi.json` regenerated in each API task.

---

### Task 1: Shared brief history — `BRIEF_SECTIONS`, `briefDiff`, `briefVersions` (BR1/BR2 logic)

**Files:**
- Create: `packages/shared/src/brief.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/test/dto.test.ts`
- Test: `packages/shared/test/brief.test.ts` (create)

**Interfaces:**
- Produces (from `@ih/shared`):
  - `BRIEF_SECTIONS: readonly ['purpose','outputs','glossary','exampleOutput','variants','rules','answers']`, `type BriefSection`
  - `interface BriefSectionDiff { section: BriefSection; before: string; after: string }`
  - `briefSectionText(body: BriefBody, section: BriefSection): string` (answers: one `question: answer` per line)
  - `briefDiff(before: BriefBody | null, after: BriefBody): BriefSectionDiff[]` (`null` = compare with `EMPTY_BRIEF`; answers compared as data, not text)
  - `BriefVersionViewSchema` / `type BriefVersionView = { version; createdAt; changedSections: BriefSection[]; usedBy: DraftStage[] }`
  - `interface BriefUse { stage: DraftStage; briefVersion: number | null; decision: ProposalDecision | null; createdAt: string }` (a `ProposalRecord` satisfies it)
  - `briefVersions(briefs: readonly Brief[], proposals: readonly BriefUse[]): BriefVersionView[]` (newest first)
- Consumed by: the briefs route (Task 4), `BriefTab` (Task 8: dirty count, edited tags, Compare).

- [ ] **Step 1: Write the failing test** — `packages/shared/test/brief.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BRIEF_SECTIONS,
  EMPTY_BRIEF,
  briefDiff,
  briefSectionText,
  briefVersions,
  type Brief,
  type BriefBody,
  type BriefSectionDiff,
  type BriefUse,
  type BriefVersionView,
} from '../src/index.js';

const body = (o: Partial<BriefBody> = {}): BriefBody => ({ ...EMPTY_BRIEF, ...o });
const brief = (version: number, o: Partial<BriefBody> = {}): Brief => ({
  projectId: 'letter',
  version,
  body: body(o),
  createdAt: `2026-10-0${version}T09:00:00.000Z`,
});
const use = (o: Partial<BriefUse> & Pick<BriefUse, 'stage'>): BriefUse => ({
  briefVersion: 1,
  decision: 'accepted',
  createdAt: '2026-10-05T09:00:00.000Z',
  ...o,
});

describe('briefDiff', () => {
  it.each<[string, BriefBody | null, BriefBody, BriefSectionDiff[]]>([
    ['identical', body({ purpose: 'a' }), body({ purpose: 'a' }), []],
    [
      'the first version against an empty brief',
      null,
      body({ purpose: 'Invoices', rules: 'DMY' }),
      [
        { section: 'purpose', before: '', after: 'Invoices' },
        { section: 'rules', before: '', after: 'DMY' },
      ],
    ],
    [
      'sections in the tab order, whatever the edit order',
      body({ rules: 'a', glossary: 'x' }),
      body({ rules: 'b', glossary: 'y', variants: 'v' }),
      [
        { section: 'glossary', before: 'x', after: 'y' },
        { section: 'variants', before: '', after: 'v' },
        { section: 'rules', before: 'a', after: 'b' },
      ],
    ],
    [
      'a cleared section',
      body({ exampleOutput: 'a,b\n1,2' }),
      body(),
      [{ section: 'exampleOutput', before: 'a,b\n1,2', after: '' }],
    ],
    [
      'answers as data, shown one per line',
      body({ answers: [{ question: 'Which copy?', answer: 'Executed' }] }),
      body({
        answers: [
          { question: 'Which copy?', answer: 'Executed' },
          { question: 'Dates?', answer: 'DMY' },
        ],
      }),
      [
        {
          section: 'answers',
          before: 'Which copy?: Executed',
          after: 'Which copy?: Executed\nDates?: DMY',
        },
      ],
    ],
    [
      'answers that read the same as text but differ as data',
      body({ answers: [{ question: 'a: b', answer: 'c' }] }),
      body({ answers: [{ question: 'a', answer: 'b: c' }] }),
      [{ section: 'answers', before: 'a: b: c', after: 'a: b: c' }],
    ],
  ])('%s', (_name, before, after, expected) => {
    expect(briefDiff(before, after)).toEqual(expected);
  });

  it('covers every brief field', () => {
    expect([...BRIEF_SECTIONS].sort()).toEqual(Object.keys(EMPTY_BRIEF).sort());
    expect(briefSectionText(body({ glossary: 'PO' }), 'glossary')).toBe('PO');
  });
});

describe('briefVersions', () => {
  const v1 = brief(1, { purpose: 'Letters' });
  const v2 = brief(2, { purpose: 'Letters', glossary: 'PO' });
  const v3 = brief(3, { purpose: 'Letters', glossary: 'PO', variants: 'two', rules: 'DMY' });

  it.each<[string, Brief[], BriefUse[], Pick<BriefVersionView, 'version' | 'changedSections' | 'usedBy'>[]]>([
    ['no brief', [], [], []],
    [
      'newest first, each against its predecessor',
      [v1, v2, v3],
      [],
      [
        { version: 3, changedSections: ['variants', 'rules'], usedBy: [] },
        { version: 2, changedSections: ['glossary'], usedBy: [] },
        { version: 1, changedSections: ['purpose'], usedBy: [] },
      ],
    ],
    [
      'only applied proposals use a version',
      [v1, v2],
      [
        use({ stage: 'outputs', briefVersion: 2 }),
        use({ stage: 'sections', briefVersion: 2, decision: 'partially_accepted' }),
        use({ stage: 'steps', briefVersion: 2, decision: 'rejected' }),
        use({ stage: 'survey', briefVersion: 1, decision: null }),
      ],
      [
        { version: 2, changedSections: ['glossary'], usedBy: ['outputs', 'sections'] },
        { version: 1, changedSections: ['purpose'], usedBy: [] },
      ],
    ],
    [
      "a stage's newest applied proposal decides",
      [v1, v2],
      [
        use({ stage: 'outputs', briefVersion: 2, createdAt: '2026-10-06T09:00:00.000Z' }),
        use({ stage: 'outputs', briefVersion: 1, createdAt: '2026-10-05T09:00:00.000Z' }),
        use({ stage: 'survey', briefVersion: 1, createdAt: '2026-10-05T09:00:00.000Z' }),
        use({ stage: 'survey', briefVersion: null, createdAt: '2026-10-07T09:00:00.000Z' }),
      ],
      [
        { version: 2, changedSections: ['glossary'], usedBy: ['outputs'] },
        { version: 1, changedSections: ['purpose'], usedBy: [] },
      ],
    ],
    [
      'stages in drafting order',
      [v1],
      [use({ stage: 'revise' }), use({ stage: 'survey' }), use({ stage: 'steps' })],
      [{ version: 1, changedSections: ['purpose'], usedBy: ['survey', 'steps', 'revise'] }],
    ],
  ])('%s', (_name, briefs, proposals, expected) => {
    const views = briefVersions(briefs, proposals);
    expect(views.map(({ version, changedSections, usedBy }) => ({ version, changedSections, usedBy }))).toEqual(expected);
    expect(views.map((v) => v.createdAt)).toEqual(
      [...briefs].reverse().map((b) => b.createdAt),
    );
  });

  it('sorts briefs given out of order', () => {
    expect(briefVersions([v2, v1], []).map((v) => v.version)).toEqual([2, 1]);
  });
});
```

Add to the DTO table in `packages/shared/test/dto.test.ts` (next to the `ExportView` row; import `BriefVersionViewSchema`):

```ts
const briefVersion = {
  version: 2,
  createdAt: '2026-10-13T09:00:00.000Z',
  changedSections: ['glossary'],
  usedBy: ['outputs'],
};
```

```ts
  ['BriefVersionView', BriefVersionViewSchema, briefVersion, 'usedBy'],
```

- [ ] **Step 2: Run** `npx vitest run --project shared packages/shared/test/brief.test.ts packages/shared/test/dto.test.ts` → FAIL (`briefDiff` etc. are not exported).

- [ ] **Step 3: Implement** — `packages/shared/src/brief.ts`:

```ts
import { z } from 'zod';
import type { ProposalDecision } from './drafting.js';
import { DRAFT_STAGES, EMPTY_BRIEF, type Brief, type BriefBody, type DraftStage } from './workbench.js';

/** The brief's sections in the Brief tab's order (handoff §2); `answers` is filled by Survey. */
export const BRIEF_SECTIONS = [
  'purpose',
  'outputs',
  'glossary',
  'exampleOutput',
  'variants',
  'rules',
  'answers',
] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

export interface BriefSectionDiff {
  section: BriefSection;
  before: string;
  after: string;
}

/** A section as text: the survey answers one `question: answer` per line. */
export function briefSectionText(body: BriefBody, section: BriefSection): string {
  return section === 'answers'
    ? body.answers.map((a) => `${a.question}: ${a.answer}`).join('\n')
    : body[section];
}

const same = (a: BriefBody, b: BriefBody, section: BriefSection) =>
  section === 'answers'
    ? JSON.stringify(a.answers) === JSON.stringify(b.answers)
    : a[section] === b[section];

/**
 * The sections that differ between two versions of a brief, in `BRIEF_SECTIONS` order.
 * `before` null: the first version, compared with an empty brief.
 */
export function briefDiff(before: BriefBody | null, after: BriefBody): BriefSectionDiff[] {
  const from = before ?? EMPTY_BRIEF;
  return BRIEF_SECTIONS.flatMap((section) =>
    same(from, after, section)
      ? []
      : [
          {
            section,
            before: briefSectionText(from, section),
            after: briefSectionText(after, section),
          },
        ],
  );
}

/** GET /api/workbench/projects/:id/briefs (handoff BR1), newest first. */
export const BriefVersionViewSchema = z.object({
  version: z.number().int().positive(),
  createdAt: z.string(),
  /** Sections changed from the previous version (the first: sections with text). */
  changedSections: z.array(z.enum(BRIEF_SECTIONS)),
  /** Stages whose newest accepted or partially accepted proposal was drafted from it. */
  usedBy: z.array(z.enum(DRAFT_STAGES)),
});
export type BriefVersionView = z.infer<typeof BriefVersionViewSchema>;

/** What `briefVersions` reads of a proposal (`ProposalRecord` has these fields). */
export interface BriefUse {
  stage: DraftStage;
  briefVersion: number | null;
  decision: ProposalDecision | null;
  createdAt: string;
}

/** Each brief version with what it changed and which stages' applied proposals used it. */
export function briefVersions(
  briefs: readonly Brief[],
  proposals: readonly BriefUse[],
): BriefVersionView[] {
  const inForce = new Map<DraftStage, number | null>();
  const applied = proposals
    .filter((p) => p.decision === 'accepted' || p.decision === 'partially_accepted')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const p of applied) inForce.set(p.stage, p.briefVersion);
  const sorted = [...briefs].sort((a, b) => a.version - b.version);
  return sorted
    .map((b, i) => ({
      version: b.version,
      createdAt: b.createdAt,
      changedSections: briefDiff(i === 0 ? null : sorted[i - 1]!.body, b.body).map(
        (d) => d.section,
      ),
      usedBy: DRAFT_STAGES.filter((s) => inForce.get(s) === b.version),
    }))
    .reverse();
}
```

In `packages/shared/src/index.ts` add `export * from './brief.js';`.

- [ ] **Step 4: Run** `npx vitest run --project shared` → PASS; `npm run typecheck`; `npx eslint packages/shared`; `npx prettier --write packages/shared/src/brief.ts packages/shared/src/index.ts packages/shared/test/brief.test.ts packages/shared/test/dto.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/brief.ts packages/shared/src/index.ts packages/shared/test/brief.test.ts packages/shared/test/dto.test.ts
git commit -m "Shared: brief sections, briefDiff and briefVersions for the Brief tab history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Worker — prepare progress and failure codes (SM1/SM2), bundle size (BR3)

**Files:**
- Modify: `worker/src/ingest_worker/workbench.py`, `worker/src/ingest_worker/pipeline.py` (`ocr_pages`), `worker/src/ingest_worker/bundle.py` (`run_export` event)
- Test: `worker/tests/test_workbench.py`, `worker/tests/test_bundle.py`

**Interfaces:**
- Produces:
  - `workbench.PREPARE_PROGRESS = "prepare progress"`, `workbench.PREPARE_FAILED = "prepare failed"`
  - `workbench.PrepareErrorCode = Literal["password", "corrupt", "too_large", "other"]`
  - `class PrepareFailed(DocumentError)` with `.code: PrepareErrorCode`; `prepare_error_code(exc: DocumentError) -> PrepareErrorCode`
  - Events during `prepare`: `("info", "prepare progress", {"stage": "text", "page": n, "of": n})` once after text extraction, then `("info", "prepare progress", {"stage": "ocr", "page": done, "of": targets})` after each OCR'd page; on any `DocumentError`, `("warn", "prepare failed", {"code": …, "message": str(exc)})` before it propagates to `run_once` (which records `needs review` with the same `str(exc)` as the job error).
  - `ocr_pages(…, *, sha256: str, progress: Callable[[int, int], None] | None = None)` — `progress(done, total)` after each page OCR'd (cached pages count as done; nothing is reported when no page needs OCR).
  - `bundle exported` event data gains `"bytes": len(zip)`.
- Consumed by: the API (Tasks 3 and 5) through `latestEvents`.

- [ ] **Step 1: Write the failing tests** — in `worker/tests/test_workbench.py`, add `import pytest`, `from pypdf.errors import EmptyFileError, FileNotDecryptedError, PdfReadError, WrongPasswordError`, change `from ingest_worker.convert import DOCX_MIME` to `from ingest_worker.convert import DOCX_MIME, ConversionRejected`, add `from ingest_worker.workbench import PREPARE_FAILED, PREPARE_PROGRESS`, then:

```python
def events_named(queue: FakeQueue, message: str) -> list[dict[str, Any]]:
    return [data for _, _, name, data in queue.event_details if name == message]


def test_prepare_reports_the_text_layer_then_each_ocr_page(fixture_specs_dir: Path) -> None:
    ocr = FakeProvider("local")
    ocr.vision_responses = [OLMOCR_OK + "Scanned one", OLMOCR_OK + "Scanned two"]
    deps = make_deps(fixture_specs_dir, [TEXT_PAGE, "", ""], ocr)
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    assert queue.completed
    assert events_named(queue, PREPARE_PROGRESS) == [
        {"stage": "text", "page": 3, "of": 3},
        {"stage": "ocr", "page": 1, "of": 2},
        {"stage": "ocr", "page": 2, "of": 2},
    ]
    assert events_named(queue, PREPARE_FAILED) == []


def test_prepare_without_ocr_reports_the_text_layer_only(fixture_specs_dir: Path) -> None:
    deps = make_deps(fixture_specs_dir, [TEXT_PAGE, TEXT_PAGE])
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    assert events_named(queue, PREPARE_PROGRESS) == [{"stage": "text", "page": 2, "of": 2}]


@pytest.mark.parametrize(
    ("error", "code", "message"),
    [
        (FileNotDecryptedError("File has not been decrypted"), "password", "PDF is password-protected"),
        (WrongPasswordError("Wrong password"), "password", "PDF is password-protected"),
        (
            PdfReadError("EOF marker not found"),
            "corrupt",
            "PDF could not be read: EOF marker not found",
        ),
        (
            EmptyFileError("Cannot read an empty file"),
            "corrupt",
            "PDF could not be read: Cannot read an empty file",
        ),
    ],
)
def test_an_unreadable_pdf_goes_to_review_with_its_reason(
    fixture_specs_dir: Path, error: Exception, code: str, message: str
) -> None:
    deps = make_deps(fixture_specs_dir, [])

    def unreadable(_pdf: bytes) -> list[str]:
        raise error

    deps.extract_text = unreadable
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    assert queue.reviewed == [("job-p", message)]
    assert queue.failed == []  # not retried: the file will not read better next time
    assert events_named(queue, PREPARE_FAILED) == [{"code": code, "message": message}]
    assert deps.store.get_optional("runs", prepared_text_key(SHA)) is None


@pytest.mark.parametrize(
    ("rejection", "code"),
    [("413: Request Entity Too Large", "too_large"), ("400: not a Word file", "corrupt")],
)
def test_a_word_sample_the_converter_rejects_says_why(
    fixture_specs_dir: Path, rejection: str, code: str
) -> None:
    deps = make_deps(fixture_specs_dir, [TEXT_PAGE])
    deps.store.put("inbox", "letter/v1/doc-s.pdf", DOCX, DOCX_MIME)
    deps.converter = FakeConverter(error=ConversionRejected(rejection))
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    [(_, reason)] = queue.reviewed
    assert events_named(queue, PREPARE_FAILED) == [{"code": code, "message": reason}]
```

Extend `test_image_only_pdf_without_ocr_needs_review_and_writes_nothing` (append):

```python
    assert events_named(queue, PREPARE_FAILED) == [{"code": "other", "message": reason}]
```

In `worker/tests/test_bundle.py` add:

```python
def test_export_records_the_size_of_its_zip(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    queue = FakeQueue()

    run_export(export_job(), deps, queue)

    zipped = store.get("runs", export_key("letter", "job-x"))
    assert queue.event_details[-1] == (
        "job-x",
        "info",
        "bundle exported",
        {"samples": ["s1"], "bytes": len(zipped)},
    )
```

- [ ] **Step 2: Run** `cd worker && uv run pytest tests/test_workbench.py tests/test_bundle.py` → FAIL (`PREPARE_PROGRESS` cannot be imported; no `bytes` in the event).

- [ ] **Step 3: Implement**

`worker/src/ingest_worker/pipeline.py`, `ocr_pages` — add the keyword-only parameter and report from the loop (the main thread):

```python
def ocr_pages(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    pdf: bytes,
    pages: list[str],
    mode: OcrMode,
    *,
    sha256: str,
    progress: Callable[[int, int], None] | None = None,
) -> list[str]:
    """Replace low-text pages with OCR output. Transient model errors propagate (retried).
    `sha256` is the source's (`Source.sha256`): the shared OCR cache is keyed by it.
    `progress(done, total)` is called after each page is OCR'd, from this thread (never from
    the OCR threads), counting pages read from the caches as done."""
```

and replace the pool loop with:

```python
    with ThreadPoolExecutor(max_workers=max(1, settings.concurrency)) as pool:
        for done, page in enumerate(pool.map(run, todo), start=1):
            pages[page.index] = page.text
            if progress is not None:
                progress(len(cached) + done, len(targets))
```

`worker/src/ingest_worker/workbench.py` — imports gain `from typing import Any, Literal`, `from pypdf.errors import FileNotDecryptedError, PdfReadError, WrongPasswordError`, `from .convert import ConversionRejected`. Below `LINE_LIMIT`:

```python
#: Job events the API reads for the Samples tab (TS: PREPARE_PROGRESS_EVENT, PREPARE_FAILED_EVENT).
PREPARE_PROGRESS = "prepare progress"
PREPARE_FAILED = "prepare failed"

#: TS: PREPARE_ERROR_CODES (packages/shared/src/workbench.ts).
PrepareErrorCode = Literal["password", "corrupt", "too_large", "other"]


class PrepareFailed(DocumentError):
    """A sample that cannot be prepared, with the reason's code for the Samples tab."""

    def __init__(self, code: PrepareErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: PrepareErrorCode = code


def prepare_error_code(exc: DocumentError) -> PrepareErrorCode:
    """The Samples tab's reason for a failed preparation."""
    if isinstance(exc, PrepareFailed):
        return exc.code
    cause = exc.__cause__
    if isinstance(cause, ConversionRejected):
        return "too_large" if str(cause).startswith("413") else "corrupt"
    return "other"


def _extract(deps: PipelineDeps, pdf: bytes) -> list[str]:
    """The text layer; a PDF pypdf cannot open is a property of the file (needs review)."""
    try:
        return deps.extract_text(pdf)
    except (FileNotDecryptedError, WrongPasswordError) as exc:
        raise PrepareFailed("password", "PDF is password-protected") from exc
    except PdfReadError as exc:
        raise PrepareFailed("corrupt", f"PDF could not be read: {exc}") from exc
```

Rename the current body of `prepare_sample` to `_prepare` and wrap it:

```python
def prepare_sample(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    """Extract and OCR (mode auto) one sample (a PDF, or a .docx converted to PDF); write its
    text and triage to the runs bucket, keyed by the sha256 of the uploaded file. Returns the
    triage. Reports `prepare progress` events as it goes; a sample that cannot be prepared
    records a `prepare failed` event (code and message, the message being the review reason)
    before the DocumentError reaches run_once."""
    try:
        return _prepare(job, deps, queue)
    except DocumentError as exc:
        data = {"code": prepare_error_code(exc), "message": str(exc)}
        queue.event(job.id, "warn", PREPARE_FAILED, data)
        raise


def _prepare(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    def report(stage: Literal["text", "ocr"], page: int, of: int) -> None:
        queue.event(job.id, "info", PREPARE_PROGRESS, {"stage": stage, "page": page, "of": of})

    source = load_source(job, deps, queue)
    pdf, sha256 = source.pdf, source.sha256
    pages = _extract(deps, pdf)
    report("text", len(pages), len(pages))
    ocr_numbers = (
        [i + 1 for i in pages_needing_ocr(pages, "auto", deps.ocr.min_chars)] if deps.ocr else []
    )
    pages = ocr_pages(
        job,
        deps,
        queue,
        pdf,
        pages,
        "auto",
        sha256=sha256,
        progress=lambda done, total: report("ocr", done, total),
    )
    # … unchanged from here: the no-text check, check_cancelled, text/triage writes, `prepared`.
```

`worker/src/ingest_worker/bundle.py`, the last event of `run_export`:

```python
    queue.event(
        job.id,
        "info",
        "bundle exported",
        {"samples": [s.sample_id for s in params.samples], "bytes": len(data)},
    )
```

- [ ] **Step 4: Run** `cd worker && uv run pytest tests/test_workbench.py tests/test_bundle.py tests/test_ocr.py tests/test_pipeline.py` → PASS; then `npm run worker:lint` and `npm run worker:test` → green.

- [ ] **Step 5: Commit**

```bash
git add worker/src/ingest_worker/workbench.py worker/src/ingest_worker/pipeline.py worker/src/ingest_worker/bundle.py worker/tests/test_workbench.py worker/tests/test_bundle.py
git commit -m "Worker: prepare progress and failure-code events, bundle size on export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: API — `latestEvents` port; `SampleView.prepare` and `prepareError` (SM1, SM2)

**Files:**
- Modify: `packages/shared/src/workbench.ts`, `packages/shared/test/dto.test.ts`
- Modify: `apps/api/src/repositories/types.ts`, `apps/api/src/repositories/memory.ts`, `apps/api/src/repositories/pg.ts`, `apps/api/src/routes/workbench.ts` (`sampleViews`, `toView`, `listSamples` docs)
- Create: `apps/api/src/workbench/prepare.ts`
- Modify: `apps/web/test/fake-api.ts` (`sampleView` defaults)
- Test: `apps/api/test/workbench-samples.test.ts`, `apps/api/test/integration/workbench-pg.test.ts`
- Regenerate: `docs/openapi.json`

**Interfaces:**
- Produces (shared): `PREPARE_PROGRESS_EVENT`, `PREPARE_FAILED_EVENT`, `PrepareProgressSchema` / `PrepareProgress = { stage: 'text' | 'ocr'; page: number; of: number }`, `PREPARE_ERROR_CODES`, `PrepareErrorSchema` / `PrepareError = { code: 'password' | 'corrupt' | 'too_large' | 'other'; message: string }`; `SampleViewSchema` gains `prepare: PrepareProgress | null` and `prepareError: PrepareError | null`.
- Produces (API): `interface JobEventRecord { jobId: string; message: string; data: unknown; at: string }`; `IngestionRepo.latestEvents(jobIds: string[], messages: readonly string[]): Promise<JobEventRecord[]>` (the newest event per job and message); `MemoryRepo.addEvent(jobId, level, message, data?)` (test helper standing in for the worker); `prepareProgress(job, events)`, `prepareError(state, job, events)` (`apps/api/src/workbench/prepare.ts`).
- Consumed by: `SamplesTab` (Task 7), `exportView` (Task 5).

- [ ] **Step 1: Write the failing tests** — in `apps/api/test/workbench-samples.test.ts`, import `PREPARE_FAILED_EVENT, PREPARE_PROGRESS_EVENT` from `@ih/shared`; extend the existing failed-preparation test and add:

```ts
  it('reports a failed preparation with its error', async () => {
    const { app, repo, upload } = await withProject();
    const sample = (await upload(pdf(1))).json() as SampleView;
    repo.jobs.set(sample.prepareJobId!, {
      ...repo.jobs.get(sample.prepareJobId!)!,
      status: 'failed',
      error: 'OCR server unreachable',
    });
    const [listed] = (await app.inject('/api/workbench/projects/letter/samples')).json();
    expect(listed).toMatchObject({
      state: 'failed',
      error: 'OCR server unreachable',
      prepare: null,
      prepareError: { code: 'other', message: 'OCR server unreachable' },
    });
  });

  it('shows live preparation progress from the current attempt only', async () => {
    const { app, repo, upload } = await withProject();
    const sample = (await upload(pdf(1))).json() as SampleView;
    const id = sample.prepareJobId!;
    const listed = async () =>
      ((await app.inject('/api/workbench/projects/letter/samples')).json() as SampleView[])[0]!;
    expect(await listed()).toMatchObject({ state: 'preparing', prepare: null, prepareError: null });

    // An event left by an earlier attempt does not count once the job is claimed again.
    repo.addEvent(id, 'info', PREPARE_PROGRESS_EVENT, { stage: 'ocr', page: 3, of: 3 });
    repo.jobs.set(id, { ...repo.jobs.get(id)!, status: 'running', updatedAt: repo.now() });
    expect((await listed()).prepare).toBeNull();

    repo.addEvent(id, 'info', PREPARE_PROGRESS_EVENT, { stage: 'text', page: 3, of: 3 });
    expect((await listed()).prepare).toEqual({ stage: 'text', page: 3, of: 3 });
    repo.addEvent(id, 'info', 'ocr', { model: 'local/olmocr' }); // other events are ignored
    repo.addEvent(id, 'info', PREPARE_PROGRESS_EVENT, { stage: 'ocr', page: 1, of: 2 });
    expect(await listed()).toMatchObject({
      state: 'preparing',
      prepare: { stage: 'ocr', page: 1, of: 2 },
    });
    repo.addEvent(id, 'info', PREPARE_PROGRESS_EVENT, { stage: 'ocr', page: 'two' });
    expect((await listed()).prepare).toBeNull(); // a malformed event shows no progress

    repo.jobs.set(id, { ...repo.jobs.get(id)!, status: 'succeeded' });
    expect((await listed()).prepare).toBeNull();
  });

  it('says why a sample could not be prepared', async () => {
    const { app, repo, upload } = await withProject();
    const sample = (await upload(pdf(1))).json() as SampleView;
    const id = sample.prepareJobId!;
    repo.addEvent(id, 'warn', PREPARE_FAILED_EVENT, {
      code: 'password',
      message: 'PDF is password-protected',
    });
    repo.jobs.set(id, {
      ...repo.jobs.get(id)!,
      status: 'needs_review',
      error: 'PDF is password-protected',
    });
    const listed = async () =>
      ((await app.inject('/api/workbench/projects/letter/samples')).json() as SampleView[])[0]!;
    expect(await listed()).toMatchObject({
      state: 'failed',
      error: 'PDF is password-protected',
      prepareError: { code: 'password', message: 'PDF is password-protected' },
    });

    // Retried, then failed for another reason: the old code no longer explains the error.
    repo.jobs.set(id, {
      ...repo.jobs.get(id)!,
      status: 'needs_review',
      error: 'no extractable text (scanned/image-only PDF?); OCR is not configured',
    });
    expect((await listed()).prepareError).toEqual({
      code: 'other',
      message: 'no extractable text (scanned/image-only PDF?); OCR is not configured',
    });
  });
```

Add to the DTO table fixture `sample` in `packages/shared/test/dto.test.ts`: `prepare: { stage: 'ocr', page: 1, of: 3 }, prepareError: null,` (a full value); and a row `['PrepareError', PrepareErrorSchema, { code: 'password', message: 'PDF is password-protected' }, 'code']`.

In `apps/api/test/integration/workbench-pg.test.ts` add:

```ts
  it('reads the newest event per job and message', async () => {
    const projectId = await newProject();
    const opts = { projectId, task: 'prepare' as const, params: { dataPolicy: 'local' } };
    const a = await repo.createWorkbenchJob(doc(projectId), opts);
    const b = await repo.createWorkbenchJob(doc(projectId), opts);
    const add = (jobId: string, message: string, data: unknown) =>
      pool.query(
        `INSERT INTO job_events (job_id, level, message, data) VALUES ($1, 'info', $2, $3)`,
        [jobId, message, JSON.stringify(data)],
      );
    await add(a.id, 'prepare progress', { stage: 'text', page: 2, of: 2 });
    await add(a.id, 'prepare progress', { stage: 'ocr', page: 1, of: 2 });
    await add(a.id, 'prepared', { pages: 2 });
    await add(b.id, 'prepare failed', { code: 'password', message: 'locked' });

    const events = await repo.latestEvents([a.id, b.id], ['prepare progress', 'prepare failed']);
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          jobId: a.id,
          message: 'prepare progress',
          data: { stage: 'ocr', page: 1, of: 2 },
          at: expect.any(String),
        },
        {
          jobId: b.id,
          message: 'prepare failed',
          data: { code: 'password', message: 'locked' },
          at: expect.any(String),
        },
      ]),
    );
    expect(await repo.latestEvents([], ['prepare progress'])).toEqual([]);
  });
```

- [ ] **Step 2: Run** `npx vitest run --project api apps/api/test/workbench-samples.test.ts` and `npx vitest run --project shared packages/shared/test/dto.test.ts` → FAIL (`addEvent` is not a function; `PREPARE_PROGRESS_EVENT` undefined; schema rejects `prepare`).

- [ ] **Step 3: Implement**

`packages/shared/src/workbench.ts`, above `SampleViewSchema`:

```ts
/** Job events the worker's prepare task writes (worker: workbench.PREPARE_PROGRESS / _FAILED). */
export const PREPARE_PROGRESS_EVENT = 'prepare progress';
export const PREPARE_FAILED_EVENT = 'prepare failed';

/** Where a running preparation is: the text layer read, or `page` of `of` OCR pages done. */
export const PrepareProgressSchema = z.object({
  stage: z.enum(['text', 'ocr']),
  page: z.number().int().nonnegative(),
  of: z.number().int().nonnegative(),
});
export type PrepareProgress = z.infer<typeof PrepareProgressSchema>;

/** Why a preparation failed (worker: workbench.PrepareErrorCode). */
export const PREPARE_ERROR_CODES = ['password', 'corrupt', 'too_large', 'other'] as const;
export const PrepareErrorSchema = z.object({
  code: z.enum(PREPARE_ERROR_CODES),
  message: z.string(),
});
export type PrepareError = z.infer<typeof PrepareErrorSchema>;
```

and in `SampleViewSchema` after `error`:

```ts
  /** While the prepare job runs: its latest progress in this attempt (null before any). */
  prepare: PrepareProgressSchema.nullable(),
  /** When `failed`: the reason's code and message (`other` when the worker gave none). */
  prepareError: PrepareErrorSchema.nullable(),
```

`apps/api/src/repositories/types.ts`, next to `ProjectJob`:

```ts
/** A job_events row as the API reads it. */
export interface JobEventRecord {
  jobId: string;
  message: string;
  data: unknown;
  at: string;
}
```

and in `IngestionRepo` (after `getJobParams`):

```ts
  /** The newest event with each of `messages` for each job (job_events); none: left out. */
  latestEvents(jobIds: string[], messages: readonly string[]): Promise<JobEventRecord[]>;
```

`apps/api/src/repositories/memory.ts`: the `events` map becomes `new Map<string, { level: string; message: string; data: unknown; at: string }[]>()` (comment: "job_events: what the API writes itself (cancellations) and what tests add for the worker"); `cancelJob` pushes `{ level: 'warn', message: 'cancelled', data: null, at: this.now() }`; add:

```ts
  /** Test helper: an event as the worker's queue.event writes it. */
  addEvent(jobId: string, level: string, message: string, data: unknown = null): void {
    this.events.set(jobId, [...(this.events.get(jobId) ?? []), { level, message, data, at: this.now() }]);
  }

  async latestEvents(jobIds: string[], messages: readonly string[]): Promise<JobEventRecord[]> {
    return jobIds.flatMap((jobId) =>
      messages.flatMap((message) => {
        const event = (this.events.get(jobId) ?? []).filter((e) => e.message === message).at(-1);
        return event ? [{ jobId, message, data: event.data, at: event.at }] : [];
      }),
    );
  }
```

`apps/api/src/repositories/pg.ts` (after `getJobParams`):

```ts
  async latestEvents(jobIds: string[], messages: readonly string[]): Promise<JobEventRecord[]> {
    if (!jobIds.length || !messages.length) return [];
    const { rows } = await this.pool.query<{
      job_id: string;
      message: string;
      data: unknown;
      at: Date;
    }>(
      `SELECT DISTINCT ON (job_id, message) job_id, message, data, at
         FROM job_events
        WHERE job_id = ANY($1::uuid[]) AND message = ANY($2::text[])
        ORDER BY job_id, message, at DESC, id DESC`,
      [jobIds, [...messages]],
    );
    return rows.map((r) => ({
      jobId: r.job_id,
      message: r.message,
      data: r.data,
      at: r.at.toISOString(),
    }));
  }
```

Create `apps/api/src/workbench/prepare.ts`:

```ts
import {
  PREPARE_FAILED_EVENT,
  PREPARE_PROGRESS_EVENT,
  PrepareErrorSchema,
  PrepareProgressSchema,
  type JobSummary,
  type PrepareError,
  type PrepareProgress,
  type SampleState,
} from '@ih/shared';
import type { JobEventRecord } from '../repositories/types.js';

/** The events `sampleViews` reads for the prepare jobs that are running or need review. */
export const PREPARE_EVENTS = [PREPARE_PROGRESS_EVENT, PREPARE_FAILED_EVENT] as const;

/**
 * A running preparation's progress in this attempt: the newest progress event written since the
 * job was claimed (the claim sets `updated_at`), so an earlier attempt's progress never shows.
 */
export function prepareProgress(
  job: JobSummary | null,
  events: readonly JobEventRecord[],
): PrepareProgress | null {
  if (!job || job.status !== 'running') return null;
  const latest = events.find((e) => e.jobId === job.id && e.message === PREPARE_PROGRESS_EVENT);
  if (!latest || Date.parse(latest.at) < Date.parse(job.updatedAt)) return null;
  const parsed = PrepareProgressSchema.safeParse(latest.data);
  return parsed.success ? parsed.data : null;
}

/**
 * Why a sample failed: the worker's code when its `prepare failed` event explains the job's
 * current error (same message), else `other` with the error the sample already shows.
 */
export function prepareError(
  state: SampleState,
  job: JobSummary | null,
  events: readonly JobEventRecord[],
): PrepareError | null {
  if (state !== 'failed') return null;
  const message = job?.error ?? job?.status ?? 'preparation job missing';
  const latest = job
    ? events.find((e) => e.jobId === job.id && e.message === PREPARE_FAILED_EVENT)
    : undefined;
  const parsed = latest ? PrepareErrorSchema.safeParse(latest.data) : null;
  if (job && parsed?.success && parsed.data.message === job.error) {
    return parsed.data;
  }
  return { code: 'other', message };
}
```

`apps/api/src/routes/workbench.ts` — import `PREPARE_EVENTS, prepareError, prepareProgress` from `../workbench/prepare.js` and `type JobEventRecord` from `../repositories/types.js`. In `sampleViews`, after `prepares`:

```ts
  // Progress and failure reasons (handoff SM1–SM2): only jobs running or needing review have any.
  const watched = prepares
    .filter((j) => j.status === 'running' || j.status === 'needs_review')
    .map((j) => j.id);
  const events = watched.length ? await app.deps.repo.latestEvents(watched, PREPARE_EVENTS) : [];
```

pass `events` as a fifth argument of `toView(app, record, job, holdoutRuns, events)`, and in `toView` (signature `events: readonly JobEventRecord[]`) add after `error`:

```ts
    prepare: prepareProgress(job, events),
    prepareError: prepareError(state, job, events),
```

`listSamples` docs: append to the description: "While preparing, \`prepare\` says how far the current attempt got (\`text\` read, or \`page\` of \`of\` OCR pages done); a failed sample's \`prepareError\` gives a \`code\` (\`password\`, \`corrupt\`, \`too_large\`, \`other\`) and the message."

`apps/web/test/fake-api.ts`, `sampleView` defaults: add `prepare: null, prepareError: null,` after `error: null,`.

- [ ] **Step 4: Run** `npx vitest run --project api apps/api/test/workbench-samples.test.ts` → PASS; `npx vitest run --project shared`; `npm run openapi`; `npx vitest run --project api` (openapi and conformance included) → PASS; `npm run typecheck`; `npx eslint apps/api packages/shared apps/web/test/fake-api.ts`; prettier on the changed files. If a throwaway Postgres is available (CLAUDE.md §4), run `IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg` → the new test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/workbench.ts packages/shared/test/dto.test.ts apps/api/src/repositories/types.ts apps/api/src/repositories/memory.ts apps/api/src/repositories/pg.ts apps/api/src/workbench/prepare.ts apps/api/src/routes/workbench.ts apps/api/test/workbench-samples.test.ts apps/api/test/integration/workbench-pg.test.ts apps/web/test/fake-api.ts docs/openapi.json
git commit -m "Workbench API: live prepare progress and failure reasons on samples

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: API — brief versions and one version's body (BR1, BR2)

**Files:**
- Modify: `apps/api/src/workbench/repo.ts` (interface, `MemoryWorkbenchRepo`, `PgWorkbenchRepo`), `apps/api/src/routes/workbench.ts`
- Test: `apps/api/test/workbench-briefs.test.ts` (create), `apps/api/test/integration/workbench-pg.test.ts`
- Regenerate: `docs/openapi.json`

**Interfaces:**
- Produces:
  - `WorkbenchRepo.listBriefs(projectId: string): Promise<Brief[]>` (oldest first), `WorkbenchRepo.getBrief(projectId: string, version: number): Promise<Brief | null>`
  - `GET /api/workbench/projects/:id/briefs` → `200 BriefVersionView[]` (newest first; `[]` without a brief), `404 project not found` — `operationId: 'listBriefVersions'`
  - `GET /api/workbench/projects/:id/briefs/:version` → `200 Brief`, `404 project not found | brief version not found` — `operationId: 'getBriefVersion'`
- Consumed by: web client (Task 6), `BriefTab` (Task 8).

- [ ] **Step 1: Write the failing tests** — `apps/api/test/workbench-briefs.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Brief, BriefVersionView } from '@ih/shared';
import { testApp } from './helpers.js';

async function withBriefs() {
  const ctx = await testApp();
  await ctx.workbench.createProject('letter', 'Letter');
  const save = (payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'PUT', url: '/api/workbench/projects/letter/brief', payload });
  return { ...ctx, save };
}

describe('brief versions', () => {
  it('lists versions newest first with what changed and which stages use them', async () => {
    const { app, workbench, save } = await withBriefs();
    expect((await app.inject('/api/workbench/projects/letter/briefs')).json()).toEqual([]);
    await save({ purpose: 'Letters' });
    await save({ purpose: 'Letters', glossary: 'PO: purchase order' });
    await save({ purpose: 'Letters', glossary: 'PO: purchase order', variants: 'two', rules: 'DMY' });
    const applied = await workbench.createProposal({
      id: randomUUID(),
      projectId: 'letter',
      stage: 'outputs',
      briefVersion: 2,
    });
    await workbench.decideProposal('letter', applied.id, 'accepted');
    // Undecided: drafted from v3, but nothing of it is in the draft.
    await workbench.createProposal({
      id: randomUUID(),
      projectId: 'letter',
      stage: 'steps',
      briefVersion: 3,
    });

    const res = await app.inject('/api/workbench/projects/letter/briefs');
    expect(res.statusCode).toBe(200);
    const versions = res.json() as BriefVersionView[];
    expect(versions.map(({ createdAt: _at, ...v }) => v)).toEqual([
      { version: 3, changedSections: ['variants', 'rules'], usedBy: [] },
      { version: 2, changedSections: ['glossary'], usedBy: ['outputs'] },
      { version: 1, changedSections: ['purpose'], usedBy: [] },
    ]);
    expect(versions.every((v) => typeof v.createdAt === 'string')).toBe(true);
  });

  it('reads one version', async () => {
    const { app, save } = await withBriefs();
    await save({ purpose: 'Letters' });
    await save({ purpose: 'Memos' });
    const res = await app.inject('/api/workbench/projects/letter/briefs/1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ projectId: 'letter', version: 1, body: { purpose: 'Letters' } });
    const latest = (await app.inject('/api/workbench/projects/letter/briefs/2')).json() as Brief;
    expect(latest.body.purpose).toBe('Memos');
  });

  it.each([
    ['/api/workbench/projects/letter/briefs/3', 'brief version not found'],
    ['/api/workbench/projects/letter/briefs/0', 'brief version not found'],
    ['/api/workbench/projects/letter/briefs/latest', 'brief version not found'],
    ['/api/workbench/projects/nope/briefs/1', 'project not found'],
    ['/api/workbench/projects/nope/briefs', 'project not found'],
  ])('%s is a 404 (%s)', async (url, error) => {
    const { app, save } = await withBriefs();
    await save({ purpose: 'Letters' });
    const res = await app.inject(url);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error });
  });
});
```

In `apps/api/test/integration/workbench-pg.test.ts` (import `EMPTY_BRIEF` from `@ih/shared`):

```ts
  it('lists brief versions oldest first and reads one', async () => {
    const projectId = await newProject();
    expect(await workbench.listBriefs(projectId)).toEqual([]);
    await workbench.saveBrief(projectId, { ...EMPTY_BRIEF, purpose: 'a' });
    await workbench.saveBrief(projectId, { ...EMPTY_BRIEF, purpose: 'b' });
    expect((await workbench.listBriefs(projectId)).map((b) => [b.version, b.body.purpose])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(await workbench.getBrief(projectId, 2)).toMatchObject({ version: 2, body: { purpose: 'b' } });
    expect(await workbench.getBrief(projectId, 3)).toBeNull();
  });
```

- [ ] **Step 2: Run** `npx vitest run --project api apps/api/test/workbench-briefs.test.ts` → FAIL (404 on `/briefs`: route missing).

- [ ] **Step 3: Implement**

`apps/api/src/workbench/repo.ts`, interface (after `saveBrief`):

```ts
  /** Every version, oldest first. */
  listBriefs(projectId: string): Promise<Brief[]>;
  getBrief(projectId: string, version: number): Promise<Brief | null>;
```

`MemoryWorkbenchRepo`:

```ts
  async listBriefs(projectId: string) {
    return this.briefs.filter((b) => b.projectId === projectId);
  }

  async getBrief(projectId: string, version: number) {
    return this.briefs.find((b) => b.projectId === projectId && b.version === version) ?? null;
  }
```

`PgWorkbenchRepo`:

```ts
  async listBriefs(projectId: string) {
    const { rows } = await this.pool.query<BriefRow>(
      `SELECT * FROM workbench_briefs WHERE project_id = $1 ORDER BY version`,
      [projectId],
    );
    return rows.map(toBrief);
  }

  async getBrief(projectId: string, version: number) {
    const { rows } = await this.pool.query<BriefRow>(
      `SELECT * FROM workbench_briefs WHERE project_id = $1 AND version = $2`,
      [projectId, version],
    );
    return rows[0] ? toBrief(rows[0]) : null;
  }
```

`apps/api/src/routes/workbench.ts` — import `BriefVersionViewSchema, briefVersions` from `@ih/shared`; next to the other param schemas:

```ts
const BriefVersionParams = z.object({ id: Id, version: z.coerce.number().int().positive() });
const BRIEF_VERSION_NOT_FOUND = '`project not found` or `brief version not found`.';
```

and after the `saveBrief` route:

```ts
  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/briefs',
    {
      schema: {
        tags: ['Samples & brief'],
        operationId: 'listBriefVersions',
        summary: "List the brief's versions",
        description: md`
          Every saved version of the brief, newest first. \`changedSections\` names the
          sections that differ from the previous version (for version 1, the sections with
          text); \`usedBy\` names the drafting stages whose newest accepted or partially
          accepted proposal was drafted from that version.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The versions, newest first.', z.array(BriefVersionViewSchema)),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      return briefVersions(
        await workbench.listBriefs(req.params.id),
        await workbench.listProposals(req.params.id),
      );
    },
  );

  app.get<{ Params: { id: string; version: string } }>(
    '/workbench/projects/:id/briefs/:version',
    {
      schema: {
        tags: ['Samples & brief'],
        operationId: 'getBriefVersion',
        summary: 'Get one version of the brief',
        description: md`
          The body of one saved version, for comparing versions (the Brief tab diffs two of
          them section by section).
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          version: z.string().describe('The brief version: 1, 2, …'),
        }),
        response: { 200: res('That version.', BriefSchema), 404: error(BRIEF_VERSION_NOT_FOUND) },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const params = BriefVersionParams.safeParse(req.params);
      const found = params.success
        ? await workbench.getBrief(params.data.id, params.data.version)
        : null;
      return found ?? reply.code(404).send({ error: 'brief version not found' });
    },
  );
```

- [ ] **Step 4: Run** `npx vitest run --project api apps/api/test/workbench-briefs.test.ts` → PASS; `npm run openapi`; `npx vitest run --project api` → PASS (openapi docs, conformance, the access sweep); `npm run typecheck`; eslint; prettier. With a throwaway Postgres, the integration test as in Task 3.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workbench/repo.ts apps/api/src/routes/workbench.ts apps/api/test/workbench-briefs.test.ts apps/api/test/integration/workbench-pg.test.ts docs/openapi.json
git commit -m "Workbench API: brief version history and one version's body

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: API — `ExportView.briefVersion`, `devSamples`, `bytes` (BR3)

**Files:**
- Modify: `packages/shared/src/bundle.ts`, `packages/shared/test/dto.test.ts`
- Modify: `apps/api/src/routes/workbench-bundle.ts`
- Modify: `apps/web/test/ExportPanel.test.tsx` (the `exp()` fixture only)
- Test: `apps/api/test/workbench-bundle.test.ts`
- Regenerate: `docs/openapi.json`

**Interfaces:**
- Produces: `BUNDLE_EXPORTED_EVENT = 'bundle exported'`; `ExportViewSchema` gains `briefVersion: number | null`, `devSamples: number | null`, `bytes: number | null`.
- Consumed by: `ExportPanel` (Task 9).

- [ ] **Step 1: Write the failing test** — `apps/api/test/workbench-bundle.test.ts` (import `BUNDLE_EXPORTED_EVENT` from `@ih/shared`), in `describe('export')`:

```ts
  it('tells the brief version, the dev samples and, once exported, the zip size', async () => {
    const { app, repo, add, start, list, finish } = await project();
    await add(1);
    await add(2);
    await add(3, 'holdout');
    await app.inject({ method: 'PUT', url: '/api/workbench/projects/letter/brief', payload: brief });

    const view = (await start()).json() as ExportView;
    expect(view).toMatchObject({ status: 'queued', briefVersion: 1, devSamples: 2, bytes: null });
    expect((await list())[0]).toEqual(view);

    // The size is only trusted once the export succeeded.
    repo.addEvent(view.jobId, 'info', BUNDLE_EXPORTED_EVENT, { samples: [], bytes: 3_100_000 });
    expect((await list())[0]!.bytes).toBeNull();
    finish(view.jobId);
    expect((await list())[0]).toMatchObject({ status: 'succeeded', bytes: 3_100_000 });
  });

  it('reads an export recorded without a brief as no brief', async () => {
    const { add, start } = await project();
    await add(1);
    expect((await start()).json()).toMatchObject({ briefVersion: null, devSamples: 1 });
  });
```

Update the fixtures: `exportView` in `packages/shared/test/dto.test.ts` gains `briefVersion: 3, devSamples: 6, bytes: 3_100_000`; `exp()` in `apps/web/test/ExportPanel.test.tsx` gains `briefVersion: null, devSamples: null, bytes: null` before `...overrides`.

- [ ] **Step 2: Run** `npx vitest run --project api apps/api/test/workbench-bundle.test.ts` → FAIL (`briefVersion` missing from the view).

- [ ] **Step 3: Implement**

`packages/shared/src/bundle.ts`:

```ts
/** The worker's last event of an export job; its data carries the zip's `bytes`. */
export const BUNDLE_EXPORTED_EVENT = 'bundle exported';
```

and in `ExportViewSchema` after `updatedAt`:

```ts
  /** The brief version the bundle carries (null: no brief saved). */
  briefVersion: z.number().int().nullable(),
  /** Dev samples (PDF or Word) the bundle carries; null when the export's params are unreadable. */
  devSamples: z.number().int().nullable(),
  /** The zip's size once the export succeeded; null before (or for an older export). */
  bytes: z.number().int().nullable(),
```

`apps/api/src/routes/workbench-bundle.ts` — import `BUNDLE_EXPORTED_EVENT` and `type JobEventRecord` (from `../repositories/types.js`); replace `exportView`:

```ts
/** What the export job's params say about the bundle (written by the export route). */
const ExportFacts = z.object({
  briefVersion: z.number().int().nullable().optional(),
  samples: z.array(z.unknown()).optional(),
});
const ExportedBytes = z.object({ bytes: z.number().int().nonnegative() });

const exportView = (
  j: ProjectJob,
  params: unknown,
  exported: JobEventRecord | undefined,
): ExportView => {
  const facts = ExportFacts.safeParse(params);
  const bytes = j.status === 'succeeded' ? ExportedBytes.safeParse(exported?.data) : null;
  return {
    jobId: j.id,
    status: j.status,
    error: j.error,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    briefVersion: facts.success ? (facts.data.briefVersion ?? null) : null,
    devSamples: facts.success && facts.data.samples ? facts.data.samples.length : null,
    bytes: bytes?.success ? bytes.data.bytes : null,
  };
};
```

In the export route, build the params once (`const params = { stage: 'export', …, samples };`), pass `params` to `repo.createExportJob(id, params)` and reply with `exportView(job, params, undefined)`. In `listExports`:

```ts
      const jobs = await repo.listExportJobs(req.params.id);
      const events = await repo.latestEvents(
        jobs.map((j) => j.id),
        [BUNDLE_EXPORTED_EVENT],
      );
      return Promise.all(
        jobs.map(async (j) =>
          exportView(j, await repo.getJobParams(j.id), events.find((e) => e.jobId === j.id)),
        ),
      );
```

Extend the `listExports` description: "Each carries the brief version and the number of dev samples it was built from, and, once \`succeeded\`, the zip's size in \`bytes\`."

- [ ] **Step 4: Run** `npx vitest run --project api apps/api/test/workbench-bundle.test.ts` → PASS; `npx vitest run --project shared`; `npx vitest run --project web apps/web/test/ExportPanel.test.tsx` → PASS (fixture only); `npm run openapi`; `npx vitest run --project api`; typecheck; eslint; prettier.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/bundle.ts packages/shared/test/dto.test.ts apps/api/src/routes/workbench-bundle.ts apps/api/test/workbench-bundle.test.ts apps/web/test/ExportPanel.test.tsx docs/openapi.json
git commit -m "Workbench API: exports tell their brief version, dev samples and zip size

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web — client methods, `fakeApi`, and the pure Samples/Brief helpers

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/client.test.ts`
- Create: `apps/web/src/workbench/samples.ts`, `apps/web/src/workbench/brief.ts`
- Test: `apps/web/test/samples-derive.test.ts`, `apps/web/test/brief-derive.test.ts` (create)

**Interfaces:**
- Produces:
  - `Api.listBriefVersions(projectId: string): Promise<BriefVersionView[]>` → `GET /workbench/projects/:id/briefs`; `Api.getBriefVersion(projectId: string, version: number): Promise<Brief>` → `GET …/briefs/:version`; `fakeApi` defaults `listBriefVersions: vi.fn(async () => [])`, `getBriefVersion` throws "not stubbed".
  - `samples.ts`: `DEV_TARGET = { min: 3, max: 8 }`, `HOLDOUT_MIN = 2` (copy guidance from handoff §1, not enforced), `formatBytes(bytes)`, `sampleSummary(samples): SampleSummary`, `sampleMeta(sample)`, `PREPARE_ERROR_TEXT`, `prepareNote(sample): { text; tone: 'muted' | 'info' | 'danger' } | null`, `holdoutLine(runs)`.
  - `brief.ts`: `BRIEF_LABEL`, `BRIEF_HINT`, `TEXT_SECTIONS`, `briefStatus(version, createdAt, changed, now)`, `versionChangeText(view)`, `csvPreview(text)` (on `parseCsv` from `results/csv.ts`), `openQuestions(survey, answers)`, `compareOf(version, versions)`.
- Consumed by: Tasks 7–9.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/samples-derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SampleView } from '@ih/shared';
import {
  formatBytes,
  holdoutLine,
  prepareNote,
  sampleMeta,
  sampleSummary,
} from '../src/workbench/samples.js';
import { sampleView } from './fake-api.js';

const triage = (pageCount: number, ocrPages: number[], ocrModel: string | null = 'local/olmocr') => ({
  sha256: 'abc',
  pageCount,
  ocrPages,
  chars: 100,
  ocrModel,
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [900, '900 B'],
    [96 * 1024, '96 KB'],
    [184_320, '180 KB'],
    [1.2 * 1024 * 1024, '1.2 MB'],
    [3_250_000, '3.1 MB'],
  ])('%i bytes read %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('sampleSummary', () => {
  it('counts ready samples per role, capacity and OCR pages', () => {
    const samples: SampleView[] = [
      sampleView({ role: 'dev', triage: triage(2, []) }),
      sampleView({ role: 'dev', triage: triage(3, [1, 2, 3]) }),
      sampleView({ role: 'dev', state: 'preparing', triage: null }),
      sampleView({ role: 'holdout', triage: triage(1, []) }),
      sampleView({ role: 'holdout', state: 'failed', triage: null }),
    ];
    expect(sampleSummary(samples)).toEqual({
      dev: { ready: 2, total: 3 },
      holdout: { ready: 1, total: 2 },
      used: 5,
      slots: 7,
      ocrPages: 3,
      pages: 6,
    });
  });

  it('never has negative slots', () => {
    const many = Array.from({ length: 13 }, () => sampleView());
    expect(sampleSummary(many).slots).toBe(0);
  });
});

describe('sampleMeta', () => {
  it.each<[string, Partial<SampleView>, string]>([
    ['ready with OCR', { triage: triage(3, [1, 2, 3]), sizeBytes: 1.2 * 1024 * 1024 }, '3 pages · 3 OCR · 1.2 MB · added for v1'],
    ['one page, no OCR', { triage: triage(1, []), sizeBytes: 96 * 1024, addedForVersion: 2 }, '1 page · 96 KB · added for v2'],
    ['not prepared', { triage: null, state: 'failed', sizeBytes: 88 * 1024, addedForVersion: 4 }, 'Pages unknown · 88 KB · added for v4'],
  ])('%s', (_name, o, text) => {
    expect(sampleMeta(sampleView(o))).toBe(text);
  });
});

describe('prepareNote', () => {
  it.each<[string, Partial<SampleView>, ReturnType<typeof prepareNote>]>([
    ['queued or just claimed', { state: 'preparing', triage: null, prepare: null }, { text: 'Preparing…', tone: 'info' }],
    [
      'text layer read',
      { state: 'preparing', triage: null, prepare: { stage: 'text', page: 3, of: 3 } },
      { text: 'Preparing — text layer read (3 pages)', tone: 'info' },
    ],
    [
      'OCR under way: the page in progress',
      { state: 'preparing', triage: null, prepare: { stage: 'ocr', page: 1, of: 3 } },
      { text: 'Preparing — OCR page 2 of 3', tone: 'info' },
    ],
    [
      'OCR done, writing the text',
      { state: 'preparing', triage: null, prepare: { stage: 'ocr', page: 3, of: 3 } },
      { text: 'Preparing — OCR page 3 of 3', tone: 'info' },
    ],
    [
      'password-protected',
      { state: 'failed', triage: null, prepareError: { code: 'password', message: 'PDF is password-protected' } },
      { text: 'PDF is password-protected. Remove the password and upload it again.', tone: 'danger' },
    ],
    [
      'too large to convert',
      { state: 'failed', triage: null, prepareError: { code: 'too_large', message: '413: …' } },
      { text: 'The file is too large to convert. Split it or make it smaller, then upload it again.', tone: 'danger' },
    ],
    [
      'damaged',
      { state: 'failed', triage: null, prepareError: { code: 'corrupt', message: 'PDF could not be read: EOF' } },
      { text: 'The file is damaged or not a readable PDF or Word document. Save or export it again and upload the new copy.', tone: 'danger' },
    ],
    [
      'any other reason, in its own words',
      { state: 'failed', triage: null, error: 'OCR down', prepareError: { code: 'other', message: 'OCR down' } },
      { text: 'Could not prepare it: OCR down', tone: 'danger' },
    ],
    ['ready, text layer only', { triage: triage(2, []) }, null],
    ['scanned', { triage: triage(3, [1, 2, 3]) }, { text: 'Scanned — all 3 pages read by OCR (local/olmocr)', tone: 'muted' }],
    ['one scanned page', { triage: triage(1, [1]) }, { text: 'Scanned — its page read by OCR (local/olmocr)', tone: 'muted' }],
    ['some pages', { triage: triage(4, [2, 3]) }, { text: 'Pages 2, 3 read by OCR (local/olmocr)', tone: 'muted' }],
    ['one page, no model recorded', { triage: triage(4, [2], null) }, { text: 'Page 2 read by OCR', tone: 'muted' }],
  ])('%s', (_name, o, note) => {
    expect(prepareNote(sampleView(o))).toEqual(note);
  });
});

describe('holdoutLine', () => {
  it.each([
    [0, 'Not used in a holdout evaluation yet · never sent to a model'],
    [1, 'Used in 1 holdout evaluation · never sent to a model'],
    [3, 'Used in 3 holdout evaluations · never sent to a model'],
  ])('%i runs', (runs, text) => {
    expect(holdoutLine(runs)).toBe(text);
  });
});
```

`apps/web/test/brief-derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { BriefVersionView, SurveyBody } from '@ih/shared';
import {
  briefStatus,
  compareOf,
  csvPreview,
  openQuestions,
  versionChangeText,
} from '../src/workbench/brief.js';

const now = Date.parse('2026-10-13T12:00:00.000Z');
const view = (version: number, o: Partial<BriefVersionView> = {}): BriefVersionView => ({
  version,
  createdAt: '2026-10-11T12:00:00.000Z',
  changedSections: [],
  usedBy: [],
  ...o,
});

describe('briefStatus', () => {
  it.each([
    [0, 'Saved as v3 · 2 days ago'],
    [1, 'Saved as v3 · 2 days ago · 1 field changed since'],
    [2, 'Saved as v3 · 2 days ago · 2 fields changed since'],
  ])('%i unsaved', (changed, text) => {
    expect(briefStatus(3, '2026-10-11T12:00:00.000Z', changed, now)).toBe(text);
  });

  it('lower-cases the age mid-sentence', () => {
    expect(briefStatus(1, '2026-10-12T11:00:00.000Z', 0, now)).toBe('Saved as v1 · yesterday');
    expect(briefStatus(1, '2026-10-13T11:59:30.000Z', 0, now)).toBe('Saved as v1 · just now');
  });
});

describe('versionChangeText', () => {
  it.each<[string, BriefVersionView, string]>([
    ['the first', view(1, { changedSections: ['purpose'] }), 'First brief'],
    ['one section', view(2, { changedSections: ['exampleOutput'] }), 'Example output'],
    ['several', view(3, { changedSections: ['variants', 'rules'] }), 'Variants, rules'],
    ['answers', view(4, { changedSections: ['answers'] }), 'Survey answers'],
    ['nothing (saved twice)', view(5), 'No changes'],
  ])('%s', (_name, v, text) => {
    expect(versionChangeText(v)).toBe(text);
  });
});

describe('csvPreview', () => {
  it.each<[string, string, ReturnType<typeof csvPreview>]>([
    ['empty', '', null],
    ['a header only', 'a,b', null],
    ['one column', 'a\n1', null],
    [
      'quoted cells, blank lines dropped',
      'invoice,description,amount\nINV-1,"Nitrile gloves, M (100)",85.00\n\n',
      { header: ['invoice', 'description', 'amount'], rows: [['INV-1', 'Nitrile gloves, M (100)', '85.00']] },
    ],
  ])('%s', (_name, text, preview) => {
    expect(csvPreview(text)).toEqual(preview);
  });
});

describe('openQuestions', () => {
  const survey: SurveyBody = {
    summary: '',
    structure: [],
    variants: [],
    candidates: [],
    questions: [
      { question: 'Which copy?', why: '' },
      { question: 'Date format?', why: '' },
      { question: 'Currency?', why: '' },
    ],
  };
  it('counts questions without a saved answer', () => {
    expect(
      openQuestions(survey, [
        { question: 'Which copy?', answer: 'Executed' },
        { question: 'Date format?', answer: '  ' },
      ]),
    ).toBe(2);
  });
});

describe('compareOf', () => {
  const versions = [view(3), view(2), view(1)];
  it.each<[number, [number, number] | null]>([
    [3, [2, 3]],
    [2, [2, 3]],
    [1, [1, 3]],
  ])('v%i', (version, pair) => {
    expect(compareOf(version, versions)).toEqual(pair);
  });
  it('has nothing to compare with one version', () => {
    expect(compareOf(1, [view(1)])).toBeNull();
  });
});
```

`apps/web/test/client.test.ts`:

```ts
describe('http api: brief versions', () => {
  it('lists versions and reads one', async () => {
    const fetchMock = vi.fn(async () => respond(200, []));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listBriefVersions('letter');
    await api.getBriefVersion('letter', 2);
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([url]) => url);
    expect(urls).toEqual([
      '/api/workbench/projects/letter/briefs',
      '/api/workbench/projects/letter/briefs/2',
    ]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/samples-derive.test.ts apps/web/test/brief-derive.test.ts apps/web/test/client.test.ts` → FAIL (modules and methods missing).

- [ ] **Step 3: Implement**

`apps/web/src/api/client.ts`: import `BriefVersionView`; in the `Api` interface next to `saveBrief`:

```ts
  listBriefVersions(projectId: string): Promise<BriefVersionView[]>;
  getBriefVersion(projectId: string, version: number): Promise<Brief>;
```

and in `createHttpApi`:

```ts
    listBriefVersions: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/briefs`).then(json<BriefVersionView[]>),
    getBriefVersion: (id, version) =>
      apiFetch(`${base}/workbench/projects/${id}/briefs/${version}`).then(json<Brief>),
```

`apps/web/test/fake-api.ts`, next to `saveBrief`:

```ts
    listBriefVersions: vi.fn(async () => []),
    getBriefVersion: vi.fn(async () => {
      throw new Error('getBriefVersion not stubbed');
    }),
```

`apps/web/src/workbench/samples.ts`:

```ts
import { MAX_SAMPLES, type PrepareError, type SampleView } from '@ih/shared';

/** Copy guidance (handoff §1), not enforced: 3–8 dev samples; the gate wants ≥ 2 holdout. */
export const DEV_TARGET = { min: 3, max: 8 } as const;
export const HOLDOUT_MIN = 2;

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface SampleSummary {
  dev: { ready: number; total: number };
  holdout: { ready: number; total: number };
  used: number;
  slots: number;
  ocrPages: number;
  pages: number;
}

/** The four summary cards: ready per role, capacity, OCR'd pages of the prepared pages. */
export function sampleSummary(samples: readonly SampleView[]): SampleSummary {
  const count = (role: SampleView['role']) => ({
    ready: samples.filter((s) => s.role === role && s.state === 'ready').length,
    total: samples.filter((s) => s.role === role).length,
  });
  const triaged = samples.flatMap((s) => (s.triage ? [s.triage] : []));
  return {
    dev: count('dev'),
    holdout: count('holdout'),
    used: samples.length,
    slots: Math.max(0, MAX_SAMPLES - samples.length),
    ocrPages: triaged.reduce((n, t) => n + t.ocrPages.length, 0),
    pages: triaged.reduce((n, t) => n + t.pageCount, 0),
  };
}

/** "3 pages · 3 OCR · 1.2 MB · added for v1". */
export function sampleMeta(s: SampleView): string {
  const parts = [s.triage ? plural(s.triage.pageCount, 'page') : 'Pages unknown'];
  if (s.triage && s.triage.ocrPages.length > 0) parts.push(`${s.triage.ocrPages.length} OCR`);
  parts.push(formatBytes(s.sizeBytes), `added for v${s.addedForVersion}`);
  return parts.join(' · ');
}

/** Plain words for a failed preparation (handoff §1); `other` shows the worker's message. */
export const PREPARE_ERROR_TEXT: Record<Exclude<PrepareError['code'], 'other'>, string> = {
  password: 'PDF is password-protected. Remove the password and upload it again.',
  corrupt:
    'The file is damaged or not a readable PDF or Word document. Save or export it again and upload the new copy.',
  too_large:
    'The file is too large to convert. Split it or make it smaller, then upload it again.',
};

export type NoteTone = 'muted' | 'info' | 'danger';

/** The row's one-line note: live progress, the failure reason, or how OCR read it. */
export function prepareNote(s: SampleView): { text: string; tone: NoteTone } | null {
  if (s.state === 'preparing') {
    const p = s.prepare;
    if (!p) return { text: 'Preparing…', tone: 'info' };
    if (p.stage === 'text') {
      return { text: `Preparing — text layer read (${plural(p.of, 'page')})`, tone: 'info' };
    }
    return { text: `Preparing — OCR page ${Math.min(p.page + 1, p.of)} of ${p.of}`, tone: 'info' };
  }
  if (s.state === 'failed') {
    const err: PrepareError = s.prepareError ?? {
      code: 'other',
      message: s.error ?? 'preparation failed',
    };
    return {
      text:
        err.code === 'other' ? `Could not prepare it: ${err.message}` : PREPARE_ERROR_TEXT[err.code],
      tone: 'danger',
    };
  }
  const t = s.triage;
  if (!t || t.ocrPages.length === 0) return null;
  const by = t.ocrModel ? ` (${t.ocrModel})` : '';
  if (t.ocrPages.length === t.pageCount) {
    const which = t.pageCount === 1 ? 'its page' : `all ${t.pageCount} pages`;
    return { text: `Scanned — ${which} read by OCR${by}`, tone: 'muted' };
  }
  const label = t.ocrPages.length === 1 ? 'Page' : 'Pages';
  return { text: `${label} ${t.ocrPages.join(', ')} read by OCR${by}`, tone: 'muted' };
}

/** Holdout rows (handoff §1): how often the gate used it; never sent to a model (§0.3). */
export function holdoutLine(runs: number): string {
  const used =
    runs === 0 ? 'Not used in a holdout evaluation yet' : `Used in ${plural(runs, 'holdout evaluation')}`;
  return `${used} · never sent to a model`;
}
```

`apps/web/src/workbench/brief.ts`:

```ts
import {
  BRIEF_SECTIONS,
  type BriefBody,
  type BriefSection,
  type BriefVersionView,
  type SurveyBody,
} from '@ih/shared';
import { relativeTime } from '../jobs/derive.js';
import { parseCsv } from '../results/csv.js';

export type TextSection = Exclude<BriefSection, 'answers'>;

export const BRIEF_LABEL: Record<BriefSection, string> = {
  purpose: 'Purpose',
  outputs: 'Outputs wanted',
  glossary: 'Glossary',
  exampleOutput: 'Example output',
  variants: 'Variants',
  rules: 'Rules',
  answers: 'Survey answers',
};

export const BRIEF_HINT: Record<TextSection, string> = {
  purpose: 'What the outputs are for and who consumes them.',
  outputs: 'Must-have and nice-to-have values, in plain words.',
  glossary: 'Domain terms and abbreviations.',
  exampleOutput: 'A mock CSV or a few example rows — shown as a table below.',
  variants: 'Known issuers, layouts, languages, blank vs executed copies.',
  rules: 'For example: placeholders are null; use the executed copy; dates are DMY.',
};

export const TEXT_SECTIONS = BRIEF_SECTIONS.filter((s): s is TextSection => s !== 'answers');

/** "Saved as v3 · 2 days ago · 1 field changed since" (handoff §2). */
export function briefStatus(version: number, createdAt: string, changed: number, now: number) {
  const age = relativeTime(createdAt, now);
  const parts = [`Saved as v${version}`, age.charAt(0).toLowerCase() + age.slice(1)];
  if (changed > 0) parts.push(`${changed} ${changed === 1 ? 'field' : 'fields'} changed since`);
  return parts.join(' · ');
}

/** What a version changed, for the Versions list. */
export function versionChangeText(v: BriefVersionView): string {
  if (v.version === 1) return 'First brief';
  if (v.changedSections.length === 0) return 'No changes';
  const [first, ...rest] = v.changedSections.map((s) => BRIEF_LABEL[s]);
  return [first!, ...rest.map((l) => l.toLowerCase())].join(', ');
}

/** The example output as a table: a header and at least one row of two or more columns. */
export function csvPreview(text: string): { header: string[]; rows: string[][] } | null {
  const lines = parseCsv(text.trim()).filter((r) => r.some((c) => c.trim() !== ''));
  if (lines.length < 2 || lines[0]!.length < 2) return null;
  return { header: lines[0]!, rows: lines.slice(1) };
}

/** Survey questions the brief has no answer to yet. */
export function openQuestions(survey: SurveyBody, answers: BriefBody['answers']): number {
  return survey.questions.filter(
    (q) => !answers.some((a) => a.question === q.question && a.answer.trim() !== ''),
  ).length;
}

/**
 * What *Compare* on a version compares: an older version with the current one; the current
 * one with its predecessor; null with a single version. `versions` is newest first.
 */
export function compareOf(
  version: number,
  versions: readonly BriefVersionView[],
): [number, number] | null {
  const current = versions[0]?.version;
  if (current === undefined) return null;
  if (version !== current) return [version, current];
  const previous = versions[1]?.version;
  return previous === undefined ? null : [previous, current];
}
```

- [ ] **Step 4: Run** `npx vitest run --project web apps/web/test/samples-derive.test.ts apps/web/test/brief-derive.test.ts apps/web/test/client.test.ts` → PASS; typecheck; eslint; prettier (the long lines in the test tables get wrapped).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/test/client.test.ts apps/web/src/workbench/samples.ts apps/web/src/workbench/brief.ts apps/web/test/samples-derive.test.ts apps/web/test/brief-derive.test.ts
git commit -m "Workbench web: brief version calls and the Samples/Brief derivations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Samples tab — summary cards, drop zone, Dev/Holdout groups, live progress, text preview

**Files:**
- Modify: `apps/web/src/workbench/SamplesTab.tsx` (rewrite), `apps/web/src/workbench/SampleText.tsx` (`paged` mode), `apps/web/src/workbench/ProjectPage.tsx` (Samples description), `apps/web/src/styles/stages.css`
- Test: `apps/web/test/SamplesTab.test.tsx` (the SamplesTab tests rewritten; the three `SampleText` mark tests at the end stay as they are), `apps/web/test/SampleText.test.tsx`

**Interfaces:**
- Consumes: `sampleSummary`, `sampleMeta`, `prepareNote`, `holdoutLine`, `formatBytes`, `DEV_TARGET`, `HOLDOUT_MIN`, `plural` (Task 6); `Meter`, `Segmented`, `Icon`, `SampleTag` (PR 1); `isSourceFile`, `SOURCE_ACCEPT`.
- Produces: `SampleText` gains `paged?: boolean` (per-page chips `aria-pressed`, named "Page N" / "Page N OCR"; one page shown with its `[page N]` marker). `SamplesTab` props unchanged.
- Accessible names the tests rely on: summary cards are regions "Dev samples", "Holdout samples", "Capacity", "OCR"; the input "Add sample documents"; the switch group "Add as"; groups are lists "Dev samples" / "Holdout samples"; each row is a `listitem` named by its file name; per row: button "Show text of <file>" (`aria-pressed`), group "Role of <file>" with buttons "Dev"/"Holdout", "Retry <file>" (failed), "Remove <file>"; the preview is region "Text preview".

- [ ] **Step 1: Write the failing tests** — replace the SamplesTab tests (everything in `describe('SamplesTab')` before "marks where a section starts on its page") with:

```tsx
const tab = (api = fakeApi()) =>
  render(<SamplesTab api={api} projectId="letter" pollMs={60_000} />);
const row = (filename: string) => screen.getByRole('listitem', { name: filename });
const triage = (pageCount: number, ocrPages: number[]) => ({
  sha256: 'abc',
  pageCount,
  ocrPages,
  chars: 1412,
  ocrModel: 'local/olmocr',
});

describe('SamplesTab', () => {
  it('summarises readiness, capacity and OCR pages', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'a.pdf', triage: triage(2, []) }),
          sampleView({ filename: 'b.pdf', triage: triage(3, [1, 2, 3]) }),
          sampleView({ filename: 'c.pdf', state: 'preparing', triage: null }),
          sampleView({ filename: 'h.pdf', role: 'holdout', triage: triage(1, []) }),
        ]),
      }),
    );
    const dev = await screen.findByRole('region', { name: 'Dev samples' });
    expect(dev).toHaveTextContent('2ready of 3');
    expect(dev).toHaveTextContent('3–8 recommended');
    expect(screen.getByRole('region', { name: 'Holdout samples' })).toHaveTextContent(
      'Add 1 more for the publish gate (≥ 2)',
    );
    expect(screen.getByRole('region', { name: 'Capacity' })).toHaveTextContent('8 slots left');
    expect(screen.getByRole('region', { name: 'OCR' })).toHaveTextContent('3of 6 pages');
    expect(screen.getByRole('img', { name: 'Dev samples ready: 67%' })).toBeInTheDocument();
  });

  it('lists dev then holdout samples with status, meta and notes', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'h.pdf', role: 'holdout', holdoutRuns: 3, triage: triage(2, []) }),
          sampleView({ filename: 'scan.pdf', triage: triage(3, [1, 2, 3]), sizeBytes: 1.2 * 1024 * 1024 }),
          sampleView({
            filename: 'wip.pdf',
            state: 'preparing',
            triage: null,
            prepare: { stage: 'ocr', page: 1, of: 3 },
          }),
          sampleView({
            filename: 'locked.pdf',
            state: 'failed',
            triage: null,
            error: 'PDF is password-protected',
            prepareError: { code: 'password', message: 'PDF is password-protected' },
          }),
        ]),
      }),
    );
    const devList = await screen.findByRole('list', { name: 'Dev samples' });
    expect(within(devList).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual([
      'scan.pdf',
      'wip.pdf',
      'locked.pdf',
    ]);
    expect(row('scan.pdf')).toHaveTextContent('Ready');
    expect(row('scan.pdf')).toHaveTextContent('3 pages · 3 OCR · 1.2 MB · added for v1');
    expect(row('scan.pdf')).toHaveTextContent('Scanned — all 3 pages read by OCR (local/olmocr)');
    expect(within(row('scan.pdf')).getByLabelText('3 pages')).toHaveTextContent('3');
    expect(row('wip.pdf')).toHaveTextContent('Preparing — OCR page 2 of 3');
    expect(within(row('wip.pdf')).getByLabelText('Pages unknown')).toHaveTextContent('?');
    expect(row('locked.pdf')).toHaveTextContent('Failed');
    expect(row('locked.pdf')).toHaveTextContent(
      'PDF is password-protected. Remove the password and upload it again.',
    );
    const holdout = screen.getByRole('list', { name: 'Holdout samples' });
    expect(within(holdout).getByRole('listitem', { name: 'h.pdf' })).toHaveTextContent(
      'Used in 3 holdout evaluations · never sent to a model',
    );
    expect(row('scan.pdf')).not.toHaveTextContent('holdout evaluation');
  });

  it('says "1 holdout evaluation" in the singular', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'h.pdf', role: 'holdout', holdoutRuns: 1 }),
        ]),
      }),
    );
    expect(await screen.findByRole('listitem', { name: 'h.pdf' })).toHaveTextContent(
      /Used in 1 holdout evaluation(?!s)/,
    );
  });

  it('uploads each chosen file with the Add as role and reports failures', async () => {
    const uploadSample = vi
      .fn()
      .mockResolvedValueOnce(sampleView())
      .mockRejectedValueOnce(new Error('this PDF is already a sample of the project'))
      .mockResolvedValue(sampleView());
    const api = fakeApi({ uploadSample });
    tab(api);
    const files = [
      new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' }),
      new File(['%PDF-2'], 'two.pdf', { type: 'application/pdf' }),
    ];
    await userEvent.upload(await screen.findByLabelText('Add sample documents'), files);
    expect(uploadSample).toHaveBeenCalledWith('letter', files[0], 'dev');
    expect(uploadSample).toHaveBeenCalledWith('letter', files[1], 'dev');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'two.pdf: this PDF is already a sample of the project',
    );

    const addAs = screen.getByRole('group', { name: 'Add as' });
    await userEvent.click(within(addAs).getByRole('button', { name: 'Holdout' }));
    expect(within(addAs).getByRole('button', { name: 'Holdout' })).toHaveAttribute('aria-pressed', 'true');
    const three = new File(['%PDF-3'], 'three.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('Add sample documents'), three);
    expect(uploadSample).toHaveBeenLastCalledWith('letter', three, 'holdout');
  });

  it('uploads Word documents too', async () => {
    const uploadSample = vi.fn().mockResolvedValue(sampleView());
    tab(fakeApi({ uploadSample }));
    const word = new File(['PK'], 'letter.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await userEvent.upload(await screen.findByLabelText('Add sample documents'), word);
    expect(uploadSample).toHaveBeenCalledWith('letter', word, 'dev');
  });

  it('takes dropped files and skips what is not a PDF or Word document', async () => {
    const uploadSample = vi.fn().mockResolvedValue(sampleView());
    tab(fakeApi({ uploadSample }));
    const zone = (await screen.findByText(/Drop sample files here/)).closest('.drop-zone')!;
    const pdf = new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' });
    const txt = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(zone, { dataTransfer: { files: [pdf, txt] } });
    await waitFor(() => expect(uploadSample).toHaveBeenCalledWith('letter', pdf, 'dev'));
    expect(uploadSample).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert')).toHaveTextContent('notes.txt: not a PDF or Word document');
  });

  it('tells the page after a successful upload, role change or removal, not after a failed upload', async () => {
    const good = sampleView({ filename: 'good.pdf' });
    const uploadSample = vi
      .fn()
      .mockRejectedValueOnce(new Error('this PDF is already a sample of the project'))
      .mockResolvedValue(sampleView());
    const api = fakeApi({
      listSamples: vi.fn(async () => [good]),
      uploadSample,
      setSampleRole: vi.fn(async () => ({ ...good, role: 'holdout' as const })),
    });
    const onChanged = vi.fn();
    render(<SamplesTab api={api} projectId="letter" pollMs={60_000} onChanged={onChanged} />);
    await screen.findByRole('listitem', { name: 'good.pdf' });
    const file = new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' });

    await userEvent.upload(screen.getByLabelText('Add sample documents'), file);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    await userEvent.upload(screen.getByLabelText('Add sample documents'), file);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    const role = within(row('good.pdf')).getByRole('group', { name: 'Role of good.pdf' });
    await userEvent.click(within(role).getByRole('button', { name: 'Holdout' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));

    await userEvent.click(within(row('good.pdf')).getByRole('button', { name: 'Remove good.pdf' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3));
  });

  it('changes a role, retries a failed preparation and removes a sample', async () => {
    const failed = sampleView({ filename: 'bad.pdf', state: 'failed', error: 'OCR down', triage: null });
    const good = sampleView({ filename: 'good.pdf' });
    const api = fakeApi({
      listSamples: vi.fn(async () => [good, failed]),
      setSampleRole: vi.fn(async () => ({ ...good, role: 'holdout' as const })),
    });
    tab(api);
    expect(await screen.findByRole('listitem', { name: 'bad.pdf' })).toHaveTextContent(
      'Could not prepare it: OCR down',
    );
    const role = within(row('good.pdf')).getByRole('group', { name: 'Role of good.pdf' });
    expect(within(role).getByRole('button', { name: 'Dev' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(role).getByRole('button', { name: 'Dev' }));
    expect(api.setSampleRole).not.toHaveBeenCalled(); // already dev
    await userEvent.click(within(role).getByRole('button', { name: 'Holdout' }));
    expect(api.setSampleRole).toHaveBeenCalledWith('letter', good.id, 'holdout');

    expect(within(row('good.pdf')).queryByRole('button', { name: /Retry/ })).toBeNull();
    await userEvent.click(within(row('bad.pdf')).getByRole('button', { name: 'Retry bad.pdf' }));
    expect(api.retryJob).toHaveBeenCalledWith(failed.prepareJobId);

    await userEvent.click(within(row('good.pdf')).getByRole('button', { name: 'Remove good.pdf' }));
    expect(api.removeSample).toHaveBeenCalledWith('letter', good.id);
  });

  it('previews the first ready dev sample, page by page, and switches on selection', async () => {
    const a = sampleView({ filename: 'a.pdf', triage: triage(2, [2]) });
    const b = sampleView({ filename: 'b.pdf', triage: triage(1, []) });
    const wip = sampleView({ filename: 'wip.pdf', state: 'preparing', triage: null });
    const getSampleText = vi.fn(async (_p: string, id: string) => ({
      sha256: 'abc',
      pages:
        id === a.id
          ? [
              { number: 1, text: 'PROTOCOL APPROVAL', ocr: false },
              { number: 2, text: 'Batch 1 results', ocr: true },
            ]
          : [{ number: 1, text: 'MEMO', ocr: false }],
    }));
    tab(fakeApi({ listSamples: vi.fn(async () => [wip, a, b]), getSampleText }));
    const preview = await screen.findByRole('region', { name: 'Text preview' });
    expect(within(preview).getByRole('heading', { name: 'a.pdf' })).toBeInTheDocument();
    expect(preview).toHaveTextContent('1,412 characters');
    expect(await within(preview).findByRole('region', { name: 'Page 1' })).toHaveTextContent(
      '[page 1] PROTOCOL APPROVAL',
    );
    await userEvent.click(within(preview).getByRole('button', { name: 'Page 2 OCR' }));
    expect(within(preview).getByRole('region', { name: 'Page 2' })).toHaveTextContent('Batch 1 results');
    expect(preview).toHaveTextContent('Read by OCR (local/olmocr) · cached per PDF hash');
    expect(screen.getByRole('button', { name: 'Show text of a.pdf' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Show text of wip.pdf' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Show text of b.pdf' }));
    expect(await within(preview).findByText(/MEMO/)).toBeInTheDocument();
    expect(getSampleText).toHaveBeenLastCalledWith('letter', b.id);
  });
});
```

Add `fireEvent` to the Testing Library import. In `apps/web/test/SampleText.test.tsx` add:

```tsx
  it('shows one page at a time with per-page chips in paged mode', async () => {
    const api = fakeApi({
      getSampleText: vi.fn(async () => ({
        sha256: 'abc',
        pages: [
          { number: 1, text: 'HEADER', ocr: false },
          { number: 2, text: 'scanned', ocr: true },
        ],
      })),
    });
    render(<SampleText api={api} projectId="letter" sampleId="s1" paged />);
    const chips = await screen.findByRole('group', { name: 'Pages' });
    expect(within(chips).getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Page 1' })).toHaveTextContent('[page 1] HEADER');
    expect(screen.queryByRole('region', { name: 'Page 2' })).toBeNull();
    await userEvent.click(within(chips).getByRole('button', { name: 'Page 2 OCR' }));
    expect(screen.getByRole('region', { name: 'Page 2' })).toHaveTextContent('[page 2] scanned');
  });
```

(Import `within` and `userEvent` there if not already imported.)

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/SamplesTab.test.tsx apps/web/test/SampleText.test.tsx` → FAIL (no regions/lists; `paged` unknown).

- [ ] **Step 3: Implement**

`apps/web/src/workbench/SampleText.tsx` — add `paged = false` to the props (`/** One page at a time with page chips (Samples preview); off: every page (Sections). */ paged?: boolean;`), a `const [page, setPage] = useState(1);`, and before the existing return:

```tsx
  if (paged) {
    const current = text.pages.find((p) => p.number === page) ?? text.pages[0];
    return (
      <div className="sample-text paged">
        <div role="group" aria-label="Pages" className="page-chips">
          {text.pages.map((p) => (
            <button
              key={p.number}
              type="button"
              aria-pressed={p.number === current?.number}
              onClick={() => setPage(p.number)}
            >
              Page {p.number}
              {p.ocr && <span className="ocr-flag"> OCR</span>}
            </button>
          ))}
        </div>
        {current && (
          <section aria-label={`Page ${current.number}`}>
            <PageBody
              text={`[page ${current.number}]\n${current.text}`}
              marks={(marks ?? []).filter((m) => m.page === current.number)}
            />
          </section>
        )}
      </div>
    );
  }
```

`apps/web/src/workbench/SamplesTab.tsx` — full rewrite:

```tsx
import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { MAX_SAMPLES, type SampleRole, type SampleView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { isSourceFile, SOURCE_ACCEPT } from '../documents.js';
import { Icon } from '../ui/Icon.js';
import { Meter } from '../ui/Meter.js';
import { Segmented } from '../ui/Segmented.js';
import { SampleText } from './SampleText.js';
import {
  DEV_TARGET,
  HOLDOUT_MIN,
  holdoutLine,
  plural,
  prepareNote,
  sampleMeta,
  sampleSummary,
} from './samples.js';
import { SampleTag } from './tags.js';

const ROLES = [
  { value: 'dev', label: 'Dev' },
  { value: 'holdout', label: 'Holdout' },
] as const;
const PILL = {
  ready: { label: 'Ready', tone: 'ok' },
  preparing: { label: 'Preparing', tone: 'info' },
  failed: { label: 'Failed', tone: 'danger' },
} as const;
const GROUP = {
  dev: { title: 'Development', note: 'the model reads these while drafting' },
  holdout: { title: 'Holdout', note: 'only used to score the draft for publishing' },
} as const;

function SummaryCard({
  title,
  figure,
  unit,
  meter,
  foot,
  footTone,
}: {
  title: string;
  figure: number;
  unit: string;
  meter: { label: string; value: number; tone: 'ok' | 'accent' | 'warn' | 'skip' };
  foot: string;
  footTone?: 'warn';
}) {
  return (
    <section className="card summary-card" aria-label={title}>
      <h3>{title}</h3>
      <p className="summary-figure">
        <strong>{figure}</strong>
        <span className="muted">{unit}</span>
      </p>
      <Meter label={meter.label} value={meter.value} tone={meter.tone} />
      <p className={footTone ? 'summary-foot tone-text-warn' : 'summary-foot muted'}>{foot}</p>
    </section>
  );
}

/** Upload, triage and roles of a project's samples (PDF or Word). Polls while any is preparing. */
export function SamplesTab({
  api,
  projectId,
  pollMs,
  onChanged,
}: {
  api: Api;
  projectId: string;
  pollMs: number;
  /** Called after a successful upload, retry, role change or removal. */
  onChanged?: () => void;
}) {
  const [samples, setSamples] = useState<SampleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [addAs, setAddAs] = useState<SampleRole>('dev');
  const [over, setOver] = useState(false);

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
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    }
    await refresh();
  };

  const upload = async (files: File[]) => {
    const failures = files
      .filter((f) => !isSourceFile(f))
      .map((f) => `${f.name}: not a PDF or Word document`);
    setUploading(true);
    let uploaded = 0;
    for (const file of files.filter(isSourceFile)) {
      try {
        await api.uploadSample(projectId, file, addAs);
        uploaded += 1;
      } catch (err) {
        failures.push(`${file.name}: ${(err as Error).message}`);
      }
    }
    setUploading(false);
    setError(failures.length ? failures.join('; ') : null);
    if (uploaded > 0) onChanged?.();
    await refresh();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!uploading) void upload([...e.dataTransfer.files]);
  };

  if (samples === null) {
    return error ? <p role="alert">{error}</p> : <p>Loading…</p>;
  }
  const summary = sampleSummary(samples);
  const ready = samples.filter((s) => s.state === 'ready');
  const shown =
    ready.find((s) => s.id === selected) ?? ready.find((s) => s.role === 'dev') ?? ready[0] ?? null;
  const devOk = summary.dev.total >= DEV_TARGET.min && summary.dev.total <= DEV_TARGET.max;
  const gateOk = summary.holdout.ready >= HOLDOUT_MIN;

  return (
    <div className="samples-tab">
      <div className="summary-cards">
        <SummaryCard
          title="Dev samples"
          figure={summary.dev.ready}
          unit={`ready of ${summary.dev.total}`}
          meter={{
            label: 'Dev samples ready',
            value: summary.dev.total ? summary.dev.ready / summary.dev.total : 0,
            tone: 'ok',
          }}
          foot={`${DEV_TARGET.min}–${DEV_TARGET.max} recommended`}
          footTone={devOk ? undefined : 'warn'}
        />
        <SummaryCard
          title="Holdout samples"
          figure={summary.holdout.ready}
          unit="ready"
          meter={{
            label: 'Holdout samples for the gate',
            value: Math.min(1, summary.holdout.ready / HOLDOUT_MIN),
            tone: 'skip',
          }}
          foot={
            gateOk
              ? `Enough for the publish gate (≥ ${HOLDOUT_MIN})`
              : `Add ${HOLDOUT_MIN - summary.holdout.ready} more for the publish gate (≥ ${HOLDOUT_MIN})`
          }
          footTone={gateOk ? undefined : 'warn'}
        />
        <SummaryCard
          title="Capacity"
          figure={summary.used}
          unit={`of ${MAX_SAMPLES}`}
          meter={{ label: 'Capacity used', value: summary.used / MAX_SAMPLES, tone: 'accent' }}
          foot={`${plural(summary.slots, 'slot')} left`}
        />
        <SummaryCard
          title="OCR"
          figure={summary.ocrPages}
          unit={`of ${summary.pages} pages`}
          meter={{
            label: 'Pages read by OCR',
            value: summary.pages ? summary.ocrPages / summary.pages : 0,
            tone: 'accent',
          }}
          foot="Pages without a text layer"
        />
      </div>

      <div
        className={`drop-zone sample-drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span className="drop-icon" aria-hidden="true">
          <Icon name="upload" size={20} />
        </span>
        <div className="drop-text">
          <strong>
            Drop sample files here or{' '}
            <label className="browse-link">
              browse
              <input
                type="file"
                className="visually-hidden"
                aria-label="Add sample documents"
                accept={SOURCE_ACCEPT}
                multiple
                disabled={uploading || summary.slots === 0}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (files.length) void upload(files);
                }}
              />
            </label>
          </strong>
          <small>
            PDF or Word. Each is prepared in the background: text extraction, then OCR for pages
            without a text layer · {summary.slots} of {MAX_SAMPLES} slots left
          </small>
        </div>
        <div className="drop-role">
          <span className="muted">Add as</span>
          <Segmented label="Add as" options={ROLES} value={addAs} onChange={setAddAs} />
        </div>
      </div>
      {error && <p role="alert">{error}</p>}

      <div className="samples-layout">
        <div className="sample-groups">
          {(['dev', 'holdout'] as const).map((role) => {
            const rows = samples.filter((s) => s.role === role);
            return (
              <section key={role} className="card sample-group" aria-labelledby={`samples-${role}`}>
                <div className={`sample-group-head tone-${role === 'dev' ? 'info' : 'skip'}`}>
                  <SampleTag role={role} />
                  <h3 id={`samples-${role}`}>{GROUP[role].title}</h3>
                  <span className="muted">
                    {plural(rows.length, 'sample')} · {GROUP[role].note}
                  </span>
                </div>
                {rows.length === 0 ? (
                  <p className="muted sample-empty">
                    No {role} samples yet. Add some with “Add as {role === 'dev' ? 'Dev' : 'Holdout'}”.
                  </p>
                ) : (
                  <ul aria-label={role === 'dev' ? 'Dev samples' : 'Holdout samples'}>
                    {rows.map((s) => {
                      const note = prepareNote(s);
                      const pill = PILL[s.state];
                      const isShown = shown?.id === s.id;
                      return (
                        <li
                          key={s.id}
                          aria-label={s.filename}
                          className={`sample-row${isShown ? ' selected' : ''}`}
                        >
                          <span
                            className="page-badge"
                            aria-label={s.triage ? plural(s.triage.pageCount, 'page') : 'Pages unknown'}
                          >
                            {s.triage?.pageCount ?? '?'}
                          </span>
                          <div className="sample-main">
                            <div className="sample-title">
                              <button
                                type="button"
                                className="sample-name"
                                aria-label={`Show text of ${s.filename}`}
                                aria-pressed={isShown}
                                disabled={s.state !== 'ready'}
                                title={s.state === 'ready' ? undefined : 'Text is shown once the sample is prepared'}
                                onClick={() => setSelected(s.id)}
                              >
                                {s.filename}
                              </button>
                              <span className={`pill tone-${pill.tone}`}>{pill.label}</span>
                            </div>
                            <p className="muted sample-meta">{sampleMeta(s)}</p>
                            {note && <p className={`sample-note tone-text-${note.tone}`}>{note.text}</p>}
                            {s.role === 'holdout' && (
                              <p className="sample-note holdout-note">{holdoutLine(s.holdoutRuns)}</p>
                            )}
                          </div>
                          <div className="sample-actions">
                            <Segmented
                              label={`Role of ${s.filename}`}
                              options={ROLES}
                              value={s.role}
                              onChange={(next) => {
                                if (next !== s.role) {
                                  void act(() => api.setSampleRole(projectId, s.id, next));
                                }
                              }}
                            />
                            {s.state === 'failed' && s.prepareJobId && (
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Retry ${s.filename}`}
                                onClick={() => void act(() => api.retryJob(s.prepareJobId!))}
                              >
                                Retry
                              </button>
                            )}
                            <button
                              type="button"
                              className="icon-button danger"
                              aria-label={`Remove ${s.filename}`}
                              onClick={() => void act(() => api.removeSample(projectId, s.id))}
                            >
                              <Icon name="trash" />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>

        <aside className="card sample-preview" aria-label="Text preview">
          {shown ? (
            <>
              <div className="sample-preview-head">
                <h3>{shown.filename}</h3>
                <span className="muted">
                  {(shown.triage?.chars ?? 0).toLocaleString('en-GB')} characters
                </span>
              </div>
              <SampleText key={shown.id} api={api} projectId={projectId} sampleId={shown.id} paged />
              <p className="muted sample-preview-foot">
                {shown.triage?.ocrPages.length
                  ? `Read by OCR (${shown.triage.ocrModel ?? 'OCR model'})`
                  : 'Text layer'}{' '}
                · cached per PDF hash, so re-runs see identical text
              </p>
            </>
          ) : (
            <p className="muted">The prepared text of a ready sample shows here.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
```

(If eslint's `react/no-array-index-key`-style rules or line length complain, let prettier wrap; keep the structure.)

`apps/web/src/workbench/ProjectPage.tsx` — `header` takes an optional description:

```tsx
  const header = (t: Exclude<ProjectTab, 'overview'>, description?: string) => (
    <TabHeader title={TAB_TITLE[t]} item={itemOf(t)} description={description} />
  );
```

and the Samples tab calls `header('samples', 'Develop with 3–8 dev samples and keep at least 2 holdout samples for the publish gate. Holdout text is never sent to a model.')`.

`apps/web/src/styles/stages.css` — append (tokens only; stacks below 1100 px and 760 px):

```css
/* Samples tab (handoff §1) */
.summary-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--ih-space-3);
}
.summary-card h3 {
  margin: 0;
  font-size: var(--ih-text-sm);
  font-weight: 600;
}
.summary-figure {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 6px 0;
}
.summary-figure strong {
  font-size: var(--ih-text-xl);
}
.summary-foot {
  margin: 6px 0 0;
  font-size: var(--ih-text-sm);
}
.tone-text-warn {
  color: var(--ih-warn-fg);
}
.tone-text-info {
  color: var(--ih-info-fg);
}
.tone-text-danger {
  color: var(--ih-danger-fg);
}
.tone-text-muted {
  color: var(--ih-muted);
}
.sample-drop {
  display: flex;
  align-items: center;
  gap: var(--ih-space-3);
  flex-wrap: wrap;
  margin: var(--ih-space-3) 0;
}
.sample-drop .drop-text {
  flex: 1 1 280px;
}
.browse-link {
  color: var(--ih-accent);
  text-decoration: underline;
  cursor: pointer;
}
.drop-role {
  display: flex;
  align-items: center;
  gap: 8px;
}
.samples-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: var(--ih-space-3);
  align-items: start;
}
.sample-groups {
  display: grid;
  gap: var(--ih-space-3);
}
.sample-group {
  padding: 0;
  overflow: hidden;
}
.sample-group-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
}
.sample-group-head h3 {
  margin: 0;
  font-size: var(--ih-text-md);
}
.sample-group ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.sample-empty {
  padding: 12px 14px;
}
.sample-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  padding: 12px 14px;
  border-top: 1px solid var(--ih-border-soft);
}
.sample-row.selected {
  background: var(--ih-sel-row);
}
.page-badge {
  display: inline-grid;
  place-items: end center;
  width: 28px;
  height: 34px;
  padding-bottom: 3px;
  border: 1px solid var(--ih-border-strong);
  border-radius: var(--ih-radius-sm);
  font-size: var(--ih-text-xs);
}
.sample-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.sample-name {
  padding: 0;
  border: 0;
  background: none;
  font-family: var(--ih-font-mono);
  font-weight: 600;
  color: var(--ih-text);
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.sample-name:disabled {
  cursor: default;
}
.sample-meta,
.sample-note {
  margin: 2px 0 0;
  font-size: var(--ih-text-sm);
  overflow-wrap: anywhere;
}
.holdout-note {
  color: var(--ih-skip-fg);
}
.sample-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sample-preview-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.sample-preview-head h3 {
  margin: 0;
  font-family: var(--ih-font-mono);
  overflow-wrap: anywhere;
}
.page-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0;
}
.page-chips button[aria-pressed='true'] {
  border-color: var(--ih-accent);
  color: var(--ih-accent);
}
.ocr-flag {
  font-size: var(--ih-text-xs);
  font-weight: 600;
  color: var(--ih-info-fg);
}
.sample-text.paged pre {
  max-height: 520px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.sample-preview-foot {
  margin: 10px 0 0;
  font-size: var(--ih-text-sm);
}
@media (max-width: 1100px) {
  .summary-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .samples-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 760px) {
  .summary-cards {
    grid-template-columns: minmax(0, 1fr);
  }
  .sample-row {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .sample-actions {
    grid-column: 1 / -1;
  }
}
```

- [ ] **Step 4: Run** `npx vitest run --project web apps/web/test/SamplesTab.test.tsx apps/web/test/SampleText.test.tsx apps/web/test/SectionsTab.test.tsx apps/web/test/ProjectPage.test.tsx` → PASS; eslint; typecheck; prettier. Look at the tab in light and dark at 1440 px and 390 px (`npm run dev:web` against `npm run dev:api`, or the Browser pane) against `01-samples.png`: rows wrap long file names, nothing scrolls the page sideways.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/SamplesTab.tsx apps/web/src/workbench/SampleText.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/src/styles/stages.css apps/web/test/SamplesTab.test.tsx apps/web/test/SampleText.test.tsx
git commit -m "Workbench web: Samples tab with summary cards, role groups, live progress and preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Brief tab — status and unsaved bar, section nav, cards, example preview, survey answers, versions and Compare

**Files:**
- Modify: `apps/web/src/workbench/BriefTab.tsx` (rewrite), `apps/web/src/workbench/ProjectPage.tsx`, `apps/web/src/styles/stages.css`
- Test: `apps/web/test/BriefTab.test.tsx` (rewritten), `apps/web/test/ProjectPage.test.tsx` (unchanged assertions must stay green)

**Interfaces:**
- `BriefTab` props become `{ api; projectId; brief: Brief | null; item: OverviewItem | null; onSaved: (brief: Brief) => void; onNavigate: (hash: string) => void; aside?: ReactNode }`. It renders its own `TabHeader` ("Brief", the composed status when a brief is saved and the overview is loaded, else `item`'s; the description; actions = "Unsaved changes", *Discard*, *Save as vN+1* only while something changed). `ProjectPage` stops calling `header('brief')`, passes `item={itemOf('brief')}`, `onNavigate` and `aside={<ExportPanel … />}`.
- Consumes: `briefDiff`, `OVERVIEW_LABEL`, `SurveyBodySchema` (shared); `BRIEF_LABEL`, `BRIEF_HINT`, `TEXT_SECTIONS`, `briefStatus`, `versionChangeText`, `csvPreview`, `openQuestions`, `compareOf` (Task 6); `api.listBriefVersions`, `api.getBriefVersion`, `api.listProposals`, `api.saveBrief`.

- [ ] **Step 1: Write the failing tests** — replace `apps/web/test/BriefTab.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BRIEF, type Brief, type BriefBody, type BriefVersionView, type OverviewItem } from '@ih/shared';
import type { Api } from '../src/api/client.js';
import { BriefTab } from '../src/workbench/BriefTab.js';
import { fakeApi, proposalView } from './fake-api.js';

const item: OverviewItem = { stage: 'brief', state: 'accepted', status: 'Saved v2', metrics: [] };
const brief = (version: number, body: Partial<BriefBody> = {}): Brief => ({
  projectId: 'letter',
  version,
  body: { ...EMPTY_BRIEF, ...body },
  createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
});
const version = (v: number, o: Partial<BriefVersionView> = {}): BriefVersionView => ({
  version: v,
  createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  changedSections: [],
  usedBy: [],
  ...o,
});
const show = (api: Api, current: Brief | null, more: { onSaved?: () => void; onNavigate?: () => void } = {}) =>
  render(
    <BriefTab
      api={api}
      projectId="letter"
      brief={current}
      item={item}
      onSaved={more.onSaved ?? vi.fn()}
      onNavigate={more.onNavigate ?? vi.fn()}
    />,
  );

describe('BriefTab', () => {
  it('starts from the latest version with its status line', async () => {
    show(fakeApi(), brief(2, { rules: 'Dates are DMY' }));
    expect(screen.getByLabelText('Rules')).toHaveValue('Dates are DMY');
    const header = screen.getByRole('heading', { level: 2, name: 'Brief' }).closest('header')!;
    expect(header).toHaveTextContent('Saved as v2 · 2 days ago');
    expect(within(header).queryByRole('button', { name: /Save as/ })).toBeNull();
  });

  it('shows the unsaved bar, the edited tag and the changed count; Discard restores', async () => {
    show(fakeApi(), brief(2, { purpose: 'Invoices' }));
    await userEvent.type(screen.getByLabelText('Glossary'), 'PO');
    const header = screen.getByRole('heading', { level: 2, name: 'Brief' }).closest('header')!;
    expect(header).toHaveTextContent('Saved as v2 · 2 days ago · 1 field changed since');
    expect(header).toHaveTextContent('Unsaved changes');
    const glossary = screen.getByLabelText('Glossary').closest('section')!;
    expect(glossary).toHaveTextContent('edited');
    expect(glossary).toHaveTextContent('2 chars');
    expect(screen.getByLabelText('Purpose').closest('section')).not.toHaveTextContent('edited');

    await userEvent.click(within(header).getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Glossary')).toHaveValue('');
    expect(within(header).queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('saves the brief as the next version, keeping the survey answers', async () => {
    const answers = [{ question: 'Which copy?', answer: 'Executed' }];
    const saved = brief(3, { purpose: 'QA', answers });
    const onSaved = vi.fn();
    const api = fakeApi({ saveBrief: vi.fn(async () => saved) });
    show(api, brief(2, { answers }), { onSaved });
    await userEvent.type(screen.getByLabelText('Purpose'), 'QA');
    await userEvent.click(screen.getByRole('button', { name: 'Save as v3' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', { ...EMPTY_BRIEF, purpose: 'QA', answers });
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(await screen.findByRole('status')).toHaveTextContent('Saved as v3');
    expect(api.listBriefVersions).toHaveBeenCalledTimes(2); // reloaded after the save
  });

  it('offers Save as v1 for a project without a brief', async () => {
    show(fakeApi(), null);
    await userEvent.type(screen.getByLabelText('Purpose'), 'x');
    expect(screen.getByRole('button', { name: 'Save as v1' })).toBeEnabled();
  });

  it('jumps to a section from the nav, marking empty sections in words', async () => {
    show(fakeApi(), brief(1, { purpose: 'Invoices' }));
    const nav = screen.getByRole('navigation', { name: 'Brief sections' });
    expect(within(nav).getByRole('button', { name: 'Purpose' })).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole('button', { name: 'Glossary (empty)' }));
    expect(screen.getByLabelText('Glossary')).toHaveFocus();
    expect(within(nav).getByRole('button', { name: /Survey answers · 0/ })).toBeInTheDocument();
  });

  it('previews the example output as a table', async () => {
    show(
      fakeApi(),
      brief(1, {
        exampleOutput: 'invoice,description,amount\nINV-1,"Nitrile gloves, M (100)",85.00\nINV-1,Tips,125.00',
      }),
    );
    expect(screen.getByText('Preview · 2 rows × 3 columns')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Example output preview' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'invoice',
      'description',
      'amount',
    ]);
    expect(table).toHaveTextContent('Nitrile gloves, M (100)');
  });

  it('lists saved survey answers read-only', async () => {
    show(fakeApi(), brief(1, { answers: [{ question: 'Which copy?', answer: 'Executed' }] }));
    const card = screen.getByRole('region', { name: 'Survey answers' });
    expect(card).toHaveTextContent('Which copy?');
    expect(card).toHaveTextContent('Executed');
    expect(within(card).queryByRole('textbox')).toBeNull();
  });

  it('links an empty survey answers card to Survey with the open questions', async () => {
    const onNavigate = vi.fn();
    const survey = proposalView({
      stage: 'survey',
      status: 'ready',
      body: {
        summary: '',
        structure: [],
        variants: [],
        candidates: [],
        questions: [
          { question: 'Which copy?', why: '' },
          { question: 'Dates?', why: '' },
        ],
      },
    });
    show(fakeApi({ listProposals: vi.fn(async () => [survey]) }), brief(1), { onNavigate });
    const card = screen.getByRole('region', { name: 'Survey answers' });
    expect(await within(card).findByText(/the Survey has 2 open questions/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Open Survey' }));
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/letter/survey');
  });

  it('lists versions with CURRENT, used-by tags and what changed', async () => {
    const api = fakeApi({
      listBriefVersions: vi.fn(async () => [
        version(3, { changedSections: ['variants', 'rules'] }),
        version(2, { changedSections: ['exampleOutput'], usedBy: ['outputs'] }),
        version(1, { changedSections: ['purpose'] }),
      ]),
    });
    show(api, brief(3));
    const list = await screen.findByRole('list', { name: 'Versions' });
    const v3 = within(list).getByRole('listitem', { name: 'v3' });
    expect(v3).toHaveTextContent('CURRENT');
    expect(v3).toHaveTextContent('Variants, rules');
    const v2 = within(list).getByRole('listitem', { name: 'v2' });
    expect(v2).toHaveTextContent('used by Outputs');
    expect(v2).not.toHaveTextContent('CURRENT');
    expect(within(list).getByRole('listitem', { name: 'v1' })).toHaveTextContent('First brief');
  });

  it('compares an older version with the current one, section by section', async () => {
    const versions = [version(2, { changedSections: ['glossary'] }), version(1)];
    const bodies: Record<number, Brief> = {
      1: brief(1, { purpose: 'Invoices' }),
      2: brief(2, { purpose: 'Invoices', glossary: 'PO: purchase order' }),
    };
    const api = fakeApi({
      listBriefVersions: vi.fn(async () => versions),
      getBriefVersion: vi.fn(async (_p: string, v: number) => bodies[v]!),
    });
    show(api, bodies[2]!);
    await userEvent.click(await screen.findByRole('button', { name: 'Compare v1' }));
    expect(api.getBriefVersion).toHaveBeenCalledWith('letter', 1);
    expect(api.getBriefVersion).toHaveBeenCalledWith('letter', 2);
    const panel = await screen.findByRole('region', { name: 'Compare v1 with v2' });
    const rows = within(panel).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Glossary—PO: purchase order');
    await userEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Compare v1 with v2' })).toBeNull();
  });

  it('disables Compare with a reason when there is one version', async () => {
    show(fakeApi({ listBriefVersions: vi.fn(async () => [version(1)]) }), brief(1));
    const compare = await screen.findByRole('button', { name: 'Compare v1' });
    expect(compare).toBeDisabled();
    expect(compare).toHaveAttribute('title', 'Nothing to compare yet');
  });

  it('renders the side panel it is given', async () => {
    render(
      <BriefTab
        api={fakeApi()}
        projectId="letter"
        brief={null}
        item={null}
        onSaved={vi.fn()}
        onNavigate={vi.fn()}
        aside={<p>bundle here</p>}
      />,
    );
    expect(screen.getByText('bundle here')).toBeInTheDocument();
  });
});
```

(`proposalView` is the existing `fake-api.ts` fixture, a ready survey proposal by default.)

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/BriefTab.test.tsx` → FAIL (no header, nav, versions).

- [ ] **Step 3: Implement** — `apps/web/src/workbench/BriefTab.tsx`:

```tsx
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  EMPTY_BRIEF,
  OVERVIEW_LABEL,
  SurveyBodySchema,
  briefDiff,
  type Brief,
  type BriefBody,
  type BriefSection,
  type BriefVersionView,
  type OverviewItem,
  type SurveyBody,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { relativeTime } from '../jobs/derive.js';
import { Icon } from '../ui/Icon.js';
import {
  BRIEF_HINT,
  BRIEF_LABEL,
  TEXT_SECTIONS,
  briefStatus,
  compareOf,
  csvPreview,
  openQuestions,
  versionChangeText,
  type TextSection,
} from './brief.js';
import { plural } from './samples.js';
import { TabHeader } from './TabHeader.js';

function SectionCard({
  section,
  value,
  edited,
  onChange,
  children,
}: {
  section: TextSection;
  value: string;
  edited: boolean;
  onChange: (value: string) => void;
  children?: ReactNode;
}) {
  const id = `brief-${section}`;
  return (
    <section id={`${id}-card`} className={`card brief-card${edited ? ' edited' : ''}`}>
      <div className="brief-card-head">
        <h3>
          <label htmlFor={id}>{BRIEF_LABEL[section]}</label>
        </h3>
        {edited && <span className="edited-tag">edited</span>}
        <span className="muted brief-chars">{value.length} chars</span>
      </div>
      <small id={`${id}-hint`} className="muted">
        {BRIEF_HINT[section]}
      </small>
      <textarea
        id={id}
        aria-describedby={`${id}-hint`}
        className={section === 'exampleOutput' ? 'mono' : undefined}
        rows={5}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {children}
    </section>
  );
}

function ExamplePreview({ text }: { text: string }) {
  const preview = csvPreview(text);
  if (!preview) return null;
  return (
    <div className="brief-preview">
      <p className="muted">
        Preview · {plural(preview.rows.length, 'row')} × {plural(preview.header.length, 'column')}
      </p>
      <div className="table-scroll">
        <table aria-label="Example output preview">
          <thead>
            <tr>
              {preview.header.map((h, i) => (
                <th key={i} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r, i) => (
              <tr key={i}>
                {preview.header.map((_h, j) => (
                  <td key={j}>{r[j] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ComparePanel({ from, to, onClose }: { from: Brief; to: Brief; onClose: () => void }) {
  const diff = briefDiff(from.body, to.body);
  return (
    <section
      className="card brief-compare"
      aria-label={`Compare v${from.version} with v${to.version}`}
    >
      <div className="brief-card-head">
        <h3>
          v{from.version} → v{to.version}
        </h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {diff.length === 0 ? (
        <p className="muted">No differences.</p>
      ) : (
        <div className="table-scroll">
          <table aria-label="Changes">
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col">v{from.version}</th>
                <th scope="col">v{to.version}</th>
              </tr>
            </thead>
            <tbody>
              {diff.map((d) => (
                <tr key={d.section}>
                  <th scope="row">{BRIEF_LABEL[d.section]}</th>
                  <td className="brief-diff-text">{d.before || '—'}</td>
                  <td className="brief-diff-text">{d.after || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The user's product knowledge for this document type; every save is a new version. */
export function BriefTab({
  api,
  projectId,
  brief,
  item,
  onSaved,
  onNavigate,
  aside,
}: {
  api: Api;
  projectId: string;
  brief: Brief | null;
  /** The Brief entry of the project overview (status line); null until it loads. */
  item: OverviewItem | null;
  onSaved: (brief: Brief) => void;
  onNavigate: (hash: string) => void;
  /** The drafting bundle panel, under Versions. */
  aside?: ReactNode;
}) {
  const saved = brief?.body ?? EMPTY_BRIEF;
  const [body, setBody] = useState<BriefBody>(saved);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<BriefVersionView[] | null>(null);
  const [survey, setSurvey] = useState<SurveyBody | null>(null);
  const [compare, setCompare] = useState<{ from: Brief; to: Brief } | null>(null);
  const [now] = useState(() => Date.now());
  const changed = briefDiff(saved, body).map((d) => d.section);

  const loadVersions = useCallback(() => {
    api.listBriefVersions(projectId).then(setVersions, (err: Error) => setError(err.message));
  }, [api, projectId]);
  useEffect(loadVersions, [loadVersions]);

  useEffect(() => {
    api.listProposals(projectId).then(
      (proposals) => {
        for (const p of proposals) {
          if (p.stage !== 'survey' || (p.status !== 'ready' && p.status !== 'accepted')) continue;
          const parsed = SurveyBodySchema.safeParse(p.body);
          if (parsed.success) {
            setSurvey(parsed.data);
            return;
          }
        }
      },
      () => setSurvey(null), // the empty card still links to Survey
    );
  }, [api, projectId]);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveBrief(projectId, body);
      onSaved(next);
      setMessage(`Saved as v${next.version}`);
      loadVersions();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const jump = (section: BriefSection) => {
    const card = document.getElementById(
      section === 'answers' ? 'brief-answers-card' : `brief-${section}-card`,
    );
    card?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    document.getElementById(section === 'answers' ? 'brief-answers-card' : `brief-${section}`)?.focus();
  };

  const openCompare = async ([from, to]: [number, number]) => {
    setError(null);
    try {
      const [a, b] = await Promise.all([
        api.getBriefVersion(projectId, from),
        api.getBriefVersion(projectId, to),
      ]);
      setCompare({ from: a, to: b });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const headerItem =
    item && brief
      ? { ...item, status: briefStatus(brief.version, brief.createdAt, changed.length, now) }
      : item;
  const open = survey ? openQuestions(survey, body.answers) : null;
  const card = (section: TextSection, children?: ReactNode) => (
    <SectionCard
      section={section}
      value={body[section]}
      edited={changed.includes(section)}
      onChange={(value) => setBody({ ...body, [section]: value })}
    >
      {children}
    </SectionCard>
  );

  return (
    <div className="brief-tab">
      <TabHeader
        title="Brief"
        item={headerItem}
        description="Everything you know about this document type, in plain words. The model reads it at every drafting stage; each save is a new version."
        actions={
          changed.length > 0 ? (
            <>
              <span className="unsaved-note">
                <span className="unsaved-dot" aria-hidden="true" />
                Unsaved changes
              </span>
              <button type="button" disabled={saving} onClick={() => setBody(saved)}>
                Discard
              </button>
              <button
                type="button"
                className="primary"
                disabled={saving}
                onClick={() => void save()}
              >
                Save as v{(brief?.version ?? 0) + 1}
              </button>
            </>
          ) : undefined
        }
      />
      <nav aria-label="Brief sections" className="brief-nav">
        {TEXT_SECTIONS.map((s) => {
          const filled = body[s].trim() !== '';
          return (
            <button key={s} type="button" className="brief-nav-chip" onClick={() => jump(s)}>
              <span className={`brief-nav-mark${filled ? ' filled' : ''}`} aria-hidden="true">
                {filled ? '✓' : '○'}
              </span>
              {BRIEF_LABEL[s]}
              {!filled && <span className="visually-hidden"> (empty)</span>}
            </button>
          );
        })}
        <button type="button" className="brief-nav-chip" onClick={() => jump('answers')}>
          <span className={`brief-nav-mark${body.answers.length ? ' filled' : ' open'}`} aria-hidden="true">
            {body.answers.length ? '✓' : '!'}
          </span>
          Survey answers · {body.answers.length}
        </button>
      </nav>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}

      <div className="brief-layout">
        <form aria-label="Brief" className="brief-main" onSubmit={(e) => void save(e)}>
          {compare && (
            <ComparePanel from={compare.from} to={compare.to} onClose={() => setCompare(null)} />
          )}
          {card('purpose')}
          <div className="brief-pair">
            {card('outputs')}
            {card('glossary')}
          </div>
          {card('exampleOutput', <ExamplePreview text={body.exampleOutput} />)}
          <div className="brief-pair">
            {card('variants')}
            {card('rules')}
          </div>
          <section
            id="brief-answers-card"
            tabIndex={-1}
            className={`card brief-answers${body.answers.length ? '' : ' empty'}`}
            aria-labelledby="brief-answers-title"
          >
            <span className="drop-icon" aria-hidden="true">
              <Icon name="search" />
            </span>
            <div className="brief-answers-body">
              <h3 id="brief-answers-title">Survey answers</h3>
              {body.answers.length ? (
                <dl>
                  {body.answers.map((a, i) => (
                    <div key={i}>
                      <dt>{a.question}</dt>
                      <dd>{a.answer}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="muted">
                  {open !== null && open > 0
                    ? `None saved yet — the Survey has ${plural(open, 'open question')} about things the brief leaves open.`
                    : 'None saved yet — the Survey stage asks about what the brief leaves open.'}{' '}
                  Answers you save there are stored here, where every later stage reads them.
                </p>
              )}
            </div>
            <button type="button" onClick={() => onNavigate(`#/workbench/${projectId}/survey`)}>
              Open Survey
            </button>
          </section>
        </form>

        <div className="brief-side">
          <section className="card brief-versions" aria-labelledby="brief-versions-title">
            <h3 id="brief-versions-title">Versions</h3>
            {versions === null ? (
              <p className="muted">Loading…</p>
            ) : versions.length === 0 ? (
              <p className="muted">No version saved yet.</p>
            ) : (
              <ul aria-label="Versions">
                {versions.map((v, i) => {
                  const pair = compareOf(v.version, versions);
                  return (
                    <li key={v.version} aria-label={`v${v.version}`}>
                      <div className="brief-version-head">
                        <strong>v{v.version}</strong>
                        <span className="muted">{relativeTime(v.createdAt, now)}</span>
                        {i === 0 && <span className="version-tag current">CURRENT</span>}
                        {v.usedBy.map((s) => (
                          <span key={s} className="version-tag">
                            used by {OVERVIEW_LABEL[s]}
                          </span>
                        ))}
                      </div>
                      <p className="muted">{versionChangeText(v)}</p>
                      <button
                        type="button"
                        aria-label={`Compare v${v.version}`}
                        disabled={!pair}
                        title={pair ? `Compare v${pair[0]} with v${pair[1]}` : 'Nothing to compare yet'}
                        onClick={() => pair && void openCompare(pair)}
                      >
                        Compare
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {aside}
        </div>
      </div>
    </div>
  );
}
```

`apps/web/src/workbench/ProjectPage.tsx`, the brief branch:

```tsx
          {tab === 'brief' && (
            <BriefTab
              api={api}
              projectId={project.id}
              brief={view.brief}
              item={itemOf('brief')}
              onNavigate={onNavigate}
              onSaved={(brief) => {
                setView({ ...view, brief });
                loadOverview();
              }}
              aside={
                <ExportPanel
                  api={api}
                  role={role}
                  projectId={project.id}
                  dataPolicy={project.dataPolicy}
                  pollMs={pollMs}
                />
              }
            />
          )}
```

`apps/web/src/styles/stages.css` — append:

```css
/* Brief tab (handoff §2) */
.unsaved-note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ih-warn-fg);
  font-size: var(--ih-text-sm);
}
.unsaved-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ih-warn-fg);
}
.brief-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: var(--ih-space-3) 0;
}
.brief-nav-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--ih-radius-pill);
}
.brief-nav-mark {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: var(--ih-text-xs);
  color: var(--ih-muted);
}
.brief-nav-mark.filled {
  background: var(--ih-ok-fg);
  color: var(--ih-surface);
}
.brief-nav-mark.open {
  background: var(--ih-warn-fg);
  color: var(--ih-surface);
}
.brief-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: var(--ih-space-3);
  align-items: start;
}
.brief-main,
.brief-side {
  display: grid;
  gap: var(--ih-space-3);
}
.brief-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--ih-space-3);
}
.brief-card textarea {
  width: 100%;
  margin-top: 8px;
}
.brief-card.edited {
  border-color: var(--ih-warn-fg);
}
.brief-card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.brief-card-head h3 {
  margin: 0;
  font-size: var(--ih-text-md);
}
.brief-chars {
  margin-left: auto;
  font-size: var(--ih-text-xs);
}
.edited-tag {
  padding: 1px 6px;
  border-radius: var(--ih-radius-sm);
  background: var(--ih-warn-bg);
  color: var(--ih-warn-fg);
  font-size: var(--ih-text-xs);
  font-weight: 600;
}
.brief-preview p {
  margin: 8px 0 4px;
  font-size: var(--ih-text-sm);
}
.table-scroll {
  overflow-x: auto;
}
.brief-diff-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.brief-answers {
  display: flex;
  align-items: flex-start;
  gap: var(--ih-space-3);
}
.brief-answers.empty {
  border-style: dashed;
  border-color: var(--ih-warn-fg);
  background: var(--ih-warn-bg);
}
.brief-answers-body {
  flex: 1;
}
.brief-answers-body h3 {
  margin: 0 0 4px;
  font-size: var(--ih-text-md);
}
.brief-answers dl div {
  margin: 0 0 6px;
}
.brief-answers dt {
  font-weight: 600;
}
.brief-answers dd {
  margin: 0;
}
.brief-versions ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.brief-versions li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 8px;
  padding: 10px 0;
  border-top: 1px solid var(--ih-border-soft);
}
.brief-versions li > button {
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
}
.brief-versions li p {
  margin: 0;
  font-size: var(--ih-text-sm);
}
.brief-version-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}
.version-tag {
  font-size: var(--ih-text-xs);
  font-weight: 600;
  color: var(--ih-muted);
}
.version-tag.current {
  color: var(--ih-ok-fg);
}
@media (max-width: 1100px) {
  .brief-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 760px) {
  .brief-pair {
    grid-template-columns: minmax(0, 1fr);
  }
  .brief-answers {
    flex-wrap: wrap;
  }
}
```

- [ ] **Step 4: Run** `npx vitest run --project web apps/web/test/BriefTab.test.tsx apps/web/test/ProjectPage.test.tsx apps/web/test/SurveyTab.test.tsx` → PASS (the ProjectPage tab-header table still finds one H2 "Brief" with "Accepted": `projectView()` has no brief, so the overview status shows; "offers the drafting bundle export on the Brief tab" still finds the heading and button); eslint; typecheck; prettier. Look at the tab at 1440 px and 390 px in both themes against `02-brief.png`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/BriefTab.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/src/styles/stages.css apps/web/test/BriefTab.test.tsx
git commit -m "Workbench web: Brief tab with unsaved bar, section cards, example preview and versions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Drafting bundle panel restyled (BR3 in the UI)

**Files:**
- Modify: `apps/web/src/workbench/ExportPanel.tsx`, `apps/web/src/styles/stages.css`
- Create: nothing; `exportStatusText` lives in `apps/web/src/workbench/brief.ts`
- Test: `apps/web/test/ExportPanel.test.tsx`, `apps/web/test/brief-derive.test.ts`

**Interfaces:**
- Produces: `exportStatusText(e: ExportView): string` — succeeded: `Export ready · brief vN · n dev samples · 3.1 MB` (parts present only when known; `no brief` when `briefVersion` is null), active: `Export queued…`/`Export running…`, else `Export failed[: error]` / `Export cancelled`.
- Accessible names kept: button "Export bundle" (first export) / "Export again" (an export exists), link "Download bundle" (visible text "Download"), heading "Drafting bundle", the non-admin sentence "Downloading a local-only project's bundle needs the admin token.".

- [ ] **Step 1: Write the failing tests** — `apps/web/test/brief-derive.test.ts`:

```ts
describe('exportStatusText', () => {
  const exp = (o: Partial<ExportView>): ExportView => ({
    jobId: 'j1',
    status: 'succeeded',
    error: null,
    createdAt: 't',
    updatedAt: 't',
    briefVersion: 3,
    devSamples: 6,
    bytes: 3_250_000,
    ...o,
  });
  it.each<[string, Partial<ExportView>, string]>([
    ['ready with every fact', {}, 'Export ready · brief v3 · 6 dev samples · 3.1 MB'],
    ['one sample, no brief, size unknown', { briefVersion: null, devSamples: 1, bytes: null }, 'Export ready · no brief · 1 dev sample'],
    ['facts unreadable', { briefVersion: null, devSamples: null, bytes: null }, 'Export ready · no brief'],
    ['running', { status: 'running' }, 'Export running…'],
    ['queued', { status: 'queued' }, 'Export queued…'],
    ['failed', { status: 'needs_review', error: 'boom' }, 'Export failed: boom'],
    ['cancelled', { status: 'cancelled' }, 'Export cancelled'],
  ])('%s', (_name, o, text) => {
    expect(exportStatusText(exp(o))).toBe(text);
  });
});
```

(import `exportStatusText` and `type ExportView`). `apps/web/test/ExportPanel.test.tsx` — add:

```tsx
  it('tells what the ready bundle carries and offers it again', async () => {
    const api = fakeApi({
      listExports: vi.fn(async () => [
        exp({ status: 'succeeded', briefVersion: 3, devSamples: 6, bytes: 3_250_000 }),
      ]),
      startExport: vi.fn(async () => exp()),
    });
    render(
      <ExportPanel api={api} role="admin" projectId="letter" dataPolicy="external" pollMs={10} />,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Export ready · brief v3 · 6 dev samples · 3.1 MB',
    );
    expect(screen.getByRole('link', { name: 'Download bundle' })).toHaveTextContent('Download');
    expect(screen.queryByRole('button', { name: 'Export bundle' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Export again' }));
    expect(api.startExport).toHaveBeenCalledWith('letter');
  });

  it('says what the bundle includes, never holdout', async () => {
    render(
      <ExportPanel api={fakeApi()} role="admin" projectId="letter" dataPolicy="external" />,
    );
    expect(await screen.findByText(/never holdout samples/)).toBeInTheDocument();
  });

  it('notes that a local-only project needs the admin token', async () => {
    render(<ExportPanel api={fakeApi()} role="admin" projectId="letter" dataPolicy="local" />);
    expect(
      await screen.findByText('Local-only project: exporting and downloading need the admin token.'),
    ).toBeInTheDocument();
  });
```

The existing tests stay as they are (their names and texts are kept by the implementation).

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/ExportPanel.test.tsx apps/web/test/brief-derive.test.ts` → FAIL (`exportStatusText` missing; status text has no facts; no "Export again").

- [ ] **Step 3: Implement** — in `apps/web/src/workbench/brief.ts` (import `type ExportView` and `formatBytes`, `plural` from `./samples.js`):

```ts
/** The drafting bundle's status line (handoff §2, BR3). */
export function exportStatusText(e: ExportView): string {
  if (e.status === 'succeeded') {
    const parts = ['Export ready', e.briefVersion === null ? 'no brief' : `brief v${e.briefVersion}`];
    if (e.devSamples !== null) parts.push(plural(e.devSamples, 'dev sample'));
    if (e.bytes !== null) parts.push(formatBytes(e.bytes));
    return parts.join(' · ');
  }
  if (e.status === 'queued' || e.status === 'running') return `Export ${e.status}…`;
  if (e.status === 'cancelled') return 'Export cancelled';
  return `Export failed${e.error ? `: ${e.error}` : ''}`;
}
```

`apps/web/src/workbench/ExportPanel.tsx` — keep the state, polling and `start`; replace the JSX:

```tsx
  const canDownload = dataPolicy !== 'local' || role === 'admin';
  const ready = latest?.status === 'succeeded';
  return (
    <section className="card export-panel" aria-labelledby="export-title">
      <h3 id="export-title">
        <Icon name="file" /> Drafting bundle
      </h3>
      <p className="muted">
        Brief, draft, stage instructions and the dev samples as uploaded — never holdout samples —
        to draft elsewhere or import into another deployment.
      </p>
      {error && <p role="alert">{error}</p>}
      {latest && (
        <p
          role="status"
          className={`export-status ${ready ? 'tone-text-ok' : active ? 'tone-text-info' : 'tone-text-danger'}`}
        >
          {ready && <Icon name="check" />} {exportStatusText(latest)}
        </p>
      )}
      <div className="export-actions">
        {latest?.status === 'succeeded' &&
          (canDownload ? (
            <a
              className="button primary"
              href={api.exportBundleUrl(projectId, latest.jobId)}
              download
              aria-label="Download bundle"
            >
              <Icon name="download" /> Download
            </a>
          ) : (
            <span className="muted">
              Downloading a local-only project&apos;s bundle needs the admin token.
            </span>
          ))}
        <button type="button" disabled={busy || active} onClick={() => void start()}>
          {latest ? 'Export again' : 'Export bundle'}
        </button>
      </div>
      {dataPolicy === 'local' && (
        <p className="muted export-note">
          Local-only project: exporting and downloading need the admin token.
        </p>
      )}
    </section>
  );
```

(import `Icon` from `../ui/Icon.js` and `exportStatusText` from `./brief.js`; the `h3`'s accessible name is "Drafting bundle" because the icon is `aria-hidden`.) Check the existing tests' expectations against this markup: "starts an export…" clicks "Export bundle" with no export listed (✓); "shows a failed export" finds `/boom/` (✓); "offers a local-only bundle download to user: false" finds the exact sentence (✓). Note the old copy "Exporting a local-only project needs the admin token." becomes the note above; the test "says local-only exports need the admin token" matches `/admin token/` (✓).

`apps/web/src/styles/stages.css` — append:

```css
/* Drafting bundle panel (handoff §2) */
.export-panel h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-size: var(--ih-text-md);
}
.export-panel p {
  font-size: var(--ih-text-sm);
}
.export-status {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  overflow-wrap: anywhere;
}
.tone-text-ok {
  color: var(--ih-ok-fg);
}
.export-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.export-note {
  margin: 10px 0 0;
}
```

(`a.button.primary` is the existing primary-link style in `apps/web/src/styles.css`.)

- [ ] **Step 4: Run** `npx vitest run --project web apps/web/test/ExportPanel.test.tsx apps/web/test/brief-derive.test.ts apps/web/test/ProjectPage.test.tsx` → PASS; eslint; typecheck; prettier. Look at the Brief tab's right column at 1440 px and 390 px, both themes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/ExportPanel.tsx apps/web/src/workbench/brief.ts apps/web/src/styles/stages.css apps/web/test/ExportPanel.test.tsx apps/web/test/brief-derive.test.ts
git commit -m "Workbench web: drafting bundle panel with brief version, dev samples and size

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs and the full check

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Docs** — in `CLAUDE.md`:

1. Contract table, row "Workbench prepared text and segmentation": append to the TS cell "; prepare progress and failure reasons: `SampleView.prepare`/`prepareError` (`PrepareProgressSchema`, `PrepareErrorSchema`, `PREPARE_ERROR_CODES`) derived in `sampleViews` from the job events `PREPARE_PROGRESS_EVENT`/`PREPARE_FAILED_EVENT` (`IngestionRepo.latestEvents`, `apps/api/src/workbench/prepare.ts`)" and to the Python cell "; `workbench.PREPARE_PROGRESS` (`{stage, page, of}`), `workbench.PREPARE_FAILED` (`{code, message}`), `PrepareFailed`, `prepare_error_code`, `ocr_pages(progress=)`".
2. Row "Workbench bundle": append to the TS cell "; `ExportView.briefVersion`/`devSamples` (from the export job's params) and `bytes` (`BUNDLE_EXPORTED_EVENT`'s `bytes`, once succeeded)" and to the Python cell "; the `bundle exported` event carries `bytes`".
3. In the **Workbench** bullet, after the sentence about prepare jobs ("…Prepare jobs never appear on the Jobs page and are never bulk-deleted;"), add: "While a sample prepares, the worker writes `prepare progress` job events (text layer read, then each OCR page) and, on a `DocumentError`, a `prepare failed` event whose `message` is the review reason; `SampleView.prepare` shows the current attempt's progress only (event at or after the job's `updatedAt`), and `prepareError` trusts a code only while its message equals the job's error (else `other`). pypdf password/read errors in `prepare` go to review instead of being retried. Brief history: `GET /api/workbench/projects/:id/briefs` (`briefVersions` in `packages/shared/src/brief.ts`: `changedSections` = `briefDiff` against the previous version, `usedBy` = stages whose newest accepted or partially accepted proposal used that version) and `GET …/briefs/:version`; the Brief tab compares versions client-side with `briefDiff`."
4. At the end of the **UI** bullet's Workbench tabs sentence (added in PR 1), append: " Samples (`SamplesTab`, helpers in `workbench/samples.ts`; `SampleText` `paged`) and Brief (`BriefTab`, helpers in `workbench/brief.ts`; `ExportPanel` as its side panel) follow handoff §1–§2."

- [ ] **Step 2: Run** `npm run openapi` (no diff expected after Tasks 3–5; commit if there is one), then `npm run check` → green (lint, typecheck, every TS project, `worker:lint`, `worker:test`). Then `npx prettier --check .`; fix only the reported files with `npx prettier --write <file>`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Docs: Samples progress and failure reasons, brief history and bundle facts in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Never `git add -A`: `config/llm-providers.yaml` has an unrelated local change.)
