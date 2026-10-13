# Workbench tabs 4/8: References — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the References tab (handoff §7) and land the API it needs: what the reviewer changed in each saved reference and who verified it (RF1), and one reference's values with their provenance (RF2). The tab gets the ready banner (every dev and holdout reference matches the draft's outputs, *Go to Evaluate*, and why references were re-verified), three cards (Dev *n/n*, Holdout *n/n* violet, Right first time *x / y*), the "Where the draft model needed you" strip, the Samples list (Dev and Holdout groups, filter *All / Corrected / Needs you*, a Run → Reviewed → Saved tracker, corrections summary, *Review* link, run buttons with counts and disabled reasons, a foot naming samples not counted) and a detail panel for the selected sample (MODEL ✓ / CORRECTED / BY HAND per output, the model's value struck through, *Open in Review to change*).

**Architecture:** No migration (user ruling: RF1 is **derived on read**, no new storage; `review_edits_job_idx (job_id, id)` from 0002 already serves the join). A new pure shared module `packages/shared/src/corrections.ts` turns a job's `review_edits` into `Correction[]` (`correctionsFromEdits`) and decides whether they still describe a saved reference (`referenceCorrections`: the source job must be `succeeded` and reviewed at or before the reference's `createdAt`, else `null` = unknown). `ReferenceRowSchema.reference` becomes the exported `ReferenceInfoSchema` and gains `sourceJobId`, `verifiedBy`, `corrections` (nullable) and `reverified` (the superseded carried copy a re-verification replaced: its version and its `outputChanges`). The API reads every row's source job review in **one** query per list (new `IngestionRepo.listJobReviews(jobIds)`, Memory + Pg, `json_agg` over `review_edits`). `GET /api/workbench/projects/:id/references/:sid` (RF2) returns `ReferenceDetailSchema`: the sample, the reference info, the run that proposed it (job, override, models from its step runs) and one value per current output with its provenance. Right first time (`rightFirstTime`) and the strip (`outputNeeds`) are pure shared functions over the rows and the draft definition, excluding outputs no step fills (`outputCoverage`, PR 1). The web adds `getReferenceDetail`, pure helpers (`apps/web/src/workbench/references.ts`) and rewrites `ReferencesTab`.

**Tech Stack:** React 19, Vitest + Testing Library, Zod (shared), Fastify + OpenAPI route docs, Postgres 17, CSS on existing `--ih-*` tokens.

**Spec:** `docs/design/workbench-tabs/WORKBENCH-TABS-HANDOFF.md` §0 (rules shared by every tab), §7 References, rows **RF1, RF2** of "New API"; screens `docs/design/workbench-tabs/screenshots/light/07-references.png`, `states/07b-references-holdout-detail.png` (dark variants in `screenshots/dark/`).

## Global Constraints

- **Card CSS gotcha:** `.card` has **no padding**. Every new card class in this plan (`.refs-ready`, `.refs-card`, `.refs-needs`, `.refs-samples`, `.refs-detail`) adds its own `padding: 12px 16px`, and its `h3` gets `font-weight: 600` (extend the rule block at the end of `apps/web/src/styles/stages.css`; do not duplicate it). Check in a browser at 1440 px and 390 px, both themes.
- **Grids never overflow:** every multi-column grid uses `minmax(0, 1fr)` tracks (`.refs-cards`: `repeat(3, minmax(0, 1fr))`; `.refs-layout`: `minmax(0, 1.4fr) minmax(0, 1fr)`), every column/flex child that holds text has `min-width: 0`; both collapse to one column below 760 px. The detail panel's value table sits in `.table-scroll` (reuse the class from PR 3; do not redefine it). File names, keys and job ids wrap with `overflow-wrap: anywhere`.
- **Long side panel:** `.refs-detail` is `position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow: auto` (static below 760 px).
- **Disabled primary/secondary actions carry a reason:** every disabled run button has a `title` (tested): "Start a draft version first", "Reference runs are still running", "Every dev sample has a verified reference", "Every holdout sample has a verified reference".
- **Selectable rows are buttons with `aria-pressed`**; the *Review* link is a sibling of the button, never inside it. The tracker is `role="img"` with its steps in `aria-label`; meters are the existing `Meter` (`role="img"`); colour is never the only signal (chips carry their number and the legend names the colours; provenance tags are text).
- **RF1 is derived, never stored:** no migration (main has 0024–0025, PR 3 adds 0026; this PR adds none). `corrections` is `null` (unknown) when the reference has no source job, the job is gone, or the job was re-run or re-reviewed after the save (`reviewedAt` null or later than the reference's `createdAt`); unknown corrections count in no figure (Right first time, strip, Corrected filter).
- **One query per list:** `referenceEntries` collects every row's `sourceJobId` and calls `repo.listJobReviews(ids)` once (dev and holdout lists are separate requests: one query each). No per-row repo calls; RF2 makes two more (the source job and its step runs) for one sample only.
- **Holdout is sealed (§0.3):** this PR sends nothing to a model; holdout values are shown to the user only, with the violet note "Holdout values are only scored, never shown to drafting."
- **References is an optional stage (#77, `OPTIONAL_STAGES`):** the tab keeps *Skip this stage*, its status comes from the overview item ("Optional, not started" when pending), and the description says it is optional. The Next banner logic in `overview.ts` is untouched.
- **No `LIST_CACHE_VERSION` bump:** the list row does not use references' corrections.
- Tests first (red, then green); never call a real LLM; Pg integration only on a throwaway `postgres:17-alpine` container on port **55448** (`ih-test-pg-ct4`), removed afterwards; `npm run check` green at the end; never stage `config/llm-providers.yaml` (unrelated local edit); never `git add -A`; commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **`correctionsFromEdits` semantics** (Task 1 table): several edits of one key collapse to (first `oldValue`, last `newValue`); an edit back to the model's value is no correction; empty = `null`/`undefined`/blank string/`[]`; `entered` only when the model proposed an empty value; clearing a proposed value is `corrected`.
2. **When corrections are trusted** (`referenceCorrections`): a source job retried after the save loses its edits (`retryJob` deletes them), so a later or missing `reviewedAt` must give `null`, never "No corrections" (Task 1, Task 4 "retried after the save").
3. **No N+1** — `listJobReviews` is called once per `referenceEntries` (Task 4 asserts the call count with a spy); the Pg query aggregates edits with `json_agg … ORDER BY e.id` and normalises `at` to ISO (Task 3).
4. **Right first time excludes what no step fills** and references with unknown corrections; a table is one value per reference (Task 2 table).
5. **`reverified`** names the version and output changes of the copy a re-verification superseded, for the banner's "because …" (Task 4).
6. **Existing tests rewritten deliberately, not weakened** — `ReferencesTab.test.tsx`: the tables "References"/"Holdout references" become the "Samples" list; "Run the draft model on unverified samples" → "Run the draft model on 1 unverified"; "Verify in Review" → "Review"; "re-verify: … changed" stays as row status text.

---

### Task 1: Shared corrections — `correctionsFromEdits`, `referenceCorrections`, `outputProvenance`

**Files:**
- Create: `packages/shared/src/corrections.ts`, `packages/shared/test/corrections.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces (from `@ih/shared`):
  - `CORRECTION_KINDS = ['corrected', 'entered'] as const`, `CorrectionSchema` / `Correction = { key: string; kind: 'corrected' | 'entered'; proposed: unknown }`
  - `correctionKey(edit: Pick<ReviewEdit, 'field' | 'table' | 'row' | 'column'>): string` — `field`, or `table[row].column` (1-based row, as in `review_edits`)
  - `correctionOutput(key: string): string` — the output id (text before `[`)
  - `emptyValue(v: unknown): boolean`
  - `correctionsFromEdits(edits: readonly ReviewEdit[]): Correction[]`
  - `interface ReviewRecord { status: JobStatus; reviewer: string | null; reviewedAt: string | null; edits: readonly ReviewEdit[] }`
  - `referenceCorrections(review: ReviewRecord | null, savedAt: string): { corrections: Correction[] | null; verifiedBy: string | null }`
  - `PROVENANCES = ['model', 'corrected', 'entered'] as const`, `type Provenance`; `outputProvenance(corrections: readonly Correction[]): Provenance`
- Consumed by: Task 2 (schemas, aggregates), Task 4 (API rows), Task 5 (RF2), web (Tasks 6–8).

- [ ] **Step 1: Write the failing tests** — `packages/shared/test/corrections.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  correctionKey,
  correctionOutput,
  correctionsFromEdits,
  outputProvenance,
  referenceCorrections,
  type Correction,
  type ReviewEdit,
} from '../src/index.js';

let seq = 0;
const edit = (o: Partial<ReviewEdit>): ReviewEdit => ({
  id: ++seq,
  at: '2026-10-13T09:00:00.000Z',
  field: null,
  table: null,
  row: null,
  column: null,
  oldValue: null,
  newValue: null,
  editor: null,
  reason: null,
  ...o,
});
const cell = (row: number, column: string, oldValue: unknown, newValue: unknown) =>
  edit({ table: 'line_items', row, column, oldValue, newValue });

describe('correctionKey / correctionOutput', () => {
  it.each<[string, Partial<ReviewEdit>, string, string]>([
    ['a field', { field: 'total' }, 'total', 'total'],
    ['a table cell', { table: 'line_items', row: 3, column: 'amount' }, 'line_items[3].amount', 'line_items'],
  ])('%s', (_name, e, key, output) => {
    expect(correctionKey(edit(e))).toBe(key);
    expect(correctionOutput(key)).toBe(output);
  });
});

describe('correctionsFromEdits', () => {
  it.each<[string, ReviewEdit[], Correction[]]>([
    ['no edits', [], []],
    [
      'a changed value is corrected',
      [edit({ field: 'total', oldValue: '3,912.00', newValue: '4,694.40' })],
      [{ key: 'total', kind: 'corrected', proposed: '3,912.00' }],
    ],
    [
      'a value the model left empty is entered',
      [edit({ field: 'due_date', oldValue: null, newValue: '2026-09-11' })],
      [{ key: 'due_date', kind: 'entered', proposed: null }],
    ],
    [
      'a blank string or empty list counts as empty',
      [
        edit({ field: 'po_number', oldValue: '  ', newValue: 'PO-1' }),
        edit({ field: 'tags', oldValue: [], newValue: ['x'] }),
      ],
      [
        { key: 'po_number', kind: 'entered', proposed: '  ' },
        { key: 'tags', kind: 'entered', proposed: [] },
      ],
    ],
    [
      'several edits of one key: first old value, last new value',
      [
        edit({ field: 'total', oldValue: '10', newValue: '11' }),
        edit({ field: 'total', oldValue: '11', newValue: '12' }),
      ],
      [{ key: 'total', kind: 'corrected', proposed: '10' }],
    ],
    [
      'edited back to what the model proposed: no correction',
      [
        edit({ field: 'vat', oldValue: '782.40', newValue: '0' }),
        edit({ field: 'vat', oldValue: '0', newValue: '782.40' }),
      ],
      [],
    ],
    [
      'empty to empty: no correction',
      [edit({ field: 'notes', oldValue: null, newValue: '' })],
      [],
    ],
    [
      'clearing a proposed value is a correction',
      [edit({ field: 'vat', oldValue: '1.00', newValue: null })],
      [{ key: 'vat', kind: 'corrected', proposed: '1.00' }],
    ],
    [
      'table cells are keyed per row and column',
      [cell(2, 'qty', '1', '2'), cell(3, 'qty', null, '5')],
      [
        { key: 'line_items[2].qty', kind: 'corrected', proposed: '1' },
        { key: 'line_items[3].qty', kind: 'entered', proposed: null },
      ],
    ],
    [
      'object values compare by content, not key order',
      [edit({ field: 'party', oldValue: { a: 1, b: 2 }, newValue: { b: 2, a: 1 } })],
      [],
    ],
  ])('%s', (_name, edits, expected) => {
    expect(correctionsFromEdits(edits)).toEqual(expected);
  });

  it('orders by edit id, whatever order the edits come in', () => {
    const first = edit({ field: 'total', oldValue: '1', newValue: '2' });
    const second = edit({ field: 'total', oldValue: '2', newValue: '1' });
    expect(correctionsFromEdits([second, first])).toEqual([]);
  });
});

describe('referenceCorrections', () => {
  const saved = '2026-10-13T10:00:00.000Z';
  const edits = [edit({ field: 'total', oldValue: '1', newValue: '2', editor: 'kim' })];
  const review = { status: 'succeeded' as const, reviewer: 'ken', reviewedAt: '2026-10-13T09:59:00.000Z', edits };

  it.each<[string, Parameters<typeof referenceCorrections>[0], ReturnType<typeof referenceCorrections>]>([
    ['reviewed before the save', review, { corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }], verifiedBy: 'ken' }],
    ['reviewed at the save', { ...review, reviewedAt: saved }, { corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }], verifiedBy: 'ken' }],
    ['no reviewer: the last editor verified it', { ...review, reviewer: null }, { corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }], verifiedBy: 'kim' }],
    ['no source job', null, { corrections: null, verifiedBy: null }],
    ['re-run since (review cleared)', { ...review, status: 'queued', reviewedAt: null, edits: [] }, { corrections: null, verifiedBy: null }],
    ['reviewed again after the save', { ...review, reviewedAt: '2026-10-13T10:00:00.001Z' }, { corrections: null, verifiedBy: null }],
    ['not approved', { ...review, status: 'awaiting_review' }, { corrections: null, verifiedBy: null }],
  ])('%s', (_name, input, expected) => {
    expect(referenceCorrections(input, saved)).toEqual(expected);
  });
});

