# Workbench tabs 3/8: Survey and Sections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Survey and Sections tabs (handoff §3, §5) and land the API they need: the stage's latest skip on `StageView` (SV1), how many samples each survey candidate was seen in plus an "In brief" check (SV2), a way to keep a stale stage without a new proposal (SC1), and one-click anchor fixes in the segmentation preview (SC2). Survey gets the "You skipped this stage on …" banner, a questions card (numbered, "Why it asks", answer textareas, *n of m answered* meter, *Save n answers to brief (vN+1)*), "What the model found" (model · brief version · age, summary, variant chips), the candidate table with *In brief*, the document anatomy column and an accept footer. Sections gets *Keep these anchors* on its stale banner, an anchors list (order, id, regex, hits badge *n/N*, Required, move/remove, where it lands in the selected sample), *Save to draft vN* when dirty, a grid with Found / Swallows > 60% / Missing (required) / Missing (optional) cells that select a sample and section, and a text panel with coloured "starts here" markers and the one-click fix.

**Architecture:** One forward-only migration, `0024_workbench_stage_confirms.sql` (0023 is `job_creator` from main). `stageStates` (pure, `packages/shared/src/drafting.ts`) gains a third input, the confirmations: a confirmation records `upTo`, the newest earlier-stage completion it acknowledges, and a stage is stale only when an earlier stage completed after `max(completedAt, upTo)`; `completedAt` and the state's kind (accepted or skipped) never change, so later stages are unaffected. `StageView.skippedAt` is the stage's newest `workbench_stage_skips` row. `POST /api/workbench/projects/:id/stages/:stage/confirm` (outputs, sections, steps; 409 unless stale) writes a confirmation through new `WorkbenchRepo.addConfirm`/`listConfirms` (Memory + Pg). Survey candidates gain an optional `seenIn: { n, of }` written by the model (worker `drafting.SURVEY_SCHEMA`, required there; `of` is overwritten with the number of samples actually sent and `n` clamped by `clamp_seen_in`); *In brief* is the pure shared `candidateInBrief(name, brief)`, derived when the tab renders. The worker's segment code adds `suggestions` (a new pure module `anchor_hints.py`, table-tested) to every grid; `SegmentationResultSchema.suggestions` defaults to `[]` so stored grids parse. The web adds `confirmStage`, pure helpers (`workbench/survey.ts`, additions to `workbench/segmentation.ts`), `StaleBanner` `keepLabel` + `skip` tone, *Keep* in `StagePanel`, and rewrites `SurveyTab`, `SectionsTab` and `SegmentationGrid`.

**Tech Stack:** React 19, Vitest + Testing Library, Zod (shared), Fastify + OpenAPI route docs, Postgres 17, Python 3.13 worker (pytest, mypy --strict, ruff), CSS on existing `--ih-*` tokens.

**Spec:** `docs/design/workbench-tabs/WORKBENCH-TABS-HANDOFF.md` §0 (rules shared by every tab), §3 Survey, §5 Sections, rows **SV1, SV2, SC1, SC2** of "New API"; screens `docs/design/workbench-tabs/screenshots/light/03-survey.png`, `states/03b-survey-answered.png`, `light/05-sections.png`, `states/05b-sections-anchor-fix.png` (dark variants in `screenshots/dark/`).

## Global Constraints

- **Card CSS gotcha:** `.card` has **no padding**. Every new card class in this plan (`.survey-questions`, `.survey-found`, `.survey-candidates`, `.survey-anatomy`, `.survey-decision`, `.anchors-card`, `.grid-card`, `.section-text`) adds its own `padding: 12px 16px`, and its `h3` gets `font-weight: 600` (the rule block at the end of `apps/web/src/styles/stages.css` from PR 2 is extended, not duplicated). Check in a browser at 1440 px and 390 px, both themes.
- **Migration 0024 only** (`db/migrations/0024_workbench_stage_confirms.sql`); never edit 0001–0023. The table cascades from `workbench_projects` and `deleteProject` also deletes it explicitly (children first, like skips).
- **Confirm semantics (SC1):** `POST …/stages/:stage/confirm` accepts `outputs`, `sections`, `steps` (`KEEPABLE_STAGES`; survey is first and can never be stale; references/revise are not proposal stages) → 400 `stage {stage} cannot be kept` otherwise; 404 `project not found`; 409 `stage {stage} is not stale` unless `stagesOf` says `stale`; 201 with every stage (`allStages`, as skip). It records `upTo` = the newest `completedAt` of the earlier `STAGE_ORDER` stages **as read for the check**, so an earlier stage completing after that read (even in a race) makes the stage stale again. No proposal is created; the draft is untouched.
- **A kept stage keeps its kind:** a kept acceptance reads `accepted`, a kept skip reads `skipped` (never turned into a skip by the confirmation, never turned into an acceptance either). `completedAt` stays the content's time, so Steps/References do not go stale because Sections was kept.
- **SV1:** `StageView.skippedAt` = the newest skip of the stage, whatever happened after (kept after a later run and acceptance). `referencesStage` passes its `skippedAt` input through. `OverviewInputs.stages` narrows to `Pick<StageView, 'stage' | 'state' | 'completedAt'>` so overview fixtures need no change.
- **SV2:** model schema change on both sides in one task: `SURVEY_SCHEMA` candidates require `seenIn: {n: integer, of: integer}` (an object, **no union types**; the stage-schema union test stays at its limit of 16); TS `SurveyBodySchema` candidates take `seenIn` **optional** (`.strict()` object) so surveys stored before this PR, bundle `survey.json` files and the drafting `params.survey` still parse. *In brief* is not stored and not in any schema: `candidateInBrief` (shared, pure) over the current brief's `outputs`, `exampleOutput` and saved answers, so saving answers updates the column without refetching proposals.
- **SC2:** `suggestions: { section, sampleId, anchor, reason }[]` — only for **required** sections that miss a segmented sample (no row error) and whose anchor is valid; at most one per (section, sample); only for anchors simple enough to read (`^Label`, `^(A|B)\b`, optional `(?i)`, `\s*`, trailing `\b`/`:`); the suggested anchor is verified to match that sample before it is offered. Computed inside `segment_samples` (so inside the 10 s child process) and therefore also present in `anchorCheck` grids. TS: `.default([])`.
- **Holdout is sealed (§0.3):** nothing here sends text to a model; the grid shows holdout rows (regex only, local) tagged `HOLDOUT` with `SampleTag`.
- **Accessibility (§0.7):** grid cells are buttons with `aria-pressed`; hits badges and the answer meter are `role="img"` with the numbers in `aria-label`; status icons in the candidate table are decorative next to text ("Yes" / "Not yet"); the candidate table is a real table with `scope="col"`; move/remove are labelled icon buttons.
- **Polling (§0.8):** Survey polls only while its proposal is running (unchanged); Sections previews stay latest-wins with the 600 ms debounce (`PREVIEW_DEBOUNCE_MS`) and the existing 30 s deadline.
- **No `LIST_CACHE_VERSION` bump:** the list row's shape and derivation do not change; the new confirmations table joins the fingerprint, which moves every fingerprint once anyway.
- Tests first (red, then green); never call a real LLM; Pg integration only on a throwaway `postgres:17-alpine` container on port **55447** (`ih-test-pg-ct3`), removed afterwards; `npm run check` green at the end; never stage `config/llm-providers.yaml` (unrelated local edit); never `git add -A`; commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worker commands (Git Bash): `export PATH="$PATH:/c/Users/kenha/AppData/Roaming/Python/Python313/Scripts"; uv run --directory worker pytest …`.

## Review Focus

1. **`stageStates` with confirmations** (Task 1 table): a confirmation only lowers staleness for completions at or before its `upTo`; a later earlier-stage completion makes the stage stale again; downstream stages are untouched; kept skips stay `skipped`.
2. **Confirm route race** — `upTo` comes from the states read for the 409 check, never from `now()` (Task 5 test "goes stale again after a later change").
3. **Contract parity** — `SURVEY_SCHEMA`/`SurveyBodySchema` (`seenIn`), `segment_samples`/`SegmentationResultSchema` (`suggestions`), migration CHECK list = `KEEPABLE_STAGES`.
4. **Old data still parses** — a survey body without `seenIn` and a grid without `suggestions` (tests in Task 2 and 3, and the deliberate update of `workbench-segment.test.ts`).
5. **The anchor heuristic never offers a wrong fix** — unreadable anchors give no suggestion; the suggestion is re-checked against the sample; optional sections never get one (Task 3 tables).
6. **Existing web tests rewritten deliberately, not weakened** — Survey: "Accept" → "Accept survey", "Run survey again" → "Run again", "Save answers to brief" → "Save n answers to brief (vN+1)"; Sections: "Save to draft" → "Save to draft v2", the Preview button is gone (live preview) and the duplicate-id test asserts no preview is requested; Grid: copy follows the legend ("Missing (required)", "HOLDOUT").

---

### Task 1: Shared stage states — `skippedAt` (SV1) and confirmations (SC1 logic)

**Files:**
- Modify: `packages/shared/src/drafting.ts`, `packages/shared/src/overview.ts` (`OverviewInputs.stages` type only)
- Test: `packages/shared/test/drafting.test.ts`, `packages/shared/test/dto.test.ts`

**Interfaces:**
- Produces (from `@ih/shared`):
  - `StageViewSchema` gains `skippedAt: string | null`
  - `KEEPABLE_STAGES = ['outputs', 'sections', 'steps'] as const`, `type KeepableStage`
  - `interface StageConfirm { stage: DraftStage; confirmedAt: string; upTo: string }`
  - `stageStates(proposals, skips, confirms: readonly StageConfirm[] = []): StageView[]`
  - `referencesStage(...)` returns `skippedAt: input.skippedAt`
- Consumed by: repo (Task 4), routes (Task 5), web (Tasks 6–9).

- [ ] **Step 1: Write the failing tests** — in `packages/shared/test/drafting.test.ts`, inside `describe('stage states')` (it already has `t(n)` and `proposal(stage, status, createdAt, decidedAt)`):

```ts
  it('keeps the latest skip after a later run and acceptance (SV1)', () => {
    const states = stageStates(
      [proposal('survey', 'accepted', t(3), t(4))],
      [
        { stage: 'survey', skippedAt: t(2) },
        { stage: 'survey', skippedAt: t(1) },
      ],
    );
    expect(states[0]).toEqual({
      stage: 'survey',
      state: 'accepted',
      completedAt: t(4),
      skippedAt: t(2),
    });
    expect(states[1]).toEqual({
      stage: 'outputs',
      state: 'pending',
      completedAt: null,
      skippedAt: null,
    });
  });

  describe('confirmations (SC1)', () => {
    const base = [
      proposal('survey', 'accepted', t(1), t(1)),
      proposal('outputs', 'accepted', t(2), t(2)),
      proposal('sections', 'accepted', t(3), t(3)),
      proposal('outputs', 'accepted', t(4), t(4)), // outputs changed after sections
      proposal('steps', 'accepted', t(5), t(5)),
    ];
    const keep = { stage: 'sections' as const, confirmedAt: t(6), upTo: t(4) };

    it.each<[string, Parameters<typeof stageStates>[2], string[]]>([
      ['without a confirmation sections is stale', [], ['accepted', 'accepted', 'stale', 'accepted']],
      ['a confirmation covering the change clears it', [keep], ['accepted', 'accepted', 'accepted', 'accepted']],
      [
        'a confirmation older than the change does not',
        [{ ...keep, upTo: t(3) }],
        ['accepted', 'accepted', 'stale', 'accepted'],
      ],
      [
        "another stage's confirmation does not",
        [{ ...keep, stage: 'steps' }],
        ['accepted', 'accepted', 'stale', 'accepted'],
      ],
    ])('%s', (_name, confirms, expected) => {
      expect(stageStates(base, [], confirms).map((s) => s.state)).toEqual(expected);
    });

    it('never moves completedAt, so later stages do not go stale', () => {
      const kept = stageStates(base, [], [keep]);
      expect(kept[2]).toEqual({
        stage: 'sections',
        state: 'accepted',
        completedAt: t(3),
        skippedAt: null,
      });
      expect(kept[3]).toMatchObject({ stage: 'steps', state: 'accepted', completedAt: t(5) });
    });

    it('goes stale again when an earlier stage completes after it', () => {
      const later = stageStates([...base, proposal('survey', 'accepted', t(7), t(7))], [], [keep]);
      expect(later.map((s) => s.state)).toEqual(['accepted', 'stale', 'stale', 'stale']);
    });

    it('a kept skip stays a skip', () => {
      const states = stageStates(
        [proposal('survey', 'accepted', t(1), t(1)), proposal('survey', 'accepted', t(3), t(3))],
        [{ stage: 'outputs', skippedAt: t(2) }],
        [{ stage: 'outputs', confirmedAt: t(4), upTo: t(3) }],
      );
      expect(states[1]).toEqual({
        stage: 'outputs',
        state: 'skipped',
        completedAt: t(2),
        skippedAt: t(2),
      });
    });
  });
```

In `describe('references stage')`: the `done` helper returns `{ stage, state: 'accepted', completedAt: at, skippedAt: null }`; the inline `{ stage: 'steps', state: 'pending', completedAt: null }` gains `skippedAt: null`; the three `toEqual` expectations gain `skippedAt: null`, `skippedAt: null` and `skippedAt: '2026-10-12T10:00:06.000Z'` (the "can be skipped" case).

`packages/shared/test/dto.test.ts`, the `StageView` row becomes:

```ts
  [
    'StageView',
    StageViewSchema,
    { stage: 'survey', state: 'accepted', completedAt: at, skippedAt: null },
    'skippedAt',
  ],
```

- [ ] **Step 2: Run** `npx vitest run --project shared packages/shared/test/drafting.test.ts packages/shared/test/dto.test.ts` → FAIL (`skippedAt` missing; confirmations ignored).

- [ ] **Step 3: Implement** — `packages/shared/src/drafting.ts`:

```ts
export const StageViewSchema = z.object({
  stage: z.enum(DRAFT_STAGES),
  state: StageStateSchema,
  /** Last time the stage was accepted (fully or partly) or skipped; null if never. */
  completedAt: z.string().nullable(),
  /** The stage's newest skip, kept after later runs and acceptances (handoff SV1); null if never. */
  skippedAt: z.string().nullable(),
});
export type StageView = z.infer<typeof StageViewSchema>;

export interface StageSkip {
  stage: DraftStage;
  skippedAt: string;
}

/** Stages whose stale state can be cleared without a new proposal (handoff SC1, migration 0024). */
export const KEEPABLE_STAGES = ['outputs', 'sections', 'steps'] as const;
export type KeepableStage = (typeof KEEPABLE_STAGES)[number];

/**
 * "Keep" on a stale stage (handoff SC1): the stage's content is confirmed against the earlier
 * stages' completions up to `upTo`. It is not stale for those; a later one makes it stale again.
 * It never changes `completedAt`, so the stages after it are unaffected.
 */
export interface StageConfirm {
  stage: DraftStage;
  confirmedAt: string;
  upTo: string;
}

const newest = (times: string[]) => times.sort().at(-1) ?? null;
```

In `stageStates` (signature `stageStates(proposals: ProposalLike[], skips: StageSkip[], confirms: readonly StageConfirm[] = [])`; update the JSDoc: "…stale when an earlier stage completed after it and after the newest confirmation of it…"), replace the `stale` and `return` lines with:

```ts
    const keptUpTo = newest(confirms.filter((c) => c.stage === stage).map((c) => c.upTo));
    const since =
      done === null ? null : keptUpTo !== null && keptUpTo > done.at ? keptUpTo : done.at;
    const stale =
      since !== null && completions.slice(0, i).some((c) => c !== null && c.at > since);
    // … `state` exactly as before …
    const skippedAt = newest(skips.filter((s) => s.stage === stage).map((s) => s.skippedAt));
    return { stage, state, completedAt: done?.at ?? null, skippedAt };
```

