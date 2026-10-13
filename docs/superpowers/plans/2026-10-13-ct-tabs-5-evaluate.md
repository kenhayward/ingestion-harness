# Workbench tabs 5/8: Evaluate and publish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Deviation from the handoff (decided):** the handoff predates #77 (`40385f1`, "make References and Evaluate optional; publish from the Template tab"). This plan follows main: the publish gate is **informational**. The gate card's tag is **BELOW THRESHOLD / MEETS THRESHOLD / PUBLISHED** (plus **NOT MEASURED** when no holdout run decides it; see Review Focus 1), never LOCKED, and its border is warn/ok, never rose. There is **no "Publish anyway…"**, no override panel, no reason textarea, and the handoff test "override button disabled under 10 chars" is dropped. The Holdout meter says "measured against the threshold" (not "decides the gate"); "What is holding it back" becomes **"What's lowering the score"**. The card keeps the **Publish vN** button that #77 kept in `PublishPanel` (never disabled by the gate; `api.publish(projectId, undefined)`); the `ProjectHeader` link to the Template tab and the Template tab's embedded editor stay as they are. Old publications with an `overrideReason` still show it in rose.

**Goal:** Redesign the Evaluate tab (handoff §8) and land EV1: the publish-gate route returns `hints`, the outputs of the deciding holdout run that score below the threshold, each with a plain cause (`no_step` / `low_accuracy`) and the tab that fixes it. The tab gets the gate card (tag, title, Holdout and Dev meters on a 70–100 % scale with the threshold tick, "What's lowering the score" with links, threshold input with validation, "Live: vN · published … at …", Publish vN), the run bar (Holdout / Dev switch, Model select forced to the template's models on holdout, Fresh model calls, Compare models dev-only, primary **Evaluate vN on holdout|dev**), the latest run of the selected set (sample rows as `aria-pressed` buttons with a meter and "Off: …", the comparison table Output · Reference · This run · ✓/✗, dev comments, the violet sealed note on holdout), Accuracy by output (worst first, red/amber/green), and History (an accessible bar chart, the iteration list with Restore, the publications log).

**Architecture:** No migration, no repo change, no `LIST_CACHE_VERSION` bump (the overview and list are untouched). One pure shared function `gateHints({ threshold, scorecard, definition })` in `packages/shared/src/evaluation.ts` (uses `outputCoverage` from `template.ts`) plus `GateHintSchema` and `PublishGateViewSchema = GateViewSchema.extend({ hints })`. Only `GET /api/workbench/projects/:id/publish-gate` computes hints (it scores the gate iteration once with the existing `iterationView`); the overview's `gate` stays a plain `GateView`, so the 300 ms-ish overview polling and the list cache never pay for a scorecard. The web: pure helpers in `apps/web/src/workbench/evaluate.ts`; three new components `GateCard.tsx` (card + `useGate` hook + `PublicationsLog`), `EvaluateLatest.tsx` (`LatestRun`), `EvaluateHistory.tsx` (`AccuracyCard`, `HistoryCard`); `EvaluateTab.tsx` is rewritten to compose them and owns loading/polling per selected set; `PublishPanel.tsx` and its test are deleted (replaced by `GateCard`).

**Tech Stack:** React 19, Vitest + Testing Library, Zod (shared), Fastify + OpenAPI route docs, CSS on existing `--ih-*` tokens.

**Spec:** `docs/design/workbench-tabs/WORKBENCH-TABS-HANDOFF.md` §0 (rules shared by every tab), §8 Evaluate and publish, row **EV1** of "New API", "Tests to add" (Evaluate); screens `docs/design/workbench-tabs/screenshots/light/08-evaluate.png`, `screenshots/states/08c-evaluate-dev-comment.png` (`08b-evaluate-override.png` is superseded by #77).

## Global Constraints

- **Card CSS gotcha:** `.card` has **no padding**. Every new card class (`.gate-card`, `.eval-runbar`, `.eval-compare`, `.eval-latest`, `.eval-accuracy`, `.eval-history`) is added to the shared padding rule at the end of `apps/web/src/styles/stages.css` (`padding: 12px 16px`, the block that starts `/* Workbench tab cards: .card itself has no padding …`) and its `h3` to the `font-weight: 600` rule below it — extend those two selector lists, do not duplicate them.
- **Grids never overflow:** every grid uses `minmax(0, …fr)` tracks (`.gate-card`: `minmax(0, 1.4fr) minmax(0, 1fr)`; `.eval-layout`: `minmax(0, 1.5fr) minmax(0, 1fr)`; `.gate-meter`, `.eval-sample`, `.acc-row`, `.eval-history-row` likewise), every child holding text has `min-width: 0`; all collapse to one column below 760 px. The comparison table and the model-comparison table sit in `.table-scroll` (the existing class in `apps/web/src/styles.css`; do not redefine it). File names, output keys and ids wrap with `overflow-wrap: anywhere`.
- **Sticky side panel:** `.eval-side` is `position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow: auto` (static below 760 px).
- **Disabled buttons carry a `title` reason (tested):** Evaluate ("Start a draft version first", "An evaluation of this set is still running", "A model comparison is still running"), Compare models (the same, plus `COMPARE_HOLDOUT_REASON` on holdout), the Model select on holdout (`HOLDOUT_MODEL_REASON`), Save threshold (the `parseThreshold` error), Save comment ("Write a comment first"), a sample row that was not compared ("Not compared: needs review").
- **Selectable rows are buttons with `aria-pressed`** (sample rows; the set switch is the existing `Segmented`). Links (*Open in Review*) are siblings of the buttons, never inside them.
- **Charts and meters are `role="img"` with a text alternative:** the existing `Meter` (`role="img"`, numbers in `aria-label`); accuracy bars `role="img"` with `accuracyLabel` (percentage, matched of total, and the tone in words, so colour is never the only signal); the History chart `role="img"` with `historySummary`, plus the full iteration list next to it.
- **Holdout is sealed (§0.3):** on a holdout run no *Comment* control is rendered and the violet `.holdout-note` explains why. The API already refuses holdout feedback (400 `feedback can only refer to dev samples` / `… dev iterations`); this PR sends nothing new to a model.
- **Evaluate is optional (#77, `OPTIONAL_STAGES`):** the tab never blocks publishing; the gate card says "Evaluation is optional: you can publish vN at any time."
- **Polling:** only while something runs (an iteration in `history` with `status === 'running'`, or a running comparison), at `pollMs`; stale responses after a set switch are dropped with a sequence ref.
- Tests first (red, then green); never call a real LLM; no Pg integration test is needed (no repository change); `npm run check` green at the end; never `git add -A` (stage the files each task names); commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **NOT MEASURED** is a fourth tag (neutral) when the gate has no score (no deciding holdout run, or it compared nothing): calling an unmeasured draft "BELOW THRESHOLD" would be false. Everything else follows the decided tags.
2. **`gateHints` semantics** (Task 1 table): below the threshold only (at the threshold is not "lowering"), worst first, `no_step` before `low_accuracy` on a tie, then by key, at most `MAX_GATE_HINTS` (5); a column takes its table's coverage; a key the draft does not define counts as `no_step` (no step fills it). Because evaluations refuse an invalid draft (`validateTemplate` flags "is not filled by any step") and the gate only counts runs of the draft as it is now, `no_step` in practice means a reference holds a value the draft has no output for (unpinned legacy references apply to every version) — the API test covers exactly that.
3. **Hints cost:** only `GET …/publish-gate` scores the gate iteration (`iterationView`, the same raw-output comparison the gate uses). `gateFor`, the overview and the list cache are unchanged.
4. **Loading per set:** `EvaluateTab.load` lists iterations and loads the newest of the **selected** set that is not a comparison member (`latestOf`); a set switch reloads, and the sequence ref drops a slower earlier response.
5. **Existing tests rewritten deliberately, not weakened:** `EvaluateTab.test.tsx` — "Evaluate the draft" → "Evaluate v2 on dev|holdout"; the "Set" select → the Holdout/Dev switch; "Fresh model calls (skip the step cache)" → "Fresh model calls" (the explanation moves to `title`); the "Samples"/"Fields in a.pdf"/"Field accuracy"/"History" tables → the Samples button list, "Outputs in a.pdf", "Accuracy by output", "Evaluations" lists (now in `EvaluateLatest.test.tsx` / `EvaluateHistory.test.tsx`); "Score 75%" heading → "2 of 2 compared"; "Comment saved; see the Revise tab" → "Comment saved — see Revise"; the polling test now feeds `listIterations` the running then the finished iteration (the tab reloads the list on each poll). `PublishPanel.test.tsx` is replaced by `GateCard.test.tsx`, keeping every behaviour it tested (publish with no override, threshold saved as a fraction, who set it, refusal shown, publications with override reasons, no gate request without a draft, reload on refresh key).
6. **No dead-end warnings (§0.5):** every hint links to the fixing tab (`#/workbench/:id/steps` or `/revise`), and "Comment saved — see Revise" links to Revise.

---

### Task 1: Shared — `gateHints`, `GateHintSchema`, `PublishGateViewSchema` (EV1 logic)

**Files:**
- Modify: `packages/shared/src/evaluation.ts`, `packages/shared/test/evaluation.test.ts`, `packages/shared/test/dto.test.ts`

**Interfaces:**
- Produces (from `@ih/shared`): `GATE_HINT_CAUSES = ['no_step', 'low_accuracy'] as const`, `GATE_HINT_STAGES = ['steps', 'revise'] as const`, `MAX_GATE_HINTS = 5`, `GateHintSchema` / `GateHint = { key: string; accuracy: number; cause: 'no_step' | 'low_accuracy'; stage: 'steps' | 'revise' }`, `PublishGateViewSchema` / `PublishGateView = GateView & { hints: GateHint[] }`, `gateHints({ threshold, scorecard, definition }): GateHint[]`.
- Consumed by: Task 2 (route), Task 3 (client type, helpers), Task 4 (card).

- [ ] **Step 1: Write the failing tests** — append to `packages/shared/test/evaluation.test.ts` (add `gateHints`, `MAX_GATE_HINTS`, `type Accuracy`, `type GateHint` to the import from `'../src/index.js'`):

```ts
describe('gateHints (EV1)', () => {
  const acc = (id: string, matched: number, total: number): Accuracy => ({
    id,
    matched,
    total,
    accuracy: matched / total,
  });
  const definition = {
    outputs: {
      fields: [{ id: 'sender' }, { id: 'due_date' }],
      tables: [{ id: 'line_items', columns: [{ id: 'qty' }] }],
    },
    pipeline: [
      { type: 'extract', id: 'head', fields: ['sender'] },
      { type: 'extract', id: 'lines', table: 'line_items' },
    ],
  };
  type Case = [string, number, { fields: Accuracy[]; columns: Accuracy[] }, unknown, [string, GateHint['cause']][]];

  it.each<Case>([
    ['nothing below the threshold', 0.9, { fields: [acc('sender', 2, 2)], columns: [] }, definition, []],
    ['at the threshold is not below it', 0.9, { fields: [acc('sender', 9, 10)], columns: [] }, definition, []],
    ['a filled output that is often wrong', 0.9, { fields: [acc('sender', 1, 2)], columns: [] }, definition, [['sender', 'low_accuracy']]],
    ['an output no step fills', 0.9, { fields: [acc('due_date', 0, 2)], columns: [] }, definition, [['due_date', 'no_step']]],
    ['a key the draft does not define', 0.9, { fields: [acc('vat', 0, 2)], columns: [] }, definition, [['vat', 'no_step']]],
    ['a column takes its table coverage', 0.95, { fields: [], columns: [acc('line_items.qty', 13, 14)] }, definition, [['line_items.qty', 'low_accuracy']]],
    ['a column of an undefined table', 0.9, { fields: [], columns: [acc('lines.qty', 0, 4)] }, definition, [['lines.qty', 'no_step']]],
    [
      'worst first, no_step before low_accuracy on a tie, then by key',
      0.9,
      { fields: [acc('sender', 0, 2), acc('due_date', 0, 2), acc('vat', 0, 2)], columns: [acc('line_items.qty', 1, 2)] },
      definition,
      [['due_date', 'no_step'], ['vat', 'no_step'], ['sender', 'low_accuracy'], ['line_items.qty', 'low_accuracy']],
    ],
    ['a malformed definition: nothing is filled', 0.9, { fields: [acc('sender', 0, 1)], columns: [] }, null, [['sender', 'no_step']]],
  ])('%s', (_name, threshold, scorecard, def, expected) => {
    expect(gateHints({ threshold, scorecard, definition: def }).map((h) => [h.key, h.cause])).toEqual(expected);
  });

  it('names the fixing tab and keeps the accuracy', () => {
    expect(
      gateHints({
        threshold: 0.9,
        scorecard: { fields: [acc('due_date', 0, 2), acc('sender', 1, 2)], columns: [] },
        definition,
      }),
    ).toEqual([
      { key: 'due_date', accuracy: 0, cause: 'no_step', stage: 'steps' },
      { key: 'sender', accuracy: 0.5, cause: 'low_accuracy', stage: 'revise' },
    ]);
  });

  it(`keeps at most ${MAX_GATE_HINTS}`, () => {
    const fields = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => acc(id, 0, 1));
    const hints = gateHints({ threshold: 0.9, scorecard: { fields, columns: [] }, definition });
    expect(hints.map((h) => h.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
```

In `packages/shared/test/dto.test.ts`, import `PublishGateViewSchema` and add after the `'GateView'` row:

```ts
  [
    'PublishGateView',
    PublishGateViewSchema,
    {
      threshold: 0.9,
      iterationId: null,
      score: null,
      passes: false,
      reason: 'no run',
      hints: [{ key: 'sender', accuracy: 0, cause: 'no_step', stage: 'steps' }],
    },
    'hints',
  ],
```

- [ ] **Step 2: Run** `npx vitest run --project shared packages/shared/test/evaluation.test.ts packages/shared/test/dto.test.ts` → FAIL (`gateHints` is not a function; `PublishGateViewSchema` undefined).

- [ ] **Step 3: Implement** — `packages/shared/src/evaluation.ts`: add `import { outputCoverage } from './template.js';` (`template.ts` imports only `zod` and `spec.js`: no cycle). After `GateViewSchema`/`GateView`:

```ts
/** Why an output lowers the holdout score (handoff EV1): no step fills it, or it is often wrong. */
export const GATE_HINT_CAUSES = ['no_step', 'low_accuracy'] as const;
/** The tab that fixes each cause: Steps adds the missing step; Revise improves one from dev feedback. */
export const GATE_HINT_STAGES = ['steps', 'revise'] as const;
/** At most this many hints, worst first. */
export const MAX_GATE_HINTS = 5;

export const GateHintSchema = z.object({
  /** A field id or `table.column`, as in the scorecard. */
  key: z.string(),
  accuracy: z.number(),
  cause: z.enum(GATE_HINT_CAUSES),
  stage: z.enum(GATE_HINT_STAGES),
});
export type GateHint = z.infer<typeof GateHintSchema>;

/** `GET …/publish-gate`: the gate and what lowers its score. The overview's gate has no hints. */
export const PublishGateViewSchema = GateViewSchema.extend({ hints: z.array(GateHintSchema) });
export type PublishGateView = z.infer<typeof PublishGateViewSchema>;

/**
 * What lowers the deciding holdout run's score (EV1): its fields and `table.column`s below the
 * threshold, worst first (a missing step before a low accuracy on a tie, then by key), at most
 * `MAX_GATE_HINTS`. `no_step` when no extract step of `definition` fills the output (a column
 * takes its table's coverage; a key the definition does not define is not filled either).
 */
export function gateHints({
  threshold,
  scorecard,
  definition,
}: {
  threshold: number;
  scorecard: Pick<Scorecard, 'fields' | 'columns'>;
  definition: unknown;
}): GateHint[] {
  const filled = new Set(
    outputCoverage(definition)
      .outputs.filter((o) => o.steps.length > 0)
      .map((o) => o.id),
  );
  const hint = (a: Accuracy, output: string): GateHint =>
    filled.has(output)
      ? { key: a.id, accuracy: a.accuracy, cause: 'low_accuracy', stage: 'revise' }
      : { key: a.id, accuracy: a.accuracy, cause: 'no_step', stage: 'steps' };
  const tableOf = (id: string) => {
    const dot = id.indexOf('.');
    return dot < 0 ? id : id.slice(0, dot);
  };
  const rank = (h: GateHint) => (h.cause === 'no_step' ? 0 : 1);
  return [
    ...scorecard.fields.map((a) => hint(a, a.id)),
    ...scorecard.columns.map((a) => hint(a, tableOf(a.id))),
  ]
    .filter((h) => h.accuracy < threshold)
    .sort((a, b) => a.accuracy - b.accuracy || rank(a) - rank(b) || a.key.localeCompare(b.key))
    .slice(0, MAX_GATE_HINTS);
}
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project shared`; `npm run typecheck`; `npx eslint packages/shared`; `npx prettier --write packages/shared/src/evaluation.ts packages/shared/test/evaluation.test.ts packages/shared/test/dto.test.ts` (the `it.each` table is long on purpose; let prettier wrap it).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/evaluation.ts packages/shared/test/evaluation.test.ts packages/shared/test/dto.test.ts
git commit -m "Shared: gate hints, what lowers the holdout score (EV1 logic)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: API — `GET …/publish-gate` returns `hints` (EV1)

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`, `apps/api/test/workbench-publish.test.ts`, `docs/openapi.json` (generated)

**Interfaces:**
- Consumes: `gateHints`, `PublishGateViewSchema`, `type PublishGateView` (Task 1); existing `gateFor` (returns `definition` of the open draft), `workbench.getIteration(projectId, id)`, `iterationView(app, record)`.
- Produces: the route's 200 body is `PublishGateView`.

- [ ] **Step 1: Write the failing tests** — append to the end of `apps/api/test/workbench-publish.test.ts` (it already defines `project`, `holdoutRun`, `gateOf`):

```ts
describe('publish gate hints (EV1)', () => {
  it('has no hints without a deciding holdout run', async () => {
    const ctx = await project();
    expect(await gateOf(ctx)).toMatchObject({ iterationId: null, hints: [] });
  });

  it('has no hints when every output meets the threshold', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    expect(await gateOf(ctx)).toMatchObject({ passes: true, hints: [] });
  });

  it('names an output the run gets wrong, fixed with Revise', async () => {
    const ctx = await project();
    const iteration = await holdoutRun(ctx, 'Wrong');
    expect(await gateOf(ctx)).toMatchObject({
      iterationId: iteration.id,
      passes: false,
      hints: [{ key: 'sender', accuracy: 0, cause: 'low_accuracy', stage: 'revise' }],
    });
  });

  it('names a referenced value no step of the draft fills, fixed on Steps', async () => {
    const ctx = await project();
    const h = await ctx.add(9);
    await ctx.setRole(h.id, 'holdout');
    // An unpinned reference (as legacy ones are) can hold a value the draft has no output for.
    const job = await ctx.repo.createWorkbenchJob(
      {
        id: crypto.randomUUID(),
        filename: h.filename,
        sha256: h.sha256,
        sizeBytes: 1,
        specId: 'letter',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `letter/${h.id}`,
      },
      { projectId: 'letter', task: 'process' },
    );
    await ctx.repo.createReference({
      templateId: 'letter',
      name: h.filename,
      documentId: job.documentId,
      sourceJobId: job.id,
      expected: { fields: { sender: 'Acme', due_date: '2026-10-03' }, tables: {} },
    });
    await ctx.evaluate({ set: 'holdout' });
    const [run] = (await ctx.repo.listProjectRuns('letter')).filter((r) => r.job.referenceId);
    await ctx.finish(run!.job.id, 'Acme');
    expect(await gateOf(ctx)).toMatchObject({
      score: 0.5,
      hints: [{ key: 'due_date', accuracy: 0, cause: 'no_step', stage: 'steps' }],
    });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project api apps/api/test/workbench-publish.test.ts` → FAIL (`hints` is missing from the body).

- [ ] **Step 3: Implement** — `apps/api/src/routes/workbench.ts`: add `PublishGateViewSchema`, `gateHints`, `type PublishGateView` to the `@ih/shared` import. Replace the publish-gate route's `description`, `response` and handler:

```ts
        description: md`
          Whether the open draft meets the holdout bar. Informational only: references and
          evaluation are optional, and publishing never needs the gate. The newest complete
          holdout iteration that evaluated the draft exactly as it is now (version and
          definition), with the template's own models, decides. It passes only when it covered
          every ready holdout sample, compared every sample it evaluated (a job that failed,
          needs review, was cancelled or deleted fails it), and scored at or above the
          project's threshold. \`reason\` says why it passes or fails. Scores are recomputed
          from the models' raw output, so review edits cannot raise them.

          \`hints\` (handoff EV1) are the deciding iteration's fields and \`table.column\`s
          below the threshold, worst first, at most 5: \`no_step\` when no step of the draft
          fills the output (fix on the Steps tab, \`stage: steps\`), else \`low_accuracy\`
          (\`stage: revise\`). Empty without a deciding iteration. The overview's \`gate\`
          carries no hints.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The gate and what lowers its score.', PublishGateViewSchema),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply): Promise<PublishGateView> => {
      const project = await workbench.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const { threshold, iterationId, score, passes, reason, definition } = await gateFor(
        app,
        project,
      );
      const gate = { threshold, iterationId, score, passes, reason };
      if (iterationId === null || definition === null) return { ...gate, hints: [] };
      const iteration = await workbench.getIteration(project.id, iterationId);
      if (!iteration) return { ...gate, hints: [] };
      // The same raw-output comparison the gate scored (holdout iterations ignore review edits).
      const { scorecard } = await iterationView(app, iteration);
      return { ...gate, hints: gateHints({ threshold, scorecard, definition }) };
    },
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npm run openapi`; `npx vitest run --project api` (openapi docs test, conformance — every response checked against `PublishGateViewSchema` — and the access sweep) → PASS; `npm run typecheck`; `npx eslint apps/api`; `npx prettier --write apps/api/src/routes/workbench.ts apps/api/test/workbench-publish.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/test/workbench-publish.test.ts docs/openapi.json
git commit -m "Workbench API: publish gate hints, what lowers the holdout score (EV1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Web — client type, `publishGateView` fake, pure Evaluate helpers

**Files:**
- Create: `apps/web/src/workbench/evaluate.ts`, `apps/web/test/evaluate-derive.test.ts`
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/EvaluateTab.test.tsx`, `apps/web/test/PublishPanel.test.tsx` (mechanical: `gateView` → `publishGateView` where `getPublishGate` is stubbed)

**Interfaces:**
- Produces: `Api.getPublishGate(projectId): Promise<PublishGateView>`; `publishGateView(overrides)` in `fake-api.ts` (default `getPublishGate`); from `evaluate.ts`: `LOW_ACCURACY`, `accuracyTone`, `accuracyLabel`, `accuracyList`, `offOutputs`, `outputsDiffering`, `tableDiff`, `latestOf`, `devScore`, `historyRows` / `HistoryRow`, `historyBars` / `HistoryBar`, `historySummary`, `parseThreshold`, `gateTag`, `gateTitle`, `hintText`, `HINT_LINK`.
- Consumed by: Tasks 4–7.

- [ ] **Step 1: Write the failing tests** — `apps/web/test/evaluate-derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Comparison, GateHint, IterationSummary } from '@ih/shared';
import {
  accuracyLabel,
  accuracyList,
  accuracyTone,
  devScore,
  gateTag,
  gateTitle,
  hintText,
  historyBars,
  historyRows,
  historySummary,
  latestOf,
  offOutputs,
  outputsDiffering,
  parseThreshold,
  tableDiff,
} from '../src/workbench/evaluate.js';
import { iterationView, publishGateView } from './fake-api.js';

const h = (o: Partial<IterationSummary>): IterationSummary => iterationView(o);
const acc = (id: string, matched: number, total: number) => ({
  id,
  matched,
  total,
  accuracy: matched / total,
});
const table = (id: string, o: Partial<Comparison['tables'][number]> = {}) => ({
  id,
  expected: 2,
  actual: 2,
  matched: 2,
  missing: [],
  extra: [],
  changed: [],
  cells: 4,
  cellsTotal: 4,
  columns: {},
  ...o,
});

describe('accuracyTone', () => {
  it.each([
    [0.69, 0.9, 'low'],
    [0.7, 0.9, 'below'],
    [0.89, 0.9, 'below'],
    [0.9, 0.9, 'ok'],
    [0.6, 0.5, 'ok'],
    [1, 1, 'ok'],
  ] as const)('%s against %s is %s', (accuracy, threshold, tone) => {
    expect(accuracyTone(accuracy, threshold)).toBe(tone);
  });

  it('puts the tone in words for the bar label', () => {
    expect(accuracyLabel(acc('due_date', 0, 2), 0.9)).toBe('due_date: 0%, 0 of 2, under 70%');
    expect(accuracyLabel(acc('total', 5, 6), 0.9)).toBe('total: 83%, 5 of 6, under the threshold');
    expect(accuracyLabel(acc('qty', 115, 116), 0.9)).toBe('qty: 99%, 115 of 116, meets the threshold');
  });
});

describe('accuracyList', () => {
  it('lists worst first and only counts what is at 100%', () => {
    const list = accuracyList(
      { fields: [acc('c', 2, 2), acc('a', 0, 2), acc('b', 1, 2)], columns: [acc('t.x', 13, 14)] },
      2,
    );
    expect(list.rows.map((a) => a.id)).toEqual(['a', 'b']);
    expect(list).toMatchObject({ more: 1, perfect: 1 });
  });
});

describe('offOutputs / outputsDiffering / tableDiff', () => {
  const c: Comparison = {
    score: 0.5,
    fields: [
      { id: 'sent_on', expected: '2026-03-01', actual: '2026-01-03', match: false },
      { id: 'sender', expected: 'Acme', actual: 'Acme', match: true },
    ],
    tables: [table('lines', { missing: [{ qty: 1 }], actual: 1, matched: 1 }), table('fees')],
  };
  it('names the differing fields, then the tables with a differing row', () => {
    expect(offOutputs(c)).toEqual(['sent_on', 'lines']);
    expect(outputsDiffering(c)).toEqual({ differ: 2, of: 4 });
  });
  it.each([
    [table('fees'), '2 rows'],
    [table('lines', { actual: 1, missing: [{ qty: 1 }] }), '1 row · 1 missing'],
    [
      table('lines', {
        actual: 3,
        extra: [{ qty: 9 }],
        changed: [{ expected: { qty: 1 }, actual: { qty: 2 }, columns: ['qty'] }],
      }),
      '3 rows · 1 changed · 1 extra',
    ],
  ])('describes a table result', (t, text) => {
    expect(tableDiff(t)).toBe(text);
  });
});

describe('latestOf / devScore', () => {
  const g = crypto.randomUUID();
  const list = [
    h({ id: 'h4', set: 'holdout', templateVersion: 4, score: 0.88 }),
    h({ id: 'run', status: 'running', score: null, templateVersion: 4 }),
    h({ id: 'fast', model: 'fast', templateVersion: 4, score: 0.7 }),
    h({ id: 'cmp', groupId: g, model: 'default', templateVersion: 4, score: 0.99 }),
    h({ id: 'd4', templateVersion: 4, score: 0.91 }),
    h({ id: 'd3', templateVersion: 3, score: 0.92 }),
  ];
  it('takes the newest run of a set that is not part of a comparison', () => {
    expect(latestOf(list, 'dev')?.id).toBe('run');
    expect(latestOf(list, 'holdout')?.id).toBe('h4');
    expect(latestOf([], 'dev')).toBeNull();
  });
  it('scores dev with the newest complete template-model run of the version', () => {
    expect(devScore(list, 4)).toBe(0.91);
    expect(devScore(list, 3)).toBe(0.92);
    expect(devScore(list, 5)).toBeNull();
    expect(devScore(list, null)).toBeNull();
  });
});

describe('historyRows', () => {
  it('collapses a model comparison into one row, models in order, best score', () => {
    const g = crypto.randomUUID();
    const rows = historyRows([
      h({ id: 'x3', model: 'draft', groupId: g, score: 0.89 }),
      h({ id: 'x2', model: 'fast', groupId: g, score: 0.84 }),
      h({ id: 'x1', model: 'default', groupId: g, score: 0.91 }),
      h({ id: 't', uncached: true, score: 0.86 }),
      h({ id: 'r', set: 'holdout', status: 'running', score: null }),
    ]);
    expect(rows.map((r) => [r.label, r.score, r.restoreId, r.running, r.set])).toEqual([
      ['Compare · default 91 · fast 84 · draft 89', 0.91, 'x3', false, 'dev'],
      ["Template's models · fresh", 0.86, 't', false, 'dev'],
      ["Template's models", null, 'r', true, 'holdout'],
    ]);
  });
});

describe('historyBars / historySummary', () => {
  const list = [
    h({ id: 'h4', set: 'holdout', templateVersion: 4, score: 0.88 }),
    h({ id: 'run', status: 'running', score: null }),
    h({ id: 'fast', model: 'fast', score: 0.7 }),
    h({ id: 'cmp', groupId: crypto.randomUUID(), model: 'default', score: 0.91 }),
    h({ id: 'd4', templateVersion: 4, score: 0.91 }),
    h({ id: 'd3', templateVersion: 3, score: 0.92 }),
  ];
  it('keeps finished template-model runs, oldest first, dimming other versions', () => {
    expect(historyBars(list, 4)).toEqual([
      { id: 'd3', version: 3, set: 'dev', score: 0.92, dimmed: true },
      { id: 'd4', version: 4, set: 'dev', score: 0.91, dimmed: false },
      { id: 'h4', version: 4, set: 'holdout', score: 0.88, dimmed: false },
    ]);
    expect(historyBars(list, null).map((b) => b.dimmed)).toEqual([true, false, false]);
    expect(historyBars(list, 4, 2).map((b) => b.id)).toEqual(['d4', 'h4']);
  });
  it('summarises the chart in words', () => {
    expect(historySummary(historyBars(list, 4), 0.9)).toBe(
      '3 template-model runs; latest dev 91% (v4); latest holdout 88% (v4); threshold 90%',
    );
    expect(historySummary(historyBars(list.slice(4), 4), 0.9)).toBe(
      '2 template-model runs; latest dev 91% (v4); no holdout run; threshold 90%',
    );
    expect(historySummary([], 0.9)).toBe('No template-model runs yet');
  });
});

describe('parseThreshold', () => {
  const error = { error: 'Enter a whole percentage from 0 to 100' };
  it.each([
    ['90', { value: 0.9 }],
    ['0', { value: 0 }],
    ['100', { value: 1 }],
    [' 75 ', { value: 0.75 }],
    ['', error],
    ['  ', error],
    ['101', error],
    ['-1', error],
    ['85.5', error],
    ['abc', error],
  ])('%j', (text, expected) => {
    expect(parseThreshold(text)).toEqual(expected);
  });
});

describe('gateTag / gateTitle', () => {
  const below = publishGateView({
    iterationId: crypto.randomUUID(),
    score: 0.88,
    reason: 'holdout score 88% is below the threshold 90%',
  });
  it.each([
    ['no draft', null, null, { label: 'PUBLISHED', tone: 'ok' }],
    ['passing', publishGateView({ passes: true, score: 0.95 }), 4, { label: 'MEETS THRESHOLD', tone: 'ok' }],
    ['below', below, 4, { label: 'BELOW THRESHOLD', tone: 'warn' }],
    ['no deciding run', publishGateView(), 4, { label: 'NOT MEASURED', tone: 'neutral' }],
    ['still loading', null, 4, { label: 'NOT MEASURED', tone: 'neutral' }],
  ] as const)('%s', (_name, gate, draft, tag) => {
    expect(gateTag(gate, draft)).toEqual(tag);
  });
  it('titles the card with the gate reason', () => {
    expect(gateTitle(below, 4, 3)).toBe('Publish v4 — holdout score 88% is below the threshold 90%');
    expect(gateTitle(null, 4, 3)).toBe('Publish v4');
    expect(gateTitle(null, null, 3)).toBe('v3 is live. Start the next version on the Template tab.');
    expect(gateTitle(null, null, null)).toBe('Nothing to publish');
  });
});

describe('hintText', () => {
  it.each<[GateHint, string]>([
    [
      { key: 'due_date', accuracy: 0, cause: 'no_step', stage: 'steps' },
      'due_date scores 0% on holdout: no step of the draft fills it.',
    ],
    [
      { key: 'po_number', accuracy: 0.5, cause: 'low_accuracy', stage: 'revise' },
      'po_number is right on 50% of holdout values. Comment on its dev mismatches, then revise.',
    ],
  ])('%j', (hint, text) => {
    expect(hintText(hint)).toBe(text);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/evaluate-derive.test.ts` → FAIL (module `../src/workbench/evaluate.js` missing; `publishGateView` not exported).

- [ ] **Step 3: Implement**

`apps/web/src/api/client.ts`: import `type PublishGateView` from `@ih/shared`; change the interface line to `getPublishGate(projectId: string): Promise<PublishGateView>;` and the implementation to `.then(json<PublishGateView>)`.

`apps/web/test/fake-api.ts`: import `type PublishGateView`; after `gateView` add

```ts
export function publishGateView(overrides: Partial<PublishGateView> = {}): PublishGateView {
  return { ...gateView(), hints: [], ...overrides };
}
```

and make the default `getPublishGate: vi.fn(async () => publishGateView()),`. In `apps/web/test/EvaluateTab.test.tsx` and `apps/web/test/PublishPanel.test.tsx`, change each `getPublishGate: vi.fn(async () => gateView(…))` to `publishGateView(…)` (import it) so the tree typechecks; both files are replaced in Tasks 4 and 7.

`apps/web/src/workbench/evaluate.ts`:

```ts
import {
  EVALUATION_MODELS,
  type Accuracy,
  type Comparison,
  type EvaluationSet,
  type GateHint,
  type GateView,
  type IterationSummary,
  type Scorecard,
  type TableComparison,
} from '@ih/shared';

/** Pure helpers of the Evaluate tab (handoff §8). */

const pct = (n: number) => `${Math.round(n * 100)}%`;
const DOT = '·';

/** Accuracy colours: red under 70 %, amber under the threshold, green at or above it. */
export const LOW_ACCURACY = 0.7;
export type AccuracyTone = 'low' | 'below' | 'ok';

export function accuracyTone(accuracy: number, threshold: number): AccuracyTone {
  if (accuracy >= threshold) return 'ok';
  return accuracy < LOW_ACCURACY ? 'low' : 'below';
}

const TONE_WORDS: Record<AccuracyTone, string> = {
  low: 'under 70%',
  below: 'under the threshold',
  ok: 'meets the threshold',
};

/** An accuracy bar's text alternative: the colour in words, never colour alone. */
export function accuracyLabel(a: Accuracy, threshold: number): string {
  return `${a.id}: ${pct(a.accuracy)}, ${a.matched} of ${a.total}, ${TONE_WORDS[accuracyTone(a.accuracy, threshold)]}`;
}

export const ACCURACY_ROWS = 8;

/** Fields and columns worst first; those at 100 % are only counted. */
export function accuracyList(
  scorecard: Pick<Scorecard, 'fields' | 'columns'>,
  limit = ACCURACY_ROWS,
): { rows: Accuracy[]; more: number; perfect: number } {
  const all = [...scorecard.fields, ...scorecard.columns].sort(
    (a, b) => a.accuracy - b.accuracy || a.id.localeCompare(b.id),
  );
  const imperfect = all.filter((a) => a.accuracy < 1);
  const rows = imperfect.slice(0, limit);
  return { rows, more: imperfect.length - rows.length, perfect: all.length - imperfect.length };
}

const tableDiffers = (t: TableComparison) => t.missing.length + t.extra.length + t.changed.length > 0;

/** "Off: …": the fields that differ, then the tables with a missing, extra or changed row. */
export function offOutputs(c: Comparison): string[] {
  return [
    ...c.fields.filter((f) => !f.match).map((f) => f.id),
    ...c.tables.filter(tableDiffers).map((t) => t.id),
  ];
}

export function outputsDiffering(c: Comparison): { differ: number; of: number } {
  return { differ: offOutputs(c).length, of: c.fields.length + c.tables.length };
}

const rows = (n: number) => `${n} row${n === 1 ? '' : 's'}`;

/** A table's actual rows and, when it differs, the non-zero changed / missing / extra counts. */
export function tableDiff(t: TableComparison): string {
  const parts = [
    [t.changed.length, 'changed'],
    [t.missing.length, 'missing'],
    [t.extra.length, 'extra'],
  ] as const;
  return [rows(t.actual), ...parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`)].join(
    ` ${DOT} `,
  );
}

/** The newest iteration of a set that is not a member of a model comparison. */
export function latestOf(
  history: readonly IterationSummary[],
  set: EvaluationSet,
): IterationSummary | null {
  return history.find((h) => h.set === set && h.groupId === null) ?? null;
}

const templateRun = (h: IterationSummary) => h.model === null && h.groupId === null;

/** The Dev meter: the newest complete dev run of `version` with the template's own models. */
export function devScore(history: readonly IterationSummary[], version: number | null): number | null {
  if (version === null) return null;
  return (
    history.find(
      (h) =>
        h.set === 'dev' && templateRun(h) && h.status === 'complete' && h.templateVersion === version,
    )?.score ?? null
  );
}

export interface HistoryRow {
  id: string;
  /** The iteration Restore uses (a comparison's members share the definition snapshot). */
  restoreId: string;
  version: number;
  set: EvaluationSet;
  label: string;
  createdAt: string;
  /** Null while running or when nothing was compared. */
  score: number | null;
  running: boolean;
}

const modelRank = (h: IterationSummary) => (h.model ? EVALUATION_MODELS.indexOf(h.model) : -1);
const scoreOf = (h: IterationSummary) => (h.status === 'complete' ? h.score : null);
const whole = (n: number | null) => (n === null ? '–' : String(Math.round(n * 100)));

/** The iteration list, newest first; a model comparison is one row ("Compare · default 91 · …"). */
export function historyRows(history: readonly IterationSummary[]): HistoryRow[] {
  const members = new Map<string, IterationSummary[]>();
  for (const h of history) {
    if (h.groupId) members.set(h.groupId, [...(members.get(h.groupId) ?? []), h]);
  }
  const seen = new Set<string>();
  return history.flatMap((h): HistoryRow[] => {
    const base = { id: h.id, restoreId: h.id, version: h.templateVersion, set: h.set, createdAt: h.createdAt };
    const fresh = h.uncached ? ` ${DOT} fresh` : '';
    if (!h.groupId) {
      return [
        {
          ...base,
          label: `${h.model ?? "Template's models"}${fresh}`,
          score: scoreOf(h),
          running: h.status === 'running',
        },
      ];
    }
    if (seen.has(h.groupId)) return [];
    seen.add(h.groupId);
    const group = [...members.get(h.groupId)!].sort((a, b) => modelRank(a) - modelRank(b));
    const scores = group.map(scoreOf).filter((s): s is number => s !== null);
    return [
      {
        ...base,
        label: `Compare ${DOT} ${group.map((g) => `${g.model ?? 'template'} ${whole(scoreOf(g))}`).join(` ${DOT} `)}${fresh}`,
        score: scores.length ? Math.max(...scores) : null,
        running: group.some((g) => g.status === 'running'),
      },
    ];
  });
}

export interface HistoryBar {
  id: string;
  version: number;
  set: EvaluationSet;
  score: number;
  /** A run of another version than the current one. */
  dimmed: boolean;
}

export const HISTORY_BARS = 12;

/** The chart: finished template-model runs with a score, the newest `limit`, oldest first. */
export function historyBars(
  history: readonly IterationSummary[],
  version: number | null,
  limit = HISTORY_BARS,
): HistoryBar[] {
  const current = version ?? Math.max(0, ...history.map((h) => h.templateVersion));
  return history
    .filter((h) => templateRun(h) && h.status === 'complete' && h.score !== null)
    .slice(0, limit)
    .reverse()
    .map((h) => ({
      id: h.id,
      version: h.templateVersion,
      set: h.set,
      score: h.score!,
      dimmed: h.templateVersion !== current,
    }));
}

/** The chart's text alternative. */
export function historySummary(bars: readonly HistoryBar[], threshold: number): string {
  if (!bars.length) return 'No template-model runs yet';
  const part = (set: EvaluationSet) => {
    const b = [...bars].reverse().find((x) => x.set === set);
    return b ? `latest ${set} ${pct(b.score)} (v${b.version})` : `no ${set} run`;
  };
  return `${bars.length} template-model runs; ${part('dev')}; ${part('holdout')}; threshold ${pct(threshold)}`;
}

/** The threshold box: a whole percentage from 0 to 100, as a fraction. */
export function parseThreshold(text: string): { value: number } | { error: string } {
  const t = text.trim();
  const n = Number(t);
  if (t === '' || !Number.isInteger(n) || n < 0 || n > 100) {
    return { error: 'Enter a whole percentage from 0 to 100' };
  }
  return { value: n / 100 };
}

export interface GateTag {
  label: 'PUBLISHED' | 'MEETS THRESHOLD' | 'BELOW THRESHOLD' | 'NOT MEASURED';
  tone: 'ok' | 'warn' | 'neutral';
}

/** Informational (#77): nothing is ever locked. */
export function gateTag(gate: GateView | null, draft: number | null): GateTag {
  if (draft === null) return { label: 'PUBLISHED', tone: 'ok' };
  if (gate?.passes) return { label: 'MEETS THRESHOLD', tone: 'ok' };
  if (!gate || gate.score === null) return { label: 'NOT MEASURED', tone: 'neutral' };
  return { label: 'BELOW THRESHOLD', tone: 'warn' };
}

export function gateTitle(gate: GateView | null, draft: number | null, published: number | null): string {
  if (draft === null) {
    return published === null
      ? 'Nothing to publish'
      : `v${published} is live. Start the next version on the Template tab.`;
  }
  return gate ? `Publish v${draft} — ${gate.reason}` : `Publish v${draft}`;
}

/** A hint in plain words (EV1); the link text comes from `HINT_LINK`. */
export function hintText(h: GateHint): string {
  return h.cause === 'no_step'
    ? `${h.key} scores ${pct(h.accuracy)} on holdout: no step of the draft fills it.`
    : `${h.key} is right on ${pct(h.accuracy)} of holdout values. Comment on its dev mismatches, then revise.`;
}

export const HINT_LINK: Record<GateHint['stage'], string> = {
  steps: 'Open Steps',
  revise: 'Open Revise',
};
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web`; `npm run typecheck`; `npx eslint apps/web`; `npx prettier --write apps/web/src/workbench/evaluate.ts apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/test/evaluate-derive.test.ts apps/web/test/EvaluateTab.test.tsx apps/web/test/PublishPanel.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/evaluate.ts apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/test/evaluate-derive.test.ts apps/web/test/EvaluateTab.test.tsx apps/web/test/PublishPanel.test.tsx
git commit -m "Workbench web: gate hints in the client and pure Evaluate helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Gate card — `GateCard`, `useGate`, `PublicationsLog`

**Files:**
- Create: `apps/web/src/workbench/GateCard.tsx`, `apps/web/test/GateCard.test.tsx`
- Modify: `apps/web/src/styles/stages.css`

**Interfaces:**
- Produces: `useGate(api, projectId, draft, refreshKey) → { gate: PublishGateView | null; publications: Publication[]; threshold: ThresholdInfo | null; error: string | null; reload(): Promise<void> }`; `GateCard` props `{ api, projectId, draft, published, gate, publications, threshold, devScore, onChanged, onPublished }`; `PublicationsLog({ publications })`; `ThresholdInfo = { value: number; setBy: string | null; setAt: string | null }`.
- Consumed by: Task 6 (`PublicationsLog`), Task 7 (`EvaluateTab`).

- [ ] **Step 1: Write the failing tests** — `apps/web/test/GateCard.test.tsx`:

```tsx
import type { ComponentProps } from 'react';
import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api/client.js';
import { GateCard, PublicationsLog, useGate } from '../src/workbench/GateCard.js';
import { fakeApi, projectView, publication, publishGateView } from './fake-api.js';

function card(props: Partial<ComponentProps<typeof GateCard>> = {}, overrides: Partial<Api> = {}) {
  const api = fakeApi({
    setPublishThreshold: vi.fn(async () => projectView()),
    publish: vi.fn(async () => ({ publication: publication({ version: 2 }), project: projectView() })),
    ...overrides,
  });
  const onChanged = vi.fn();
  const onPublished = vi.fn();
  render(
    <GateCard
      api={api}
      projectId="letter"
      draft={2}
      published={1}
      gate={publishGateView()}
      publications={[]}
      threshold={{ value: 0.9, setBy: null, setAt: null }}
      devScore={null}
      onChanged={onChanged}
      onPublished={onPublished}
      {...props}
    />,
  );
  return { api, onChanged, onPublished };
}

const below = publishGateView({
  iterationId: crypto.randomUUID(),
  score: 0.88,
  reason: 'holdout score 88% is below the threshold 90%',
});

describe('GateCard', () => {
  it('is informational below the threshold: Publish stays available, no override', () => {
    card({ gate: below, devScore: 0.91 });
    const gate = screen.getByRole('region', { name: 'Publish gate' });
    expect(within(gate).getByText('BELOW THRESHOLD')).toBeInTheDocument();
    expect(
      within(gate).getByRole('heading', {
        name: 'Publish v2 — holdout score 88% is below the threshold 90%',
      }),
    ).toBeInTheDocument();
    expect(within(gate).getByRole('img', { name: 'Holdout score: 88%, threshold 90%' })).toBeInTheDocument();
    expect(within(gate).getByRole('img', { name: 'Dev score: 91%, threshold 90%' })).toBeInTheDocument();
    expect(within(gate).getByText('measured against the threshold')).toBeInTheDocument();
    expect(within(gate).getByText('guides your changes')).toBeInTheDocument();
    expect(within(gate).getByRole('button', { name: 'Publish v2' })).toBeEnabled();
    expect(within(gate).queryByText(/LOCKED/)).toBeNull();
    expect(within(gate).queryByRole('button', { name: /Publish anyway/ })).toBeNull();
    expect(within(gate).queryByLabelText(/override/i)).toBeNull();
    expect(within(gate).getByText('Evaluation is optional: you can publish v2 at any time.')).toBeInTheDocument();
  });

  it('meets the threshold', () => {
    card({ gate: publishGateView({ passes: true, score: 0.95, iterationId: crypto.randomUUID() }) });
    expect(screen.getByText('MEETS THRESHOLD')).toBeInTheDocument();
  });

  it('says when no holdout run measures the draft', () => {
    card();
    expect(screen.getByText('NOT MEASURED')).toBeInTheDocument();
    expect(
      screen.getByText('No holdout run of v2 yet. Run one below to measure v2 against the threshold.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Holdout score: no score yet' })).toBeInTheDocument();
  });

  it('shows a published version without meters or a Publish button', () => {
    card({ draft: null, published: 2, gate: null });
    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'v2 is live. Start the next version on the Template tab.' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Publish v/ })).toBeNull();
  });

  it("lists what's lowering the score with a link to the fixing tab", () => {
    card({
      gate: {
        ...below,
        hints: [
          { key: 'due_date', accuracy: 0, cause: 'no_step', stage: 'steps' },
          { key: 'po_number', accuracy: 0.5, cause: 'low_accuracy', stage: 'revise' },
        ],
      },
    });
    const hints = screen.getByRole('complementary', { name: "What's lowering the score" });
    const items = within(hints).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('due_date scores 0% on holdout: no step of the draft fills it.');
    expect(within(items[0]!).getByRole('link', { name: 'Open Steps' })).toHaveAttribute(
      'href',
      '#/workbench/letter/steps',
    );
    expect(within(items[1]!).getByRole('link', { name: 'Open Revise' })).toHaveAttribute(
      'href',
      '#/workbench/letter/revise',
    );
  });

  it('says when nothing is below the threshold', () => {
    card({ gate: publishGateView({ iterationId: crypto.randomUUID(), score: 0.95, passes: true }) });
    expect(screen.getByText('No output is below the threshold.')).toBeInTheDocument();
  });

  it('validates the threshold and saves it as a fraction', async () => {
    const { api, onChanged } = card();
    const input = screen.getByLabelText('Publish threshold (%)');
    const save = screen.getByRole('button', { name: 'Save threshold' });
    expect(input).toHaveValue(90);
    for (const bad of ['', '120', '85.5']) {
      await userEvent.clear(input);
      if (bad) await userEvent.type(input, bad);
      expect(save).toBeDisabled();
      expect(save).toHaveAttribute('title', 'Enter a whole percentage from 0 to 100');
    }
    await userEvent.clear(input);
    await userEvent.type(input, '80');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(api.setPublishThreshold).toHaveBeenCalledWith('letter', 0.8);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('shows who last set the threshold, and when', () => {
    const at = '2026-10-01T09:30:00.000Z';
    card({ threshold: { value: 0.9, setBy: 'ken', setAt: at } });
    expect(
      screen.getByText(`Threshold set by ken on ${new Date(at).toLocaleDateString()}`),
    ).toBeInTheDocument();
  });

  it('names the live version', () => {
    const at = '2026-10-02T11:04:00.000Z';
    card({ publications: [publication({ version: 1, score: 0.9, publishedAt: at })] });
    expect(
      screen.getByText(`Live: v1 · published ${new Date(at).toLocaleDateString()} at 90%`),
    ).toBeInTheDocument();
  });

  it('says when nothing is live', () => {
    card({ published: null });
    expect(screen.getByText('Not published yet')).toBeInTheDocument();
  });

  it('publishes with no override reason', async () => {
    const { api, onPublished, onChanged } = card({ gate: below });
    await userEvent.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect(api.publish).toHaveBeenCalledWith('letter', undefined);
    expect(await screen.findByText('Published v2')).toBeInTheDocument();
    expect(onPublished).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows why the API refused', async () => {
    card({}, { publish: vi.fn(async () => Promise.reject(new Error('the draft is not valid'))) });
    await userEvent.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the draft is not valid');
  });
});

describe('PublicationsLog', () => {
  it('lists publications, keeping old override reasons', () => {
    render(
      <PublicationsLog
        publications={[
          publication({ version: 2, score: 0.95 }),
          publication({ version: 1, score: 0.87, overrideReason: 'AP pilot needed it' }),
        ]}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Publications' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('v2');
    expect(items[0]).toHaveTextContent('95%');
    expect(items[1]).toHaveTextContent('override: AP pilot needed it');
  });

  it('renders nothing without publications', () => {
    const { container } = render(<PublicationsLog publications={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('useGate', () => {
  it('asks for no gate without a draft', async () => {
    const api = fakeApi({ getProject: vi.fn(async () => projectView()) });
    const { result } = renderHook(() => useGate(api, 'letter', null, ''));
    await waitFor(() => expect(result.current.threshold).toEqual({ value: 0.9, setBy: null, setAt: null }));
    expect(api.getPublishGate).not.toHaveBeenCalled();
    expect(result.current.gate).toBeNull();
  });

  it('reloads when the refresh key changes', async () => {
    const api = fakeApi({ getProject: vi.fn(async () => projectView()) });
    const { rerender } = renderHook(({ k }) => useGate(api, 'letter', 2, k), {
      initialProps: { k: 'a' },
    });
    await waitFor(() => expect(api.getPublishGate).toHaveBeenCalledTimes(1));
    rerender({ k: 'b' });
    await waitFor(() => expect(api.getPublishGate).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/GateCard.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement** — `apps/web/src/workbench/GateCard.tsx`:

```tsx
import { useCallback, useEffect, useId, useState } from 'react';
import type { Publication, PublishGateView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Meter } from '../ui/Meter.js';
import { gateTag, gateTitle, HINT_LINK, hintText, parseThreshold } from './evaluate.js';

const DOT = '·';
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);
/** The meters' scale (handoff §8): 70–100 %. */
const SCALE_MIN = 0.7;

export interface ThresholdInfo {
  value: number;
  setBy: string | null;
  setAt: string | null;
}

/** The gate (with EV1 hints), the publication log and the threshold; reloads on `refreshKey`. */
export function useGate(api: Api, projectId: string, draft: number | null, refreshKey: string) {
  const [state, setState] = useState<{
    gate: PublishGateView | null;
    publications: Publication[];
    threshold: ThresholdInfo | null;
  }>({ gate: null, publications: [], threshold: null });
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const [gate, publications, view] = await Promise.all([
        draft === null ? null : api.getPublishGate(projectId),
        api.listPublications(projectId),
        api.getProject(projectId),
      ]);
      const { publishThreshold, thresholdSetBy, thresholdSetAt } = view.project;
      setState({
        gate,
        publications,
        threshold: { value: publishThreshold, setBy: thresholdSetBy, setAt: thresholdSetAt },
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId, draft]);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  return { ...state, error, reload };
}

function GateMeter({
  name,
  note,
  value,
  threshold,
  tone,
}: {
  name: string;
  note: string;
  value: number | null;
  threshold: number;
  tone: 'skip' | 'accent';
}) {
  return (
    <div className="gate-meter">
      <span className="gate-meter-name">
        <strong>{name}</strong>
        <small className="muted">{note}</small>
      </span>
      <Meter label={`${name} score`} value={value} min={SCALE_MIN} threshold={threshold} tone={tone} />
      <span className="gate-figure">{pct(value)}</span>
    </div>
  );
}

/**
 * The publish gate (handoff §8 after #77): informational, never locked. Tag and title, the
 * Holdout and Dev meters, what lowers the score (EV1 hints, linked to the fixing tab), the
 * threshold, the live version and Publish vN.
 */
export function GateCard({
  api,
  projectId,
  draft,
  published,
  gate,
  publications,
  threshold,
  devScore,
  onChanged,
  onPublished,
}: {
  api: Api;
  projectId: string;
  draft: number | null;
  published: number | null;
  gate: PublishGateView | null;
  /** Newest first. */
  publications: Publication[];
  threshold: ThresholdInfo | null;
  /** Newest complete dev score of the draft with the template's models. */
  devScore: number | null;
  /** The gate or the threshold may have changed: reload them. */
  onChanged: () => void;
  onPublished: () => void;
}) {
  const hintsId = useId();
  const saved = threshold?.value;
  const [text, setText] = useState(saved === undefined ? '' : String(Math.round(saved * 100)));
  useEffect(() => {
    if (saved !== undefined) setText(String(Math.round(saved * 100)));
  }, [saved]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justPublished, setJustPublished] = useState<number | null>(null);

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
  const parsed = parseThreshold(text);
  const save = () =>
    act(async () => {
      if (!('value' in parsed)) return;
      await api.setPublishThreshold(projectId, parsed.value);
      onChanged();
    });
  const publish = () =>
    act(async () => {
      const result = await api.publish(projectId, undefined);
      setJustPublished(result.publication.version);
      onPublished();
      onChanged();
    });

  const tag = gateTag(gate, draft);
  const limit = gate?.threshold ?? saved ?? 0.9;
  const holdout = gate && gate.iterationId !== null ? gate.score : null;
  const live = publications[0] ?? null;
  return (
    <section className="card gate-card" data-tone={tag.tone} aria-label="Publish gate">
      <div className="gate-main">
        <div className="gate-head">
          <span className="gate-tag" data-tone={tag.tone}>
            {tag.label}
          </span>
          <h3>{gateTitle(gate, draft, published)}</h3>
        </div>
        {draft !== null && (
          <>
            <GateMeter
              name="Holdout"
              note="measured against the threshold"
              value={holdout}
              threshold={limit}
              tone="skip"
            />
            <GateMeter name="Dev" note="guides your changes" value={devScore} threshold={limit} tone="accent" />
            <div className="gate-scale" aria-hidden="true">
              <span>70%</span>
              <span>Threshold {pct(limit)}</span>
              <span>100%</span>
            </div>
            <p className="muted gate-optional">
              Evaluation is optional: you can publish v{draft} at any time.
            </p>
          </>
        )}
      </div>
      {draft !== null && (
        <aside className="gate-hints" data-tone={tag.tone} aria-labelledby={hintsId}>
          <h4 id={hintsId}>What&apos;s lowering the score</h4>
          {gate === null ? (
            <p className="muted">Checking the gate…</p>
          ) : gate.iterationId === null ? (
            <p>
              No holdout run of v{draft} yet. Run one below to measure v{draft} against the
              threshold.
            </p>
          ) : gate.hints.length === 0 ? (
            <p>No output is below the threshold.</p>
          ) : (
            <ul>
              {gate.hints.map((h) => (
                <li key={h.key}>
                  {hintText(h)}{' '}
                  <a href={`#/workbench/${projectId}/${h.stage}`}>{HINT_LINK[h.stage]}</a>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
      <div className="gate-foot">
        <label className="gate-threshold">
          Publish threshold (%){' '}
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy || 'error' in parsed}
          title={'error' in parsed ? parsed.error : busy ? 'Saving…' : undefined}
          onClick={() => void save()}
        >
          Save threshold
        </button>
        {threshold?.setBy && threshold.setAt && (
          <small className="muted">
            Threshold set by {threshold.setBy} on {new Date(threshold.setAt).toLocaleDateString()}
          </small>
        )}
        <span className="muted gate-live">
          {live
            ? `Live: v${live.version} ${DOT} published ${new Date(live.publishedAt).toLocaleDateString()} at ${live.score === null ? 'no holdout score' : pct(live.score)}`
            : 'Not published yet'}
        </span>
        {draft !== null && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            title={busy ? 'Working…' : undefined}
            onClick={() => void publish()}
          >
            Publish v{draft}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {justPublished !== null && <p role="status">Published v{justPublished}</p>}
    </section>
  );
}

/** Every Workbench publication, newest first; overrides (from before #77) in rose. */
export function PublicationsLog({ publications }: { publications: Publication[] }) {
  if (!publications.length) return null;
  return (
    <div className="publications">
      <h4>Publications</h4>
      <ul aria-label="Publications">
        {publications.map((p) => (
          <li key={p.id}>
            <strong>v{p.version}</strong> {DOT} {new Date(p.publishedAt).toLocaleDateString()} {DOT}{' '}
            {pct(p.score)}
            {p.overrideReason && (
              <span className="publication-override">
                {' '}
                {DOT} override: {p.overrideReason}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Note the "Not published yet" test passes `published: null` with empty publications; the live line reads only `publications` (a version published from the Templates route before the Workbench existed has no publication row, so it is not named here).

CSS — `apps/web/src/styles/stages.css`: add `.gate-card` to the card padding list and `.gate-card h3` to the `font-weight: 600` list, then append:

```css
/* Evaluate: gate card (handoff §8 after #77: informational, never locked) */
.gate-card {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 12px 20px;
  border-color: var(--ih-border);
}
.gate-card[data-tone='ok'] {
  border-color: var(--ih-ok-fg);
}
.gate-card[data-tone='warn'] {
  border-color: var(--ih-warn-fg);
}
.gate-main,
.gate-hints {
  min-width: 0;
}
.gate-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.gate-head h3 {
  margin: 0;
  overflow-wrap: anywhere;
}
.gate-tag {
  padding: 2px 8px;
  border-radius: var(--ih-radius-sm);
  font-size: var(--ih-text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  background: var(--ih-neutral-bg);
  color: var(--ih-neutral-fg);
}
.gate-tag[data-tone='ok'] {
  background: var(--ih-ok-bg);
  color: var(--ih-ok-fg);
}
.gate-tag[data-tone='warn'] {
  background: var(--ih-warn-bg);
  color: var(--ih-warn-fg);
}
.gate-meter {
  display: grid;
  grid-template-columns: minmax(0, 120px) minmax(0, 1fr) 48px;
  align-items: center;
  gap: 12px;
  margin: 8px 0;
}
.gate-meter-name {
  display: grid;
  min-width: 0;
}
.gate-figure {
  font-weight: 600;
  text-align: right;
}
.gate-scale {
  display: flex;
  justify-content: space-between;
  margin-left: calc(min(120px, 30%) + 12px);
  margin-right: 60px;
  color: var(--ih-muted);
  font-size: var(--ih-text-xs);
}
.gate-hints {
  padding: 12px 16px;
  border-radius: var(--ih-radius-md);
  background: var(--ih-neutral-bg);
}
.gate-hints[data-tone='warn'] {
  background: var(--ih-warn-bg);
}
.gate-hints[data-tone='ok'] {
  background: var(--ih-ok-bg);
}
.gate-hints h4 {
  margin: 0 0 6px;
  font-weight: 600;
}
.gate-hints ul {
  margin: 0;
  padding-left: 18px;
}
.gate-hints li {
  overflow-wrap: anywhere;
}
.gate-foot {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding-top: 12px;
  border-top: 1px solid var(--ih-border-soft);
}
.gate-threshold input {
  width: 72px;
}
.gate-foot .primary {
  margin-left: auto;
}
.publication-override {
  color: var(--ih-lock-fg);
}
@media (max-width: 760px) {
  .gate-card {
    grid-template-columns: minmax(0, 1fr);
  }
  .gate-meter {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .gate-meter .meter {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .gate-scale {
    margin: 0;
  }
}
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web`; `npm run typecheck`; `npx eslint apps/web`; `npx prettier --write apps/web/src/workbench/GateCard.tsx apps/web/test/GateCard.test.tsx apps/web/src/styles/stages.css`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/GateCard.tsx apps/web/test/GateCard.test.tsx apps/web/src/styles/stages.css
git commit -m "Workbench web: informational gate card with hints, meters and threshold check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Latest run — sample rows, comparison table, dev comments, sealed holdout

**Files:**
- Create: `apps/web/src/workbench/EvaluateLatest.tsx`, `apps/web/test/EvaluateLatest.test.tsx`
- Modify: `apps/web/src/styles/stages.css`

**Interfaces:**
- Produces: `LatestRun({ api, projectId, iteration: IterationView | null, set: EvaluationSet, threshold: number })`, `SEALED_NOTE`.
- Consumes: `offOutputs`, `outputsDiffering`, `tableDiff` (Task 3), `Meter`, `api.addFeedback`.

- [ ] **Step 1: Write the failing tests** — `apps/web/test/EvaluateLatest.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { EvaluationSet, IterationView } from '@ih/shared';
import type { Api } from '../src/api/client.js';
import { LatestRun, SEALED_NOTE } from '../src/workbench/EvaluateLatest.js';
import { fakeApi, feedbackItem, iterationView } from './fake-api.js';

function latest(
  iteration: IterationView | null,
  overrides: Partial<Api> = {},
  set: EvaluationSet = iteration?.set ?? 'dev',
) {
  const api = fakeApi(overrides);
  render(<LatestRun api={api} projectId="letter" iteration={iteration} set={set} threshold={0.9} />);
  return { api };
}
const row = (name: RegExp) => screen.getByRole('button', { name });

describe('LatestRun', () => {
  it('heads the run with its set, version, model, compared count and cache reuse', () => {
    latest(iterationView({ cache: { reused: 5, total: 8 } }));
    expect(
      screen.getByRole('heading', { name: "Latest dev run · v2 · template's models" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 of 2 compared · 5 of 8 steps reused from the cache/)).toBeInTheDocument();
  });

  it('lists the samples as selectable rows with a score bar and what is off', () => {
    latest(iterationView());
    const a = row(/^a\.pdf/);
    expect(a).toHaveAttribute('aria-pressed', 'false');
    expect(within(a).getByText('50%')).toBeInTheDocument();
    expect(within(a).getByText('Off: sent_on')).toBeInTheDocument();
    expect(within(a).getByLabelText('a.pdf score: 50%, threshold 90%')).toBeInTheDocument();
    expect(within(row(/^b\.pdf/)).getByText('All match')).toBeInTheDocument();
  });

  it('opens the comparison table for the selected sample, and closes it again', async () => {
    latest(iterationView());
    await userEvent.click(row(/^a\.pdf/));
    expect(row(/^a\.pdf/)).toHaveAttribute('aria-pressed', 'true');
    const table = screen.getByRole('table', { name: 'Outputs in a.pdf' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Output', 'Reference', 'This run', 'Match', 'Comment']);
    const sentOn = within(table).getByText('sent_on').closest('tr')!;
    expect(sentOn).toHaveTextContent('2026-03-01');
    expect(sentOn).toHaveTextContent('2026-01-03');
    expect(within(sentOn).getByRole('img', { name: 'differs' })).toBeInTheDocument();
    expect(within(sentOn).getByRole('button', { name: 'Comment' })).toBeInTheDocument();
    const sender = within(table).getByText('sender').closest('tr')!;
    expect(within(sender).getByRole('img', { name: 'matches' })).toBeInTheDocument();
    expect(within(sender).queryByRole('button', { name: 'Comment' })).toBeNull();
    expect(screen.getByText(/1 of 2 outputs differ from the reference/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Review' })).toHaveAttribute('href', '#/review/j1');
    await userEvent.click(row(/^a\.pdf/));
    expect(screen.queryByRole('table', { name: 'Outputs in a.pdf' })).toBeNull();
  });

  it('saves a comment on a dev mismatch for Revise', async () => {
    const it0 = iterationView();
    const { api } = latest(it0, { addFeedback: vi.fn(async () => feedbackItem()) });
    await userEvent.click(row(/^a\.pdf/));
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const save = screen.getByRole('button', { name: 'Save comment' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'Write a comment first');
    const box = screen.getByLabelText(/^Comment on sent_on/);
    expect(box).toHaveAttribute('maxlength', '2000');
    await userEvent.type(box, 'Dates are DMY');
    await userEvent.click(save);
    expect(api.addFeedback).toHaveBeenCalledWith('letter', {
      target: 'field',
      targetId: 'sent_on',
      body: 'Dates are DMY',
      sampleId: 's1',
      iterationId: it0.id,
    });
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Comment saved — see Revise');
    expect(within(status).getByRole('link', { name: 'Revise' })).toHaveAttribute(
      'href',
      '#/workbench/letter/revise',
    );
  });

  it('keeps a comment that failed to save and shows why', async () => {
    latest(iterationView(), {
      addFeedback: vi.fn(async () => Promise.reject(new Error('feedback can only refer to dev samples'))),
    });
    await userEvent.click(row(/^a\.pdf/));
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await userEvent.type(screen.getByLabelText(/^Comment on sent_on/), 'Dates are DMY');
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('feedback can only refer to dev samples');
    expect(screen.getByLabelText(/^Comment on sent_on/)).toHaveValue('Dates are DMY');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('comments on a table that differs', async () => {
    const base = iterationView();
    const it0 = iterationView({
      samples: [
        {
          ...base.samples[0]!,
          comparison: {
            score: 0.5,
            fields: [],
            tables: [
              {
                id: 'lines',
                expected: 2,
                actual: 1,
                matched: 1,
                missing: [{ qty: 1 }],
                extra: [],
                changed: [],
                cells: 1,
                cellsTotal: 2,
                columns: { qty: { matched: 1, total: 2 } },
              },
            ],
          },
        },
      ],
    });
    const { api } = latest(it0, { addFeedback: vi.fn(async () => feedbackItem()) });
    await userEvent.click(row(/^a\.pdf/));
    const lines = screen.getByText('lines').closest('tr')!;
    expect(lines).toHaveTextContent('2 rows');
    expect(lines).toHaveTextContent('1 row · 1 missing');
    await userEvent.click(within(lines).getByRole('button', { name: 'Comment' }));
    await userEvent.type(screen.getByLabelText(/^Comment on lines/), 'Rows run onto page 3');
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }));
    expect(api.addFeedback).toHaveBeenCalledWith(
      'letter',
      expect.objectContaining({ target: 'table', targetId: 'lines' }),
    );
  });

  it('keeps holdout sealed: differences are shown, comments are not', async () => {
    latest(iterationView({ set: 'holdout' }));
    expect(screen.getByRole('heading', { name: /^Latest holdout run/ })).toBeInTheDocument();
    await userEvent.click(row(/^a\.pdf/));
    expect(screen.getByText(SEALED_NOTE)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Outputs in a.pdf' });
    expect(within(table).queryByRole('button', { name: 'Comment' })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: 'Comment' })).toBeNull();
  });

  it('cannot select a sample that was not compared, and says why', () => {
    const base = iterationView();
    latest(
      iterationView({
        samples: [
          ...base.samples,
          {
            sampleId: 's3',
            filename: 'c.pdf',
            jobId: 'j3',
            status: 'needs_review',
            error: null,
            comparison: null,
          },
        ],
      }),
    );
    const c = row(/^c\.pdf/);
    expect(c).toBeDisabled();
    expect(c).toHaveAttribute('title', 'Not compared: needs review');
    expect(c).toHaveTextContent('needs review');
  });

  it('says when the set has no run yet', () => {
    latest(null, {}, 'holdout');
    expect(
      screen.getByText(
        'No holdout run yet. Holdout runs need verified holdout references (References tab) and are optional.',
      ),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/EvaluateLatest.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement** — `apps/web/src/workbench/EvaluateLatest.tsx`:

```tsx
import { Fragment, useEffect, useState } from 'react';
import { FEEDBACK_MAX_CHARS, type EvaluationSet, type IterationView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Meter } from '../ui/Meter.js';
import { offOutputs, outputsDiffering, tableDiff } from './evaluate.js';

const DOT = '·';
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);
const show = (v: unknown) =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v);

const EMPTY: Record<EvaluationSet, string> = {
  dev: 'No dev run yet. Evaluate the draft on dev to score it against the verified dev references.',
  holdout:
    'No holdout run yet. Holdout runs need verified holdout references (References tab) and are optional.',
};

export const SEALED_NOTE =
  'Holdout is sealed: you can see the differences, but comments are off so nothing from it reaches the model in Revise.';

type Target = { target: 'field' | 'table'; id: string };

function Verdict({ match }: { match: boolean }) {
  return match ? (
    <span role="img" aria-label="matches" className="eval-ok">
      ✓
    </span>
  ) : (
    <span role="img" aria-label="differs" className="eval-bad">
      ✗
    </span>
  );
}

/** The newest run of the selected set (handoff §8): rows, the comparison table, dev comments. */
export function LatestRun({
  api,
  projectId,
  iteration,
  set,
  threshold,
}: {
  api: Api;
  projectId: string;
  iteration: IterationView | null;
  set: EvaluationSet;
  threshold: number;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<Target | null>(null);
  const [body, setBody] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iterationId = iteration?.id;
  useEffect(() => {
    setOpen(null);
    setCommenting(null);
    setSaved(false);
  }, [iterationId]);

  if (!iteration) {
    return (
      <section className="card eval-latest" aria-label="Latest run">
        <h3>Latest {set} run</h3>
        <p className="muted">{EMPTY[set]}</p>
      </section>
    );
  }
  const holdout = iteration.set === 'holdout';
  const opened = iteration.samples.find((s) => s.jobId !== null && s.jobId === open) ?? null;
  const comparison = opened?.comparison ?? null;

  const save = async () => {
    if (!commenting || !opened || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addFeedback(projectId, {
        target: commenting.target,
        targetId: commenting.id,
        body,
        ...(opened.sampleId ? { sampleId: opened.sampleId } : {}),
        iterationId: iteration.id,
      });
      setCommenting(null);
      setBody('');
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const commentCell = (t: Target, match: boolean) =>
    !holdout && (
      <td>
        {!match && (
          <button
            type="button"
            onClick={() => {
              setCommenting(t);
              setBody('');
              setSaved(false);
            }}
          >
            Comment
          </button>
        )}
      </td>
    );
  const commentRow = (t: Target) =>
    commenting?.target === t.target &&
    commenting.id === t.id && (
      <tr className="eval-comment-row">
        <td colSpan={5}>
          <label>
            Comment on {t.id} — goes to Revise as feedback for the model
            <textarea
              value={body}
              maxLength={FEEDBACK_MAX_CHARS}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !body.trim()}
              title={!body.trim() ? 'Write a comment first' : busy ? 'Saving…' : undefined}
              onClick={() => void save()}
            >
              Save comment
            </button>
            <button type="button" onClick={() => setCommenting(null)}>
              Cancel
            </button>
          </div>
        </td>
      </tr>
    );

  const differing = comparison ? outputsDiffering(comparison) : null;
  return (
    <section className="card eval-latest" aria-label="Latest run">
      <header className="eval-latest-head">
        <h3>
          Latest {iteration.set} run {DOT} v{iteration.templateVersion} {DOT}{' '}
          {iteration.model ?? "template's models"}
          {iteration.uncached && ` ${DOT} fresh`}
        </h3>
        <p className="muted">
          {new Date(iteration.createdAt).toLocaleString()} {DOT} {iteration.completed} of{' '}
          {iteration.total} compared
          {iteration.cache.total > 0 &&
            ` ${DOT} ${iteration.cache.reused} of ${iteration.cache.total} steps reused from the cache`}
          {iteration.status === 'running' && ` ${DOT} running`}
        </p>
      </header>
      <ul className="eval-samples" aria-label="Samples">
        {iteration.samples.map((s, i) => {
          const selectable = s.comparison !== null && s.jobId !== null;
          const status = s.status ? s.status.replace('_', ' ') : 'deleted';
          const off = s.comparison ? offOutputs(s.comparison) : [];
          const score = s.comparison?.score ?? null;
          return (
            <li key={`${i}-${s.jobId ?? s.filename}`}>
              <button
                type="button"
                className="eval-sample"
                aria-pressed={selectable && open === s.jobId}
                disabled={!selectable}
                title={selectable ? undefined : `Not compared: ${status}${s.error ? ` (${s.error})` : ''}`}
                onClick={() => setOpen(open === s.jobId ? null : s.jobId)}
              >
                <code className="eval-file">{s.filename}</code>
                <Meter
                  label={`${s.filename} score`}
                  value={score}
                  min={0.7}
                  threshold={threshold}
                  tone={holdout ? 'skip' : 'accent'}
                />
                <span
                  className="eval-score"
                  data-tone={score === null ? undefined : score >= threshold ? 'ok' : 'warn'}
                >
                  {pct(score)}
                </span>
                <span className="eval-off">
                  {!s.comparison ? status : off.length ? `Off: ${off.join(', ')}` : 'All match'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {opened && comparison && differing && (
        <div className="eval-detail">
          <div className="eval-detail-head">
            <p>
              <code className="eval-file">{opened.filename}</code> {pct(comparison.score)} {DOT}{' '}
              {differing.differ} of {differing.of} outputs differ from the reference
            </p>
            {opened.jobId && <a href={`#/review/${opened.jobId}`}>Open in Review</a>}
          </div>
          {holdout && <p className="holdout-note">{SEALED_NOTE}</p>}
          <div className="table-scroll">
            <table aria-label={`Outputs in ${opened.filename}`}>
              <thead>
                <tr>
                  <th scope="col">Output</th>
                  <th scope="col">Reference</th>
                  <th scope="col">This run</th>
                  <th scope="col">Match</th>
                  {!holdout && (
                    <th scope="col">
                      <span className="visually-hidden">Comment</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {comparison.fields.map((f) => (
                  <Fragment key={`f-${f.id}`}>
                    <tr>
                      <td>
                        <code>{f.id}</code>
                      </td>
                      <td>{show(f.expected) ?? '—'}</td>
                      <td className={f.match ? undefined : 'eval-miss'}>{show(f.actual) ?? '— empty'}</td>
                      <td>
                        <Verdict match={f.match} />
                      </td>
                      {commentCell({ target: 'field', id: f.id }, f.match)}
                    </tr>
                    {commentRow({ target: 'field', id: f.id })}
                  </Fragment>
                ))}
                {comparison.tables.map((t) => {
                  const match = !t.missing.length && !t.extra.length && !t.changed.length;
                  return (
                    <Fragment key={`t-${t.id}`}>
                      <tr>
                        <td>
                          <code>{t.id}</code>
                        </td>
                        <td>
                          {t.expected} row{t.expected === 1 ? '' : 's'}
                        </td>
                        <td className={match ? undefined : 'eval-miss'}>{tableDiff(t)}</td>
                        <td>
                          <Verdict match={match} />
                        </td>
                        {commentCell({ target: 'table', id: t.id }, match)}
                      </tr>
                      {commentRow({ target: 'table', id: t.id })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {saved && (
        <p role="status">
          Comment saved — see <a href={`#/workbench/${projectId}/revise`}>Revise</a>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
```

(The visually hidden "Comment" header text is what the column-header assertion reads; it is absent on holdout.)

CSS — add `.eval-latest` to the card padding list and `.eval-latest h3` to the `font-weight: 600` list; append:

```css
/* Evaluate: latest run */
.eval-latest-head h3 {
  margin: 0;
  overflow-wrap: anywhere;
}
.eval-samples {
  list-style: none;
  margin: 12px -16px 0;
  padding: 0;
  border-top: 1px solid var(--ih-border-soft);
}
.eval-sample {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 48px minmax(0, 1.4fr);
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 16px;
  border: 0;
  border-bottom: 1px solid var(--ih-border-soft);
  border-left: 3px solid transparent;
  border-radius: 0;
  background: none;
  color: inherit;
  text-align: left;
}
.eval-sample[aria-pressed='true'] {
  border-left-color: var(--ih-accent);
  background: var(--ih-sel-row);
}
.eval-sample > * {
  min-width: 0;
}
.eval-file {
  overflow-wrap: anywhere;
}
.eval-score {
  font-weight: 600;
  text-align: right;
}
.eval-score[data-tone='ok'] {
  color: var(--ih-ok-fg);
}
.eval-score[data-tone='warn'] {
  color: var(--ih-warn-fg);
}
.eval-off {
  color: var(--ih-muted);
  font-size: var(--ih-text-sm);
  overflow-wrap: anywhere;
}
.eval-detail {
  margin-top: 12px;
  min-width: 0;
}
.eval-detail-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
}
.eval-detail td code {
  overflow-wrap: anywhere;
}
.eval-miss,
.eval-bad {
  color: var(--ih-danger-fg);
  font-weight: 600;
}
.eval-ok {
  color: var(--ih-ok-fg);
}
.eval-comment-row td {
  background: var(--ih-info-bg);
}
.eval-comment-row textarea {
  display: block;
  width: 100%;
  margin: 6px 0;
}
@media (max-width: 760px) {
  .eval-sample {
    grid-template-columns: minmax(0, 1fr) 48px;
  }
  .eval-sample .meter,
  .eval-off {
    grid-column: 1 / -1;
  }
}
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web`; `npm run typecheck`; `npx eslint apps/web`; `npx prettier --write apps/web/src/workbench/EvaluateLatest.tsx apps/web/test/EvaluateLatest.test.tsx apps/web/src/styles/stages.css`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/EvaluateLatest.tsx apps/web/test/EvaluateLatest.test.tsx apps/web/src/styles/stages.css
git commit -m "Workbench web: latest evaluation run with comparison table and dev-only comments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Accuracy by output and History — `AccuracyCard`, `HistoryCard`

**Files:**
- Create: `apps/web/src/workbench/EvaluateHistory.tsx`, `apps/web/test/EvaluateHistory.test.tsx`
- Modify: `apps/web/src/styles/stages.css`

**Interfaces:**
- Produces: `AccuracyCard({ iteration, threshold })`, `HistoryCard({ history, version, threshold, busy, onRestore, publications })`.
- Consumes: `accuracyList`, `accuracyTone`, `accuracyLabel`, `historyRows`, `historyBars`, `historySummary` (Task 3), `PublicationsLog` (Task 4), `SampleTag` (`./tags.js`).

- [ ] **Step 1: Write the failing tests** — `apps/web/test/EvaluateHistory.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccuracyCard, HistoryCard } from '../src/workbench/EvaluateHistory.js';
import { iterationView, publication } from './fake-api.js';

describe('AccuracyCard', () => {
  it('lists outputs worst first with bars in words, counting those at 100%', () => {
    const it0 = iterationView({
      scorecard: {
        score: 0.6,
        completed: 2,
        total: 2,
        fields: [
          { id: 'due_date', matched: 0, total: 2, accuracy: 0 },
          { id: 'total', matched: 5, total: 6, accuracy: 5 / 6 },
          { id: 'sender', matched: 2, total: 2, accuracy: 1 },
        ],
        columns: [{ id: 'lines.qty', matched: 115, total: 116, accuracy: 115 / 116 }],
      },
    });
    render(<AccuracyCard iteration={it0} threshold={0.9} />);
    const list = screen.getByRole('list', { name: 'Accuracy by output' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.querySelector('code')!.textContent)).toEqual(['due_date', 'total', 'lines.qty']);
    expect(items[0]).toHaveTextContent('0% · 0 / 2');
    expect(within(list).getByRole('img', { name: 'due_date: 0%, 0 of 2, under 70%' })).toBeInTheDocument();
    expect(within(list).getByRole('img', { name: 'total: 83%, 5 of 6, under the threshold' })).toBeInTheDocument();
    expect(
      within(list).getByRole('img', { name: 'lines.qty: 99%, 115 of 116, meets the threshold' }),
    ).toBeInTheDocument();
    expect(screen.getByText('+ 1 more at 100%')).toBeInTheDocument();
    expect(screen.getByText('dev run · worst first')).toBeInTheDocument();
  });

  it('says when everything is at 100%', () => {
    const it0 = iterationView({
      scorecard: { score: 1, completed: 1, total: 1, fields: [{ id: 'a', matched: 1, total: 1, accuracy: 1 }], columns: [] },
    });
    render(<AccuracyCard iteration={it0} threshold={0.9} />);
    expect(screen.getByText('Every output and column is at 100%.')).toBeInTheDocument();
  });
});

describe('HistoryCard', () => {
  const g = crypto.randomUUID();
  const history = [
    iterationView({ id: 'h2', set: 'holdout', score: 0.88 }),
    iterationView({ id: 'x2', model: 'fast', groupId: g, score: 0.5 }),
    iterationView({ id: 'x1', model: 'default', groupId: g, score: 0.75 }),
    iterationView({ id: 'd2', uncached: true, score: 0.91 }),
    iterationView({ id: 'd1', templateVersion: 1, score: 0.8 }),
  ];
  const card = (onRestore = vi.fn()) =>
    render(
      <HistoryCard
        history={history}
        version={2}
        threshold={0.9}
        busy={false}
        onRestore={onRestore}
        publications={[publication({ version: 1, overrideReason: 'Known bad scan' })]}
      />,
    );

  it('charts template-model runs with a text alternative', () => {
    card();
    expect(
      screen.getByRole('img', {
        name: '3 template-model runs; latest dev 91% (v2); latest holdout 88% (v2); threshold 90%',
      }),
    ).toBeInTheDocument();
  });

  it('lists every evaluation, a comparison as one row, and restores one', async () => {
    const onRestore = vi.fn();
    card(onRestore);
    const rows = within(screen.getByRole('list', { name: 'Evaluations' })).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('HOLDOUT');
    expect(rows[0]).toHaveTextContent('88%');
    expect(rows[1]).toHaveTextContent('Compare · default 75 · fast 50');
    expect(rows[2]).toHaveTextContent("Template's models · fresh");
    expect(rows[3]).toHaveTextContent('v1');
    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledWith('h2');
  });

  it('shows the publications log below the history', () => {
    card();
    expect(screen.getByRole('list', { name: 'Publications' })).toHaveTextContent(
      'override: Known bad scan',
    );
  });

  it('says when nothing was evaluated', () => {
    render(
      <HistoryCard history={[]} version={2} threshold={0.9} busy={false} onRestore={vi.fn()} publications={[]} />,
    );
    expect(screen.getByText('No evaluations yet.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/EvaluateHistory.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement** — `apps/web/src/workbench/EvaluateHistory.tsx`:

```tsx
import { useId } from 'react';
import type { IterationSummary, IterationView, Publication } from '@ih/shared';
import { PublicationsLog } from './GateCard.js';
import {
  accuracyLabel,
  accuracyList,
  accuracyTone,
  historyBars,
  historyRows,
  historySummary,
} from './evaluate.js';
import { SampleTag } from './tags.js';

const DOT = '·';
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);

/** Accuracy by output (handoff §8): worst first, red < 70 %, amber < threshold, green ≥ it. */
export function AccuracyCard({ iteration, threshold }: { iteration: IterationView; threshold: number }) {
  const titleId = useId();
  const { rows, more, perfect } = accuracyList(iteration.scorecard);
  return (
    <section className="card eval-accuracy" aria-labelledby={titleId}>
      <header className="eval-card-head">
        <h3 id={titleId}>Accuracy by output</h3>
        <span className="muted">
          {iteration.set} run {DOT} worst first
        </span>
      </header>
      {rows.length === 0 ? (
        <p className={perfect ? undefined : 'muted'}>
          {perfect ? 'Every output and column is at 100%.' : 'Nothing compared yet.'}
        </p>
      ) : (
        <ul className="acc-list" aria-label="Accuracy by output">
          {rows.map((a) => (
            <li key={a.id} className="acc-row" data-tone={accuracyTone(a.accuracy, threshold)}>
              <code className="acc-id">{a.id}</code>
              <span className="acc-bar" role="img" aria-label={accuracyLabel(a, threshold)}>
                <span className="acc-fill" style={{ width: `${Math.round(a.accuracy * 100)}%` }} />
              </span>
              <span className="acc-figure">
                {pct(a.accuracy)} {DOT} {a.matched} / {a.total}
              </span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="muted">+ {more} more below 100%</p>}
      {perfect > 0 && rows.length > 0 && <p className="muted">+ {perfect} more at 100%</p>}
    </section>
  );
}

/** History (handoff §8): the template-model chart, every evaluation with Restore, publications. */
export function HistoryCard({
  history,
  version,
  threshold,
  busy,
  onRestore,
  publications,
}: {
  history: IterationSummary[];
  /** The draft (or, without one, the published) version: other versions' bars are dimmed. */
  version: number | null;
  threshold: number;
  busy: boolean;
  onRestore: (iterationId: string) => void;
  publications: Publication[];
}) {
  const titleId = useId();
  const bars = historyBars(history, version);
  const rows = historyRows(history);
  return (
    <section className="card eval-history" aria-labelledby={titleId}>
      <header className="eval-card-head">
        <h3 id={titleId}>History</h3>
        <span className="eval-legend" aria-hidden="true">
          <span className="legend-dev">Dev</span>
          <span className="legend-holdout">Holdout</span>
        </span>
      </header>
      {bars.length > 0 && (
        <figure className="eval-chart">
          <div className="eval-bars" role="img" aria-label={historySummary(bars, threshold)}>
            <span className="eval-threshold" style={{ bottom: `${threshold * 100}%` }} />
            {bars.map((b) => (
              <span
                key={b.id}
                className={`eval-bar ${b.set}${b.dimmed ? ' dimmed' : ''}`}
                style={{ height: `${Math.max(2, b.score * 100)}%` }}
              />
            ))}
          </div>
          <div className="eval-bar-labels" aria-hidden="true">
            {bars.map((b) => (
              <span key={b.id}>
                v{b.version} {b.set === 'dev' ? 'D' : 'H'}
              </span>
            ))}
          </div>
        </figure>
      )}
      {rows.length === 0 ? (
        <p className="muted">No evaluations yet.</p>
      ) : (
        <ul className="eval-history-list" aria-label="Evaluations">
          {rows.map((r) => (
            <li key={r.id} className="eval-history-row">
              <strong>v{r.version}</strong>
              <span className="eval-history-what">
                <SampleTag role={r.set} /> {r.label}
                <small className="muted">{new Date(r.createdAt).toLocaleString()}</small>
              </span>
              <span className="eval-history-score">{r.running ? 'running' : pct(r.score)}</span>
              <button
                type="button"
                disabled={busy}
                title={busy ? 'Working…' : undefined}
                onClick={() => onRestore(r.restoreId)}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      <PublicationsLog publications={publications} />
    </section>
  );
}
```

CSS — add `.eval-accuracy, .eval-history` to the card padding list and their `h3` to the `font-weight: 600` list; append:

```css
/* Evaluate: accuracy and history */
.eval-card-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.eval-card-head h3 {
  margin: 0;
}
.acc-list,
.eval-history-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.acc-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.acc-id {
  min-width: 0;
  overflow-wrap: anywhere;
}
.acc-bar {
  display: block;
  height: 8px;
  border-radius: 4px;
  background: var(--ih-border-soft);
}
.acc-fill {
  display: block;
  height: 100%;
  min-width: 2px;
  border-radius: 4px;
}
.acc-row[data-tone='low'] .acc-fill {
  background: var(--ih-danger-fg);
}
.acc-row[data-tone='below'] .acc-fill {
  background: var(--ih-warn-fg);
}
.acc-row[data-tone='ok'] .acc-fill {
  background: var(--ih-ok-fg);
}
.acc-figure {
  font-size: var(--ih-text-sm);
  white-space: nowrap;
}
.acc-row[data-tone='low'] .acc-figure {
  color: var(--ih-danger-fg);
}
.acc-row[data-tone='below'] .acc-figure {
  color: var(--ih-warn-fg);
}
.eval-legend {
  display: flex;
  gap: 10px;
  font-size: var(--ih-text-xs);
  color: var(--ih-muted);
}
.eval-legend span::before {
  content: '';
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 4px;
  border-radius: 2px;
  vertical-align: -1px;
}
.legend-dev::before {
  background: var(--ih-accent);
}
.legend-holdout::before {
  background: var(--ih-skip-fg);
}
.eval-chart {
  margin: 12px 0 0;
}
.eval-bars {
  position: relative;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  align-items: end;
  gap: 6px;
  height: 120px;
  border-bottom: 1px solid var(--ih-border);
}
.eval-threshold {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--ih-muted);
}
.eval-bar {
  display: block;
  border-radius: 3px 3px 0 0;
}
.eval-bar.dev {
  background: var(--ih-accent);
}
.eval-bar.holdout {
  background: var(--ih-skip-fg);
}
.eval-bar.dimmed {
  opacity: 0.45;
}
.eval-bar-labels {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 6px;
  color: var(--ih-muted);
  font-size: var(--ih-text-xs);
  text-align: center;
}
.eval-history-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--ih-border-soft);
}
.eval-history-what {
  display: grid;
  min-width: 0;
  overflow-wrap: anywhere;
}
.eval-history-score {
  font-weight: 600;
}
.publications {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--ih-border-soft);
}
.publications h4 {
  margin: 0 0 4px;
  font-weight: 600;
}
.publications ul {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web`; `npm run typecheck`; `npx eslint apps/web`; `npx prettier --write apps/web/src/workbench/EvaluateHistory.tsx apps/web/test/EvaluateHistory.test.tsx apps/web/src/styles/stages.css`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/EvaluateHistory.tsx apps/web/test/EvaluateHistory.test.tsx apps/web/src/styles/stages.css
git commit -m "Workbench web: accuracy by output and an accessible evaluation history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Evaluate tab — run bar, per-set loading, composition; retire `PublishPanel`

**Files:**
- Modify: `apps/web/src/workbench/EvaluateTab.tsx` (rewrite), `apps/web/test/EvaluateTab.test.tsx` (rewrite), `apps/web/src/workbench/ProjectPage.tsx`, `apps/web/test/ProjectPage.test.tsx`, `apps/web/src/styles/stages.css`
- Delete: `apps/web/src/workbench/PublishPanel.tsx`, `apps/web/test/PublishPanel.test.tsx` (behaviour now in `GateCard`, Review Focus 5)

**Interfaces:**
- `EvaluateTab` props become `{ api, projectId, dataPolicy, draft, published, pollMs, onRestored, onStarted? }` (`hasDraft` is dropped: it was `draft !== null`). Exports `HOLDOUT_MODEL_REASON`, `COMPARE_HOLDOUT_REASON`.
- Consumes: `useGate`, `GateCard` (Task 4), `LatestRun` (Task 5), `AccuracyCard`, `HistoryCard` (Task 6), `latestOf`, `devScore` (Task 3), `Segmented`.

- [ ] **Step 1: Write the failing tests** — replace `apps/web/test/EvaluateTab.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api/client.js';
import {
  COMPARE_HOLDOUT_REASON,
  EvaluateTab,
  HOLDOUT_MODEL_REASON,
} from '../src/workbench/EvaluateTab.js';
import { fakeApi, iterationView, projectView } from './fake-api.js';

function tab(overrides: Partial<Api> = {}, draft: number | null = 2, pollMs = 1) {
  const api = fakeApi({ getProject: vi.fn(async () => projectView()), ...overrides });
  const onRestored = vi.fn();
  const onStarted = vi.fn();
  render(
    <EvaluateTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      draft={draft}
      published={draft === null ? 2 : null}
      pollMs={pollMs}
      onRestored={onRestored}
      onStarted={onStarted}
    />,
  );
  return { api, onRestored, onStarted };
}

describe('EvaluateTab', () => {
  it("evaluates the draft on dev with the template's models by default", async () => {
    const it0 = iterationView({ status: 'running', score: null });
    const { api, onStarted } = tab({
      startEvaluation: vi.fn(async () => it0),
      getIteration: vi.fn(async () => it0),
    });
    expect(await screen.findByRole('button', { name: 'Dev' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate v2 on dev' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', null, { uncached: false, set: 'dev' });
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  });

  it('passes the chosen model and fresh model calls on dev', async () => {
    const it0 = iterationView({ status: 'running', score: null });
    const { api } = tab({ startEvaluation: vi.fn(async () => it0), getIteration: vi.fn(async () => it0) });
    await userEvent.selectOptions(await screen.findByLabelText('Model'), 'fast');
    await userEvent.click(screen.getByLabelText('Fresh model calls'));
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate v2 on dev' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', 'fast', { uncached: true, set: 'dev' });
  });

  it("holdout forces the template's models and cannot compare models, with reasons", async () => {
    const it0 = iterationView({ status: 'running', score: null, set: 'holdout' });
    const { api } = tab({ startEvaluation: vi.fn(async () => it0), getIteration: vi.fn(async () => it0) });
    await userEvent.selectOptions(await screen.findByLabelText('Model'), 'fast');
    await userEvent.click(screen.getByRole('button', { name: 'Holdout' }));
    expect(screen.getByRole('button', { name: 'Holdout' })).toHaveAttribute('aria-pressed', 'true');
    const select = screen.getByLabelText('Model');
    expect(select).toBeDisabled();
    expect(select).toHaveValue('');
    expect(select).toHaveAttribute('title', HOLDOUT_MODEL_REASON);
    const compare = screen.getByRole('button', { name: 'Compare models' });
    expect(compare).toBeDisabled();
    expect(compare).toHaveAttribute('title', COMPARE_HOLDOUT_REASON);
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate v2 on holdout' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', null, { uncached: false, set: 'holdout' });
  });

  it('needs an open draft, and says so', async () => {
    const { api } = tab({}, null);
    const evaluate = await screen.findByRole('button', { name: 'Evaluate on dev' });
    expect(evaluate).toBeDisabled();
    expect(evaluate).toHaveAttribute('title', 'Start a draft version first');
    expect(screen.getByRole('button', { name: 'Compare models' })).toHaveAttribute(
      'title',
      'Start a draft version first',
    );
    await waitFor(() => expect(api.listPublications).toHaveBeenCalled());
    expect(api.getPublishGate).not.toHaveBeenCalled();
    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
  });

  it('shows the latest run of the selected set', async () => {
    const dev = iterationView();
    const holdout = iterationView({ set: 'holdout' });
    const getIteration = vi.fn(async (_p: string, id: string) => (id === holdout.id ? holdout : dev));
    tab({ listIterations: vi.fn(async () => [holdout, dev]), getIteration });
    const latest = await screen.findByRole('region', { name: 'Latest run' });
    expect(within(latest).getByRole('heading', { name: /^Latest dev run/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Holdout' }));
    expect(await screen.findByRole('heading', { name: /^Latest holdout run/ })).toBeInTheDocument();
    expect(getIteration).toHaveBeenCalledWith('letter', holdout.id);
  });

  it('feeds the Dev meter from the newest dev run of the draft', async () => {
    const dev = iterationView();
    tab({ listIterations: vi.fn(async () => [dev]), getIteration: vi.fn(async () => dev) });
    const gate = await screen.findByRole('region', { name: 'Publish gate' });
    expect(await within(gate).findByRole('img', { name: 'Dev score: 75%, threshold 90%' })).toBeInTheDocument();
  });

  it('polls while a run is active, then stops', async () => {
    const running = iterationView({ status: 'running', score: null, completed: 0 });
    const done = iterationView({ id: running.id });
    const listIterations = vi.fn().mockResolvedValueOnce([running]).mockResolvedValue([done]);
    const getIteration = vi.fn().mockResolvedValueOnce(running).mockResolvedValue(done);
    tab({ listIterations, getIteration });
    expect(await screen.findByText(/2 of 2 compared/)).toBeInTheDocument();
    const calls = listIterations.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(listIterations.mock.calls.length).toBe(calls);
  });

  it('reloads the publish gate when the latest evaluation completes', async () => {
    const running = iterationView({ status: 'running', score: null, set: 'holdout' });
    const done = iterationView({ id: running.id, status: 'complete', set: 'holdout' });
    const { api } = tab({
      listIterations: vi.fn().mockResolvedValueOnce([running]).mockResolvedValue([done]),
      getIteration: vi.fn().mockResolvedValueOnce(running).mockResolvedValue(done),
    });
    // Once on mount, once when the running iteration is listed, once when it completes.
    await waitFor(() => expect(api.getPublishGate).toHaveBeenCalledTimes(3));
  });

  it('reports a failed history refresh while polling', async () => {
    const running = iterationView({ status: 'running', score: null, completed: 0 });
    tab({
      listIterations: vi.fn().mockResolvedValueOnce([]).mockRejectedValue(new Error('history unavailable')),
      startEvaluation: vi.fn(async () => running),
      getIteration: vi.fn(async () => running),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Evaluate v2 on dev' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('history unavailable');
  });

  it('does not tell the page when starting an evaluation fails', async () => {
    const { onStarted } = tab(
      { startEvaluation: vi.fn(async () => Promise.reject(new Error('no ready dev samples'))) },
      2,
      60_000,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Evaluate v2 on dev' }));
    expect(await screen.findByText('no ready dev samples')).toBeInTheDocument();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('compares models side by side and tells the page', async () => {
    const group = 'g1';
    const views = [
      iterationView({ model: 'default', groupId: group, score: 0.75 }),
      iterationView({ model: 'fast', groupId: group, score: 0.5 }),
      iterationView({ model: 'draft', groupId: group, score: 1 }),
    ];
    const { api, onStarted } = tab({
      startComparison: vi.fn(async () => ({ groupId: group, iterations: views })),
      getComparison: vi.fn(async () => ({ groupId: group, iterations: views })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Compare models' }));
    expect(api.startComparison).toHaveBeenCalledWith('letter', { uncached: false });
    const table = await screen.findByRole('table', { name: 'Model comparison' });
    const score = within(table).getByText('score').closest('tr')!;
    expect(score).toHaveTextContent('75%');
    expect(score).toHaveTextContent('50%');
    expect(score).toHaveTextContent('100%');
    expect(onStarted).toHaveBeenCalled();
  });

  it('disables Evaluate while a comparison is running, with a reason', async () => {
    const group = 'g1';
    const running = [iterationView({ model: 'default', groupId: group, status: 'running', score: null })];
    tab(
      {
        startComparison: vi.fn(async () => ({ groupId: group, iterations: running })),
        getComparison: vi.fn(async () => ({ groupId: group, iterations: running })),
      },
      2,
      60_000,
    );
    const evaluate = await screen.findByRole('button', { name: 'Evaluate v2 on dev' });
    expect(evaluate).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Compare models' }));
    // Busy ("Starting…") first, then blocked by the running comparison.
    await waitFor(() =>
      expect(evaluate).toHaveAttribute('title', 'A model comparison is still running'),
    );
    expect(evaluate).toBeDisabled();
  });

  it('polls a running comparison until it completes, then stops', async () => {
    const group = 'g1';
    const running = [
      iterationView({ model: 'default', groupId: group, status: 'running', score: null }),
      iterationView({ model: 'fast', groupId: group, status: 'running', score: null }),
    ];
    const done = running.map((i) => ({ ...i, status: 'complete' as const, score: 0.5 }));
    const getComparison = vi
      .fn()
      .mockResolvedValueOnce({ groupId: group, iterations: running })
      .mockResolvedValue({ groupId: group, iterations: done });
    tab({
      startComparison: vi.fn(async () => ({ groupId: group, iterations: running })),
      getComparison,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Compare models' }));
    const table = await screen.findByRole('table', { name: 'Model comparison' });
    await waitFor(() => expect(within(table).getByText('score').closest('tr')).toHaveTextContent('50%'));
    expect(within(table).queryByText(/running/)).not.toBeInTheDocument();
    const calls = getComparison.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(getComparison.mock.calls.length).toBe(calls);
  });

  it('shows a comparison poll failure and clears it when a poll succeeds', async () => {
    const group = 'g1';
    const running = [iterationView({ model: 'default', groupId: group, status: 'running' })];
    const done = running.map((i) => ({ ...i, status: 'complete' as const }));
    tab({
      startComparison: vi.fn(async () => ({ groupId: group, iterations: running })),
      getComparison: vi
        .fn()
        .mockRejectedValueOnce(new Error('comparison poll failed'))
        .mockResolvedValue({ groupId: group, iterations: done }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Compare models' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('comparison poll failed');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('restores an iteration from the history after confirming', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const iter = iterationView();
    const { api, onRestored } = tab({
      listIterations: vi.fn(async () => [iter]),
      getIteration: vi.fn(async () => iter),
      restoreIteration: vi.fn(async () => projectView()),
    });
    const list = await screen.findByRole('list', { name: 'Evaluations' });
    await userEvent.click(within(list).getByRole('button', { name: 'Restore' }));
    expect(confirm).toHaveBeenCalled();
    expect(api.restoreIteration).toHaveBeenCalledWith('letter', iter.id);
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    confirm.mockRestore();
  });
});
```

In `apps/web/test/ProjectPage.test.tsx` change the evaluate assertion to `screen.findByRole('button', { name: 'Evaluate v1 on dev' })` (the `projectView()` draft is 1).

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/EvaluateTab.test.tsx apps/web/test/ProjectPage.test.tsx` → FAIL (old component: no "Evaluate v2 on dev", no Holdout/Dev switch, missing exports).

- [ ] **Step 3: Implement** — replace `apps/web/src/workbench/EvaluateTab.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EVALUATION_MODELS,
  comparisonRows,
  type ComparisonView,
  type DataPolicy,
  type EvaluationModel,
  type EvaluationSet,
  type IterationSummary,
  type IterationView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Segmented, type SegmentedOption } from '../ui/Segmented.js';
import { AccuracyCard, HistoryCard } from './EvaluateHistory.js';
import { LatestRun } from './EvaluateLatest.js';
import { GateCard, useGate } from './GateCard.js';
import { devScore, latestOf } from './evaluate.js';

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

export const HOLDOUT_MODEL_REASON =
  "Holdout runs use the template's own models: only they are measured against the threshold";
export const COMPARE_HOLDOUT_REASON =
  'Model comparison runs on dev samples only; holdout samples are never compared across models';

const SETS: readonly SegmentedOption<EvaluationSet>[] = [
  { value: 'holdout', label: 'Holdout' },
  { value: 'dev', label: 'Dev' },
];
const DEFAULT_THRESHOLD = 0.9;
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);

/**
 * Evaluate and publish (handoff §8 after #77): the informational gate card, the run bar, the
 * latest run of the selected set, accuracy by output and the history. Polls only while a run or
 * a model comparison is active.
 */
export function EvaluateTab({
  api,
  projectId,
  dataPolicy,
  draft,
  published,
  pollMs,
  onRestored,
  onStarted,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  /** The open draft version; null when every version is published. */
  draft: number | null;
  published: number | null;
  pollMs: number;
  onRestored: () => void;
  /** Called after an evaluation or a model comparison has been started. */
  onStarted?: () => void;
}) {
  const [set, setSet] = useState<EvaluationSet>('dev');
  const [model, setModel] = useState<EvaluationModel | ''>('');
  const [uncached, setUncached] = useState(false);
  const [history, setHistory] = useState<IterationSummary[] | null>(null);
  const [current, setCurrent] = useState<IterationView | null>(null);
  const [comparison, setComparison] = useState<ComparisonView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await api.listIterations(projectId);
      const latest = latestOf(list, set);
      const view = latest ? await api.getIteration(projectId, latest.id) : null;
      if (n !== seq.current) return; // a set switch or a newer poll superseded this one
      setHistory(list);
      setCurrent(view);
      setError(null);
    } catch (err) {
      if (n === seq.current) setError((err as Error).message);
    }
  }, [api, projectId, set]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = history?.some((h) => h.status === 'running') ?? false;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [active, load, pollMs]);

  const comparisonId = comparison?.groupId;
  const comparing = comparison?.iterations.some((i) => i.status === 'running') ?? false;
  useEffect(() => {
    if (!comparing || !comparisonId) return;
    let stopped = false;
    const timer = setInterval(() => {
      api.getComparison(projectId, comparisonId).then(
        (next) => {
          if (stopped) return;
          setComparison(next);
          setError(null);
          if (!next.iterations.some((i) => i.status === 'running')) void load();
        },
        (err: Error) => {
          if (!stopped) setError(err.message);
        },
      );
    }, pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [comparing, comparisonId, pollMs, api, projectId, load]);

  const gateKey = (history ?? []).map((h) => `${h.id}:${h.status}`).join(',');
  const gate = useGate(api, projectId, draft, gateKey);
  const threshold = gate.gate?.threshold ?? gate.threshold?.value ?? DEFAULT_THRESHOLD;

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

  const holdout = set === 'holdout';
  const running = current?.status === 'running';
  const evaluateBlocked =
    draft === null
      ? 'Start a draft version first'
      : running
        ? 'An evaluation of this set is still running'
        : comparing
          ? 'A model comparison is still running'
          : busy
            ? 'Starting…'
            : null;
  const compareBlocked = draft !== null && holdout ? COMPARE_HOLDOUT_REASON : evaluateBlocked;

  const evaluate = () =>
    act(async () => {
      const started = await api.startEvaluation(projectId, holdout ? null : model || null, {
        uncached,
        set,
      });
      setCurrent(started);
      setHistory((h) => [started, ...(h ?? [])]);
      onStarted?.();
    });
  const compare = () =>
    act(async () => {
      setComparison(await api.startComparison(projectId, { uncached }));
      onStarted?.();
    });
  const restore = (id: string) =>
    void act(async () => {
      if (!window.confirm('Replace the open draft with the template from this iteration?')) return;
      await api.restoreIteration(projectId, id);
      onRestored();
    });

  return (
    <div className="eval-tab">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      <GateCard
        api={api}
        projectId={projectId}
        draft={draft}
        published={published}
        gate={gate.gate}
        publications={gate.publications}
        threshold={gate.threshold}
        devScore={history ? devScore(history, draft) : null}
        onChanged={() => void gate.reload()}
        onPublished={onRestored}
      />
      {gate.error && <p role="alert">{gate.error}</p>}
      <section className="card eval-runbar" aria-label="Run">
        <h3>Run</h3>
        <Segmented label="Sample set" options={SETS} value={set} onChange={setSet} />
        <label>
          Model{' '}
          <select
            value={holdout ? '' : model}
            disabled={holdout}
            title={holdout ? HOLDOUT_MODEL_REASON : undefined}
            onChange={(e) => setModel(e.target.value as EvaluationModel | '')}
          >
            <option value="">Template&apos;s models</option>
            {EVALUATION_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label title="Skip the step cache: every step calls its model">
          <input type="checkbox" checked={uncached} onChange={(e) => setUncached(e.target.checked)} />{' '}
          Fresh model calls
        </label>
        <span className="muted eval-runbar-note">
          {holdout ? "Holdout: template's models only" : 'Dev: any model, or compare'}
        </span>
        <div className="eval-runbar-actions">
          <button
            type="button"
            disabled={compareBlocked !== null}
            title={compareBlocked ?? undefined}
            onClick={() => void compare()}
          >
            Compare models
          </button>
          <button
            type="button"
            className="primary"
            disabled={evaluateBlocked !== null}
            title={evaluateBlocked ?? undefined}
            onClick={() => void evaluate()}
          >
            {draft === null ? `Evaluate on ${set}` : `Evaluate v${draft} on ${set}`}
          </button>
        </div>
      </section>
      {error && <p role="alert">{error}</p>}
      {comparison && (
        <section className="card eval-compare" aria-label="Models compared">
          <h3>Model comparison</h3>
          <div className="table-scroll">
            <table aria-label="Model comparison">
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  {comparison.iterations.map((i) => (
                    <th scope="col" key={i.id}>
                      {i.model ?? 'template'}
                      {i.status === 'running' && ' (running)'}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparisonRows(comparison.iterations).map((row) => (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    {comparison.iterations.map((i) => (
                      <td key={i.id}>{pct(row.byModel[i.model ?? 'template'] ?? null)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <div className="eval-layout">
        <div className="eval-main">
          <LatestRun api={api} projectId={projectId} iteration={current} set={set} threshold={threshold} />
        </div>
        <div className="eval-side">
          {current && <AccuracyCard iteration={current} threshold={threshold} />}
          <HistoryCard
            history={history ?? []}
            version={draft ?? published}
            threshold={threshold}
            busy={busy}
            onRestore={restore}
            publications={gate.publications}
          />
        </div>
      </div>
    </div>
  );
}
```

`apps/web/src/workbench/ProjectPage.tsx`: change the evaluate block to

```tsx
          {tab === 'evaluate' &&
            header(
              'evaluate',
              'Runs the draft on samples with verified references and scores every value against them. Dev runs guide your changes; holdout runs measure the draft against the publish threshold. Both are optional.',
            )}
          {tab === 'evaluate' && (
            <EvaluateTab
              api={api}
              projectId={project.id}
              dataPolicy={project.dataPolicy}
              draft={draft}
              published={published}
              pollMs={pollMs}
              onRestored={changed}
              onStarted={loadOverview}
            />
          )}
```

Delete `apps/web/src/workbench/PublishPanel.tsx` and `apps/web/test/PublishPanel.test.tsx` (`git rm`); `grep -rn "PublishPanel" apps/web` must then return nothing.

CSS — add `.eval-runbar, .eval-compare` to the card padding list and their `h3` to the `font-weight: 600` list; append:

```css
/* Evaluate: tab layout and run bar */
.eval-tab {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  min-width: 0;
}
.eval-runbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.eval-runbar h3 {
  margin: 0;
}
.eval-runbar-note {
  min-width: 0;
}
.eval-runbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}
.eval-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.eval-main,
.eval-side {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  min-width: 0;
}
.eval-side {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  overflow: auto;
}
@media (max-width: 760px) {
  .eval-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .eval-side {
    position: static;
    max-height: none;
    overflow: visible;
  }
  .eval-runbar-actions {
    margin-left: 0;
    width: 100%;
  }
}
```

- [ ] **Step 4: Run** the Step 2 command → PASS; `npx vitest run --project web`; `npm run typecheck`; `npx eslint apps/web`; `npx prettier --write apps/web/src/workbench/EvaluateTab.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/test/EvaluateTab.test.tsx apps/web/test/ProjectPage.test.tsx apps/web/src/styles/stages.css`. Browser check (`deploy/scripts/dev-infra.ps1 up`, `npm run dev:api`, `npm run dev:web`, a project with dev and holdout references and a few evaluations): 1440 px and 390 px, light and dark — the gate card's two columns collapse, meters keep their tick, the run bar wraps without overflow, long file names and keys wrap, the comparison table scrolls inside `.table-scroll`, the side column stays in view and scrolls on its own, the History bars and the dashed threshold line are visible in both themes, every disabled button shows its reason on hover.

- [ ] **Step 5: Commit**

```bash
git rm apps/web/src/workbench/PublishPanel.tsx apps/web/test/PublishPanel.test.tsx
git add apps/web/src/workbench/EvaluateTab.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/test/EvaluateTab.test.tsx apps/web/test/ProjectPage.test.tsx apps/web/src/styles/stages.css
git commit -m "Workbench web: Evaluate tab redesign (run bar, latest run per set, gate card, history)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Docs and the full check

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Docs** — in `CLAUDE.md`:

1. Contract table, row "Evaluation (references, comparison, scorecard, iterations)": append to the TS cell "; gate hints (EV1): `GateHintSchema`, `PublishGateViewSchema`, `gateHints` (TS only)".
2. In the **Workbench** bullet, after "…`GET /api/workbench/projects/:id/publish-gate` shows it." add: "Its body also carries `hints` (handoff EV1, `gateHints` in `packages/shared/src/evaluation.ts`): the deciding iteration's fields and `table.column`s below the threshold, worst first, at most `MAX_GATE_HINTS` (5), each `no_step` (no step of the draft fills it, `stage: 'steps'`; with a valid draft this means a reference holds a value the draft has no output for) or `low_accuracy` (`stage: 'revise'`); empty without a deciding iteration. Only that route scores the iteration for hints; the overview's `gate` has none."
3. At the end of the **UI** bullet's Workbench sentence, append: " Evaluate (`EvaluateTab`; `GateCard` with `useGate` and `PublicationsLog`, `EvaluateLatest` (`LatestRun`), `EvaluateHistory` (`AccuracyCard`, `HistoryCard`), helpers in `workbench/evaluate.ts`) follows handoff §8 after #77: an informational gate card (BELOW / MEETS THRESHOLD, PUBLISHED, NOT MEASURED; never locked, no override), the Holdout/Dev run bar (holdout forces the template's models and cannot compare), the latest run of the selected set with dev-only comments (holdout sealed), accuracy by output and the history chart and list."

- [ ] **Step 2: Run** `npm run openapi` (no diff expected after Task 2; commit it if there is one), then `npm run check` → green (lint, typecheck, every TS project, `worker:lint`, `worker:test`). Then `npx prettier --check .`; fix only the reported files with `npx prettier --write <file>`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Docs: gate hints (EV1) and the Evaluate tab redesign in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Never `git add -A`.)