describe('outputProvenance', () => {
  it.each<[string, Correction[], string]>([
    ['nothing changed', [], 'model'],
    ['entered only', [{ key: 'due_date', kind: 'entered', proposed: null }], 'entered'],
    [
      'any correction wins',
      [
        { key: 'line_items[1].qty', kind: 'entered', proposed: null },
        { key: 'line_items[2].qty', kind: 'corrected', proposed: '1' },
      ],
      'corrected',
    ],
  ])('%s', (_name, corrections, expected) => {
    expect(outputProvenance(corrections)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project shared packages/shared/test/corrections.test.ts` → FAIL (`correctionsFromEdits` is not exported).

- [ ] **Step 3: Implement** — `packages/shared/src/corrections.ts`:

```ts
import { z } from 'zod';
import { stableJson } from './drafting.js';
import type { JobStatus, ReviewEdit } from './jobs.js';

/**
 * What the reviewer changed in a reference run (handoff RF1), derived from the run's
 * `review_edits` when references are read; nothing is stored. Keys are a field id, or
 * `table[row].column` for a table cell (1-based row, as in review_edits): the output id is the
 * text before `[` (template ids never contain one), so grouping per output needs no lookup.
 */
export const CORRECTION_KINDS = ['corrected', 'entered'] as const;
export const CorrectionSchema = z.object({
  key: z.string(),
  /** corrected: the model proposed a value the reviewer changed; entered: it proposed nothing. */
  kind: z.enum(CORRECTION_KINDS),
  /** The model's value (the first edit's old value). */
  proposed: z.unknown(),
});
export type Correction = z.infer<typeof CorrectionSchema>;

type EditTarget = Pick<ReviewEdit, 'field' | 'table' | 'row' | 'column'>;

export const correctionKey = (e: EditTarget): string =>
  e.field ?? `${e.table ?? ''}[${e.row ?? 0}].${e.column ?? ''}`;

export const correctionOutput = (key: string): string => key.split('[')[0]!;

/** No value: null, undefined, a blank string or an empty list. */
export const emptyValue = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/** One correction per key edited: the first edit's old value against the last edit's new one. */
export function correctionsFromEdits(edits: readonly ReviewEdit[]): Correction[] {
  const byKey = new Map<string, { proposed: unknown; final: unknown }>();
  for (const e of [...edits].sort((a, b) => a.id - b.id)) {
    const key = correctionKey(e);
    const seen = byKey.get(key);
    byKey.set(key, { proposed: seen ? seen.proposed : e.oldValue, final: e.newValue });
  }
  return [...byKey].flatMap(([key, { proposed, final }]): Correction[] => {
    if (emptyValue(proposed) && emptyValue(final)) return [];
    if (stableJson(proposed) === stableJson(final)) return [];
    return [{ key, kind: emptyValue(proposed) ? 'entered' : 'corrected', proposed: proposed ?? null }];
  });
}

/** The review of a reference's source job (`IngestionRepo.listJobReviews`). */
export interface ReviewRecord {
  status: JobStatus;
  reviewer: string | null;
  reviewedAt: string | null;
  edits: readonly ReviewEdit[];
}

/**
 * A saved reference's corrections and who verified it. Null corrections mean unknown: no source
 * job, or the job was re-run (its edits are deleted) or reviewed again after the save, so its
 * edits no longer describe the saved values. `verifiedBy`: the approver, else the last editor.
 */
export function referenceCorrections(
  review: ReviewRecord | null,
  savedAt: string,
): { corrections: Correction[] | null; verifiedBy: string | null } {
  if (
    review === null ||
    review.status !== 'succeeded' ||
    review.reviewedAt === null ||
    review.reviewedAt > savedAt
  ) {
    return { corrections: null, verifiedBy: null };
  }
  const lastEditor = [...review.edits].sort((a, b) => a.id - b.id).at(-1)?.editor ?? null;
  return {
    corrections: correctionsFromEdits(review.edits),
    verifiedBy: review.reviewer ?? lastEditor,
  };
}

export const PROVENANCES = ['model', 'corrected', 'entered'] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** An output's provenance from its own corrections: MODEL ✓, CORRECTED or BY HAND. */
export function outputProvenance(corrections: readonly Correction[]): Provenance {
  if (corrections.length === 0) return 'model';
  return corrections.some((c) => c.kind === 'corrected') ? 'corrected' : 'entered';
}
```

`packages/shared/src/index.ts`: add `export * from './corrections.js';` after `./references.js`.

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project shared`; `npm run typecheck`; `npx eslint packages/shared`; `npx prettier --write packages/shared/src/corrections.ts packages/shared/src/index.ts packages/shared/test/corrections.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/corrections.ts packages/shared/src/index.ts packages/shared/test/corrections.test.ts
git commit -m "Shared: reference corrections derived from review edits (RF1 logic)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared schemas and aggregates — `ReferenceInfo`, `ReferenceDetail`, `rightFirstTime`, `outputNeeds`

**Files:**
- Modify: `packages/shared/src/evaluation.ts` (`ReferenceInfoSchema`, `ReferenceRowSchema`, `ReferenceDetailSchema`)
- Modify: `packages/shared/src/corrections.ts` (`rightFirstTime`, `outputNeeds`)
- Test: `packages/shared/test/corrections.test.ts`, `packages/shared/test/dto.test.ts`

**Interfaces:**
- Produces:
  - `ReferenceInfoSchema` (= the old row `reference` object plus `sourceJobId: string | null`, `verifiedBy: string | null`, `corrections: Correction[] | null`, `reverified: { from: number; changed: string[] } | null`); `ReferenceRowSchema.reference = ReferenceInfoSchema.nullable()`; `type ReferenceInfo`
  - `ReferenceValueSchema` / `ReferenceValue = { id; kind: 'field' | 'table'; value: unknown; provenance: Provenance | null; proposed: unknown; corrections: Correction[] }`
  - `ReferenceDetailSchema` / `ReferenceDetail = { sampleId; filename; role: SampleRole; reference: ReferenceInfo; run: { jobId; modelOverride: string | null; models: string[] } | null; values: ReferenceValue[]; corrections: Correction[] | null }`
  - `rightFirstTime(rows: readonly ReferenceRow[], definition: unknown): { right: number; total: number; references: number; excluded: string[] }`
  - `outputNeeds(rows: readonly ReferenceRow[], definition: unknown): OutputNeed[]`, `OutputNeed = { id; kind: 'field' | 'table'; corrected: number; entered: number; hasStep: boolean }`
- Consumed by: API (Tasks 4–5), web (Tasks 6–8).

- [ ] **Step 1: Write the failing tests** — append to `packages/shared/test/corrections.test.ts` (add `outputNeeds`, `rightFirstTime`, `type ReferenceRow`, `type ReferenceInfo` to the import):

```ts
const definition = {
  outputs: {
    fields: [{ id: 'supplier_name' }, { id: 'total' }, { id: 'due_date' }],
    tables: [{ id: 'line_items', columns: [{ id: 'qty' }] }],
  },
  pipeline: [
    { type: 'extract', id: 'head', fields: ['supplier_name', 'total'] },
    { type: 'extract', id: 'lines', table: 'line_items' },
  ],
}; // due_date: no step fills it

const info = (o: Partial<ReferenceInfo> = {}): ReferenceInfo => ({
  id: crypto.randomUUID(),
  name: 'r',
  createdAt: '2026-10-13T09:00:00.000Z',
  version: 4,
  carriedFrom: null,
  outdated: [],
  sourceJobId: crypto.randomUUID(),
  verifiedBy: 'ken',
  corrections: [],
  reverified: null,
  ...o,
});
const row = (reference: ReferenceInfo | null): ReferenceRow => ({
  sampleId: crypto.randomUUID(),
  filename: 'a.pdf',
  sha256: 'sha',
  reference,
  run: null,
});
const corrected = (key: string): Correction => ({ key, kind: 'corrected', proposed: 'x' });
const entered = (key: string): Correction => ({ key, kind: 'entered', proposed: null });

describe('rightFirstTime', () => {
  it.each<[string, ReferenceRow[], ReturnType<typeof rightFirstTime>]>([
    ['no references', [row(null)], { right: 0, total: 0, references: 0, excluded: ['due_date'] }],
    [
      'three values per reference, due_date excluded',
      [row(info()), row(info({ corrections: [corrected('total'), entered('due_date')] }))],
      { right: 5, total: 6, references: 2, excluded: ['due_date'] },
    ],
    [
      'a table is one value however many cells changed',
      [row(info({ corrections: [corrected('line_items[1].qty'), entered('line_items[2].qty')] }))],
      { right: 2, total: 3, references: 1, excluded: ['due_date'] },
    ],
    [
      'outdated references and unknown corrections do not count',
      [row(info({ outdated: ['field:total'] })), row(info({ corrections: null })), row(info())],
      { right: 3, total: 3, references: 1, excluded: ['due_date'] },
    ],
  ])('%s', (_name, rows, expected) => {
    expect(rightFirstTime(rows, definition)).toEqual(expected);
  });
});

describe('outputNeeds', () => {
  it('counts per output the references where it was corrected or only entered', () => {
    const rows = [
      row(info({ corrections: [corrected('supplier_name'), entered('due_date')] })),
      row(info({ corrections: [entered('due_date'), entered('line_items[1].qty'), corrected('line_items[2].qty')] })),
      row(info({ corrections: null })), // unknown: not counted
      row(null),
    ];
    expect(outputNeeds(rows, definition)).toEqual([
      { id: 'supplier_name', kind: 'field', corrected: 1, entered: 0, hasStep: true },
      { id: 'total', kind: 'field', corrected: 0, entered: 0, hasStep: true },
      { id: 'due_date', kind: 'field', corrected: 0, entered: 2, hasStep: false },
      { id: 'line_items', kind: 'table', corrected: 1, entered: 0, hasStep: true },
    ]);
  });
});
```

`packages/shared/test/dto.test.ts`: add rows (import `ReferenceRowSchema`, `ReferenceDetailSchema` if not imported):

```ts
  [
    'ReferenceRow',
    ReferenceRowSchema,
    {
      sampleId: '7a1b2c3d-0000-4000-8000-000000000001',
      filename: 'a.pdf',
      sha256: 'sha',
      reference: {
        id: '7a1b2c3d-0000-4000-8000-000000000002',
        name: 'a',
        createdAt: at,
        version: 4,
        carriedFrom: null,
        outdated: [],
        sourceJobId: null,
        verifiedBy: null,
        corrections: null,
        reverified: { from: 3, changed: ['field:due_date'] },
      },
      run: null,
    },
    'sha256',
  ],
  [
    'ReferenceDetail',
    ReferenceDetailSchema,
    {
      sampleId: '7a1b2c3d-0000-4000-8000-000000000001',
      filename: 'a.pdf',
      role: 'holdout',
      reference: {
        id: '7a1b2c3d-0000-4000-8000-000000000002',
        name: 'a',
        createdAt: at,
        version: 4,
        carriedFrom: 3,
        outdated: [],
        sourceJobId: '7a1b2c3d-0000-4000-8000-000000000003',
        verifiedBy: 'ken',
        corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }],
        reverified: null,
      },
      run: { jobId: '7a1b2c3d-0000-4000-8000-000000000003', modelOverride: null, models: ['local/qwen'] },
      values: [
        {
          id: 'total',
          kind: 'field',
          value: '2',
          provenance: 'corrected',
          proposed: '1',
          corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }],
        },
      ],
      corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }],
    },
    'values',
  ],
```

(Follow the table's existing shape `[name, schema, valid value, required key]`; if `at` is not defined in that file, use the constant it already uses for timestamps.)

- [ ] **Step 2: Run** `npx vitest run --project shared packages/shared/test/corrections.test.ts packages/shared/test/dto.test.ts` → FAIL (`rightFirstTime` not exported; `ReferenceDetailSchema` undefined; `reference.sourceJobId` stripped/missing).

- [ ] **Step 3: Implement** — `packages/shared/src/evaluation.ts`: import `CorrectionSchema, PROVENANCES` from `./corrections.js` and `SampleRoleSchema` from `./workbench.js` (neither imports `evaluation.ts` at runtime). Replace the `reference` object of `ReferenceRowSchema`:

```ts
/** A sample's reference for the current version, with what the reviewer changed (RF1). */
export const ReferenceInfoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string(),
  /** Version it is pinned to; null for an unpinned (legacy) reference. */
  version: z.number().int().nullable(),
  /** Version it was carried forward from, when it is a copy. */
  carriedFrom: z.number().int().nullable(),
  /** `outputChanges` against the version's outputs: non-empty means re-verify before use. */
  outdated: z.array(z.string()),
  /** The reviewed run the values were saved from; null when unknown or deleted. */
  sourceJobId: z.string().uuid().nullable(),
  /** The run's approver (else its last editor); null when unknown. */
  verifiedBy: z.string().nullable(),
  /**
   * What the reviewer changed (derived from the run's review edits); null when unknown: no
   * source run, or it was re-run or reviewed again after the save.
   */
  corrections: z.array(CorrectionSchema).nullable(),
  /**
   * Set when this reference re-verified a carried copy at the same version: the version that
   * copy came from and its output changes (why it needed verifying again).
   */
  reverified: z.object({ from: z.number().int(), changed: z.array(z.string()) }).nullable(),
});
export type ReferenceInfo = z.infer<typeof ReferenceInfoSchema>;
```

and in `ReferenceRowSchema` use `reference: ReferenceInfoSchema.nullable(),`; change its JSDoc to "One ready sample (dev or holdout) on the References tab." After `ReferenceRow`:

```ts
/** One output of a reference with where its value came from (handoff RF2). */
export const ReferenceValueSchema = z.object({
  id: z.string(),
  kind: z.enum(['field', 'table']),
  /** A field's expected value, or a table's expected rows. */
  value: z.unknown(),
  /** null: the corrections are unknown. */
  provenance: z.enum(PROVENANCES).nullable(),
  /** A corrected field: the model's value (shown struck through); otherwise null. */
  proposed: z.unknown(),
  /** This output's corrections (cells for a table). */
  corrections: z.array(CorrectionSchema),
});
export type ReferenceValue = z.infer<typeof ReferenceValueSchema>;

/** `GET /api/workbench/projects/:id/references/:sid` (handoff RF2): the References detail panel. */
export const ReferenceDetailSchema = z.object({
  sampleId: z.string().uuid(),
  filename: z.string(),
  role: SampleRoleSchema,
  reference: ReferenceInfoSchema,
  /** The run that proposed the values; null when it is unknown or deleted. */
  run: z
    .object({
      jobId: z.string().uuid(),
      modelOverride: z.string().nullable(),
      /** Models its succeeded step runs used (cached runs included), in first-use order. */
      models: z.array(z.string()),
    })
    .nullable(),
  /** One per output of the current version, in definition order (fields, then tables). */
  values: z.array(ReferenceValueSchema),
  corrections: z.array(CorrectionSchema).nullable(),
});
export type ReferenceDetail = z.infer<typeof ReferenceDetailSchema>;
```

`packages/shared/src/corrections.ts` — add `import { outputCoverage } from './template.js';` and `import type { ReferenceRow } from './evaluation.js';` (type-only: no runtime cycle), then:

```ts
/** References that count in figures: verified for the current outputs, corrections known. */
const knownReferences = (rows: readonly ReferenceRow[]) =>
  rows.flatMap((r) =>
    r.reference !== null && r.reference.outdated.length === 0 && r.reference.corrections !== null
      ? [r.reference.corrections]
      : [],
  );

