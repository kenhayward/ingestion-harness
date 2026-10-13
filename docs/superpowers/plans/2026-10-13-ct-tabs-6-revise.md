# Workbench tabs 6/8: Revise — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Decided before planning (user):** RV3 keeps the existing **400** (`feedback can only refer to dev samples` / `… dev iterations`), not the handoff's 422; this PR only adds a test through the real routes and makes the web never offer a holdout target. RV2 resolves **only the answered feedback** when the proposal names any, else the old behaviour (all sent feedback). The "another stage has an undecided proposal" banner is the simple version: any of `survey`/`outputs`/`sections`/`steps` whose newest proposal is `ready`.

**Goal:** Redesign the Revise tab (handoff §9) and land RV1–RV3. **RV1:** `GET /api/workbench/projects/:id/stages/revise/preview` returns exactly what the next revise call would send (open feedback, dev-only failure diffs already trimmed the way the worker trims them, where they came from, the drafting model, the open draft, the dev sample files whose text goes along, the limits) plus what is **not** sent (the latest holdout run and the ready holdout samples). **RV2:** `DraftChange.answers: string[]` (feedback ids) on revise changes, produced by the model on both sides; accepting a revise proposal resolves exactly the feedback its *applied* changes answer. **RV3:** confirmed with a test through the routes; the web add form never sends a sample or a run.

**Architecture:** No migration, no repository interface change, no `LIST_CACHE_VERSION` bump (the overview and the list cache do not read proposal bodies or feedback ids), so no Pg integration test is needed.

- *Shared* (`packages/shared/src/drafting.ts`): `answers` on every `DraftChangeSchema` variant (optional; `parseChangeBody` refuses it outside `revise`), `answeredFeedback(changes, applied, sent)`. (`packages/shared/src/evaluation.ts`): `FEEDBACK_TARGET_ID`, `MAX_CONTEXT_SAMPLES = 8` (mirrors `drafting.MAX_CONTEXT_SAMPLES`), `revisionFailures(failures, devFiles)` (mirrors the worker's selection, now `drafting.select_failures`), `FailureDiffSchema`, `RevisionFeedbackSchema`, `RevisePreviewSchema`. Two shared fixtures hold the sides together: the existing `draft-changes.json` gains an `answers` case, and the new `revise-failures.json` runs in both `evaluation.test.ts` and `test_drafting.py`.
- *Worker*: `REVISE_SCHEMA` gains a required top-level `answers: {"type":"array","items":{"type":"string"}}` (no union: the `[]` sentinel means "none"); the prompt labels feedback `F1…Fn`; `convert_revise` carries the labels; `draft_stages.resolve_answers` maps them to the feedback ids that came in `params.feedback[].id` (unknown labels dropped); the failure selection moves into `select_failures` unchanged.
- *API*: `reviseInputs` adds each feedback item's `id`, trims failures with `revisionFailures` (so the worker's own selection becomes a no-op on them and the preview equals what is sent by construction) and returns the source iteration; `devSamplesOf` is shared by the start route and the preview; the decision route resolves `answeredFeedback(...)`.
- *Web*: `apps/web/src/workbench/revise.ts` (pure helpers), `ReviseFeedback.tsx` (feedback list + add form), `ReviseTab.tsx` rewritten (it no longer uses `StagePanel`: it owns the proposal so it can draw Answers badges, the running strip and Earlier revisions), `ProposalCard` gains `badge` and `footerNote`, `StaleBanner` gains a `warn` tone, `ProjectPage` passes `draft`.

**Tech Stack:** React 19, Vitest + Testing Library, Zod (shared), Fastify + OpenAPI route docs, Python 3.13 (pytest, mypy --strict, ruff), CSS on existing `--ih-*` tokens.

**Spec:** `docs/design/workbench-tabs/WORKBENCH-TABS-HANDOFF.md` §0 (rules shared by every tab), §9 Revise, rows **RV1**, **RV2**, **RV3** of "New API", "Tests to add" (Revise); screens `docs/design/workbench-tabs/screenshots/light/09-revise.png`, `screenshots/states/09b-revise-proposal.png`, `screenshots/states/09c-revise-applied.png`.

## Global Constraints

- **Card CSS gotcha:** `.card` has **no padding**. Every new padded block (`.revise-see-head`, `.revise-feedback`, `.revise-failures`, `.revise-earlier`) is added to the shared padding rule at the end of `apps/web/src/styles/stages.css` (the block that starts `/* Workbench tab cards: .card itself has no padding …`, `padding: 12px 16px`) and their `h3` to the `font-weight: 600` rule below it — extend those two selector lists, do not duplicate them.
- **Grids never overflow:** `.revise-split` is `grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr)`; `.feedback-item` is `auto minmax(0, 1fr) auto`; `.revise-see-head` and `.failure-head` are flex with `min-width: 0` children; every child holding text has `min-width: 0`; all collapse to one column below 760 px. Feedback ids, sample file names and diff chips wrap with `overflow-wrap: anywhere` (no wide table on this tab, so no `.table-scroll` is needed; the proposal card's `<pre>` details are already the primitive's).
- **Disabled buttons carry a `title` reason (tested):** *Ask the model for a revision* ("Start the next version on the Template tab first", "A revision is being drafted", "Add feedback first: a revision answers your feedback"); *Add* ("The draft has no tables yet" etc., "Write the feedback first"); *Apply* keeps the primitive's "Select a change to apply".
- **Selectable controls:** the target switch is the existing `Segmented` (buttons with `aria-pressed`); the id is a real `<select>` filled from the draft. Failure rows and feedback rows are not selectable (plain list items); links (*Open Steps*, *Evaluate on dev*) are never inside buttons.
- **Holdout is sealed (§0.3, RV3):** the add form sends only `{ target, targetId, body }` (never `sampleId`/`iterationId`); the failures list shows only what the preview says is sent (dev); the violet `.holdout-note` says what is not sent. The API keeps 400 for holdout targets.
- **Stale responses and polling:** `ReviseTab.load` uses a sequence ref (a slower earlier response, or one arriving after unmount, is dropped); it polls `load` at `pollMs` only while the newest revise proposal is `running`.
- **Never call a real LLM** (worker tests use `FakeProvider`); worker commands: `export PATH="$PATH:/c/Users/kenha/AppData/Roaming/Python/Python313/Scripts"; uv run --directory worker pytest …`. No Pg integration test (no repository change). Any migration would be 0028+ (none is needed).
- Tests first (red, then green); `npm run check` green at the end; never `git add -A` (stage the files each task names); commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Labels, not UUIDs, in the prompt (RV2).** The model sees `- F1 [field total] (sample a.pdf): …` and answers `["F1"]`; `resolve_answers` maps labels to the ids from `params.feedback[].id` (case-insensitive; an exact id is accepted too). Unknown labels are **dropped, not fed back as errors**: an answer only decides which feedback an accept resolves, and dropping one leaves that feedback open (the safe direction), whereas an error would spend the job's only retry (`max_attempts=2`) and could send a good revision to `needs_review`.
2. **What an accept resolves (`answeredFeedback`).** If any change of the proposal carries `answers`, only the sent feedback named by the **applied** changes is resolved (an unticked change's feedback stays open: it was not answered); ids the proposal was not sent are ignored (they never reach `uuid[]` in Pg). If no change carries `answers` (a proposal stored before RV2, or the model named none), all sent feedback is resolved, as before. Old stored bodies still parse (`answers` is optional).
3. **"Exactly what will be sent" holds by construction.** The API now applies `revisionFailures` (dev files only, lowest score first, stable, at most `MAX_CONTEXT_SAMPLES`) before writing `params.failures`; the worker's `select_failures` (same rule, now extracted) is idempotent on that input, so params = preview. The rule itself is pinned on both sides by `packages/shared/test/fixtures/revise-failures.json`. Feedback needs no trimming (the API already drops non-dev-sample feedback; the worker's filter keeps everything the API sends). The dev sample texts sent are the first `MAX_CONTEXT_SAMPLES` of the same `devSamplesOf` list.
4. **`answers` has no union.** It is a required plain string array at the change's top level (`[]` = none), so `test_schemas_stay_under_the_anthropic_union_type_limit` keeps `REVISE.schema` at 0 unions; a new test pins its exact shape.
5. **`model` in the preview** is `llm.getSettings().draftingModel` (ADR 0010 phase 4b, migration 0027: the drafting model is a pipeline setting; draft jobs name no model and the worker resolves `draft` from that setting). `null` means unset; the summary then says "drafting model not set".
6. **Existing tests rewritten deliberately, not weakened:** `workbench-revise.test.ts` "sends open feedback…" now expects each feedback item's `id` (the model needs it to answer); `ReviseTab.test.tsx` is replaced (free-text Id + hint → the id `<select>` filled from the draft; "Add feedback" → "Add"; the Feedback table → the numbered "Your feedback" list; "Propose a revision" → "Ask the model for a revision"; the "resolved" text → the ANSWERED tag, still with no Delete); `ProjectPage.test.tsx` "has one Propose button and no Skip on the Revise tab" → "one Ask button, no Skip".
7. **Deviation:** Earlier revisions show date, model, applied/total and how many feedback items each answered, but **no version**: `ProposalView` has no base version and adding one is out of scope.

---

### Task 1: Shared — `DraftChange.answers`, `answeredFeedback` (RV2 contract, TS side)

**Files:**
- Modify: `packages/shared/src/drafting.ts`, `packages/shared/test/drafting.test.ts`, `packages/shared/test/fixtures/draft-changes.json`

**Interfaces:**
- Produces (from `@ih/shared`): `DraftChange` variants each with `answers?: string[]`; `parseChangeBody(stage, body)` returns null when a non-`revise` body carries `answers`; `answeredFeedback(changes: readonly DraftChange[], applied: readonly number[], sent: readonly string[]): string[]`.
- Consumed by: Task 3 (fixture parity in Python), Task 4 (decision route), Tasks 6–9 (badges).

- [ ] **Step 1: Write the failing tests**

Append one case to the array in `packages/shared/test/fixtures/draft-changes.json` (before the closing `]`, after a `,`):

```json
  {
    "name": "revise answers ride along and change nothing themselves",
    "definition": {
      "id": "letter",
      "version": 2,
      "name": "Letter",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [{ "id": "sender", "type": "text" }], "tables": [] },
      "pipeline": []
    },
    "changes": [
      {
        "op": "setPreamble",
        "preamble": "Letters from suppliers.",
        "reason": "feedback 1",
        "answers": ["9b7c0c1e-0000-4000-8000-000000000001"]
      }
    ],
    "expected": {
      "id": "letter",
      "version": 2,
      "name": "Letter",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [{ "id": "sender", "type": "text" }], "tables": [] },
      "pipeline": [],
      "preamble": "Letters from suppliers."
    }
  }
```

Append to `packages/shared/test/drafting.test.ts` (add `answeredFeedback` to the import from `'../src/index.js'`):

```ts
describe('answers (RV2)', () => {
  const field = { op: 'putField', field: { id: 'a', type: 'text' }, reason: 'r' };

  it('parses a revise change that names the feedback it answers, and an old one without', () => {
    expect(
      parseChangeBody('revise', { notes: '', changes: [{ ...field, answers: ['f1', 'f2'] }] })
        ?.changes[0],
    ).toMatchObject({ answers: ['f1', 'f2'] });
    expect(parseChangeBody('revise', { notes: '', changes: [field] })?.changes[0]).not.toHaveProperty(
      'answers',
    );
  });

  it('only revise changes answer feedback', () => {
    expect(parseChangeBody('outputs', { notes: '', changes: [{ ...field, answers: ['f1'] }] })).toBeNull();
  });

  it('rejects an empty feedback id', () => {
    expect(parseChangeBody('revise', { notes: '', changes: [{ ...field, answers: [''] }] })).toBeNull();
  });
});

describe('answeredFeedback (RV2)', () => {
  const c = (answers?: string[]): DraftChange => ({
    op: 'removeStep',
    id: 's',
    reason: 'r',
    ...(answers ? { answers } : {}),
  });

  it.each<[string, DraftChange[], number[], string[], string[]]>([
    ['a proposal without answers resolves all it was sent', [c(), c()], [0], ['f1', 'f2'], ['f1', 'f2']],
    ['only the applied changes answer', [c(['f1']), c(['f2'])], [1], ['f1', 'f2'], ['f2']],
    ['a change may answer several', [c(['f1', 'f2'])], [0], ['f1', 'f2', 'f3'], ['f1', 'f2']],
    ['an id the proposal was not sent is ignored', [c(['f9', 'f1'])], [0], ['f1'], ['f1']],
    ['applied changes that answer nothing resolve nothing', [c(['f1']), c()], [1], ['f1', 'f2'], []],
    ['the order is the order sent', [c(['f2', 'f1'])], [0], ['f1', 'f2'], ['f1', 'f2']],
    ['an out-of-range index answers nothing', [c(['f1'])], [3], ['f1'], []],
  ])('%s', (_name, changes, applied, sent, expected) => {
    expect(answeredFeedback(changes, applied, sent)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project shared packages/shared/test/drafting.test.ts` → FAIL (the fixture case: `DraftChangeSchema.safeParse` rejects the unknown key `answers`; `answeredFeedback` is not a function).

- [ ] **Step 3: Implement** — `packages/shared/src/drafting.ts`. Replace the `reason`/`DraftChangeSchema` block:

```ts
const reason = z.string();
/**
 * Revise (handoff RV2): the ids of the feedback items a change answers. Optional, so bodies
 * stored before RV2 parse; `parseChangeBody` refuses it on the other stages.
 */
const answers = z.array(z.string().min(1)).optional();
export const DraftChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('putField'), field: ValueDefSchema, reason, answers }).strict(),
  z.object({ op: z.literal('putTable'), table: TableDefSchema, reason, answers }).strict(),
  z.object({ op: z.literal('removeOutput'), id: z.string(), reason, answers }).strict(),
  z.object({ op: z.literal('putSection'), section: SectionSchema, reason, answers }).strict(),
  z.object({ op: z.literal('removeSection'), id: z.string(), reason, answers }).strict(),
  z
    .object({ op: z.literal('setCopies'), copies: CopySelectionSchema.nullable(), reason, answers })
    .strict(),
  z.object({ op: z.literal('putStep'), step: StepSchema, reason, answers }).strict(),
  z.object({ op: z.literal('removeStep'), id: z.string(), reason, answers }).strict(),
  z.object({ op: z.literal('setPreamble'), preamble: z.string(), reason, answers }).strict(),
]);
```