In `referencesStage`, `return { stage: 'references', state, completedAt, skippedAt: input.skippedAt };`.

`packages/shared/src/overview.ts`, `OverviewInputs`:

```ts
  /** Survey, outputs, sections, steps and references, as `GET /stages` returns them. */
  stages: readonly Pick<StageView, 'stage' | 'state' | 'completedAt'>[];
```

(`staleCauseLabel(stages: OverviewInputs['stages'], …)` keeps compiling; `allStages` still passes full `StageView`s.)

- [ ] **Step 4: Run** `npx vitest run --project shared` → PASS; `npm run typecheck` (the API's `stagesOf` still compiles: `confirms` defaults to `[]`); `npx eslint packages/shared`; `npx prettier --write packages/shared/src/drafting.ts packages/shared/src/overview.ts packages/shared/test/drafting.test.ts packages/shared/test/dto.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/drafting.ts packages/shared/src/overview.ts packages/shared/test/drafting.test.ts packages/shared/test/dto.test.ts
git commit -m "Shared: StageView.skippedAt and stage confirmations in stageStates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Survey candidates — `seenIn` on both sides, `candidateInBrief` (SV2)

**Files:**
- Modify: `packages/shared/src/workbench.ts` (`SurveyBodySchema`), `packages/shared/src/index.ts`
- Create: `packages/shared/src/survey.ts`, `packages/shared/test/survey.test.ts`
- Modify: `packages/shared/test/workbench.test.ts`
- Modify: `worker/src/ingest_worker/drafting.py` (`SURVEY_SCHEMA`, `SURVEY` instructions, `clamp_seen_in`, `run_draft`)
- Test: `worker/tests/test_drafting.py`, `worker/tests/test_draft_stages.py`

**Interfaces:**
- Produces: `SeenInSchema` / `SeenIn = { n: number; of: number }`; survey candidates' optional `seenIn`; `candidateInBrief(name: string, brief: BriefBody | null): boolean`; Python `drafting.clamp_seen_in(body: dict[str, Any], samples: int) -> dict[str, Any]`.
- Consumed by: `SurveyTab` (Task 8).

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/survey.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_BRIEF, candidateInBrief, type BriefBody } from '../src/index.js';

const brief = (o: Partial<BriefBody>): BriefBody => ({ ...EMPTY_BRIEF, ...o });

describe('candidateInBrief', () => {
  it.each<[string, string, BriefBody | null, boolean]>([
    ['a snake_case name in the outputs prose', 'due_date', brief({ outputs: 'Due date (DMY), total' }), true],
    [
      'a CSV header of the example output',
      'invoice_number',
      brief({ exampleOutput: 'invoice_number,total\nINV-1,10' }),
      true,
    ],
    ['a camelCase name', 'poNumber', brief({ outputs: 'The PO number, if printed' }), true],
    [
      'a saved survey answer',
      'supplier_vat_number',
      brief({ answers: [{ question: 'VAT?', answer: 'Yes, capture the supplier VAT number' }] }),
      true,
    ],
    ['only part of the name', 'discount_percent', brief({ outputs: 'discount amount' }), false],
    ['inside another word', 'vat', brief({ outputs: 'private notes' }), false],
    ['only in purpose or glossary', 'total', brief({ purpose: 'total', glossary: 'total' }), false],
    ['no brief yet', 'total', null, false],
    ['a name without letters or digits', '__', brief({ outputs: 'anything' }), false],
  ])('%s', (_name, name, b, expected) => {
    expect(candidateInBrief(name, b)).toBe(expected);
  });
});
```

`packages/shared/test/workbench.test.ts`, after the existing survey parse test:

```ts
  it('reads seenIn on a candidate, and surveys written before it', () => {
    const candidate = { name: 'vat', description: 'VAT', where: 'totals', kind: 'field' as const };
    const body = { summary: 's', structure: [], variants: [], candidates: [candidate], questions: [] };
    expect(SurveyBodySchema.parse(body)).toEqual(body);
    const seen = { ...body, candidates: [{ ...candidate, seenIn: { n: 3, of: 6 } }] };
    expect(SurveyBodySchema.parse(seen)).toEqual(seen);
    const extra = { ...body, candidates: [{ ...candidate, seenIn: { n: 3, of: 6, x: 1 } }] };
    expect(SurveyBodySchema.safeParse(extra).success).toBe(false);
  });
```

`worker/tests/test_drafting.py`: import `clamp_seen_in` from `ingest_worker.drafting` and `SURVEY_SCHEMA`; `SURVEY_BODY`'s candidate gains `"seenIn": {"n": 1, "of": 1}` (one sample is sent by `draft_job()`, so the existing equality test still holds); add:

```python
def test_survey_schema_asks_for_seen_in_on_every_candidate() -> None:
    item = SURVEY_SCHEMA["properties"]["candidates"]["items"]
    assert "seenIn" in item["required"]
    assert item["properties"]["seenIn"]["required"] == ["n", "of"]
    assert "In how many" in SURVEY.instructions


@pytest.mark.parametrize(
    ("seen", "samples", "expected"),
    [
        ({"n": 2, "of": 3}, 3, {"n": 2, "of": 3}),
        ({"n": 9, "of": 12}, 4, {"n": 4, "of": 4}),  # `of` is what was sent, n within it
        ({"n": -1, "of": 2}, 2, {"n": 0, "of": 2}),
        ({"n": 1, "of": 0}, 0, {"n": 0, "of": 0}),
    ],
)
def test_clamp_seen_in(seen: dict[str, int], samples: int, expected: dict[str, int]) -> None:
    body = {**SURVEY_BODY, "candidates": [{**SURVEY_BODY["candidates"][0], "seenIn": seen}]}
    assert clamp_seen_in(body, samples)["candidates"][0]["seenIn"] == expected
    assert body["candidates"][0]["seenIn"] == seen  # not mutated