/**
 * Right first time (handoff §7): of the values in verified references, those the model proposed
 * correctly. One value per output per reference (a table is one value: right when no cell
 * changed); outputs no step fills are `excluded` (nothing proposed them).
 */
export function rightFirstTime(rows: readonly ReferenceRow[], definition: unknown) {
  const coverage = outputCoverage(definition);
  const counted = coverage.outputs.filter((o) => o.steps.length > 0).map((o) => o.id);
  const references = knownReferences(rows);
  const right = references.reduce(
    (sum, corrections) =>
      sum + counted.filter((id) => !corrections.some((c) => correctionOutput(c.key) === id)).length,
    0,
  );
  return {
    right,
    total: references.length * counted.length,
    references: references.length,
    excluded: coverage.uncovered,
  };
}

export interface OutputNeed {
  id: string;
  kind: 'field' | 'table';
  /** References where a value the model proposed was changed. */
  corrected: number;
  /** References where the model proposed nothing and every change was typed in. */
  entered: number;
  /** Some extract step fills it (else the strip links to Steps). */
  hasStep: boolean;
}

/** "Where the draft model needed you": per output, how many references changed it, and how. */
export function outputNeeds(rows: readonly ReferenceRow[], definition: unknown): OutputNeed[] {
  const references = knownReferences(rows);
  return outputCoverage(definition).outputs.map((o) => {
    const kinds = references.map((cs) =>
      outputProvenance(cs.filter((c) => correctionOutput(c.key) === o.id)),
    );
    return {
      id: o.id,
      kind: o.kind,
      corrected: kinds.filter((k) => k === 'corrected').length,
      entered: kinds.filter((k) => k === 'entered').length,
      hasStep: o.steps.length > 0,
    };
  });
}
```

(`outputProvenance` is defined earlier in the same file.)

- [ ] **Step 4: Run** the Step 2 command → PASS. `npm run typecheck` now fails where `ReferenceRow.reference` objects are built: `apps/api/src/routes/workbench.ts` (`referenceEntries`, fixed in Task 4 — for now add the four fields as `sourceJobId: reference.sourceJobId, verifiedBy: null, corrections: null, reverified: null` so the tree compiles; Task 4 replaces them) and `apps/web/test/ReferencesTab.test.tsx` (three literals: add `sourceJobId: null, verifiedBy: null, corrections: null, reverified: null`; the file is rewritten in Task 7). Then `npx vitest run --project shared --project api --project web` → PASS; eslint; prettier on the changed files.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/evaluation.ts packages/shared/src/corrections.ts packages/shared/test/corrections.test.ts packages/shared/test/dto.test.ts apps/api/src/routes/workbench.ts apps/web/test/ReferencesTab.test.tsx
git commit -m "Shared: reference info with corrections, reference detail schema, right first time and output needs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `IngestionRepo.listJobReviews` — one query for many jobs (Memory + Pg)

**Files:**
- Modify: `apps/api/src/repositories/types.ts`, `apps/api/src/repositories/memory.ts`, `apps/api/src/repositories/pg.ts`
- Test: `apps/api/test/repo.test.ts` (or the Memory repo test file that covers `addEdit`/`approve`; find it with `grep -l "addEdit" apps/api/test/*.ts`), `apps/api/test/integration/workbench-pg.test.ts`

**Interfaces:**
- Produces: `interface JobReview extends ReviewRecord { jobId: string; modelOverride: string | null }` (exported from `types.ts`); `IngestionRepo.listJobReviews(jobIds: readonly string[]): Promise<JobReview[]>` — one entry per existing job (unknown ids are left out, duplicates collapse), edits in id order.
- Consumed by: `referenceEntries` (Task 4).

- [ ] **Step 1: Write the failing tests** — in the Memory repo test file (it builds `new MemoryRepo()` and creates jobs with `createDocumentAndJob`; reuse its document helper):

```ts
  it('lists the reviews of several jobs with their edits, leaving out unknown ids', async () => {
    const repo = new MemoryRepo();
    const a = await repo.createDocumentAndJob(doc(), null, true);
    const b = await repo.createDocumentAndJob(doc(), null, true);
    repo.jobs.set(a.id, { ...repo.jobs.get(a.id)!, status: 'awaiting_review' });
    const e1 = await repo.addEdit(a.id, {
      field: 'total', table: null, row: null, column: null,
      oldValue: '1', newValue: '2', editor: 'kim', reason: null,
    });
    await repo.approve(a.id, 'ken', null);
    const reviews = await repo.listJobReviews([a.id, b.id, a.id, crypto.randomUUID()]);
    expect(reviews).toEqual([
      { jobId: a.id, status: 'queued', reviewer: 'ken', reviewedAt: expect.any(String), modelOverride: null, edits: [e1] },
      { jobId: b.id, status: 'queued', reviewer: null, reviewedAt: null, modelOverride: null, edits: [] },
    ]);
    expect(await repo.listJobReviews([])).toEqual([]);
  });
```

(`doc()` is the file's existing `NewDocument` helper; if it has none, build one as `workbench-pg.test.ts` does.)

`apps/api/test/integration/workbench-pg.test.ts`:

```ts
  it('lists job reviews with their edits in one query, edits in id order with ISO times', async () => {
    const projectId = await newProject();
    const a = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'process', modelOverride: 'draft' });
    const b = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'process' });
    await pool.query(`UPDATE jobs SET status = 'awaiting_review' WHERE id = $1`, [a.id]);
    const first = await repo.addEdit(a.id, {
      field: 'total', table: null, row: null, column: null,
      oldValue: '1', newValue: '2', editor: 'kim', reason: null,
    });
    const second = await repo.addEdit(a.id, {
      field: null, table: 'line_items', row: 2, column: 'qty',
      oldValue: null, newValue: 5, editor: 'kim', reason: 'missing',
    });
    await repo.approve(a.id, 'ken', null);
    await pool.query(`UPDATE jobs SET status = 'succeeded' WHERE id = $1`, [a.id]);

    const reviews = await repo.listJobReviews([b.id, a.id, randomUUID()]);
    const byId = new Map(reviews.map((r) => [r.jobId, r]));
    expect(reviews).toHaveLength(2);
    expect(byId.get(a.id)).toEqual({
      jobId: a.id,
      status: 'succeeded',
      reviewer: 'ken',
      reviewedAt: expect.stringMatching(/Z$/),
      modelOverride: 'draft',
      edits: [first, second],
    });
    expect(byId.get(b.id)).toMatchObject({ status: 'queued', reviewer: null, reviewedAt: null, edits: [] });
    expect(await repo.listJobReviews([])).toEqual([]);
  });
```

(`first`/`second` come from `addEdit`'s `toEdit`, so equality proves the aggregated rows are mapped the same way, `at` included.)

- [ ] **Step 2: Run** `npx vitest run --project api <memory repo test file>` → FAIL (`listJobReviews` is not a function).

- [ ] **Step 3: Implement** — `apps/api/src/repositories/types.ts`: import `type ReviewRecord` from `@ih/shared`; add

```ts
/** A job's review as references read it (handoff RF1): decision, reviewer and every edit. */
export interface JobReview extends ReviewRecord {
  jobId: string;
  modelOverride: string | null;
}
```

and in `IngestionRepo`, in the review section after `listEdits`:

```ts
  /**
   * Reviews of several jobs in one call (the References tab's corrections): one entry per
   * existing job, in no particular order; unknown ids are left out, duplicates collapse.
   */
  listJobReviews(jobIds: readonly string[]): Promise<JobReview[]>;
```

`apps/api/src/repositories/memory.ts`:

```ts
  async listJobReviews(jobIds: readonly string[]): Promise<JobReview[]> {
    return [...new Set(jobIds)].flatMap((id) => {
      const job = this.jobs.get(id);
      if (!job) return [];
      return [
        {
          jobId: id,
          status: job.status,
          reviewer: job.reviewer,
          reviewedAt: job.reviewedAt,
          modelOverride: job.modelOverride,
          edits: this.edits.get(id) ?? [],
        },
      ];
    });
  }
```

`apps/api/src/repositories/pg.ts`:

```ts
  async listJobReviews(jobIds: readonly string[]): Promise<JobReview[]> {
    if (jobIds.length === 0) return [];
    // One round trip for every row of a References list (no per-reference query); edits use
    // review_edits_job_idx (job_id, id).
    const { rows } = await this.pool.query<{
      id: string;
      status: JobStatus;
      reviewer: string | null;
      reviewed_at: Date | null;
      model_override: string | null;
      edits: (Omit<EditRow, 'at'> & { at: string })[];
    }>(
      `SELECT j.id, j.status, j.reviewer, j.reviewed_at, j.model_override,
              coalesce(json_agg(e ORDER BY e.id) FILTER (WHERE e.id IS NOT NULL), '[]') AS edits
         FROM jobs j LEFT JOIN review_edits e ON e.job_id = j.id
        WHERE j.id = ANY($1::uuid[])
        GROUP BY j.id`,
      [[...new Set(jobIds)]],
    );
    return rows.map((r) => ({
      jobId: r.id,
      status: r.status,
      reviewer: r.reviewer,
      reviewedAt: r.reviewed_at?.toISOString() ?? null,
      modelOverride: r.model_override,
      // json_agg renders timestamptz as text: parse it back so `at` matches toEdit's ISO.
      edits: r.edits.map((e) => toEdit({ ...e, at: new Date(e.at) })),
    }));
  }
```

(`EditRow` is the existing row type used by `toEdit`; `json_agg(e)` emits the table's column names — `id`, `job_id`, `at`, `field_id`, `table_id`, `row_number`, `column_id`, `old_value`, `new_value`, `editor`, `reason` — the same keys `toEdit` reads. `id` is a bigserial: `toEdit` already does `Number(r.id)`. Import `JobReview` from `./types.js` in both repos and `JobStatus` from `@ih/shared` if not yet imported in `pg.ts`.)

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project api`; `npm run typecheck`; eslint; prettier. Then the Pg integration test on a throwaway container:

```bash
docker run --rm -d --name ih-test-pg-ct4 -e POSTGRES_PASSWORD=test -p 55448:5432 postgres:17-alpine
IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55448/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg
docker rm -f ih-test-pg-ct4
```

→ PASS (the new test and every existing one).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/repositories/types.ts apps/api/src/repositories/memory.ts apps/api/src/repositories/pg.ts apps/api/test/integration/workbench-pg.test.ts <memory repo test file>
git commit -m "API repo: list several jobs' reviews and edits in one query

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: API — reference rows carry corrections, verifiedBy, sourceJobId and reverified (RF1)

**Files:**
- Modify: `apps/api/src/routes/workbench.ts` (`currentReferences`, `ReferenceEntry`, `referenceEntries`, `listReferenceRows` description)
- Test: `apps/api/test/workbench-references.test.ts`, `apps/api/test/workbench-versions.test.ts`
- Regenerate: `docs/openapi.json`

**Interfaces:**
- Produces: `ReferenceEntry` gains `reference: CurrentReference | null` (the full current reference, `expected` included) — used by RF2 (Task 5); `currentDefinition(app, projectId)` helper `{ version: number | null; definition: Record<string, unknown> | null }`.
- Consumed by: Task 5, overview (`referenceRows`, unchanged signature).

- [ ] **Step 1: Write the failing tests** — `apps/api/test/workbench-references.test.ts`, a helper in `project()` that makes a reviewed reference run (returned with the others):

```ts
  /** A reference run of sample `s`, reviewed with `edits`, approved by `reviewer` and saved. */
  const reviewed = async (
    s: SampleView,
    edits: Omit<NewEdit, 'editor' | 'reason'>[],
    reviewer: string | null = 'ken',
  ) => {
    const [job] = (await propose()).json().jobs as { id: string; documentId: string }[];
    ctx.repo.jobs.set(job!.id, { ...ctx.repo.jobs.get(job!.id)!, status: 'awaiting_review' });
    for (const e of edits) await ctx.repo.addEdit(job!.id, { ...e, editor: 'kim', reason: null });
    await ctx.repo.approve(job!.id, reviewer, null);
    ctx.repo.jobs.set(job!.id, { ...ctx.repo.jobs.get(job!.id)!, status: 'succeeded' });
    const reference = await ctx.repo.createReference({
      templateId: 'letter',
      name: s.filename,
      documentId: job!.documentId,
      sourceJobId: job!.id,
      expected: { fields: { sender: 'Acme Ltd' }, tables: {} },
      templateVersion: 1,
      verifiedOutputs: letter(1).outputs,
    });
    return { job: job!, reference };
  };
```

(import `type NewEdit` from `../src/repositories/types.js`.) Tests:

```ts
describe('reference corrections (RF1)', () => {
  const field = (f: string, oldValue: unknown, newValue: unknown) =>
    ({ field: f, table: null, row: null, column: null, oldValue, newValue });

  it('derives corrections and the reviewer from the source run, in one review query', async () => {
    const { add, skipAll, reviewed, rows, repo } = await project();
    const s = await add(1);
    await skipAll();
    const { job } = await reviewed(s, [field('sender', 'Acme', 'Acme Ltd')]);
    const spy = vi.spyOn(repo, 'listJobReviews');
    const [row] = await rows();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(row!.reference).toMatchObject({
      sourceJobId: job.id,
      verifiedBy: 'ken',
      corrections: [{ key: 'sender', kind: 'corrected', proposed: 'Acme' }],
      reverified: null,
    });
  });

  it('reports a value the model left empty as entered, and no corrections as []', async () => {
    const { add, skipAll, reviewed, rows } = await project();
    const s1 = await add(1);
    const s2 = await add(2);
    await skipAll();
    await reviewed(s1, [field('sender', null, 'Acme Ltd')]);
    await reviewed(s2, []);
    const [r1, r2] = await rows();
    expect(r1!.reference!.corrections).toEqual([{ key: 'sender', kind: 'entered', proposed: null }]);
    expect(r2!.reference!.corrections).toEqual([]);
  });

  it('says corrections are unknown once the source run was retried after the save', async () => {
    const { app, add, skipAll, reviewed, rows } = await project();
    const s = await add(1);
    await skipAll();
    const { job } = await reviewed(s, [field('sender', 'Acme', 'Acme Ltd')]);
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` })).statusCode).toBe(200);
    expect((await rows())[0]!.reference).toMatchObject({ corrections: null, verifiedBy: null });
  });

  it('says corrections are unknown without a source run', async () => {
    const { add, skipAll, rows, repo } = await project();
    const s = await add(1);
    await skipAll();
    const doc = [...repo.documents.values()].find((d) => d.sha256 === s.sha256)!;
    await repo.createReference({
      templateId: 'letter', name: 's1', documentId: doc.id, sourceJobId: null,
      expected: { fields: { sender: 'Acme' }, tables: {} },
    });
    expect((await rows())[0]!.reference).toMatchObject({
      sourceJobId: null, verifiedBy: null, corrections: null,
    });
  });

  it('reads holdout rows the same way', async () => {
    const { app, add, skipAll, repo } = await project();
    const h = await add(2, 'holdout');
    await skipAll();
    const started = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/holdout/reference-runs',
    });
    const [job] = started.json().jobs as { id: string; documentId: string }[];
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'awaiting_review' });
    await repo.approve(job!.id, 'ken', null);
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'succeeded' });
    await repo.createReference({
      templateId: 'letter', name: h.filename, documentId: job!.documentId, sourceJobId: job!.id,
      expected: { fields: { sender: 'Acme' }, tables: {} }, templateVersion: 1,
      verifiedOutputs: letter(1).outputs,
    });
    const [row] = (
      await app.inject('/api/workbench/projects/letter/references?set=holdout')
    ).json() as ReferenceRow[];
    expect(row!.reference).toMatchObject({ verifiedBy: 'ken', corrections: [] });
  });
});
```

(Add `vi` to the vitest import. If `POST /api/jobs/:id/retry` of a succeeded test run needs a body or answers 201, follow what `apps/api/test/jobs.test.ts` does for retry; the assertion that matters is the row afterwards.)

`apps/api/test/workbench-versions.test.ts`, test "re-verifying replaces the outdated copy; v1 keeps its reference" — extend the `toMatchObject`:

```ts
    expect(row!.reference).toMatchObject({
      id: fresh.id,
      version: 2,
      carriedFrom: null,
      outdated: [],
      reverified: { from: 1, changed: ['field:sender'] },
    });
```

and in "carries v1 references to draft v2; unchanged outputs keep them verified": `expect(row!.reference).toMatchObject({ version: 2, carriedFrom: 1, outdated: [], reverified: null });`.

- [ ] **Step 2: Run** `npx vitest run --project api apps/api/test/workbench-references.test.ts apps/api/test/workbench-versions.test.ts` → FAIL (corrections `null` everywhere from Task 2's placeholder; `reverified` null).

- [ ] **Step 3: Implement** — `apps/api/src/routes/workbench.ts`, import `referenceCorrections` and `type ReferenceInfo` from `@ih/shared`.

Split the definition read out of `currentReferences`:

```ts
/** The project's current version (open draft, else latest published) and its definition. */
async function currentDefinition(app: FastifyInstance, projectId: string) {
  const { draft, published } = await versionsOf(app.deps.templates, projectId);
  const version = draft ?? published;
  const record = version === null ? null : await app.deps.templates.get(projectId, version);
  return {
    draft,
    version,
    definition: (record?.definition as Record<string, unknown> | undefined) ?? null,
  };
}

type CurrentReference = Awaited<ReturnType<typeof currentReferences>>[number];
```

`currentReferences` becomes:

```ts
async function currentReferences(app: FastifyInstance, projectId: string) {
  const { draft, version, definition } = await currentDefinition(app, projectId);
  if (draft !== null) await app.deps.repo.carryReferencesForward(projectId, draft);
  const all = await app.deps.repo.listReferencesWithSha(projectId);
  const outputs = definition?.outputs ?? null;
  const versionOfRow = new Map(all.map((r) => [r.id, r.templateVersion]));
  // A re-verification supersedes the carried copy of the same PDF at the same version: that
  // copy says which version it came from and which output changes made it outdated.
  const replacedCopy = (r: (typeof all)[number]) =>
    r.copiedFrom !== null || r.templateVersion === null
      ? null
      : (all.find(
          (o) =>
            o.supersededAt !== null &&
            o.copiedFrom !== null &&
            o.sha256 === r.sha256 &&
            o.templateVersion === r.templateVersion,
        ) ?? null); // `all` is newest first
  return all
    .filter(
      (r) =>
        r.supersededAt === null && (r.templateVersion === null || r.templateVersion === version),
    )
    .map((r) => {
      const copy = replacedCopy(r);
      const from = copy === null ? null : (versionOfRow.get(copy.copiedFrom!) ?? null);
      return {
        ...r,
        carriedFrom: r.copiedFrom === null ? null : (versionOfRow.get(r.copiedFrom) ?? null),
        outdated: outputChanges(r.verifiedOutputs, outputs),
        reverified:
          copy === null || from === null
            ? null
            : { from, changed: outputChanges(copy.verifiedOutputs, r.verifiedOutputs) },
      };
    });
}
```

`ReferenceEntry` gains `reference: CurrentReference | null;`. In `referenceEntries`, after `const runs = …`, read every source run's review in one query:

```ts
  const picked = samples.map(
    (s) =>
      references.find((r) => r.sha256 === s.sha256 && r.templateVersion !== null) ??
      references.find((r) => r.sha256 === s.sha256) ??
      null,
  );
  const sourceIds = picked.flatMap((r) => (r?.sourceJobId ? [r.sourceJobId] : []));
  const reviews = new Map(
    (sourceIds.length ? await app.deps.repo.listJobReviews(sourceIds) : []).map((r) => [
      r.jobId,
      r,
    ]),
  );
```

and in the `samples.map((s, i) => …)` use `const reference = picked[i]!;` (replacing the inline `find`s) and build the info with:

```ts
    const info = (r: CurrentReference): ReferenceInfo => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      version: r.templateVersion,
      carriedFrom: r.carriedFrom,
      outdated: r.outdated,
      sourceJobId: r.sourceJobId,
      ...referenceCorrections(
        (r.sourceJobId && reviews.get(r.sourceJobId)) || null,
        r.createdAt,
      ),
      reverified: r.reverified,
    });
```

returning `{ draftRun, reference, row: { …, reference: reference && info(reference), … } }` (remove Task 2's placeholder fields). Only call `listJobReviews` when there is at least one id (the empty case makes no query, as above).

`listReferenceRows` description — replace with:

```ts
        description: md`
          One row per ready sample of the set (\`dev\` by default, or \`holdout\`): its
          reference for the open draft's version, if any (pinned version, the version it was
          carried from, \`outdated\`: output changes since it was verified, which mean verify it
          again, and \`reverified\`: the carried copy a re-verification replaced and why), and its
          latest reference or test run. \`corrections\` (handoff RF1) is derived from the
          reviewed run's edits: \`corrected\` where the model proposed a value the reviewer
          changed, \`entered\` where it proposed nothing; keys are a field id or
          \`table[row].column\` (1-based row). It is \`null\` when unknown: no source run, or the
          run was re-run or reviewed again after the save. \`verifiedBy\` is the run's approver,
          else its last editor.
        `,
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project api` (overview, evaluation and conformance tests use `referenceRows` too) → PASS; `npm run openapi`; `npm run typecheck`; eslint; prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/test/workbench-references.test.ts apps/api/test/workbench-versions.test.ts docs/openapi.json
git commit -m "Workbench API: reference rows carry corrections, verifiedBy and why they were re-verified (RF1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: API — `GET /api/workbench/projects/:id/references/:sid` (RF2)

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`
- Test: `apps/api/test/workbench-references.test.ts`
- Regenerate: `docs/openapi.json`

**Interfaces:**
- Produces: `GET /api/workbench/projects/:id/references/:sid` → `200 ReferenceDetail`, `404 project not found | sample not found | no reference for this sample` — `operationId: 'getReferenceDetail'`, tag `Drafting stages & proposals`, not admin-only.
- Consumed by: web client (Task 6).

- [ ] **Step 1: Write the failing tests** — append to `apps/api/test/workbench-references.test.ts` (`detail` helper in `project()`: `const detail = (sid: string) => ctx.app.inject(\`/api/workbench/projects/letter/references/${sid}\`);`; import `type ReferenceDetail`):

```ts
describe('reference detail (RF2)', () => {
  const field = (f: string, oldValue: unknown, newValue: unknown) =>
    ({ field: f, table: null, row: null, column: null, oldValue, newValue });

  it('returns each output with its provenance, the run that proposed it and its models', async () => {
    const { add, skipAll, reviewed, detail, repo } = await project();
    const s = await add(1);
    await skipAll();
    const { job, reference } = await reviewed(s, [field('sender', 'Acme', 'Acme Ltd')]);
    repo.stepRuns.set(job.id, [
      {
        id: 1, stepId: 'head', trigger: 'process', model: 'local/qwen', attempts: 1,
        inputTokens: 1, outputTokens: 1, status: 'succeeded', cached: false, error: null,
        startedAt: '2026-10-13T09:00:00.000Z', finishedAt: '2026-10-13T09:00:01.000Z',
      },
    ]);
    const res = await detail(s.id);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReferenceDetail;
    expect(body).toMatchObject({
      sampleId: s.id,
      filename: 's1.pdf',
      role: 'dev',
      reference: { id: reference.id, verifiedBy: 'ken', sourceJobId: job.id },
      run: { jobId: job.id, modelOverride: 'draft', models: ['local/qwen'] },
      corrections: [{ key: 'sender', kind: 'corrected', proposed: 'Acme' }],
    });
    expect(body.values).toEqual([
      {
        id: 'sender',
        kind: 'field',
        value: 'Acme Ltd',
        provenance: 'corrected',
        proposed: 'Acme',
        corrections: [{ key: 'sender', kind: 'corrected', proposed: 'Acme' }],
      },
    ]);
  });

  it('marks values the reviewer typed as entered and untouched ones as model', async () => {
    const { add, skipAll, reviewed, detail } = await project();
    const s1 = await add(1);
    const s2 = await add(2);
    await skipAll();
    await reviewed(s1, [field('sender', null, 'Acme Ltd')]);
    await reviewed(s2, []);
    expect(((await detail(s1.id)).json() as ReferenceDetail).values[0]).toMatchObject({
      provenance: 'entered',
      proposed: null,
    });
    expect(((await detail(s2.id)).json() as ReferenceDetail).values[0]).toMatchObject({
      provenance: 'model',
      proposed: null,
      corrections: [],
    });
  });

  it('serves holdout samples, with null provenance when the corrections are unknown', async () => {
    const { add, skipAll, detail, repo } = await project();
    const h = await add(3, 'holdout');
    await skipAll();
    const doc = [...repo.documents.values()].find((d) => d.sha256 === h.sha256)!;
    await repo.createReference({
      templateId: 'letter', name: 'h', documentId: doc.id, sourceJobId: null,
      expected: { fields: { sender: 'Globex' }, tables: {} },
    });
    const body = (await detail(h.id)).json() as ReferenceDetail;
    expect(body).toMatchObject({ role: 'holdout', run: null, corrections: null });
    expect(body.values[0]).toMatchObject({ value: 'Globex', provenance: null });
  });

  it.each([
    ['an unknown project', '/api/workbench/projects/nope/references/00000000-0000-4000-8000-000000000000', 'project not found'],
    ['an unknown sample', '/api/workbench/projects/letter/references/00000000-0000-4000-8000-000000000000', 'sample not found'],
    ['a malformed sample id', '/api/workbench/projects/letter/references/x', 'sample not found'],
  ])('is a 404 for %s', async (_name, url, error) => {
    const { app } = await project();
    const res = await app.inject(url);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error });
  });

  it('is a 404 for a sample without a reference', async () => {
    const { add, detail } = await project();
    const s = await add(1);
    const res = await detail(s.id);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no reference for this sample' });
  });
});
```

(`repo.stepRuns` is the MemoryRepo map behind `listStepRuns`; if its value type differs, set it the way `apps/api/test/review.test.ts` seeds step runs.)

- [ ] **Step 2: Run** `npx vitest run --project api apps/api/test/workbench-references.test.ts` → FAIL (404 route not found for every detail call).

- [ ] **Step 3: Implement** — `apps/api/src/routes/workbench.ts`, import `ReferenceDetailSchema, correctionOutput, outputCoverage, outputProvenance, type ReferenceDetail` from `@ih/shared`. A function next to `referenceRows`:

```ts
/**
 * One sample's reference with each current output's value and provenance (handoff RF2), or why
 * there is none. Reads the sample's set the same way as `referenceRows` (one review query).
 */
async function referenceDetail(
  app: FastifyInstance,
  projectId: string,
  sampleId: string,
): Promise<ReferenceDetail | 'sample not found' | 'no reference for this sample'> {
  const views = await sampleViews(app, projectId);
  const sample = views.find((s) => s.record.id === sampleId);
  if (!sample) return 'sample not found';
  const entry = (await referenceEntries(app, projectId, sample.view.role, views)).find(
    (e) => e.row.sampleId === sampleId,
  );
  if (!entry?.reference || !entry.row.reference) return 'no reference for this sample';
  const { reference } = entry;
  const info = entry.row.reference;
  const { definition } = await currentDefinition(app, projectId);
  const values = outputCoverage(definition).outputs.map((o) => {
    const own =
      info.corrections === null
        ? null
        : info.corrections.filter((c) => correctionOutput(c.key) === o.id);
    const first = own?.[0];
    return {
      id: o.id,
      kind: o.kind,
      value:
        o.kind === 'field'
          ? (reference.expected.fields[o.id] ?? null)
          : (reference.expected.tables[o.id] ?? []),
      provenance: own === null ? null : outputProvenance(own),
      proposed: o.kind === 'field' && first?.kind === 'corrected' ? first.proposed : null,
      corrections: own ?? [],
    };
  });
  const job = info.sourceJobId ? await app.deps.repo.getJob(info.sourceJobId) : null;
  const models = job
    ? [
        ...new Set(
          (await app.deps.repo.listStepRuns(job.id)).flatMap((r) =>
            r.status === 'succeeded' && r.model ? [r.model] : [],
          ),
        ),
      ]
    : [];
  return {
    sampleId,
    filename: sample.record.filename,
    role: sample.view.role,
    reference: info,
    run: job && { jobId: job.id, modelOverride: job.modelOverride, models },
    values,
    corrections: info.corrections,
  };
}
```

