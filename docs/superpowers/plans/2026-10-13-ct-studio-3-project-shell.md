# Workbench project screen shell + overview API (PR 3 of 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Workbench project page its redesigned frame — icon-only app nav, a vertical "Project steps" rail with status icons and a legend, a new header with the data-policy pill and a gated **Publish vN** button, and a default **Overview** tab — all fed by one new aggregate call, `GET /api/workbench/projects/:id/overview` (handoff W2).

**Architecture:** Pure shared logic (`packages/shared/src/overview.ts`, from PR 2) gains the W2 response schema, per-tab status text (`overviewItems`) and the Next banner (`overviewNext`). A new route plugin `apps/api/src/routes/workbench-overview.ts` gathers the inputs with the existing helpers of `routes/workbench.ts` (exported for it) and returns `ProjectOverview`. The web adds `getProjectOverview` to the `Api` port, makes `overview` the default project tab, compacts the app nav on project routes, and replaces the horizontal `workbench-tabs` with `ProjectRail` + `ProjectHeader`. The Overview tab in this PR shows the Next banner and a stage list; PR 4 replaces the list with the map and adds per-box metrics to the API.

**Tech Stack:** Fastify + Zod (route schema documents the route, pass-through validation), MemoryRepo/`testApp()`/`app.inject`, React 19, Vitest + Testing Library.

**Spec:** `docs/design/workbench-redesign/WORKBENCH-HANDOFF.md` §2 (project page shell), §3 (Next banner), §5 W2 and W4, §6 steps 2–3. PR 2's carry-forward notes are folded into the tasks below.

## Global Constraints

- Rail: `nav aria-label="Project steps"`, groups in this order with uppercase headings: *(no heading)* Overview · **Prepare:** Samples, Brief · **Draft with the model:** Survey, Outputs, Sections, Steps · **Verify:** References, Evaluate, Revise · **By hand:** Template, Test runs. Each item: 17 px tab icon, label, 20 px status icon; accessible name and tooltip carry the full status (`"Sections: Stale — Outputs changed after it was accepted"`); active item `aria-current="page"`; legend at the bottom.
- Tab → status: Survey/Outputs/Sections/Steps/References from stage views; Samples, Brief, Evaluate, Revise, Publish derived (PR 2 `overviewStates`); Test runs via `runsState`; Overview and Template have none.
- Router: `PROJECT_TABS` gains `'overview'` first; `#/workbench/<id>` opens Overview.
- App nav collapses to icons (68 px rail, `aria-label` + tooltip on each link) on `route.name === 'project'` only.
- Header: back link "Workbench"; H1 project name; "Developing vN" info pill; "vM published · `<id>`"; data-policy pill ("Local models only" ok tone / "External models allowed" warn tone); admin button **Allow external models…** / **Restrict to local models** (keep the existing confirm); **Publish vN** looks locked until the gate passes, `title` = gate reason, opens the Evaluate tab.
- W2 response: `{ project: ProjectView; stages: { stage; state; status }[]; next: { stage; title; reason } | null; gate: GateView }`. `metrics` are added by PR 4.
- Overview polled every `pollMs` while any item is `running`; refetched on window focus and after any change made on the page.
- Below 760 px: the rail becomes a `<select>`; nothing scrolls the page sideways at 390 px.
- New routes are documented (Fastify `schema` with `tags`, `operationId`, `summary`, `description`, Zod `params`, `response`); not added to `UNDOCUMENTED`.
- Tests first; `npm run check` green; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never stage `config/llm-providers.yaml`; stage files by name.

## Review Focus

1. **A revise accepted for an earlier version** must not make the new draft's Revise look done: only revise proposals created after the latest publication count (Task 2 test).
2. **A project whose type is fully published (no open draft)** — rail shows every stage done, header shows "No open draft", no Publish button, banner absent (Tasks 1, 5 tests).
3. **Polling stops** once nothing is running, and the timer is cleared on unmount (Task 6 test with fake timers).
4. **Non-admin** sees the policy pill but no policy button (Task 5 test).
5. **Stale wording** names the earlier stage that changed, and falls back to a generic sentence when none is found (Task 1 test).

---

### Task 1: Shared W2 schema, per-tab status text, Next banner

**Files:**
- Modify: `packages/shared/src/evaluation.ts` (add `GateViewSchema`; derive `GateView` from it)
- Modify: `packages/shared/src/overview.ts`
- Test: `packages/shared/test/overview.test.ts` (append)

**Interfaces:**
- Consumes (PR 2): `OVERVIEW_STAGES`, `OVERVIEW_LABEL`, `OverviewInputs`, `OverviewEntry`, `overviewStates`, `nextAction`, `urgency`, `runsState`, `briefSaved`; `ProjectViewSchema` (`workbench.ts`); `STAGE_ORDER` (`drafting.ts`).
- Produces:
  - `GateViewSchema` (Zod) with `type GateView = z.infer<typeof GateViewSchema>` (same shape as today).
  - `OVERVIEW_TABS = [...OVERVIEW_STAGES, 'template', 'runs'] as const`; `type OverviewTab`; `OVERVIEW_TAB_LABEL: Record<OverviewTab, string>` (= `OVERVIEW_LABEL` + Template, Test runs).
  - `OverviewStateSchema` (z.enum of the 9 `OverviewState` values); `OverviewItemSchema = { stage: z.enum(OVERVIEW_TABS), state: OverviewStateSchema | 'none', status: string }`; `OverviewNextSchema = { stage: z.enum(OVERVIEW_STAGES), title, reason }`; `ProjectOverviewSchema = { project: ProjectViewSchema, stages: OverviewItemSchema[], next: OverviewNextSchema.nullable(), gate: GateViewSchema }` and the inferred types `OverviewItem`, `OverviewNext`, `ProjectOverview`.
  - `interface StatusContext { inputs: OverviewInputs; briefVersion: number | null; runs: { total: number; unfinished: number; awaitingReview: number }; openFeedback: number }`
  - `overviewItems(ctx: StatusContext): OverviewItem[]` — 12 items in `OVERVIEW_TABS` order.
  - `overviewNext(inputs: OverviewInputs, entries?: readonly OverviewEntry[]): OverviewNext | null`