def test_survey_job_stores_seen_in_against_the_samples_sent(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    candidate = {**SURVEY_BODY["candidates"][0], "seenIn": {"n": 5, "of": 6}}
    provider.responses = [{**SURVEY_BODY, "candidates": [candidate]}]
    queue = FakeQueue(jobs=[draft_job()])

    run_once(queue, deps, "w1")

    result = json.loads(store.get("runs", drafting_key("letter", "job-d")))
    assert result["body"]["candidates"][0]["seenIn"] == {"n": 1, "of": 1}
```

(`SURVEY_SCHEMA` keeps its row `(SURVEY_SCHEMA, 16)` in `test_schemas_stay_under_the_anthropic_union_type_limit`; `seenIn` adds no union, so that test passes unchanged and guards it.)

- [ ] **Step 2: Run** `npx vitest run --project shared packages/shared/test/survey.test.ts packages/shared/test/workbench.test.ts` → FAIL (`candidateInBrief` not exported; `seenIn` rejected by `.strict()`). `export PATH="$PATH:/c/Users/kenha/AppData/Roaming/Python/Python313/Scripts"; uv run --directory worker pytest tests/test_drafting.py tests/test_draft_stages.py` → FAIL (`clamp_seen_in` cannot be imported).

- [ ] **Step 3: Implement**

`packages/shared/src/workbench.ts`, above `SurveyBodySchema`:

```ts
/** In how many of the samples the model was shown it saw a candidate (handoff SV2). */
export const SeenInSchema = z
  .object({ n: z.number().int().nonnegative(), of: z.number().int().nonnegative() })
  .strict();
export type SeenIn = z.infer<typeof SeenInSchema>;
```

and in the candidate object, after `kind`:

```ts
          /** Written by the model since SV2; surveys stored before it have none. */
          seenIn: SeenInSchema.optional(),
```

`packages/shared/src/survey.ts`:

```ts
import type { BriefBody } from './workbench.js';

const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Whether the brief already asks for a survey candidate (handoff SV2, "In brief"): the words of
 * its name (snake_case, camelCase or spaced) appear together, as whole words, in the brief's
 * outputs wanted, example output or saved survey answers. Derived when shown, never stored: the
 * brief changes after the survey (saving answers makes a new version).
 */
export function candidateInBrief(name: string, brief: BriefBody | null): boolean {
  const wanted = words(name);
  if (!brief || !wanted.length) return false;
  const text = [brief.outputs, brief.exampleOutput, ...brief.answers.map((a) => a.answer)].join(
    '\n',
  );
  return ` ${words(text).join(' ')} `.includes(` ${wanted.join(' ')} `);
}
```

`packages/shared/src/index.ts`: `export * from './survey.js';`.

`worker/src/ingest_worker/drafting.py` — the `SURVEY_SCHEMA` candidate item gains (after `kind`):

```python
                    "seenIn": _object({"n": {"type": "integer"}, "of": {"type": "integer"}}),
```

(update the comment above `SURVEY_SCHEMA`: "Mirrors packages/shared/src/workbench.ts SurveyBodySchema (seenIn is optional there: older surveys have none).") The `SURVEY` instructions' candidates bullet becomes:

```
- candidates: data worth extracting, guided by the brief: name (lowercase_snake_case), what it
  is, where it is found, kind = field (one value per document) or table (repeating rows), and
  seenIn: In how many of the samples shown here you saw it (n), of how many samples (of).
```

Add below `SURVEY`:

```python
def clamp_seen_in(body: dict[str, Any], samples: int) -> dict[str, Any]:
    """`of` is the number of samples the model was shown, whatever it wrote; `n` stays within
    0..of. Returns a new body (TS: SeenInSchema)."""
    candidates = [
        {**c, "seenIn": {"n": max(0, min(int(c["seenIn"]["n"]), samples)), "of": samples}}
        for c in body["candidates"]
    ]
    return {**body, "candidates": candidates}
```

In `run_draft`, right after `result, body = propose(prompt, f"draft-{stage.id}")`:

```python
    if stage.id == "survey":
        body = clamp_seen_in(body, len(samples))
```

(the following `if stage.id == "sections":` stays as it is.)

- [ ] **Step 4: Run** both commands of Step 2 → PASS; then `npm run worker:lint` and `npm run worker:test`; `npx vitest run --project shared`; `npx eslint packages/shared`; prettier on the changed TS files.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/workbench.ts packages/shared/src/survey.ts packages/shared/src/index.ts packages/shared/test/survey.test.ts packages/shared/test/workbench.test.ts worker/src/ingest_worker/drafting.py worker/tests/test_drafting.py
git commit -m "Survey candidates: seenIn from the model, clamped to the samples sent; candidateInBrief

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Worker anchor suggestions and `SegmentationResult.suggestions` (SC2)

**Files:**
- Create: `worker/src/ingest_worker/anchor_hints.py`, `worker/tests/test_anchor_hints.py`
- Modify: `worker/src/ingest_worker/workbench.py` (`segment_samples`)
- Test: `worker/tests/test_workbench_segment.py`
- Modify: `packages/shared/src/workbench.ts`, `packages/shared/test/workbench.test.ts`
- Modify (fixtures the typecheck flags): `apps/api/test/workbench-segment.test.ts`, `apps/web/test/SectionsTab.test.tsx`, `apps/web/test/StagePanel.test.tsx`, `apps/web/test/segmentation.test.ts`, `apps/web/test/useSegmentPreview.test.tsx`, `apps/web/test/SegmentationGrid.test.tsx`
- Modify: `apps/api/src/routes/workbench.ts` (`getSegmentation` description)
- Regenerate: `docs/openapi.json`

**Interfaces:**
- Produces (Python): `anchor_hints.LABEL_VARIANTS`, `anchor_labels(anchor) -> tuple[bool, bool, list[str]] | None` (case-insensitive, indented, labels), `suggest_anchor(anchor, text) -> tuple[str, str] | None` (anchor, reason); `segment_samples` returns `{"anchorErrors", "samples", "suggestions"}`.
- Produces (TS): `AnchorSuggestionSchema` / `AnchorSuggestion = { section; sampleId; anchor; reason }`; `SegmentationResultSchema.suggestions` (default `[]`).
- Consumed by: `SectionsTab` (Task 9) through `suggestionFor` (Task 6).

- [ ] **Step 1: Write the failing tests** — `worker/tests/test_anchor_hints.py`:

```python
"""Anchor fixes for required sections that miss a sample (handoff SC2)."""

from __future__ import annotations

import pytest

from ingest_worker.anchor_hints import LABEL_VARIANTS, anchor_labels, suggest_anchor

REASON = '; no alternative of the anchor matches that.'


@pytest.mark.parametrize(
    ("anchor", "expected"),
    [
        (r"^(From|Supplier)\b", (False, False, ["From", "Supplier"])),
        (r"^Description\s+Qty", (False, False, ["Description Qty"])),
        (r"(?i)^\s*(?:Sub total|Subtotal):", (True, True, ["Sub total", "Subtotal"])),
        (r"^Invoice No\.", (False, False, ["Invoice No."])),
        (r"^(TAX )?INVOICE", None),
        (r"^Payment (terms|details)", None),
        (r"^\d+\.0 PURPOSE", None),
        (r"\A", None),
    ],
)
def test_anchor_labels(anchor: str, expected: tuple[bool, bool, list[str]] | None) -> None:
    assert anchor_labels(anchor) == expected


@pytest.mark.parametrize(
    ("name", "anchor", "text", "expected"),
    [
        (
            "a synonym",
            r"^(From|Supplier)\b",
            "GLOBEX CORPORATION\nVendor: Globex Corporation\n",
            (r"^(From|Supplier|Vendor)\b", 'This sample labels it "Vendor:"' + REASON),
        ),
        (
            "another case",
            r"^Supplier\b",
            "SUPPLIER: Acme Ltd\n",
            (r"^(Supplier|SUPPLIER)\b", 'This sample labels it "SUPPLIER:"' + REASON),
        ),
        (
            "an indented label",
            r"^Total\b",
            "Sub total 10.00\n   Total  12.00\n",
            (r"^\s*Total\b", 'This sample labels it "Total"' + REASON),
        ),
        (
            "a two-word synonym",
            r"^Payment terms",
            "Remit to: Bank of Example\n",
            (r"^(Payment\s+terms|Remit\s+to)\b", 'This sample labels it "Remit to:"' + REASON),
        ),
        (
            "a case-insensitive anchor keeps its flag",
            r"(?i)^vendor\b",
            "  Vendor: Globex\n",
            (r"(?i)^\s*vendor\b", 'This sample labels it "Vendor:"' + REASON),
        ),
        ("an anchor too clever to rewrite", r"^(TAX )?INVOICE", "Invoice\n", None),
        ("no variant in the text", r"^Supplier\b", "Nothing like it here\n", None),
        ("a label only mid-line", r"^Supplier\b", "Bill to: X   Supplier: Y\n", None),
    ],
)
def test_suggest_anchor(
    name: str, anchor: str, text: str, expected: tuple[str, str] | None
) -> None:
    assert suggest_anchor(anchor, text) == expected


def test_label_variants_are_lower_case_single_spaced_and_unique() -> None:
    seen: set[str] = set()
    for group in LABEL_VARIANTS:
        for label in group:
            assert label == " ".join(label.lower().split())
            assert label not in seen, label
            seen.add(label)
```

In `worker/tests/test_workbench_segment.py`:

```python
def test_a_required_section_that_misses_gets_a_label_variant_suggestion() -> None:
    document = SegmentDocument.model_validate(
        {
            "sections": [
                {"id": "header", "anchor": r"^TAX INVOICE"},
                {"id": "supplier", "anchor": r"^(From|Supplier)\b"},
                {"id": "notes", "anchor": r"^Notes\b", "required": False},
            ]
        }
    )
    acme = ["TAX INVOICE\nSupplier: Acme Ltd\n"]
    globex = ["TAX INVOICE\nVendor: Globex Corporation\nNOTES: none\n"]
    result = segment_samples([("acme", acme), ("globex", globex), ("blank", None)], document)
    assert result["suggestions"] == [
        {
            "section": "supplier",
            "sampleId": "globex",
            "anchor": r"^(From|Supplier|Vendor)\b",
            "reason": 'This sample labels it "Vendor:"; no alternative of the anchor matches that.',
        }
    ]


def test_a_grid_without_misses_has_no_suggestions() -> None:
    assert segment_samples([("s1", PAGES)], doc())["suggestions"] == []
```

`packages/shared/test/workbench.test.ts` (import `SegmentationResultSchema`):

```ts
  it('reads a grid written before suggestions as having none, and keeps suggestions', () => {
    const grid = { anchorErrors: {}, samples: [] };
    expect(SegmentationResultSchema.parse(grid)).toEqual({ ...grid, suggestions: [] });
    const suggestion = {
      section: 'supplier',
      sampleId: 's1',
      anchor: '^(From|Supplier|Vendor)\\b',
      reason: 'This sample labels it "Vendor:"; no alternative of the anchor matches that.',
    };
    expect(SegmentationResultSchema.parse({ ...grid, suggestions: [suggestion] })).toEqual({
      ...grid,
      suggestions: [suggestion],
    });
  });
```

`apps/api/test/workbench-segment.test.ts`, "returns the grid once the worker has written it": the expected `result` becomes `{ ...grid, suggestions: [] }` with the comment `// a grid written before SC2 reads with no suggestions` (deliberate: the API now normalises through the schema default).

- [ ] **Step 2: Run** `uv run --directory worker pytest tests/test_anchor_hints.py tests/test_workbench_segment.py` (with the PATH export) → FAIL (module missing; no `suggestions` key). `npx vitest run --project shared packages/shared/test/workbench.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `worker/src/ingest_worker/anchor_hints.py`:

```python
"""Anchor fixes for the Sections tab (handoff SC2).

When a required section's anchor misses a sample, the sample often names the same part another
way: a synonym ("Vendor" for "Supplier"), another case ("SUPPLIER"), or an indented label. For
anchors simple enough to read (`^Label`, `^(A|B)\\b`, optionally `(?i)` and `\\s*`), look for such
a label at the start of a line and propose the anchor with it added. No suggestion is better than
a wrong one: anything cleverer is left alone, and a suggestion is only returned if it matches.
Pure; runs inside the preview's time-capped child process with the grid (workbench.py)."""

from __future__ import annotations

import re

#: Labels that name the same part of a business document (lower case, single spaces).
LABEL_VARIANTS: tuple[frozenset[str], ...] = (
    frozenset({"supplier", "vendor", "seller", "from", "sold by", "issued by"}),
    frozenset({"customer", "client", "buyer", "bill to", "sold to", "invoice to"}),
    frozenset({"ship to", "deliver to", "delivery address"}),
    frozenset({"invoice", "tax invoice", "bill"}),
    frozenset({"invoice no", "invoice number", "inv no"}),
    frozenset({"date", "dated", "invoice date", "issue date"}),
    frozenset({"due date", "payment due", "pay by"}),
    frozenset({"total", "grand total", "total due", "amount due", "balance due"}),
    frozenset({"sub total", "subtotal", "net total"}),
    frozenset({"payment", "payment terms", "terms", "remit to", "bank details"}),
    frozenset({"description", "item", "items", "details"}),
    frozenset({"reference", "ref", "your ref", "our ref", "po", "purchase order"}),
)

_HEAD = re.compile(r"(\(\?i\))?\^(\\s\*)?")
_TAIL = re.compile(r"(?:\\b|:)$")
_GROUP = re.compile(r"\((?:\?:)?([^()]*)\)")
_SPACE = re.compile(r"\\s[+*]?|\\ ")
_ESCAPED = re.compile(r"\\([#&'./-])")
_PLAIN = re.compile(r"[A-Za-z0-9 #&'./-]+")


def anchor_labels(anchor: str) -> tuple[bool, bool, list[str]] | None:
    """(case-insensitive, indented, labels) of an anchor shaped like `^Label`, `^(A|B)\\b` or
    `(?i)^\\s*(?:A|B):`; None for any other regex."""
    head = _HEAD.match(anchor)
    if head is None:
        return None
    body = _TAIL.sub("", anchor[head.end() :])
    group = _GROUP.fullmatch(body)
    alternatives = group.group(1).split("|") if group else [body]
    labels: list[str] = []
    for alternative in alternatives:
        text = _ESCAPED.sub(r"\1", _SPACE.sub(" ", alternative))
        if "\\" in text or not text.strip() or not _PLAIN.fullmatch(text):
            return None
        labels.append(" ".join(text.split()))
    return head.group(1) is not None, head.group(2) is not None, labels


def _pattern(label: str) -> str:
    return r"\s+".join(re.escape(word) for word in label.split())


def suggest_anchor(anchor: str, text: str) -> tuple[str, str] | None:
    """(new anchor, reason) when `text` starts a line with another way of writing the anchor's
    label; None otherwise."""
    parsed = anchor_labels(anchor)
    if parsed is None:
        return None
    insensitive, indented, labels = parsed
    known = {label.lower() for label in labels}
    synonyms = sorted({v for group in LABEL_VARIANTS if known & group for v in group} - known)
    for label in [*labels, *synonyms]:
        found = re.search(
            rf"^([ \t]*)({_pattern(label)})\b", text, re.MULTILINE | re.IGNORECASE
        )
        if found is None:
            continue
        written = " ".join(found.group(2).split())
        same = written in labels or (insensitive and written.lower() in known)
        alternatives = labels if same else [*labels, written]
        parts = [_pattern(a) for a in alternatives]
        group = parts[0] if len(parts) == 1 else "(" + "|".join(parts) + ")"
        prefix = ("(?i)" if insensitive else "") + "^"
        if indented or found.group(1):
            prefix += r"\s*"
        suggestion = prefix + group + r"\b"
        if suggestion == anchor or re.search(suggestion, text, re.MULTILINE) is None:
            continue
        end = found.end(2)
        shown = text[found.start(2) : end + (1 if text[end : end + 1] == ":" else 0)]
        return suggestion, f'This sample labels it "{shown}"; no alternative of the anchor matches that.'
    return None
```

`worker/src/ingest_worker/workbench.py` — import `from .anchor_hints import suggest_anchor`; in `segment_samples` declare `suggestions: list[dict[str, Any]] = []` before the loop, and after `rows.append({... "sections": cells})` for a segmented row:

```python
        for section in valid:
            if section.required and section.id in unmatched:
                hint = suggest_anchor(section.anchor, text)
                if hint is not None:
                    suggestions.append(
                        {
                            "section": section.id,
                            "sampleId": sample_id,
                            "anchor": hint[0],
                            "reason": hint[1],
                        }
                    )
    return {"anchorErrors": anchor_errors, "samples": rows, "suggestions": suggestions}
```

Update the docstring: "…plus `suggestions` (anchor_hints) for required sections that miss a sample."

`packages/shared/src/workbench.ts`, above `SegmentationResultSchema`:

```ts
/** A one-click fix for a required section that missed a sample (worker anchor_hints, SC2). */
export const AnchorSuggestionSchema = z.object({
  section: z.string(),
  sampleId: z.string(),
  /** The anchor with the sample's way of writing the label added; it matches that sample. */
  anchor: z.string(),
  reason: z.string(),
});
export type AnchorSuggestion = z.infer<typeof AnchorSuggestionSchema>;
```

and in `SegmentationResultSchema` after `samples`:

```ts
  /** Required sections that missed a sample, with an anchor that finds it; none before SC2. */
  suggestions: z.array(AnchorSuggestionSchema).default([]),
```

`apps/api/src/routes/workbench.ts`, `getSegmentation` description: append "\`suggestions\` lists, for required sections that missed a sample, an anchor that would find it (the sample writes the label another way: a synonym, another case, an indent) and why."

Run `npm run typecheck` and add `suggestions: []` to every `SegmentationResult` fixture it reports (the grid in `SectionsTab.test.tsx`, `result` in `SegmentationGrid.test.tsx`, the `anchorCheck` in `StagePanel.test.tsx`, `result` objects in `segmentation.test.ts`, `grid` in `useSegmentPreview.test.tsx`).

- [ ] **Step 4: Run** the Step 2 commands → PASS; `npm run worker:lint`; `npm run worker:test`; `npm run openapi`; `npx vitest run --project shared --project api --project web` → PASS; `npm run typecheck`; eslint; prettier on the changed TS files.

- [ ] **Step 5: Commit**

```bash
git add worker/src/ingest_worker/anchor_hints.py worker/src/ingest_worker/workbench.py worker/tests/test_anchor_hints.py worker/tests/test_workbench_segment.py packages/shared/src/workbench.ts packages/shared/test/workbench.test.ts apps/api/src/routes/workbench.ts apps/api/test/workbench-segment.test.ts apps/web/test/SectionsTab.test.tsx apps/web/test/StagePanel.test.tsx apps/web/test/segmentation.test.ts apps/web/test/useSegmentPreview.test.tsx apps/web/test/SegmentationGrid.test.tsx docs/openapi.json
git commit -m "Segmentation preview: label-variant anchor suggestions for required sections that miss

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Migration 0024 and the confirmations port (Memory + Pg)

**Files:**
- Create: `db/migrations/0024_workbench_stage_confirms.sql`
- Modify: `apps/api/src/workbench/repo.ts` (interface, `MemoryWorkbenchRepo`, `PgWorkbenchRepo`, `FINGERPRINT_SQL`, both `deleteProject`s, Memory `projectFingerprints`)
- Test: `apps/api/test/workbench-stages-repo.test.ts`, `apps/api/test/workbench-list-repo.test.ts`, `apps/api/test/workbench-delete.test.ts`, `apps/api/test/integration/workbench-pg.test.ts`

**Interfaces:**
- Produces: `type StageConfirmRecord = StageConfirm & { projectId: string }`; `WorkbenchRepo.addConfirm(projectId: string, stage: KeepableStage, upTo: string): Promise<StageConfirmRecord>`; `WorkbenchRepo.listConfirms(projectId: string): Promise<StageConfirmRecord[]>` (newest first).
- Consumed by: `stagesOf` and the confirm route (Task 5).

- [ ] **Step 1: Write the failing tests** — `apps/api/test/workbench-stages-repo.test.ts`:

```ts
  it('records confirmations newest first', async () => {
    const { workbench } = await setup();
    const a = await workbench.addConfirm('letter', 'sections', '2026-10-13T09:00:00.000Z');
    const b = await workbench.addConfirm('letter', 'outputs', '2026-10-13T09:30:00.000Z');
    expect(a).toMatchObject({ projectId: 'letter', stage: 'sections', upTo: '2026-10-13T09:00:00.000Z' });
    expect(b.confirmedAt > a.confirmedAt).toBe(true);
    expect((await workbench.listConfirms('letter')).map((c) => c.stage)).toEqual([
      'outputs',
      'sections',
    ]);
    expect(await workbench.listConfirms('other')).toEqual([]);
  });
```

`apps/api/test/workbench-list-repo.test.ts`, in the table of changes that move a fingerprint (after `'skipping a stage'`):

```ts
    [
      'keeping a stale stage',
      ({ workbench }) => workbench.addConfirm('alpha', 'sections', '2026-10-13T09:00:00.000Z'),
    ],
```

`apps/api/test/workbench-delete.test.ts`, next to `await workbench.addSkip('letter', 'survey');`: `await workbench.addConfirm('letter', 'outputs', '2026-10-13T09:00:00.000Z');`, and where the test asserts the project's rows are gone add `expect(await workbench.listConfirms('letter')).toEqual([]);`.

`apps/api/test/integration/workbench-pg.test.ts`:

```ts
  it('records confirmations newest first', async () => {
    const projectId = await newProject();
    const first = await workbench.addConfirm(projectId, 'sections', '2026-10-13T09:00:00.000Z');
    const second = await workbench.addConfirm(projectId, 'steps', '2026-10-13T09:30:00.000Z');
    expect(first).toMatchObject({ projectId, stage: 'sections', upTo: '2026-10-13T09:00:00.000Z' });
    expect(second.confirmedAt >= first.confirmedAt).toBe(true);
    expect((await workbench.listConfirms(projectId)).map((c) => c.stage)).toEqual([
      'steps',
      'sections',
    ]);
    await expect(
      pool.query(
        `INSERT INTO workbench_stage_confirms (project_id, stage, up_to) VALUES ($1, 'survey', now())`,
        [projectId],
      ),
    ).rejects.toThrow(/check constraint/);
  });
```

In the fingerprint test's list (after `add('stage skip deleted', …)`): `add('stage confirm', () => workbench.addConfirm(projectId, 'sections', new Date().toISOString()));`. In the delete test's `counts` query add `(SELECT count(*)::int FROM workbench_stage_confirms WHERE project_id = $1) AS confirms,`, call `await workbench.addConfirm(projectId, 'outputs', new Date().toISOString());` next to its `addSkip`, and its "everything is gone" expectation gains `confirms: 0`.

- [ ] **Step 2: Run** `npx vitest run --project api apps/api/test/workbench-stages-repo.test.ts apps/api/test/workbench-list-repo.test.ts apps/api/test/workbench-delete.test.ts` → FAIL (`addConfirm` is not a function).

- [ ] **Step 3: Implement** — `db/migrations/0024_workbench_stage_confirms.sql`:

```sql
-- Workbench tabs (handoff SC1): "Keep" on a stale drafting stage. A confirmation acknowledges the
-- earlier stages' completions up to `up_to`; stage state stays derived (packages/shared
-- drafting.ts stageStates). The stage list matches KEEPABLE_STAGES.
CREATE TABLE workbench_stage_confirms (
  id            bigserial   PRIMARY KEY,
  project_id    text        NOT NULL REFERENCES workbench_projects (id) ON DELETE CASCADE,
  stage         text        NOT NULL CHECK (stage IN ('outputs', 'sections', 'steps')),
  up_to         timestamptz NOT NULL,
  confirmed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_stage_confirms_project_idx
  ON workbench_stage_confirms (project_id, confirmed_at DESC);
```

`apps/api/src/workbench/repo.ts` — import `type KeepableStage, type StageConfirm` from `@ih/shared`; next to `StageSkipRecord`: `export type StageConfirmRecord = StageConfirm & { projectId: string };`. Interface, after `listSkips`:

```ts
  /** "Keep" on a stale stage (handoff SC1, migration 0024): its content stands up to `upTo`. */
  addConfirm(projectId: string, stage: KeepableStage, upTo: string): Promise<StageConfirmRecord>;
  /** Newest first. */
  listConfirms(projectId: string): Promise<StageConfirmRecord[]>;
```

`MemoryWorkbenchRepo`: `readonly confirms: StageConfirmRecord[] = [];` and

```ts
  async addConfirm(projectId: string, stage: KeepableStage, upTo: string) {
    const confirm: StageConfirmRecord = { projectId, stage, upTo, confirmedAt: this.now() };
    this.confirms.push(confirm);
    return confirm;
  }

  async listConfirms(projectId: string) {
    return this.confirms.filter((c) => c.projectId === projectId).reverse();
  }
```

In its `deleteProject`, add `this.confirms,` after `this.skips,` in the arrays emptied of the project's rows. In its `projectFingerprints`, add `const confirms = of(this.confirms).map((c) => [c.stage, c.upTo, c.confirmedAt]);`, put `confirms` after `skips` in the hashed array, and `...confirms.map((c) => c[2] as string),` after the skips in `times`.

`PgWorkbenchRepo`:

```ts
interface ConfirmRow {
  project_id: string;
  stage: KeepableStage;
  up_to: Date;
  confirmed_at: Date;
}

const toConfirm = (r: ConfirmRow): StageConfirmRecord => ({
  projectId: r.project_id,
  stage: r.stage,
  upTo: r.up_to.toISOString(),
  confirmedAt: r.confirmed_at.toISOString(),
});
```

```ts
  async addConfirm(projectId: string, stage: KeepableStage, upTo: string) {
    const { rows } = await this.pool.query<ConfirmRow>(
      `INSERT INTO workbench_stage_confirms (project_id, stage, up_to) VALUES ($1, $2, $3)
       RETURNING project_id, stage, up_to, confirmed_at`,
      [projectId, stage, upTo],
    );
    return toConfirm(rows[0]!);
  }

  async listConfirms(projectId: string) {
    const { rows } = await this.pool.query<ConfirmRow>(
      `SELECT project_id, stage, up_to, confirmed_at FROM workbench_stage_confirms
        WHERE project_id = $1 ORDER BY confirmed_at DESC, id DESC`,
      [projectId],
    );
    return rows.map(toConfirm);
  }
```

(`up_to` is written from an ISO string with millisecond precision and read back the same; `stageStates` compares ISO strings, so a confirmation of a completion read as `…:00.123Z` covers it exactly.)

`PgWorkbenchRepo.deleteProject`: add `'workbench_stage_confirms',` after `'workbench_stage_skips',` in the children list (the FK also cascades; explicit keeps the list complete).

`FINGERPRINT_SQL`: after the `coalesce(sk.n, 0), coalesce(sk.at::text, ''),` line add `coalesce(sc.n, 0), coalesce(sc.at::text, ''),`; add `sc.at` after `sk.at` in `greatest(…)`; and after the `sk` join:

```sql
    LEFT JOIN (SELECT project_id, count(*) AS n, max(confirmed_at) AS at
                 FROM workbench_stage_confirms GROUP BY project_id) sc
      ON sc.project_id = p.id
```

Update the `projectFingerprints` JSDoc list ("…samples, proposals, skips, confirmations, briefs…").

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project api` → PASS; `npm run typecheck`; eslint; prettier. Then the Pg integration test on a throwaway container:

```bash
docker run --rm -d --name ih-test-pg-ct3 -e POSTGRES_PASSWORD=test -p 55447:5432 postgres:17-alpine
IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55447/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg
docker rm -f ih-test-pg-ct3
```

→ PASS (new confirmations test, the fingerprint and delete tests with confirmations).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0024_workbench_stage_confirms.sql apps/api/src/workbench/repo.ts apps/api/test/workbench-stages-repo.test.ts apps/api/test/workbench-list-repo.test.ts apps/api/test/workbench-delete.test.ts apps/api/test/integration/workbench-pg.test.ts
git commit -m "Workbench repo: stage confirmations (migration 0024) in fingerprints and project delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: API — `skippedAt` on stages, `POST …/stages/:stage/confirm` (SV1, SC1)

**Files:**
- Modify: `apps/api/src/routes/workbench.ts` (`stagesOf`, the confirm route, `listStages` description)
- Test: `apps/api/test/workbench-stages.test.ts`
- Regenerate: `docs/openapi.json`

**Interfaces:**
- Produces: `POST /api/workbench/projects/:id/stages/:stage/confirm` → `201 StageView[]`, `400 stage {stage} cannot be kept`, `404 project not found`, `409 stage {stage} is not stale` — `operationId: 'confirmStage'`, tag `Drafting stages & proposals`.
- Consumed by: web client (Task 6).

- [ ] **Step 1: Write the failing tests** — `apps/api/test/workbench-stages.test.ts` (in `project()` add `const confirm = (stage: string) => ctx.app.inject({ method: 'POST', url: \`/api/workbench/projects/letter/stages/${stage}/confirm\` });` and return it; `putSection` helper next to `putField`):

```ts
const putSection = (id: string, anchor: string) => ({
  op: 'putSection',
  section: { id, anchor },
  reason: 'r',
});

describe('skippedAt (SV1)', () => {
  it('keeps the skip after the stage is run and accepted', async () => {
    const { app, start, skip, finish, decide } = await project();
    await skip('survey');
    const surveyOf = async () =>
      ((await app.inject('/api/workbench/projects/letter/stages')).json() as StageView[]).find(
        (s) => s.stage === 'survey',
      )!;
    const skipped = await surveyOf();
    expect(skipped.skippedAt).toEqual(expect.any(String));
    expect(skipped.completedAt).toBe(skipped.skippedAt);
    const run = (await start('survey')).json() as ProposalView;
    await finish(run.id, 'survey', survey);
    expect(await surveyOf()).toMatchObject({ state: 'proposed', skippedAt: skipped.skippedAt });
    await decide(run.id, { decision: 'accepted' });
    const accepted = await surveyOf();
    expect(accepted).toMatchObject({ state: 'accepted', skippedAt: skipped.skippedAt });
    expect(accepted.completedAt! > skipped.skippedAt!).toBe(true);
  });
});

describe('keep a stale stage (SC1)', () => {
  async function staleSections() {
    const p = await project();
    await p.skip('survey');
    const outputs = (await p.start('outputs')).json() as ProposalView;
    await p.finish(outputs.id, 'outputs', { notes: '', changes: [putField('date')] });
    await p.decide(outputs.id, { decision: 'accepted', changes: [0] });
    const sections = (await p.start('sections')).json() as ProposalView;
    await p.finish(sections.id, 'sections', { notes: '', changes: [putSection('body', '^Dear')] });
    await p.decide(sections.id, { decision: 'accepted', changes: [0] });
    const again = (await p.start('outputs')).json() as ProposalView;
    await p.finish(again.id, 'outputs', { notes: '', changes: [putField('total')] });
    await p.decide(again.id, { decision: 'accepted', changes: [0] });
    return p;
  }

  it('clears stale without a proposal, keeps the stage accepted, and goes stale again after a later change', async () => {
    const { app, confirm, stages, start, finish, decide, draft } = await staleSections();
    expect(await stages()).toContain('sections:stale');
    const before = (await app.inject('/api/workbench/projects/letter/proposals')).json() as unknown[];
    const definition = await draft();

    const kept = await confirm('sections');
    expect(kept.statusCode).toBe(201);
    expect((kept.json() as StageView[]).find((s) => s.stage === 'sections')).toMatchObject({
      state: 'accepted',
    });
    expect(await stages()).toEqual([
      'survey:skipped',
      'outputs:accepted',
      'sections:accepted',
      'steps:pending',
      'references:pending',
    ]);
    expect((await app.inject('/api/workbench/projects/letter/proposals')).json()).toHaveLength(
      before.length,
    );
    expect(await draft()).toEqual(definition);

    const twice = await confirm('sections');
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toEqual({ error: 'stage sections is not stale' });

    const third = (await start('outputs')).json() as ProposalView;
    await finish(third.id, 'outputs', { notes: '', changes: [putField('vat')] });
    await decide(third.id, { decision: 'accepted', changes: [0] });
    expect(await stages()).toContain('sections:stale');
  });

  it.each([
    ['survey', 400, 'stage survey cannot be kept'],
    ['references', 400, 'stage references cannot be kept'],
    ['revise', 400, 'stage revise cannot be kept'],
    ['nope', 400, 'stage nope cannot be kept'],
    ['steps', 409, 'stage steps is not stale'],
  ])('%s → %i', async (stage, code, error) => {
    const { confirm } = await staleSections();
    const res = await confirm(stage);
    expect(res.statusCode).toBe(code);
    expect(res.json()).toEqual({ error });
  });

  it('is a 404 for an unknown project', async () => {
    const { app } = await project();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/nope/stages/sections/confirm',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project not found' });
  });
});
```

(If `letter(1)` in `apps/api/test/helpers.ts` has no `document.sections`, the sections `finish` still applies: `putSection` adds the section.)

- [ ] **Step 2: Run** `npx vitest run --project api apps/api/test/workbench-stages.test.ts` → FAIL (the confirm route does not exist yet: 404 instead of 201/400/409; `skippedAt` already comes from Task 1, so the SV1 test may already pass and guards the route wiring).

- [ ] **Step 3: Implement** — `apps/api/src/routes/workbench.ts`, import `KEEPABLE_STAGES, STAGE_ORDER` from `@ih/shared` (if not already). `stagesOf`:

```ts
  const [skips, confirms] = await Promise.all([
    app.deps.workbench.listSkips(projectId),
    app.deps.workbench.listConfirms(projectId),
  ]);
  return stageStates(proposals, skips, confirms);
```

After the skip route:

```ts
  app.post<{ Params: { id: string; stage: string } }>(
    '/workbench/projects/:id/stages/:stage/confirm',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'confirmStage',
        summary: 'Keep a stale stage as it is',
        description: md`
          Clears \`stale\` from a stage without a new proposal (the Sections tab's *Keep these
          anchors*): its current content is confirmed against the earlier stages as they are now.
          Its \`completedAt\` and its state (\`accepted\`, or \`skipped\` for a kept skip) are
          unchanged, so later stages do not go stale; an earlier stage completing again makes it
          stale again. Only \`outputs\`, \`sections\` and \`steps\` can be kept, and only while
          stale. Nothing is proposed and the draft is not changed.
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          stage: z.string().describe('The stage: outputs, sections or steps.'),
        }),
        response: {
          201: res("Every stage's state.", z.array(StageViewSchema)),
          400: error('`stage {stage} cannot be kept`.'),
          404: PROJECT_NOT_FOUND,
          409: error('`stage {stage} is not stale`.'),
        },
      },
    },
    async (req, reply) => {
      const stage = KEEPABLE_STAGES.find((s) => s === req.params.stage);
      if (!stage) {
        return reply.code(400).send({ error: `stage ${req.params.stage} cannot be kept` });
      }
      const projectId = req.params.id;
      if (!(await workbench.getProject(projectId))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const states = await stagesOf(app, projectId);
      const index = STAGE_ORDER.indexOf(stage);
      if (states[index]?.state !== 'stale') {
        return reply.code(409).send({ error: `stage ${stage} is not stale` });
      }
      // What the stage is kept against: the earlier completions read for the check above. One
      // that lands after this read (even concurrently) is newer, so it makes the stage stale again.
      const upTo = states
        .slice(0, index)
        .map((s) => s.completedAt)
        .filter((at): at is string => at !== null)
        .sort()
        .at(-1)!;
      await workbench.addConfirm(projectId, stage, upTo);
      req.log.info({ projectId, stage, upTo }, 'workbench stage kept');
      return reply.code(201).send(await allStages(app, projectId));
    },
  );
```

`listStages` description: append "\`skippedAt\` is the stage's latest skip, kept after it is run or accepted again (the Survey tab's \"You skipped this stage\" banner)."

- [ ] **Step 4: Run** `npx vitest run --project api apps/api/test/workbench-stages.test.ts` → PASS; `npm run openapi`; `npx vitest run --project api` (openapi docs, conformance, the access sweep) → PASS; `npm run typecheck`; eslint; prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/test/workbench-stages.test.ts docs/openapi.json
git commit -m "Workbench API: keep a stale stage without a proposal; skippedAt on stages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web — `confirmStage`, `fakeApi`, pure Survey and Sections helpers

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/client.test.ts`
- Create: `apps/web/src/workbench/survey.ts`, `apps/web/test/survey-derive.test.ts`
- Modify: `apps/web/src/workbench/segmentation.ts`, `apps/web/test/segmentation.test.ts`

**Interfaces:**
- Produces:
  - `Api.confirmStage(projectId: string, stage: KeepableStage): Promise<StageView[]>` (POST `/stages/:stage/confirm`)
  - `survey.ts`: `answerProgress(questions, saved, typed) → { answered; of; unsaved: { question; answer }[] }`, `saveAnswersLabel(count, nextVersion)`, `skipBanner(stages, proposal) → { skippedAt; later: DraftStage[] } | null`, `skipBannerText(info)`, `seenInText(seenIn?)`, `candidateCounts(candidates)`
  - `segmentation.ts`: `type Selection = { sampleId; sectionId }`, `cellShare`, `landingText`, `hitTone`, `initialSelection`, `suggestionFor`, `move`
- Consumed by: Tasks 7–9.

- [ ] **Step 1: Write the failing tests** — `apps/web/test/client.test.ts`, in the stages test after `listStages`:

```ts
    await api.confirmStage('letter', 'sections');
    expect(fetchMock.mock.calls[4]![0]).toBe('/api/workbench/projects/letter/stages/sections/confirm');
    expect(fetchMock.mock.calls[4]![1]!.method).toBe('POST');
```

`apps/web/test/survey-derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { StageView } from '@ih/shared';
import {
  answerProgress,
  candidateCounts,
  saveAnswersLabel,
  seenInText,
  skipBanner,
  skipBannerText,
} from '../src/workbench/survey.js';

const qs = [
  { question: 'A?', why: 'a' },
  { question: 'B?', why: 'b' },
  { question: 'C?', why: 'c' },
];

describe('answerProgress', () => {
  it.each<[string, { question: string; answer: string }[], Record<string, string>, number, string[]]>([
    ['nothing yet', [], {}, 0, []],
    ['saved answers count as answered, not unsaved', [{ question: 'A?', answer: 'x' }], {}, 1, []],
    ['typed answers count and are unsaved', [], { 'B?': ' y ' }, 1, ['B?']],
    ['typing the saved answer again is not a change', [{ question: 'A?', answer: 'x' }], { 'A?': 'x' }, 1, []],
    ['clearing a saved answer unanswers it, and is not saved', [{ question: 'A?', answer: 'x' }], { 'A?': '' }, 0, []],
    ['blank typing is not an answer', [], { 'C?': '   ' }, 0, []],
  ])('%s', (_name, saved, typed, answered, unsaved) => {
    const p = answerProgress(qs, saved, typed);
    expect(p.answered).toBe(answered);
    expect(p.of).toBe(3);
    expect(p.unsaved.map((u) => u.question)).toEqual(unsaved);
  });

  it('trims what it would save', () => {
    expect(answerProgress(qs, [], { 'B?': ' y ' }).unsaved).toEqual([{ question: 'B?', answer: 'y' }]);
  });
});

describe('saveAnswersLabel', () => {
  it.each([
    [0, 4, 'Save answers to brief (v4)'],
    [1, 4, 'Save 1 answer to brief (v4)'],
    [2, 1, 'Save 2 answers to brief (v1)'],
  ])('%i answers, next v%i', (n, next, expected) => {
    expect(saveAnswersLabel(n, next)).toBe(expected);
  });
});

describe('skipBanner', () => {
  const T1 = '2026-10-03T09:00:00.000Z';
  const T2 = '2026-10-05T09:00:00.000Z';
  const stage = (o: Partial<StageView> & Pick<StageView, 'stage'>): StageView => ({
    state: 'pending',
    completedAt: null,
    skippedAt: null,
    ...o,
  });
  const skipped = [
    stage({ stage: 'survey', state: 'proposed', completedAt: T1, skippedAt: T1 }),
    stage({ stage: 'outputs', state: 'accepted', completedAt: T2 }),
    stage({ stage: 'sections', state: 'skipped', completedAt: T2, skippedAt: T2 }),
    stage({ stage: 'steps' }),
  ];
  const ready = { status: 'ready' as const, createdAt: '2026-10-13T09:00:00.000Z' };

  it.each<[string, StageView[], typeof ready | null, ReturnType<typeof skipBanner>]>([
    ['a skip in force and a newer survey', skipped, ready, { skippedAt: T1, later: ['outputs', 'sections'] }],
    ['no survey run since', skipped, null, null],
    ['the survey ran before the skip', skipped, { ...ready, createdAt: '2026-10-01T00:00:00.000Z' }, null],
    [
      'accepted since: the skip no longer counts',
      [stage({ stage: 'survey', state: 'accepted', completedAt: T2, skippedAt: T1 })],
      { ...ready, status: 'accepted' as never },
      null,
    ],
    ['never skipped', [stage({ stage: 'survey', state: 'proposed' })], ready, null],
  ])('%s', (_name, stages, proposal, expected) => {
    expect(skipBanner(stages, proposal)).toEqual(expected);
  });

  it('names the stages that will go stale', () => {
    expect(skipBannerText({ skippedAt: T1, later: ['outputs', 'sections', 'steps'] })).toMatch(
      /^You skipped this stage on .+, then ran it again\. Accepting replaces the skip — Outputs, Sections and Steps were completed without it and will be marked stale so you can re-propose them\.$/,
    );
    expect(skipBannerText({ skippedAt: T1, later: ['outputs'] })).toMatch(
      /Outputs was completed without it and will be marked stale so you can re-propose it\.$/,
    );
    expect(skipBannerText({ skippedAt: T1, later: [] })).toMatch(/Accepting replaces the skip\.$/);
  });
});

describe('seenInText and candidateCounts', () => {
  it.each([
    [{ n: 3, of: 6 }, '3 of 6 samples'],
    [{ n: 1, of: 1 }, '1 of 1 sample'],
    [{ n: 0, of: 0 }, null],
    [undefined, null],
  ])('%j', (seen, expected) => {
    expect(seenInText(seen)).toBe(expected);
  });

  it('counts fields and tables', () => {
    const c = (kind: 'field' | 'table') => ({ name: 'x', description: '', where: '', kind });
    expect(candidateCounts([c('field'), c('field'), c('table')])).toBe('2 fields · 1 table');
    expect(candidateCounts([])).toBe('0 fields · 0 tables');
  });
});
```

`apps/web/test/segmentation.test.ts` (import the new helpers and `type SegmentationResult`; reuse the file's `cell`/`sample` builders):

```ts
describe('anchor helpers', () => {
  const result: SegmentationResult = {
    anchorErrors: {},
    samples: [
      sample([cell({ id: 'header' }), cell({ id: 'supplier' })], { sampleId: 'acme' }),
      sample(
        [cell({ id: 'header' }), cell({ id: 'supplier', found: false, chars: 0, page: null, line: null })],
        { sampleId: 'globex', missingRequired: ['supplier'] },
      ),
    ],
    suggestions: [
      { section: 'supplier', sampleId: 'globex', anchor: '^(From|Vendor)\\b', reason: 'r' },
    ],
  };

  it('selects the first required miss, else the first cell', () => {
    expect(initialSelection(result)).toEqual({ sampleId: 'globex', sectionId: 'supplier' });
    expect(initialSelection({ ...result, samples: [result.samples[0]!] })).toEqual({
      sampleId: 'acme',
      sectionId: 'header',
    });
    expect(initialSelection({ ...result, samples: [] })).toBeNull();
  });

  it('finds the suggestion for a sample and section', () => {
    expect(suggestionFor(result, 'globex', 'supplier')?.anchor).toBe('^(From|Vendor)\\b');
    expect(suggestionFor(result, 'acme', 'supplier')).toBeNull();
  });

  it.each<[string, Parameters<typeof landingText>[1], boolean, string]>([
    ['found', cell({ id: 'h', page: 2, line: 'TAX INVOICE' }), true, 'In a.pdf: p.2 · matches "TAX INVOICE"'],
    ['missing, required', cell({ id: 'h', found: false, page: null, line: null }), true, 'In a.pdf: no match — required'],
    ['missing, optional', cell({ id: 'h', found: false, page: null, line: null }), false, 'In a.pdf: no match — optional'],
    ['not previewed', undefined, true, 'In a.pdf: not in the preview yet'],
  ])('landingText: %s', (_name, c, required, expected) => {
    expect(landingText('a.pdf', c, required)).toBe(expected);
  });

  it.each([
    [8, 8, true, 'ok'],
    [7, 8, true, 'danger'],
    [7, 8, false, 'neutral'],
    [0, 0, true, 'neutral'],
  ] as const)('hitTone(%i, %i, %s) = %s', (hits, of, required, tone) => {
    expect(hitTone(hits, of, required)).toBe(tone);
  });

  it('measures a cell against the sample and moves rows', () => {
    const big = cell({ id: 'a', chars: 800 });
    expect(cellShare(big, sample([big, cell({ id: 'b', chars: 200 })]))).toBeCloseTo(0.8);
    expect(cellShare(big, sample([]))).toBe(0);
    expect(move(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(move(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(move(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});
```

(Adjust the `sample(...)` builder call to the file's actual signature: it takes sections and an overrides object.)

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/client.test.ts apps/web/test/survey-derive.test.ts apps/web/test/segmentation.test.ts` → FAIL (missing exports and method).

- [ ] **Step 3: Implement** — `apps/web/src/api/client.ts` (import `type KeepableStage`):

```ts
  /** Keep a stale stage as it is (handoff SC1): no new proposal, the draft is unchanged. */
  confirmStage(projectId: string, stage: KeepableStage): Promise<StageView[]>;
```

```ts
    confirmStage: (id, stage) =>
      post<StageView[]>(`${base}/workbench/projects/${id}/stages/${stage}/confirm`, {}),
```

`apps/web/test/fake-api.ts`, next to `skipStage`:

```ts
    confirmStage: vi.fn(async () => {
      throw new Error('confirmStage not stubbed');
    }),
```

`apps/web/src/workbench/survey.ts`:

```ts
import {
  STAGE_ORDER,
  type BriefBody,
  type DraftStage,
  type ProposalView,
  type SeenIn,
  type StageView,
  type SurveyBody,
} from '@ih/shared';
import { plural } from './samples.js';

export interface AnswerProgress {
  answered: number;
  of: number;
  /** Typed answers that differ from the brief's (trimmed): what Save writes. */
  unsaved: { question: string; answer: string }[];
}

/** The questions card's counts (handoff §3): answered = shown answer non-blank. */
export function answerProgress(
  questions: SurveyBody['questions'],
  saved: BriefBody['answers'],
  typed: Record<string, string>,
): AnswerProgress {
  const savedAnswer = (q: string) => saved.find((a) => a.question === q)?.answer ?? '';
  const shown = questions.map((q) => typed[q.question] ?? savedAnswer(q.question));
  return {
    answered: shown.filter((a) => a.trim() !== '').length,
    of: questions.length,
    unsaved: questions
      .map((q) => ({ question: q.question, answer: (typed[q.question] ?? '').trim() }))
      .filter((a) => a.answer !== '' && a.answer !== savedAnswer(a.question)),
  };
}

/** "Save 2 answers to brief (v4)"; each save is a new brief version. */
export function saveAnswersLabel(count: number, nextVersion: number): string {
  const what = count === 0 ? 'answers' : plural(count, 'answer');
  return `Save ${what} to brief (v${nextVersion})`;
}

export interface SkipBannerInfo {
  skippedAt: string;
  /** Later stages already completed: accepting the survey will make them stale. */
  later: DraftStage[];
}

/**
 * Handoff SV1: the survey was skipped (and the skip still completes it) and has been run again
 * since; null otherwise.
 */
export function skipBanner(
  stages: readonly StageView[],
  proposal: Pick<ProposalView, 'status' | 'createdAt'> | null,
): SkipBannerInfo | null {
  const survey = stages.find((s) => s.stage === 'survey');
  if (!survey?.skippedAt || !proposal || survey.completedAt !== survey.skippedAt) return null;
  if (proposal.status !== 'ready' && proposal.status !== 'running') return null;
  if (proposal.createdAt <= survey.skippedAt) return null;
  const later = STAGE_ORDER.slice(1).filter(
    (stage) => (stages.find((s) => s.stage === stage)?.completedAt ?? null) !== null,
  );
  return { skippedAt: survey.skippedAt, later };
}

const STAGE_NAME: Partial<Record<DraftStage, string>> = {
  outputs: 'Outputs',
  sections: 'Sections',
  steps: 'Steps',
};
const listOf = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export function skipBannerText(info: SkipBannerInfo): string {
  const day = new Date(info.skippedAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
  const head = `You skipped this stage on ${day}, then ran it again. Accepting replaces the skip`;
  if (!info.later.length) return `${head}.`;
  const one = info.later.length === 1;
  const names = listOf(info.later.map((s) => STAGE_NAME[s] ?? s));
  return `${head} — ${names} ${one ? 'was' : 'were'} completed without it and will be marked stale so you can re-propose ${one ? 'it' : 'them'}.`;
}

/** "3 of 6 samples" (handoff SV2); null for surveys without it. */
export function seenInText(seen: SeenIn | undefined): string | null {
  return seen && seen.of > 0 ? `${seen.n} of ${plural(seen.of, 'sample')}` : null;
}

export function candidateCounts(candidates: SurveyBody['candidates']): string {
  const tables = candidates.filter((c) => c.kind === 'table').length;
  return `${plural(candidates.length - tables, 'field')} · ${plural(tables, 'table')}`;
}
```

`apps/web/src/workbench/segmentation.ts` — imports become `import type { AnchorSuggestion, SectionCell, SegmentationResult, SegmentedSample } from '@ih/shared';`; append:

```ts
/** The selected sample × section of the Sections tab. */
export interface Selection {
  sampleId: string;
  sectionId: string;
}

/** The share of the sample's sectioned text a cell holds (0..1). */
export function cellShare(cell: SectionCell, sample: SegmentedSample): number {
  const total = sample.sections.reduce((sum, c) => sum + c.chars, 0);
  return total > 0 ? cell.chars / total : 0;
}

/** An anchor row's "where it lands" line for the selected sample (handoff §5). */
export function landingText(
  filename: string,
  cell: SectionCell | undefined,
  required: boolean,
): string {
  if (!cell) return `In ${filename}: not in the preview yet`;
  if (!cell.found) return `In ${filename}: no match — ${required ? 'required' : 'optional'}`;
  return `In ${filename}: p.${cell.page} · matches "${cell.line ?? ''}"`;
}

/** The hits badge: ok when every sample matched, danger when a required section misses one. */
export function hitTone(hits: number, of: number, required: boolean): 'ok' | 'danger' | 'neutral' {
  if (of === 0) return 'neutral';
  if (hits === of) return 'ok';
  return required ? 'danger' : 'neutral';
}

/** What to show first: the first required miss, else the first segmented sample's first section. */
export function initialSelection(result: SegmentationResult): Selection | null {
  const missing = result.samples.find((s) => s.error === null && s.missingRequired.length > 0);
  if (missing) return { sampleId: missing.sampleId, sectionId: missing.missingRequired[0]! };
  const first = result.samples.find((s) => s.error === null && s.sections.length > 0);
  return first ? { sampleId: first.sampleId, sectionId: first.sections[0]!.id } : null;
}

/** The worker's one-click fix for a sample × section (handoff SC2), if any. */
export function suggestionFor(
  result: SegmentationResult,
  sampleId: string,
  sectionId: string,
): AnchorSuggestion | null {
  return result.suggestions.find((s) => s.sampleId === sampleId && s.section === sectionId) ?? null;
}

/** Move one item; out of range: unchanged. */
export function move<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (to < 0 || to >= items.length || from === to) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npm run typecheck`; `npx eslint apps/web`; prettier on the changed files.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/test/client.test.ts apps/web/src/workbench/survey.ts apps/web/test/survey-derive.test.ts apps/web/src/workbench/segmentation.ts apps/web/test/segmentation.test.ts
git commit -m "Workbench web: confirmStage client, Survey and Sections helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: *Keep* on stale stages — `StaleBanner` `keepLabel`/`skip` tone, `StagePanel` (SC1 in the UI)

**Files:**
- Modify: `apps/web/src/workbench/StaleBanner.tsx`, `apps/web/src/workbench/StagePanel.tsx`, `apps/web/src/workbench/ProjectPage.tsx` (sections `StagePanel` gets `onConfirmed`), `apps/web/src/styles/stages.css`
- Test: `apps/web/test/StagePanel.test.tsx`, `apps/web/test/tab-primitives.test.tsx`

**Interfaces:**
- Produces: `StaleBanner` props `keepLabel?: string` (default `'Keep'`), `tone?: 'alert' | 'info' | 'skip'`; `StagePanel` prop `onConfirmed?: () => void` (default `onApplied`); a stale `outputs`/`sections`/`steps` panel shows *Keep these outputs* / *Keep these anchors* / *Keep these steps*, which calls `api.confirmStage`.
- Consumed by: `SurveyTab` (skip tone, Task 8); `ProjectPage` sections tab.

- [ ] **Step 1: Write the failing tests** — `apps/web/test/StagePanel.test.tsx`:

```ts
  it('keeps a stale stage without a new proposal', async () => {
    const onConfirmed = vi.fn();
    const { api, onApplied } = panel(
      {
        listProposals: vi.fn(async () => [changeProposalView({ stage: 'sections', status: 'accepted' })]),
        confirmStage: vi.fn(async () => []),
      },
      {
        stage: 'sections',
        title: 'Sections',
        item: {
          stage: 'sections',
          state: 'stale',
          status: 'Stale — Outputs changed after it was accepted',
          metrics: [],
        },
        onConfirmed,
      },
    );
    const banner = await screen.findByRole('note');
    expect(banner).toHaveTextContent('Stale — Outputs changed after it was accepted.');
    await userEvent.click(within(banner).getByRole('button', { name: 'Keep these anchors' }));
    expect(api.confirmStage).toHaveBeenCalledWith('letter', 'sections');
    expect(api.startStage).not.toHaveBeenCalled();
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('says why keeping failed', async () => {
    panel(
      {
        listProposals: vi.fn(async () => [changeProposalView({ status: 'accepted' })]),
        confirmStage: vi.fn(async () => {
          throw new ApiError(409, 'stage outputs is not stale');
        }),
      },
      {
        title: 'Outputs',
        item: { stage: 'outputs', state: 'stale', status: 'Stale — Survey changed', metrics: [] },
      },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Keep these outputs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not stale');
  });
```

(Check `ApiError`'s constructor in `apps/web/src/api/client.ts` and match its argument order.)

`apps/web/test/tab-primitives.test.tsx`, in the `StaleBanner` describe:

```ts
  it('names its Keep button and has a skip tone', async () => {
    const onKeep = vi.fn();
    render(
      <StaleBanner tone="skip" onKeep={onKeep} keepLabel="Keep these anchors">
        Skipped
      </StaleBanner>,
    );
    const note = screen.getByRole('note');
    expect(note).toHaveAttribute('data-tone', 'skip');
    await userEvent.click(screen.getByRole('button', { name: 'Keep these anchors' }));
    expect(onKeep).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/StagePanel.test.tsx apps/web/test/tab-primitives.test.tsx` → FAIL (no Keep button; `keepLabel` ignored).

- [ ] **Step 3: Implement** — `StaleBanner.tsx`: props gain `keepLabel = 'Keep'` and `tone?: 'alert' | 'info' | 'skip'`; the icon line becomes

```tsx
      {tone !== 'info' && (
        <StageStatusIcon state={tone === 'skip' ? 'skipped' : 'stale'} size={18} decorative />
      )}
```

and the Keep button text `{keepLabel}`. (Update its JSDoc: "Handoff §0.4 (stale) and SV1 (a skip being replaced, `skip` tone)".) If `StageStatusIcon` without `decorative` was asserted anywhere for the stale banner, keep the previous non-decorative form for `alert` and use `decorative` only for `skip`.

`StagePanel.tsx`:

```ts
/** Handoff §0.4 / SC1: what Keep is called and what the banner asks, per stage. */
const KEEP: Record<ChangeStage, { label: string; text: string }> = {
  outputs: {
    label: 'Keep these outputs',
    text: 'Check the outputs below, then keep them as they are or propose again; the draft keeps what you applied until you apply new changes.',
  },
  sections: {
    label: 'Keep these anchors',
    text: 'The anchors may still work: check where they land below, then keep them or let the model propose new ones.',
  },
  steps: {
    label: 'Keep these steps',
    text: 'Check the steps below, then keep them as they are or propose again.',
  },
  revise: { label: 'Keep', text: '' }, // revise is never stale (not in STAGE_ORDER)
};
```

New prop `onConfirmed?: () => void` (JSDoc: "After Keep on a stale stage; defaults to `onApplied`. The draft is unchanged, so the sections tab passes a lighter reload."). Action:

```ts
  const keep = () =>
    act(async () => {
      if (stage === 'revise') return;
      await api.confirmStage(projectId, stage);
      setMessage(`Kept as it is; ${(title ?? stage).toLowerCase()} is up to date again.`);
      (onConfirmed ?? onApplied)();
    });
```

and the stale banner:

```tsx
      {title !== undefined && item?.state === 'stale' && stage !== 'revise' && (
        <StaleBanner onKeep={() => void keep()} keepLabel={KEEP[stage].label} busy={busy}>
          {item.status}. {KEEP[stage].text}
        </StaleBanner>
      )}
```

(*Propose again* stays the header action, as in `05-sections.png`; the banner carries only *Keep*.)

`ProjectPage.tsx`, the sections `StagePanel`: add `onConfirmed={loadOverview}` (keeping does not change the draft, so the Sections editor below is not remounted and unsaved anchor edits survive).

`apps/web/src/styles/stages.css`, after `.stale-banner[data-tone='info']`:

```css
.stale-banner[data-tone='skip'] {
  border-color: var(--ih-skip-fg);
  background: var(--ih-skip-bg);
}
```

- [ ] **Step 4: Run** `npx vitest run --project web apps/web/test/StagePanel.test.tsx apps/web/test/tab-primitives.test.tsx apps/web/test/OutputsTab.test.tsx apps/web/test/StepsTab.test.tsx apps/web/test/ProjectPage.test.tsx` → PASS (the existing "names what changed when the stage is stale" still finds `Stale — Survey changed after it was accepted.`); typecheck; eslint; prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/StaleBanner.tsx apps/web/src/workbench/StagePanel.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/src/styles/stages.css apps/web/test/StagePanel.test.tsx apps/web/test/tab-primitives.test.tsx
git commit -m "Workbench web: Keep a stale stage from its banner (Keep these anchors/outputs/steps)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Survey tab — header, skip banner, questions, findings, candidates with In brief, anatomy

**Files:**
- Modify: `apps/web/src/workbench/SurveyTab.tsx` (rewrite), `apps/web/src/workbench/ProjectPage.tsx` (pass `item`, drop `header('survey')`), `apps/web/src/styles/stages.css`
- Test: `apps/web/test/SurveyTab.test.tsx`

**Interfaces:**
- Consumes: `answerProgress`, `saveAnswersLabel`, `skipBanner`, `skipBannerText`, `seenInText`, `candidateCounts` (Task 6), `candidateInBrief` (Task 2), `StaleBanner` `skip` tone (Task 7), `TabHeader`, `Meter`, `StageStatusIcon`, `relativeTime`.
- Produces: `SurveyTab` props gain `item?: OverviewItem | null` and `now?: number`.

- [ ] **Step 1: Write the failing tests** — `apps/web/test/SurveyTab.test.tsx`. Deliberate updates to existing tests (copy from handoff §3): `'Save answers to brief'` → `'Save 1 answer to brief (v3)'` (brief is v2; when nothing is typed: `'Save answers to brief (v3)'`), `'Run survey again'` → `'Run again'`, `'Accept'` → `'Accept survey'`. Add (import `type StageView`, `type SurveyBody`):

```ts
  it('numbers the questions and counts answers, saved or typed', async () => {
    const answered = {
      ...brief,
      body: { ...brief.body, answers: [{ question: 'Which copy should be extracted?', answer: 'Executed' }] },
    };
    const body = proposalView().body as SurveyBody;
    const api = fakeApi({
      listProposals: vi.fn(async () => [
        proposalView({
          body: { ...body, questions: [...body.questions, { question: 'Credit notes?', why: 'Layout' }] },
        }),
      ]),
    });
    render(
      <SurveyTab api={api} projectId="letter" dataPolicy="local" brief={answered} onBriefSaved={vi.fn()} pollMs={1} />,
    );
    const card = (await screen.findByRole('heading', { name: 'Questions from the model' })).closest('section')!;
    expect(within(card).getByText('1 of 2 answered')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: /Answered 1 of 2/ })).toBeInTheDocument();
    expect(within(card).getByText('Why it asks: Some PDFs hold two copies')).toBeInTheDocument();
    await userEvent.type(within(card).getByLabelText('Credit notes?'), 'Reject them');
    expect(within(card).getByText('2 of 2 answered')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Save 1 answer to brief (v3)' })).toBeEnabled();
  });

  it('shows what the model found, the candidates with In brief and samples seen, and the anatomy', async () => {
    const body = proposalView().body as SurveyBody;
    tab({
      listProposals: vi.fn(async () => [
        proposalView({
          body: {
            ...body,
            variants: ['Acme — two-column header'],
            candidates: [
              { ...body.candidates[0]!, seenIn: { n: 3, of: 6 } },
              { name: 'batch_size', description: 'Batch size', where: 'table', kind: 'table' },
            ],
          },
        }),
      ]),
    });
    const found = (await screen.findByRole('heading', { name: 'What the model found' })).closest('section')!;
    expect(within(found).getByText(/local\/qwen · brief v1/)).toBeInTheDocument();
    expect(within(found).getByText('Acme — two-column header')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Candidate data' });
    const [, first, second] = within(table).getAllByRole('row');
    expect(first).toHaveTextContent('FIELD');
    expect(first).toHaveTextContent('page header — 3 of 6 samples');
    expect(first).toHaveTextContent('Not yet'); // the brief's purpose is not its outputs
    expect(second).toHaveTextContent('TABLE');
    expect(screen.getByText('1 field · 1 table · the Outputs stage turns these into fields and tables')).toBeInTheDocument();
    const anatomy = screen.getByRole('complementary', { name: 'Document anatomy' });
    expect(within(anatomy).getByText('Find it: PROTOCOL APPROVAL')).toBeInTheDocument();
  });

  it('says In brief once the brief asks for a candidate', async () => {
    const api = fakeApi({ listProposals: vi.fn(async () => [proposalView()]) });
    render(
      <SurveyTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        brief={{ ...brief, body: { ...brief.body, outputs: 'The protocol number' } }}
        onBriefSaved={vi.fn()}
        pollMs={1}
      />,
    );
    const table = await screen.findByRole('table', { name: 'Candidate data' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Yes');
  });

  it('warns that accepting replaces an earlier skip and names the stages that go stale', async () => {
    const at = '2026-10-03T09:00:00.000Z';
    const stage = (o: Partial<StageView> & Pick<StageView, 'stage'>): StageView => ({
      state: 'pending',
      completedAt: null,
      skippedAt: null,
      ...o,
    });
    tab({
      listProposals: vi.fn(async () => [proposalView()]),
      listStages: vi.fn(async () => [
        stage({ stage: 'survey', state: 'proposed', completedAt: at, skippedAt: at }),
        stage({ stage: 'outputs', state: 'accepted', completedAt: '2026-10-05T09:00:00.000Z' }),
        stage({ stage: 'sections', state: 'accepted', completedAt: '2026-10-06T09:00:00.000Z' }),
        stage({ stage: 'steps' }),
      ]),
    });
    const note = await screen.findByRole('note');
    expect(note).toHaveAttribute('data-tone', 'skip');
    expect(note).toHaveTextContent(/You skipped this stage on .+Accepting replaces the skip — Outputs and Sections were completed without it/);
  });

  it('puts Run again and Skip in the tab header with the status', async () => {
    const api = fakeApi({ listProposals: vi.fn(async () => [proposalView()]) });
    render(
      <SurveyTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        brief={brief}
        onBriefSaved={vi.fn()}
        pollMs={1}
        item={{ stage: 'survey', state: 'proposed', status: 'Survey ready — waiting for your decision', metrics: [] }}
      />,
    );
    const header = (await screen.findByRole('heading', { level: 2, name: 'Survey' })).closest('header')!;
    expect(within(header).getByText('Survey ready — waiting for your decision')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Run again' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Skip this stage' })).toBeInTheDocument();
  });

  it('points to Outputs once accepted', async () => {
    const p = proposalView();
    tab({
      listProposals: vi.fn(async () => [p]),
      decideProposal: vi.fn(async () => ({ ...p, status: 'accepted' as const })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept survey' }));
    expect(await screen.findByRole('link', { name: 'Go to Outputs' })).toHaveAttribute(
      'href',
      '#/workbench/letter/outputs',
    );
  });
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/SurveyTab.test.tsx` → FAIL.

- [ ] **Step 3: Implement** — `apps/web/src/workbench/SurveyTab.tsx` (keeps `POLICY_NOTE`; `act` gains a `busy` guard like `StagePanel`'s):

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  EMPTY_BRIEF,
  candidateInBrief,
  surveyBodyOf,
  type Brief,
  type DataPolicy,
  type OverviewItem,
  type ProposalView,
  type StageView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { relativeTime } from '../jobs/derive.js';
import { Icon } from '../ui/Icon.js';
import { Meter } from '../ui/Meter.js';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { StaleBanner } from './StaleBanner.js';
import { TabHeader } from './TabHeader.js';
import {
  answerProgress,
  candidateCounts,
  saveAnswersLabel,
  seenInText,
  skipBanner,
  skipBannerText,
} from './survey.js';

const DESCRIPTION =
  'The model reads the ready dev samples and describes what it found, then asks about anything the brief leaves open.';

/** Drafting stage 1 (handoff §3): the model surveys the dev samples and asks questions. */
export function SurveyTab({
  api,
  projectId,
  dataPolicy,
  brief,
  onBriefSaved,
  pollMs,
  onChanged,
  item = null,
  now = Date.now(),
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  brief: Brief | null;
  onBriefSaved: (brief: Brief) => void;
  pollMs: number;
  /** Called after a decision or a skip, so the page can reload stage states. */
  onChanged?: () => void;
  /** The overview item: the header's status line (same text as the rail). */
  item?: OverviewItem | null;
  now?: number;
}) {
  const [proposal, setProposal] = useState<ProposalView | null | undefined>(undefined);
  const [stages, setStages] = useState<StageView[]>([]);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [all, states] = await Promise.all([
        api.listProposals(projectId),
        api.listStages(projectId),
      ]);
      setProposal(all.find((p) => p.stage === 'survey') ?? null);
      setStages(states);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);
  // … the refresh/poll/reset-typed effects exactly as today …

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const body = proposal ? surveyBodyOf(proposal) : null;
  const saved = brief?.body.answers ?? [];
  const progress = body ? answerProgress(body.questions, saved, typed) : null;
  const banner = skipBanner(stages, proposal ?? null);
  const running = proposal?.status === 'running';
  const savedAnswer = (q: string) => saved.find((a) => a.question === q)?.answer ?? '';

  const run = () => act(async () => setProposal(await api.startStage(projectId, 'survey')));
  const decide = (decision: 'accepted' | 'rejected') =>
    act(async () => {
      if (!proposal) return;
      setProposal(await api.decideProposal(projectId, proposal.id, decision));
      void refresh();
      onChanged?.();
    });
  const skip = () =>
    act(async () => {
      await api.skipStage(projectId, 'survey');
      setMessage('Survey skipped');
      void refresh();
      onChanged?.();
    });
  const saveAnswers = () =>
    act(async () => {
      if (!progress?.unsaved.length) return;
      const base = brief?.body ?? EMPTY_BRIEF;
      const kept = base.answers.filter((qa) => !progress.unsaved.some((u) => u.question === qa.question));
      const next = await api.saveBrief(projectId, { ...base, answers: [...kept, ...progress.unsaved] });
      onBriefSaved(next);
      setTyped({});
      setMessage(`Answers saved to brief version ${next.version}`);
    });

  const actions = (
    <>
      <button
        type="button"
        className={proposal ? undefined : 'primary'}
        disabled={running || busy}
        onClick={() => void run()}
      >
        {proposal ? 'Run again' : 'Run survey'}
      </button>
      <button type="button" disabled={running || busy} onClick={() => void skip()}>
        Skip this stage
      </button>
    </>
  );
  const header = (
    <TabHeader title="Survey" item={item} description={DESCRIPTION} note={POLICY_NOTE[dataPolicy]} actions={actions} />
  );

  if (proposal === undefined) {
    return (
      <div className="survey-tab">
        {header}
        {error ? <p role="alert">{error}</p> : <p>Loading…</p>}
      </div>
    );
  }

  return (
    <div className="survey-tab">
      {header}
      {running && <p className="muted">Surveying the dev samples…</p>}
      {error && <p role="alert">{error}</p>}
      {proposal?.status === 'failed' && <p role="alert">{proposal.error}</p>}
      {message && <p role="status">{message}</p>}
      {banner && <StaleBanner tone="skip">{skipBannerText(banner)}</StaleBanner>}
      {proposal?.status === 'accepted' && (
        <p className="survey-next">
          Survey accepted. <a href={`#/workbench/${projectId}/outputs`}>Go to Outputs</a> to turn
          the candidates into fields and tables.
        </p>
      )}
      {body && proposal && progress && (
        <div className="survey-layout">
          <div className="survey-main">
            {body.questions.length > 0 && (
              <section className="card survey-questions" aria-labelledby="survey-questions-title">
                <div className="survey-card-head">
                  <h3 id="survey-questions-title">Questions from the model</h3>
                  <span className="tone-text-warn">
                    {progress.answered} of {progress.of} answered
                  </span>
                  <Meter
                    label={`Answered ${progress.answered} of ${progress.of}`}
                    value={progress.of ? progress.answered / progress.of : 0}
                    tone="warn"
                  />
                </div>
                <ol className="survey-question-list">
                  {body.questions.map((q, i) => {
                    const value = typed[q.question] ?? savedAnswer(q.question);
                    const done = value.trim() !== '';
                    return (
                      <li key={`${i}:${q.question}`} className="survey-question">
                        <span className={`question-number tone-${done ? 'ok' : 'warn'}`} aria-hidden="true">
                          {i + 1}
                        </span>
                        <div className="survey-question-body">
                          <p className="question-text">{q.question}</p>
                          <p className="muted question-why">Why it asks: {q.why}</p>
                          <textarea
                            aria-label={q.question}
                            rows={2}
                            placeholder="Your answer — saved to the brief"
                            value={value}
                            onChange={(e) => setTyped({ ...typed, [q.question]: e.target.value })}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ol>
                <div className="survey-card-foot">
                  <button
                    type="button"
                    disabled={progress.unsaved.length === 0 || busy}
                    onClick={() => void saveAnswers()}
                  >
                    {saveAnswersLabel(progress.unsaved.length, (brief?.version ?? 0) + 1)}
                  </button>
                  <span className="muted">
                    Saving creates a new brief version; unanswered questions can wait.
                  </span>
                </div>
              </section>
            )}
            <section className="card survey-found" aria-labelledby="survey-found-title">
              <div className="survey-card-head">
                <h3 id="survey-found-title">What the model found</h3>
                <span className="muted survey-meta">
                  {proposal.model ?? 'model'} · brief v{proposal.briefVersion ?? '–'} ·{' '}
                  {relativeTime(proposal.createdAt, now)}
                </span>
              </div>
              <p>{body.summary}</p>
              {body.variants.length > 0 && (
                <>
                  <h4>Variants it noticed</h4>
                  <ul className="variant-chips">
                    {body.variants.map((v, i) => (
                      <li key={`${i}:${v}`}>{v}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
            <section className="card survey-candidates" aria-labelledby="survey-candidates-title">
              <div className="survey-card-head">
                <h3 id="survey-candidates-title">Candidate data</h3>
                <span className="muted">
                  {candidateCounts(body.candidates)} · the Outputs stage turns these into fields and
                  tables
                </span>
              </div>
              <div className="table-scroll">
                <table aria-label="Candidate data">
                  <thead>
                    <tr>
                      <th scope="col">Kind</th>
                      <th scope="col">Name</th>
                      <th scope="col">What</th>
                      <th scope="col">Where</th>
                      <th scope="col">In brief</th>
                    </tr>
                  </thead>
                  <tbody>
                    {body.candidates.map((c, i) => {
                      const seen = seenInText(c.seenIn);
                      const inBrief = candidateInBrief(c.name, brief?.body ?? null);
                      return (
                        <tr key={`${i}:${c.name}`}>
                          <td>
                            <span className={`kind-tag tone-${c.kind === 'table' ? 'ok' : 'info'}`}>
                              {c.kind === 'table' ? 'TABLE' : 'FIELD'}
                            </span>
                          </td>
                          <td>
                            <code>{c.name}</code>
                          </td>
                          <td>{c.description}</td>
                          <td>
                            {c.where}
                            {seen && ` — ${seen}`}
                          </td>
                          <td className={inBrief ? 'tone-text-ok' : 'tone-text-warn'}>
                            <StageStatusIcon state={inBrief ? 'accepted' : 'proposed'} size={14} decorative />{' '}
                            {inBrief ? 'Yes' : 'Not yet'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
          <aside className="card survey-anatomy" aria-labelledby="survey-anatomy-title">
            <h3 id="survey-anatomy-title">Document anatomy</h3>
            <p className="muted">
              The structure the model found, top to bottom — the Sections stage turns it into anchors.
            </p>
            <ol className="anatomy-list">
              {body.structure.map((s, i) => (
                <li key={`${i}:${s.name}`} className="anatomy-card">
                  <span className="anatomy-number" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div>
                    <strong>{s.name}</strong>
                    <p>{s.description}</p>
                    <p className="muted anatomy-find">Find it: {s.howToFind}</p>
                  </div>
                </li>
              ))}
            </ol>
          </aside>
          {proposal.status === 'ready' && (
            <div className="card survey-decision">
              <p className="muted">
                Accepting completes the survey stage. Answers are saved to the brief separately —
                save them first so the next stages can use them.
              </p>
              <div className="actions">
                <button type="button" disabled={busy} onClick={() => void decide('rejected')}>
                  Reject
                </button>
                <button type="button" className="primary" disabled={busy} onClick={() => void decide('accepted')}>
                  <Icon name="check" /> Accept survey
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

(The existing "keeps rows whose names or strings repeat" test keeps passing: variants are `li`s, candidates rows keyed by index. `getByText(/accepted/i)` after accepting matches only the "Survey accepted." paragraph. The `aside` gets role `complementary` named by its `h3`.)

`ProjectPage.tsx`: delete `{tab === 'survey' && header('survey')}` and pass `item={itemOf('survey')}` to `SurveyTab`.

`apps/web/src/styles/stages.css` — append (and add `.survey-questions, .survey-found, .survey-candidates, .survey-anatomy, .survey-decision` to the PR 2 padding selector list and their `h3`s to the weight list):

```css
/* Survey (handoff §3) */
.survey-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 320px);
  gap: 16px;
  align-items: start;
}
.survey-main {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.survey-decision {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.survey-questions {
  border-color: var(--ih-warn-fg);
}
.survey-card-head,
.survey-card-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.survey-card-head h3 {
  margin: 0;
}
.survey-meta {
  margin-left: auto;
  font-family: var(--ih-font-mono);
  font-size: var(--ih-text-sm);
}
.survey-question-list,
.anatomy-list {
  list-style: none;
  margin: 12px 0;
  padding: 0;
  display: grid;
  gap: 12px;
}
.survey-question {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 10px;
}
.question-number,
.anatomy-number {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: var(--ih-text-sm);
  font-weight: 600;
}
.question-text {
  margin: 0;
  font-weight: 600;
}
.question-why,
.anatomy-find {
  margin: 2px 0 6px;
  font-size: var(--ih-text-sm);
}
.anatomy-find {
  font-style: italic;
}
.survey-question textarea {
  width: 100%;
}
.variant-chips {
  list-style: none;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.variant-chips li {
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--ih-surface-2);
  font-size: var(--ih-text-sm);
}
.anatomy-card {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ih-border);
  border-radius: 8px;
}
.anatomy-card p {
  margin: 2px 0 0;
}
.table-scroll {
  overflow-x: auto;
}
@media (max-width: 900px) {
  .survey-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

(Use the token names that exist in `apps/web/src/styles/tokens.css`; if `--ih-surface-2` or `--ih-border` is named differently there, use the existing equivalent. Check `.table-scroll` is not already defined; if it is, reuse it.)

- [ ] **Step 4: Run** `npx vitest run --project web apps/web/test/SurveyTab.test.tsx apps/web/test/ProjectPage.test.tsx apps/web/test/survey-derive.test.ts` → PASS; typecheck; eslint; prettier. Look at the Survey tab at 1440 px and 390 px in both themes against `03-survey.png` / `03b-survey-answered.png` (cards padded, no horizontal page scroll; the candidate table scrolls inside its card).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/SurveyTab.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/src/styles/stages.css apps/web/test/SurveyTab.test.tsx
git commit -m "Workbench web: Survey tab with questions progress, skip banner, In brief and anatomy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Sections tab — anchors list, live grid, cell selection, coloured markers, one-click fix

**Files:**
- Modify: `apps/web/src/workbench/SectionsTab.tsx` (rewrite of the render; data loading, `edit` debounce, `save` kept), `apps/web/src/workbench/SegmentationGrid.tsx`, `apps/web/src/workbench/SampleText.tsx` (`TextMark.color`), `apps/web/src/styles/stages.css`
- Test: `apps/web/test/SectionsTab.test.tsx`, `apps/web/test/SegmentationGrid.test.tsx`, `apps/web/test/SampleText.test.tsx`

**Interfaces:**
- Consumes: `cellFlag`, `cellShare`, `sectionHits`, `hitTone`, `landingText`, `initialSelection`, `suggestionFor`, `move`, `Selection` (Task 6); `SampleTag` (`tags.tsx`); `sectionTone`, `TONE_COLOR`.
- Produces: `SegmentationGrid` prop `selected?: Selection | null` (cells `aria-pressed`); `TextMark` gains optional `color` (marker background).

- [ ] **Step 1: Write the failing tests** — deliberate updates in `apps/web/test/SectionsTab.test.tsx`: every `'Save to draft'` → `'Save to draft v2'`; "keeps Save disabled while two sections share an id" replaces the Preview assertion with `expect(api.startSegmentation).toHaveBeenCalledTimes(1); // only the load: an id clash is never previewed` (the Preview button is gone: editing previews live); "removes copies…" first clicks `screen.getByText(/^Document options/)` (the copy fields live in a `<details>`). Add (the grid fixture already has `suggestions: []` from Task 3):

```ts
const supplierDefinition = {
  ...definition,
  document: {
    ...definition.document,
    sections: [
      { id: 'header', anchor: '^TAX INVOICE' },
      { id: 'supplier', anchor: '^(From|Supplier)\\b' },
    ],
  },
};
const missGrid = {
  anchorErrors: {},
  samples: [
    {
      sampleId: 's1',
      firstPage: 1,
      pageCount: 1,
      error: null,
      missingRequired: ['supplier'],
      sections: [
        { id: 'header', found: true, page: 1, line: 'TAX INVOICE', chars: 30 },
        { id: 'supplier', found: false, page: null, line: null, chars: 0 },
      ],
    },
  ],
  suggestions: [
    {
      section: 'supplier',
      sampleId: 's1',
      anchor: '^(From|Supplier|Vendor)\\b',
      reason: 'This sample labels it "Vendor:"; no alternative of the anchor matches that.',
    },
  ],
};
const missSetup = () =>
  setup({
    getTemplate: vi.fn(async () => templateView(supplierDefinition)),
    getSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', result: missGrid })),
    getSampleText: vi.fn(async () => ({
      sha256: 'abc',
      pages: [{ number: 1, text: 'TAX INVOICE\nVendor: Globex', ocr: false }],
    })),
  });

  it('shows hits per anchor and where it lands in the selected sample', async () => {
    missSetup();
    expect(await screen.findByRole('img', { name: 'Matched in 0 of 1 samples' })).toHaveTextContent('0/1');
    expect(screen.getByRole('img', { name: 'Matched in 1 of 1 samples' })).toHaveTextContent('1/1');
    expect(screen.getByText('In a.pdf: no match — required')).toBeInTheDocument();
    expect(screen.getByText('In a.pdf: p.1 · matches "TAX INVOICE"')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'a.pdf · supplier' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('applies the suggested anchor in one click and previews it without saving', async () => {
    const api = missSetup();
    const hint = await screen.findByRole('note', { name: 'supplier not found' });
    expect(hint).toHaveTextContent('This sample labels it "Vendor:"');
    await userEvent.click(within(hint).getByRole('button', { name: 'Use ^(From|Supplier|Vendor)\\b' }));
    expect(screen.getByLabelText('Anchor of section 2')).toHaveValue('^(From|Supplier|Vendor)\\b');
    await waitFor(
      () =>
        expect(api.startSegmentation).toHaveBeenLastCalledWith('letter', {
          sections: [
            { id: 'header', anchor: '^TAX INVOICE', required: true },
            { id: 'supplier', anchor: '^(From|Supplier|Vendor)\\b', required: true },
          ],
          pageMarkers: true,
          copies: { anchor: '^COPY', select: 'last' },
        }),
      { timeout: 2000 },
    );
    expect(api.saveTemplate).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved anchors')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save to draft v2' })).toBeEnabled();
  });

  it('selects a sample and section from a grid cell', async () => {
    missSetup();
    await userEvent.click(await screen.findByRole('button', { name: 'a.pdf · header' }));
    expect(screen.getByRole('button', { name: 'a.pdf · header' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('note', { name: 'supplier not found' })).toBeNull();
    expect(await screen.findByRole('note', { name: 'header starts here' })).toBeInTheDocument();
  });

  it('moves a section and previews the new order', async () => {
    const api = missSetup();
    await screen.findByRole('button', { name: 'a.pdf · header' });
    await userEvent.click(screen.getByRole('button', { name: 'Move section 2 up' }));
    await waitFor(
      () =>
        expect(api.startSegmentation).toHaveBeenLastCalledWith(
          'letter',
          expect.objectContaining({
            sections: [
              { id: 'supplier', anchor: '^(From|Supplier)\\b', required: true },
              { id: 'header', anchor: '^TAX INVOICE', required: true },
            ],
          }),
        ),
      { timeout: 2000 },
    );
    expect(screen.getByRole('button', { name: 'Move section 1 up' })).toBeDisabled();
  });
```

(`within` is added to the Testing Library import.)

`apps/web/test/SegmentationGrid.test.tsx` deliberate copy updates: `toHaveTextContent('missing')` → `toHaveTextContent('Missing (required)')`; `/missing \(required\)/` → `/Missing \(required\)/`; the holdout row → `toHaveTextContent('HOLDOUT')`. Add:

```ts
  it('marks the selected cell, lists the states and flags a section that swallows the text', () => {
    const swallowing: SegmentationResult = {
      anchorErrors: {},
      suggestions: [],
      samples: [
        {
          ...result.samples[0]!,
          missingRequired: [],
          sections: [
            { id: 'header', found: true, page: 1, line: 'INVOICE 42', chars: 80 },
            { id: 'totals', found: true, page: 2, line: 'Total', chars: 920 },
          ],
        },
      ],
    };
    render(
      <SegmentationGrid
        result={swallowing}
        sections={sections}
        samples={[a]}
        selected={{ sampleId: 's1', sectionId: 'totals' }}
        onOpen={vi.fn()}
      />,
    );
    const totals = screen.getByRole('button', { name: 'a.pdf · totals' });
    expect(totals).toHaveAttribute('aria-pressed', 'true');
    expect(totals).toHaveTextContent('92% of text');
    expect(totals).toHaveAccessibleDescription(/swallows more than 60% of the text/);
    expect(screen.getByRole('button', { name: 'a.pdf · header' })).toHaveAttribute('aria-pressed', 'false');
    const legend = screen.getByRole('list', { name: 'Cell states' });
    expect(legend).toHaveTextContent('Found');
    expect(legend).toHaveTextContent('Swallows > 60% of the text');
    expect(legend).toHaveTextContent('Missing (required)');
    expect(legend).toHaveTextContent('Missing (optional)');
  });
```

`apps/web/test/SampleText.test.tsx`:

```ts
  it('colours a section start marker', async () => {
    render(
      <SampleText
        api={fakeApi({
          getSampleText: vi.fn(async () => ({
            sha256: 'abc',
            pages: [{ number: 1, text: 'intro\nHEADER\nbody', ocr: false }],
          })),
        })}
        projectId="letter"
        sampleId="s1"
        marks={[{ page: 1, line: 'HEADER', label: 'header', color: 'var(--ih-ok-fg)' }]}
      />,
    );
    const mark = await screen.findByRole('note', { name: 'header starts here' });
    expect(mark).toHaveStyle({ background: 'var(--ih-ok-fg)' });
    expect(mark).toHaveTextContent('▶ header starts here');
  });
```

(Adapt the render to the file's existing helper. The visible marker text changes from "▶ all" to "▶ all starts here" (05b screenshot): update `SamplesTab.test.tsx:304` deliberately to `/^▶ all starts here\nintro/`.)

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/SectionsTab.test.tsx apps/web/test/SegmentationGrid.test.tsx apps/web/test/SampleText.test.tsx apps/web/test/SamplesTab.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`SampleText.tsx`: `export type TextMark = { page: number; line: string; label: string; color?: string };` and the marker:

```tsx
              <span
                role="note"
                aria-label={`${mark.label} starts here`}
                className="section-start"
                style={mark.color ? { background: mark.color } : undefined}
              >
                {`▶ ${mark.label} starts here\n`}
              </span>
```

(`PageBody`'s `marks` parameter type becomes `Omit<TextMark, 'page'>[]`.)

`SegmentationGrid.tsx`:

```tsx
import type { SampleView, SegmentationResult } from '@ih/shared';
import { SampleTag } from './tags.js';
import { cellFlag, cellShare, sectionHits, type CellFlag, type Selection } from './segmentation.js';

const FLAG_TEXT: Record<Exclude<CellFlag, null>, string> = {
  'missing-required': 'Missing (required)',
  missing: 'Missing (optional)',
  empty: 'Empty',
  large: 'Swallows > 60% of the text',
};
const LEGEND = [
  ['found', 'Found'],
  ['large', 'Swallows > 60% of the text'],
  ['missing-required', 'Missing (required)'],
  ['missing', 'Missing (optional)'],
] as const;

/** Samples × sections (handoff §5): where each anchor lands; a cell selects sample + section. */
export function SegmentationGrid({
  result,
  sections,
  samples,
  onOpen,
  selected = null,
}: {
  result: SegmentationResult;
  sections: { id: string; required: boolean }[];
  samples: SampleView[];
  onOpen: (sampleId: string, sectionId: string) => void;
  selected?: Selection | null;
}) {
  const byId = new Map(samples.map((s) => [s.id, s]));
  const errors = Object.entries(result.anchorErrors);
  return (
    <div className="segmentation-grid">
      {/* anchor errors list: unchanged */}
      <ul className="seg-legend" aria-label="Cell states">
        {LEGEND.map(([state, text]) => (
          <li key={state}>
            <span className={`seg-swatch cell-${state}`} aria-hidden="true" />
            {text}
          </li>
        ))}
      </ul>
      <div className="table-scroll">
        <table aria-label="Section anchors">
          <thead>
            <tr>
              <th scope="col">Sample</th>
              {sections.map((s) => {
                const { hits, of } = sectionHits(result, s.id);
                const short = s.required && hits < of;
                return (
                  <th key={s.id} scope="col" aria-label={`${s.id}, matched in ${hits} of ${of} samples`}>
                    <code>{s.id}</code>
                    <small className={short ? 'tone-text-danger' : 'tone-text-ok'}>{`${hits} of ${of}`}</small>
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
                    {name} {view && <SampleTag role={view.role} />}
                  </th>
                  {row.error !== null ? (
                    <td colSpan={Math.max(1, sections.length)} className="muted">
                      {row.error}
                    </td>
                  ) : (
                    sections.map((s) => {
                      const cell = row.sections.find((c) => c.id === s.id);
                      const flag = cell ? cellFlag(cell, s.required, row, sections.length) : null;
                      const state = cell === undefined ? null : (flag ?? 'found');
                      const descId = `seg-${row.sampleId}-${s.id}`;
                      return (
                        <td key={s.id} className={state ? `cell-${state}` : undefined}>
                          <button
                            type="button"
                            className="seg-cell"
                            aria-label={`${name} · ${s.id}`}
                            aria-describedby={descId}
                            aria-pressed={selected?.sampleId === row.sampleId && selected.sectionId === s.id}
                            title={cell?.line ?? undefined}
                            onClick={() => onOpen(row.sampleId, s.id)}
                          >
                            <span id={descId}>
                              {cell === undefined && 'not in preview yet'}
                              {cell?.found && (
                                <>
                                  {`p.${cell.page} · ${cell.chars}`}
                                  <small>
                                    {flag === 'large'
                                      ? ` ${Math.round(cellShare(cell, row) * 100)}% of text`
                                      : ' chars'}
                                  </small>
                                </>
                              )}
                              {flag === 'large' && (
                                <span className="visually-hidden">, swallows more than 60% of the text</span>
                              )}
                              {flag && flag !== 'large' && <span className="flag"> {FLAG_TEXT[flag]}</span>}
                            </span>
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
    </div>
  );
}
```

`SectionsTab.tsx` — keep `PREVIEW_DEBOUNCE_MS`, `Row`, `Copies`, `isComplete`, `candidate`, the loading effect, the unmount effect, `edit`, `setRow`, `save`, `slowAnchor`; replace `open` with `selected: Selection | null` and add:

```tsx
  const result = view?.result ?? null;
  useEffect(() => {
    if (!result) return;
    setSelected((current) =>
      current && result.samples.some((s) => s.sampleId === current.sampleId)
        ? current
        : initialSelection(result),
    );
  }, [result]);
```

(this effect sits with the other hooks, before the early returns). After the early returns:

```tsx
  const addSection = () =>
    edit([...rows, { key: nextKey.current++, id: '', anchor: '', required: true }]);
  const selectedSample = selected ? samples.find((s) => s.id === selected.sampleId) : undefined;
  const selectedRow =
    selected && result ? result.samples.find((s) => s.sampleId === selected.sampleId) : undefined;
  const cellOf = (id: string) => selectedRow?.sections.find((c) => c.id === id);
  const indexOf = (id: string) => rows.findIndex((r) => r.id === id);
  const colour = (id: string) => {
    const i = indexOf(id);
    return i < 0 ? TONE_COLOR.neutral : TONE_COLOR[sectionTone(i)];
  };
  const marks: TextMark[] = (selectedRow?.sections ?? [])
    .filter((c) => c.found && c.page !== null && c.line !== null)
    .map((c) => ({ page: c.page!, line: c.line!, label: c.id, color: colour(c.id) }));
  const selectedSection = selected ? rows.find((r) => r.id === selected.sectionId) : undefined;
  const missingRequired =
    selectedSection?.required === true &&
    selectedRow?.error === null &&
    cellOf(selectedSection.id)?.found === false;
  const suggestion =
    result && selected ? suggestionFor(result, selected.sampleId, selected.sectionId) : null;
  const applySuggestion = (s: AnchorSuggestion) => {
    const i = indexOf(s.section);
    if (i >= 0) setRow(i, { anchor: s.anchor });
  };
  const prepared = result ? result.samples.filter((s) => s.error === null).length : 0;
  const hitsOf = (id: string) =>
    result && result.samples.some((s) => s.sections.some((c) => c.id === id))
      ? sectionHits(result, id)
      : null;
```

Render:

```tsx
  return (
    <div className="sections-tab">
      <div className="sections-layout">
        <div className="sections-main">
          <section className="card anchors-card" aria-labelledby="anchors-title">
            <div className="anchors-head">
              <h3 id="anchors-title">Anchors</h3>
              <span className="muted" aria-live="polite">
                {running
                  ? 'Updating the preview…'
                  : result
                    ? `Live preview on ${plural(prepared, 'prepared sample')}`
                    : 'No preview yet'}
              </span>
              {dirty && <span className="tone-text-warn unsaved-note">Unsaved anchors</span>}
              <span className="anchors-actions">
                <button type="button" onClick={addSection}>
                  <Icon name="plus" /> Add section
                </button>
                <button
                  type="button"
                  className={dirty ? 'primary' : undefined}
                  onClick={() => void save()}
                  disabled={!dirty || !complete || saving || slowAnchor}
                >
                  Save to draft v{draft}
                </button>
              </span>
            </div>
            {slowAnchor && <p className="muted">Fix the slow anchor to save.</p>}
            {message && <p role="status">{message}</p>}
            {(error ?? previewError) && <p role="alert">{error ?? previewError}</p>}
            <ol className="anchor-list">
              {rows.map((r, i) => {
                const hits = hitsOf(r.id);
                const tone = hits ? hitTone(hits.hits, hits.of, r.required) : 'neutral';
                return (
                  <li key={r.key} className={`anchor-row${selected?.sectionId === r.id ? ' selected' : ''}`}>
                    <span className="anchor-order" aria-hidden="true" style={{ background: TONE_COLOR[sectionTone(i)] }}>
                      {i + 1}
                    </span>
                    <input className="mono anchor-id" aria-label={`Id of section ${i + 1}`} value={r.id} onChange={(e) => setRow(i, { id: e.target.value })} />
                    <input
                      className="mono anchor-regex"
                      aria-label={`Anchor of section ${i + 1}`}
                      aria-invalid={tone === 'danger'}
                      value={r.anchor}
                      onChange={(e) => setRow(i, { anchor: e.target.value })}
                    />
                    <span
                      className={`hits-badge tone-${tone}`}
                      role="img"
                      aria-label={hits ? `Matched in ${hits.hits} of ${hits.of} samples` : 'Not in the preview yet'}
                    >
                      {hits ? `${hits.hits}/${hits.of}` : '–'}
                    </span>
                    <label className="inline anchor-required">
                      <input type="checkbox" aria-label={`Section ${i + 1} required`} checked={r.required} onChange={(e) => setRow(i, { required: e.target.checked })} />{' '}
                      Required
                    </label>
                    <span className="anchor-tools">
                      <button type="button" className="icon-button" aria-label={`Move section ${i + 1} up`} disabled={i === 0} onClick={() => edit(move(rows, i, i - 1))}>
                        <Icon name="chevronUp" />
                      </button>
                      <button type="button" className="icon-button" aria-label={`Move section ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => edit(move(rows, i, i + 1))}>
                        <Icon name="chevronDown" />
                      </button>
                      <button type="button" className="icon-button danger" aria-label={`Remove section ${i + 1}`} onClick={() => edit(rows.filter((_, j) => j !== i))}>
                        <Icon name="trash" />
                      </button>
                    </span>
                    {selectedSample && selectedRow?.error === null && (
                      <p className={`anchor-landing${tone === 'danger' && cellOf(r.id)?.found === false ? ' tone-text-danger' : ''}`}>
                        {landingText(selectedSample.filename, cellOf(r.id), r.required)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
            <details className="document-options">
              <summary>
                Document options · page markers {pageMarkers ? 'on' : 'off'} ·{' '}
                {copies?.anchor ? `keeps the ${copies.select} copy` : 'no copy selection'}
              </summary>
              {/* the existing "Several copies in one document" fieldset, unchanged */}
            </details>
          </section>
          {result && (
            <section className="card grid-card" aria-labelledby="grid-title">
              <div className="grid-head">
                <h3 id="grid-title">Where each anchor lands</h3>
                <span className="muted">Click a cell to see it in the text</span>
              </div>
              <SegmentationGrid
                result={result}
                sections={rows.map((r) => ({ id: r.id, required: r.required }))}
                samples={samples}
                selected={selected}
                onOpen={(sampleId, sectionId) => setSelected({ sampleId, sectionId })}
              />
            </section>
          )}
        </div>
        {selected && selectedSample && (
          <aside className="card section-text" aria-label={`Text of ${selectedSample.filename}`}>
            <h3>{selectedSample.filename}</h3>
            <p className="muted">Section starts marked in their colours</p>
            {missingRequired && selectedSection && (
              <div className="anchor-hint" role="note" aria-label={`${selectedSection.id} not found`}>
                <p>
                  <strong>{selectedSection.id} not found.</strong>{' '}
                  {suggestion
                    ? suggestion.reason
                    : 'No other way of writing its label starts a line in this sample; edit the anchor by hand.'}
                </p>
                {suggestion && (
                  <button type="button" onClick={() => applySuggestion(suggestion)}>
                    Use <code>{suggestion.anchor}</code>
                  </button>
                )}
              </div>
            )}
            <SampleText key={selected.sampleId} api={api} projectId={projectId} sampleId={selected.sampleId} marks={marks} />
          </aside>
        )}
      </div>
    </div>
  );
```

Imports: `AnchorSuggestion` from `@ih/shared`; `Icon`; `sectionTone, TONE_COLOR` from `../ui/stageStyle.js`; `type TextMark` from `./SampleText.js`; `plural` from `./samples.js`; `hitTone, initialSelection, landingText, move, sectionHits, suggestionFor, type Selection` from `./segmentation.js`. The old description paragraph moves out: the tab description is `StagePanel`'s `DESCRIPTION.sections`; update it to "Each section starts at the first match of its anchor (a multiline regular expression) and runs to the next. The grid shows, live, where every anchor lands in each prepared sample." The *Preview* button and its handler are removed (live preview on every complete edit; the load previews once).

`apps/web/src/styles/stages.css` — append (and add `.anchors-card, .grid-card, .section-text` to the PR 2 padding list and their `h3`s to the weight list):

```css
/* Sections (handoff §5) */
.sections-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
  gap: 16px;
  align-items: start;
}
.sections-main {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.anchors-head,
.grid-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.anchors-head h3,
.grid-head h3 {
  margin: 0;
}
.anchors-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.anchor-list {
  list-style: none;
  margin: 12px 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.anchor-row {
  display: grid;
  grid-template-columns: 24px minmax(80px, 160px) minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
}
.anchor-row.selected {
  background: var(--ih-info-bg);
}
.anchor-order {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  color: var(--ih-accent-text);
  font-size: var(--ih-text-sm);
  font-weight: 600;
}
.anchor-regex[aria-invalid='true'] {
  border-color: var(--ih-danger-fg);
}
.hits-badge {
  min-width: 44px;
  padding: 2px 8px;
  border-radius: 999px;
  text-align: center;
  font-size: var(--ih-text-sm);
}
.hits-badge.tone-neutral {
  background: var(--ih-surface-2);
}
.anchor-landing {
  grid-column: 2 / -1;
  margin: 0;
  font-size: var(--ih-text-sm);
  color: var(--ih-text-muted);
  overflow-wrap: anywhere;
}
.seg-legend {
  list-style: none;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: var(--ih-text-sm);
}
.seg-swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 4px;
  border: 1px solid var(--ih-border);
  border-radius: 3px;
  vertical-align: -2px;
}
.cell-found .seg-cell,
.seg-swatch.cell-found {
  background: var(--ih-ok-bg);
}
.cell-large .seg-cell,
.seg-swatch.cell-large {
  background: var(--ih-warn-bg);
  border-color: var(--ih-warn-fg);
}
.cell-missing-required .seg-cell,
.seg-swatch.cell-missing-required {
  background: var(--ih-danger-bg);
  border-color: var(--ih-danger-fg);
}
.cell-missing .seg-cell,
.seg-swatch.cell-missing {
  background: var(--ih-surface-2);
}
.seg-cell[aria-pressed='true'] {
  outline: 2px solid var(--ih-accent);
  outline-offset: -2px;
}
.anchor-hint {
  margin-bottom: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--ih-danger-bg);
}
.anchor-hint p {
  margin: 0 0 8px;
}
.section-start {
  color: var(--ih-accent-text);
  padding: 0 6px;
  border-radius: 4px;
}
@media (max-width: 900px) {
  .sections-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .anchor-row {
    grid-template-columns: 24px minmax(0, 1fr) auto;
  }
  .anchor-regex,
  .anchor-landing {
    grid-column: 1 / -1;
  }
}
```

(Remove or narrow the old `.section-start` rule in `apps/web/src/styles.css` (accent text) so the coloured marker reads; keep a marker without `color` readable by giving `.section-start:not([style])` the old accent colour. Use the token names that exist in `tokens.css` for surface/border/danger backgrounds; the existing `.cell-*` rules in `styles.css` are replaced by these.)

- [ ] **Step 4: Run** `npx vitest run --project web` → PASS (SectionsTab, SegmentationGrid, SampleText, SamplesTab, StagePanel, ProjectPage, useSegmentPreview); typecheck; eslint; prettier. In the browser, compare with `05-sections.png` / `05b-sections-anchor-fix.png` at 1440 px and 390 px in both themes: cards padded, the grid scrolls inside its card, no horizontal page scroll; edit an anchor and watch the grid recompute without saving.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/SectionsTab.tsx apps/web/src/workbench/SegmentationGrid.tsx apps/web/src/workbench/SampleText.tsx apps/web/src/workbench/StagePanel.tsx apps/web/src/styles/stages.css apps/web/src/styles.css apps/web/test/SectionsTab.test.tsx apps/web/test/SegmentationGrid.test.tsx apps/web/test/SampleText.test.tsx apps/web/test/SamplesTab.test.tsx
git commit -m "Workbench web: Sections tab with anchor list, live grid, coloured markers and one-click fixes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs and the full check

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Docs** — in `CLAUDE.md`:

1. Contract table, row "Workbench prepared text and segmentation": append to the TS cell "; `SegmentationResultSchema.suggestions` (`AnchorSuggestionSchema`, default `[]`)" and to the Python cell "; `segment_samples` adds `suggestions` from `anchor_hints.suggest_anchor` (label variants, `LABEL_VARIANTS`)".
2. Row "Data policy and drafting": append to the TS cell "; survey candidates' optional `seenIn` (`SeenInSchema`), `candidateInBrief` (`packages/shared/src/survey.ts`, derived, never stored)" and to the Python cell "; `SURVEY_SCHEMA` candidates require `seenIn`, `drafting.clamp_seen_in`".
3. Row "Job statuses and tasks" is unchanged; add the migration to the stage logic: in the **Workbench** bullet, after "…a stage counts as complete once it is accepted or skipped, and stale is derived, never stored.", add: "`StageView.skippedAt` is the stage's latest skip, kept after later runs (the Survey tab's skip banner). A stale outputs, sections or steps stage can be kept without a proposal: `POST /api/workbench/projects/:id/stages/:stage/confirm` (`KEEPABLE_STAGES`; 400 for other stages, 409 `stage {stage} is not stale`) records a `workbench_stage_confirms` row (migration 0024) whose `up_to` is the newest earlier completion read for the check; `stageStates(proposals, skips, confirms)` treats the stage as stale only when an earlier stage completed after `max(completedAt, upTo)`, and never moves `completedAt` or the state's kind (a kept skip stays skipped), so later stages do not go stale. The table is in `projectFingerprints` and `deleteProject`."
4. In the same bullet, after the sentence on anchor previews ("…so the Sections tab refuses to save an anchor whose preview timed out)"), add: "Every grid carries `suggestions` for required sections that miss a segmented sample: `anchor_hints` reads simple anchors (`^Label`, `^(A|B)\b`, `(?i)`, `\s*`), looks for a synonym, another case or an indent at a line start, and offers the anchor with it only when it matches that sample; the Sections tab applies one with a click (unsaved, previewed live)."
5. At the end of the **UI** bullet's Workbench tabs sentence (PR 1/2), append: " Survey (`SurveyTab`, helpers in `workbench/survey.ts`) and Sections (`SectionsTab`, `SegmentationGrid`, helpers in `workbench/segmentation.ts`; *Keep* on stale stages in `StagePanel` via `StaleBanner` `keepLabel`) follow handoff §3 and §5."

- [ ] **Step 2: Run** `npm run openapi` (no diff expected after Tasks 3 and 5; commit if there is one), then `npm run check` → green (lint, typecheck, every TS project, `worker:lint`, `worker:test`). Then `npx prettier --check .`; fix only the reported files with `npx prettier --write <file>`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Docs: stage confirmations, survey seenIn and anchor suggestions in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Never `git add -A`: `config/llm-providers.yaml` has an unrelated local change.)