(`referenceEntries` filters to ready samples of the role: a preparing or failed sample gives 'no reference for this sample'.) The route, after `listReferenceRows`:

```ts
  app.get<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/references/:sid',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'getReferenceDetail',
        summary: "Read one sample's reference",
        description: md`
          The References tab's detail panel (handoff RF2): the sample's reference for the
          current version (as in the list), the run that proposed its values (job, model
          override, the models its step runs used) and one entry per output of the current
          version with the expected value (a table's rows) and its provenance: \`model\` (the
          model proposed it and nobody changed it), \`corrected\` (with the model's value in
          \`proposed\` for a field) or \`entered\` (the model proposed nothing); \`null\` when the
          corrections are unknown. Dev and holdout samples alike: holdout values are shown to
          the user, never to a model.
        `,
        params: SampleIdParams,
        response: {
          200: res('The reference.', ReferenceDetailSchema),
          404: error(
            '`project not found`, `sample not found` or `no reference for this sample` (none yet, or the sample is not ready).',
          ),
        },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const params = SampleParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'sample not found' });
      const detail = await referenceDetail(app, params.data.id, params.data.sid);
      if (typeof detail === 'string') return reply.code(404).send({ error: detail });
      return detail;
    },
  );
```

(`SampleIdParams`/`SampleParams` are the existing schemas of the `samples/:sid` routes: the same `id` + uuid `sid`.)

- [ ] **Step 4: Run** the Step 2 command → PASS; `npm run openapi`; `npx vitest run --project api` (openapi docs test: tags, summary, unique `operationId`, 2xx; conformance; the access sweep) → PASS; `npm run typecheck`; eslint; prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/test/workbench-references.test.ts docs/openapi.json
git commit -m "Workbench API: one reference's values with provenance (RF2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web — `getReferenceDetail`, `fakeApi`, pure References helpers

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/client.test.ts`
- Create: `apps/web/src/workbench/references.ts`, `apps/web/test/references-derive.test.ts`

**Interfaces:**
- Produces:
  - `Api.getReferenceDetail(projectId: string, sampleId: string): Promise<ReferenceDetail>`
  - `fake-api.ts`: `referenceInfo(overrides?: Partial<ReferenceInfo>): ReferenceInfo`, `referenceDetail(overrides?: Partial<ReferenceDetail>): ReferenceDetail`; `fakeApi()` gains `getReferenceDetail: vi.fn(async () => referenceDetail())`
  - `references.ts`: `verified(row)`, `isActive(status)`, `tracker(row): { ran: boolean; reviewed: boolean; saved: boolean }`, `trackerLabel(t)`, `rowStatus(row): string`, `rowLine(row, version: number | null): string`, `correctionSummary(row): string`, `unverifiedCount(rows): number`, `REFERENCE_FILTERS = ['all', 'corrected', 'needs'] as const`, `matchesFilter(row, filter)`, `readyBanner(dev, holdout, version): { ready: boolean; text: string }`, `reviewHref(row): string | null`, `shortDateTime(iso)`
- Consumed by: `ReferencesTab` (Tasks 7–8).

- [ ] **Step 1: Write the failing tests**

`apps/web/test/client.test.ts`, in `describe('http api: evaluation')`, a new `it`:

```ts
  it('reads one reference detail', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.getReferenceDetail('letter', 's1');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/workbench/projects/letter/references/s1');
  });
```

`apps/web/test/references-derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ReferenceRow } from '@ih/shared';
import {
  correctionSummary,
  matchesFilter,
  readyBanner,
  reviewHref,
  rowLine,
  rowStatus,
  tracker,
  trackerLabel,
  unverifiedCount,
} from '../src/workbench/references.js';
import { referenceInfo, referenceRow } from './fake-api.js';

const run = (status: NonNullable<ReferenceRow['run']>['status']) => ({
  jobId: 'j1',
  status,
  error: null,
  modelOverride: 'draft',
});
const saved = (o = {}) => referenceRow({ reference: referenceInfo(o) });

describe('tracker and status', () => {
  it.each<[string, ReferenceRow, [boolean, boolean, boolean], string]>([
    ['not run', referenceRow(), [false, false, false], 'Not run'],
    ['running', referenceRow({ run: run('running') }), [false, false, false], 'Running'],
    ['awaiting review', referenceRow({ run: run('awaiting_review') }), [true, false, false], 'Awaiting review'],
    ['approved, not saved', referenceRow({ run: run('succeeded') }), [true, true, false], 'Reviewed — save it as the reference'],
    ['run failed', referenceRow({ run: run('needs_review') }), [false, false, false], 'Run needs attention'],
    ['verified', saved(), [true, true, true], 'Verified'],
    ['outdated', saved({ outdated: ['field:due_date'] }), [true, true, false], 'Re-verify: field:due_date changed'],
  ])('%s', (_name, row, steps, status) => {
    const t = tracker(row);
    expect([t.ran, t.reviewed, t.saved]).toEqual(steps);
    expect(rowStatus(row)).toBe(status);
  });

  it('labels the tracker with every step', () => {
    expect(trackerLabel({ ran: true, reviewed: true, saved: false })).toBe(
      'Run: done · Reviewed: done · Saved: not yet',
    );
  });
});

describe('row text', () => {
  it.each<[string, ReferenceRow, RegExp | string]>([
    ['no reference', referenceRow(), 'Not verified yet'],
    ['verified at this version', saved({ version: 4 }), /^Verified in v4 · /],
    ['carried', saved({ version: 4, carriedFrom: 3 }), /^Carried from v3 · /],
    ['re-verified', saved({ version: 4, reverified: { from: 3, changed: [] } }), /^Re-verified in v4 · .+ · was v3$/],
    ['unpinned', saved({ version: null }), /^Verified · /],
  ])('%s', (_name, row, expected) => {
    const line = rowLine(row, 4);
    if (typeof expected === 'string') expect(line).toBe(expected);
    else expect(line).toMatch(expected);
  });

  it.each<[string, ReferenceRow, string]>([
    ['no reference', referenceRow(), ''],
    ['nothing changed', saved({ corrections: [] }), 'No corrections'],
    ['unknown', saved({ corrections: null }), 'Corrections unknown'],
    [
      'corrected outputs, once each, entered ones left to the strip',
      saved({
        corrections: [
          { key: 'line_items[1].qty', kind: 'corrected', proposed: '1' },
          { key: 'line_items[2].qty', kind: 'corrected', proposed: '2' },
          { key: 'total', kind: 'corrected', proposed: '3' },
          { key: 'due_date', kind: 'entered', proposed: null },
        ],
      }),
      'Corrected: line_items, total',
    ],
    ['only entered', saved({ corrections: [{ key: 'due_date', kind: 'entered', proposed: null }] }), 'No corrections'],
  ])('%s', (_name, row, expected) => {
    expect(correctionSummary(row)).toBe(expected);
  });

  it('links Review to the source run of a reference, else the latest run', () => {
    expect(reviewHref(saved({ sourceJobId: 'src' }))).toBe('#/review/src');
    expect(reviewHref(referenceRow({ run: run('awaiting_review') }))).toBe('#/review/j1');
    expect(reviewHref(referenceRow({ run: run('running') }))).toBeNull();
    expect(reviewHref(referenceRow())).toBeNull();
  });
});

describe('filters, counts and the ready banner', () => {
  const corrected = saved({ corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }] });
  const clean = saved();
  const outdated = saved({ outdated: ['field:vat'] });
  const open = referenceRow({ run: run('running') });
  const none = referenceRow();

  it.each<[string, ReferenceRow, boolean, boolean]>([
    ['corrected', corrected, true, false],
    ['clean', clean, false, false],
    ['outdated', outdated, false, true],
    ['running', open, false, true],
    ['nothing yet', none, false, true],
  ])('%s', (_name, row, isCorrected, needsYou) => {
    expect(matchesFilter(row, 'all')).toBe(true);
    expect(matchesFilter(row, 'corrected')).toBe(isCorrected);
    expect(matchesFilter(row, 'needs')).toBe(needsYou);
  });

  it('counts unverified samples without an active run', () => {
    expect(unverifiedCount([corrected, outdated, open, none])).toBe(2);
  });

  it.each<[string, ReferenceRow[], ReferenceRow[], { ready: boolean; text: string }]>([
    ['no dev samples', [], [clean], { ready: false, text: '' }],
    ['one unverified', [clean, none], [clean], { ready: false, text: '' }],
    [
      'all verified',
      [clean, corrected],
      [clean],
      { ready: true, text: '2 dev and 1 holdout references match the draft v4 outputs.' },
    ],
    [
      'with re-verifications',
      [saved({ reverified: { from: 3, changed: ['field:due_date'] } }), saved({ reverified: { from: 3, changed: ['field:due_date', 'table:line_items.qty'] } })],
      [],
      {
        ready: true,
        text: '2 dev and 0 holdout references match the draft v4 outputs. 2 were re-verified this version because these outputs changed: due_date, line_items.qty.',
      },
    ],
  ])('%s', (_name, dev, holdout, expected) => {
    expect(readyBanner(dev, holdout, 4)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/references-derive.test.ts apps/web/test/client.test.ts` → FAIL (module missing; `getReferenceDetail` not a function).

- [ ] **Step 3: Implement**

`apps/web/src/api/client.ts`: import `type ReferenceDetail`; in `Api` after `listReferenceRows`:

```ts
  /** One sample's reference with each output's provenance (handoff RF2). */
  getReferenceDetail(projectId: string, sampleId: string): Promise<ReferenceDetail>;
```

and in `createHttpApi` after `listReferenceRows`:

```ts
    getReferenceDetail: (id, sid) =>
      apiFetch(`${base}/workbench/projects/${id}/references/${sid}`).then(json<ReferenceDetail>),
```

`apps/web/test/fake-api.ts` (import `ReferenceDetail`, `ReferenceInfo`):

```ts
export function referenceInfo(overrides: Partial<ReferenceInfo> = {}): ReferenceInfo {
  return {
    id: crypto.randomUUID(),
    name: 'a',
    createdAt: '2026-10-11T16:55:00.000Z',
    version: 2,
    carriedFrom: null,
    outdated: [],
    sourceJobId: 'src-job',
    verifiedBy: 'ken',
    corrections: [],
    reverified: null,
    ...overrides,
  };
}

export function referenceDetail(overrides: Partial<ReferenceDetail> = {}): ReferenceDetail {
  return {
    sampleId: crypto.randomUUID(),
    filename: 'a.pdf',
    role: 'dev',
    reference: referenceInfo(),
    run: { jobId: 'src-job', modelOverride: 'draft', models: ['local/qwen'] },
    values: [],
    corrections: [],
    ...overrides,
  };
}
```

and in `fakeApi()` after `listReferenceRows`: `getReferenceDetail: vi.fn(async () => referenceDetail()),`.

`apps/web/src/workbench/references.ts`:

```ts
import { correctionOutput, type JobStatus, type ReferenceRow } from '@ih/shared';

/** Pure helpers of the References tab (handoff §7). */

export const isActive = (status: JobStatus) => status === 'queued' || status === 'running';

/** A reference that Evaluate can use: present and verified against the current outputs. */
export const verified = (row: ReferenceRow) =>
  row.reference !== null && row.reference.outdated.length === 0;

export interface Tracker {
  ran: boolean;
  reviewed: boolean;
  saved: boolean;
}

/** Run → Reviewed → Saved. A saved (even outdated) reference was run and reviewed. */
export function tracker(row: ReferenceRow): Tracker {
  const status = row.run?.status ?? null;
  const reviewed = row.reference !== null || status === 'succeeded';
  return { ran: reviewed || status === 'awaiting_review', reviewed, saved: verified(row) };
}

export const trackerLabel = (t: Tracker) =>
  [`Run: ${t.ran ? 'done' : 'not yet'}`, `Reviewed: ${t.reviewed ? 'done' : 'not yet'}`, `Saved: ${t.saved ? 'done' : 'not yet'}`].join(' · ');

export function rowStatus(row: ReferenceRow): string {
  if (row.reference) {
    return row.reference.outdated.length === 0
      ? 'Verified'
      : `Re-verify: ${row.reference.outdated.join(', ')} changed`;
  }
  const status = row.run?.status ?? null;
  if (status === null) return 'Not run';
  if (isActive(status)) return 'Running';
  if (status === 'awaiting_review') return 'Awaiting review';
  if (status === 'succeeded') return 'Reviewed — save it as the reference';
  return 'Run needs attention';
}

/** "11 Oct 16:55" in the viewer's time zone. */
export const shortDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** "Re-verified in v4 · 11 Oct 16:55 · was v3", "Carried from v3 · …", "Verified in v4 · …". */
export function rowLine(row: ReferenceRow, version: number | null): string {
  const r = row.reference;
  if (!r) return 'Not verified yet';
  const at = shortDateTime(r.createdAt);
  if (r.carriedFrom !== null) return `Carried from v${r.carriedFrom} · ${at}`;
  const v = r.version ?? null;
  if (v === null) return `Verified · ${at}`;
  if (r.reverified) return `Re-verified in v${v} · ${at} · was v${r.reverified.from}`;
  return `Verified in v${v ?? version} · ${at}`;
}

/** Outputs the reviewer corrected (entered-by-hand values show in the strip and the panel). */
export function correctionSummary(row: ReferenceRow): string {
  const r = row.reference;
  if (!r) return '';
  if (r.corrections === null) return 'Corrections unknown';
  const outputs = [
    ...new Set(r.corrections.filter((c) => c.kind === 'corrected').map((c) => correctionOutput(c.key))),
  ];
  return outputs.length ? `Corrected: ${outputs.join(', ')}` : 'No corrections';
}

export const reviewHref = (row: ReferenceRow): string | null => {
  if (row.reference?.sourceJobId) return `#/review/${row.reference.sourceJobId}`;
  const run = row.run;
  return run && (run.status === 'awaiting_review' || run.status === 'succeeded')
    ? `#/review/${run.jobId}`
    : null;
};