- [ ] **Step 1: Write the failing tests** — append to `packages/shared/test/overview.test.ts` (extend the import list with `OVERVIEW_TABS, ProjectOverviewSchema, overviewItems, overviewNext, type StatusContext`; reuse the file's `inputs`, `drafted`, `gate` helpers):

```ts
const ctx = (over: Partial<StatusContext> = {}, i: OverviewInputs = inputs()): StatusContext => ({
  inputs: i,
  briefVersion: 3,
  runs: { total: 0, unfinished: 0, awaitingReview: 0 },
  openFeedback: 0,
  ...over,
});
const status = (c: StatusContext, stage: (typeof OVERVIEW_TABS)[number]) =>
  overviewItems(c).find((x) => x.stage === stage)!;

describe('overviewItems', () => {
  it('lists the ten stages, then Template and Test runs', () => {
    expect(overviewItems(ctx()).map((x) => x.stage)).toEqual([...OVERVIEW_TABS]);
    expect(OVERVIEW_TABS.slice(-2)).toEqual(['template', 'runs']);
  });

  it.each([
    [{ total: 0, preparing: 0, failed: 0 }, 'warn', 'No samples yet'],
    [{ total: 4, preparing: 0, failed: 2 }, 'warn', '2 failed'],
    [{ total: 4, preparing: 1, failed: 0 }, 'running', 'Preparing 1 of 4'],
    [{ total: 4, preparing: 0, failed: 0 }, 'accepted', 'Ready'],
  ] as const)('samples %o', (samples, state, text) => {
    expect(status(ctx({}, inputs({ samples })), 'samples')).toEqual({ stage: 'samples', state, status: text });
  });

  it('says which brief version is saved', () => {
    expect(status(ctx(), 'brief').status).toBe('Saved v3');
    expect(status(ctx({ briefVersion: null }, inputs({ briefSaved: false })), 'brief').status).toBe('Not written yet');
  });

  it.each([
    ['accepted', 'Accepted'],
    ['skipped', 'Skipped'],
    ['proposed', 'Needs your decision'],
    ['running', 'Running'],
    ['pending', 'Not started'],
  ] as const)('drafting stage %s → %s', (state, text) => {
    expect(status(ctx({}, inputs({ stages: drafted({ outputs: state }) })), 'outputs').status).toBe(text);
  });

  it('says References are verified', () => {
    expect(status(ctx(), 'references').status).toBe('Verified');
  });

  it('names the earlier stage that made a stage stale', () => {
    const stages = [
      { stage: 'survey' as const, state: 'accepted' as const, completedAt: '2026-10-13T09:00:00Z' },
      { stage: 'outputs' as const, state: 'accepted' as const, completedAt: '2026-10-13T11:00:00Z' },
      { stage: 'sections' as const, state: 'stale' as const, completedAt: '2026-10-13T10:00:00Z' },
      { stage: 'steps' as const, state: 'pending' as const, completedAt: null },
    ];
    expect(status(ctx({}, inputs({ stages })), 'sections').status).toBe(
      'Stale — Outputs changed after it was accepted',
    );
    const unknown = stages.map((s) => (s.stage === 'outputs' ? { ...s, completedAt: null } : s));
    expect(status(ctx({}, inputs({ stages: unknown })), 'sections').status).toBe(
      'Stale — an earlier stage changed after it was accepted',
    );
  });

  it.each([
    [inputs(), 'pending', 'Not run on holdout yet'],
    [inputs({ evaluation: { running: true } }), 'running', 'Running'],
    [inputs({ gate: gate({ iterationId: 'it1', score: 0.86 }) }), 'warn', 'Holdout 86%, below 90%'],
    [inputs({ gate: gate({ iterationId: 'it1', score: 0.95, passes: false }) }), 'warn', 'Re-run holdout'],
    [inputs({ gate: gate({ iterationId: 'it1', score: 0.93, passes: true }) }), 'accepted', 'Holdout 93% passes'],
  ] as const)('evaluate %#', (i, state, text) => {
    expect(status(ctx({}, i), 'evaluate')).toEqual({ stage: 'evaluate', state, status: text });
  });

  it.each([
    [null, 0, 'No feedback'],
    [null, 3, '3 open'],
    ['running', 3, 'Running'],
    ['ready', 3, 'Needs your decision'],
    ['accepted', 0, 'Applied'],
  ] as const)('revise %s with %i open', (revise, openFeedback, text) => {
    expect(status(ctx({ openFeedback }, inputs({ revise })), 'revise').status).toBe(text);
  });

  it('describes Publish, Template and Test runs', () => {
    expect(status(ctx(), 'publish')).toEqual({ stage: 'publish', state: 'locked', status: 'Locked by the gate' });
    const ready = inputs({ gate: gate({ iterationId: 'it1', score: 0.93, passes: true }) });
    expect(status(ctx({}, ready), 'publish').status).toBe('Ready to publish v2');
    expect(status(ctx(), 'template')).toEqual({ stage: 'template', state: 'none', status: 'Draft v2' });
    expect(status(ctx({ runs: { total: 6, unfinished: 2, awaitingReview: 1 } }), 'runs')).toEqual({
      stage: 'runs',
      state: 'running',
      status: '2 running',
    });
    expect(status(ctx({ runs: { total: 6, unfinished: 0, awaitingReview: 1 } }), 'runs').status).toBe('1 awaiting review');
    expect(status(ctx({ runs: { total: 6, unfinished: 0, awaitingReview: 0 } }), 'runs').status).toBe('6 finished');
    expect(status(ctx(), 'runs').status).toBe('No runs yet');
  });

  it('shows a fully published type as done', () => {
    const items = overviewItems(ctx({}, inputs({ draft: null, published: 3 })));
    expect(items.find((x) => x.stage === 'publish')!.status).toBe('v3 published');
    expect(items.find((x) => x.stage === 'outputs')).toEqual({ stage: 'outputs', state: 'accepted', status: 'Done' });
    expect(items.find((x) => x.stage === 'template')!.status).toBe('v3 published');
  });
});

describe('overviewNext', () => {
  it.each([
    ['no draft', inputs({ draft: null }), null],
    [
      'stale',
      inputs({ stages: drafted({ survey: 'accepted', outputs: 'accepted', sections: 'stale', steps: 'proposed' }) }),
      { stage: 'sections', title: 'Next: refresh Sections', reason: 'An earlier stage changed after Sections was accepted.' },
    ],
    [
      'proposal',
      inputs({ stages: drafted({ survey: 'accepted', outputs: 'accepted', sections: 'accepted', steps: 'proposed' }) }),
      { stage: 'steps', title: 'Next: decide on Steps', reason: 'A proposal is waiting for your decision.' },
    ],
    [
      'gate below threshold',
      inputs({ gate: gate({ iterationId: 'it1', score: 0.5, reason: 'holdout score 50% is below the threshold 90%' }) }),
      { stage: 'evaluate', title: 'Next: raise the holdout score', reason: 'Holdout score 50% is below the threshold 90%.' },
    ],
    [
      'gate without a usable score',
      inputs({ gate: gate({ iterationId: 'it1', score: 0.95, reason: 'holdout evaluation covered 1 of 2 holdout samples' }) }),
      { stage: 'evaluate', title: 'Next: re-run the holdout evaluation', reason: 'Holdout evaluation covered 1 of 2 holdout samples.' },
    ],
    [
      'no samples',
      inputs({ samples: { total: 0, preparing: 0, failed: 0 } }),
      { stage: 'samples', title: 'Next: add sample PDFs', reason: 'Upload 3–8 dev samples and a few holdout samples.' },
    ],
    [
      'failed samples',
      inputs({ samples: { total: 4, preparing: 0, failed: 2 } }),
      { stage: 'samples', title: 'Next: fix the failed samples', reason: '2 samples could not be prepared.' },
    ],
    [
      'brief',
      inputs({ briefSaved: false }),
      { stage: 'brief', title: 'Next: write the brief', reason: 'Describe the document and what to extract from it.' },
    ],
    [
      'not started',
      inputs({ stages: drafted({ survey: 'accepted' }) }),
      { stage: 'outputs', title: 'Next: start Outputs', reason: 'The stages before it are done.' },
    ],
    [
      'falls back to publishing',
      inputs({ gate: gate({ iterationId: 'it1', score: 0.93, passes: true, reason: 'holdout score 93% meets the threshold 90%' }) }),
      { stage: 'publish', title: 'Next: publish v2', reason: 'Holdout score 93% meets the threshold 90%.' },
    ],
    [
      'falls back to a running stage',
      inputs({ stages: drafted({ survey: 'accepted', outputs: 'accepted', sections: 'accepted', steps: 'accepted', references: 'running' }) }),
      { stage: 'references', title: 'Next: references running', reason: 'References is running; this page updates when it finishes.' },
    ],
  ] as const)('%s', (_, i, expected) => {
    expect(overviewNext(i)).toEqual(expected);
  });
});

describe('ProjectOverviewSchema', () => {
  it('accepts an overview built from the functions', () => {
    const i = inputs();
    const parsed = ProjectOverviewSchema.safeParse({
      project: {
        project: {
          id: 'letter',
          name: 'Letter',
          createdAt: '2026-10-13T00:00:00Z',
          dataPolicy: 'local',
          dataPolicyChangedAt: null,
          dataPolicyChangedBy: null,
          publishThreshold: 0.9,
          thresholdSetBy: null,
          thresholdSetAt: null,
        },
        draft: 2,
        published: 1,
        brief: null,
      },
      stages: overviewItems(ctx({}, i)),
      next: overviewNext(i),
      gate: i.gate,
    });
    expect(parsed.success).toBe(true);
  });
});
```

(If `ProjectViewSchema`'s `project` object requires different fields than above, copy the exact field list from `WorkbenchProjectSchema` in `packages/shared/src/workbench.ts` — the test must build a valid `ProjectView`, not loosen the schema.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project shared packages/shared/test/overview.test.ts`
Expected: FAIL — `overviewItems` is not exported.

- [ ] **Step 3: Implement**

`packages/shared/src/evaluation.ts` — replace the `GateView` interface with a schema (keep the field comments), importing `z` if not already:

```ts
export const GateViewSchema = z.object({
  threshold: z.number(),
  iterationId: z.string().nullable(),
  score: z.number().nullable(),
  passes: z.boolean(),
  reason: z.string(),
});
export type GateView = z.infer<typeof GateViewSchema>;
```

`packages/shared/src/overview.ts` — add `import { z } from 'zod';`, `import { STAGE_ORDER } from './drafting.js';`, `import { GateViewSchema } from './evaluation.js';`, `import { ProjectViewSchema } from './workbench.js';` (keep the existing type imports), then append:

```ts
/** The project page's tabs that show a status: the ten stages, then the by-hand tabs. */
export const OVERVIEW_TABS = [...OVERVIEW_STAGES, 'template', 'runs'] as const;
export type OverviewTab = (typeof OVERVIEW_TABS)[number];

export const OVERVIEW_TAB_LABEL: Record<OverviewTab, string> = {
  ...OVERVIEW_LABEL,
  template: 'Template',
  runs: 'Test runs',
};

export const OverviewStateSchema = z.enum([
  'pending',
  'running',
  'proposed',
  'accepted',
  'skipped',
  'stale',
  'ready',
  'locked',
  'warn',
]);

export const OverviewItemSchema = z.object({
  stage: z.enum(OVERVIEW_TABS),
  /** `none`: Template, which has no status. */
  state: z.union([OverviewStateSchema, z.literal('none')]),
  /** Plain words after the stage name: "Stale — Outputs changed after it was accepted". */
  status: z.string(),
});
export type OverviewItem = z.infer<typeof OverviewItemSchema>;

export const OverviewNextSchema = z.object({
  stage: z.enum(OVERVIEW_STAGES),
  title: z.string(),
  reason: z.string(),
});
export type OverviewNext = z.infer<typeof OverviewNextSchema>;

/** GET /api/workbench/projects/:id/overview (handoff W2): the rail, header and Overview tab. */
export const ProjectOverviewSchema = z.object({
  project: ProjectViewSchema,
  stages: z.array(OverviewItemSchema),
  next: OverviewNextSchema.nullable(),
  gate: GateViewSchema,
});
export type ProjectOverview = z.infer<typeof ProjectOverviewSchema>;

export interface StatusContext {
  inputs: OverviewInputs;
  /** The latest brief's version; null when none is saved. */
  briefVersion: number | null;
  /** The project's jobs except sample preparation (Test runs tab). */
  runs: { total: number; unfinished: number; awaitingReview: number };
  /** Feedback items no revise proposal has answered yet. */
  openFeedback: number;
}

const percent = (x: number) => `${Math.round(x * 100)}%`;
/** "holdout score …" → "Holdout score ….": gate reasons are sentence fragments. */
const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${s.endsWith('.') ? '' : '.'}`;
const lowerFirst = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

const DRAFTED: Partial<Record<OverviewState, string>> = {
  accepted: 'Accepted',
  skipped: 'Skipped',
  proposed: 'Needs your decision',
  running: 'Running',
  pending: 'Not started',
};

/** The latest-completed earlier stage that completed after `stage`: why `stage` is stale. */
function staleCause(stages: OverviewInputs['stages'], stage: OverviewStage): string {
  const order: readonly string[] = [...STAGE_ORDER, 'references'];
  const own = stages.find((s) => s.stage === stage)?.completedAt ?? null;
  const cause = stages
    .filter((s) => order.indexOf(s.stage) < order.indexOf(stage))
    .filter((s) => s.completedAt !== null && own !== null && s.completedAt > own)
    .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))[0];
  const who = cause ? OVERVIEW_LABEL[cause.stage as OverviewStage] : 'an earlier stage';
  return `Stale — ${who} changed after it was accepted`;
}