Replace `parseChangeBody`:

```ts
/** A stage body, or null if it is malformed, uses an op the stage may not, or answers feedback outside revise. */
export function parseChangeBody(stage: ChangeStage, body: unknown): ChangeBody | null {
  const parsed = ChangeBodySchema.safeParse(body);
  if (!parsed.success) return null;
  const { changes } = parsed.data;
  if (!changes.every((c) => STAGE_OPS[stage].includes(c.op))) return null;
  if (stage !== 'revise' && changes.some((c) => c.answers !== undefined)) return null;
  return parsed.data;
}

/**
 * The feedback an accepted revise proposal resolves (RV2). When any change names the feedback
 * it answers, only the `sent` ids named by the applied changes (indexes into `changes`); when
 * none does (stored before RV2, or the model named none), everything it was sent. In `sent` order.
 */
export function answeredFeedback(
  changes: readonly DraftChange[],
  applied: readonly number[],
  sent: readonly string[],
): string[] {
  if (!changes.some((c) => c.answers?.length)) return [...sent];
  const named = new Set(applied.flatMap((i) => changes[i]?.answers ?? []));
  return sent.filter((id) => named.has(id));
}
```

`applyChanges` needs no change (it copies `c.field`, `c.step`, … never the change itself).

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project shared`; `npm run typecheck`; `npx eslint packages/shared`; `npx prettier --write packages/shared/src/drafting.ts packages/shared/test/drafting.test.ts packages/shared/test/fixtures/draft-changes.json`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/drafting.ts packages/shared/test/drafting.test.ts packages/shared/test/fixtures/draft-changes.json
git commit -m "Shared: revise changes name the feedback they answer (RV2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared — `revisionFailures`, `RevisePreviewSchema` (RV1 contract)

**Files:**
- Create: `packages/shared/test/fixtures/revise-failures.json`
- Modify: `packages/shared/src/evaluation.ts`, `packages/shared/test/evaluation.test.ts`, `packages/shared/test/dto.test.ts`

**Interfaces:**
- Produces (from `@ih/shared`): `FEEDBACK_TARGET_ID` (the regex `FeedbackBodySchema.targetId` uses), `MAX_CONTEXT_SAMPLES = 8`, `revisionFailures(failures: readonly FailureDiff[], devFiles: ReadonlySet<string>): FailureDiff[]`, `FailureDiffSchema` / `SentFailure`, `RevisionFeedbackSchema` / `RevisionFeedback = { id; target; targetId; sample: string | null; body }`, `RevisePreviewSchema` / `RevisePreview`.
- Consumed by: Task 3 (fixture), Tasks 4–5 (API), Tasks 6–9 (web).

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/fixtures/revise-failures.json` (shared with `worker/tests/test_drafting.py`):

```json
[
  {
    "name": "keeps dev samples only",
    "dev": ["a.pdf"],
    "failures": [
      { "sample": "a.pdf", "score": 0.5 },
      { "sample": "holdout.pdf", "score": 0.1 }
    ],
    "expected": ["a.pdf"]
  },
  {
    "name": "lowest score first",
    "dev": ["a.pdf", "b.pdf", "c.pdf"],
    "failures": [
      { "sample": "a.pdf", "score": 0.9 },
      { "sample": "b.pdf", "score": 0.2 },
      { "sample": "c.pdf", "score": 0.5 }
    ],
    "expected": ["b.pdf", "c.pdf", "a.pdf"]
  },
  {
    "name": "ties keep the order they came in",
    "dev": ["a.pdf", "b.pdf", "c.pdf"],
    "failures": [
      { "sample": "c.pdf", "score": 0 },
      { "sample": "a.pdf", "score": 0 },
      { "sample": "b.pdf", "score": 0 }
    ],
    "expected": ["c.pdf", "a.pdf", "b.pdf"]
  },
  {
    "name": "at most eight, the worst ones",
    "dev": ["0.pdf", "1.pdf", "2.pdf", "3.pdf", "4.pdf", "5.pdf", "6.pdf", "7.pdf", "8.pdf", "9.pdf"],
    "failures": [
      { "sample": "0.pdf", "score": 0.9 },
      { "sample": "1.pdf", "score": 0.8 },
      { "sample": "2.pdf", "score": 0.7 },
      { "sample": "3.pdf", "score": 0.6 },
      { "sample": "4.pdf", "score": 0.5 },
      { "sample": "5.pdf", "score": 0.4 },
      { "sample": "6.pdf", "score": 0.3 },
      { "sample": "7.pdf", "score": 0.2 },
      { "sample": "8.pdf", "score": 0.1 },
      { "sample": "9.pdf", "score": 0 }
    ],
    "expected": ["9.pdf", "8.pdf", "7.pdf", "6.pdf", "5.pdf", "4.pdf", "3.pdf", "2.pdf"]
  }
]
```

Append to `packages/shared/test/evaluation.test.ts` (add `import { readFileSync } from 'node:fs';` at the top and `FailureDiffSchema`, `FEEDBACK_TARGET_ID`, `MAX_CONTEXT_SAMPLES`, `revisionFailures` to the import from `'../src/index.js'`):

```ts
const failureCases = JSON.parse(
  readFileSync(new URL('./fixtures/revise-failures.json', import.meta.url), 'utf8'),
) as { name: string; dev: string[]; failures: { sample: string; score: number }[]; expected: string[] }[];

describe('revisionFailures (fixture shared with worker/tests/test_drafting.py)', () => {
  it.each(failureCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const failures = c.failures.map((f) => ({ ...f, fields: [], tables: [] }));
    expect(revisionFailures(failures, new Set(c.dev)).map((f) => f.sample)).toEqual(c.expected);
  });

  it('caps at the worker limit (drafting.MAX_CONTEXT_SAMPLES)', () => {
    expect(MAX_CONTEXT_SAMPLES).toBe(8);
  });
});

describe('FailureDiffSchema / FEEDBACK_TARGET_ID', () => {
  it('describes what failureDiffs produces', () => {
    expect(
      FailureDiffSchema.safeParse({
        sample: 'a.pdf',
        score: 0.5,
        fields: [{ id: 'total', expected: '4694.40', actual: null }],
        tables: [{ id: 'lines', missing: 1, extra: 0, changed: [] }],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['sent_on', true],
    ['line-items', true],
    ['Total', false],
    ['1st', false],
    ['', false],
  ] as const)('%j is a feedback target id: %s', (id, ok) => {
    expect(FEEDBACK_TARGET_ID.test(id)).toBe(ok);
  });
});
```

In `packages/shared/test/dto.test.ts`, import `RevisePreviewSchema` and add after the `'PublishGateView'` row:

```ts
  [
    'RevisePreview',
    RevisePreviewSchema,
    {
      feedback: [
        {
          id: '9b7c0c1e-0000-4000-8000-000000000001',
          target: 'field',
          targetId: 'total',
          sample: 'a.pdf',
          body: 'Take the TOTAL DUE line',
        },
      ],
      failures: [{ sample: 'a.pdf', score: 0.85, fields: [], tables: [] }],
      failuresTotal: 1,
      failuresFrom: {
        iterationId: '9b7c0c1e-0000-4000-8000-000000000002',
        templateVersion: 4,
        model: null,
        createdAt: '2026-10-12T09:02:00.000Z',
        compared: 6,
      },
      model: 'local/qwen3.8-27b-mtp',
      draft: { version: 4, definition: { id: 'letter' } },
      samples: ['a.pdf'],
      limits: { samples: 8, fieldDiffs: 20, rowDiffs: 5 },
      notSent: {
        holdoutSamples: 2,
        holdoutRun: { iterationId: '9b7c0c1e-0000-4000-8000-000000000003', status: 'complete', score: 0.88 },
      },
    },
    'notSent',
  ],
```

- [ ] **Step 2: Run** `npx vitest run --project shared packages/shared/test/evaluation.test.ts packages/shared/test/dto.test.ts` → FAIL (`revisionFailures` is not a function; `RevisePreviewSchema`, `FailureDiffSchema`, `FEEDBACK_TARGET_ID` undefined).

- [ ] **Step 3: Implement** — `packages/shared/src/evaluation.ts`. Before `FeedbackBodySchema`, add and use the id rule:

```ts
/** A feedback target id: a lowercase output, step or section id (what `FeedbackBodySchema` takes). */
export const FEEDBACK_TARGET_ID = /^[a-z][a-z0-9_-]*$/;
```

and in `FeedbackBodySchema` replace `targetId: z.string().regex(/^[a-z][a-z0-9_-]*$/),` with `targetId: z.string().regex(FEEDBACK_TARGET_ID),`.

After `failureDiffs`, add:

```ts
/** Most dev samples a drafting call sees, and most failures a revision sends (worker drafting.MAX_CONTEXT_SAMPLES). */
export const MAX_CONTEXT_SAMPLES = 8;

/**
 * The failures a revision sends (mirrors worker drafting.select_failures; shared fixture
 * revise-failures.json): dev files only, lowest score first (ties keep their order), at most
 * MAX_CONTEXT_SAMPLES. The API applies it before writing the job, so the worker's own pass is a no-op.
 */
export function revisionFailures(
  failures: readonly FailureDiff[],
  devFiles: ReadonlySet<string>,
): FailureDiff[] {
  return failures
    .filter((f) => devFiles.has(f.sample))
    .sort((a, b) => a.score - b.score) // Array.prototype.sort is stable
    .slice(0, MAX_CONTEXT_SAMPLES);
}

/** `FailureDiff` as documented in the API (expected and actual are any JSON value). */
export const FailureDiffSchema = z.object({
  sample: z.string(),
  score: z.number(),
  fields: z.array(z.object({ id: z.string(), expected: z.unknown(), actual: z.unknown() })),
  tables: z.array(
    z.object({
      id: z.string(),
      missing: z.number().int(),
      extra: z.number().int(),
      changed: z.array(
        z.object({
          expected: z.record(z.unknown()),
          actual: z.record(z.unknown()),
          columns: z.array(z.string()),
        }),
      ),
    }),
  ),
});
export type SentFailure = z.infer<typeof FailureDiffSchema>;

/** One open feedback item as a revise job's `params.feedback` carries it (RV2: with its id). */
export const RevisionFeedbackSchema = z.object({
  id: z.string().uuid(),
  target: z.enum(FEEDBACK_TARGETS),
  targetId: z.string(),
  /** The dev sample's file name, when the feedback names one. */
  sample: z.string().nullable(),
  body: z.string(),
});
export type RevisionFeedback = z.infer<typeof RevisionFeedbackSchema>;

/** `GET …/stages/revise/preview` (handoff RV1): what the next revise call sends, and what it never does. */
export const RevisePreviewSchema = z.object({
  feedback: z.array(RevisionFeedbackSchema),
  /** Already trimmed with `revisionFailures`. */
  failures: z.array(FailureDiffSchema),
  /** Failing dev samples before the MAX_CONTEXT_SAMPLES cap. */
  failuresTotal: z.number().int(),
  /** The latest complete dev iteration the failures come from; null when there is none. */
  failuresFrom: z
    .object({
      iterationId: z.string().uuid(),
      templateVersion: z.number().int(),
      model: z.enum(EVALUATION_MODELS).nullable(),
      createdAt: z.string(),
      /** Current dev samples it compared. */
      compared: z.number().int(),
    })
    .nullable(),
  /** The drafting model setting (`endpoint/model-id`); null when unset. */
  model: z.string().nullable(),
  /** The open draft sent as `<current_draft>`; null without one (a revision needs one). */
  draft: z.object({ version: z.number().int(), definition: z.record(z.unknown()) }).nullable(),
  /** Dev sample files whose text is sent (at most MAX_CONTEXT_SAMPLES). */
  samples: z.array(z.string()),
  limits: z.object({
    samples: z.number().int(),
    fieldDiffs: z.number().int(),
    rowDiffs: z.number().int(),
  }),
  /** Never sent (the holdout rule): shown so the user knows. */
  notSent: z.object({
    /** Ready holdout samples. */
    holdoutSamples: z.number().int(),
    /** The newest holdout iteration. */
    holdoutRun: z
      .object({
        iterationId: z.string().uuid(),
        status: z.enum(['running', 'complete']),
        score: z.number().nullable(),
      })
      .nullable(),
  }),
});
export type RevisePreview = z.infer<typeof RevisePreviewSchema>;
```

(`EVALUATION_MODELS` and `FEEDBACK_TARGETS` are defined earlier in the same file.)

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project shared`; `npm run typecheck`; `npx eslint packages/shared`; `npx prettier --write packages/shared/src/evaluation.ts packages/shared/test/evaluation.test.ts packages/shared/test/dto.test.ts packages/shared/test/fixtures/revise-failures.json`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/evaluation.ts packages/shared/test/evaluation.test.ts packages/shared/test/dto.test.ts packages/shared/test/fixtures/revise-failures.json
git commit -m "Shared: revise preview schema and the failure selection a revision sends (RV1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Worker — `answers` in the revise schema, F-labels, `resolve_answers`, `select_failures`

**Files:**
- Modify: `worker/src/ingest_worker/draft_stages.py`, `worker/src/ingest_worker/drafting.py`, `worker/tests/test_draft_stages.py`, `worker/tests/test_drafting.py`

**Interfaces:**
- Consumes: `params.feedback[]` items with an `id` (Task 4 sends it; items without one still work), fixtures from Tasks 1–2.
- Produces: `REVISE_SCHEMA` change item with required `answers` (plain string array); `draft_stages.resolve_answers(body, labels) -> body`; `drafting.select_failures(failures, dev_files)`; stored revise bodies whose changes may carry `answers` (feedback ids) — exactly what `DraftChangeSchema` (Task 1) parses.

- [ ] **Step 1: Write the failing tests**

`worker/tests/test_draft_stages.py` — extend the import to `from ingest_worker.draft_stages import OUTPUTS, REVISE, REVISE_SCHEMA, SECTIONS, STEPS, Stage, resolve_answers`, give `nested` an `answers` argument (the schema now requires the key):

```python
def nested(
    op: str, key: str, item: dict[str, Any], answers: list[str] | None = None
) -> dict[str, Any]:
    """A revise change: the chosen payload from a flat item, the rest filled with empties."""
    schema = REVISE_SCHEMA["properties"]["changes"]["items"]["properties"]
    change: dict[str, Any] = {"op": op, "reason": "r", "answers": answers or []}
    for k in ("field", "table", "section", "step"):
        change[k] = _empty(schema[k])
    for k, v in item.items():
        if k not in ("op", "reason") and v is not None:
            change[key][k] = v
    return change