/** Samples a run button would queue: no verified reference and no active run. */
export const unverifiedCount = (rows: readonly ReferenceRow[]) =>
  rows.filter((r) => !verified(r) && !(r.run && isActive(r.run.status))).length;

export const REFERENCE_FILTERS = ['all', 'corrected', 'needs'] as const;
export type ReferenceFilter = (typeof REFERENCE_FILTERS)[number];

export function matchesFilter(row: ReferenceRow, filter: ReferenceFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'corrected') {
    return verified(row) && (row.reference!.corrections ?? []).some((c) => c.kind === 'corrected');
  }
  return !verified(row);
}

const outputName = (key: string) => key.replace(/^(field|table):/, '');

/** The ready banner: every dev and holdout sample has a verified reference (at least one dev). */
export function readyBanner(
  dev: readonly ReferenceRow[],
  holdout: readonly ReferenceRow[],
  version: number | null,
): { ready: boolean; text: string } {
  if (dev.length === 0 || ![...dev, ...holdout].every(verified)) return { ready: false, text: '' };
  const again = [...dev, ...holdout].filter((r) => r.reference!.reverified !== null);
  const changed = [
    ...new Set(again.flatMap((r) => r.reference!.reverified!.changed.map(outputName))),
  ];
  const why =
    again.length === 0
      ? ''
      : ` ${again.length} ${again.length === 1 ? 'was' : 'were'} re-verified this version${
          changed.length ? ` because these outputs changed: ${changed.join(', ')}` : ''
        }.`;
  return {
    ready: true,
    text: `${dev.length} dev and ${holdout.length} holdout references match the draft v${version ?? '?'} outputs.${why}`,
  };
}
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web`; `npm run typecheck`; `npx eslint apps/web`; prettier on the changed files.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/test/client.test.ts apps/web/src/workbench/references.ts apps/web/test/references-derive.test.ts
git commit -m "Workbench web: getReferenceDetail and pure References helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: References tab — header, ready banner, three cards, "Where the draft model needed you"

**Files:**
- Modify: `apps/web/src/workbench/ReferencesTab.tsx` (rewrite, part 1), `apps/web/src/workbench/ProjectPage.tsx`, `apps/web/src/styles/stages.css`
- Test: `apps/web/test/ReferencesTab.test.tsx` (rewrite)

**Interfaces:**
- Consumes: `readyBanner`, `unverifiedCount`, `isActive`, `verified` (Task 6), `rightFirstTime`, `outputNeeds` (Task 2), `useDefinitions`, `TabHeader`, `Meter`.
- Produces: `ReferencesTab` props become `{ api; projectId; dataPolicy; draft: number | null; published: number | null; item?: OverviewItem | null; pollMs; onChanged }` (`hasDraft` is `draft !== null`).

- [ ] **Step 1: Write the failing tests** — rewrite `apps/web/test/ReferencesTab.test.tsx`. Deliberate changes from the old file (Review Focus 6): the "References"/"Holdout references" tables are replaced by the Samples list (Task 8), the button names carry counts, "Verify in Review" becomes "Review". Part 1 (this task):

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OverviewItem, ReferenceRow } from '@ih/shared';
import { ReferencesTab } from '../src/workbench/ReferencesTab.js';
import { fakeApi, job, referenceInfo, referenceRow, templateView } from './fake-api.js';

const definition = {
  id: 'letter',
  version: 2,
  name: 'Letter',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: {
    fields: [{ id: 'sender' }, { id: 'total' }, { id: 'due_date' }],
    tables: [],
  },
  pipeline: [{ type: 'extract', id: 'head', fields: ['sender', 'total'], sections: ['all'] }],
};
const item: OverviewItem = { stage: 'references', state: 'pending', status: 'Optional, not started', metrics: [] };
const run = (status: NonNullable<ReferenceRow['run']>['status'], jobId = 'j1') => ({
  jobId,
  status,
  error: null,
  modelOverride: 'draft',
});
const saved = (filename: string, o = {}) =>
  referenceRow({ filename, reference: referenceInfo({ name: filename, ...o }) });

function tab(
  rows: { dev?: ReferenceRow[]; holdout?: ReferenceRow[] } = {},
  overrides = {},
  props: Partial<{ draft: number | null; published: number | null }> = {},
) {
  const api = fakeApi({
    listReferenceRows: vi.fn(async (_id: string, set?: string) =>
      set === 'holdout' ? (rows.holdout ?? []) : (rows.dev ?? []),
    ),
    getTemplate: vi.fn(async () => templateView(definition)),
    ...overrides,
  });
  const onChanged = vi.fn();
  render(
    <ReferencesTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      draft={props.draft === undefined ? 2 : props.draft}
      published={props.published === undefined ? 1 : props.published}
      item={item}
      pollMs={1}
      onChanged={onChanged}
    />,
  );
  return { api, onChanged };
}

describe('ReferencesTab', () => {
  it('has the tab header with the optional status, the description and Skip', async () => {
    const { api, onChanged } = tab({}, { skipStage: vi.fn(async () => []) });
    const header = (await screen.findByRole('heading', { level: 2, name: 'References' })).closest('header')!;
    expect(within(header).getByText('Optional, not started')).toBeInTheDocument();
    expect(within(header).getByText(/you correct and approve them in Review and save them as the reference/)).toBeInTheDocument();
    await userEvent.click(within(header).getByRole('button', { name: 'Skip this stage' }));
    expect(api.skipStage).toHaveBeenCalledWith('letter', 'references');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('runs the draft model on the unverified count, and gives the reason when it cannot', async () => {
    const { api, onChanged } = tab(
      { dev: [referenceRow({ filename: 'a.pdf' }), saved('b.pdf')] },
      { proposeReferences: vi.fn(async () => [job()]) },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Run the draft model on 1 unverified' }));
    expect(api.proposeReferences).toHaveBeenCalledWith('letter');
    expect(onChanged).toHaveBeenCalled();
  });

  it.each<[string, ReferenceRow[], number | null, string]>([
    ['no draft', [referenceRow()], null, 'Start a draft version first'],
    ['every dev sample verified', [saved('a.pdf')], 2, 'Every dev sample has a verified reference'],
    ['runs in progress', [referenceRow({ run: run('running') })], 2, 'Reference runs are still running'],
  ])('disables the dev run button: %s', async (_name, dev, draft, reason) => {
    tab({ dev }, {}, { draft });
    const button = await screen.findByRole('button', { name: /^Run the draft model on \d+ unverified$/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', reason);
  });

  it('shows the ready banner with why references were re-verified, and links to Evaluate', async () => {
    tab({
      dev: [saved('a.pdf', { reverified: { from: 1, changed: ['field:due_date'] } }), saved('b.pdf')],
      holdout: [saved('h.pdf')],
    });
    const banner = await screen.findByRole('region', { name: 'Ready to evaluate' });
    expect(banner).toHaveTextContent(
      'Ready to evaluate. 2 dev and 1 holdout references match the draft v2 outputs. 1 was re-verified this version because these outputs changed: due_date.',
    );
    expect(within(banner).getByRole('link', { name: 'Go to Evaluate' })).toHaveAttribute(
      'href',
      '#/workbench/letter/evaluate',
    );
  });

  it('has no ready banner while a sample is unverified', async () => {
    tab({ dev: [saved('a.pdf'), referenceRow({ filename: 'b.pdf' })] });
    await screen.findByText('b.pdf');
    expect(screen.queryByRole('region', { name: 'Ready to evaluate' })).toBeNull();
  });

  it('shows the dev, holdout and right-first-time cards', async () => {
    tab({
      dev: [
        saved('a.pdf'),
        saved('b.pdf', { corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }] }),
        referenceRow({ filename: 'c.pdf' }),
      ],
      holdout: [saved('h.pdf'), referenceRow({ filename: 'i.pdf' })],
    });
    const dev = (await screen.findByRole('heading', { name: 'Dev references' })).closest('section')!;
    expect(dev).toHaveTextContent('2 / 3verified for v2');
    expect(within(dev).getByRole('img', { name: 'Dev references verified: 67%' })).toBeInTheDocument();
    const holdout = screen.getByRole('heading', { name: 'Holdout references' }).closest('section')!;
    expect(holdout).toHaveTextContent('1 / 2verified for v2');
    expect(holdout).toHaveTextContent('Extracted by the template’s own models — never seen by drafting');
    const right = screen.getByRole('heading', { name: 'Right first time' }).closest('section')!;
    expect(right).toHaveTextContent('3 / 475% of dev values');
    expect(right).toHaveTextContent('Excludes due_date, which no step fills yet');
  });

  it('counts per output where the draft model needed you, and links an output without a step to Steps', async () => {
    tab({
      dev: [
        saved('a.pdf', { corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }, { key: 'due_date', kind: 'entered', proposed: null }] }),
        saved('b.pdf', { corrections: [{ key: 'due_date', kind: 'entered', proposed: null }] }),
      ],
    });
    const strip = (await screen.findByRole('heading', { name: 'Where the draft model needed you' })).closest('section')!;
    const chips = within(strip).getAllByRole('listitem');
    expect(chips.map((c) => c.textContent)).toEqual([
      'sender 0 — right first time',
      'total 1 — corrected',
      'due_date 2 — entered by hand',
    ]);
    expect(within(strip).getByRole('link', { name: 'the Steps tab' })).toHaveAttribute(
      'href',
      '#/workbench/letter/steps',
    );
    expect(strip).toHaveTextContent('due_date has no step yet — add one on the Steps tab.');
  });
});
```

(`templateView(definition)` is the existing `TemplateRecordView` builder in `fake-api.ts`, as `SectionsTab.test.tsx` uses it; `fakeApi()`'s default `getTemplate` throws, so every test here stubs it.)

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/ReferencesTab.test.tsx` → FAIL (old component: no header, no cards, old button names).

- [ ] **Step 3: Implement** — rewrite the top of `apps/web/src/workbench/ReferencesTab.tsx` (the Samples list and detail panel come in Task 8; leave a placeholder `<SamplesSection …/>` call out until then):

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  outputNeeds,
  rightFirstTime,
  type DataPolicy,
  type OverviewItem,
  type ReferenceRow,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Meter } from '../ui/Meter.js';
import { TabHeader } from './TabHeader.js';
import { isActive, readyBanner, unverifiedCount, verified } from './references.js';
import { useDefinitions } from './useDefinitions.js';

const DESCRIPTION =
  'The draft model proposes the values for each dev sample; you correct and approve them in Review and save them as the reference. Evaluate scores every run against these references. Optional: without references Evaluate has nothing to score.';

const percent = (n: number, of: number) => (of === 0 ? 0 : n / of);

function runReason(
  hasDraft: boolean,
  running: boolean,
  count: number,
  set: 'dev' | 'holdout',
): string | null {
  if (!hasDraft) return 'Start a draft version first';
  if (running) return 'Reference runs are still running';
  if (count === 0) return `Every ${set} sample has a verified reference`;
  return null;
}

/** Stage 5 (handoff §7): the draft model proposes values; the user verifies them in Review. */
export function ReferencesTab({
  api,
  projectId,
  dataPolicy,
  draft,
  published,
  item = null,
  pollMs,
  onChanged,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  draft: number | null;
  published: number | null;
  item?: OverviewItem | null;
  pollMs: number;
  onChanged: () => void;
}) {
  const hasDraft = draft !== null;
  const version = draft ?? published;
  const { draftDef } = useDefinitions(api, projectId, version, null, version !== null);
  const [rows, setRows] = useState<ReferenceRow[] | null>(null);
  const [holdoutRows, setHoldoutRows] = useState<ReferenceRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // refresh, polling and act(): unchanged from the previous component.
  // …
  const dev = rows ?? [];
  const holdout = holdoutRows ?? [];
  const running = [...dev, ...holdout].some((r) => r.run !== null && isActive(r.run.status));
  const devCount = unverifiedCount(dev);
  const holdoutCount = unverifiedCount(holdout);
  const devReason = runReason(hasDraft, busy || running, devCount, 'dev');
  const banner = readyBanner(dev, holdout, version);
  const right = useMemo(() => rightFirstTime(dev, draftDef), [dev, draftDef]);
  const needs = useMemo(() => outputNeeds(dev, draftDef), [dev, draftDef]);

  return (
    <div className="references-tab">
      <TabHeader
        title="References"
        item={item}
        description={DESCRIPTION}
        note={POLICY_NOTE[dataPolicy]}
        actions={
          <>
            <button
              type="button"
              disabled={devReason !== null}
              title={devReason ?? undefined}
              onClick={() => void propose()}
            >
              Run the draft model on {devCount} unverified
            </button>
            <button type="button" disabled={busy} onClick={() => void skip()}>
              Skip this stage
            </button>
          </>
        }
      />
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {banner.ready && (
        <section className="card refs-ready" aria-label="Ready to evaluate">
          <p>
            <strong>Ready to evaluate.</strong> {banner.text}
          </p>
          <a className="button primary" href={`#/workbench/${projectId}/evaluate`}>
            Go to Evaluate
          </a>
        </section>
      )}
      <div className="refs-cards">
        <RefCard
          title="Dev references"
          n={dev.filter(verified).length}
          of={dev.length}
          version={version}
          tone="ok"
          note="Proposed by the draft model, corrected by you"
        />
        <RefCard
          title="Holdout references"
          n={holdout.filter(verified).length}
          of={holdout.length}
          version={version}
          tone="skip"
          note="Extracted by the template’s own models — never seen by drafting"
        />
        <section className="card refs-card">
          <h3>Right first time</h3>
          <p className="refs-figure">
            <strong>
              {right.right} / {right.total}
            </strong>
            <span className="muted">{Math.round(percent(right.right, right.total) * 100)}% of dev values</span>
          </p>
          <Meter label="Right first time" value={right.total ? right.right / right.total : null} tone="info" />
          <p className="muted">
            {right.excluded.length
              ? `Excludes ${right.excluded.join(', ')}, which no step fills yet`
              : 'Every output has a step'}
          </p>
        </section>
      </div>
      <NeedsStrip projectId={projectId} needs={needs} samples={right.references} />
      {/* Samples list and detail panel: Task 8 */}
    </div>
  );
}