function statusText(stage: OverviewStage, state: OverviewState, ctx: StatusContext): string {
  const { inputs } = ctx;
  if (inputs.draft === null) return stage === 'publish' ? `v${inputs.published} published` : 'Done';
  switch (stage) {
    case 'samples': {
      const { total, preparing, failed } = inputs.samples;
      if (total === 0) return 'No samples yet';
      if (failed > 0) return `${failed} failed`;
      return preparing > 0 ? `Preparing ${preparing} of ${total}` : 'Ready';
    }
    case 'brief':
      return state === 'accepted' ? `Saved v${ctx.briefVersion ?? 1}` : 'Not written yet';
    case 'evaluate': {
      const { gate } = inputs;
      if (state === 'accepted') return `Holdout ${percent(gate.score ?? 0)} passes`;
      if (state === 'running') return 'Running';
      if (state === 'warn') {
        return gate.score !== null && gate.score < gate.threshold
          ? `Holdout ${percent(gate.score)}, below ${percent(gate.threshold)}`
          : 'Re-run holdout';
      }
      return 'Not run on holdout yet';
    }
    case 'revise':
      if (state === 'running') return 'Running';
      if (state === 'proposed') return 'Needs your decision';
      if (state === 'accepted') return 'Applied';
      return ctx.openFeedback > 0 ? `${ctx.openFeedback} open` : 'No feedback';
    case 'publish':
      return state === 'ready' ? `Ready to publish v${inputs.draft}` : 'Locked by the gate';
    default:
      if (state === 'stale') return staleCause(inputs.stages, stage);
      if (stage === 'references' && state === 'accepted') return 'Verified';
      return DRAFTED[state] ?? 'Not started';
  }
}

/** Every tab's state and status text, in `OVERVIEW_TABS` order (the rail and the map). */
export function overviewItems(ctx: StatusContext): OverviewItem[] {
  const entries = overviewStates(ctx.inputs);
  const { draft, published } = ctx.inputs;
  const runs = runsState(ctx.runs);
  const runsText =
    runs === 'running'
      ? `${ctx.runs.unfinished} running`
      : runs === 'warn'
        ? `${ctx.runs.awaitingReview} awaiting review`
        : runs === 'accepted'
          ? `${ctx.runs.total} finished`
          : 'No runs yet';
  return [
    ...entries.map((e) => ({ stage: e.stage, state: e.state, status: statusText(e.stage, e.state, ctx) })),
    {
      stage: 'template' as const,
      state: 'none' as const,
      status: draft !== null ? `Draft v${draft}` : `v${published} published`,
    },
    { stage: 'runs' as const, state: runs, status: runsText },
  ];
}

/**
 * The Overview's Next banner: the most urgent stage (`urgency`), else what to do next
 * (`nextAction`); null with no open draft.
 */
export function overviewNext(
  inputs: OverviewInputs,
  entries: readonly OverviewEntry[] = overviewStates(inputs),
): OverviewNext | null {
  if (inputs.draft === null) return null;
  const u = urgency(inputs, entries);
  if (u) {
    const label = OVERVIEW_LABEL[u.stage];
    const { gate, samples } = inputs;
    switch (u.kind) {
      case 'stale':
        return { stage: u.stage, title: `Next: refresh ${label}`, reason: `An earlier stage changed after ${label} was accepted.` };
      case 'proposed':
        return { stage: u.stage, title: `Next: decide on ${label}`, reason: 'A proposal is waiting for your decision.' };
      case 'gate':
        return {
          stage: u.stage,
          title:
            gate.score !== null && gate.score < gate.threshold
              ? 'Next: raise the holdout score'
              : 'Next: re-run the holdout evaluation',
          reason: sentence(gate.reason),
        };
      case 'samples':
        return samples.total === 0
          ? { stage: u.stage, title: 'Next: add sample PDFs', reason: 'Upload 3–8 dev samples and a few holdout samples.' }
          : {
              stage: u.stage,
              title: 'Next: fix the failed samples',
              reason: `${samples.failed} ${samples.failed === 1 ? 'sample' : 'samples'} could not be prepared.`,
            };
      case 'brief':
        return { stage: u.stage, title: 'Next: write the brief', reason: 'Describe the document and what to extract from it.' };
      case 'pending':
        return { stage: u.stage, title: `Next: start ${label}`, reason: 'The stages before it are done.' };
    }
  }
  const action = nextAction(inputs, entries);
  if (!action || action.stage === null) return null;
  const reason =
    action.kind === 'publish'
      ? sentence(inputs.gate.reason)
      : action.kind === 'running'
        ? `${OVERVIEW_LABEL[action.stage]} is running; this page updates when it finishes.`
        : '';
  return { stage: action.stage, title: `Next: ${lowerFirst(action.label)}`, reason };
}
```

(`OverviewStage`/`OverviewState` and the PR 2 functions are already in this file. If TypeScript cannot narrow `u.kind` exhaustively, add a final `return null;` after the switch.)

Also change PR 2's `urgency` so "not started" means *the first step still to do has not started* — not "some later step has not started" (otherwise, while References runs, the banner would say "start Evaluate"). Replace its last two lines with:

```ts
  const todo = firstToDo(entries);
  return todo && todo.state === 'pending' ? { stage: todo.stage, kind: 'pending' } : null;
```

and add this row to PR 2's `describe('urgency')` table: `['a running step is not overtaken', inputs({ stages: drafted({ survey: 'accepted', outputs: 'accepted', sections: 'accepted', steps: 'accepted', references: 'running' }) }), null]`. The existing urgency rows must still pass unchanged.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project shared` → PASS. Prettier on the changed files; `npm run typecheck && npm run lint` → clean (the `GateView` interface → type change must not break `apps/api` or `apps/web`).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/evaluation.ts packages/shared/src/overview.ts packages/shared/test/overview.test.ts
git commit -m "Workbench overview: W2 schema, per-tab status text and the Next banner"
```

---

### Task 2: `GET /api/workbench/projects/:id/overview`

**Files:**
- Modify: `apps/api/src/routes/workbench.ts` — add `export` to `statusOf`, `allStages`, `gateFor`, `unsettledJob` (no other change)
- Create: `apps/api/src/routes/workbench-overview.ts`
- Modify: `apps/api/src/app.ts` (register `workbenchOverviewRoutes` with `{ prefix: '/api' }` after `workbenchBundleRoutes`)
- Test: `apps/api/test/workbench-overview.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 (`ProjectOverviewSchema`, `ProjectOverview`, `overviewItems`, `overviewNext`, `briefSaved`, `OverviewInputs`); from `routes/workbench.ts`: `projectView(app, project)`, `sampleViews(app, projectId)`, `allStages(app, projectId)`, `gateFor(app, project)`, `statusOf(proposalRecord, job)`; `WorkbenchRepo.listProposals/listIterations/listFeedback/listPublications`; `Repo.listDraftJobs/listProjectJobs`.
- Produces: route `GET /api/workbench/projects/:id/overview` → 200 `ProjectOverview` | 404 `{ error: 'project not found' }`; `projectOverview(app, project): Promise<ProjectOverview>` (exported for PR 6).