```

and append:

```python
def test_revise_answers_are_a_required_plain_string_array() -> None:
    item = REVISE_SCHEMA["properties"]["changes"]["items"]
    assert item["properties"]["answers"] == {"type": "array", "items": {"type": "string"}}
    assert "answers" in item["required"]


def test_revise_carries_answer_labels_trimmed_and_once() -> None:
    assert REVISE.convert is not None
    change = nested("putField", "field", output_item(id="ref"), answers=[" F1 ", "", "F1", "F2"])
    body, errors = REVISE.convert({"notes": "", "changes": [change]})
    assert errors == []
    assert body["changes"][0]["answers"] == ["F1", "F2"]


def test_revise_change_that_answers_nothing_has_no_answers_key() -> None:
    assert REVISE.convert is not None
    body, _ = REVISE.convert({"notes": "", "changes": [nested("setPreamble", "step", {})]})
    assert "answers" not in body["changes"][0]


@pytest.mark.parametrize(
    ("answers", "expected"),
    [
        (["F2", "F1"], ["fb-2", "fb-1"]),
        (["f1"], ["fb-1"]),  # labels are case-insensitive
        (["F1", "F1"], ["fb-1"]),
        (["fb-2"], ["fb-2"]),  # an exact id is accepted
        (["F9", "nonsense"], None),  # unknown labels are dropped, and so is the key
    ],
)
def test_resolve_answers_maps_labels_to_feedback_ids(
    answers: list[str], expected: list[str] | None
) -> None:
    change = {"op": "removeStep", "id": "s", "reason": "r", "answers": answers}
    body = resolve_answers({"notes": "", "changes": [change]}, {"F1": "fb-1", "F2": "fb-2"})
    assert body["changes"][0].get("answers") == expected
    assert body["changes"][0]["id"] == "s"
