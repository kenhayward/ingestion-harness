# Workbench 3b/6: Outputs, Sections and Steps Drafting Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the survey, the drafting model proposes the template itself in three stages: **outputs** (fields and tables), **sections** (anchors, checked on every dev sample before the user sees them) and **steps** (the extraction pipeline). Each proposal is a list of changes. The user accepts the ones they want, and those are applied to the open draft. Stages run in order, can be skipped, and are marked **stale** when an earlier stage changes after them.

**Architecture:**
- **Changes.** A proposal body is `{ notes, changes[] }`. Each change is a typed op on one part of the template definition: `putField`, `putTable`, `removeOutput`, `putSection`, `removeSection`, `setCopies`, `putStep`, `removeStep` or `setPreamble`.
  - One pure function, `applyChanges`, applies them, and exists in TypeScript and Python. Both suites run the same JSON fixture, so the two cannot drift.
  - The API applies accepted changes to the draft.
  - The worker applies them only to *validate* a proposal before the user sees it. Errors are fed back to the model through a new `check` hook on the existing validate-and-retry loop.
- **Model output.** The model emits flat, nullable JSON (a provider-friendly schema). The worker converts it into typed changes, validating each item with the template's own Pydantic models.
- **Sections stage.** It runs the real segmenter, `segment_with_timeout` (the same as the anchor preview), on the dev samples. Missed anchors are fed back to the model once, and the final hit and miss grid is stored with the proposal.
- **Stage state** is derived, not stored, from proposals and skips by one pure function, `stageStates`: pending, running, proposed, accepted, skipped or stale. The API enforces the stage order with it, and the web shows it in the tab bar.
- **Conflicts.** A proposal stores the draft definition it was made against. On accept, a change is refused if the draft has changed the item that change touches.

**Tech Stack:** Python 3.13 + pytest + mypy strict + Pydantic (worker), Fastify + Zod (API), React + Testing Library + Vitest (web), Postgres migration.

**Spec:** [docs/design/workbench.md](../../design/workbench.md): "User journey" steps 5–7, "Worker tasks" → `draft`, "Context assembly", "API (sketch)" (stages, skip, decision per change), "UI" (Outputs / Sections / Steps, stage rail), "Risks" (proposal conflicts). Also [ADR 0007](../../adr/0007-workbench.md).