- [ ] **Step 1: Write the failing test** — `apps/api/test/workbench-overview.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { preparedTriageKey, type ProjectOverview, type SampleView } from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({ method: 'POST', url: '/api/workbench/projects', payload: { id: 'letter', name: 'Letter' } });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const overview = async () => {
    const res = await ctx.app.inject(`/api/workbench/projects/letter/overview`);
    expect(res.statusCode).toBe(200);
    return res.json<ProjectOverview>();
  };
  const item = async (stage: string) => (await overview()).stages.find((s) => s.stage === stage)!;
  const addSample = async (n: number, prepared: boolean) => {
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role: 'dev' }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json<SampleView>();
    if (prepared) {
      const prep = ctx.repo.jobs.get(s.prepareJobId!)!;
      ctx.repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
      const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
      await ctx.store.put('runs', preparedTriageKey(s.sha256), Buffer.from(JSON.stringify(triage)), 'application/json');
    }
    return s;
  };
  return { ...ctx, overview, item, addSample };
}

describe('GET /api/workbench/projects/:id/overview', () => {
  it('is 404 for an unknown project', async () => {
    const { app } = await testApp();
    const res = await app.inject('/api/workbench/projects/nope/overview');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project not found' });
  });

  it('describes a new project: no samples, no brief, nothing run', async () => {
    const p = await project();
    const o = await p.overview();
    expect(o.project.project.id).toBe('letter');
    expect(o.project.draft).toBe(1);
    expect(o.stages.map((s) => s.stage)).toEqual([
      'samples', 'brief', 'survey', 'outputs', 'sections', 'steps', 'references', 'evaluate', 'revise', 'publish', 'template', 'runs',
    ]);
    expect(o.stages[0]).toEqual({ stage: 'samples', state: 'warn', status: 'No samples yet' });
    expect(o.stages[1]).toEqual({ stage: 'brief', state: 'warn', status: 'Not written yet' });
    expect(o.stages.find((s) => s.stage === 'publish')).toEqual({ stage: 'publish', state: 'locked', status: 'Locked by the gate' });
    expect(o.stages.find((s) => s.stage === 'template')).toEqual({ stage: 'template', state: 'none', status: 'Draft v1' });
    expect(o.next).toEqual({ stage: 'samples', title: 'Next: add sample PDFs', reason: 'Upload 3–8 dev samples and a few holdout samples.' });
    expect(o.gate.passes).toBe(false);
  });

  it('follows sample preparation and the brief', async () => {
    const p = await p0();
    async function p0() {
      return project();
    }
    await p.addSample(1, false);
    expect(await p.item('samples')).toEqual({ stage: 'samples', state: 'running', status: 'Preparing 1 of 1' });
    await p.addSample(2, true);
    expect((await p.item('samples')).status).toBe('Preparing 1 of 2');
    await p.app.inject({ method: 'PUT', url: '/api/workbench/projects/letter/brief', payload: { purpose: 'Letters to customers' } });
    expect(await p.item('brief')).toEqual({ stage: 'brief', state: 'accepted', status: 'Saved v1' });
  });

  it('shows a skipped stage', async () => {
    const p = await project();
    const res = await p.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/survey/skip' });
    expect(res.statusCode).toBeLessThan(300);
    expect(await p.item('survey')).toEqual({ stage: 'survey', state: 'skipped', status: 'Skipped' });
  });

  it('counts test runs by status', async () => {
    const p = await project();
    const s = await p.addSample(1, true);
    const run = await p.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/test-runs`, payload: { sampleIds: [s.id] } });
    expect(run.statusCode).toBeLessThan(300);
    expect((await p.item('runs')).state).toBe('running');
    for (const job of p.repo.jobs.values()) {
      if (job.task === 'process') p.repo.jobs.set(job.id, { ...job, status: 'awaiting_review' });
    }
    expect(await p.item('runs')).toEqual({ stage: 'runs', state: 'warn', status: '1 awaiting review' });
  });

  it('ignores a revise accepted before the latest publication', async () => {
    const p = await project();
    const job = await p.repo.createDraftJob?.({ projectId: 'letter', params: {} } as never);
    void job;
    // Seed directly: an accepted revise proposal, then a publication after it.
    const proposal = await p.workbench.createProposal({ projectId: 'letter', stage: 'revise', briefVersion: null } as never);
    await p.workbench.decideProposal('letter', proposal.id, 'accepted', [0] as never);
    expect((await p.item('revise')).state).toBe('accepted');
    await p.workbench.recordPublication({
      projectId: 'letter',
      version: 1,
      iterationId: null,
      score: null,
      threshold: 0.9,
      overrideReason: 'test',
      publishedBy: null,
    });
    expect((await p.item('revise')).state).toBe('pending');
  });
});
```

The last test seeds a proposal and a publication directly through `ctx.workbench`; **before writing it, read** `NewProposal`, `decideProposal` and `NewPublication` in `apps/api/src/workbench/repo.ts` and `createDraftJob`/`createFinishedDraftJob` in `apps/api/src/repositories/types.ts`, and replace the `as never` placeholders with correctly typed calls (a proposal needs its draft job: create it with `ctx.repo.createFinishedDraftJob` or the repo's draft-job creator, as the existing `apps/api/test/workbench-revise.test.ts` does — copy that file's seeding helper). Delete the `createDraftJob?.` line. Likewise copy the exact test-run start body (`POST /api/workbench/projects/:id/test-runs`) and brief save route/verb from `apps/api/test/workbench-runs.test.ts` and `apps/api/test/workbench.test.ts`, and remove the `p0` indirection. The assertions stay as written.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project api apps/api/test/workbench-overview.test.ts`
Expected: FAIL — 404 for every overview request (route missing).

- [ ] **Step 3: Implement** `apps/api/src/routes/workbench-overview.ts`:

```ts
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ProjectOverviewSchema,
  briefSaved,
  overviewItems,
  overviewNext,
  type OverviewInputs,
  type ProjectOverview,
  type WorkbenchProject,
} from '@ih/shared';
import { error, md, res } from '../openapi/zod.js';
import { allStages, gateFor, projectView, sampleViews, statusOf } from './workbench.js';

const Params = z.object({ id: z.string() });

/**
 * Everything the project page's rail, header and Overview tab show, in one call (handoff W2).
 * Revise counts only proposals made since the latest publication: an older one answered an
 * earlier version.
 */
export async function projectOverview(
  app: FastifyInstance,
  project: WorkbenchProject,
): Promise<ProjectOverview> {
  const { workbench, repo } = app.deps;
  const id = project.id;
  const [view, samples, stages, gate, proposals, draftJobs, iterations, jobs, feedback, publications] =
    await Promise.all([
      projectView(app, project),
      sampleViews(app, id),
      allStages(app, id),
      gateFor(app, project),
      workbench.listProposals(id),
      repo.listDraftJobs(id),
      workbench.listIterations(id),
      repo.listProjectJobs(id),
      workbench.listFeedback(id),
      workbench.listPublications(id),
    ]);
  const since = publications.map((p) => p.publishedAt).sort().at(-1) ?? '';
  const draftJob = new Map(draftJobs.map((j) => [j.id, j]));
  const revise = proposals
    .filter((p) => p.stage === 'revise' && p.createdAt > since)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const active = (jobId: string) => {
    const status = jobById.get(jobId)?.status;
    return status === 'queued' || status === 'running';
  };
  const runs = jobs.filter((j) => j.task !== 'prepare');
  const inputs: OverviewInputs = {
    draft: view.draft,
    published: view.published,
    briefSaved: briefSaved(view.brief),
    samples: {
      total: samples.length,
      preparing: samples.filter((s) => s.view.state === 'preparing').length,
      failed: samples.filter((s) => s.view.state === 'failed').length,
    },
    stages,
    revise: revise ? statusOf(revise, draftJob.get(revise.id) ?? null) : null,
    evaluation: {
      running:
        view.draft !== null &&
        iterations.some((i) => i.templateVersion === view.draft && i.jobIds.some(active)),
    },
    gate: { threshold: gate.threshold, iterationId: gate.iterationId, score: gate.score, passes: gate.passes, reason: gate.reason },
  };
  return {
    project: view,
    stages: overviewItems({
      inputs,
      briefVersion: view.brief?.version ?? null,
      runs: {
        total: runs.length,
        unfinished: runs.filter((j) => j.status === 'queued' || j.status === 'running').length,
        awaitingReview: runs.filter((j) => j.status === 'awaiting_review').length,
      },
      openFeedback: feedback.filter((f) => f.resolvedBy === null).length,
    }),
    next: overviewNext(inputs),
    gate: inputs.gate,
  };
}

/** GET /api/workbench/projects/:id/overview (Workbench redesign, W2). */
export const workbenchOverviewRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: z.infer<typeof Params> }>(
    '/workbench/projects/:id/overview',
    {
      schema: {
        tags: ['Projects & data policy'],
        operationId: 'getProjectOverview',
        summary: "Get a project's overview",
        description: md`
          Everything the project page shows around its tabs, in one call: the project, each
          tab's state and status text (the ten stages, then Template and Test runs), the most
          urgent next step, and the publish gate. Poll it while any stage is running.
        `,
        params: Params,
        response: {
          200: res('The overview.', ProjectOverviewSchema),
          404: error('`project not found`.'),
        },
      },
    },
    async (req, reply) => {
      const project = await app.deps.workbench.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      return projectOverview(app, project);
    },
  );
};
```