```

`worker/tests/test_drafting.py` — add `select_failures` to the `from ingest_worker.drafting import (...)` list, add `from ingest_worker.config import REPO_ROOT`, set `change["answers"] = []` in `revise_response()` (right after `change: dict[str, Any] = {"op": "putStep", "reason": "feedback"}`), and append:

```python
FAILURES_FIXTURE = REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "revise-failures.json"
FAILURE_CASES: list[dict[str, Any]] = json.loads(FAILURES_FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", FAILURE_CASES, ids=[c["name"] for c in FAILURE_CASES])
def test_select_failures_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    picked = select_failures(case["failures"], set(case["dev"]))
    assert [f["sample"] for f in picked] == case["expected"]


def test_revise_labels_feedback_and_stores_the_ids_a_change_answers(
    fixture_specs_dir: Path,
) -> None:
    provider, store, deps = make(fixture_specs_dir)
    response = revise_response()
    response["changes"][0]["answers"] = ["F2", "f1", "F9", "F2"]
    provider.responses = [response]
    feedback = [
        {"id": "fb-1", "target": "field", "targetId": "sender", "sample": None, "body": "one"},
        {"id": "fb-2", "target": "step", "targetId": "head", "sample": None, "body": "two"},
    ]
    job = draft_job(
        stage="revise", draft=REVISE_DRAFT, feedback=feedback, feedbackIds=["fb-1", "fb-2"]
    )
    queue = FakeQueue(jobs=[job])
    run_once(queue, deps, "w1")
    assert queue.completed
    prompt = str(provider.calls[0][1].prompt)
    assert "- F1 [field sender]: one" in prompt and "- F2 [step head]: two" in prompt
    assert '"answers"' in str(provider.calls[0][1].json_schema)
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    assert body["changes"][0]["answers"] == ["fb-2", "fb-1"]


def test_revise_change_without_answers_is_stored_without_them(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [revise_response()]
    feedback = [{"id": "fb-1", "target": "field", "targetId": "sender", "body": "one"}]
    queue = FakeQueue(jobs=[draft_job(stage="revise", draft=REVISE_DRAFT, feedback=feedback)])
    run_once(queue, deps, "w1")
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    assert "answers" not in body["changes"][0]
```

- [ ] **Step 2: Run** `export PATH="$PATH:/c/Users/kenha/AppData/Roaming/Python/Python313/Scripts"; uv run --directory worker pytest tests/test_draft_stages.py tests/test_drafting.py tests/test_draft_changes.py -q` → FAIL (`resolve_answers` / `select_failures` cannot be imported; no `answers` in the schema; prompt lines have no `F1`). The new `draft-changes.json` case already passes in `test_draft_changes.py` (Python's `apply_changes` ignores extra keys); that is expected, the fixture's red side was TS in Task 1.

- [ ] **Step 3: Implement**

`worker/src/ingest_worker/draft_stages.py` — in `REVISE_SCHEMA`, add the key between `"step": _STEP_ITEM,` and `"reason": _S,`:

```python
            "answers": {"type": "array", "items": _S},
```

In the `REVISE` instructions, after the line `  outputs. reason: which feedback item or failure the change addresses.` add:

```
- answers: the labels of the feedback items the change answers (for example ["F1", "F3"]);
  [] when it only fixes evaluation failures.
```

Add above `convert_revise`:

```python
def _answers(value: Any) -> list[str]:
    """The feedback labels a revise change answers: trimmed, non-empty, each once, in order."""
    items = value if isinstance(value, list) else []
    return list(dict.fromkeys(a.strip() for a in items if isinstance(a, str) and a.strip()))
```

In `convert_revise`, replace `changes += body["changes"]` with:

```python
        answers = _answers(c.get("answers"))
        changes += [{**ch, "answers": answers} if answers else ch for ch in body["changes"]]
```

Append after `check_revise`:

```python
def resolve_answers(body: dict[str, Any], labels: dict[str, str]) -> dict[str, Any]:
    """Map the model's feedback labels (F1, F2, ...) to feedback ids (RV2, TS DraftChange.answers).

    Labels are case-insensitive and an exact id is accepted too. Unknown labels are dropped: an
    answer only decides which feedback an accept resolves, and dropping one leaves it open. A
    change left with no answers carries no `answers` key."""
    by_label = {k.upper(): v for k, v in labels.items()}
    ids = set(labels.values())
    changes: list[dict[str, Any]] = []
    for change in body["changes"]:
        rest = {k: v for k, v in change.items() if k != "answers"}
        mapped = [
            by_label.get(a.upper()) or (a if a in ids else None)
            for a in change.get("answers") or []
        ]
        found = list(dict.fromkeys(m for m in mapped if m))
        changes.append({**rest, "answers": found} if found else rest)
    return {**body, "changes": changes}
```

`worker/src/ingest_worker/drafting.py` — import `resolve_answers`: `from .draft_stages import OUTPUTS, REVISE, SECTIONS, STEPS, Stage, resolve_answers`. In `build_context`, label the feedback:

```python
    if feedback:
        lines = [
            f"- F{n} [{f.get('target')} {f.get('targetId')}]"
            + (f" (sample {f['sample']})" if f.get("sample") else "")
            + f": {f.get('body', '')}"
            for n, f in enumerate(feedback, 1)
        ]
        blocks.append("<feedback>\n" + "\n".join(lines) + "\n</feedback>")
```

Add after `prepared_pages`:

```python
def select_failures(failures: list[dict[str, Any]], dev_files: set[str]) -> list[dict[str, Any]]:
    """The failures a revision sends (TS revisionFailures; shared fixture revise-failures.json):
    dev samples only, lowest score first (stable), at most MAX_CONTEXT_SAMPLES. The API sends
    them already selected, so this is a defensive no-op on its input."""
    return sorted(
        (f for f in failures if f.get("sample") in dev_files),
        key=lambda f: float(f.get("score", 0)),
    )[:MAX_CONTEXT_SAMPLES]
```

In `run_draft`, replace the `dev_failures = sorted(...)[:MAX_CONTEXT_SAMPLES]` statement (and its comment) with:

```python
    # The worst-scoring failures are the most worth fixing; the cap keeps the prompt bounded.
    dev_failures = select_failures(params.failures, names)
    # The prompt labels feedback F1..Fn in this order; answers name those labels (RV2).
    labels = {f"F{n}": str(f["id"]) for n, f in enumerate(dev_feedback, 1) if f.get("id")}
```

and right after `result, body = propose(prompt, f"draft-{stage.id}")` add:

```python
    if stage.id == "revise":
        body = resolve_answers(body, labels)
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npm run worker:test`; `npm run worker:lint` (ruff, ruff format --check, mypy --strict; run `export PATH=…; uv run --directory worker ruff format src tests` if the format check complains).

- [ ] **Step 5: Commit**

```bash
git add worker/src/ingest_worker/draft_stages.py worker/src/ingest_worker/drafting.py worker/tests/test_draft_stages.py worker/tests/test_drafting.py
git commit -m "Worker: revise changes answer labelled feedback; shared failure selection (RV2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: API — feedback ids and trimmed failures in revise jobs, resolve only what was answered (RV2), RV3 test

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`, `apps/api/test/workbench-revise.test.ts`, `docs/openapi.json` (generated)

**Interfaces:**
- Consumes: `answeredFeedback` (Task 1); `revisionFailures`, `MAX_CONTEXT_SAMPLES`, `type RevisionFeedback` (Task 2); existing `failureDiffs`, `iterationView`, `sampleViews`, `workbench.listFeedback`, `workbench.listIterations`, `workbench.resolveFeedback`.
- Produces: `devSamplesOf(views)` and the reshaped `reviseInputs(projectId, dev) → { params, failuresTotal, source }` (used by Task 5); revise job params `feedback[].id`; decision route resolves `answeredFeedback(proposed, chosen, record.feedbackIds ?? [])`.

- [ ] **Step 1: Write the failing tests** — `apps/api/test/workbench-revise.test.ts` (add `MAX_CONTEXT_SAMPLES` to the `@ih/shared` import).

In `'sends open feedback and dev-only failures from the latest complete evaluation'`, keep the returned item and expect its id (the model needs it to answer, RV2):

```ts
    const fb = await feedback({ target: 'field', targetId: 'sender', body: 'Letterhead', sampleId: a.id });
    const res = await start('revise');
    const params = paramsOf(ctx, res.json().id);
    expect(params.feedback).toEqual([
      { id: fb.id, target: 'field', targetId: 'sender', sample: 's1.pdf', body: 'Letterhead' },
    ]);
```

Append to `describe('feedback', …)`:

```ts
  it('refuses a holdout iteration made through the routes (RV3)', async () => {
    const { app, add, setRole, verify, evaluate } = await project();
    const h = await add(1);
    await setRole(h.id, 'holdout');
    await verify(h, 'Acme');
    const run = await evaluate({ set: 'holdout' });
    expect(run.statusCode).toBe(201);
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/feedback',
      payload: { target: 'field', targetId: 'sender', body: 'x', iterationId: (run.json() as { id: string }).id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('feedback can only refer to dev iterations');
    expect((await app.inject('/api/workbench/projects/letter/feedback')).json()).toEqual([]);
  });
```

(This confirms RV3, which the API already enforces; it passes at once and guards the rule. `POST …/evaluations` answers 201 with the iteration view.)

Append to `describe('revise', …)`:

```ts
  it(`sends at most ${MAX_CONTEXT_SAMPLES} failures`, async () => {
    const ctx = await project();
    for (let n = 1; n <= MAX_CONTEXT_SAMPLES + 1; n++) await ctx.verify(await ctx.add(n), 'Acme');
    await ctx.evaluate();
    for (const r of await ctx.repo.listProjectRuns('letter')) {
      if (r.job.referenceId) await ctx.finish(r.job.id, 'Wrong');
    }
    await ctx.feedback({ target: 'field', targetId: 'sender', body: 'Letterhead' });
    const params = paramsOf(ctx, (await ctx.start('revise')).json().id);
    expect(params.failures as unknown[]).toHaveLength(MAX_CONTEXT_SAMPLES);
  });

  it('keeps the answers and resolves only the feedback its applied changes answer (RV2)', async () => {
    const { app, start, feedback, finishDraft, decide } = await project();
    const one = await feedback({ target: 'field', targetId: 'sender', body: 'Describe it' });
    const two = await feedback({ target: 'step', targetId: 'head', body: 'Say what letters are' });
    const { id } = (await start('revise')).json();
    await finishDraft(id, 'revise', {
      notes: '',
      changes: [
        {
          op: 'putField',
          field: { id: 'sender', type: 'text', description: 'Who' },
          reason: 'feedback 1',
          answers: [one.id],
        },
        { op: 'setPreamble', preamble: 'Letters.', reason: 'feedback 2', answers: [two.id] },
      ],
    });
    const [listed] = (await app.inject('/api/workbench/projects/letter/proposals')).json() as {
      body: { changes: { answers?: string[] }[] };
    }[];
    expect(listed!.body.changes.map((c) => c.answers)).toEqual([[one.id], [two.id]]);
    expect((await decide(id, { decision: 'accepted', changes: [0] })).statusCode).toBe(200);
    const items = (
      await app.inject('/api/workbench/projects/letter/feedback')
    ).json() as FeedbackItem[];
    expect(items.find((f) => f.id === one.id)!.resolvedBy).toBe(id);
    expect(items.find((f) => f.id === two.id)!.resolvedBy).toBeNull();
  });
```

(The existing `'resolves its feedback when accepted, even partly, and not when rejected'` stays as is: its changes carry no `answers`, so it now pins the old behaviour for such proposals.)

- [ ] **Step 2: Run** `npx vitest run --project api apps/api/test/workbench-revise.test.ts` → FAIL (feedback has no `id`; 9 failures are sent; both feedback items are resolved).

- [ ] **Step 3: Implement** — `apps/api/src/routes/workbench.ts`. Add `answeredFeedback`, `revisionFailures`, `MAX_CONTEXT_SAMPLES`, `type RevisionFeedback` to the `@ih/shared` import (and `type IterationRecord` from `../workbench/repo.js` if it is not imported yet).

Add next to `sampleViews` (module scope):

```ts
/** The ready dev samples a drafting call may send (the holdout rule, ADR 0007), in sample order. */
function devSamplesOf(views: Awaited<ReturnType<typeof sampleViews>>) {
  return views
    .filter((s) => s.view.role === 'dev' && s.view.state === 'ready')
    .map((s) => ({
      sampleId: s.record.id,
      filename: s.record.filename,
      sha256: s.record.sha256,
      role: 'dev' as const,
    }));
}
```

Replace `reviseInputs` (doc comment included):

```ts
  /**
   * What a revision is asked to answer (also the RV1 preview). Holdout rule (ADR 0007): feedback
   * naming a sample that is not a ready dev sample now is dropped, and the failures come from the
   * latest complete dev iteration, restricted to the current dev samples and trimmed with
   * `revisionFailures` (the worker's own selection is then a no-op, so what the preview shows is
   * what is sent). The template's own runs are preferred over model-comparison members (groupId
   * set), which fall back only when no own run is complete; failuresFrom names the iteration used.
   * Each feedback item carries its id: the model answers feedback by it (RV2).
   */
  async function reviseInputs(
    projectId: string,
    dev: { sampleId: string; filename: string }[],
  ): Promise<{
    params: {
      feedback: RevisionFeedback[];
      failures: FailureDiff[];
      failuresFrom?: { templateVersion: number; model: EvaluationModel | null };
      feedbackIds: string[];
    };
    /** Failing dev samples before the cap. */
    failuresTotal: number;
    source: { iteration: IterationRecord; compared: number } | null;
  }> {
    const names = new Map(dev.map((s) => [s.sampleId, s.filename]));
    const devIds = new Set(names.keys());
    const open = (await workbench.listFeedback(projectId)).filter(
      (f) => f.resolvedBy === null && (f.sampleId === null || names.has(f.sampleId)),
    );
    let all: FailureDiff[] = [];
    let source: { iteration: IterationRecord; compared: number } | null = null;
    const devRuns = (await workbench.listIterations(projectId)).filter((i) => i.set === 'dev');
    // Stable sort: own runs first, newest first within each group.
    const candidates = [...devRuns].sort(
      (a, b) => Number(a.groupId !== null) - Number(b.groupId !== null),
    );
    for (const iteration of candidates) {
      const view = await iterationView(app, iteration);
      if (view.status !== 'complete') continue;
      all = failureDiffs(view.samples, devIds);
      const compared = view.samples.filter(
        (s) => s.comparison !== null && s.sampleId !== null && devIds.has(s.sampleId),
      ).length;
      source = { iteration, compared };
      break;
    }
    return {
      params: {
        feedback: open.map((f) => ({
          id: f.id,
          target: f.target,
          targetId: f.targetId,
          sample: f.sampleId === null ? null : (names.get(f.sampleId) ?? null),
          body: f.body,
        })),
        failures: revisionFailures(all, new Set(names.values())),
        ...(source
          ? {
              failuresFrom: {
                templateVersion: source.iteration.templateVersion,
                model: source.iteration.model,
              },
            }
          : {}),
        feedbackIds: open.map((f) => f.id),
      },
      failuresTotal: all.length,
      source,
    };
  }
```

In the `POST /workbench/projects/:id/stages/:stage` handler, replace the `samples` computation through the `createProposal` call's `feedbackIds` line with:

```ts
      // Holdout rule (ADR 0007): only dev samples ever reach a drafting model.
      const samples = devSamplesOf(await sampleViews(app, projectId));
      const revision = stage === 'revise' ? await reviseInputs(projectId, samples) : null;
      if (revision && !revision.params.feedback.length) {
        return reply.code(409).send({ error: 'add feedback before asking for a revision' });
      }
      // A revision can work from feedback alone; the other stages read the samples.
      if (!samples.length && !revision) {
        return reply.code(409).send({ error: 'no prepared dev samples' });
      }
      const brief = await workbench.latestBrief(projectId);
      const job = await app.deps.repo.createDraftJob(projectId, {
        stage,
        dataPolicy: project.dataPolicy,
        briefVersion: brief?.version ?? null,
        brief: brief?.body ?? EMPTY_BRIEF,
        draft: record.definition,
        samples,
        ...(changeStage ? { survey: await acceptedSurvey(app, projectId) } : {}),
        ...(revision?.params ?? {}),
      });
      const proposal = await workbench.createProposal({
        id: job.id,
        projectId,
        stage,
        briefVersion: brief?.version ?? null,
        baseVersion: changeStage ? record.version : null,
        baseDefinition: changeStage ? record.definition : null,
        feedbackIds: revision?.params.feedbackIds ?? null,
      });
```

In the decision handler replace the resolve block:

```ts
      // Accepted, fully or partly (RV2): the feedback the applied changes answer, or all of it
      // when no change names any (proposals from before RV2).
      if (record.stage === 'revise') {
        await workbench.resolveFeedback(
          projectId,
          answeredFeedback(proposed, chosen, record.feedbackIds ?? []),
          pid,
        );
      }
```

and in that route's `description`, replace the last sentence with:

```
          Accepting a \`revise\` proposal, fully or partly, resolves the feedback its applied
          changes answer (their \`answers\`); a proposal whose changes name none resolves all the
          feedback it was sent.
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project api` (stages, overview, holdout, bundle, openapi, conformance) → PASS; `npm run openapi`; `npm run typecheck`; `npx eslint apps/api`; `npx prettier --write apps/api/src/routes/workbench.ts apps/api/test/workbench-revise.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/test/workbench-revise.test.ts docs/openapi.json
git commit -m "Workbench API: revise jobs carry feedback ids and trimmed failures; resolve answered feedback (RV2, RV3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: API — `GET …/stages/revise/preview` (RV1)

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`, `apps/api/test/workbench-revise.test.ts`, `docs/openapi.json` (generated)

**Interfaces:**
- Consumes: `devSamplesOf`, `reviseInputs` (Task 4), `RevisePreviewSchema`, `type RevisePreview`, `MAX_CONTEXT_SAMPLES`, `MAX_FIELD_DIFFS`, `MAX_ROW_DIFFS` (shared), `versionsOf(templates, projectId)`, `templates.get`, `app.deps.llm.getSettings()`, `workbench.listIterations`, `iterationView`.
- Produces: `GET /api/workbench/projects/:id/stages/revise/preview` → 200 `RevisePreview` | 404 (operationId `previewRevision`, tag `Feedback & revise`).

- [ ] **Step 1: Write the failing tests** — append to `apps/api/test/workbench-revise.test.ts` (import `type RevisePreview` from `@ih/shared`):

```ts
describe('revise preview (RV1)', () => {
  const preview = async (ctx: Awaited<ReturnType<typeof project>>) => {
    const res = await ctx.app.inject('/api/workbench/projects/letter/stages/revise/preview');
    expect(res.statusCode).toBe(200);
    return res.json() as RevisePreview;
  };

  it('is a 404 for an unknown project', async () => {
    const { app } = await project();
    expect(
      (await app.inject('/api/workbench/projects/nope/stages/revise/preview')).statusCode,
    ).toBe(404);
  });

  it('shows the draft and the limits before any feedback or evaluation', async () => {
    const ctx = await project();
    expect(await preview(ctx)).toEqual({
      feedback: [],
      failures: [],
      failuresTotal: 0,
      failuresFrom: null,
      model: null,
      draft: { version: 1, definition: (await ctx.templates.get('letter', 1))!.definition },
      samples: [],
      limits: { samples: 8, fieldDiffs: 20, rowDiffs: 5 },
      notSent: { holdoutSamples: 0, holdoutRun: null },
    });
  });

  it('is exactly what the next revision sends, and names what it never sends', async () => {
    const ctx = await project();
    await ctx.app.deps.llm.setSettings({ draftingModel: 'local/qwen' }, null);
    const a = await ctx.add(1);
    const h = await ctx.add(2);
    await ctx.verify(a, 'Acme');
    await ctx.setRole(h.id, 'holdout');
    await ctx.verify(h, 'Globex');
    const dev = (await ctx.evaluate()).json() as { id: string };
    await ctx.evaluate({ set: 'holdout' });
    for (const r of await ctx.repo.listProjectRuns('letter')) {
      if (r.job.referenceId) await ctx.finish(r.job.id, 'Wrong');
    }
    await ctx.feedback({ target: 'field', targetId: 'sender', body: 'Letterhead', sampleId: a.id });

    const shown = await preview(ctx);
    const params = paramsOf(ctx, (await ctx.start('revise')).json().id);
    expect(shown.feedback).toEqual(params.feedback);
    expect(shown.failures).toEqual(params.failures);
    expect(shown.failures.map((f) => f.sample)).toEqual(['s1.pdf']);
    expect(shown.samples).toEqual(
      (params.samples as { filename: string }[]).map((s) => s.filename),
    );
    expect(shown.draft!.definition).toEqual(params.draft);
    expect(shown).toMatchObject({
      model: 'local/qwen',
      failuresTotal: 1,
      failuresFrom: { iterationId: dev.id, templateVersion: 1, model: null, compared: 1 },
      notSent: { holdoutSamples: 1, holdoutRun: { status: 'complete', score: 0 } },
    });
    expect(params.failuresFrom).toEqual({ templateVersion: 1, model: null });
  });

  it('has no draft once the version is published', async () => {
    const ctx = await project();
    await ctx.templates.publish('letter', 1);
    expect((await preview(ctx)).draft).toBeNull();
  });
});
```

(Iterations list newest first, so `evaluate()` before `evaluate({ set: 'holdout' })` keeps the dev run the latest *dev* iteration; `failuresFrom.createdAt` is not asserted because it is a clock value.)

- [ ] **Step 2: Run** `npx vitest run --project api apps/api/test/workbench-revise.test.ts -t "revise preview"` → FAIL (404: no such route).

- [ ] **Step 3: Implement** — `apps/api/src/routes/workbench.ts`: add `RevisePreviewSchema`, `type RevisePreview`, `MAX_FIELD_DIFFS`, `MAX_ROW_DIFFS` to the `@ih/shared` import. Inside the plugin, after `reviseInputs`:

```ts
  /** The newest holdout iteration, for "Not sent" (RV1); its score is shown, never sent. */
  async function latestHoldoutRun(projectId: string) {
    const latest = (await workbench.listIterations(projectId)).find((i) => i.set === 'holdout');
    if (!latest) return null;
    if (latest.scores) {
      return { iterationId: latest.id, status: 'complete' as const, score: latest.scores.score };
    }
    const view = await iterationView(app, latest);
    return { iterationId: latest.id, status: view.status, score: view.score };
  }
```

and register the route after `DELETE /workbench/projects/:id/feedback/:fid`:

```ts
  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/stages/revise/preview',
    {
      schema: {
        tags: ['Feedback & revise'],
        operationId: 'previewRevision',
        summary: 'Preview what a revision would send',
        description: md`
          Exactly what \`POST …/stages/revise\` would send to the drafting model now (handoff
          RV1): the open \`feedback\` (with ids, which the model's \`answers\` name), the failure
          diffs of the latest complete dev iteration (the template's own run first, else a
          model-comparison member; \`failuresFrom\`) restricted to the current ready dev samples,
          lowest score first and at most \`limits.samples\` (\`failuresTotal\` counts them before
          that cap; each diff keeps at most \`limits.fieldDiffs\` fields and \`limits.rowDiffs\`
          changed rows per table), the open \`draft\`, the dev sample files whose text goes along
          (\`samples\`), and the drafting \`model\` setting (null when unset).

          \`notSent\` is what the holdout rule keeps out of every model call: the ready holdout
          samples and the newest holdout iteration (its score is shown here, never sent). A
          revision needs open feedback and an open draft; the preview is available without them.
        `,
        params: ProjectIdParams,
        response: {
          200: res('What the next revision would send.', RevisePreviewSchema),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply): Promise<RevisePreview> => {
      const projectId = req.params.id;
      if (!(await workbench.getProject(projectId))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const views = await sampleViews(app, projectId);
      const dev = devSamplesOf(views);
      const [inputs, { draft }, settings, holdoutRun] = await Promise.all([
        reviseInputs(projectId, dev),
        versionsOf(templates, projectId),
        app.deps.llm.getSettings(),
        latestHoldoutRun(projectId),
      ]);
      const record = draft === null ? null : await templates.get(projectId, draft);
      const { source } = inputs;
      return {
        feedback: inputs.params.feedback,
        failures: inputs.params.failures,
        failuresTotal: inputs.failuresTotal,
        failuresFrom: source
          ? {
              iterationId: source.iteration.id,
              templateVersion: source.iteration.templateVersion,
              model: source.iteration.model,
              createdAt: source.iteration.createdAt,
              compared: source.compared,
            }
          : null,
        model: settings.draftingModel,
        draft: record ? { version: record.version, definition: record.definition } : null,
        samples: dev.slice(0, MAX_CONTEXT_SAMPLES).map((s) => s.filename),
        limits: { samples: MAX_CONTEXT_SAMPLES, fieldDiffs: MAX_FIELD_DIFFS, rowDiffs: MAX_ROW_DIFFS },
        notSent: {
          holdoutSamples: views.filter((s) => s.view.role === 'holdout' && s.view.state === 'ready')
            .length,
          holdoutRun,
        },
      };
    },
  );
```

(`IterationRecord.createdAt` exists in `apps/api/src/workbench/repo.ts`. The path does not clash with `POST …/stages/:stage` or `POST …/stages/:stage/skip`: different method and depth.)

- [ ] **Step 4: Run** the Step 2 command → PASS; `npm run openapi`; `npx vitest run --project api` (openapi docs test: tags, summary, description, operationId; conformance: the response is checked against `RevisePreviewSchema`; the access sweep covers the new route) → PASS; `npm run typecheck`; `npx eslint apps/api`; `npx prettier --write apps/api/src/routes/workbench.ts apps/api/test/workbench-revise.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/test/workbench-revise.test.ts docs/openapi.json
git commit -m "Workbench API: preview exactly what a revision sends (RV1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web — client method, `revisePreview` fake, pure Revise helpers

**Files:**
- Create: `apps/web/src/workbench/revise.ts`, `apps/web/test/revise-derive.test.ts`
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/client.test.ts`

**Interfaces:**
- Produces: `Api.getRevisePreview(projectId): Promise<RevisePreview>`; `revisePreview(overrides)` and `reviseProposal(overrides)` in `fake-api.ts` (default `getRevisePreview: vi.fn(async () => revisePreview())`); from `revise.ts`: `TARGET_TAG`, `STAGE_NAME`, `feedbackTargetIds`, `failureChips`, `previewSummary`, `failuresHeader`, `notSentText`, `feedbackOrigin`, `shownFeedback`, `answerNumbers`, `latestRevise`, `openProposalStage`, `earlierRevisions` / `EarlierRevision`, `revisionLine`.
- Consumed by: Tasks 8–9.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/client.test.ts` — inside `describe('http api: feedback', …)` add:

```ts
  it('reads the revise preview', async () => {
    const fetchMock = vi.fn(async () => respond(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await createHttpApi('/api').getRevisePreview('letter');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/workbench/projects/letter/stages/revise/preview');
  });
```

`apps/web/test/revise-derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DraftChange, FeedbackItem } from '@ih/shared';
import {
  answerNumbers,
  earlierRevisions,
  failureChips,
  failuresHeader,
  feedbackOrigin,
  feedbackTargetIds,
  notSentText,
  openProposalStage,
  previewSummary,
  revisionLine,
  shownFeedback,
} from '../src/workbench/revise.js';
import {
  changeProposalView,
  feedbackItem,
  iterationView,
  revisePreview,
  reviseProposal,
} from './fake-api.js';

const day = (iso: string) => new Date(iso).toLocaleDateString();

describe('feedbackTargetIds', () => {
  const def = {
    document: { sections: [{ id: 'header' }, { id: 'totals' }] },
    outputs: {
      fields: [{ id: 'total' }, { id: 'Bad Id' }],
      tables: [{ id: 'line_items' }],
    },
    pipeline: [{ type: 'extract', id: 'head' }, { type: 'check', id: 'sum' }],
  };
  it.each([
    ['field', ['total']],
    ['table', ['line_items']],
    ['step', ['head', 'sum']],
    ['section', ['header', 'totals']],
  ] as const)('%s ids in definition order, only ids the API accepts', (target, ids) => {
    expect(feedbackTargetIds(def, target)).toEqual(ids);
  });
  it('is empty for a malformed definition', () => {
    expect(feedbackTargetIds(null, 'field')).toEqual([]);
  });
});

describe('failureChips', () => {
  it('names fields, shows actual ≠ expected for scalars, and counts rows and cells', () => {
    expect(
      failureChips({
        sample: 'a.pdf',
        score: 0.85,
        fields: [
          { id: 'due_date', expected: '2026-10-03', actual: null },
          { id: 'total', expected: '4,694.40', actual: '3,912.00' },
        ],
        tables: [
          { id: 'line_items', missing: 1, extra: 0, changed: [] },
          { id: 'fees', missing: 0, extra: 2, changed: [] },
          {
            id: 'lines',
            missing: 0,
            extra: 0,
            changed: [
              { expected: { qty: 1 }, actual: { qty: 2 }, columns: ['qty'] },
              { expected: { qty: 3, unit: 'x' }, actual: { qty: 4, unit: 'y' }, columns: ['qty', 'unit'] },
            ],
          },
        ],
      }),
    ).toEqual([
      'due_date',
      'total 3,912.00 ≠ 4,694.40',
      'line_items −1 row',
      'fees +2 rows',
      'lines.qty 2 cells',
      'lines.unit 1 cell',
    ]);
  });
});

describe('previewSummary / failuresHeader / notSentText', () => {
  const failure = { sample: 'a.pdf', score: 0.5, fields: [], tables: [] };
  it('summarises what is sent', () => {
    expect(
      previewSummary(
        revisePreview({ feedback: [revisePreview().feedback[0]!], failures: [failure], failuresTotal: 1 }),
      ),
    ).toBe(
      '1 feedback item · 1 failure diff (up to 20 fields and 5 rows per table each) · draft v4 · local/qwen',
    );
  });
  it('says when the cap trims failures, and when there is no draft or model', () => {
    expect(
      previewSummary(
        revisePreview({
          feedback: [],
          failures: Array(8).fill(failure),
          failuresTotal: 11,
          draft: null,
          model: null,
        }),
      ),
    ).toBe(
      '0 feedback items · 8 of 11 failure diffs (the worst 8; up to 20 fields and 5 rows per table each) · no open draft · drafting model not set',
    );
  });
  it('heads the failures with the run they come from', () => {
    const at = '2026-10-12T09:02:00.000Z';
    const from = { iterationId: crypto.randomUUID(), templateVersion: 4, model: null, createdAt: at, compared: 6 };
    expect(failuresHeader(revisePreview({ failuresFrom: from, failuresTotal: 6 }))).toBe(
      `v4 · ${day(at)} · 6 of 6 below 100%`,
    );
    expect(failuresHeader(revisePreview({ failuresFrom: { ...from, model: 'fast' }, failuresTotal: 2 }))).toBe(
      `v4 · ${day(at)} · 2 of 6 below 100% · fast`,
    );
    expect(failuresHeader(revisePreview())).toBeNull();
  });
  it.each([
    [{ holdoutSamples: 2, holdoutRun: { iterationId: 'x', status: 'complete', score: 0.88 } }, 'Not sent: the holdout run (88%) and its 2 samples.'],
    [{ holdoutSamples: 1, holdoutRun: { iterationId: 'x', status: 'running', score: null } }, 'Not sent: the holdout run and its 1 sample.'],
    [{ holdoutSamples: 3, holdoutRun: null }, 'Not sent: the 3 holdout samples.'],
    [{ holdoutSamples: 0, holdoutRun: null }, 'Not sent: holdout samples (none yet).'],
  ] as const)('%j', (notSent, text) => {
    expect(notSentText(notSent)).toBe(text);
  });
});

describe('feedbackOrigin', () => {
  const run = iterationView({ id: crypto.randomUUID(), templateVersion: 4, createdAt: '2026-10-12T09:02:00.000Z' });
  it.each([
    [feedbackItem({ iterationId: run.id }), `From Evaluate · dev run v4 · ${day(run.createdAt)}`],
    [feedbackItem({ iterationId: crypto.randomUUID(), createdAt: '2026-10-11T17:20:00.000Z' }), `From Evaluate · ${day('2026-10-11T17:20:00.000Z')}`],
    [feedbackItem({ createdAt: '2026-10-11T17:20:00.000Z' }), `Added here · ${day('2026-10-11T17:20:00.000Z')}`],
  ])('%#', (item, text) => {
    expect(feedbackOrigin(item, [run])).toBe(text);
  });
});

describe('shownFeedback / answerNumbers', () => {
  const latest = reviseProposal();
  const open = feedbackItem({ body: 'open' });
  const answered = feedbackItem({ body: 'answered now', resolvedBy: latest.id });
  const old = feedbackItem({ body: 'answered before', resolvedBy: crypto.randomUUID() });
  it('shows open feedback and what the latest revision answered', () => {
    expect(shownFeedback([open, answered, old], latest).map((f) => f.body)).toEqual(['open', 'answered now']);
    expect(shownFeedback([open, answered], null).map((f) => f.body)).toEqual(['open']);
  });
  it('numbers the answered feedback as listed, ignoring ids not shown', () => {
    const shown: FeedbackItem[] = [open, answered];
    const c: DraftChange = { op: 'removeStep', id: 's', reason: 'r', answers: [answered.id, 'gone', open.id] };
    expect(answerNumbers(c, shown)).toEqual([1, 2]);
    expect(answerNumbers({ op: 'removeStep', id: 's', reason: 'r' }, shown)).toEqual([]);
  });
});

describe('openProposalStage', () => {
  it('names the first drafting stage whose newest proposal waits for a decision', () => {
    expect(openProposalStage([changeProposalView({ stage: 'steps' })])).toBe('steps');
    expect(
      openProposalStage([
        changeProposalView({ stage: 'steps', status: 'accepted' }),
        changeProposalView({ stage: 'steps' }), // older one: superseded
      ]),
    ).toBeNull();
    expect(openProposalStage([reviseProposal()])).toBeNull(); // revise itself does not count
  });
});

describe('earlierRevisions / revisionLine', () => {
  it('lists the revisions before the latest with what they answered', () => {
    const older = reviseProposal({ status: 'partially_accepted', acceptedChanges: [0], createdAt: '2026-10-10T08:00:00.000Z' });
    const rejected = reviseProposal({ status: 'rejected', createdAt: '2026-10-09T08:00:00.000Z' });
    const rows = earlierRevisions(
      [reviseProposal(), older, rejected],
      [feedbackItem({ resolvedBy: older.id })],
    );
    expect(rows.map(revisionLine)).toEqual([
      `${day(older.createdAt)} · local/qwen · 1 of 2 applied · answered 1 feedback item`,
      `${day(rejected.createdAt)} · local/qwen · rejected (2 changes)`,
    ]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/revise-derive.test.ts apps/web/test/client.test.ts` → FAIL (module `../src/workbench/revise.js` missing; `revisePreview`/`reviseProposal` not exported; `getRevisePreview` is not a function).

- [ ] **Step 3: Implement**

`apps/web/src/api/client.ts`: import `type RevisePreview` from `@ih/shared`; add to the `Api` interface after `deleteFeedback`:

```ts
  /** RV1: exactly what the next revision would send, and what it never sends. */
  getRevisePreview(projectId: string): Promise<RevisePreview>;
```

and to the implementation after `deleteFeedback`:

```ts
    getRevisePreview: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/stages/revise/preview`).then(json<RevisePreview>),
```

`apps/web/test/fake-api.ts`: import `type RevisePreview`; add `getRevisePreview: vi.fn(async () => revisePreview()),` after `deleteFeedback` in `fakeApi`; append:

```ts
export function revisePreview(overrides: Partial<RevisePreview> = {}): RevisePreview {
  return {
    feedback: [
      {
        id: '9b7c0c1e-0000-4000-8000-000000000001',
        target: 'field',
        targetId: 'total',
        sample: 'a.pdf',
        body: 'Take the TOTAL DUE line',
      },
    ],
    failures: [],
    failuresTotal: 0,
    failuresFrom: null,
    model: 'local/qwen',
    draft: {
      version: 4,
      definition: {
        id: 'letter',
        version: 4,
        name: 'Letter',
        document: { sections: [{ id: 'all', anchor: '\\A' }] },
        outputs: {
          fields: [
            { id: 'sender', type: 'text' },
            { id: 'total', type: 'decimal' },
          ],
          tables: [{ id: 'line_items', columns: [{ id: 'qty', type: 'integer' }] }],
        },
        pipeline: [{ type: 'extract', id: 'head', fields: ['sender', 'total'], sections: ['all'] }],
      },
    },
    samples: ['a.pdf'],
    limits: { samples: 8, fieldDiffs: 20, rowDiffs: 5 },
    notSent: { holdoutSamples: 0, holdoutRun: null },
    ...overrides,
  };
}

/** A ready revise proposal with two changes (no answers unless the body is overridden). */
export function reviseProposal(overrides: Partial<ProposalView> = {}): ProposalView {
  return changeProposalView({
    stage: 'revise',
    body: {
      notes: '',
      changes: [
        {
          op: 'putField',
          field: { id: 'total', type: 'decimal', description: 'The TOTAL DUE line' },
          reason: 'feedback 1',
        },
        { op: 'setPreamble', preamble: 'Supplier invoices.', reason: 'feedback 2' },
      ],
    },
    ...overrides,
  });
}
```

(The test-side helper `revisePreview()` uses `RevisePreview.feedback[0]` for the summary test; keep its default list at one item.)

`apps/web/src/workbench/revise.ts`:

```ts
import {
  changeBodyOf,
  FEEDBACK_TARGET_ID,
  STAGE_ORDER,
  type DraftChange,
  type DraftStage,
  type FeedbackItem,
  type FeedbackTarget,
  type IterationSummary,
  type ProposalView,
  type RevisePreview,
  type SentFailure,
} from '@ih/shared';

/** Pure helpers of the Revise tab (handoff §9). */

const DOT = '·';
const pct = (n: number) => `${Math.round(n * 100)}%`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => new Date(iso).toLocaleDateString();

export const TARGET_TAG: Record<FeedbackTarget, string> = {
  field: 'FIELD',
  table: 'TABLE',
  step: 'STEP',
  section: 'SECTION',
};

/** Tab names of the drafting stages a banner may point at (the stage ids are the tab ids). */
export const STAGE_NAME: Partial<Record<DraftStage, string>> = {
  survey: 'Survey',
  outputs: 'Outputs',
  sections: 'Sections',
  steps: 'Steps',
};

type Def = Record<string, unknown>;
const obj = (v: unknown): Def =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {};
const idsOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => obj(x).id)
    .filter((id): id is string => typeof id === 'string' && FEEDBACK_TARGET_ID.test(id));

/** The ids the add form offers (handoff §9: filled from the draft), in definition order. */
export function feedbackTargetIds(definition: unknown, target: FeedbackTarget): string[] {
  const def = obj(definition);
  const outputs = obj(def.outputs);
  switch (target) {
    case 'field':
      return idsOf(outputs.fields);
    case 'table':
      return idsOf(outputs.tables);
    case 'step':
      return idsOf(def.pipeline);
    case 'section':
      return idsOf(obj(def.document).sections);
  }
}

const scalar = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Diff chips of one failing sample: `due_date`, `total 3,912.00 ≠ 4,694.40`, `line_items −1 row`. */
export function failureChips(f: SentFailure): string[] {
  const fields = f.fields.map((x) =>
    scalar(x.actual) && scalar(x.expected)
      ? `${x.id} ${String(x.actual)} ≠ ${String(x.expected)}`
      : x.id,
  );
  const tables = f.tables.flatMap((t) => {
    const cells = new Map<string, number>();
    for (const row of t.changed) {
      for (const col of row.columns) cells.set(col, (cells.get(col) ?? 0) + 1);
    }
    return [
      ...(t.missing ? [`${t.id} −${count(t.missing, 'row')}`] : []),
      ...(t.extra ? [`${t.id} +${count(t.extra, 'row')}`] : []),
      ...[...cells].map(([col, n]) => `${t.id}.${col} ${count(n, 'cell')}`),
    ];
  });
  return [...fields, ...tables];
}

/** The "What the model will see" summary line. */
export function previewSummary(p: RevisePreview): string {
  const each = `up to ${p.limits.fieldDiffs} fields and ${p.limits.rowDiffs} rows per table each`;
  const failures =
    p.failuresTotal > p.failures.length
      ? `${p.failures.length} of ${p.failuresTotal} failure diffs (the worst ${p.limits.samples}; ${each})`
      : `${count(p.failures.length, 'failure diff')} (${each})`;
  return [
    count(p.feedback.length, 'feedback item'),
    failures,
    p.draft ? `draft v${p.draft.version}` : 'no open draft',
    p.model ?? 'drafting model not set',
  ].join(` ${DOT} `);
}

/** "v4 · 12/10/2026 · 6 of 6 below 100%" (plus the model of a comparison member). */
export function failuresHeader(p: RevisePreview): string | null {
  const from = p.failuresFrom;
  if (!from) return null;
  return [
    `v${from.templateVersion}`,
    day(from.createdAt),
    `${p.failuresTotal} of ${from.compared} below 100%`,
    ...(from.model ? [from.model] : []),
  ].join(` ${DOT} `);
}

/** The violet footer (§0.3): what the holdout rule keeps out of the call. */
export function notSentText({ holdoutSamples, holdoutRun }: RevisePreview['notSent']): string {
  if (holdoutRun) {
    const score = holdoutRun.score === null ? '' : ` (${pct(holdoutRun.score)})`;
    return `Not sent: the holdout run${score} and its ${count(holdoutSamples, 'sample')}.`;
  }
  return holdoutSamples
    ? `Not sent: the ${count(holdoutSamples, 'holdout sample')}.`
    : 'Not sent: holdout samples (none yet).';
}

/** "From Evaluate · dev run v4 · date" or "Added here · date". */
export function feedbackOrigin(f: FeedbackItem, iterations: readonly IterationSummary[]): string {
  if (f.iterationId === null) return `Added here ${DOT} ${day(f.createdAt)}`;
  const run = iterations.find((i) => i.id === f.iterationId);
  return run
    ? `From Evaluate ${DOT} dev run v${run.templateVersion} ${DOT} ${day(run.createdAt)}`
    : `From Evaluate ${DOT} ${day(f.createdAt)}`;
}

/** Open feedback, plus what the latest revision answered (shown ANSWERED). */
export function shownFeedback(
  items: readonly FeedbackItem[],
  latest: ProposalView | null,
): FeedbackItem[] {
  return items.filter((f) => f.resolvedBy === null || (latest !== null && f.resolvedBy === latest.id));
}

/** The list numbers of the feedback a change answers (the "Answers ①" badge). */
export function answerNumbers(c: DraftChange, shown: readonly FeedbackItem[]): number[] {
  const at = new Map(shown.map((f, i) => [f.id, i + 1]));
  return (c.answers ?? [])
    .flatMap((id) => (at.has(id) ? [at.get(id)!] : []))
    .sort((a, b) => a - b);
}

/** Proposals are listed newest first. */
export const latestRevise = (proposals: readonly ProposalView[]): ProposalView | null =>
  proposals.find((p) => p.stage === 'revise') ?? null;

/** The first drafting stage whose newest proposal is still waiting for a decision. */
export function openProposalStage(proposals: readonly ProposalView[]): DraftStage | null {
  return (
    STAGE_ORDER.find((stage) => proposals.find((p) => p.stage === stage)?.status === 'ready') ??
    null
  );
}

export interface EarlierRevision {
  id: string;
  createdAt: string;
  model: string | null;
  status: ProposalView['status'];
  applied: number;
  total: number;
  answered: number;
}

/** Every revise proposal before the latest (which the card shows), newest first. */
export function earlierRevisions(
  proposals: readonly ProposalView[],
  feedback: readonly FeedbackItem[],
): EarlierRevision[] {
  return proposals
    .filter((p) => p.stage === 'revise')
    .slice(1)
    .map((p) => ({
      id: p.id,
      createdAt: p.createdAt,
      model: p.model,
      status: p.status,
      applied: p.acceptedChanges?.length ?? 0,
      total: changeBodyOf(p)?.changes.length ?? 0,
      answered: feedback.filter((f) => f.resolvedBy === p.id).length,
    }));
}

const UNDECIDED: Partial<Record<ProposalView['status'], string>> = {
  ready: 'not decided',
  running: 'running',
  failed: 'failed',
};

export function revisionLine(r: EarlierRevision): string {
  const head = [day(r.createdAt), r.model ?? '—'];
  if (r.status === 'accepted' || r.status === 'partially_accepted') {
    return [...head, `${r.applied} of ${r.total} applied`, `answered ${count(r.answered, 'feedback item')}`].join(` ${DOT} `);
  }
  if (r.status === 'rejected') return [...head, `rejected (${count(r.total, 'change')})`].join(` ${DOT} `);
  return [...head, UNDECIDED[r.status] ?? r.status].join(` ${DOT} `);
}
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web`; `npm run typecheck`; `npx eslint apps/web`; `npx prettier --write apps/web/src/workbench/revise.ts apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/test/revise-derive.test.ts apps/web/test/client.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/revise.ts apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/test/revise-derive.test.ts apps/web/test/client.test.ts
git commit -m "Workbench web: revise preview in the client and pure Revise helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Primitives — `ProposalCard` `badge` and `footerNote`, `StaleBanner` `warn` tone

**Files:**
- Modify: `apps/web/src/workbench/ProposalCard.tsx`, `apps/web/src/workbench/StaleBanner.tsx`, `apps/web/src/styles/stages.css`, `apps/web/test/ProposalCard.test.tsx`, `apps/web/test/tab-primitives.test.tsx`

**Interfaces:**
- Produces: `ProposalCard` props `badge?: (c: DraftChange, index: number) => ReactNode` (rendered beside each change while the proposal is ready) and `footerNote?: string` (muted text in the footer); `StaleBanner` `tone?: 'alert' | 'info' | 'skip' | 'warn'`.
- Consumed by: Task 9.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/ProposalCard.test.tsx`:

```tsx
  it('draws a badge beside each change and a footer note', () => {
    card(changeProposalView(), {
      badge: (_c, i) => (i === 0 ? <span>Answers 1</span> : null),
      footerNote: 'Feedback a change answers is marked answered when you apply it.',
    });
    const [first, second] = within(screen.getByRole('region', { name: 'Proposal' })).getAllByRole(
      'listitem',
    );
    expect(first).toHaveTextContent('Answers 1');
    expect(second).not.toHaveTextContent('Answers');
    expect(
      screen.getByText('Feedback a change answers is marked answered when you apply it.'),
    ).toBeInTheDocument();
  });
```

Append inside `describe('StaleBanner', …)` in `apps/web/test/tab-primitives.test.tsx`:

```tsx
  it('has a warn tone without the stale icon', () => {
    render(<StaleBanner tone="warn">Steps has an open proposal.</StaleBanner>);
    const note = screen.getByRole('note');
    expect(note).toHaveAttribute('data-tone', 'warn');
    expect(within(note).queryByRole('img', { name: 'Stale' })).toBeNull();
  });
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/ProposalCard.test.tsx apps/web/test/tab-primitives.test.tsx` → FAIL (no badge or footer note rendered). The `warn` banner test passes at runtime already (the attribute passes through and only `alert` draws the icon); its red side is `npm run typecheck`, which fails on `tone="warn"` until the type is widened — run it too.

- [ ] **Step 3: Implement**

`apps/web/src/workbench/ProposalCard.tsx`: `import { useId, type ReactNode } from 'react';`; add to the props type after `next?: NextStep;`:

```ts
  /** Beside each change while ready (revise: the "Answers ①" badge); null draws nothing. */
  badge?: (c: DraftChange, index: number) => ReactNode;
  /** A muted line in the footer, next to Apply and Reject. */
  footerNote?: string;
```

destructure `badge, footerNote`, and in the ready list, between `</label>` and `<details>`:

```tsx
              {badge && <span className="proposal-badge">{badge(c, i)}</span>}
```

and in the footer, before the *Edit by hand* link:

```tsx
        {footerNote && <span className="muted proposal-footer-note">{footerNote}</span>}
```

`apps/web/src/workbench/StaleBanner.tsx`: widen `tone?: 'alert' | 'info' | 'skip' | 'warn';` (the icon lines stay keyed on `alert`/`skip`, so `warn` has none).

`apps/web/src/styles/stages.css`: after `.stale-banner[data-tone='skip'] { … }` add

```css
.stale-banner[data-tone='warn'] {
  border-color: var(--ih-warn-fg);
  background: var(--ih-warn-bg);
}
.proposal-badge {
  align-self: start;
  min-width: 0;
}
.proposal-footer-note {
  font-size: var(--ih-text-sm);
  overflow-wrap: anywhere;
}
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web`; `npm run typecheck`; `npx eslint apps/web`; `npx prettier --write apps/web/src/workbench/ProposalCard.tsx apps/web/src/workbench/StaleBanner.tsx apps/web/src/styles/stages.css apps/web/test/ProposalCard.test.tsx apps/web/test/tab-primitives.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/ProposalCard.tsx apps/web/src/workbench/StaleBanner.tsx apps/web/src/styles/stages.css apps/web/test/ProposalCard.test.tsx apps/web/test/tab-primitives.test.tsx
git commit -m "Workbench web: proposal card badges and footer note; warn banner tone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Your feedback — `ReviseFeedback` (numbered list, ANSWERED, add form from the draft)

**Files:**
- Create: `apps/web/src/workbench/ReviseFeedback.tsx`, `apps/web/test/ReviseFeedback.test.tsx`
- Modify: `apps/web/src/styles/stages.css`

**Interfaces:**
- Consumes: `TARGET_TAG`, `feedbackOrigin`, `feedbackTargetIds` (Task 6); `Segmented`; `api.addFeedback`, `api.deleteFeedback`.
- Produces: `ReviseFeedback` props `{ api, projectId, items: FeedbackItem[] (already `shownFeedback`), samples: SampleView[], iterations: IterationSummary[], definition: unknown, onChanged: () => void }`.
- Consumed by: Task 9.

- [ ] **Step 1: Write the failing tests** — `apps/web/test/ReviseFeedback.test.tsx`:

```tsx
import type { ComponentProps } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api/client.js';
import { ReviseFeedback } from '../src/workbench/ReviseFeedback.js';
import { fakeApi, feedbackItem, iterationView, revisePreview, sampleView } from './fake-api.js';

const definition = revisePreview().draft!.definition;

function list(props: Partial<ComponentProps<typeof ReviseFeedback>> = {}, overrides: Partial<Api> = {}) {
  const api = fakeApi({
    addFeedback: vi.fn(async () => feedbackItem()),
    deleteFeedback: vi.fn(async () => undefined),
    ...overrides,
  });
  const onChanged = vi.fn();
  render(
    <ReviseFeedback
      api={api}
      projectId="letter"
      items={[]}
      samples={[]}
      iterations={[]}
      definition={definition}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { api, onChanged };
}

describe('ReviseFeedback', () => {
  it('numbers each item with its target, sample, body and origin', () => {
    const run = iterationView({ id: crypto.randomUUID(), templateVersion: 4 });
    const s = sampleView({ id: crypto.randomUUID(), filename: 'inv-0012-initech.pdf' });
    list({
      samples: [s],
      iterations: [run],
      items: [
        feedbackItem({ targetId: 'total', sampleId: s.id, iterationId: run.id, body: 'Take TOTAL DUE' }),
        feedbackItem({ target: 'table', targetId: 'line_items', body: 'Rows split across pages' }),
      ],
    });
    const section = screen.getByRole('region', { name: /Your feedback/ });
    expect(within(section).getByRole('heading', { name: 'Your feedback 2 open' })).toBeInTheDocument();
    const [first, second] = within(section).getAllByRole('listitem');
    expect(first).toHaveTextContent('FIELD');
    expect(first).toHaveTextContent('total');
    expect(first).toHaveTextContent('inv-0012-initech.pdf');
    expect(first).toHaveTextContent('Take TOTAL DUE');
    expect(first).toHaveTextContent(`From Evaluate · dev run v4 · ${new Date(run.createdAt).toLocaleDateString()}`);
    expect(second).toHaveTextContent('TABLE');
    expect(second).toHaveTextContent('Added here');
    expect(within(second!).getByRole('button', { name: 'Delete feedback 2' })).toBeEnabled();
  });

  it('marks answered feedback and offers no Delete for it', () => {
    list({ items: [feedbackItem({ body: 'Done', resolvedBy: crypto.randomUUID() })] });
    const item = screen.getByRole('listitem');
    expect(within(item).getByText('ANSWERED')).toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Your feedback 0 open' })).toBeInTheDocument();
  });

  it('deletes open feedback', async () => {
    const f = feedbackItem();
    const { api, onChanged } = list({ items: [f] });
    await userEvent.click(screen.getByRole('button', { name: 'Delete feedback 1' }));
    expect(api.deleteFeedback).toHaveBeenCalledWith('letter', f.id);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('fills the id list from the draft for the chosen target', async () => {
    list();
    const about = screen.getByRole('group', { name: 'Add feedback about' });
    expect(within(about).getByRole('button', { name: 'Field' })).toHaveAttribute('aria-pressed', 'true');
    const id = screen.getByRole('combobox', { name: 'Id' });
    expect(within(id).getAllByRole('option').map((o) => o.textContent)).toEqual(['sender', 'total']);
    await userEvent.click(within(about).getByRole('button', { name: 'Table' }));
    expect(within(id).getAllByRole('option').map((o) => o.textContent)).toEqual(['line_items']);
    await userEvent.click(within(about).getByRole('button', { name: 'Section' }));
    expect(within(id).getAllByRole('option').map((o) => o.textContent)).toEqual(['all']);
  });

  it('adds feedback with only a target, an id and the text: never a sample or a run (RV3)', async () => {
    const { api, onChanged } = list();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Id' }), 'total');
    await userEvent.type(screen.getByRole('textbox', { name: 'Feedback' }), 'Take the TOTAL DUE line');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(api.addFeedback).toHaveBeenCalledWith('letter', {
      target: 'field',
      targetId: 'total',
      body: 'Take the TOTAL DUE line',
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: 'Feedback' })).toHaveValue('');
  });

  it('says why Add is disabled', async () => {
    list({ definition: { outputs: { fields: [{ id: 'total' }], tables: [] } } });
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', 'Write the feedback first');
    await userEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByRole('combobox', { name: 'Id' })).toBeDisabled();
    expect(add).toHaveAttribute('title', 'The draft has no tables yet');
  });

  it('caps the text at what the API accepts and shows a refusal', async () => {
    list({}, { addFeedback: vi.fn(async () => Promise.reject(new Error('nope'))) });
    expect(screen.getByRole('textbox', { name: 'Feedback' })).toHaveAttribute('maxlength', '2000');
    await userEvent.type(screen.getByRole('textbox', { name: 'Feedback' }), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/ReviseFeedback.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement** — `apps/web/src/workbench/ReviseFeedback.tsx`:

```tsx
import { useId, useState } from 'react';
import {
  FEEDBACK_MAX_CHARS,
  FEEDBACK_TARGETS,
  type FeedbackItem,
  type FeedbackTarget,
  type IterationSummary,
  type SampleView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Segmented } from '../ui/Segmented.js';
import { feedbackOrigin, feedbackTargetIds, TARGET_TAG } from './revise.js';

const TARGET_LABEL: Record<FeedbackTarget, string> = {
  field: 'Field',
  table: 'Table',
  step: 'Step',
  section: 'Section',
};
const TARGET_TONE: Record<FeedbackTarget, string> = {
  field: 'info',
  table: 'ok',
  step: 'warn',
  section: 'skip',
};

/**
 * "Your feedback" (handoff §9): numbered items with target, sample, body and origin; answered
 * items are tagged and kept; the add form's id list comes from the draft. Holdout rule (RV3):
 * the form never sends a sample or a run (feedback from a run is added on the Evaluate tab).
 */
export function ReviseFeedback({
  api,
  projectId,
  items,
  samples,
  iterations,
  definition,
  onChanged,
}: {
  api: Api;
  projectId: string;
  /** Open feedback and what the latest revision answered (`shownFeedback`). */
  items: FeedbackItem[];
  samples: SampleView[];
  iterations: IterationSummary[];
  /** The open draft (ids for the add form); null without one. */
  definition: unknown;
  onChanged: () => void;
}) {
  const headingId = useId();
  const [target, setTarget] = useState<FeedbackTarget>('field');
  const [chosen, setChosen] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = feedbackTargetIds(definition, target);
  const targetId = options.includes(chosen) ? chosen : (options[0] ?? '');
  const open = items.filter((f) => f.resolvedBy === null).length;
  const sampleName = (id: string) => samples.find((s) => s.id === id)?.filename ?? null;
  const addReason = !targetId
    ? `The draft has no ${target}s yet`
    : !body.trim()
      ? 'Write the feedback first'
      : null;

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = () =>
    act(async () => {
      await api.addFeedback(projectId, { target, targetId, body: body.trim() });
      setBody('');
      onChanged();
    });
  const remove = (id: string) =>
    act(async () => {
      await api.deleteFeedback(projectId, id);
      onChanged();
    });

  return (
    <section className="revise-feedback" aria-labelledby={headingId}>
      <h3 id={headingId}>
        Your feedback <span className="muted">{open} open</span>
      </h3>
      {items.length === 0 ? (
        <p className="muted">
          No open feedback. Add a note below, or comment on a dev run on the Evaluate tab.
        </p>
      ) : (
        <ol className="feedback-list">
          {items.map((f, i) => {
            const answered = f.resolvedBy !== null;
            const sample = f.sampleId ? sampleName(f.sampleId) : null;
            return (
              <li key={f.id} className="feedback-item">
                <span className="feedback-num" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="feedback-text">
                  <p className="feedback-head">
                    <span className={`kind-tag tone-${TARGET_TONE[f.target]}`}>
                      {TARGET_TAG[f.target]}
                    </span>{' '}
                    <code>{f.targetId}</code>
                    {sample && <span className="muted"> · {sample}</span>}
                    {answered && (
                      <>
                        {' '}
                        <span className="kind-tag tone-ok">ANSWERED</span>
                      </>
                    )}
                  </p>
                  <p className="feedback-body">{f.body}</p>
                  <p className="muted feedback-origin">{feedbackOrigin(f, iterations)}</p>
                </div>
                {!answered && (
                  <button
                    type="button"
                    aria-label={`Delete feedback ${i + 1}`}
                    disabled={busy}
                    onClick={() => void remove(f.id)}
                  >
                    Delete
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <form
        className="feedback-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="feedback-add-row">
          <Segmented
            label="Add feedback about"
            options={FEEDBACK_TARGETS.map((t) => ({ value: t, label: TARGET_LABEL[t] }))}
            value={target}
            onChange={(t) => {
              setTarget(t);
              setChosen('');
            }}
          />
          <select
            aria-label="Id"
            value={targetId}
            disabled={!options.length}
            onChange={(e) => setChosen(e.target.value)}
          >
            {options.length ? (
              options.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))
            ) : (
              <option value="">No {target}s in the draft</option>
            )}
          </select>
        </div>
        <div className="feedback-add-row">
          <textarea
            aria-label="Feedback"
            placeholder="What should change, in plain words"
            maxLength={FEEDBACK_MAX_CHARS}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button type="submit" disabled={busy || addReason !== null} title={addReason ?? undefined}>
            Add
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
```

`apps/web/src/styles/stages.css` — append (and add `.revise-feedback` to the shared padding list and `.revise-feedback h3` to the `font-weight: 600` list):

```css
/* Revise (handoff §9) */
.feedback-list {
  display: grid;
  gap: 0;
  margin: 8px 0 12px;
  padding: 0;
  list-style: none;
}
.feedback-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
  padding: 10px 0;
  border-top: 1px solid var(--ih-border);
}
.feedback-num {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--ih-info-bg);
  color: var(--ih-info-fg);
  font-size: var(--ih-text-sm);
}
.feedback-text {
  min-width: 0;
}
.feedback-text p {
  margin: 2px 0;
  overflow-wrap: anywhere;
}
.feedback-origin {
  font-size: var(--ih-text-sm);
}
.feedback-add {
  display: grid;
  gap: 8px;
}
.feedback-add-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-start;
}
.feedback-add-row > * {
  min-width: 0;
}
.feedback-add textarea {
  flex: 1 1 240px;
  min-height: 52px;
}
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web`; `npm run typecheck`; `npx eslint apps/web`; `npx prettier --write apps/web/src/workbench/ReviseFeedback.tsx apps/web/test/ReviseFeedback.test.tsx apps/web/src/styles/stages.css`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/ReviseFeedback.tsx apps/web/test/ReviseFeedback.test.tsx apps/web/src/styles/stages.css
git commit -m "Workbench web: Your feedback list and add form filled from the draft

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Revise tab — banner, What the model will see, failures, running strip, proposal with Answers, Earlier revisions

**Files:**
- Modify: `apps/web/src/workbench/ReviseTab.tsx` (rewrite), `apps/web/test/ReviseTab.test.tsx` (rewrite), `apps/web/src/workbench/StagePanel.tsx` (export `POLICY_NOTE`), `apps/web/src/workbench/ProjectPage.tsx`, `apps/web/test/ProjectPage.test.tsx`, `apps/web/src/styles/stages.css`

**Interfaces:**
- Consumes: Tasks 6–8; `api.getRevisePreview`, `listFeedback`, `listProposals`, `listSamples`, `listIterations`, `startStage`, `decideProposal`; `changeBodyOf`.
- Produces: `ReviseTab` props `{ api, projectId, dataPolicy, draft: number | null, pollMs, onApplied, now? }` (replaces `hasDraft`).

- [ ] **Step 1: Write the failing tests** — replace `apps/web/test/ReviseTab.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api/client.js';
import { ReviseTab } from '../src/workbench/ReviseTab.js';
import {
  changeProposalView,
  fakeApi,
  feedbackItem,
  revisePreview,
  reviseProposal,
} from './fake-api.js';

function tab(overrides: Partial<Api> = {}, props: { draft?: number | null; pollMs?: number } = {}) {
  const api = fakeApi(overrides);
  const onApplied = vi.fn();
  render(
    <ReviseTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      draft={props.draft === undefined ? 4 : props.draft}
      pollMs={props.pollMs ?? 60_000}
      onApplied={onApplied}
      now={Date.parse('2026-10-13T12:00:00.000Z')}
    />,
  );
  return { api, onApplied };
}

const failing = {
  failures: [
    { sample: 'inv-0039-hooli.pdf', score: 0.84, fields: [{ id: 'due_date', expected: '2026-10-03', actual: null }], tables: [] },
    { sample: 'inv-0012-initech.pdf', score: 0.85, fields: [{ id: 'total', expected: '4,694.40', actual: '3,912.00' }], tables: [] },
  ],
  failuresTotal: 2,
  failuresFrom: {
    iterationId: crypto.randomUUID(),
    templateVersion: 4,
    model: null,
    createdAt: '2026-10-12T09:02:00.000Z',
    compared: 6,
  },
  notSent: {
    holdoutSamples: 2,
    holdoutRun: { iterationId: crypto.randomUUID(), status: 'complete' as const, score: 0.88 },
  },
};

describe('ReviseTab', () => {
  it('shows what the model will see and asks for a revision', async () => {
    const { api } = tab({
      getRevisePreview: vi.fn(async () => revisePreview(failing)),
      listFeedback: vi.fn(async () => [feedbackItem({ targetId: 'total' })]),
      startStage: vi.fn(async () => reviseProposal({ status: 'running', body: null })),
    });
    const card = await screen.findByRole('region', { name: 'What the model will see' });
    expect(card).toHaveTextContent(
      '1 feedback item · 2 failure diffs (up to 20 fields and 5 rows per table each) · draft v4 · local/qwen',
    );
    const failures = within(card).getByRole('region', { name: /Failures from the latest dev run/ });
    const rows = within(failures).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('inv-0039-hooli.pdf');
    expect(rows[0]).toHaveTextContent('84%');
    expect(rows[1]).toHaveTextContent('total 3,912.00 ≠ 4,694.40');
    expect(within(failures).getByText('Not sent: the holdout run (88%) and its 2 samples.')).toHaveClass(
      'holdout-note',
    );
    await userEvent.click(within(card).getByRole('button', { name: 'Ask the model for a revision' }));
    expect(api.startStage).toHaveBeenCalledWith('letter', 'revise');
  });

  it.each([
    [{ getRevisePreview: vi.fn(async () => revisePreview({ feedback: [] })) }, 4, 'Add feedback first: a revision answers your feedback'],
    [{ getRevisePreview: vi.fn(async () => revisePreview({ draft: null })) }, null, 'Start the next version on the Template tab first'],
    [{ listProposals: vi.fn(async () => [reviseProposal({ status: 'running', body: null })]) }, 4, 'A revision is being drafted'],
  ])('says why it cannot ask (%#)', async (overrides, draft, reason) => {
    tab(overrides, { draft });
    const ask = await screen.findByRole('button', { name: 'Ask the model for a revision' });
    expect(ask).toBeDisabled();
    expect(ask).toHaveAttribute('title', reason);
  });

  it('says when no dev run has failures to send', async () => {
    tab();
    expect(await screen.findByText('No complete dev run yet. Evaluate on dev to send its failures.')).toBeInTheDocument();
  });

  it('warns when another stage has a proposal waiting, with a link to decide it', async () => {
    tab({ listProposals: vi.fn(async () => [changeProposalView({ stage: 'steps' })]) });
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Steps has an open proposal.');
    expect(within(note).getByRole('link', { name: 'Open Steps' })).toHaveAttribute(
      'href',
      '#/workbench/letter/steps',
    );
  });

  it('shows a running strip while the revision is drafted, then polls until it is ready', async () => {
    const ready = reviseProposal();
    tab(
      {
        listProposals: vi
          .fn()
          .mockResolvedValueOnce([{ ...ready, status: 'running', body: null }])
          .mockResolvedValue([ready]),
      },
      { pollMs: 1 },
    );
    expect(await screen.findByRole('region', { name: 'Proposal' })).toBeInTheDocument();
  });

  it('shows the running strip', async () => {
    tab({ listProposals: vi.fn(async () => [reviseProposal({ status: 'running', body: null })]) });
    expect(await screen.findByRole('status')).toHaveTextContent('The model is drafting a revision…');
  });

  it('badges each change with the feedback it answers, then marks it ANSWERED after Apply', async () => {
    const one = feedbackItem({ targetId: 'total', body: 'Take TOTAL DUE' });
    const two = feedbackItem({ target: 'step', targetId: 'head', body: 'Say what these are' });
    const ready = reviseProposal({
      body: {
        notes: '',
        changes: [
          { op: 'putField', field: { id: 'total', type: 'decimal' }, reason: 'feedback 1', answers: [one.id] },
          { op: 'setPreamble', preamble: 'Supplier invoices.', reason: 'feedback 2', answers: [two.id] },
        ],
      },
    });
    const accepted = { ...ready, status: 'accepted' as const, acceptedChanges: [0, 1] };
    const { api, onApplied } = tab({
      listFeedback: vi
        .fn()
        .mockResolvedValueOnce([one, two])
        .mockResolvedValue([
          { ...one, resolvedBy: ready.id },
          { ...two, resolvedBy: ready.id },
        ]),
      listProposals: vi.fn().mockResolvedValueOnce([ready]).mockResolvedValue([accepted]),
      decideProposal: vi.fn(async () => accepted),
    });
    const proposal = await screen.findByRole('region', { name: 'Proposal' });
    const [first, second] = within(proposal).getAllByRole('listitem');
    expect(first).toHaveTextContent('Answers 1');
    expect(second).toHaveTextContent('Answers 2');
    expect(
      within(proposal).getByText('Feedback a change answers is marked answered when you apply it.'),
    ).toBeInTheDocument();
    await userEvent.click(within(proposal).getByRole('button', { name: 'Apply 2 selected changes' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', ready.id, 'accepted', [0, 1]);
    await waitFor(() => expect(screen.getAllByText('ANSWERED')).toHaveLength(2));
    expect(onApplied).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Evaluate on dev' })).toHaveAttribute(
      'href',
      '#/workbench/letter/evaluate',
    );
  });

  it('lists earlier revisions, collapsed', async () => {
    const older = reviseProposal({ status: 'accepted', acceptedChanges: [0, 1], createdAt: '2026-10-10T08:00:00.000Z' });
    tab({
      listProposals: vi.fn(async () => [reviseProposal(), older]),
      listFeedback: vi.fn(async () => [feedbackItem({ resolvedBy: older.id })]),
    });
    const details = (await screen.findByText('Earlier revisions · 1')).closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('2 of 2 applied · answered 1 feedback item');
  });

  it('shows why it could not load', async () => {
    tab({ getRevisePreview: vi.fn(async () => Promise.reject(new Error('down'))) });
    expect(await screen.findByRole('alert')).toHaveTextContent('down');
  });
});
```

In `apps/web/test/ProjectPage.test.tsx`, replace the test `'has one Propose button and no Skip on the Revise tab'` body's assertions (keep the render) with:

```tsx
    await screen.findByRole('heading', { level: 2, name: 'Revise' });
    expect(
      await screen.findAllByRole('button', { name: 'Ask the model for a revision' }),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Skip this stage' })).toBeNull();
```

and rename it `'has one Ask button and no Skip on the Revise tab'`.

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/ReviseTab.test.tsx apps/web/test/ProjectPage.test.tsx` → FAIL (the old tab has no preview card, no Ask button, takes `hasDraft`).

- [ ] **Step 3: Implement**

`apps/web/src/workbench/StagePanel.tsx`: change `const POLICY_NOTE` to `export const POLICY_NOTE`.

`apps/web/src/workbench/ReviseTab.tsx` (replace the file):

```tsx
import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  changeBodyOf,
  type DataPolicy,
  type DraftChange,
  type FeedbackItem,
  type IterationSummary,
  type ProposalView,
  type RevisePreview,
  type SampleView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { ProposalCard, type NextStep } from './ProposalCard.js';
import { ReviseFeedback } from './ReviseFeedback.js';
import {
  answerNumbers,
  earlierRevisions,
  failureChips,
  failuresHeader,
  latestRevise,
  notSentText,
  openProposalStage,
  previewSummary,
  revisionLine,
  shownFeedback,
  STAGE_NAME,
} from './revise.js';
import { POLICY_NOTE } from './StagePanel.js';
import { StaleBanner } from './StaleBanner.js';

const pct = (n: number) => `${Math.round(n * 100)}%`;

const NEXT = (projectId: string): NextStep => ({
  href: `#/workbench/${projectId}/evaluate`,
  label: 'Evaluate on dev',
  text: 'Run the dev set to see whether the changes helped; when dev looks right, run holdout to check the gate.',
});

function AnswersBadge({ numbers }: { numbers: number[] }) {
  return (
    <span className="answers-badge">
      Answers
      {numbers.map((n) => (
        <Fragment key={n}>
          {' '}
          <span className="answer-num">{n}</span>
        </Fragment>
      ))}
    </span>
  );
}

interface Loaded {
  preview: RevisePreview;
  feedback: FeedbackItem[];
  proposals: ProposalView[];
  samples: SampleView[];
  iterations: IterationSummary[];
}

/**
 * Revise (handoff §9, RV1–RV3): what the next revision sends (preview), your feedback, the
 * latest dev failures, the proposal with the feedback each change answers, earlier revisions.
 */
export function ReviseTab({
  api,
  projectId,
  dataPolicy,
  draft,
  pollMs,
  onApplied,
  now = Date.now(),
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  draft: number | null;
  pollMs: number;
  onApplied: () => void;
  now?: number;
}) {
  const seeId = useId();
  const failId = useId();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const [preview, feedback, proposals, samples, iterations] = await Promise.all([
        api.getRevisePreview(projectId),
        api.listFeedback(projectId),
        api.listProposals(projectId),
        api.listSamples(projectId),
        api.listIterations(projectId),
      ]);
      if (id !== seq.current) return; // a newer load (or unmount) superseded this one
      setData({ preview, feedback, proposals, samples, iterations });
      setError(null);
    } catch (err) {
      if (id === seq.current) setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load, draft]);

  const latest = data ? latestRevise(data.proposals) : null;
  const running = latest?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, load]);

  // A new proposal starts with every change selected (reset during render, as StagePanel does).
  const body = latest ? changeBodyOf(latest) : null;
  const changeCount = body?.changes.length ?? 0;
  const selectionKey = `${latest?.id ?? ''}:${changeCount}`;
  const [selectedFor, setSelectedFor] = useState(selectionKey);
  if (selectedFor !== selectionKey) {
    setSelectedFor(selectionKey);
    setSelected(new Set(Array.from({ length: changeCount }, (_, i) => i)));
  }

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ask = () =>
    act(async () => {
      await api.startStage(projectId, 'revise');
      await load();
    });
  const apply = () =>
    act(async () => {
      if (!latest) return;
      await api.decideProposal(
        projectId,
        latest.id,
        'accepted',
        [...selected].sort((a, b) => a - b),
      );
      onApplied();
      await load();
    });
  const reject = () =>
    act(async () => {
      if (!latest) return;
      await api.decideProposal(projectId, latest.id, 'rejected');
      await load();
    });
  const toggle = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setSelected(next);
  };

  if (!data) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;

  const { preview } = data;
  const shown = shownFeedback(data.feedback, latest);
  const other = openProposalStage(data.proposals);
  const header = failuresHeader(preview);
  const earlier = earlierRevisions(data.proposals, data.feedback);
  const askReason = !preview.draft
    ? 'Start the next version on the Template tab first'
    : running
      ? 'A revision is being drafted'
      : !preview.feedback.length
        ? 'Add feedback first: a revision answers your feedback'
        : null;
  const badge = (c: DraftChange) => {
    const numbers = answerNumbers(c, shown);
    return numbers.length ? <AnswersBadge numbers={numbers} /> : null;
  };

  return (
    <div className="revise-tab">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      {other && (
        <StaleBanner tone="warn">
          <strong>{STAGE_NAME[other]} has an open proposal.</strong> Decide it first so this
          revision does not spend itself proposing the same fix.{' '}
          <a href={`#/workbench/${projectId}/${other}`}>Open {STAGE_NAME[other]}</a>
        </StaleBanner>
      )}
      {error && <p role="alert">{error}</p>}
      <section className="card revise-see" aria-labelledby={seeId}>
        <div className="revise-see-head">
          <div className="revise-see-text">
            <h3 id={seeId}>What the model will see</h3>
            <p className="muted">{previewSummary(preview)}</p>
          </div>
          <button
            type="button"
            className="primary"
            disabled={busy || askReason !== null}
            title={askReason ?? undefined}
            onClick={() => void ask()}
          >
            Ask the model for a revision
          </button>
        </div>
        <div className="revise-split">
          <ReviseFeedback
            api={api}
            projectId={projectId}
            items={shown}
            samples={data.samples}
            iterations={data.iterations}
            definition={preview.draft?.definition ?? null}
            onChanged={() => void load()}
          />
          <section className="revise-failures" aria-labelledby={failId}>
            <h3 id={failId}>
              Failures from the latest dev run
              {header && <span className="muted"> {header}</span>}
            </h3>
            {preview.failuresFrom === null ? (
              <p className="muted">No complete dev run yet. Evaluate on dev to send its failures.</p>
            ) : preview.failures.length === 0 ? (
              <p className="muted">Every dev sample scored 100%.</p>
            ) : (
              <ul className="failure-list">
                {preview.failures.map((f, i) => (
                  <li key={`${i}-${f.sample}`}>
                    <span className="failure-head">
                      <code>{f.sample}</code>
                      <span>{pct(f.score)}</span>
                    </span>
                    <span className="failure-chips">
                      {failureChips(f).map((chip, j) => (
                        <code key={`${j}-${chip}`} className="diff-chip">
                          {chip}
                        </code>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {preview.failuresTotal > preview.failures.length && (
              <p className="muted">
                {preview.failuresTotal - preview.failures.length} more failing dev samples are not
                sent (the worst {preview.limits.samples} are).
              </p>
            )}
            <p className="holdout-note revise-not-sent">{notSentText(preview.notSent)}</p>
          </section>
        </div>
      </section>
      {running && (
        <p role="status" className="revise-running">
          The model is drafting a revision…
        </p>
      )}
      {latest?.status === 'failed' && <p role="alert">{latest.error}</p>}
      {latest && body && (
        <ProposalCard
          projectId={projectId}
          proposal={latest}
          body={body}
          definition={preview.draft?.definition ?? null}
          draftVersion={preview.draft?.version ?? draft}
          selected={selected}
          onToggle={toggle}
          onApply={() => void apply()}
          onReject={() => void reject()}
          busy={busy}
          now={now}
          next={NEXT(projectId)}
          badge={badge}
          footerNote="Feedback a change answers is marked answered when you apply it."
        />
      )}
      {earlier.length > 0 && (
        <details className="card revise-earlier">
          <summary>Earlier revisions · {earlier.length}</summary>
          <ul>
            {earlier.map((r) => (
              <li key={r.id}>{revisionLine(r)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
```

`apps/web/src/workbench/ProjectPage.tsx`: in the `<ReviseTab … />` element replace `hasDraft={draft !== null}` with `draft={draft}`.

`apps/web/src/styles/stages.css` — add `.revise-see-head`, `.revise-failures`, `.revise-earlier` to the shared padding list and `.revise-see-head h3`, `.revise-failures h3` to the `font-weight: 600` list; append:

```css
.revise-tab {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}
.revise-see {
  overflow: hidden;
}
.revise-see-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  border-bottom: 1px solid var(--ih-border);
}
.revise-see-text {
  min-width: 0;
  flex: 1 1 320px;
}
.revise-see-text p {
  margin: 4px 0 0;
  overflow-wrap: anywhere;
}
.revise-split {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
}
.revise-split > * {
  min-width: 0;
}
.revise-failures {
  border-left: 1px solid var(--ih-border);
}
.failure-list {
  margin: 8px 0;
  padding: 0;
  list-style: none;
}
.failure-list li {
  display: grid;
  gap: 4px;
  padding: 8px 0;
  border-top: 1px solid var(--ih-border);
}
.failure-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.failure-head code {
  min-width: 0;
  overflow-wrap: anywhere;
}
.failure-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.failure-chips .diff-chip {
  overflow-wrap: anywhere;
}
.revise-not-sent {
  margin: 8px -16px -12px;
  padding: 8px 16px;
  background: var(--ih-skip-bg);
}
.revise-running {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--ih-radius-lg);
  background: var(--ih-info-bg);
  color: var(--ih-info-fg);
}
.answers-badge {
  font-size: var(--ih-text-sm);
  white-space: nowrap;
}
.answer-num {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--ih-info-bg);
  color: var(--ih-info-fg);
}
@media (max-width: 760px) {
  .revise-split {
    grid-template-columns: minmax(0, 1fr);
  }
  .revise-failures {
    border-left: 0;
    border-top: 1px solid var(--ih-border);
  }
}
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web` (StagePanel, OverviewMap, ProjectRail tests still green: `StagePanel` keeps its `revise` entries because `ChangeStage` includes it); `npm run typecheck`; `npx eslint apps/web`; `npx prettier --write apps/web/src/workbench/ReviseTab.tsx apps/web/src/workbench/StagePanel.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/test/ReviseTab.test.tsx apps/web/test/ProjectPage.test.tsx apps/web/src/styles/stages.css`. Then check the tab in the browser at 1440 px and 375 px wide (dev stack, a project with feedback, a dev run and a holdout run): no horizontal scroll, ids and file names wrap, the split stacks below 760 px.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/ReviseTab.tsx apps/web/src/workbench/StagePanel.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/test/ReviseTab.test.tsx apps/web/test/ProjectPage.test.tsx apps/web/src/styles/stages.css
git commit -m "Workbench web: Revise tab redesign (preview, feedback, failures, answers, earlier revisions)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs and the full check

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Docs** — in `CLAUDE.md`:

1. Contract table, row "Drafting changes (typed changes, apply, stage states, `revise`)": append to the TS cell "; `DraftChange.answers` (revise only; `parseChangeBody` refuses it elsewhere) and `answeredFeedback` (RV2)", and to the Python cell "; `REVISE_SCHEMA` `answers` (plain string array, `[]` = none), `draft_stages.resolve_answers` (prompt labels `F1…Fn` → feedback ids). Shared fixture `draft-changes.json` carries an `answers` case".
2. Contract table, row "Data policy and drafting": append to the TS cell "; `MAX_CONTEXT_SAMPLES`, `revisionFailures`, `RevisePreviewSchema`, `RevisionFeedbackSchema`, `FailureDiffSchema` (RV1)" and to the Python cell "; `drafting.MAX_CONTEXT_SAMPLES`, `drafting.select_failures` (shared fixture `packages/shared/test/fixtures/revise-failures.json`)".
3. In the **Workbench** bullet, in the "Feedback and revise (phase 4c)" sentences: after "…and `feedbackIds` (only the items actually sent)." add: "Each `params.feedback` item carries its `id`, and the API trims `failures` with `revisionFailures` (dev files, lowest score first, at most `MAX_CONTEXT_SAMPLES`), the same rule as the worker's `select_failures`, which is then a no-op. `GET /api/workbench/projects/:id/stages/revise/preview` (handoff RV1, `RevisePreview`) returns exactly what the next revision sends (feedback, failures with `failuresTotal` and `failuresFrom`, the drafting model setting, the open draft, the dev sample files sent, the limits) and `notSent` (ready holdout samples, the newest holdout run). The prompt labels feedback `F1…Fn`; each revise change's `answers` names the labels it answers, and `draft_stages.resolve_answers` stores them as feedback ids (`DraftChange.answers`, unknown labels dropped)." Replace "Accepting a revise proposal, fully or partly, resolves its feedback." with "Accepting a revise proposal, fully or partly, resolves the feedback its applied changes answer (`answeredFeedback`), or all the feedback it was sent when no change names any (proposals from before RV2)." Replace "The revise model schema has no union (nullable) types: payload objects are always present with empty sentinels (`""`, `[]`, `0`) that are mapped back to absent," with "The revise model schema has no union (nullable) types: payload objects and `answers` are always present with empty sentinels (`""`, `[]`, `0`) that are mapped back to absent,".
4. At the end of the **UI** bullet's Workbench sentence, append: " Revise (`ReviseTab`, `ReviseFeedback`, helpers in `workbench/revise.ts`) follows handoff §9: a warn banner when another drafting stage has a proposal waiting, the *What the model will see* card from the RV1 preview (your numbered feedback with the add form's ids filled from the draft and never a sample or run; the latest dev run's failures worst first with diff chips; the violet *Not sent* note), the running strip, the proposal card with *Answers* badges (`ProposalCard` `badge`/`footerNote`), ANSWERED feedback and *Evaluate on dev* after Apply, and Earlier revisions."

- [ ] **Step 2: Run** `npm run openapi` (no diff expected after Task 5; commit it if there is one), then `npm run check` → green (lint, typecheck, every TS project, `worker:lint`, `worker:test`). Then `npx prettier --check .`; fix only the reported files with `npx prettier --write <file>`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Docs: revise preview (RV1), answered feedback (RV2) and the Revise tab in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Never `git add -A`.)