function RefCard({ title, n, of, version, tone, note }: {
  title: string; n: number; of: number; version: number | null;
  tone: 'ok' | 'skip'; note: string;
}) {
  return (
    <section className={`card refs-card${tone === 'skip' ? ' refs-card-holdout' : ''}`}>
      <h3>{title}</h3>
      <p className="refs-figure">
        <strong>
          {n} / {of}
        </strong>
        <span className="muted">verified for v{version ?? '?'}</span>
      </p>
      <Meter label={`${title} verified`} value={of ? n / of : null} tone={tone} />
      <p className="muted">{note}</p>
    </section>
  );
}

const NEED_TEXT = { ok: 'right first time', warn: 'corrected', info: 'entered by hand' } as const;

function NeedsStrip({ projectId, needs, samples }: {
  projectId: string; needs: ReturnType<typeof outputNeeds>; samples: number;
}) {
  const noStep = needs.filter((n) => !n.hasStep);
  return (
    <section className="card refs-needs">
      <h3>Where the draft model needed you</h3>
      <p className="muted">Values you changed in Review, per output, across the {samples} dev samples</p>
      <ul className="refs-chips">
        {needs.map((n) => {
          const tone = n.corrected > 0 ? 'warn' : n.entered > 0 ? 'info' : 'ok';
          return (
            <li key={n.id} className={`refs-chip tone-${tone}`}>
              <code>{n.id}</code> <span className="refs-chip-count">{n.corrected + n.entered}</span>
              <span className="visually-hidden"> — {NEED_TEXT[tone]}</span>
            </li>
          );
        })}
      </ul>
      <p className="refs-legend muted">
        <span className="tone-ok">● Right first time</span>{' '}
        <span className="tone-warn">● Corrected</span>{' '}
        <span className="tone-info">● Entered by hand (model left it empty)</span>
      </p>
      {noStep.length > 0 && (
        <p>
          {noStep.map((n) => n.id).join(', ')} {noStep.length === 1 ? 'has' : 'have'} no step yet — add one on{' '}
          <a href={`#/workbench/${projectId}/steps`}>the Steps tab</a>.
        </p>
      )}
    </section>
  );
}
```

(Keep the old `POLICY_NOTE`, `refresh`, the polling effect, `act`, `propose`, `proposeHoldout` and `skip` as they are. The chip's accessible text is "`id` `count` — `meaning`"; the test reads `textContent`, which includes the visually hidden part. The `.visually-hidden` class already exists — `SectionChip` uses it.)

`apps/web/src/workbench/ProjectPage.tsx`: remove `{tab === 'references' && header('references')}` and pass the new props:

```tsx
          {tab === 'references' && (
            <ReferencesTab
              key={`references-${revision}`}
              api={api}
              projectId={project.id}
              dataPolicy={project.dataPolicy}
              draft={draft}
              published={published}
              item={itemOf('references')}
              pollMs={pollMs}
              onChanged={changed}
            />
          )}
```

`apps/web/src/styles/stages.css` — extend the card padding block at the end (add `.refs-ready, .refs-card, .refs-needs, .refs-samples, .refs-detail` to the `padding: 12px 16px` list and their `h3` to the `font-weight: 600` list), then:

```css
.refs-ready {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  margin-bottom: 16px;
  border-color: var(--ih-ok-fg);
  background: var(--ih-ok-bg);
}
.refs-ready p {
  min-width: 0;
  margin: 0;
}
.refs-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.refs-card {
  min-width: 0;
}
.refs-card h3 {
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.refs-figure {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
}
.refs-figure strong {
  font-size: 1.5rem;
}
.refs-needs {
  margin-bottom: 16px;
}
.refs-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0;
  list-style: none;
}
.refs-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px 4px 2px 10px;
  border: 1px solid currentColor;
  border-radius: 999px;
  overflow-wrap: anywhere;
}
.refs-chip-count {
  min-width: 1.4em;
  border-radius: 999px;
  background: currentColor;
  text-align: center;
}
.refs-chip-count {
  color: var(--ih-surface);
}
@media (max-width: 760px) {
  .refs-cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

(Use the existing `tone-ok`/`tone-warn`/`tone-info` colour classes that `SampleTag` and `.kind-tag` use; if they only exist under `.kind-tag.tone-*`, add `.refs-chip.tone-*` and `.refs-legend .tone-*` rules with `color: var(--ih-<tone>-fg)` the same way. Use the surface token that `tokens.css` actually defines for the count's text.)

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web`; `npm run typecheck`; eslint; prettier. Browser check (`npm run dev:api`, `npm run dev:web`, a seeded project): 1440 px and 390 px, light and dark — cards fit, chips wrap, banner button never overflows.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/ReferencesTab.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/src/styles/stages.css apps/web/test/ReferencesTab.test.tsx
git commit -m "Workbench web: References header, ready banner, cards and where the draft model needed you

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: References tab — Samples list (groups, filter, tracker, foot) and the detail panel

**Files:**
- Modify: `apps/web/src/workbench/ReferencesTab.tsx` (part 2), `apps/web/src/styles/stages.css`
- Test: `apps/web/test/ReferencesTab.test.tsx`

**Interfaces:**
- Consumes: `tracker`, `trackerLabel`, `rowStatus`, `rowLine`, `correctionSummary`, `reviewHref`, `matchesFilter`, `REFERENCE_FILTERS` (Task 6), `SampleTag`, `api.getReferenceDetail`, `api.listSamples` (foot).
- Produces: `SamplesSection`, `ReferenceDetailPanel` (module-private components).

- [ ] **Step 1: Write the failing tests** — append to `apps/web/test/ReferencesTab.test.tsx` (import `referenceDetail` and the existing `SampleView` builder `sampleView` from `./fake-api.js`):

```tsx
describe('ReferencesTab samples list', () => {
  it('groups dev and holdout samples with their line, tracker, corrections and Review link', async () => {
    tab({
      dev: [
        saved('inv-0012.pdf', {
          version: 2,
          reverified: { from: 1, changed: [] },
          sourceJobId: 'src-1',
          corrections: [{ key: 'total', kind: 'corrected', proposed: '3,912.00' }],
        }),
        referenceRow({ filename: 'inv-0031.pdf', run: run('awaiting_review', 'j31') }),
      ],
      holdout: [saved('inv-0019.pdf', { carriedFrom: 1 })],
    });
    const list = await screen.findByRole('region', { name: 'Samples' });
    const dev = within(list).getByRole('group', { name: 'Dev samples' });
    expect(dev).toHaveTextContent('1 of 2 verified · run by the draft model');
    const first = within(dev).getByRole('button', { name: /inv-0012\.pdf/ });
    expect(first).toHaveTextContent(/Re-verified in v2 · .+ · was v1/);
    expect(within(first).getByRole('img', { name: 'Run: done · Reviewed: done · Saved: done' })).toBeInTheDocument();
    expect(first).toHaveTextContent('Verified');
    expect(first).toHaveTextContent('Corrected: total');
    const reviews = within(dev).getAllByRole('link', { name: 'Review' });
    expect(reviews.map((a) => a.getAttribute('href'))).toEqual(['#/review/src-1', '#/review/j31']);
    const second = within(dev).getByRole('button', { name: /inv-0031\.pdf/ });
    expect(second).toHaveTextContent('Awaiting review');
    expect(within(second).getByRole('img', { name: 'Run: done · Reviewed: not yet · Saved: not yet' })).toBeInTheDocument();
    const holdout = within(list).getByRole('group', { name: 'Holdout samples' });
    expect(holdout).toHaveTextContent('HOLDOUT');
    expect(holdout).toHaveTextContent('1 of 1 verified · run by the live template, sealed from drafting');
    expect(holdout).toHaveTextContent(/Carried from v1 · /);
  });

  it('filters All / Corrected / Needs you with counts', async () => {
    tab({
      dev: [
        saved('a.pdf', { corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }] }),
        saved('b.pdf'),
        referenceRow({ filename: 'c.pdf' }),
      ],
    });
    const list = await screen.findByRole('region', { name: 'Samples' });
    const all = within(list).getByRole('button', { name: 'All 3' });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(list).getByRole('button', { name: 'Corrected 1' }));
    expect(within(list).getByRole('button', { name: 'Corrected 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(list).queryByText('b.pdf')).toBeNull();
    expect(within(list).getByText('a.pdf')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: 'Needs you 1' }));
    expect(within(list).getByText('c.pdf')).toBeInTheDocument();
    expect(within(list).queryByText('a.pdf')).toBeNull();
  });

  it('runs the template on unverified holdout samples from the holdout group, with a reason when it cannot', async () => {
    const { api, onChanged } = tab(
      { holdout: [referenceRow({ filename: 'h.pdf' })] },
      { startHoldoutReferenceRuns: vi.fn(async () => [job()]) },
    );
    const holdout = await screen.findByRole('group', { name: 'Holdout samples' });
    await userEvent.click(within(holdout).getByRole('button', { name: 'Run the template on 1 unverified' }));
    expect(api.startHoldoutReferenceRuns).toHaveBeenCalledWith('letter');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('disables the holdout run with a reason when every holdout sample is verified', async () => {
    tab({ holdout: [saved('h.pdf')] });
    const holdout = await screen.findByRole('group', { name: 'Holdout samples' });
    const button = within(holdout).getByRole('button', { name: 'Run the template on 0 unverified' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Every holdout sample has a verified reference');
  });

  it('names the samples not counted and links to Samples', async () => {
    tab(
      { dev: [saved('a.pdf')] },
      {
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'inv-0055.pdf', state: 'preparing' }),
          sampleView({ filename: 'inv-0056.pdf', state: 'failed' }),
          sampleView({ filename: 'a.pdf', state: 'ready' }),
        ]),
      },
    );
    const foot = await screen.findByText(/Not counted:/);
    expect(foot).toHaveTextContent('Not counted: inv-0055.pdf is still preparing · inv-0056.pdf failed to prepare.');
    expect(screen.getByRole('link', { name: 'Samples' })).toHaveAttribute('href', '#/workbench/letter/samples');
  });

  it('polls while a run is active', async () => {
    const dev = vi
      .fn()
      .mockResolvedValueOnce([referenceRow({ run: run('running') })])
      .mockResolvedValue([referenceRow({ run: run('awaiting_review') })]);
    tab({}, { listReferenceRows: vi.fn(async (_id: string, set?: string) => (set === 'holdout' ? [] : dev())) });
    expect(await screen.findByText('Awaiting review')).toBeInTheDocument();
  });
});