Match the existing route files: if `routes/workbench.ts` defines `ProjectIdParams` and `PROJECT_NOT_FOUND` for docs, export and reuse them instead of the local `Params`/`error(...)`. If `sampleViews` returns `{ record, view }` objects (it does today), the `s.view.state` reads above are right. Register the plugin in `apps/api/src/app.ts`. Check `FeedbackItem` in the repo layer uses `resolvedBy` (shared type does).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project api apps/api/test/workbench-overview.test.ts apps/api/test/openapi.test.ts apps/api/test/access.test.ts` → PASS (the OpenAPI conformance check validates every overview response against `ProjectOverviewSchema`; the access sweep covers the new route).
Run: `npm run openapi` to regenerate `docs/openapi.json`; re-run `npx vitest run --project api apps/api/test/openapi.test.ts` → PASS.
Run: `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/src/routes/workbench-overview.ts apps/api/src/app.ts apps/api/test/workbench-overview.test.ts docs/openapi.json
git commit -m "Workbench API: GET /projects/:id/overview (W2) for the rail, header and Overview"
```

---

### Task 3: Web client, fake and router

**Files:**
- Modify: `apps/web/src/api/client.ts` (Api port + `httpApi`)
- Modify: `apps/web/test/fake-api.ts` (default + `projectOverview()` fixture)
- Modify: `apps/web/src/router.ts`
- Test: `apps/web/test/client.test.ts`, `apps/web/test/router.test.ts`

**Interfaces:**
- Consumes: `ProjectOverview`, `OVERVIEW_TABS` from `@ih/shared`.
- Produces: `Api.getProjectOverview(projectId: string): Promise<ProjectOverview>`; `projectOverview(overrides?: Partial<ProjectOverview>): ProjectOverview` in `fake-api.ts` (12 pending/none items with plausible status text, `next: null`, `gate: gateView()`, `project: projectView()`), and `fakeApi()` defaults `getProjectOverview` to `vi.fn(async () => projectOverview())`; `PROJECT_TABS` starts with `'overview'`; `parseHash('#/workbench/x')` → tab `'overview'`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/router.test.ts` — add:

```ts
  it('opens a project on its Overview tab', () => {
    expect(parseHash('#/workbench/letter')).toEqual({ name: 'project', projectId: 'letter', tab: 'overview' });
    expect(parseHash('#/workbench/letter/overview')).toEqual({ name: 'project', projectId: 'letter', tab: 'overview' });
    expect(parseHash('#/workbench/letter/nonsense')).toEqual({ name: 'project', projectId: 'letter', tab: 'overview' });
    expect(PROJECT_TABS[0]).toBe('overview');
  });
```

(and update any existing assertion that expected `'samples'` as the default tab — that default changed by design.)

`apps/web/test/client.test.ts` — add, following the file's existing fetch-stub pattern for `getPublishGate`:

```ts
  it('reads a project overview', async () => {
    // stub fetch to return { project: …, stages: [], next: null, gate: … } as the file does for other GETs
    // then:
    // expect(await httpApi.getProjectOverview('letter')).toEqual(body);
    // expect(fetch).toHaveBeenCalledWith('/api/workbench/projects/letter/overview', expect.anything());
  });
```

Write it concretely by copying the `getPublishGate` test in that file and changing the URL, method name and body.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/web/test/router.test.ts apps/web/test/client.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`router.ts`: `PROJECT_TABS = ['overview', 'samples', 'brief', 'survey', 'outputs', 'sections', 'steps', 'references', 'evaluate', 'revise', 'template', 'runs'] as const;` and in `parseHash` the fallback tab becomes `'overview'`. Update the doc comment (`#/workbench/<id>[/<tab>]`, Overview by default).

`client.ts`: in the `Api` interface next to `getPublishGate`:

```ts
  /** Rail, header and Overview tab in one call (Workbench redesign W2). */
  getProjectOverview(projectId: string): Promise<ProjectOverview>;
```

and in `httpApi`: `getProjectOverview: (id) => apiFetch(`${base}/workbench/projects/${id}/overview`).then(json<ProjectOverview>),`

`fake-api.ts`: add the `projectOverview` fixture (import `OVERVIEW_TABS`, `type ProjectOverview`):

```ts
export function projectOverview(overrides: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    project: projectView(),
    stages: OVERVIEW_TABS.map((stage) => ({
      stage,
      state: stage === 'template' ? ('none' as const) : ('pending' as const),
      status: stage === 'template' ? 'Draft v1' : 'Not started',
    })),
    next: null,
    gate: gateView(),
    ...overrides,
  };
}
```

and the default `getProjectOverview: vi.fn(async () => projectOverview()),` in `fakeApi()`.

- [ ] **Step 4: Run** `npx vitest run --project web` → PASS (fix any test that relied on Samples being the default tab by passing `tab="samples"` explicitly — say so in the report), `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/router.ts apps/web/test/fake-api.ts apps/web/test/router.test.ts apps/web/test/client.test.ts
git commit -m "Workbench web: project overview client call; Overview is the default tab"
```

---

### Task 4: App nav collapses to icons on project pages

**Files:**
- Modify: `apps/web/src/shell/AppShell.tsx` (`NavLink` + `<nav>`)
- Modify: `apps/web/src/styles.css` (append compact rules after the `.side-nav` block)
- Test: `apps/web/test/AppShell.test.tsx`

**Interfaces:**
- Produces: `<nav className="side-nav compact">` when `route.name === 'project'`; each link then has `aria-label={label}` and `title={label}`; labels and the Admin heading hidden by CSS.

- [ ] **Step 1: Write the failing test** — add to `apps/web/test/AppShell.test.tsx`:

```tsx
  it('collapses the main nav to labelled icons on a project page only', async () => {
    window.location.hash = '#/workbench/letter';
    const api = fakeApi({
      me: vi.fn(async () => ({ role: 'admin' as const, label: 'Ken', expiresAt: null })),
      getProject: vi.fn(async () => projectView()),
    });
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav).toHaveClass('compact');
    for (const name of ['Jobs', 'Results', 'Document types', 'Workbench', 'Access']) {
      const link = within(nav).getByRole('link', { name });
      expect(link).toHaveAttribute('title', name);
    }
    window.location.hash = '#/templates';
    await waitFor(() => expect(nav).not.toHaveClass('compact'));
    expect(within(nav).getByRole('link', { name: 'Document types' })).not.toHaveAttribute('title');
  });
```

(import `projectView` from `./fake-api.js` and `waitFor` from Testing Library if missing.)

- [ ] **Step 2: Run** `npx vitest run apps/web/test/AppShell.test.tsx` → FAIL (no `compact` class).

- [ ] **Step 3: Implement**

`AppShell.tsx`: give `NavLink` a `compact: boolean` prop; when compact render `<a href aria-current aria-label={label} title={label}>`; otherwise unchanged. In `AppShell`, `const compact = route.name === 'project';`, pass it to every `NavLink`, and `<nav className={compact ? 'side-nav compact' : 'side-nav'} aria-label="Main">`. The API docs foot link gets `aria-label="API docs (opens in a new tab)"` and `title="API docs"` when compact.

`styles.css`, after the `.nav-heading` rule:

```css
/* Project pages: icons only, to make room for the project's own step rail (Workbench redesign). */
.side-nav.compact {
  flex: 0 0 68px;
  padding: 20px 10px;
}
.side-nav.compact a {
  position: relative;
  justify-content: center;
  padding: 0;
}
.side-nav.compact .nav-label,
.side-nav.compact .nav-heading,
.side-nav.compact .nav-foot > svg:last-of-type {
  display: none;
}
.side-nav.compact .nav-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  font-size: var(--ih-text-xs);
}
```

Check the existing mobile rules for `.side-nav` (`@media (max-width: 640px)`) still apply sensibly to `.compact` (on phones the nav already stacks); if they set a width, scope the compact rules with `@media (min-width: 641px)`.