**Depends on:** Workbench phase 3a ([kenhayward/ingestion-harness#38](https://github.com/kenhayward/ingestion-harness/pull/38)) merged to `main`. That PR's migration is `0011_workbench_drafting.sql`, so this plan adds `0012`. Branch from `main` after it lands.

**Scope decision (references stage):**
- The design lists `references` as drafting stage 5 *and* lists "reference proposals and verification" in phase 4.
- A reference must link a dev sample to a verified test-run job. Today `template_references` is keyed by each test run's own document row, and the phase 4 scorecard needs exactly that sample-to-reference link.
- So the references stage moves to **phase 4**, together with the scorecard. 3b ends at a complete, runnable draft: outputs, sections and steps.

## Global Constraints

- **Stage order.** `survey → outputs → sections → steps`. This order is `STAGE_ORDER` in `packages/shared/src/drafting.ts`. A stage can be started or skipped only when every earlier stage is **complete**, meaning accepted (fully or partly) or skipped, at any time. Otherwise 409: `finish the <stage> stage first (accept or skip it)`.
- **Stale.** A completed stage is `stale` when an earlier stage completed after it. Stale stages are never deleted or reset.
- **Change stages** (`outputs`, `sections`, `steps`) need an **open draft**. Otherwise 409: `no open draft; start the next version on the Template tab`. The proposal records `baseVersion` and `baseDefinition`, the draft it was made against.
- **Allowed ops per stage:**
  - outputs: `putField`, `putTable`, `removeOutput`
  - sections: `putSection`, `removeSection`, `setCopies`
  - steps: `putStep`, `removeStep`, `setPreamble`
- **`applyChanges` semantics (TS ≡ Python):**
  - **put:** replaces the item with the same `id`, or appends it.
  - **putField / putTable:** also removes an output of the *other* kind with the same id.
  - **removeOutput:** removes fields and tables with that id.
  - **setCopies:** `null` deletes `document.copies`.
  - **setPreamble:** an empty string deletes `preamble`.
  - `outputs.fields`, `outputs.tables`, `document.sections` and `pipeline` always exist in the result.
- **Decision body:** `{ decision: 'accepted' | 'rejected', changes?: number[] }`.
  - `changes` is required when accepting a change-stage proposal, and allowed only then.
  - Accepting every change gives `accepted`; accepting some gives `partially_accepted`. `acceptedChanges` stores the sorted, de-duplicated indexes.
- **Conflict rule.** For each accepted change, compare the item it targets (`changeTarget`) in `baseDefinition` against the current draft using `stableJson`, which ignores key order because Postgres `jsonb` reorders keys.
  - If any differ: 409 `the draft changed since this proposal where these changes apply: <1-based list>; re-run the stage or accept the others`.
  - If the open draft's version is not `baseVersion`: 409 `the draft version changed since this proposal; re-run the stage`.
- **Model output.**
  - Change stages use flat schemas: every key is required, with `null` for keys that don't apply, and `additionalProperties: false`.
  - The worker converts and validates the output, then feeds errors back through `run_extraction(..., check=...)`. There are at most 2 attempts, and after that the job goes to `needs_review`.
  - The sections stage gets one extra **anchor round** when an anchor misses. A put section is a miss when its anchor matches none of the dev samples, or when it is required and misses any of them.
- **Holdout and data policy** are unchanged from 3a. Only dev samples are sent, through `build_context`, and `enforce_data_policy` runs before every call. The accepted survey body, if any, joins the context as `<survey>`.
- **Migrations and process.** Migrations are forward-only: `db/migrations/0012_workbench_stages.sql`. Zod at every boundary, including stored JSON read back. Use `mypy --strict` and ruff. Never call real LLMs from tests. CI runs `npm run format:check`.
- **Contracts, both sides, this PR:**
  - the change ops and `ChangeBody`, mirrored by `draft_changes.py` and `draft_stages.py`;
  - `applyChanges`, via the shared fixture `packages/shared/test/fixtures/draft-changes.json`;
  - `DraftParams.survey`.

## Review Focus

1. **Accepting only some changes.** The unaccepted changes never reach the draft. The proposal shows `partially_accepted` with the accepted indexes. (Task 6 test.)
2. **The user edited the draft after the proposal was made.** Changes that touch edited items are refused with 409, naming them. The other changes can still be accepted. Key order alone is never a conflict. (Task 1 `stableJson`/`conflictingChanges` tests, Task 6 test.)
3. **Anchors that miss dev samples.** The misses are fed back once. The final grid is shown per proposed section ("found in 1 of 2 dev samples (missed: b.pdf)"). A runaway regex goes to `needs_review` and never hangs the worker. (Task 4 and Task 7 tests.)
4. **A proposed step references an unknown field or section, or leaves an output unfilled.** The Template validation errors go back to the model, then the job goes to `needs_review` with them. (Task 3 test.)
5. **Re-running and accepting an earlier stage.** Later stages show `stale` and keep their history. Starting a stage before its predecessors are complete gets 409. A skip counts as complete. (Task 1 `stageStates` tests, Task 6 tests.)

---

## File map

| File | Responsibility |
| --- | --- |
| `db/migrations/0012_workbench_stages.sql` (new) | Decision `partially_accepted`; `accepted_changes`, `base_version`, `base_definition`; `workbench_stage_skips` |
| `packages/shared/src/drafting.ts` (new) | Change ops, `ChangeBody`, `applyChanges`, `changeTarget`, `stableJson`, `conflictingChanges`, `stageStates`, `blockingStage` |
| `packages/shared/src/workbench.ts`, `index.ts` | `AVAILABLE_STAGES`, `ProposalStatus`, `ProposalView` (body union, `acceptedChanges`) |
| `packages/shared/test/fixtures/draft-changes.json` (new) | `applyChanges` cases shared by both suites |
| `worker/src/ingest_worker/extract.py` | `run_extraction(..., check=…)` |
| `worker/src/ingest_worker/draft_changes.py` (new) | `apply_changes` (mirror) |
| `worker/src/ingest_worker/draft_stages.py` (new) | `Stage`; flat schemas, converters and checks for OUTPUTS, SECTIONS, STEPS |
| `worker/src/ingest_worker/drafting.py` | Stage registry, `DraftParams.survey`, `<survey>` context, convert/check wiring, anchor round |
| `apps/api/src/workbench/repo.ts` | Proposal base and decision fields; skips |
| `apps/api/src/routes/workbench.ts` | Stage order, change-stage start, decision per change, skip, `GET stages` |
| `apps/web/src/api/client.ts`, `test/fake-api.ts` | `decideProposal(..., changes)`, `skipStage`, `listStages` |
| `apps/web/src/workbench/StagePanel.tsx` (new) | Propose, review changes, accept selected, reject, skip; anchor check |
| `apps/web/src/workbench/ProjectPage.tsx`, `SurveyTab.tsx`, `router.ts` | Outputs and Steps tabs, panel on Sections, stage states in the tab bar, survey skip |
| `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md` | Document it |

---

### Task 1: Migration and shared drafting contracts

**Files:**
- Create: `db/migrations/0012_workbench_stages.sql`, `packages/shared/src/drafting.ts`, `packages/shared/test/fixtures/draft-changes.json`, `packages/shared/test/drafting.test.ts`
- Modify: `packages/shared/src/workbench.ts`, `packages/shared/src/index.ts`, `apps/web/test/fake-api.ts` (the `proposalView` builder gains `acceptedChanges: null`)

**Interfaces:**
- Produces (`@ih/shared`):
  - `CHANGE_STAGES = ['outputs', 'sections', 'steps'] as const`, `type ChangeStage`, `isChangeStage(stage: DraftStage): stage is ChangeStage`
  - `DraftChangeSchema` (a discriminated union on `op`), `type DraftChange`, `STAGE_OPS: Record<ChangeStage, readonly DraftChange['op'][]>`
  - `ChangeBodySchema = { notes: string; changes: DraftChange[]; anchorCheck?: SegmentationResult | null }` (strict), `type ChangeBody`, `parseChangeBody(stage: ChangeStage, body: unknown): ChangeBody | null`
  - `type ProposalDecision = 'accepted' | 'partially_accepted' | 'rejected'`
  - `changeTarget(c: DraftChange): string`. The result is one of `output:<id>`, `section:<id>`, `copies`, `step:<id>` or `preamble`.
  - `applyChanges(definition: Record<string, unknown>, changes: DraftChange[]): Record<string, unknown>`
  - `stableJson(v: unknown): string`
  - `conflictingChanges(base, current, changes): number[]`, the indexes into `changes`
  - `STAGE_ORDER: readonly DraftStage[] = ['survey', 'outputs', 'sections', 'steps']`
  - `type StageState = 'pending' | 'running' | 'proposed' | 'accepted' | 'skipped' | 'stale'`
  - `interface StageView { stage: DraftStage; state: StageState; completedAt: string | null }`
  - `interface StageSkip { stage: DraftStage; skippedAt: string }`
  - `stageStates(proposals: { stage: DraftStage; status: ProposalStatus; createdAt: string; decidedAt: string | null }[], skips: StageSkip[]): StageView[]`
  - `blockingStage(states: StageView[], stage: DraftStage): DraftStage | null`
  - `surveyBodyOf(p)` and `changeBodyOf(p)`: narrowing helpers on a `ProposalView`
  - `workbench.ts`:
    - `AVAILABLE_STAGES = ['survey', 'outputs', 'sections', 'steps']`
    - `ProposalStatus` adds `'partially_accepted'`
    - `ProposalView.body: SurveyBody | ChangeBody | null`, plus `acceptedChanges: number[] | null`

- [ ] **Step 1: Write the shared fixture**

`packages/shared/test/fixtures/draft-changes.json`: both the TS and Python suites run every case through `applyChanges` / `apply_changes`. Changes are applied as written, without default-filling.

```json
[
  {
    "name": "putField appends a new field",
    "definition": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": { "ocr": "auto", "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [{ "id": "sender", "type": "text" }], "tables": [] },
      "pipeline": [{ "type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"] }]
    },
    "changes": [
      { "op": "putField", "field": { "id": "sent_on", "type": "date", "description": "Date of the letter" }, "reason": "r" }
    ],
    "expected": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": { "ocr": "auto", "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": {
        "fields": [{ "id": "sender", "type": "text" }, { "id": "sent_on", "type": "date", "description": "Date of the letter" }],
        "tables": []
      },
      "pipeline": [{ "type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"] }]
    }
  },
  {
    "name": "put replaces by id in place and drops an output of the other kind with that id",
    "definition": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": {
        "fields": [{ "id": "sender", "type": "text" }, { "id": "ref", "type": "text" }],
        "tables": [{ "id": "items", "columns": [{ "id": "name", "type": "text" }] }]
      },
      "pipeline": []
    },
    "changes": [
      { "op": "putField", "field": { "id": "sender", "type": "text", "description": "Who wrote it" }, "reason": "r" },
      { "op": "putField", "field": { "id": "items", "type": "list" }, "reason": "r" },
      { "op": "putTable", "table": { "id": "ref", "columns": [{ "id": "code", "type": "text" }] }, "reason": "r" }
    ],
    "expected": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": {
        "fields": [{ "id": "sender", "type": "text", "description": "Who wrote it" }, { "id": "items", "type": "list" }],
        "tables": [{ "id": "ref", "columns": [{ "id": "code", "type": "text" }] }]
      },
      "pipeline": []
    }
  },
  {
    "name": "removeOutput removes the output and ignores unknown ids",
    "definition": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [{ "id": "sender", "type": "text" }], "tables": [] },
      "pipeline": []
    },
    "changes": [
      { "op": "removeOutput", "id": "sender", "reason": "r" },
      { "op": "removeOutput", "id": "nope", "reason": "r" }
    ],
    "expected": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [], "tables": [] },
      "pipeline": []
    }
  },
  {
    "name": "sections: put replaces and appends, setCopies sets",
    "definition": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": { "ocr": "auto", "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [], "tables": [] },
      "pipeline": []
    },
    "changes": [
      { "op": "putSection", "section": { "id": "all", "anchor": "^Dear" }, "reason": "r" },
      { "op": "putSection", "section": { "id": "sig", "anchor": "^Yours", "required": false }, "reason": "r" },
      { "op": "setCopies", "copies": { "anchor": "^LETTER", "select": "last" }, "reason": "r" }
    ],
    "expected": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": {
        "ocr": "auto",
        "sections": [{ "id": "all", "anchor": "^Dear" }, { "id": "sig", "anchor": "^Yours", "required": false }],
        "copies": { "anchor": "^LETTER", "select": "last" }
      },
      "outputs": { "fields": [], "tables": [] },
      "pipeline": []
    }
  },
  {
    "name": "removeSection drops a section and setCopies null clears copy selection",
    "definition": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": {
        "sections": [{ "id": "all", "anchor": "\\A" }, { "id": "sig", "anchor": "^Yours" }],
        "copies": { "anchor": "^LETTER", "select": "first" }
      },
      "outputs": { "fields": [], "tables": [] },
      "pipeline": []
    },
    "changes": [
      { "op": "removeSection", "id": "sig", "reason": "r" },
      { "op": "setCopies", "copies": null, "reason": "r" }
    ],
    "expected": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [], "tables": [] },
      "pipeline": []
    }
  },
  {
    "name": "steps: putStep replaces in place and appends, setPreamble sets",
    "definition": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [{ "id": "sender", "type": "text" }], "tables": [] },
      "pipeline": [{ "type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"] }]
    },
    "changes": [
      { "op": "putStep", "step": { "type": "check", "id": "c1", "values": "sender", "reference": "sender" }, "reason": "r" },
      { "op": "putStep", "step": { "type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"], "instructions": "Top of page 1" }, "reason": "r" },
      { "op": "setPreamble", "preamble": "Letters to QA.", "reason": "r" }
    ],
    "expected": {
      "id": "letter", "version": 2, "name": "Letter",
      "preamble": "Letters to QA.",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [{ "id": "sender", "type": "text" }], "tables": [] },
      "pipeline": [
        { "type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"], "instructions": "Top of page 1" },
        { "type": "check", "id": "c1", "values": "sender", "reference": "sender" }
      ]
    }
  },
  {
    "name": "removeStep drops a step and an empty preamble removes it",
    "definition": {
      "id": "letter", "version": 2, "name": "Letter", "preamble": "Old.",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [], "tables": [] },
      "pipeline": [{ "type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"] }]
    },
    "changes": [
      { "op": "removeStep", "id": "head", "reason": "r" },
      { "op": "setPreamble", "preamble": "", "reason": "r" }
    ],
    "expected": {
      "id": "letter", "version": 2, "name": "Letter",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [], "tables": [] },
      "pipeline": []
    }
  },
  {
    "name": "missing blocks are created",
    "definition": { "id": "letter", "version": 1, "name": "Letter" },
    "changes": [{ "op": "putSection", "section": { "id": "all", "anchor": "\\A" }, "reason": "r" }],
    "expected": {
      "id": "letter", "version": 1, "name": "Letter",
      "document": { "sections": [{ "id": "all", "anchor": "\\A" }] },
      "outputs": { "fields": [], "tables": [] },
      "pipeline": []
    }
  }
]
```

- [ ] **Step 2: Write the failing tests**

`packages/shared/test/drafting.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DraftChangeSchema,
  applyChanges,
  blockingStage,
  conflictingChanges,
  parseChangeBody,
  stableJson,
  stageStates,
  type DraftChange,
} from '../src/index.js';

const cases = JSON.parse(
  readFileSync(new URL('./fixtures/draft-changes.json', import.meta.url), 'utf8'),
) as {
  name: string;
  definition: Record<string, unknown>;
  changes: unknown[];
  expected: Record<string, unknown>;
}[];

describe('applyChanges (fixture shared with worker/tests/test_draft_changes.py)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    for (const change of c.changes) expect(DraftChangeSchema.safeParse(change).success).toBe(true);
    expect(applyChanges(c.definition, c.changes as DraftChange[])).toEqual(c.expected);
  });

  it('never mutates its input', () => {
    const c = cases[0]!;
    const before = JSON.stringify(c.definition);
    applyChanges(c.definition, c.changes as DraftChange[]);
    expect(JSON.stringify(c.definition)).toBe(before);
  });
});

describe('change bodies', () => {
  const field = { op: 'putField', field: { id: 'a', type: 'text' }, reason: 'r' };
  const step = {
    op: 'putStep',
    step: { type: 'extract', id: 's', fields: ['a'], sections: ['all'] },
    reason: 'r',
  };

  it('accepts only the ops of the stage', () => {
    expect(parseChangeBody('outputs', { notes: '', changes: [field] })?.changes).toHaveLength(1);
    expect(parseChangeBody('outputs', { notes: '', changes: [step] })).toBeNull();
    expect(parseChangeBody('steps', { notes: '', changes: [step] })?.changes[0]).toMatchObject({
      op: 'putStep',
    });
  });

  it('rejects unknown keys and invalid items', () => {
    expect(parseChangeBody('outputs', { notes: '', changes: [], extra: 1 })).toBeNull();
    const badEnum = { op: 'putField', field: { id: 'a', type: 'enum' }, reason: 'r' };
    expect(parseChangeBody('outputs', { notes: '', changes: [badEnum] })).toBeNull();
  });
});

describe('conflicts', () => {
  const base = {
    outputs: { fields: [{ id: 'sender', type: 'text', description: 'x' }], tables: [] },
    document: { sections: [{ id: 'all', anchor: '\\A' }] },
    pipeline: [],
  };
  const change = (id: string): DraftChange => ({
    op: 'putField',
    field: { id, type: 'text' },
    reason: 'r',
  });

  it('ignores key order (jsonb reorders keys)', () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    const reordered = {
      pipeline: [],
      document: { sections: [{ anchor: '\\A', id: 'all' }] },
      outputs: { tables: [], fields: [{ description: 'x', type: 'text', id: 'sender' }] },
    };
    expect(conflictingChanges(base, reordered, [change('sender')])).toEqual([]);
  });

  it('flags only changes whose target was edited since the proposal', () => {
    const edited = {
      ...base,
      outputs: { fields: [{ id: 'sender', type: 'text', description: 'edited' }], tables: [] },
    };
    expect(conflictingChanges(base, edited, [change('new_one'), change('sender')])).toEqual([1]);
  });
});

describe('stage states', () => {
  const t = (n: number) => `2026-10-12T10:00:0${n}.000Z`;
  const proposal = (
    stage: 'survey' | 'outputs' | 'sections' | 'steps',
    status: 'running' | 'ready' | 'failed' | 'accepted' | 'partially_accepted' | 'rejected',
    createdAt: string,
    decidedAt: string | null = null,
  ) => ({ stage, status, createdAt, decidedAt });

  it('starts pending and blocks later stages until earlier ones are complete', () => {
    const states = stageStates([], []);
    expect(states.map((s) => s.state)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(blockingStage(states, 'survey')).toBeNull();
    expect(blockingStage(states, 'outputs')).toBe('survey');
  });

  it('treats a skip as complete and shows running and proposed work', () => {
    const states = stageStates(
      [proposal('outputs', 'ready', t(2)), proposal('sections', 'running', t(3))],
      [{ stage: 'survey', skippedAt: t(1) }],
    );
    expect(states.map((s) => s.state)).toEqual(['skipped', 'proposed', 'running', 'pending']);
    expect(blockingStage(states, 'outputs')).toBeNull();
    expect(blockingStage(states, 'sections')).toBe('outputs');
  });

  it('marks later stages stale when an earlier stage completes after them, keeping them complete', () => {
    const states = stageStates(
      [
        proposal('survey', 'accepted', t(1), t(2)),
        proposal('outputs', 'partially_accepted', t(3), t(4)),
        proposal('survey', 'accepted', t(5), t(6)),
      ],
      [],
    );
    expect(states.map((s) => s.state)).toEqual(['accepted', 'stale', 'pending', 'pending']);
    expect(blockingStage(states, 'sections')).toBeNull();
  });

  it('a rejected or failed latest proposal leaves the earlier completion in place', () => {
    const states = stageStates(
      [
        proposal('survey', 'accepted', t(1), t(2)),
        proposal('survey', 'rejected', t(3), t(4)),
        proposal('outputs', 'failed', t(5)),
      ],
      [],
    );
    expect(states.map((s) => s.state)).toEqual(['accepted', 'pending', 'pending', 'pending']);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/shared/test/drafting.test.ts`
Expected: FAIL. `applyChanges` is not exported.

- [ ] **Step 4: Write the migration**

`db/migrations/0012_workbench_stages.sql`:

```sql
-- Workbench phase 3b (ADR 0007): per-change decisions, the draft a proposal was made against,
-- and stage skips. Stage state is derived from proposals and skips (packages/shared drafting.ts).

ALTER TABLE workbench_proposals DROP CONSTRAINT workbench_proposals_decision_check;
ALTER TABLE workbench_proposals ADD CONSTRAINT workbench_proposals_decision_check
  CHECK (decision IN ('accepted', 'partially_accepted', 'rejected'));

ALTER TABLE workbench_proposals
  ADD COLUMN accepted_changes integer[],
  ADD COLUMN base_version     integer,
  ADD COLUMN base_definition  jsonb;

CREATE TABLE workbench_stage_skips (
  id          bigserial   PRIMARY KEY,
  project_id  text        NOT NULL REFERENCES workbench_projects (id),
  stage       text        NOT NULL CHECK (stage IN ('survey', 'outputs', 'sections', 'steps', 'references')),
  skipped_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_stage_skips_project_idx ON workbench_stage_skips (project_id, skipped_at DESC);
```

(`workbench_proposals_decision_check` is the name Postgres gave the inline column CHECK in 0011. Check `0011_workbench_drafting.sql` before relying on it.)

- [ ] **Step 5: Write `packages/shared/src/drafting.ts`**

```ts
import { z } from 'zod';
import { CopySelectionSchema, SectionSchema } from './spec.js';
import { StepSchema, TableDefSchema, ValueDefSchema } from './template.js';
import {
  SegmentationResultSchema,
  type DraftStage,
  type ProposalStatus,
  type ProposalView,
  type SurveyBody,
} from './workbench.js';

/**
 * Drafting stages that propose changes to the draft template (ADR 0007, phase 3b).
 * Mirrors worker/src/ingest_worker/draft_changes.py (apply) and draft_stages.py (ops per stage).
 */
export const CHANGE_STAGES = ['outputs', 'sections', 'steps'] as const;
export type ChangeStage = (typeof CHANGE_STAGES)[number];
export const isChangeStage = (stage: DraftStage): stage is ChangeStage =>
  (CHANGE_STAGES as readonly string[]).includes(stage);

const reason = z.string();
export const DraftChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('putField'), field: ValueDefSchema, reason }).strict(),
  z.object({ op: z.literal('putTable'), table: TableDefSchema, reason }).strict(),
  z.object({ op: z.literal('removeOutput'), id: z.string(), reason }).strict(),
  z.object({ op: z.literal('putSection'), section: SectionSchema, reason }).strict(),
  z.object({ op: z.literal('removeSection'), id: z.string(), reason }).strict(),
  z.object({ op: z.literal('setCopies'), copies: CopySelectionSchema.nullable(), reason }).strict(),
  z.object({ op: z.literal('putStep'), step: StepSchema, reason }).strict(),
  z.object({ op: z.literal('removeStep'), id: z.string(), reason }).strict(),
  z.object({ op: z.literal('setPreamble'), preamble: z.string(), reason }).strict(),
]);
export type DraftChange = z.infer<typeof DraftChangeSchema>;

export const STAGE_OPS: Record<ChangeStage, readonly DraftChange['op'][]> = {
  outputs: ['putField', 'putTable', 'removeOutput'],
  sections: ['putSection', 'removeSection', 'setCopies'],
  steps: ['putStep', 'removeStep', 'setPreamble'],
};

/** Body of an outputs/sections/steps proposal (worker draft task, runs bucket). */
export const ChangeBodySchema = z
  .object({
    notes: z.string(),
    changes: z.array(DraftChangeSchema),
    /** sections stage: the proposal's anchors applied to every dev sample (worker). */
    anchorCheck: SegmentationResultSchema.nullable().optional(),
  })
  .strict();
export type ChangeBody = z.infer<typeof ChangeBodySchema>;

/** A stage body, or null if it is malformed or uses an op the stage may not. */
export function parseChangeBody(stage: ChangeStage, body: unknown): ChangeBody | null {
  const parsed = ChangeBodySchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.changes.every((c) => STAGE_OPS[stage].includes(c.op)) ? parsed.data : null;
}

export type ProposalDecision = 'accepted' | 'partially_accepted' | 'rejected';

type Def = Record<string, unknown>;
const obj = (v: unknown): Def => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {});
const list = (v: unknown): Def[] => (Array.isArray(v) ? (v as Def[]) : []);
const put = (items: Def[], item: Def) => {
  const i = items.findIndex((x) => x.id === item.id);
  return i < 0 ? [...items, item] : items.map((x, j) => (j === i ? item : x));
};
const drop = (items: Def[], id: unknown) => items.filter((x) => x.id !== id);

/** The part of a definition a change touches (conflict detection). */
export function changeTarget(c: DraftChange): string {
  switch (c.op) {
    case 'putField':
      return `output:${c.field.id}`;
    case 'putTable':
      return `output:${c.table.id}`;
    case 'removeOutput':
      return `output:${c.id}`;
    case 'putSection':
      return `section:${c.section.id}`;
    case 'removeSection':
      return `section:${c.id}`;
    case 'setCopies':
      return 'copies';
    case 'putStep':
      return `step:${c.step.id}`;
    case 'removeStep':
      return `step:${c.id}`;
    case 'setPreamble':
      return 'preamble';
  }
}

function valueAt(def: Def, target: string): unknown {
  const [kind, id] = target.split(':', 2) as [string, string | undefined];
  const outputs = obj(def.outputs);
  const document = obj(def.document);
  if (kind === 'output') {
    return [...list(outputs.fields), ...list(outputs.tables)].find((o) => o.id === id) ?? null;
  }
  if (kind === 'section') return list(document.sections).find((s) => s.id === id) ?? null;
  if (kind === 'copies') return document.copies ?? null;
  if (kind === 'step') return list(def.pipeline).find((s) => s.id === id) ?? null;
  return def.preamble ?? null;
}

/** JSON with object keys sorted, so key order (which jsonb does not keep) never matters. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Def;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Indexes of changes whose target differs between the proposal's base and the current draft. */
export function conflictingChanges(base: Def, current: Def, changes: DraftChange[]): number[] {
  return changes.flatMap((c, i) => {
    const target = changeTarget(c);
    return stableJson(valueAt(base, target)) === stableJson(valueAt(current, target)) ? [] : [i];
  });
}

/** Apply changes to a definition (pure). Mirrors worker draft_changes.apply_changes. */
export function applyChanges(definition: Def, changes: DraftChange[]): Def {
  const outputsIn = obj(definition.outputs);
  let fields = list(outputsIn.fields);
  let tables = list(outputsIn.tables);
  const document: Def = { ...obj(definition.document) };
  let sections = list(document.sections);
  let pipeline = list(definition.pipeline);
  let preamble = definition.preamble;
  for (const c of changes) {
    switch (c.op) {
      case 'putField':
        fields = put(fields, c.field as Def);
        tables = drop(tables, c.field.id);
        break;
      case 'putTable':
        tables = put(tables, c.table as Def);
        fields = drop(fields, c.table.id);
        break;
      case 'removeOutput':
        fields = drop(fields, c.id);
        tables = drop(tables, c.id);
        break;
      case 'putSection':
        sections = put(sections, c.section as Def);
        break;
      case 'removeSection':
        sections = drop(sections, c.id);
        break;
      case 'setCopies':
        if (c.copies === null) delete document.copies;
        else document.copies = c.copies;
        break;
      case 'putStep':
        pipeline = put(pipeline, c.step as Def);
        break;
      case 'removeStep':
        pipeline = drop(pipeline, c.id);
        break;
      case 'setPreamble':
        preamble = c.preamble;
        break;
    }
  }
  const out: Def = {
    ...definition,
    document: { ...document, sections },
    outputs: { ...outputsIn, fields, tables },
    pipeline,
  };
  if (preamble) out.preamble = preamble;
  else delete out.preamble;
  return out;
}

/** Drafting stages in order (3b; `references` joins in phase 4). */
export const STAGE_ORDER: readonly DraftStage[] = ['survey', 'outputs', 'sections', 'steps'];

export type StageState = 'pending' | 'running' | 'proposed' | 'accepted' | 'skipped' | 'stale';

export interface StageView {
  stage: DraftStage;
  state: StageState;
  /** Last time the stage was accepted (fully or partly) or skipped; null if never. */
  completedAt: string | null;
}

export interface StageSkip {
  stage: DraftStage;
  skippedAt: string;
}

type ProposalLike = { stage: DraftStage; status: ProposalStatus; createdAt: string; decidedAt: string | null };

/**
 * Stage state, derived (never stored): a stage is complete once accepted or skipped; it is
 * stale when an earlier stage completed after it; newer running/ready work shows over it.
 */
export function stageStates(proposals: ProposalLike[], skips: StageSkip[]): StageView[] {
  const completions = STAGE_ORDER.map((stage) => {
    const done = [
      ...proposals
        .filter(
          (p) =>
            p.stage === stage &&
            (p.status === 'accepted' || p.status === 'partially_accepted') &&
            p.decidedAt !== null,
        )
        .map((p) => ({ kind: 'accepted' as const, at: p.decidedAt! })),
      ...skips.filter((s) => s.stage === stage).map((s) => ({ kind: 'skipped' as const, at: s.skippedAt })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    return done[0] ?? null;
  });
  return STAGE_ORDER.map((stage, i) => {
    const done = completions[i] ?? null;
    const latest = proposals
      .filter((p) => p.stage === stage)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const active =
      latest !== undefined &&
      (latest.status === 'running' || latest.status === 'ready') &&
      (done === null || latest.createdAt > done.at);
    const stale = done !== null && completions.slice(0, i).some((c) => c !== null && c.at > done.at);
    const state: StageState = active
      ? latest.status === 'running'
        ? 'running'
        : 'proposed'
      : done
        ? stale
          ? 'stale'
          : done.kind
        : 'pending';
    return { stage, state, completedAt: done?.at ?? null };
  });
}

/** The first earlier stage that is not complete, or null when `stage` may run. */
export function blockingStage(states: StageView[], stage: DraftStage): DraftStage | null {
  const index = STAGE_ORDER.indexOf(stage);
  return states.slice(0, Math.max(index, 0)).find((s) => s.completedAt === null)?.stage ?? null;
}

export const surveyBodyOf = (p: Pick<ProposalView, 'stage' | 'body'>): SurveyBody | null =>
  p.stage === 'survey' ? (p.body as SurveyBody | null) : null;
export const changeBodyOf = (p: Pick<ProposalView, 'stage' | 'body'>): ChangeBody | null =>
  p.stage !== 'survey' ? (p.body as ChangeBody | null) : null;
```

In `packages/shared/src/workbench.ts`:
- Set `AVAILABLE_STAGES: readonly DraftStage[] = ['survey', 'outputs', 'sections', 'steps']` and update its comment: "3b; `references` comes with phase 4".
- Change the status union to `export type ProposalStatus = 'running' | 'ready' | 'failed' | 'accepted' | 'partially_accepted' | 'rejected';`.
- Change `ProposalView`:

```ts
/** Type-only stand-in for drafting.ts ChangeBody (avoids a runtime import cycle). */
export type ChangeBodyLike = import('./drafting.js').ChangeBody;

export interface ProposalView {
  id: string;
  stage: DraftStage;
  status: ProposalStatus;
  error: string | null;
  briefVersion: number | null;
  /** Resolved model that produced it (once ready). */
  model: string | null;
  /** survey: SurveyBody; outputs/sections/steps: ChangeBody. Null until ready. */
  body: SurveyBody | ChangeBodyLike | null;
  /** Indexes of the changes applied to the draft (accepted / partially_accepted). */
  acceptedChanges: number[] | null;
  createdAt: string;
  decidedAt: string | null;
}
```

(drafting.ts imports runtime values from workbench.ts, and workbench.ts imports only types from drafting.ts, so there is no runtime cycle. If ESLint objects to the inline `import()` type, use `import type { ChangeBody } from './drafting.js'` at the top of workbench.ts instead and drop `ChangeBodyLike`. Use whichever the lint config accepts, and say which in the report.)

In `packages/shared/src/index.ts`, add `export * from './drafting.js';`.

- [ ] **Step 6: Run tests, fix fallout**

Run: `npx vitest run packages/shared && npm run typecheck`
Expected: the shared tests PASS. The typecheck lists the `ProposalView` literals that lack `acceptedChanges`:
- `proposalView()` in `apps/api/src/routes/workbench.ts`: add `acceptedChanges: null` to `base` for now. Task 6 fills it in.
- `proposalView()` builder in `apps/web/test/fake-api.ts`: add `acceptedChanges: null`.

Two more cases to handle:
- `SurveyTab.tsx` reads `proposal.body` as a survey. Replace those reads with `surveyBodyOf(proposal)`.
- Code that switches on `ProposalStatus` (for example, a status label map) may need `partially_accepted`.

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/0012_workbench_stages.sql packages/shared apps
git commit -m "Workbench: migration 0012 and drafting change contracts (applyChanges, stage states)"
```

---

### Task 2: Worker: `apply_changes` mirror and the `check` hook

**Files:**
- Create: `worker/src/ingest_worker/draft_changes.py`, `worker/tests/test_draft_changes.py`
- Modify: `worker/src/ingest_worker/extract.py`, `worker/tests/test_extract.py`

**Interfaces:**
- Produces:
  - `draft_changes.apply_changes(definition: dict[str, Any], changes: list[dict[str, Any]]) -> dict[str, Any]`: pure, with the same semantics as TS `applyChanges`
  - `extract.run_extraction(..., check: Callable[[dict[str, Any]], list[str]] | None = None)`. After the JSON Schema validation passes, `check(data)` runs. A non-empty list is treated exactly like schema errors: recorded on the attempt and fed back, and the call raises `ExtractionFailedError` when attempts run out.

- [ ] **Step 1: Write the failing tests**

`worker/tests/test_draft_changes.py`:

```python
"""apply_changes mirrors packages/shared/src/drafting.ts applyChanges (shared fixture)."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from ingest_worker.config import REPO_ROOT
from ingest_worker.draft_changes import apply_changes

FIXTURE = REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "draft-changes.json"
CASES: list[dict[str, Any]] = json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_apply_changes_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    assert apply_changes(case["definition"], case["changes"]) == case["expected"]


def test_apply_changes_never_mutates_its_input() -> None:
    case = CASES[0]
    before = copy.deepcopy(case["definition"])
    apply_changes(case["definition"], case["changes"])
    assert case["definition"] == before


def test_unknown_op_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown change op"):
        apply_changes({}, [{"op": "rename"}])
```

Append to `worker/tests/test_extract.py`:

```python
def test_check_errors_are_fed_back_like_schema_errors() -> None:
    provider = FakeProvider("p", responses=[{"n": 1}, {"n": 2}])
    result = run_extraction(
        extraction_id="x",
        provider=provider,
        model_id="m",
        prompt="P",
        schema={"type": "object"},
        max_attempts=2,
        check=lambda data: [] if data["n"] == 2 else ["n must be 2"],
    )
    assert result.data == {"n": 2}
    assert result.attempts[0].errors == ["n must be 2"]
    assert "n must be 2" in provider.calls[1][1].prompt


def test_check_failing_every_attempt_raises() -> None:
    provider = FakeProvider("p", responses=[{"n": 1}, {"n": 1}])
    with pytest.raises(ExtractionFailedError, match="n must be 2"):
        run_extraction(
            extraction_id="x",
            provider=provider,
            model_id="m",
            prompt="P",
            schema={"type": "object"},
            max_attempts=2,
            check=lambda data: ["n must be 2"],
        )
```

(Use the imports `test_extract.py` already has, and add `ExtractionFailedError` / `pytest` if missing. Check `FakeProvider`'s constructor in `tests/fakes.py`: it takes `responses=`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_draft_changes.py tests/test_extract.py -q`
Expected: FAIL. `ingest_worker.draft_changes` does not exist, and `run_extraction` has no `check`.

- [ ] **Step 3: Implement**

`worker/src/ingest_worker/draft_changes.py`:

```python
"""Apply drafting changes to a template definition (ADR 0007, phase 3b).

Mirrors packages/shared/src/drafting.ts applyChanges; both suites run
packages/shared/test/fixtures/draft-changes.json. Pure: the input is never mutated."""

from __future__ import annotations

import copy
from typing import Any

Definition = dict[str, Any]


def _list(value: Any) -> list[dict[str, Any]]:
    return list(value) if isinstance(value, list) else []


def _obj(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _put(items: list[dict[str, Any]], item: dict[str, Any]) -> list[dict[str, Any]]:
    for i, existing in enumerate(items):
        if existing.get("id") == item["id"]:
            return [*items[:i], item, *items[i + 1 :]]
    return [*items, item]


def _drop(items: list[dict[str, Any]], item_id: Any) -> list[dict[str, Any]]:
    return [x for x in items if x.get("id") != item_id]


def apply_changes(definition: Definition, changes: list[dict[str, Any]]) -> Definition:
    out = copy.deepcopy(definition)
    outputs = _obj(out.get("outputs"))
    fields, tables = _list(outputs.get("fields")), _list(outputs.get("tables"))
    document = _obj(out.get("document"))
    sections = _list(document.get("sections"))
    pipeline = _list(out.get("pipeline"))
    preamble = out.get("preamble")
    for change in copy.deepcopy(changes):
        op = change.get("op")
        if op == "putField":
            fields = _put(fields, change["field"])
            tables = _drop(tables, change["field"]["id"])
        elif op == "putTable":
            tables = _put(tables, change["table"])
            fields = _drop(fields, change["table"]["id"])
        elif op == "removeOutput":
            fields, tables = _drop(fields, change["id"]), _drop(tables, change["id"])
        elif op == "putSection":
            sections = _put(sections, change["section"])
        elif op == "removeSection":
            sections = _drop(sections, change["id"])
        elif op == "setCopies":
            if change["copies"] is None:
                document.pop("copies", None)
            else:
                document["copies"] = change["copies"]
        elif op == "putStep":
            pipeline = _put(pipeline, change["step"])
        elif op == "removeStep":
            pipeline = _drop(pipeline, change["id"])
        elif op == "setPreamble":
            preamble = change["preamble"]
        else:
            raise ValueError(f"unknown change op {op!r}")
    out["outputs"] = {**outputs, "fields": fields, "tables": tables}
    out["document"] = {**document, "sections": sections}
    out["pipeline"] = pipeline
    if preamble:
        out["preamble"] = preamble
    else:
        out.pop("preamble", None)
    return out
```

In `extract.py`:
- Add `from collections.abc import Callable` to the imports.
- Add the keyword-only parameter `check: Callable[[dict[str, Any]], list[str]] | None = None` to `run_extraction`, and extend its docstring: "`check` adds rules JSON Schema cannot express; its errors are fed back the same way."
- Directly after `data, errors = validate(result.text, validator)`:

```python
        if data is not None and check is not None:
            errors = check(data)
            if errors:
                data = None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run mypy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "Worker: apply_changes (shared fixture with TS) and a check hook on run_extraction"
```

---

### Task 3: Worker: the outputs and steps stages

**Files:**
- Create: `worker/src/ingest_worker/draft_stages.py`, `worker/tests/test_draft_stages.py`
- Modify: `worker/src/ingest_worker/drafting.py`, `worker/tests/test_drafting.py`

**Interfaces:**
- Consumes: `apply_changes` and the `check=` hook (Task 2); the template models `ValueDef`, `TableDef`, `ExtractStep`, `CheckStep`, `Template`, `RESERVED_OUTPUT_IDS` (`template.py`); `Section`, `CopySelection` (`specs.py`).
- Produces:
  - `draft_stages.Stage(id: str, instructions: str, schema: dict[str, Any], convert: Converter | None = None, check: Checker | None = None)`, a frozen dataclass, where:
    - `Converter = Callable[[dict[str, Any]], tuple[dict[str, Any], list[str]]]` turns flat model output into a `ChangeBody` plus errors;
    - `Checker = Callable[[dict[str, Any], dict[str, Any]], list[str]]` takes the typed body and the draft and returns errors.
  - `draft_stages.OUTPUTS`, `draft_stages.STEPS` (this task) and `draft_stages.SECTIONS` (Task 4)
  - `drafting.Stage` is now imported from `draft_stages`; `drafting.SURVEY` stays where it is.
  - `drafting.STAGES` holds `survey`, `outputs` and `steps`; Task 4 adds `sections`.
  - `drafting.DraftParams.survey: dict[str, Any] | None = None`
  - `drafting.build_context(..., survey: dict[str, Any] | None = None)` adds a `<survey>` block.
  - Change stages without `params.draft` raise `DocumentError("drafting stage <id> needs the current draft")`.

- [ ] **Step 1: Write the failing tests**

`worker/tests/test_draft_stages.py`:

```python
"""Change stages: flat model output -> typed changes, validated against the draft."""

from __future__ import annotations

from typing import Any

from ingest_worker.draft_stages import OUTPUTS, STEPS

DRAFT: dict[str, Any] = {
    "id": "letter",
    "version": 2,
    "name": "Letter",
    "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
    "outputs": {"fields": [], "tables": []},
    "pipeline": [],
}


def output_item(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "op": "putField", "id": "sender", "name": None, "type": "text",
        "description": "Who wrote it", "enum": None, "columns": None, "reason": "r",
    }
    return {**base, **kw}


def step_item(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "op": "putStep", "id": "head", "type": "extract", "fields": ["sender"], "table": None,
        "sections": ["all"], "instructions": "Top of page 1", "pageImages": None,
        "chunkPages": None, "context": None, "description": None, "values": None,
        "reference": None, "aliases": None, "preamble": None, "reason": "r",
    }
    return {**base, **kw}


def run(stage: Any, data: dict[str, Any], draft: dict[str, Any] = DRAFT) -> tuple[dict[str, Any], list[str]]:
    body, errors = stage.convert(data)
    return body, errors or stage.check(body, draft)


def test_outputs_convert_fields_and_tables_to_typed_changes() -> None:
    columns = [{"id": "name", "name": None, "type": "text", "description": None, "enum": None}]
    body, errors = run(
        OUTPUTS,
        {"notes": "n", "changes": [output_item(), output_item(op="putTable", id="items", type=None, columns=columns)]},
    )
    assert errors == []
    assert body == {
        "notes": "n",
        "changes": [
            {"op": "putField", "field": {"id": "sender", "description": "Who wrote it"}, "reason": "r"},
            {"op": "putTable", "table": {"id": "items", "columns": [{"id": "name"}]}, "reason": "r"},
        ],
    }


def test_outputs_report_invalid_items_and_reserved_or_unknown_ids() -> None:
    _, errors = run(OUTPUTS, {"notes": "", "changes": [output_item(type="enum", enum=None)]})
    assert any("changes[0]" in e and "enum" in e for e in errors)
    _, errors = run(
        OUTPUTS,
        {"notes": "", "changes": [output_item(op="putTable", id="issues", columns=[{"id": "x", "name": None, "type": "text", "description": None, "enum": None}])]},
    )
    assert any("reserved" in e for e in errors)
    _, errors = run(OUTPUTS, {"notes": "", "changes": [output_item(op="removeOutput", id="nope")]})
    assert any("no such output" in e for e in errors)


def test_steps_validate_the_whole_template_after_applying() -> None:
    draft = {**DRAFT, "outputs": {"fields": [{"id": "sender"}], "tables": []}}
    body, errors = run(STEPS, {"notes": "", "changes": [step_item()]}, draft)
    assert errors == []
    assert body["changes"][0]["step"] == {
        "type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"],
        "instructions": "Top of page 1",
    }
    _, errors = run(STEPS, {"notes": "", "changes": [step_item(sections=["nope"])]}, draft)
    assert any("unknown section" in e for e in errors)
    _, errors = run(STEPS, {"notes": "", "changes": [step_item(fields=["other"])]}, draft)
    assert any("unknown field" in e for e in errors) and any("not filled" in e for e in errors)


def test_steps_convert_context_checks_and_preamble() -> None:
    draft = {**DRAFT, "outputs": {"fields": [{"id": "sender"}, {"id": "ref"}], "tables": []}}
    changes = [
        step_item(),
        step_item(id="tail", fields=["ref"], context=[{"name": "who", "path": "sender"}]),
        step_item(id="same", type="check", fields=None, sections=None, values="ref", reference="sender"),
        step_item(op="setPreamble", id="", preamble="Letters to QA."),
    ]
    body, errors = run(STEPS, {"notes": "", "changes": changes}, draft)
    assert errors == []
    assert body["changes"][1]["step"]["context"] == {"who": "sender"}
    assert body["changes"][2]["step"] == {"type": "check", "id": "same", "values": "ref", "reference": "sender"}
    assert body["changes"][3] == {"op": "setPreamble", "preamble": "Letters to QA.", "reason": "r"}
```

Append to `worker/tests/test_drafting.py`. It reuses that file's `draft_job`, `make`, `DRAFT` and `SURVEY_BODY`; check the names in the file.

```python
OUTPUTS_BODY = {
    "notes": "",
    "changes": [
        {
            "op": "putField", "id": "protocol_number", "name": None, "type": "text",
            "description": "Protocol id, e.g. PVP/23/003", "enum": None, "columns": None,
            "reason": "header of every sample",
        }
    ],
}


def test_outputs_job_writes_typed_changes_and_sees_the_accepted_survey(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [OUTPUTS_BODY]
    queue = FakeQueue(jobs=[draft_job(stage="outputs", survey=SURVEY_BODY)])
    run_once(queue, deps, "w1")
    result = json.loads(store.get("runs", drafting_key("letter", "job-d")))
    assert result["body"]["changes"] == [
        {
            "op": "putField",
            "field": {"id": "protocol_number", "description": "Protocol id, e.g. PVP/23/003"},
            "reason": "header of every sample",
        }
    ]
    [(_, request)] = provider.calls
    assert "<survey>" in request.prompt and "Process validation protocols." in request.prompt


def test_steps_errors_are_fed_back_then_need_review(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    bad = {
        "notes": "",
        "changes": [
            {
                "op": "putStep", "id": "head", "type": "extract", "fields": ["missing"],
                "table": None, "sections": ["all"], "instructions": None, "pageImages": None,
                "chunkPages": None, "context": None, "description": None, "values": None,
                "reference": None, "aliases": None, "preamble": None, "reason": "r",
            }
        ],
    }
    provider.responses = [bad, bad]
    queue = FakeQueue(jobs=[draft_job(stage="steps")])
    run_once(queue, deps, "w1")
    assert len(provider.calls) == 2
    assert "unknown field" in provider.calls[1][1].prompt
    [(_, reason)] = queue.reviewed
    assert "unknown field" in reason


def test_change_stage_without_a_draft_needs_review(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[draft_job(stage="outputs", draft=None)])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "needs the current draft" in reason and provider.calls == []
```

The phase-3a test `test_unknown_stage_needs_review` used `stage="outputs"`, which is now available. Change it to `stage="references"` and keep its assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_draft_stages.py tests/test_drafting.py -q`
Expected: FAIL. `ingest_worker.draft_stages` does not exist.

- [ ] **Step 3: Write `draft_stages.py`**

```python
"""Drafting stages that propose changes to the draft template (ADR 0007, phase 3b).

Models answer in a flat JSON shape (every key present, null when not applicable), which every
provider's structured output accepts. `convert` turns that into the typed changes of
packages/shared/src/drafting.ts (DraftChange), validating each item with the template's own
Pydantic models; `check` validates the changes against the current draft. Both feed their
errors back to the model through run_extraction(check=...)."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, get_args

from pydantic import BaseModel, ValidationError

from .draft_changes import apply_changes
from .normalize import ValueType
from .specs import CopySelection, Section
from .template import RESERVED_OUTPUT_IDS, CheckStep, ExtractStep, TableDef, Template, ValueDef

Converter = Callable[[dict[str, Any]], tuple[dict[str, Any], list[str]]]
Checker = Callable[[dict[str, Any], dict[str, Any]], list[str]]


@dataclass(frozen=True)
class Stage:
    id: str
    instructions: str
    schema: dict[str, Any]
    convert: Converter | None = None
    check: Checker | None = None


def _object(props: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


_S: dict[str, Any] = {"type": "string"}
_NS: dict[str, Any] = {"type": ["string", "null"]}
_NSA: dict[str, Any] = {"type": ["array", "null"], "items": {"type": "string"}}


def _ops(*ops: str) -> dict[str, Any]:
    return {"type": "string", "enum": list(ops)}


def _body(item: dict[str, Any]) -> dict[str, Any]:
    return _object({"notes": _S, "changes": {"type": "array", "items": item}})


_TYPE = {"type": ["string", "null"], "enum": [*get_args(ValueType), None]}
_VALUE = _object({"id": _S, "name": _NS, "type": _TYPE, "description": _NS, "enum": _NSA})

OUTPUTS_SCHEMA = _body(
    _object(
        {
            "op": _ops("putField", "putTable", "removeOutput"),
            "id": _S,
            "name": _NS,
            "type": _TYPE,
            "description": _NS,
            "enum": _NSA,
            "columns": {"type": ["array", "null"], "items": _VALUE},
            "reason": _S,
        }
    )
)

STEPS_SCHEMA = _body(
    _object(
        {
            "op": _ops("putStep", "removeStep", "setPreamble"),
            "id": _S,
            "type": {"type": ["string", "null"], "enum": ["extract", "check", None]},
            "fields": _NSA,
            "table": _NS,
            "sections": _NSA,
            "instructions": _NS,
            "pageImages": {"type": ["array", "null"], "items": {"type": "integer"}},
            "chunkPages": {"type": ["integer", "null"]},
            "context": {"type": ["array", "null"], "items": _object({"name": _S, "path": _S})},
            "description": _NS,
            "values": _NS,
            "reference": _NS,
            "aliases": _NS,
            "preamble": _NS,
            "reason": _S,
        }
    )
)


def _clean(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _dump(model: BaseModel) -> dict[str, Any]:
    """Typed change payload (camelCase, defaults omitted: the TS schema fills them back)."""
    return model.model_dump(by_alias=True, exclude_none=True, exclude_defaults=True)


def _errors(i: int, exc: ValidationError) -> list[str]:
    return [
        f"changes[{i}]: {'.'.join(str(p) for p in e['loc']) or 'item'}: {e['msg']}"
        for e in exc.errors()
    ]


def _value(c: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "name", "type", "description", "enum")
    return _clean({k: c.get(k) for k in keys})


def convert_outputs(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    changes: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, c in enumerate(data["changes"]):
        try:
            if c["op"] == "putField":
                field = ValueDef.model_validate(_value(c))
                changes.append({"op": "putField", "field": _dump(field), "reason": c["reason"]})
            elif c["op"] == "putTable":
                table = TableDef.model_validate(
                    _clean(
                        {
                            "id": c["id"],
                            "name": c.get("name"),
                            "description": c.get("description"),
                            "columns": [_value(col) for col in c.get("columns") or []],
                        }
                    )
                )
                changes.append({"op": "putTable", "table": _dump(table), "reason": c["reason"]})
            else:
                changes.append({"op": "removeOutput", "id": c["id"], "reason": c["reason"]})
        except ValidationError as exc:
            errors += _errors(i, exc)
    return {"notes": data["notes"], "changes": changes}, errors


def _output_ids(definition: dict[str, Any]) -> set[str]:
    outputs = definition.get("outputs") or {}
    return {str(o.get("id")) for o in [*(outputs.get("fields") or []), *(outputs.get("tables") or [])]}


def check_outputs(body: dict[str, Any], draft: dict[str, Any]) -> list[str]:
    errors = [
        f"changes[{i}]: removeOutput {c['id']!r}: no such output in the current draft"
        for i, c in enumerate(body["changes"])
        if c["op"] == "removeOutput" and c["id"] not in _output_ids(draft)
    ]
    applied = apply_changes(draft, body["changes"])
    errors += [
        f"output id {t['id']!r} is reserved"
        for t in applied["outputs"]["tables"]
        if t["id"] in RESERVED_OUTPUT_IDS
    ]
    if not _output_ids(applied):
        errors.append("propose at least one field or table")
    return errors


def convert_steps(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    changes: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, c in enumerate(data["changes"]):
        try:
            if c["op"] == "putStep":
                step: BaseModel
                if c.get("type") == "check":
                    keys = ("id", "description", "values", "reference", "aliases")
                    step = CheckStep.model_validate(
                        _clean({"type": "check", **{k: c.get(k) for k in keys}})
                    )
                else:
                    context = {x["name"]: x["path"] for x in c.get("context") or []}
                    step = ExtractStep.model_validate(
                        _clean(
                            {
                                "type": "extract",
                                "id": c["id"],
                                "fields": c.get("fields"),
                                "table": c.get("table"),
                                "sections": c.get("sections"),
                                "instructions": c.get("instructions"),
                                "pageImages": c.get("pageImages"),
                                "chunkPages": c.get("chunkPages"),
                                "context": context or None,
                            }
                        )
                    )
                changes.append({"op": "putStep", "step": _dump(step), "reason": c["reason"]})
            elif c["op"] == "removeStep":
                changes.append({"op": "removeStep", "id": c["id"], "reason": c["reason"]})
            else:
                changes.append(
                    {"op": "setPreamble", "preamble": c.get("preamble") or "", "reason": c["reason"]}
                )
        except ValidationError as exc:
            errors += _errors(i, exc)
    return {"notes": data["notes"], "changes": changes}, errors


def check_steps(body: dict[str, Any], draft: dict[str, Any]) -> list[str]:
    step_ids = {s.get("id") for s in draft.get("pipeline") or []}
    errors = [
        f"changes[{i}]: removeStep {c['id']!r}: no such step in the current draft"
        for i, c in enumerate(body["changes"])
        if c["op"] == "removeStep" and c["id"] not in step_ids
    ]
    try:
        Template.model_validate(apply_changes(draft, body["changes"]))
    except ValidationError as exc:
        for e in exc.errors():
            errors += [part.strip() for part in str(e["msg"]).removeprefix("Value error, ").split(";")]
    return errors


OUTPUTS = Stage(
    "outputs",
    """\
Task: propose the template's outputs from the survey, the brief and the samples.
- changes: one per output.
  - putField: one value per document. id is lowercase_snake_case; type is one of text,
    integer, decimal, date, boolean, enum, list; enum lists the allowed values for type enum;
    description tells an extractor exactly what to copy.
  - putTable: repeating rows. columns use the same keys as a field; columns is null for fields.
  - removeOutput: drop an output the current draft has that the brief does not want.
- Keep outputs the current draft already has unless the brief or survey says otherwise;
  proposing an existing id replaces it.
- Use null for keys that do not apply. reason: one sentence citing the brief or a sample.
- notes: anything the user should know (ambiguities, outputs you left out).
Return JSON only.""",
    OUTPUTS_SCHEMA,
    convert_outputs,
    check_outputs,
)

STEPS = Stage(
    "steps",
    """\
Task: propose the extraction pipeline that fills every output in the current draft.
- putStep with type extract:
  - id, and sections (ids from the current draft's sections).
  - Either fields (field ids) or table (one table id). Every field and table must be filled
    by exactly one step.
  - instructions: concrete guidance (where the value is, formats, what to ignore).
  - pageImages: page numbers to show as images when the text loses information, else null.
  - chunkPages: only for a long table in one section.
  - context: values from earlier steps the prompt should see, as {name, path}, where path is
    a field id or table.column.
- putStep with type check: values and reference are paths (field or table.column) whose values
  must match; aliases optional.
- removeStep: drop a step from the current draft.
- setPreamble: domain guidance placed at the top of every extraction prompt (from the brief).
- Steps run in the order given; context may only use outputs filled by earlier steps.
- Use null for keys that do not apply. reason: one sentence.
Return JSON only.""",
    STEPS_SCHEMA,
    convert_steps,
    check_steps,
)
```

(`ValueType` is the `Literal` in `normalize.py`. If it is not a plain `Literal`, import the value list the way `template.py` does. mypy may need `cast` around `get_args`.)

- [ ] **Step 4: Wire the stages into `drafting.py`**

- Remove the `Stage` dataclass and `from dataclasses import dataclass` if it's no longer used. Import `Stage, OUTPUTS, STEPS` from `.draft_stages`. Keep `SURVEY` and `SURVEY_SCHEMA` here.
- `STAGES: dict[str, Stage] = {s.id: s for s in (SURVEY, OUTPUTS, STEPS)}` (Task 4 adds `SECTIONS`).
- `CHANGE_STAGE_IDS = {"outputs", "sections", "steps"}`.
- `DraftParams`: add `survey: dict[str, Any] | None = None` (the accepted survey body, if any).
- `build_context`: add a keyword `survey: dict[str, Any] | None = None`. After the brief block, when present, add `f"<survey>\n{json.dumps(survey, indent=1, ensure_ascii=False)}\n</survey>"`.
- In `run_draft`:
  - Right after the stage lookup, add `if stage.id in CHANGE_STAGE_IDS and params.draft is None: raise DocumentError(f"drafting stage {stage.id} needs the current draft")`.
  - Pass `survey=params.survey` to `build_context`.
  - Replace the single `run_extraction` call and the output building with:

```python
    draft = params.draft or {}

    def check(data: dict[str, Any]) -> list[str]:
        body, errors = stage.convert(data) if stage.convert else (data, [])
        if not errors and stage.check is not None:
            errors = stage.check(body, draft)
        return errors

    def propose(prompt: str, label: str) -> tuple[ExtractionResult, dict[str, Any]]:
        try:
            result = run_extraction(
                extraction_id=label,
                provider=provider,
                model_id=model_id,
                prompt=prompt,
                schema=stage.schema,
                max_attempts=2,
                max_tokens=DRAFT_MAX_TOKENS,
                system=DRAFT_SYSTEM,
                check=check if (stage.convert or stage.check) else None,
            )
        except ExtractionFailedError as exc:
            _audit(deps, job, label, exc.attempts)
            raise DocumentError(str(exc)) from exc
        except RefusalError as exc:
            raise DocumentError(f"drafting model refused: {exc}") from exc
        _audit(deps, job, label, result.attempts)
        body = stage.convert(result.data)[0] if stage.convert else result.data
        return result, body

    prompt = f"{context}\n\n{stage.instructions}"
    result, body = propose(prompt, f"draft-{stage.id}")
```

  - Then build `output` with `"body": body` instead of `result.data`, keeping the rest unchanged.
  - Change `_audit` to take the `label: str` and use `run_key(job.id, label, a.n)`. The survey label stays `draft-survey`, so the 3a audit-key test still holds.
  - Import `ExtractionResult` from `.extract`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run mypy`
Expected: PASS. All the 3a drafting tests still pass.

- [ ] **Step 6: Commit**

```bash
git add worker
git commit -m "Worker: outputs and steps drafting stages (typed changes validated against the draft)"
```

---

### Task 4: Worker: the sections stage and its anchor round

**Files:**
- Modify: `worker/src/ingest_worker/draft_stages.py`, `worker/src/ingest_worker/drafting.py`
- Test: `worker/tests/test_draft_stages.py`, `worker/tests/test_drafting.py`

**Interfaces:**
- Consumes: `segment_with_timeout` and `SegmentDocument` (`workbench.py`); `DraftSample` (`drafting.py`).
- Produces:
  - `draft_stages.SECTIONS`, with ops `putSection`, `removeSection` and `setCopies`.
  - `drafting.anchor_check(samples: list[DraftSample], draft: dict[str, Any], body: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]`, which returns the grid (TS `SegmentationResult`) and the misses.
  - In `run_draft`, when the sections stage has misses, one more `propose` round runs with label `draft-sections-anchors`. The final body gets `anchorCheck` = the grid, or None if segmentation timed out on the last round.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_draft_stages.py`:

```python
from ingest_worker.draft_stages import SECTIONS


def section_item(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "op": "putSection", "id": "approval", "anchor": "^PROTOCOL APPROVAL", "required": None,
        "description": "Signatures", "copiesSelect": None, "reason": "r",
    }
    return {**base, **kw}


def test_sections_convert_sections_and_copies() -> None:
    body, errors = run(
        SECTIONS,
        {
            "notes": "",
            "changes": [
                section_item(),
                section_item(op="setCopies", id="copies", anchor="^PROTOCOL$", copiesSelect="first", description=None),
            ],
        },
    )
    assert errors == []
    assert body["changes"] == [
        {"op": "putSection", "section": {"id": "approval", "anchor": "^PROTOCOL APPROVAL", "description": "Signatures"}, "reason": "r"},
        {"op": "setCopies", "copies": {"anchor": "^PROTOCOL$", "select": "first"}, "reason": "r"},
    ]


def test_sections_report_bad_regexes_and_keep_one_section() -> None:
    _, errors = run(SECTIONS, {"notes": "", "changes": [section_item(anchor="(unclosed")]})
    assert any("approval" in e and "regular expression" in e for e in errors)
    _, errors = run(SECTIONS, {"notes": "", "changes": [section_item(op="removeSection", id="all")]})
    assert any("at least one section" in e for e in errors)
```

Append to `worker/tests/test_drafting.py`:

```python
def sections_body(anchor: str) -> dict[str, Any]:
    return {
        "notes": "",
        "changes": [
            {
                "op": "putSection", "id": "approval", "anchor": anchor, "required": None,
                "description": None, "copiesSelect": None, "reason": "r",
            }
        ],
    }


def test_sections_anchor_misses_are_fed_back_once_and_the_grid_is_kept(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [sections_body("^SIGNATURES"), sections_body("^PROTOCOL APPROVAL")]
    queue = FakeQueue(jobs=[draft_job(stage="sections")])
    run_once(queue, deps, "w1")
    assert len(provider.calls) == 2
    assert "matched none of the dev samples" in provider.calls[1][1].prompt
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    [row] = body["anchorCheck"]["samples"]
    assert {c["id"]: c["found"] for c in row["sections"]}["approval"] is True
    assert store.get_optional("runs", "job-d/draft-sections-anchors/attempt-1.json") is not None


def test_sections_keep_the_last_misses_visible(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [sections_body("^SIGNATURES"), sections_body("^STILL WRONG")]
    queue = FakeQueue(jobs=[draft_job(stage="sections")])
    run_once(queue, deps, "w1")
    assert queue.completed and len(provider.calls) == 2
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    [row] = body["anchorCheck"]["samples"]
    assert {c["id"]: c["found"] for c in row["sections"]}["approval"] is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_draft_stages.py tests/test_drafting.py -q`
Expected: FAIL. `SECTIONS` cannot be imported.

- [ ] **Step 3: Implement**

Append to `draft_stages.py`:

```python
SECTIONS_SCHEMA = _body(
    _object(
        {
            "op": _ops("putSection", "removeSection", "setCopies"),
            "id": _S,
            "anchor": _NS,
            "required": {"type": ["boolean", "null"]},
            "description": _NS,
            "copiesSelect": {"type": ["string", "null"], "enum": ["first", "last", None]},
            "reason": _S,
        }
    )
)


def _regex_error(pattern: str) -> str | None:
    try:
        re.compile(pattern, re.MULTILINE)
    except re.error as exc:
        return str(exc)
    return None


def convert_sections(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    changes: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, c in enumerate(data["changes"]):
        try:
            if c["op"] == "putSection":
                keys = ("id", "anchor", "required", "description")
                section = Section.model_validate(_clean({k: c.get(k) for k in keys}))
                changes.append({"op": "putSection", "section": _dump(section), "reason": c["reason"]})
            elif c["op"] == "removeSection":
                changes.append({"op": "removeSection", "id": c["id"], "reason": c["reason"]})
            else:
                copies = (
                    CopySelection.model_validate(
                        _clean({"anchor": c["anchor"], "select": c.get("copiesSelect")})
                    ).model_dump(by_alias=True)
                    if c.get("anchor")
                    else None
                )
                changes.append({"op": "setCopies", "copies": copies, "reason": c["reason"]})
        except ValidationError as exc:
            errors += _errors(i, exc)
    return {"notes": data["notes"], "changes": changes}, errors


def check_sections(body: dict[str, Any], draft: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    existing = {s.get("id") for s in (draft.get("document") or {}).get("sections") or []}
    for i, c in enumerate(body["changes"]):
        if c["op"] == "putSection" and (error := _regex_error(c["section"]["anchor"])):
            errors.append(f"section {c['section']['id']!r}: invalid regular expression: {error}")
        elif c["op"] == "setCopies" and c["copies"] and (error := _regex_error(c["copies"]["anchor"])):
            errors.append(f"copies: invalid regular expression: {error}")
        elif c["op"] == "removeSection" and c["id"] not in existing:
            errors.append(f"changes[{i}]: removeSection {c['id']!r}: no such section in the current draft")
    if not apply_changes(draft, body["changes"])["document"]["sections"]:
        errors.append("keep at least one section")
    return errors


SECTIONS = Stage(
    "sections",
    """\
Task: propose section anchors that split every sample the same way.
- putSection:
  - id: lowercase.
  - anchor: a Python regular expression (multiline mode) matching the first line of the
    section in every sample. Prefer headings and wording over page numbers or layout.
  - required: false when some documents legitimately lack the section.
  - description: what the section contains.
- removeSection: drop a section from the current draft.
- setCopies: when a PDF holds several copies (for example blank, then executed), anchor is the
  regex that starts each copy and copiesSelect is first or last; anchor null removes copy
  selection.
- Every anchor is tested on every dev sample before the user sees it; misses are reported back.
- Use null for keys that do not apply. reason: one sentence.
Return JSON only.""",
    SECTIONS_SCHEMA,
    convert_sections,
    check_sections,
)
```

In `drafting.py`:
- Register `SECTIONS` in `STAGES`.
- Import `SegmentDocument` and `segment_with_timeout` from `.workbench`, and `apply_changes` from `.draft_changes`.
- Add:

```python
def anchor_check(
    samples: list[DraftSample], draft: dict[str, Any], body: dict[str, Any]
) -> tuple[dict[str, Any] | None, list[str]]:
    """Apply a sections proposal to the draft and segment every dev sample with it (the same
    code as the anchor preview, capped by SEGMENT_TIMEOUT_S). Returns the grid and the misses
    worth feeding back: an anchor that matches no sample, or a required one that misses any."""
    block = apply_changes(draft, body["changes"])["document"]
    document = SegmentDocument.model_validate(
        {k: block[k] for k in ("sections", "copies", "pageMarkers") if k in block}
    )
    try:
        grid = segment_with_timeout([(s.sample_id, s.pages) for s in samples], document)
    except DocumentError as exc:
        return None, [str(exc)]
    names = {s.sample_id: s.filename for s in samples}
    rows = [row for row in grid["samples"] if not row.get("error")]
    misses: list[str] = []
    for change in body["changes"]:
        if change["op"] != "putSection":
            continue
        section = change["section"]
        sid = section["id"]
        if sid in grid["anchorErrors"]:
            misses.append(f'section "{sid}": {grid["anchorErrors"][sid]}')
            continue
        missed = [
            names.get(row["sampleId"], row["sampleId"])
            for row in rows
            if not any(c["id"] == sid and c["found"] for c in row["sections"])
        ]
        if rows and len(missed) == len(rows):
            misses.append(f'section "{sid}": anchor {section["anchor"]!r} matched none of the dev samples')
        elif missed and section.get("required", True):
            misses.append(
                f'section "{sid}" is required but anchor {section["anchor"]!r} missed: {", ".join(missed)}'
            )
    return grid, misses
```

In `run_draft`, after `result, body = propose(prompt, f"draft-{stage.id}")`:

```python
    if stage.id == "sections":
        grid, misses = anchor_check(samples, draft, body)
        if misses:
            check_cancelled(job, queue)
            feedback = "\n".join(misses)
            result, body = propose(
                f"{prompt}\n\nYour proposal was tested on the dev samples and these anchors "
                f"need work:\n<anchor_misses>\n{feedback}\n</anchor_misses>\n"
                "Propose the full set of changes again.",
                "draft-sections-anchors",
            )
            grid, _ = anchor_check(samples, draft, body)
        body = {**body, "anchorCheck": grid}
```

(`samples` is the `DraftSample` list `run_draft` already built for the context. When the external-call event is logged, it must still list only those samples.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run mypy`
Expected: PASS. The anchor tests start a child process (spawn on Windows), so allow a few seconds.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "Worker: sections drafting stage, anchors checked on every dev sample with one feedback round"
```

---

### Task 5: API repos: proposal base and decision fields, stage skips

**Files:**
- Modify: `apps/api/src/workbench/repo.ts`, `apps/api/test/integration/workbench-pg.test.ts`
- Test: `apps/api/test/workbench-stages-repo.test.ts` (new)

**Interfaces:**
- Consumes: migration 0012; `ProposalDecision` and `StageSkip` (Task 1).
- Produces (`apps/api/src/workbench/repo.ts`):
  - `ProposalRecord` gains these fields:
    - `decision: ProposalDecision | null`
    - `acceptedChanges: number[] | null`
    - `baseVersion: number | null`
    - `baseDefinition: Record<string, unknown> | null`
  - `createProposal(p: { id; projectId; stage; briefVersion; baseVersion?: number | null; baseDefinition?: Record<string, unknown> | null })`. Both new inputs default to null.
  - `decideProposal(projectId, id, decision: ProposalDecision, acceptedChanges?: number[] | null)`, which returns null when the proposal is unknown, belongs to another project, or has already been decided.
  - `addSkip(projectId: string, stage: DraftStage): Promise<StageSkip & { projectId: string }>`
  - `listSkips(projectId: string): Promise<(StageSkip & { projectId: string })[]>`, newest first
  - Memory timestamps (`createdAt`, `decidedAt`, `skippedAt`) are **strictly increasing**, so stage states never tie within a millisecond.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-stages-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

async function setup() {
  const ctx = await testApp();
  await ctx.workbench.createProject('letter', 'Letter');
  return ctx;
}

describe('stage persistence', () => {
  it('stores the draft a proposal was made against and the changes accepted', async () => {
    const { repo, workbench } = await setup();
    const job = await repo.createDraftJob('letter', {});
    const base = { id: 'letter', version: 1, outputs: { fields: [] } };
    await workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'outputs',
      briefVersion: null,
      baseVersion: 1,
      baseDefinition: base,
    });
    const decided = await workbench.decideProposal('letter', job.id, 'partially_accepted', [0, 2]);
    expect(decided).toMatchObject({
      decision: 'partially_accepted',
      acceptedChanges: [0, 2],
      baseVersion: 1,
      baseDefinition: base,
    });
    expect(await workbench.decideProposal('letter', job.id, 'rejected')).toBeNull();
  });

  it('defaults the new fields for survey proposals', async () => {
    const { repo, workbench } = await setup();
    const job = await repo.createDraftJob('letter', {});
    const p = await workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'survey',
      briefVersion: 1,
    });
    expect(p).toMatchObject({ acceptedChanges: null, baseVersion: null, baseDefinition: null });
    expect(await workbench.decideProposal('letter', job.id, 'accepted')).toMatchObject({
      acceptedChanges: null,
    });
  });

  it('records skips newest first with strictly increasing times', async () => {
    const { workbench } = await setup();
    const a = await workbench.addSkip('letter', 'survey');
    const b = await workbench.addSkip('letter', 'outputs');
    expect(b.skippedAt > a.skippedAt).toBe(true);
    expect((await workbench.listSkips('letter')).map((s) => s.stage)).toEqual(['outputs', 'survey']);
    expect(await workbench.listSkips('other')).toEqual([]);
  });
});
```

Extend the opt-in `apps/api/test/integration/workbench-pg.test.ts` with the same three behaviours against Postgres:
- a `partially_accepted` decision with `acceptedChanges` round-trips as `number[]`, and `baseDefinition` comes back as an object;
- `addSkip` and `listSkips` work.

Follow that file's existing setup: random project ids and its own pool.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-stages-repo.test.ts`
Expected: FAIL. `workbench.addSkip` is not a function, and the base fields are undefined.

- [ ] **Step 3: Implement**

In `repo.ts`:
- Extend `ProposalRecord` and the port as in Interfaces.
- `MemoryWorkbenchRepo`:
  - Add a monotonic clock and use it for every timestamp the class writes:

```ts
  private lastTime = 0;
  /** Strictly increasing ISO times: stage states compare them, so ties would hide staleness. */
  private now(): string {
    this.lastTime = Math.max(Date.now(), this.lastTime + 1);
    return new Date(this.lastTime).toISOString();
  }
```

  - `createProposal` sets `acceptedChanges: null`, `baseVersion: p.baseVersion ?? null` and `baseDefinition: p.baseDefinition ?? null`.
  - `decideProposal` also stores `acceptedChanges: acceptedChanges ?? null`.
  - `readonly skips: (StageSkip & { projectId: string })[] = []`.
  - `addSkip` pushes `{ projectId, stage, skippedAt: this.now() }` and returns it.
  - `listSkips` filters by project and reverses (newest first).
- `PgWorkbenchRepo`:
  - `ProposalRow` gains `accepted_changes: number[] | null`, `base_version: number | null` and `base_definition: Record<string, unknown> | null`, and `toProposal` maps them.
  - `createProposal`: `INSERT INTO workbench_proposals (id, project_id, stage, brief_version, base_version, base_definition) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, with `p.baseVersion ?? null` and `p.baseDefinition ? JSON.stringify(p.baseDefinition) : null`.
  - `decideProposal`: `UPDATE workbench_proposals SET decision = $3, accepted_changes = $4, decided_at = now() WHERE project_id = $1 AND id = $2 AND decision IS NULL RETURNING *`, with `acceptedChanges ?? null`.
  - Skips:

```ts
  async addSkip(projectId: string, stage: DraftStage) {
    const { rows } = await this.pool.query<{ project_id: string; stage: DraftStage; skipped_at: Date }>(
      `INSERT INTO workbench_stage_skips (project_id, stage) VALUES ($1, $2)
       RETURNING project_id, stage, skipped_at`,
      [projectId, stage],
    );
    const row = rows[0]!;
    return { projectId: row.project_id, stage: row.stage, skippedAt: row.skipped_at.toISOString() };
  }

  async listSkips(projectId: string) {
    const { rows } = await this.pool.query<{ project_id: string; stage: DraftStage; skipped_at: Date }>(
      `SELECT project_id, stage, skipped_at FROM workbench_stage_skips
        WHERE project_id = $1 ORDER BY skipped_at DESC, id DESC`,
      [projectId],
    );
    return rows.map((r) => ({ projectId: r.project_id, stage: r.stage, skippedAt: r.skipped_at.toISOString() }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`
Expected: PASS. If Docker is available, also run the opt-in Pg test against a **throwaway** container, as `CLAUDE.md` describes (`IH_TEST_DATABASE_URL=… npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg`), then remove the container. Record the result.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: proposal base draft, per-change decisions and stage skips persistence"
```

---

### Task 6: API routes: stage order, change stages, per-change decisions, skip, stage states

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`
- Test: `apps/api/test/workbench-stages.test.ts` (new); `apps/api/test/workbench-drafting.test.ts` (3a). Its "outputs is unavailable" assertion must become "references is unavailable".

**Interfaces:**
- Consumes: Task 1 (`applyChanges`, `conflictingChanges`, `parseChangeBody`, `isChangeStage`, `stageStates`, `blockingStage`, `AVAILABLE_STAGES`), Task 5 (repo), `pinned` (`templates/drafts.ts`).
- Produces:
  - `POST /api/workbench/projects/:id/stages/:stage`:
    - Returns 400 for `references` or an unknown stage.
    - Returns 409 when an earlier stage is incomplete (`finish the <stage> stage first (accept or skip it)`).
    - Change stages need an open draft; otherwise 409 `no open draft; start the next version on the Template tab`.
    - For change stages, the job params also include `survey` (the latest accepted survey body, or null). The proposal stores `baseVersion` and `baseDefinition` from the open draft.
  - `POST /api/workbench/projects/:id/stages/:stage/skip` returns `StageView[]` (201). It has the same 400 and 404 responses and the same 409 order rule.
  - `GET /api/workbench/projects/:id/stages` returns `StageView[]`.
  - `ProposalView.body` is parsed per stage; `acceptedChanges` is filled in.
  - `POST .../proposals/:pid/decision` with `{ decision, changes? }` follows the Global Constraints. Accepting a change stage applies the chosen changes to the open draft through `templates.updateDraft`, with the id and version pinned.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-stages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { draftingKey, preparedTriageKey, type ProposalView, type SampleView, type StageView } from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';

const pdf = Buffer.from('%PDF-1.7\n% sample\n%%EOF\n');
const survey = { summary: 'Letters.', structure: [], variants: [], candidates: [], questions: [] };
const putField = (id: string, description = 'd') => ({
  op: 'putField',
  field: { id, type: 'text', description },
  reason: 'r',
});

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({ method: 'POST', url: '/api/workbench/projects', payload: { id: 'letter', name: 'Letter' } });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const s = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/samples',
      ...multipart({ role: 'dev' }, { filename: 's1.pdf', content: pdf }),
    })
  ).json() as SampleView;
  const prep = ctx.repo.jobs.get(s.prepareJobId!)!;
  ctx.repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
  const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
  await ctx.store.put('runs', preparedTriageKey(s.sha256), Buffer.from(JSON.stringify(triage)), 'application/json');

  const start = (stage: string) =>
    ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/stages/${stage}` });
  const skip = (stage: string) =>
    ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/stages/${stage}/skip` });
  const finish = async (id: string, stage: string, body: unknown) => {
    ctx.repo.draftJobs.set(id, { ...ctx.repo.draftJobs.get(id)!, status: 'succeeded' });
    const result = { stage, model: 'local/big', body, usage: { inputTokens: 1, outputTokens: 1 } };
    await ctx.store.put('runs', draftingKey('letter', id), Buffer.from(JSON.stringify(result)), 'application/json');
  };
  const decide = (id: string, payload: unknown) =>
    ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/proposals/${id}/decision`, payload });
  const stages = async () =>
    ((await ctx.app.inject('/api/workbench/projects/letter/stages')).json() as StageView[]).map(
      (s) => `${s.stage}:${s.state}`,
    );
  const draft = async () => (await ctx.templates.get('letter', 1))!.definition as ReturnType<typeof letter>;
  return { ...ctx, start, skip, finish, decide, stages, draft };
}

describe('stage order', () => {
  it('blocks a stage until earlier ones are accepted or skipped', async () => {
    const { start, skip, stages } = await project();
    const blocked = await start('outputs');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('finish the survey stage first (accept or skip it)');
    expect((await skip('survey')).statusCode).toBe(201);
    expect((await start('outputs')).statusCode).toBe(202);
    expect(await stages()).toEqual(['survey:skipped', 'outputs:running', 'sections:pending', 'steps:pending']);
    expect((await start('references')).statusCode).toBe(400);
  });

  it('marks later stages stale when an earlier stage is accepted again', async () => {
    const { start, skip, finish, decide, stages } = await project();
    await skip('survey');
    const outputs = (await start('outputs')).json() as ProposalView;
    await finish(outputs.id, 'outputs', { notes: '', changes: [putField('date')] });
    await decide(outputs.id, { decision: 'accepted', changes: [0] });
    const again = (await start('survey')).json() as ProposalView;
    await finish(again.id, 'survey', survey);
    await decide(again.id, { decision: 'accepted' });
    expect(await stages()).toEqual(['survey:accepted', 'outputs:stale', 'sections:pending', 'steps:pending']);
  });
});

describe('change stages', () => {
  it('passes the accepted survey and records the draft the proposal is based on', async () => {
    const { start, finish, decide, repo, workbench } = await project();
    const s = (await start('survey')).json() as ProposalView;
    await finish(s.id, 'survey', survey);
    await decide(s.id, { decision: 'accepted' });
    const p = (await start('outputs')).json() as ProposalView;
    expect(repo.draftJobs.get(p.id)!.params).toMatchObject({ stage: 'outputs', survey, draft: letter(1) });
    const [record] = await workbench.listProposals('letter');
    expect(record).toMatchObject({ baseVersion: 1, baseDefinition: letter(1) });
  });

  it('applies only the accepted changes to the draft', async () => {
    const { start, skip, finish, decide, draft } = await project();
    await skip('survey');
    const p = (await start('outputs')).json() as ProposalView;
    await finish(p.id, 'outputs', { notes: 'n', changes: [putField('date'), putField('sender', 'Who')] });
    const res = await decide(p.id, { decision: 'accepted', changes: [0] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'partially_accepted', acceptedChanges: [0] });
    const fields = (await draft()).outputs.fields;
    expect(fields).toEqual([
      { id: 'sender', type: 'text' },
      { id: 'date', type: 'text', description: 'd' },
    ]);
  });

  it('refuses changes whose target was edited since the proposal, but applies the others', async () => {
    const { start, skip, finish, decide, draft, templates } = await project();
    await skip('survey');
    const p = (await start('outputs')).json() as ProposalView;
    await finish(p.id, 'outputs', { notes: '', changes: [putField('date'), putField('sender', 'Who')] });
    const edited = letter(1);
    edited.outputs.fields[0] = { id: 'sender', type: 'text', description: 'hand-written' } as never;
    await templates.updateDraft('letter', 1, edited);
    const clash = await decide(p.id, { decision: 'accepted', changes: [0, 1] });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toContain('where these changes apply: 2');
    const ok = await decide(p.id, { decision: 'accepted', changes: [0] });
    expect(ok.statusCode).toBe(200);
    expect((await draft()).outputs.fields.map((f) => f.id)).toEqual(['sender', 'date']);
  });

  it('validates decisions', async () => {
    const { start, skip, finish, decide } = await project();
    const s = (await start('survey')).json() as ProposalView;
    await finish(s.id, 'survey', survey);
    expect((await decide(s.id, { decision: 'accepted', changes: [0] })).statusCode).toBe(400);
    await decide(s.id, { decision: 'rejected' });
    await skip('survey');
    const p = (await start('outputs')).json() as ProposalView;
    await finish(p.id, 'outputs', { notes: '', changes: [putField('date')] });
    expect((await decide(p.id, { decision: 'accepted' })).statusCode).toBe(400);
    expect((await decide(p.id, { decision: 'accepted', changes: [3] })).statusCode).toBe(400);
    expect((await decide(p.id, { decision: 'rejected', changes: [0] })).statusCode).toBe(400);
    expect((await decide(p.id, { decision: 'rejected' })).json()).toMatchObject({ status: 'rejected' });
  });

  it('reports a body with a foreign op as unreadable', async () => {
    const { app, start, skip, finish } = await project();
    await skip('survey');
    const p = (await start('outputs')).json() as ProposalView;
    await finish(p.id, 'outputs', {
      notes: '',
      changes: [{ op: 'removeStep', id: 'head', reason: 'r' }],
    });
    const [view] = (await app.inject('/api/workbench/projects/letter/proposals')).json() as ProposalView[];
    expect(view).toMatchObject({ status: 'failed', error: 'result unreadable' });
  });
});
```

(`letter()` returns a literal type. Cast where the test mutates it, as above, or widen with `as Record<string, any>` and an eslint comment if lint complains. Keep the assertions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-stages.test.ts`
Expected: FAIL. `GET /stages` returns 404, and outputs returns 400.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/workbench.ts`:

Imports:
- From `@ih/shared`: `applyChanges`, `blockingStage`, `conflictingChanges`, `isChangeStage`, `parseChangeBody`, `stageStates`, and the types `ChangeBody`, `DraftStage`, `ProposalStatus`, `StageView`, `SurveyBody`.
- `pinned` from `../templates/drafts.js`.

Schemas:

```ts
const DecisionBody = z
  .object({
    decision: z.enum(['accepted', 'rejected']),
    changes: z.array(z.number().int().min(0)).min(1).optional(),
  })
  .strict();
const SkipParams = StageParams;
```

Module helpers:

```ts
function parseBody(stage: DraftStage, body: unknown): SurveyBody | ChangeBody | null {
  if (stage === 'survey') {
    const survey = SurveyBodySchema.safeParse(body);
    return survey.success ? survey.data : null;
  }
  return isChangeStage(stage) ? parseChangeBody(stage, body) : null;
}

/** Proposal status without reading its body (stage rail; order checks). */
function statusOf(p: ProposalRecord, job: ProjectJob | null): ProposalStatus {
  if (p.decision) return p.decision;
  if (!job || job.status === 'queued' || job.status === 'running') return 'running';
  return job.status === 'succeeded' ? 'ready' : 'failed';
}

async function stagesOf(app: FastifyInstance, projectId: string): Promise<StageView[]> {
  const jobs = new Map((await app.deps.repo.listDraftJobs(projectId)).map((j) => [j.id, j]));
  const proposals = (await app.deps.workbench.listProposals(projectId)).map((p) => ({
    stage: p.stage,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
    status: statusOf(p, jobs.get(p.id) ?? null),
  }));
  return stageStates(proposals, await app.deps.workbench.listSkips(projectId));
}

async function acceptedSurvey(app: FastifyInstance, projectId: string): Promise<SurveyBody | null> {
  const p = (await app.deps.workbench.listProposals(projectId)).find(
    (x) => x.stage === 'survey' && x.decision === 'accepted',
  );
  if (!p) return null;
  const raw = await readJsonSafe(app, draftingKey(projectId, p.id));
  const parsed = raw == null ? null : DraftResultSchema.safeParse(raw);
  const body = parsed?.success ? SurveyBodySchema.safeParse(parsed.data.body) : null;
  return body?.success ? body.data : null;
}
```

In `proposalView`:
- Add `acceptedChanges: p.acceptedChanges` to `base`.
- Replace the survey-only body parse with `const body = parsed?.success ? parseBody(p.stage, parsed.data.body) : null;`.
- The failure branch becomes `if (!parsed?.success || !body)`, keeping `'result missing'` / `'result unreadable'`.
- Return `body` (not `body.data`).

Stage start route (replace the body after the stage params check):

```ts
      const { id: projectId, stage } = params.data;
      const project = await workbench.getProject(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const blocking = blockingStage(await stagesOf(app, projectId), stage);
      if (blocking) {
        return reply.code(409).send({ error: `finish the ${blocking} stage first (accept or skip it)` });
      }
      const { draft, latest } = await versionsOf(templates, projectId);
      const changeStage = isChangeStage(stage);
      if (changeStage && draft === null) {
        return reply.code(409).send({ error: 'no open draft; start the next version on the Template tab' });
      }
      const record = draft !== null ? await templates.get(projectId, draft) : latest;
      if (!record) return reply.code(409).send({ error: 'the project has no template version' });
      // Keep the existing 3a lines here unchanged: `const samples = …` (ready dev samples
      // only), the 409 'no prepared dev samples', and `const brief = await workbench.latestBrief(projectId);`.
      const job = await app.deps.repo.createDraftJob(projectId, {
        stage,
        dataPolicy: project.dataPolicy,
        briefVersion: brief?.version ?? null,
        brief: brief?.body ?? EMPTY_BRIEF,
        draft: record.definition,
        samples,
        ...(changeStage ? { survey: await acceptedSurvey(app, projectId) } : {}),
      });
      const proposal = await workbench.createProposal({
        id: job.id,
        projectId,
        stage,
        briefVersion: brief?.version ?? null,
        baseVersion: changeStage ? record.version : null,
        baseDefinition: changeStage ? record.definition : null,
      });
      return reply.code(202).send(await proposalView(app, proposal, job));
```

New routes:

```ts
  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/stages', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    return stagesOf(app, req.params.id);
  });

  app.post<{ Params: { id: string; stage: string } }>(
    '/workbench/projects/:id/stages/:stage/skip',
    async (req, reply) => {
      const params = SkipParams.safeParse(req.params);
      if (!params.success || !AVAILABLE_STAGES.includes(params.data.stage)) {
        return reply.code(400).send({ error: `stage ${req.params.stage} is not available yet` });
      }
      const { id: projectId, stage } = params.data;
      if (!(await workbench.getProject(projectId))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const blocking = blockingStage(await stagesOf(app, projectId), stage);
      if (blocking) {
        return reply.code(409).send({ error: `finish the ${blocking} stage first (accept or skip it)` });
      }
      await workbench.addSkip(projectId, stage);
      return reply.code(201).send(await stagesOf(app, projectId));
    },
  );
```

Decision route: after the `current.status !== 'ready'` check, replace the decide-and-return with:

```ts
      const { decision, changes } = body.data;
      if (!isChangeStage(record.stage) || decision === 'rejected') {
        if (changes) {
          return reply
            .code(400)
            .send({ error: 'changes can only be chosen when accepting a drafting change proposal' });
        }
        const decided = await workbench.decideProposal(projectId, pid, decision);
        if (!decided) return reply.code(409).send({ error: 'proposal was already decided' });
        return proposalView(app, decided, job);
      }
      const proposed = (current.body as ChangeBody).changes;
      if (!changes) return reply.code(400).send({ error: 'choose the changes to accept' });
      const chosen = [...new Set(changes)].sort((a, b) => a - b);
      if (chosen.some((i) => i >= proposed.length)) {
        return reply.code(400).send({ error: 'no such change' });
      }
      const { draft } = await versionsOf(templates, projectId);
      if (draft === null || draft !== record.baseVersion) {
        return reply.code(409).send({ error: 'the draft version changed since this proposal; re-run the stage' });
      }
      const draftRecord = (await templates.get(projectId, draft))!;
      const selected = chosen.map((i) => proposed[i]!);
      const clashes = conflictingChanges(record.baseDefinition ?? {}, draftRecord.definition, selected).map(
        (k) => chosen[k]! + 1,
      );
      if (clashes.length) {
        return reply.code(409).send({
          error: `the draft changed since this proposal where these changes apply: ${clashes.join(', ')}; re-run the stage or accept the others`,
        });
      }
      const decided = await workbench.decideProposal(
        projectId,
        pid,
        chosen.length === proposed.length ? 'accepted' : 'partially_accepted',
        chosen,
      );
      if (!decided) return reply.code(409).send({ error: 'proposal was already decided' });
      await templates.updateDraft(
        projectId,
        draft,
        pinned(applyChanges(draftRecord.definition, selected), projectId, draft),
      );
      req.log.info({ projectId, proposal: pid, applied: chosen }, 'drafting changes applied');
      return proposalView(app, decided, job);
```

In `apps/api/test/workbench-drafting.test.ts` (3a), change `expect((await start('outputs')).statusCode).toBe(400);` to `start('references')`. Outputs is available now, and the stage order would answer 409 first. Leave the other assertions as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`
Expected: PASS, including the `access.test.ts` sweep over the new routes.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: drafting stage order, per-change decisions applied to the draft, skip and stage states"
```

---

### Task 7: Web: client and the stage panel

**Files:**
- Create: `apps/web/src/workbench/StagePanel.tsx`
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`
- Test: `apps/web/test/StagePanel.test.tsx` (new), `apps/web/test/client.test.ts`

**Interfaces:**
- Produces:
  - Api:
    - `decideProposal(projectId, proposalId, decision, changes?: number[])`. The body is `{ decision }`, plus `changes` when given.
    - `skipStage(projectId: string, stage: DraftStage): Promise<StageView[]>` (POST `/stages/:stage/skip`)
    - `listStages(projectId: string): Promise<StageView[]>`
  - fake-api defaults: `listStages` returns `[]`; `skipStage` throws "not stubbed". New builder `changeProposalView(overrides?)`.
  - `StagePanel({ api, projectId, stage, dataPolicy, hasDraft, pollMs, onApplied, onSkipped })`, where `stage: ChangeStage`:
    - **Propose button:** "Propose outputs", "Propose section anchors" or "Propose extraction steps"; "Propose again" once a proposal exists.
    - **No open draft:** the button is disabled and the panel says "Start the next version on the Template tab first."
    - **Policy note:** the same text as the Survey tab.
    - **While running:** polls every `pollMs`.
    - **Failed proposal:** `role="alert"`.
    - **Ready proposal:**
      - notes;
      - a list of changes, each a checkbox labelled with `describeChange`, all checked by default;
      - for sections, each put section shows "found in X of N dev samples (missed: …)";
      - **Apply selected changes** calls `decideProposal(…, 'accepted', indexes)`, then `onApplied()`;
      - **Reject all** rejects the proposal.
    - **Accepted or partially accepted proposal:** shows which changes were applied.
    - **Skip this stage** (always shown) calls `skipStage`, then `onSkipped()`.
    - **Errors**, including a 409 conflict message, show in `role="alert"`.
  - `describeChange(c: DraftChange): string` (exported for tests).

- [ ] **Step 1: Write the failing tests**

`client.test.ts`:

```ts
describe('http api: drafting stages', () => {
  it('decides chosen changes, skips and lists stages', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, []));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.decideProposal('letter', 'p1', 'accepted', [0, 2]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      decision: 'accepted',
      changes: [0, 2],
    });
    await api.decideProposal('letter', 'p1', 'rejected');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ decision: 'rejected' });
    await api.skipStage('letter', 'survey');
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/workbench/projects/letter/stages/survey/skip');
    await api.listStages('letter');
    expect(fetchMock.mock.calls[3]![0]).toBe('/api/workbench/projects/letter/stages');
  });
});
```

`apps/web/test/StagePanel.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { StagePanel } from '../src/workbench/StagePanel.js';
import { changeProposalView, fakeApi, sampleView } from './fake-api.js';

function panel(overrides = {}, props: Partial<Parameters<typeof StagePanel>[0]> = {}) {
  const api = fakeApi(overrides);
  const onApplied = vi.fn();
  const onSkipped = vi.fn();
  render(
    <StagePanel
      api={api}
      projectId="letter"
      stage="outputs"
      dataPolicy="local"
      hasDraft
      pollMs={1}
      onApplied={onApplied}
      onSkipped={onSkipped}
      {...props}
    />,
  );
  return { api, onApplied, onSkipped };
}

describe('StagePanel', () => {
  it('proposes, then applies only the selected changes', async () => {
    const p = changeProposalView();
    const listProposals = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...p, status: 'running', body: null }])
      .mockResolvedValue([p]);
    const { api, onApplied } = panel({
      listProposals,
      startStage: vi.fn(async () => ({ ...p, status: 'running' as const, body: null })),
      decideProposal: vi.fn(async () => ({ ...p, status: 'partially_accepted' as const, acceptedChanges: [1] })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Propose outputs' }));
    expect(api.startStage).toHaveBeenCalledWith('letter', 'outputs');
    const first = await screen.findByRole('checkbox', { name: /Field protocol_number/ });
    expect(first).toBeChecked();
    await userEvent.click(first);
    await userEvent.click(screen.getByRole('button', { name: 'Apply selected changes' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', p.id, 'accepted', [1]);
    expect(onApplied).toHaveBeenCalled();
    expect(await screen.findByText(/1 of 2 changes applied/)).toBeInTheDocument();
  });

  it('rejects all', async () => {
    const p = changeProposalView();
    const { api } = panel({
      listProposals: vi.fn(async () => [p]),
      decideProposal: vi.fn(async () => ({ ...p, status: 'rejected' as const })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Reject all' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', p.id, 'rejected');
  });

  it('shows a conflict from the API', async () => {
    panel({
      listProposals: vi.fn(async () => [changeProposalView()]),
      decideProposal: vi.fn(async () => {
        throw new ApiError('the draft changed since this proposal where these changes apply: 2; re-run the stage or accept the others', 409);
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Apply selected changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the draft changed since this proposal');
  });

  it('needs an open draft', async () => {
    panel({}, { hasDraft: false });
    expect(await screen.findByRole('button', { name: 'Propose outputs' })).toBeDisabled();
    expect(screen.getByText('Start the next version on the Template tab first.')).toBeInTheDocument();
  });

  it('skips the stage', async () => {
    const { api, onSkipped } = panel({ skipStage: vi.fn(async () => []) });
    await userEvent.click(await screen.findByRole('button', { name: 'Skip this stage' }));
    expect(api.skipStage).toHaveBeenCalledWith('letter', 'outputs');
    await waitFor(() => expect(onSkipped).toHaveBeenCalled());
  });

  it('shows where proposed anchors were found on the dev samples', async () => {
    const a = sampleView({ id: 'sa', filename: 'a.pdf' });
    const b = sampleView({ id: 'sb', filename: 'b.pdf' });
    const p = changeProposalView({
      stage: 'sections',
      body: {
        notes: '',
        changes: [
          { op: 'putSection', section: { id: 'approval', anchor: '^PROTOCOL APPROVAL', required: false }, reason: 'r' },
        ],
        anchorCheck: {
          anchorErrors: {},
          samples: [
            { sampleId: 'sa', firstPage: 1, pageCount: 1, error: null, missingRequired: [], sections: [{ id: 'approval', found: true, page: 1, line: 'PROTOCOL APPROVAL', chars: 10 }] },
            { sampleId: 'sb', firstPage: 1, pageCount: 1, error: null, missingRequired: [], sections: [{ id: 'approval', found: false, page: null, line: null, chars: 0 }] },
          ],
        },
      },
    });
    panel(
      { listProposals: vi.fn(async () => [p]), listSamples: vi.fn(async () => [a, b]) },
      { stage: 'sections' },
    );
    const item = (await screen.findByRole('checkbox', { name: /Section approval/ })).closest('li')!;
    expect(await within(item).findByText('found in 1 of 2 dev samples (missed: b.pdf)')).toBeInTheDocument();
  });
});
```

(Check the `SegmentedSample` shape in `packages/shared/src/workbench.ts`, including `missingRequired`, `line`, `chars` and `error`, and adjust the literal to match. Don't change what the test asserts.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/client.test.ts apps/web/test/StagePanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`client.ts`:
- Extend the `Api` interface for the three methods.
- `decideProposal: (id, proposalId, decision, changes) => post<ProposalView>(\`${base}/workbench/projects/${id}/proposals/${proposalId}/decision\`, changes ? { decision, changes } : { decision })`
- `skipStage: (id, stage) => post<StageView[]>(\`${base}/workbench/projects/${id}/stages/${stage}/skip\`, {})`
- `listStages: (id) => apiFetch(\`${base}/workbench/projects/${id}/stages\`).then(json<StageView[]>)`

`fake-api.ts`: add the defaults, plus:

```ts
export function changeProposalView(overrides: Partial<ProposalView> = {}): ProposalView {
  return proposalView({
    stage: 'outputs',
    body: {
      notes: 'Dates are DMY in every sample.',
      changes: [
        { op: 'putField', field: { id: 'protocol_number', type: 'text', description: 'Protocol id' }, reason: 'header' },
        { op: 'putField', field: { id: 'approved_on', type: 'date' }, reason: 'approval page' },
      ],
    },
    acceptedChanges: null,
    ...overrides,
  });
}
```

`apps/web/src/workbench/StagePanel.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  changeBodyOf,
  type ChangeStage,
  type DataPolicy,
  type DraftChange,
  type ProposalView,
  type SampleView,
} from '@ih/shared';
import type { Api } from '../api/client.js';

const PROPOSE: Record<ChangeStage, string> = {
  outputs: 'Propose outputs',
  sections: 'Propose section anchors',
  steps: 'Propose extraction steps',
};

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

/** One line per change, used as its checkbox label. */
export function describeChange(c: DraftChange): string {
  switch (c.op) {
    case 'putField':
      return `Field ${c.field.id} (${c.field.type}${c.field.type === 'enum' ? `: ${(c.field.enum ?? []).join(', ')}` : ''})`;
    case 'putTable':
      return `Table ${c.table.id} (${c.table.columns.map((col) => col.id).join(', ')})`;
    case 'removeOutput':
      return `Remove output ${c.id}`;
    case 'putSection':
      return `Section ${c.section.id}: /${c.section.anchor}/${c.section.required ? '' : ' (optional)'}`;
    case 'removeSection':
      return `Remove section ${c.id}`;
    case 'setCopies':
      return c.copies
        ? `Keep the ${c.copies.select} copy, split at /${c.copies.anchor}/`
        : 'No copy selection';
    case 'putStep':
      return c.step.type === 'extract'
        ? `Extract step ${c.step.id}: ${c.step.table ? `table ${c.step.table}` : c.step.fields.join(', ')} from ${c.step.sections.join(', ')}`
        : `Check step ${c.step.id}: ${c.step.values} against ${c.step.reference}`;
    case 'removeStep':
      return `Remove step ${c.id}`;
    case 'setPreamble':
      return c.preamble ? 'Set the prompt preamble' : 'Remove the prompt preamble';
  }
}

/** Drafting stages 2-4 (ADR 0007): propose changes to the draft, apply the chosen ones. */
export function StagePanel({
  api,
  projectId,
  stage,
  dataPolicy,
  hasDraft,
  pollMs,
  onApplied,
  onSkipped,
}: {
  api: Api;
  projectId: string;
  stage: ChangeStage;
  dataPolicy: DataPolicy;
  hasDraft: boolean;
  pollMs: number;
  onApplied: () => void;
  onSkipped: () => void;
}) {
  const [proposal, setProposal] = useState<ProposalView | null | undefined>(undefined);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [samples, setSamples] = useState<SampleView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await api.listProposals(projectId);
      setProposal(all.find((p) => p.stage === stage) ?? null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId, stage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const body = proposal ? changeBodyOf(proposal) : null;
  const running = proposal?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, refresh]);

  const proposalId = proposal?.id;
  const changeCount = body?.changes.length ?? 0;
  useEffect(() => {
    setSelected(new Set(Array.from({ length: changeCount }, (_, i) => i)));
  }, [proposalId, changeCount]);

  useEffect(() => {
    if (stage !== 'sections') return;
    api.listSamples(projectId).then(setSamples, () => setSamples([]));
  }, [api, projectId, stage]);

  const act = async (action: () => Promise<void>) => {
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const run = () => act(async () => setProposal(await api.startStage(projectId, stage)));
  const accept = () =>
    act(async () => {
      if (!proposal) return;
      const chosen = [...selected].sort((a, b) => a - b);
      setProposal(await api.decideProposal(projectId, proposal.id, 'accepted', chosen));
      onApplied();
    });
  const reject = () =>
    act(async () => {
      if (!proposal) return;
      setProposal(await api.decideProposal(projectId, proposal.id, 'rejected'));
    });
  const skip = () =>
    act(async () => {
      await api.skipStage(projectId, stage);
      setMessage('Stage skipped; write this part by hand on the Template tab.');
      onSkipped();
    });

  const toggle = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setSelected(next);
  };

  const anchorLine = (c: DraftChange): string | null => {
    if (c.op !== 'putSection' || !body?.anchorCheck) return null;
    const rows = body.anchorCheck.samples.filter((r) => !r.error);
    const name = (id: string) => samples.find((s) => s.id === id)?.filename ?? id;
    const missed = rows.filter((r) => !r.sections.some((s) => s.id === c.section.id && s.found));
    const found = rows.length - missed.length;
    return `found in ${found} of ${rows.length} dev samples${missed.length ? ` (missed: ${missed.map((r) => name(r.sampleId)).join(', ')})` : ''}`;
  };

  if (proposal === undefined) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;
  const applied = proposal?.acceptedChanges ?? null;

  return (
    <div className="stage-panel">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      {!hasDraft && <p className="muted">Start the next version on the Template tab first.</p>}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={running || !hasDraft}
          onClick={() => void run()}
        >
          {proposal ? 'Propose again' : PROPOSE[stage]}
        </button>
        <button type="button" onClick={() => void skip()}>
          Skip this stage
        </button>
      </div>
      {running && <p className="muted">Drafting…</p>}
      {error && <p role="alert">{error}</p>}
      {proposal?.status === 'failed' && <p role="alert">{proposal.error}</p>}
      {message && <p role="status">{message}</p>}
      {body && proposal && (
        <section aria-label="Proposal">
          <p className="muted">
            {proposal.model} · brief v{proposal.briefVersion ?? '–'} · {proposal.status.replace('_', ' ')}
          </p>
          {body.notes && <p>{body.notes}</p>}
          {applied && (
            <p role="status">
              {applied.length} of {body.changes.length} changes applied to the draft
            </p>
          )}
          <ul className="changes">
            {body.changes.map((c, i) => {
              const line = anchorLine(c);
              return (
                <li key={`${i}-${c.op}`}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={proposal.status !== 'ready'}
                      checked={proposal.status === 'ready' ? selected.has(i) : (applied ?? []).includes(i)}
                      onChange={() => toggle(i)}
                    />{' '}
                    {describeChange(c)}
                  </label>
                  <small className="muted"> {c.reason}</small>
                  {line && <p className="muted">{line}</p>}
                  <details>
                    <summary>Details</summary>
                    <pre>{JSON.stringify(c, null, 2)}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
          {proposal.status === 'ready' && (
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={selected.size === 0}
                onClick={() => void accept()}
              >
                Apply selected changes
              </button>
              <button type="button" onClick={() => void reject()}>
                Reject all
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
```

(If the first test's "1 of 2 changes applied" text sits in a `role="status"`, query it however the test needs, but keep the text.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: stage panel (propose, choose changes, apply, reject, skip, anchor check)"
```

---

### Task 8: Web: Outputs and Steps tabs, stage states in the tab bar, survey skip

**Files:**
- Modify: `apps/web/src/router.ts`, `apps/web/src/workbench/ProjectPage.tsx`, `apps/web/src/workbench/SurveyTab.tsx`, `apps/web/src/styles.css` (only if a class needs a rule)
- Test: `apps/web/test/router.test.ts`, `apps/web/test/ProjectPage.test.tsx`, `apps/web/test/SurveyTab.test.tsx`

**Interfaces:**
- Consumes: `StagePanel` (Task 7); `listStages`, `skipStage` (Task 7).
- Produces:
  - `PROJECT_TABS = ['samples', 'brief', 'survey', 'outputs', 'sections', 'steps', 'template', 'runs']`.
  - `ProjectPage` loads `listStages` on mount and after any decision or skip. For a stage tab whose state isn't `pending`, the tab link shows a suffix such as `Outputs · stale`.
  - The Outputs and Steps tabs render `StagePanel`. The Sections tab renders `StagePanel` above the existing `SectionsTab`, which remounts after changes are applied.
  - `SurveyTab` gains an optional `onChanged?: () => void`, called after a decision or a skip, and a **Skip this stage** button.

- [ ] **Step 1: Write the failing tests**

`router.test.ts` rows:

```ts
['#/workbench/letter/outputs', { name: 'project', projectId: 'letter', tab: 'outputs' }],
['#/workbench/letter/steps', { name: 'project', projectId: 'letter', tab: 'steps' }],
```

`ProjectPage.test.tsx` (use the file's existing `page()` helper, which passes `role="admin"`):

```tsx
  it('shows each drafting stage state in the tab bar', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      listStages: vi.fn(async () => [
        { stage: 'survey' as const, state: 'accepted' as const, completedAt: '2026-10-12T10:00:00.000Z' },
        { stage: 'outputs' as const, state: 'stale' as const, completedAt: '2026-10-12T09:00:00.000Z' },
        { stage: 'sections' as const, state: 'pending' as const, completedAt: null },
        { stage: 'steps' as const, state: 'pending' as const, completedAt: null },
      ]),
    });
    render(<ProjectPage api={api} projectId="letter" tab="outputs" onNavigate={vi.fn()} role="admin" />);
    const tabs = await screen.findByRole('navigation', { name: 'Project' });
    expect(await within(tabs).findByRole('link', { name: /Outputs · stale/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: /Survey · accepted/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: /^Sections$/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Propose outputs' })).toBeInTheDocument();
  });

  it('shows the anchor proposals above the Sections editor', async () => {
    render(
      <ProjectPage
        api={fakeApi({ getProject: vi.fn(async () => projectView()) })}
        projectId="letter"
        tab="sections"
        onNavigate={vi.fn()}
        role="admin"
      />,
    );
    expect(await screen.findByRole('button', { name: 'Propose section anchors' })).toBeInTheDocument();
  });
```

(Import `within` if the file doesn't already. `projectView()` must have an open draft so the button is enabled; check its default.)

`SurveyTab.test.tsx`:

```tsx
  it('skips the survey and reports the change', async () => {
    const onChanged = vi.fn();
    const api = fakeApi({ skipStage: vi.fn(async () => []) });
    render(
      <SurveyTab api={api} projectId="letter" dataPolicy="local" brief={brief} onBriefSaved={vi.fn()} pollMs={1} onChanged={onChanged} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Skip this stage' }));
    expect(api.skipStage).toHaveBeenCalledWith('letter', 'survey');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/router.test.ts apps/web/test/ProjectPage.test.tsx apps/web/test/SurveyTab.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `router.ts`: the new `PROJECT_TABS`.
- `ProjectPage.tsx`:
  - Add `outputs: 'Outputs'` and `steps: 'Steps'` to `TAB_LABEL`.
  - State: `const [stages, setStages] = useState<StageView[]>([]);` and `const [revision, setRevision] = useState(0);`.
  - `const loadStages = useCallback(() => { api.listStages(projectId).then(setStages, () => setStages([])); }, [api, projectId]);` with `useEffect(loadStages, [loadStages]);`.
  - `const changed = () => { loadStages(); load(); setRevision((r) => r + 1); };`
  - Tab link content:

```tsx
            {TAB_LABEL[t]}
            {(() => {
              const s = stages.find((x) => x.stage === t);
              return s && s.state !== 'pending' ? ` · ${s.state}` : '';
            })()}
```

  - Render, for `t` in `outputs | steps`:

```tsx
      {(tab === 'outputs' || tab === 'steps') && (
        <>
          <StagePanel
            key={`${tab}-${revision}`}
            api={api}
            projectId={project.id}
            stage={tab}
            dataPolicy={project.dataPolicy}
            hasDraft={draft !== null}
            pollMs={pollMs}
            onApplied={changed}
            onSkipped={changed}
          />
          <p className="muted">
            Edit by hand on the <a href={`#/workbench/${project.id}/template`}>Template</a> tab.
          </p>
        </>
      )}
```

  - For `sections`, render the same `StagePanel` with `stage="sections"` above `<SectionsTab key={revision} ... />`.
  - Pass `onChanged={changed}` to `SurveyTab`.
- `SurveyTab.tsx`:
  - Add the `onChanged?: () => void` prop and call it after a successful `decide`.
  - Add a **Skip this stage** button next to Run survey: `act(async () => { await api.skipStage(projectId, 'survey'); setMessage('Survey skipped'); onChanged?.(); })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: Outputs and Steps tabs, anchor proposals on Sections, stage states in the tab bar"
```

---

### Task 9: Docs, full check and smoke test

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md`

- [ ] **Step 1: Document it**

`CLAUDE.md`:
- Contracts table: add a **Drafting changes** row.
  - TypeScript: `DraftChangeSchema`, `ChangeBodySchema`, `applyChanges` and `stageStates` in `packages/shared/src/drafting.ts`.
  - Python: `draft_changes.apply_changes`, and `draft_stages` (flat schemas and converters).
  - Note: shared fixture `packages/shared/test/fixtures/draft-changes.json`.
- Workbench bullet, add:
  - Stages run in order (`STAGE_ORDER`). A stage counts as complete once it is accepted or skipped. Stale is derived, never stored.
  - Change proposals carry `baseVersion` and `baseDefinition`. Accepting applies the chosen changes to the open draft. A change whose target was edited since the proposal is refused (409).
  - The sections stage checks anchors on every dev sample, gives one feedback round, and stores the grid as `anchorCheck`.
  - `run_extraction(check=...)` feeds rules beyond JSON Schema back to the model.

`docs/architecture.md`: in the Workbench section, add one paragraph on the change stages and per-change acceptance.

`docs/design/workbench.md`, Phasing:
- Mark 3b done: outputs, sections and steps stages; per-change accept; skip; stale.
- Move "the references stage" into phase 4's line: "Evaluation loop: the references stage (reference proposals and verification), step cache, …".
- In the API sketch, mark the decision as `{ decision, changes? }`.

- [ ] **Step 2: Full check**

Run `npm run check` and `npm run format:check`. If `uv` is not on PATH, run the worker parts separately.
Expected: PASS.

- [ ] **Step 3: Smoke test (throwaway infra only)**

1. Apply migrations 0001–0012 to a throwaway Postgres, and run the opt-in `workbench-pg` integration test against it.
2. If a full stack is available, run the whole journey with a local `draft` model:
   - Survey, then accept it.
   - Outputs: apply some changes.
   - Sections: check that each anchor line shows found counts.
   - Steps: apply them.
   - Run a dev test run from the Test runs tab. The draft should validate.
   - Re-run and accept the survey. Outputs, Sections and Steps should show `stale`.
3. No real external LLM calls. Record anything you couldn't run in the PR description.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs
git commit -m "Workbench: document phase 3b (outputs, sections and steps drafting stages)"
```