describe('ReferencesTab detail panel', () => {
  it('opens the first saved sample and shows provenance per output, the model value struck through', async () => {
    const a = saved('inv-0012.pdf', { sourceJobId: 'src-1' });
    const getReferenceDetail = vi.fn(async () =>
      referenceDetail({
        sampleId: a.sampleId,
        filename: 'inv-0012.pdf',
        reference: a.reference!,
        run: { jobId: 'src-1', modelOverride: 'draft', models: ['local/qwen'] },
        values: [
          { id: 'sender', kind: 'field', value: 'Initech Ltd', provenance: 'model', proposed: null, corrections: [] },
          { id: 'total', kind: 'field', value: '4,694.40', provenance: 'corrected', proposed: '3,912.00', corrections: [{ key: 'total', kind: 'corrected', proposed: '3,912.00' }] },
          { id: 'due_date', kind: 'field', value: '2026-09-11', provenance: 'entered', proposed: null, corrections: [{ key: 'due_date', kind: 'entered', proposed: null }] },
          { id: 'line_items', kind: 'table', value: [{}, {}], provenance: 'model', proposed: null, corrections: [] },
        ],
        corrections: [{ key: 'total', kind: 'corrected', proposed: '3,912.00' }, { key: 'due_date', kind: 'entered', proposed: null }],
      }),
    );
    tab({ dev: [a] }, { getReferenceDetail });
    const panel = await screen.findByRole('complementary', { name: 'Reference inv-0012.pdf' });
    expect(getReferenceDetail).toHaveBeenCalledWith('letter', a.sampleId);
    expect(within(screen.getByRole('region', { name: 'Samples' })).getByRole('button', { name: /inv-0012\.pdf/ })).toHaveAttribute('aria-pressed', 'true');
    expect(panel).toHaveTextContent(/saved .+ by ken/);
    expect(panel).toHaveTextContent('Run by the draft model (local/qwen) · src-1 · 2 of 4 values changed in Review');
    const table = within(panel).getByRole('table', { name: 'Reference values' });
    const [, sender, total, due, lines] = within(table).getAllByRole('row');
    expect(sender).toHaveTextContent('MODEL ✓');
    expect(within(total!).getByText('3,912.00').tagName).toBe('DEL');
    expect(total).toHaveTextContent('CORRECTED');
    expect(due).toHaveTextContent('BY HAND');
    expect(lines).toHaveTextContent('2 rows');
    expect(within(panel).getByRole('link', { name: 'Open in Review to change' })).toHaveAttribute('href', '#/review/src-1');
    expect(panel).toHaveTextContent('Saving again replaces this reference for v2.');
  });

  it('switches to a holdout sample with the sealed note', async () => {
    const h = saved('inv-0033.pdf');
    const getReferenceDetail = vi.fn(async (_p: string, sid: string) =>
      referenceDetail({ sampleId: sid, filename: 'inv-0033.pdf', role: 'holdout', reference: h.reference!, run: { jobId: 'hj', modelOverride: null, models: [] } }),
    );
    tab({ dev: [saved('a.pdf')], holdout: [h] }, { getReferenceDetail });
    await userEvent.click(await screen.findByRole('button', { name: /inv-0033\.pdf/ }));
    const panel = await screen.findByRole('complementary', { name: 'Reference inv-0033.pdf' });
    expect(panel).toHaveAttribute('data-role', 'holdout');
    expect(panel).toHaveTextContent('Run by the live template v1');
    expect(panel).toHaveTextContent('Holdout values are only scored, never shown to drafting.');
  });

  it('says when the corrections are unknown', async () => {
    const a = saved('a.pdf', { corrections: null, verifiedBy: null });
    tab(
      { dev: [a] },
      {
        getReferenceDetail: vi.fn(async () =>
          referenceDetail({
            sampleId: a.sampleId,
            reference: a.reference!,
            run: null,
            values: [{ id: 'sender', kind: 'field', value: 'x', provenance: null, proposed: null, corrections: [] }],
            corrections: null,
          }),
        ),
      },
    );
    const panel = await screen.findByRole('complementary', { name: 'Reference a.pdf' });
    expect(panel).toHaveTextContent('Which values were changed in Review is not known');
    expect(within(panel).getByRole('table', { name: 'Reference values' })).not.toHaveTextContent('MODEL ✓');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/ReferencesTab.test.tsx` → FAIL (no Samples region, no panel).

- [ ] **Step 3: Implement** — in `ReferencesTab.tsx` (import `useEffect` is already there; import `type ReferenceDetail, type SampleView` from `@ih/shared`, `SampleTag` from `./tags.js` and the Task 6 helpers):

State in `ReferencesTab`: `const [filter, setFilter] = useState<ReferenceFilter>('all');`, `const [selected, setSelected] = useState<string | null>(null);`, `const [samples, setSamples] = useState<SampleView[]>([]);` (loaded in `refresh` with the rows: `api.listSamples(projectId)` in the same `Promise.all`; a failure there only empties the foot). The effective selection is `selected ?? [...dev, ...holdout].find((r) => r.reference)?.sampleId ?? null`.

Render below `NeedsStrip`:

```tsx
      <div className="refs-layout">
        <section className="card refs-samples" aria-label="Samples">
          <div className="refs-samples-head">
            <h3>Samples</h3>
            <div className="refs-filter" role="group" aria-label="Filter samples">
              {REFERENCE_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {FILTER_LABEL[f]} {[...dev, ...holdout].filter((r) => matchesFilter(r, f)).length}
                </button>
              ))}
            </div>
          </div>
          <SampleGroup
            role="dev"
            rows={dev}
            filter={filter}
            version={version}
            selected={current}
            onSelect={setSelected}
            note="run by the draft model"
          />
          <SampleGroup
            role="holdout"
            rows={holdout}
            filter={filter}
            version={version}
            selected={current}
            onSelect={setSelected}
            note="run by the live template, sealed from drafting"
            action={
              <button
                type="button"
                disabled={holdoutReason !== null}
                title={holdoutReason ?? undefined}
                onClick={() => void proposeHoldout()}
              >
                Run the template on {holdoutCount} unverified
              </button>
            }
          />
          <NotCounted projectId={projectId} samples={samples} />
        </section>
        {current && (
          <ReferenceDetailPanel api={api} projectId={projectId} sampleId={current} version={version} published={published} />
        )}
      </div>
      <p className="muted">
        References carry over to the next version. Only those whose outputs change type, enum
        values or columns need verifying again; renaming or describing an output does not.
        Holdout samples are extracted by the live template’s own models and are never sent to
        the draft model.
      </p>
```

with `const FILTER_LABEL = { all: 'All', corrected: 'Corrected', needs: 'Needs you' } as const;` and `const holdoutReason = runReason(hasDraft, busy || running, holdoutCount, 'holdout');`.

```tsx
function SampleGroup({ role, rows, filter, version, selected, onSelect, note, action }: {
  role: 'dev' | 'holdout'; rows: ReferenceRow[]; filter: ReferenceFilter; version: number | null;
  selected: string | null; onSelect: (id: string) => void; note: string; action?: ReactNode;
}) {
  const label = role === 'dev' ? 'Dev samples' : 'Holdout samples';
  const shown = rows.filter((r) => matchesFilter(r, filter));
  return (
    <div role="group" aria-label={label} className="refs-group" data-role={role}>
      <div className="refs-group-head">
        <SampleTag role={role} />
        <strong>{label}</strong>
        <span className="muted">
          {rows.filter(verified).length} of {rows.length} verified · {note}
        </span>
        {action}
      </div>
      {shown.length === 0 ? (
        <p className="muted">{rows.length ? 'No samples match this filter.' : 'No ready samples.'}</p>
      ) : (
        <ul className="refs-rows">
          {shown.map((r) => {
            const t = tracker(r);
            const href = reviewHref(r);
            return (
              <li key={r.sampleId} className="refs-row">
                <button
                  type="button"
                  className="refs-row-main"
                  aria-pressed={selected === r.sampleId}
                  disabled={!r.reference}
                  title={r.reference ? undefined : 'No reference to show yet'}
                  onClick={() => onSelect(r.sampleId)}
                >
                  <span className="refs-row-name">
                    <code>{r.filename}</code>
                    <small className="muted">{rowLine(r, version)}</small>
                  </span>
                  <span className="refs-tracker" role="img" aria-label={trackerLabel(t)}>
                    {[t.ran, t.reviewed, t.saved].map((done, i) => (
                      <span key={i} className={`refs-dot${done ? ' done' : ''}`} aria-hidden="true" />
                    ))}
                  </span>
                  <span className="refs-row-status">{rowStatus(r)}</span>
                  <span className="refs-row-corrections">{correctionSummary(r)}</span>
                </button>
                {href && <a href={href}>Review</a>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NotCounted({ projectId, samples }: { projectId: string; samples: SampleView[] }) {
  const parts = samples.flatMap((s) =>
    s.state === 'preparing'
      ? [`${s.filename} is still preparing`]
      : s.state === 'failed'
        ? [`${s.filename} failed to prepare`]
        : [],
  );
  if (parts.length === 0) return null;
  return (
    <p className="refs-foot muted">
      Not counted: {parts.join(' · ')}. <a href={`#/workbench/${projectId}/samples`}>Samples</a>
    </p>
  );
}

const PROVENANCE_TAG = {
  model: { text: 'MODEL ✓', tone: 'ok' },
  corrected: { text: 'CORRECTED', tone: 'warn' },
  entered: { text: 'BY HAND', tone: 'info' },
} as const;

const display = (v: unknown) =>
  v === null || v === undefined || v === '' ? '—' : typeof v === 'string' ? v : JSON.stringify(v);

function runText(detail: ReferenceDetail, published: number | null) {
  const run = detail.run;
  if (!run) return 'The run that proposed these values is no longer there';
  const models = run.models.length ? ` (${run.models.join(', ')})` : '';
  const who =
    run.modelOverride === 'draft'
      ? `the draft model${models}`
      : run.modelOverride === null
        ? `the live template${published === null ? '' : ` v${published}`}${models}`
        : `${run.modelOverride}${models}`;
  const changed = detail.corrections === null ? null : new Set(detail.corrections.map((c) => correctionOutput(c.key))).size;
  return `Run by ${who} · ${run.jobId}${
    changed === null ? '' : ` · ${changed} of ${detail.values.length} values changed in Review`
  }`;
}

function ReferenceDetailPanel({ api, projectId, sampleId, version, published }: {
  api: Api; projectId: string; sampleId: string; version: number | null; published: number | null;
}) {
  const [detail, setDetail] = useState<ReferenceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setDetail(null);
    api.getReferenceDetail(projectId, sampleId).then(
      (d) => live && (setDetail(d), setError(null)),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [api, projectId, sampleId]);
  if (error) return <aside className="card refs-detail"><p role="alert">{error}</p></aside>;
  if (!detail) return <aside className="card refs-detail"><p>Loading…</p></aside>;
  const r = detail.reference;
  const holdout = detail.role === 'holdout';
  return (
    <aside className="card refs-detail" aria-label={`Reference ${detail.filename}`} data-role={detail.role}>
      <header>
        <SampleTag role={detail.role} /> <code>{detail.filename}</code>
        <p className="muted">
          Reference “{r.name}”{r.version !== null ? ` · v${r.version}` : ''} · saved {shortDateTime(r.createdAt)}
          {r.verifiedBy ? ` by ${r.verifiedBy}` : ''}
        </p>
        <p className="muted">{runText(detail, published)}</p>
        {detail.corrections === null && (
          <p className="muted">Which values were changed in Review is not known: the run was re-run or removed after the save.</p>
        )}
      </header>
      <div className="table-scroll">
        <table aria-label="Reference values">
          <thead>
            <tr>
              <th scope="col">Output</th>
              <th scope="col">Value</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {detail.values.map((v) => (
              <tr key={v.id}>
                <td><code>{v.id}</code></td>
                <td>
                  {v.provenance === 'corrected' && v.kind === 'field' && <del>{display(v.proposed)}</del>}{' '}
                  {v.kind === 'table' ? `${Array.isArray(v.value) ? v.value.length : 0} rows` : display(v.value)}
                </td>
                <td>
                  {v.provenance && (
                    <span className={`kind-tag tone-${PROVENANCE_TAG[v.provenance].tone}`}>
                      {PROVENANCE_TAG[v.provenance].text}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.sourceJobId && (
        <a className="button" href={`#/review/${r.sourceJobId}`}>
          Open in Review to change
        </a>
      )}
      <p className="muted">
        {holdout
          ? 'Holdout values are only scored, never shown to drafting.'
          : `Saving again replaces this reference for v${version ?? '?'}.`}
      </p>
    </aside>
  );
}
```

(Import `type ReactNode` from `react`; `correctionOutput`, `shortDateTime` from shared/`references.ts`. The holdout panel's run text reads "Run by the live template v1 · hj" in the test: `published` is 1 there and `models` is empty.)

CSS (append to `stages.css`, and add `.refs-samples`, `.refs-detail` to the padding/h3 blocks in Task 7 if not already):

```css
.refs-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
  margin-bottom: 16px;
}
.refs-samples,
.refs-detail {
  min-width: 0;
}
.refs-samples-head,
.refs-group-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.refs-samples-head {
  justify-content: space-between;
}
.refs-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.refs-filter button[aria-pressed='true'] {
  border-color: var(--ih-accent);
  background: var(--ih-info-bg);
}
.refs-group {
  margin-top: 12px;
}
.refs-rows {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.refs-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--ih-border);
}
.refs-row-main {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 2fr) auto minmax(0, 1fr) minmax(0, 1.2fr);
  gap: 4px 12px;
  align-items: center;
  min-width: 0;
  padding: 8px 4px;
  border: 0;
  border-left: 3px solid transparent;
  background: none;
  text-align: left;
}
.refs-row-main[aria-pressed='true'] {
  border-left-color: var(--ih-accent);
  background: var(--ih-info-bg);
}
.refs-row-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-wrap: anywhere;
}
.refs-row-status,
.refs-row-corrections {
  min-width: 0;
  overflow-wrap: anywhere;
}
.refs-tracker {
  display: inline-flex;
  gap: 4px;
}
.refs-dot {
  width: 14px;
  height: 14px;
  border: 2px solid var(--ih-ok-fg);
  border-radius: 50%;
}
.refs-dot.done {
  background: var(--ih-ok-fg);
}
.refs-foot {
  margin-top: 12px;
  overflow-wrap: anywhere;
}
.refs-detail {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  overflow: auto;
  overflow-wrap: anywhere;
}
.refs-detail[data-role='holdout'] {
  border-color: var(--ih-skip-fg);
}
.refs-detail[data-role='holdout'] header {
  background: var(--ih-skip-bg);
}
@media (max-width: 760px) {
  .refs-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .refs-row-main {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .refs-detail {
    position: static;
    max-height: none;
  }
}
```

(Use the token names that exist in `tokens.css` — `--ih-border`, `--ih-skip-fg/bg` from the Workbench pack; if one is named differently, use the existing equivalent.)

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web`; `npm run typecheck`; eslint; prettier. Browser check at 1440 px and 390 px, both themes: long file names wrap, the panel stays in view and scrolls on its own, the row grid never forces horizontal scroll, the holdout panel is violet.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/ReferencesTab.tsx apps/web/src/styles/stages.css apps/web/test/ReferencesTab.test.tsx
git commit -m "Workbench web: References samples list with tracker and filters, and the detail panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs and the full check

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Docs** — in `CLAUDE.md`:

1. Contract table, row "Evaluation (references, comparison, scorecard, iterations)": append to the TS cell "; corrections (RF1, derived on read, never stored): `CorrectionSchema`, `correctionsFromEdits`, `referenceCorrections`, `outputProvenance`, `rightFirstTime`, `outputNeeds` in `packages/shared/src/corrections.ts`; `ReferenceInfoSchema` (`sourceJobId`, `verifiedBy`, `corrections`, `reverified`), `ReferenceDetailSchema` (RF2) in `evaluation.ts` (TS only)".
2. In the **Workbench** bullet, after "…`outputChanges` … marks a copy outdated; outdated means unverified everywhere (…)" add: "Reference rows carry what the reviewer changed (handoff RF1), derived when read from the source run's `review_edits` (no storage): `corrections` keyed by field id or `table[row].column` (1-based), `corrected` where the model proposed a non-empty value the reviewer changed (first old value against last new value; an edit back is none) and `entered` where it proposed nothing; `null` (unknown) when the reference has no source run or the run was re-run or reviewed again after the save (`reviewedAt` later than the reference's `createdAt`); `verifiedBy` is the approver, else the last editor. `referenceEntries` reads every row's review with one `IngestionRepo.listJobReviews` query. `reverified` names the carried copy a re-verification superseded (its version and `outputChanges`). `GET /api/workbench/projects/:id/references/:sid` (RF2) returns one ready sample's reference (dev or holdout) with each current output's value and provenance (`model`, `corrected` with the model's value, `entered`; `null` when unknown) and the run that proposed it (job, override, its step runs' models); 404 `sample not found` / `no reference for this sample`. Right first time (`rightFirstTime`) counts one value per output per verified reference with known corrections, excluding outputs no step fills (`outputCoverage`)."
3. At the end of the **UI** bullet's Workbench tabs sentence, append: " References (`ReferencesTab`, helpers in `workbench/references.ts`) follows handoff §7: ready banner, Dev/Holdout/Right-first-time cards, the per-output strip, the Samples list (Run → Reviewed → Saved tracker, filters) and the detail panel."

- [ ] **Step 2: Run** `npm run openapi` (no diff expected after Tasks 4 and 5; commit it if there is one), then `npm run check` → green (lint, typecheck, every TS project, `worker:lint`, `worker:test`). Then `npx prettier --check .`; fix only the reported files with `npx prettier --write <file>`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Docs: reference corrections (RF1) and reference detail (RF2) in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Never `git add -A`: `config/llm-providers.yaml` has an unrelated local change.)