- [ ] **Step 4: Run** `npx vitest run apps/web/test/AppShell.test.tsx` → PASS; `npx vitest run --project web`; lint/typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/AppShell.tsx apps/web/src/styles.css apps/web/test/AppShell.test.tsx
git commit -m "Workbench web: the main nav collapses to labelled icons on project pages"
```

---

### Task 5: `ProjectRail` and `ProjectHeader`

**Files:**
- Modify: `apps/web/src/ui/Icon.tsx` (add tab icons)
- Create: `apps/web/src/workbench/ProjectRail.tsx`, `apps/web/src/workbench/ProjectHeader.tsx`
- Modify: `apps/web/src/styles/stages.css` (rail + header styles)
- Test: `apps/web/test/ProjectRail.test.tsx`, `apps/web/test/ProjectHeader.test.tsx` (create)

**Interfaces:**
- Consumes: `OverviewItem`, `OVERVIEW_TAB_LABEL`, `ProjectView`, `GateView` (`@ih/shared`); `ProjectTab` (`router.ts`); `StageStatusIcon`, `StageLegend` (PR 2).
- Produces:
  - `ProjectRail({ projectId, tab, items, onNavigate })` — `items: OverviewItem[] | null` (null while loading: icons absent, links present).
  - `ProjectHeader({ view, gate, role, onTogglePolicy })`.
  - `TAB_ICON: Record<ProjectTab, IconName>`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/ProjectRail.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectRail } from '../src/workbench/ProjectRail.js';
import { projectOverview } from './fake-api.js';

const items = projectOverview().stages.map((s) =>
  s.stage === 'sections'
    ? { ...s, state: 'stale' as const, status: 'Stale — Outputs changed after it was accepted' }
    : s.stage === 'samples'
      ? { ...s, state: 'accepted' as const, status: 'Ready' }
      : s,
);

describe('ProjectRail', () => {
  it('groups the tabs under their phase headings', () => {
    render(<ProjectRail projectId="letter" tab="overview" items={items} onNavigate={vi.fn()} />);
    const rail = screen.getByRole('navigation', { name: 'Project steps' });
    expect(within(rail).getAllByRole('heading').map((h) => h.textContent)).toEqual([
      'Prepare',
      'Draft with the model',
      'Verify',
      'By hand',
    ]);
    expect(within(rail).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(
      ['overview', 'samples', 'brief', 'survey', 'outputs', 'sections', 'steps', 'references', 'evaluate', 'revise', 'template', 'runs'].map(
        (t) => `#/workbench/letter/${t}`,
      ),
    );
  });

  it('names each tab with its full status and marks the current one', () => {
    render(<ProjectRail projectId="letter" tab="sections" items={items} onNavigate={vi.fn()} />);
    const sections = screen.getByRole('link', { name: 'Sections: Stale — Outputs changed after it was accepted' });
    expect(sections).toHaveAttribute('aria-current', 'page');
    expect(sections).toHaveAttribute('title', 'Sections: Stale — Outputs changed after it was accepted');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Template' })).toBeInTheDocument();
    expect(sections.querySelector('svg[data-state="stale"]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows the legend', () => {
    render(<ProjectRail projectId="letter" tab="overview" items={items} onNavigate={vi.fn()} />);
    expect(screen.getByRole('list', { name: 'Status legend' })).toBeInTheDocument();
  });

  it('works before the overview has loaded', () => {
    render(<ProjectRail projectId="letter" tab="brief" items={null} onNavigate={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Brief' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers a step picker for small screens', async () => {
    const onNavigate = vi.fn();
    render(<ProjectRail projectId="letter" tab="overview" items={items} onNavigate={onNavigate} />);
    const picker = screen.getByRole('combobox', { name: 'Project step' });
    expect(within(picker).getByRole('option', { name: 'Sections — Stale — Outputs changed after it was accepted' })).toBeInTheDocument();
    await userEvent.selectOptions(picker, 'evaluate');
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/letter/evaluate');
  });
});
```

`apps/web/test/ProjectHeader.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectHeader } from '../src/workbench/ProjectHeader.js';
import { gateView, projectView } from './fake-api.js';

describe('ProjectHeader', () => {
  it('shows the name, versions and id with a way back', () => {
    render(<ProjectHeader view={projectView({ draft: 4, published: 3 })} gate={gateView()} role="user" onTogglePolicy={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Letter' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', '#/workbench');
    expect(screen.getByText('Developing v4')).toBeInTheDocument();
    expect(screen.getByText(/v3 published/)).toBeInTheDocument();
    expect(screen.getByText('letter')).toBeInTheDocument();
  });

  it('locks Publish until the gate passes and explains why', () => {
    render(<ProjectHeader view={projectView({ draft: 4 })} gate={gateView({ reason: 'no complete holdout evaluation of the current draft' })} role="user" onTogglePolicy={vi.fn()} />);
    const publish = screen.getByRole('link', { name: /^Publish v4/ });
    expect(publish).toHaveAttribute('href', '#/workbench/letter/evaluate');
    expect(publish).toHaveClass('locked');
    expect(publish).toHaveAttribute('title', 'no complete holdout evaluation of the current draft');
    expect(publish).toHaveAccessibleName('Publish v4 (locked: no complete holdout evaluation of the current draft)');
  });

  it('offers Publish when the gate passes', () => {
    render(<ProjectHeader view={projectView({ draft: 4 })} gate={gateView({ passes: true, score: 0.95, iterationId: 'it1', reason: 'holdout score 95% meets the threshold 90%' })} role="user" onTogglePolicy={vi.fn()} />);
    const publish = screen.getByRole('link', { name: 'Publish v4' });
    expect(publish).not.toHaveClass('locked');
  });

  it('has no Publish button without an open draft', () => {
    render(<ProjectHeader view={projectView({ draft: null, published: 3 })} gate={gateView()} role="user" onTogglePolicy={vi.fn()} />);
    expect(screen.getByText('No open draft')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Publish/ })).toBeNull();
  });

  it('shows the data policy, and the switch only to admins', async () => {
    const onTogglePolicy = vi.fn();
    const { unmount } = render(<ProjectHeader view={projectView()} gate={gateView()} role="admin" onTogglePolicy={onTogglePolicy} />);
    expect(screen.getByText('Local models only')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow external models…' }));
    expect(onTogglePolicy).toHaveBeenCalled();
    unmount();
    const external = projectView();
    external.project.dataPolicy = 'external';
    render(<ProjectHeader view={external} gate={gateView()} role="user" onTogglePolicy={vi.fn()} />);
    expect(screen.getByText('External models allowed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /models/ })).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run apps/web/test/ProjectRail.test.tsx apps/web/test/ProjectHeader.test.tsx` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`Icon.tsx` — add to `PATHS` (24×24, stroke, `currentColor`, same style as the existing entries):

```tsx
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="8.5" y="14" width="7" height="7" rx="1.5" />
      <path d="M6.5 10v2h11v-2M12 12v2" />
    </>
  ),
  brief: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  ),
  sections: <path d="M5 6h14M8 10h8M5 14h14M8 18h8" />,
  steps: (
    <>
      <rect x="3" y="4" width="7" height="6" rx="1.5" />
      <rect x="14" y="14" width="7" height="6" rx="1.5" />
      <path d="M6.5 10v4.5a2 2 0 0 0 2 2H14" />
    </>
  ),
  shieldCheck: (
    <>
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  bars: <path d="M5 20h14M8 16v-5M12 16V7M16 16v-8" />,
  message: <path d="M5 5h14v10H9l-4 4z" />,
  code: <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />,
  play: <path d="M8 5v14l11-7z" />,
  back: <path d="M15 6l-6 6 6 6" />,
  lock: (
    <>
      <rect x="6" y="11" width="12" height="9" rx="2" />
      <path d="M9 11V8a3 3 0 0 1 6 0v3" />
    </>
  ),
```

`ProjectRail.tsx`:

```tsx
import { OVERVIEW_TAB_LABEL, type OverviewItem } from '@ih/shared';
import type { ProjectTab } from '../router.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { StageLegend, StageStatusIcon } from '../ui/StageStatusIcon.js';

export const TAB_ICON: Record<ProjectTab, IconName> = {
  overview: 'overview',
  samples: 'file',
  brief: 'brief',
  survey: 'search',
  outputs: 'results',
  sections: 'sections',
  steps: 'steps',
  references: 'shieldCheck',
  evaluate: 'bars',
  revise: 'message',
  template: 'code',
  runs: 'play',
};

const GROUPS: { heading: string | null; tabs: ProjectTab[] }[] = [
  { heading: null, tabs: ['overview'] },
  { heading: 'Prepare', tabs: ['samples', 'brief'] },
  { heading: 'Draft with the model', tabs: ['survey', 'outputs', 'sections', 'steps'] },
  { heading: 'Verify', tabs: ['references', 'evaluate', 'revise'] },
  { heading: 'By hand', tabs: ['template', 'runs'] },
];

const label = (tab: ProjectTab) => (tab === 'overview' ? 'Overview' : OVERVIEW_TAB_LABEL[tab]);

/** The project's own step rail (handoff §2); a select on small screens. */
export function ProjectRail({
  projectId,
  tab,
  items,
  onNavigate,
}: {
  projectId: string;
  tab: ProjectTab;
  items: OverviewItem[] | null;
  onNavigate: (hash: string) => void;
}) {
  const item = (t: ProjectTab) => items?.find((i) => i.stage === t) ?? null;
  const name = (t: ProjectTab) => {
    const i = item(t);
    return i && i.state !== 'none' ? `${label(t)}: ${i.status}` : label(t);
  };
  const href = (t: ProjectTab) => `#/workbench/${projectId}/${t}`;
  return (
    <>
      <label className="rail-select">
        <span className="visually-hidden">Project step</span>
        <select aria-label="Project step" value={tab} onChange={(e) => onNavigate(href(e.target.value as ProjectTab))}>
          {GROUPS.flatMap((g) => g.tabs).map((t) => {
            const i = item(t);
            return (
              <option key={t} value={t}>
                {i && i.state !== 'none' ? `${label(t)} — ${i.status}` : label(t)}
              </option>
            );
          })}
        </select>
      </label>
      <nav className="project-rail" aria-label="Project steps">
        {GROUPS.map((g) => (
          <div key={g.heading ?? 'top'} className="rail-group">
            {g.heading && <h2 className="rail-heading">{g.heading}</h2>}
            {g.tabs.map((t) => {
              const i = item(t);
              return (
                <a
                  key={t}
                  href={href(t)}
                  aria-current={t === tab ? 'page' : undefined}
                  aria-label={name(t)}
                  title={name(t)}
                >
                  <Icon name={TAB_ICON[t]} size={17} />
                  <span className="rail-label">{label(t)}</span>
                  {i && <StageStatusIcon state={i.state} decorative />}
                </a>
              );
            })}
          </div>
        ))}
        <StageLegend />
      </nav>
    </>
  );
}
```

(The `<label>` already names the select; drop the `aria-label` on the select if Testing Library reports a duplicate name — the test queries the combobox by name "Project step".)

`ProjectHeader.tsx`:

```tsx
import type { GateView, ProjectView } from '@ih/shared';
import { Icon } from '../ui/Icon.js';

/** Project page header (handoff §2): name, versions, data policy and the gated Publish button. */
export function ProjectHeader({
  view,
  gate,
  role,
  onTogglePolicy,
}: {
  view: ProjectView;
  gate: GateView;
  role: 'admin' | 'user';
  onTogglePolicy: () => void;
}) {
  const { project, draft, published } = view;
  const external = project.dataPolicy === 'external';
  return (
    <header className="project-header">
      <a className="back-link" href="#/workbench">
        <Icon name="back" size={16} />
        Workbench
      </a>
      <div className="project-title">
        <h1>{project.name}</h1>
        <span className="pill tone-info">{draft !== null ? `Developing v${draft}` : 'No open draft'}</span>
        <span className="muted">
          {published !== null && `v${published} published · `}
          <code>{project.id}</code>
        </span>
      </div>
      <div className="project-actions">
        <span className={`pill ${external ? 'tone-warn' : 'tone-ok'}`}>
          <Icon name="lock" size={14} />
          {external ? 'External models allowed' : 'Local models only'}
        </span>
        {role === 'admin' && (
          <button type="button" onClick={onTogglePolicy}>
            {external ? 'Restrict to local models' : 'Allow external models…'}
          </button>
        )}
        {draft !== null && (
          <a
            className={gate.passes ? 'button' : 'button locked'}
            href={`#/workbench/${project.id}/evaluate`}
            title={gate.reason}
          >
            {!gate.passes && <Icon name="lock" size={14} />}
            Publish v{draft}
            {!gate.passes && <span className="visually-hidden"> (locked: {gate.reason})</span>}
          </a>
        )}
      </div>
    </header>
  );
}
```

(If the app has no `a.button` style, add one in `stages.css` mirroring the secondary `button` look; `.locked` = muted text, dashed border.)

Append to `apps/web/src/styles/stages.css`:

```css
.project-header {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px 16px;
  align-items: center;
  margin-bottom: 20px;
}
.back-link {
  grid-column: 1 / -1;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ih-muted);
  text-decoration: none;
  font-size: var(--ih-text-md);
}
.project-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 12px;
  min-width: 0;
}
.project-title h1 {
  margin: 0;
  font-size: var(--ih-text-h1);
}
.project-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
}
.project-actions .button.locked {
  color: var(--ih-muted);
  border-style: dashed;
}
.project-layout {
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
.project-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px;
  border: 1px solid var(--ih-border);
  border-radius: var(--ih-radius-lg);
  background: var(--ih-surface);
}
.rail-heading {
  margin: 14px 10px 6px;
  font-size: var(--ih-text-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ih-muted);
}
.project-rail a {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 0 10px;
  border-radius: var(--ih-radius-md);
  color: var(--ih-text);
  text-decoration: none;
}
.project-rail a:hover {
  background: var(--ih-surface2);
}
.project-rail a[aria-current='page'] {
  background: var(--ih-accent-soft);
  color: var(--ih-accent-soft-text);
  font-weight: 600;
}
.rail-label {
  flex: 1;
}
.project-rail .stage-legend {
  margin-top: 12px;
  padding: 12px 10px 4px;
  border-top: 1px solid var(--ih-border);
}
.rail-select {
  display: none;
}
@media (max-width: 760px) {
  .project-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .project-rail {
    display: none;
  }
  .rail-select {
    display: block;
  }
  .rail-select select {
    width: 100%;
  }
  .project-header {
    grid-template-columns: minmax(0, 1fr);
  }
  .project-actions {
    justify-content: flex-start;
  }
}
```

- [ ] **Step 4: Run** the two test files → PASS; `npx vitest run --project web`; lint/typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/Icon.tsx apps/web/src/workbench/ProjectRail.tsx apps/web/src/workbench/ProjectHeader.tsx apps/web/src/styles/stages.css apps/web/test/ProjectRail.test.tsx apps/web/test/ProjectHeader.test.tsx
git commit -m "Workbench web: project step rail with status icons, and the project header"
```

---

### Task 6: `ProjectPage` on the new shell, Overview tab, polling, docs

**Files:**
- Modify: `apps/web/src/workbench/ProjectPage.tsx`
- Create: `apps/web/src/workbench/OverviewTab.tsx`
- Modify: `apps/web/src/styles.css` (remove the `.workbench-tabs` rules), `apps/web/src/styles/stages.css` (banner + list)
- Modify: `CLAUDE.md` (Workbench bullet: one sentence on W2 and the shell), `docs/design/workbench.md` (short "Project page (redesign)" note pointing at the handoff and W2)
- Test: `apps/web/test/ProjectPage.test.tsx`, `apps/web/test/OverviewTab.test.tsx` (create)

**Interfaces:**
- Consumes: Tasks 3 and 5; `OverviewNext`, `OverviewItem`, `OVERVIEW_TAB_LABEL`.
- Produces: `OverviewTab({ projectId, overview })` — Next banner (`role="note"`) with title, reason and a link "Open <Tab>" to the banner's stage tab (Publish → Evaluate), then a list of the 12 tabs with status icon + status (PR 4 replaces the list with the map).

Behaviour of `ProjectPage` after this task:
- Loads `getProject` (as today) **and** `getProjectOverview`; `ProjectHeader` gets `view` and `overview?.gate ?? null` (render the header only once both are loaded; until then a "Loading…" line as today).
- `<div className="project-layout">` = `ProjectRail` (items from the overview) + `<div className="project-tab">` with the current tab's existing content.
- The old `listStages` call and `stages` state go; `changed()` (and brief saves, policy changes, Delete-project failures) reload the overview too.
- Polls `getProjectOverview` every `pollMs` while any item's state is `running`; stops when none is; clears the timer on unmount; refetches on `window` `focus`.
- `tab === 'overview'` renders `OverviewTab`.
- The `DeleteProject` block stays at the end of the page (unpublished types only).

- [ ] **Step 1: Write the failing tests**

`apps/web/test/OverviewTab.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverviewTab } from '../src/workbench/OverviewTab.js';
import { projectOverview } from './fake-api.js';

describe('OverviewTab', () => {
  it('leads with the next step and links to its tab', () => {
    render(
      <OverviewTab
        projectId="letter"
        overview={projectOverview({
          next: { stage: 'sections', title: 'Next: refresh Sections', reason: 'An earlier stage changed after Sections was accepted.' },
        })}
      />,
    );
    const note = screen.getByRole('note');
    expect(within(note).getByText('Next: refresh Sections')).toBeInTheDocument();
    expect(within(note).getByText('An earlier stage changed after Sections was accepted.')).toBeInTheDocument();
    expect(within(note).getByRole('link', { name: 'Open Sections' })).toHaveAttribute('href', '#/workbench/letter/sections');
  });

  it('sends Publish to the Evaluate tab', () => {
    render(<OverviewTab projectId="letter" overview={projectOverview({ next: { stage: 'publish', title: 'Next: publish v2', reason: 'Holdout score 93% meets the threshold 90%.' } })} />);
    expect(screen.getByRole('link', { name: 'Open Evaluate' })).toHaveAttribute('href', '#/workbench/letter/evaluate');
  });

  it('lists every stage with its status and has no banner when nothing is next', () => {
    render(<OverviewTab projectId="letter" overview={projectOverview()} />);
    expect(screen.queryByRole('note')).toBeNull();
    const list = screen.getByRole('list', { name: 'Stages' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(12);
    expect(within(list).getByRole('link', { name: 'Samples: Not started' })).toHaveAttribute('href', '#/workbench/letter/samples');
  });
});
```

`apps/web/test/ProjectPage.test.tsx` — update deliberately (the shell changed by design; keep each test's intent):
- `'shows the project with tab links'`: navigation name `'Project steps'`; the H1 `Letter`; "Developing v2"; Brief link href unchanged; with `tab="samples"` the Samples link is `aria-current`.
- The stage-state test (currently asserting link names like `/Outputs · stale/`): stub `getProjectOverview` with a `projectOverview()` whose `outputs` item is `{ state: 'stale', status: 'Stale — Survey changed after it was accepted' }` and `survey` `{ state: 'accepted', status: 'Accepted' }`, then assert `findByRole('link', { name: 'Outputs: Stale — Survey changed after it was accepted' })` and `'Survey: Accepted'`; `Sections` with state `pending` reads `'Sections: Not started'`. Same pattern for the References test (`'References: Needs your decision'` from a stubbed item).
- Policy button names gain the ellipsis: `'Allow external models…'`.
- New tests:

```tsx
  it('opens on the Overview tab with the next step', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      getProjectOverview: vi.fn(async () =>
        projectOverview({ next: { stage: 'samples', title: 'Next: add sample PDFs', reason: 'Upload 3–8 dev samples and a few holdout samples.' } }),
      ),
    });
    render(<ProjectPage api={api} projectId="letter" tab="overview" onNavigate={vi.fn()} pollMs={60_000} role="admin" />);
    expect(await screen.findByText('Next: add sample PDFs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  it('polls the overview only while something is running', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const running = projectOverview({
        stages: projectOverview().stages.map((s) => (s.stage === 'samples' ? { ...s, state: 'running' as const, status: 'Preparing 1 of 1' } : s)),
      });
      const getProjectOverview = vi.fn().mockResolvedValueOnce(running).mockResolvedValue(projectOverview());
      const api = fakeApi({ getProject: vi.fn(async () => projectView()), getProjectOverview });
      const { unmount } = render(<ProjectPage api={api} projectId="letter" tab="overview" onNavigate={vi.fn()} pollMs={1000} role="admin" />);
      await screen.findByRole('link', { name: 'Samples: Preparing 1 of 1' });
      await vi.advanceTimersByTimeAsync(1000);
      await screen.findByRole('link', { name: 'Samples: Not started' });
      const calls = getProjectOverview.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(getProjectOverview.mock.calls.length).toBe(calls);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
```

(import `projectOverview` from `./fake-api.js`.)

- [ ] **Step 2: Run** `npx vitest run apps/web/test/OverviewTab.test.tsx apps/web/test/ProjectPage.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`OverviewTab.tsx`:

```tsx
import { OVERVIEW_TAB_LABEL, type ProjectOverview } from '@ih/shared';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { stageStyle } from '../ui/stageStyle.js';

/** Overview tab (handoff §3): the Next banner, then every step's status. PR 4 adds the map. */
export function OverviewTab({ projectId, overview }: { projectId: string; overview: ProjectOverview }) {
  const { next } = overview;
  const target = next ? (next.stage === 'publish' ? 'evaluate' : next.stage) : null;
  const tone = next ? stageStyle(overview.stages.find((s) => s.stage === next.stage)?.state ?? 'none').tone : null;
  return (
    <div className="overview">
      {next && target && (
        <div role="note" className="next-banner" data-tone={tone ?? undefined}>
          <div>
            <strong>{next.title}</strong>
            {next.reason && <p>{next.reason}</p>}
          </div>
          <a className="button primary" href={`#/workbench/${projectId}/${target}`}>
            Open {OVERVIEW_TAB_LABEL[target]}
          </a>
        </div>
      )}
      <ul className="overview-list" aria-label="Stages">
        {overview.stages.map((s) => (
          <li key={s.stage}>
            <a href={`#/workbench/${projectId}/${s.stage === 'publish' ? 'evaluate' : s.stage}`} aria-label={`${OVERVIEW_TAB_LABEL[s.stage]}: ${s.status}`}>
              <StageStatusIcon state={s.state} decorative />
              <span>{OVERVIEW_TAB_LABEL[s.stage]}</span>
              <span className="muted">{s.status}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

(If `a.button.primary` has no style, use the app's existing primary-link pattern; check `styles.css` for `.button`.)

`ProjectPage.tsx` — restructure as described under *Behaviour* above. Sketch of the new state and effects (keep every existing tab body unchanged):

```tsx
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const loadOverview = useCallback(() => {
    api.getProjectOverview(projectId).then(setOverview, () => undefined);
  }, [api, projectId]);
  useEffect(loadOverview, [loadOverview]);
  useEffect(() => {
    window.addEventListener('focus', loadOverview);
    return () => window.removeEventListener('focus', loadOverview);
  }, [loadOverview]);
  const running = overview?.stages.some((s) => s.state === 'running') ?? false;
  useEffect(() => {
    if (!running || pollMs <= 0) return;
    const timer = setInterval(loadOverview, pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, loadOverview]);

  const changed = () => {
    loadOverview();
    load();
    setRevision((r) => r + 1);
  };
```

Render:

```tsx
  return (
    <section className="workbench project-page">
      {overview ? (
        <ProjectHeader view={view} gate={overview.gate} role={role} onTogglePolicy={() => void togglePolicy()} />
      ) : (
        <h1>{view.project.name}</h1>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="project-layout">
        <ProjectRail projectId={project.id} tab={tab} items={overview?.stages ?? null} onNavigate={onNavigate} />
        <div className="project-tab">
          {tab === 'overview' && (overview ? <OverviewTab projectId={project.id} overview={overview} /> : <p>Loading…</p>)}
          {/* …every existing tab body, unchanged… */}
        </div>
      </div>
      {published === null && <DeleteProject … />}
    </section>
  );
```

The policy toggle's confirm text and `act` stay; after `setDataPolicy` also call `loadOverview()`. Brief saves (`onSaved`, `onBriefSaved`) also call `loadOverview()`. Remove the `TAB_LABEL` map if nothing else uses it, the `stages`/`loadStages` state, and the old `<nav aria-label="Project" className="workbench-tabs">`. Remove the `.workbench-tabs` rules from `styles.css`.

Append to `stages.css`:

```css
.next-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 20px;
  padding: 14px 18px;
  margin-bottom: 20px;
  border: 1px solid var(--ih-border);
  border-radius: var(--ih-radius-lg);
  background: var(--ih-surface);
}
.next-banner p {
  margin: 4px 0 0;
  color: var(--ih-muted);
}
.overview-list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.overview-list a {
  display: grid;
  grid-template-columns: 20px 140px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--ih-border);
  border-radius: var(--ih-radius-md);
  background: var(--ih-surface);
  color: var(--ih-text);
  text-decoration: none;
}
```

Docs: `CLAUDE.md` — in the Workbench bullet, after the bundle/import paragraph's end or at the start of the bullet's UI-related part, add: "Project page (Workbench redesign, [handoff](docs/design/workbench-redesign/WORKBENCH-HANDOFF.md)): `GET /api/workbench/projects/:id/overview` (`routes/workbench-overview.ts`, `projectOverview`) returns the project, every tab's state and status text (`overviewItems`), the Next banner (`overviewNext`) and the gate in one call; the page polls it while anything runs. The app nav collapses to icons on project routes; `ProjectRail` (status icons, legend, a `<select>` below 760 px) and `ProjectHeader` (policy pill, Publish vN locked until the gate passes) frame every tab; Overview is the default tab." `docs/design/workbench.md` — add a short section "Project page (redesign)" with the same facts in two or three sentences.

- [ ] **Step 4: Run** `npx vitest run --project web` → PASS; `npm run check` → green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/ProjectPage.tsx apps/web/src/workbench/OverviewTab.tsx apps/web/src/styles.css apps/web/src/styles/stages.css apps/web/test/ProjectPage.test.tsx apps/web/test/OverviewTab.test.tsx CLAUDE.md docs/design/workbench.md
git commit -m "Workbench web: project page on the new shell, with the Overview tab and live status"
```
