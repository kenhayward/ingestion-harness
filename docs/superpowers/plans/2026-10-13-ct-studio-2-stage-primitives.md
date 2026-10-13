# Workbench redesign building blocks (PR 2 of 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the shared stage-status logic and the visual primitives every later Workbench redesign screen uses (rail icons, Overview map, project list), with no visible change to existing screens yet.

**Architecture:** Pure derivation lives in `packages/shared/src/overview.ts` so the API (W1 list, W2 overview, PRs 3 and 6) and the web compute the same states from the same inputs. The web gets one state → style mapping (`ui/stageStyle.ts`) that feeds `StageStatusIcon`, `StageLegend`, `ProgressStrip`, `NextAction` and (via its `fill`) the map boxes of PR 4; `PhasePanel` is the map's phase group. New colour tokens join `styles/tokens.css`; component CSS goes in a new `styles/stages.css`.

**Tech Stack:** TypeScript, React 19, Vitest + Testing Library (jsdom), plain CSS on `--ih-*` tokens.

**Spec:** `docs/design/workbench-redesign/WORKBENCH-HANDOFF.md` (§2 status icon set and tab → status mapping, §1 segment colours and next-action rules, §3 urgency and box fills, §5 "Derived client logic", §6 step 1) and `docs/design/workbench-redesign/design-tokens/tokens-workbench.css`.

## Global Constraints

- New tokens, exact values — light: `--ih-skip-bg: #EDE8FB; --ih-skip-fg: #5B3BB0; --ih-lock-bg: #FBE6F0; --ih-lock-fg: #9B1D58; --ih-flow: #0A5BB0; --ih-side: #0E7C72; --ih-band: rgba(255,255,255,0.72); --ih-band-bd: #C9D2DE;` dark (both `[data-theme='dark']` and System dark): `--ih-skip-bg: #261D44; --ih-skip-fg: #C7B8FF; --ih-lock-bg: #3D1729; --ih-lock-fg: #F7A8CC; --ih-flow: #6FB0F5; --ih-side: #3DD6C2; --ih-band: rgba(255,255,255,0.035); --ih-band-bd: #2A374A;`
- Status icons: 20×20 viewBox, circle r 8.25, stroke 2, round caps; glyphs on filled circles use `--ih-surface`. Glyph paths verbatim: check `M6 10.5l2.7 2.7L14 7.8`, ! `M10 5.6v5.2M10 14.1v.2`, ¾ arc `M10 3.6a6.4 6.4 0 1 1-6.4 6.4`, refresh `M13.6 8.2a4 4 0 1 0 .3 3.4M14 5v3.3h-3.3`, arrow `M6 10h7M10.4 7l3 3-3 3`, padlock `M7.4 9.4V8a2.6 2.6 0 0 1 5.2 0v1.4M6.6 9.4h6.8v4.8H6.6z`; pending = dashed ring `2.6 2.6`.
- One state → style mapping (`stageStyle`) feeds every icon, legend, strip segment and box fill. No component hard-codes a state colour.
- Every icon state has an accessible label; the running icon rotates except under `prefers-reduced-motion: reduce`.
- Ten overview stages in fixed order: Samples, Brief, Survey, Outputs, Sections, Steps, References, Evaluate, Revise, Publish.
- Tests first (red, then green); table-driven for the pure functions; Testing Library queries by role/label. `npm run check` green. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `config/llm-providers.yaml`; stage files by name.

## Review Focus

1. **Published type with no open draft** — every stage shows done, phase `published`, next action "Start v<published+1>", no banner (Task 1 tests).
2. **Brand-new project** (no samples, empty brief, nothing run) — Samples and Brief need you, the rest not started, next action "Write the brief", banner points at Samples (Task 1 tests).
3. **Gate never evaluated vs. evaluated and failing** — "never run" must not read as failing: Evaluate `pending` and no "Holdout below" action until a holdout score exists (Task 1 tests).
4. **Revise is optional** — a never-run Revise must not hold the phase back or become the next action (Task 1 tests).
5. **Icon rendered without a label in a labelled context** — inside a link or list row that already says the status, the icon must be hidden from assistive tech, not read twice (`decorative`, Task 2 and 3 tests).

---

### Task 1: Shared overview derivation

**Files:**
- Create: `packages/shared/src/overview.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from './overview.js';`)
- Test: `packages/shared/test/overview.test.ts` (create)

**Interfaces:**
- Consumes: `StageState`, `StageView` (`drafting.ts`), `GateView` (`evaluation.ts`), `Brief`, `ProposalStatus` (`workbench.ts`).
- Produces (all exported from `@ih/shared`):
  - `OVERVIEW_STAGES`, `type OverviewStage`, `type OverviewState = StageState | 'ready' | 'locked' | 'warn'`, `OVERVIEW_LABEL: Record<OverviewStage, string>`
  - `type OverviewPhase = 'prepare' | 'draft' | 'verify' | 'published'`
  - `type NextActionKind`, `interface NextAction { kind; stage: OverviewStage | null; label: string }`
  - `interface OverviewInputs`, `interface OverviewEntry { stage: OverviewStage; state: OverviewState }`
  - `briefSaved(brief: Brief | null): boolean`
  - `overviewStates(inputs: OverviewInputs): OverviewEntry[]` (always 10 entries, `OVERVIEW_STAGES` order)
  - `phaseOf(entries: readonly OverviewEntry[], draft: number | null): { phase: OverviewPhase; done: number }`
  - `nextAction(inputs: OverviewInputs, entries?: readonly OverviewEntry[]): NextAction | null`
  - `type UrgencyKind = 'stale' | 'proposed' | 'gate' | 'samples' | 'brief' | 'pending'`; `urgency(inputs: OverviewInputs, entries?: readonly OverviewEntry[]): { stage: OverviewStage; kind: UrgencyKind } | null`
  - `runsState(runs: { total: number; unfinished: number; awaitingReview: number }): OverviewState`

- [ ] **Step 1: Write the failing test** — `packages/shared/test/overview.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_STAGES,
  briefSaved,
  nextAction,
  overviewStates,
  phaseOf,
  runsState,
  urgency,
  type Brief,
  type GateView,
  type OverviewInputs,
  type OverviewState,
  type StageState,
} from '../src/index.js';

const gate = (over: Partial<GateView> = {}): GateView => ({
  threshold: 0.9,
  iterationId: null,
  score: null,
  passes: false,
  reason: 'no complete holdout evaluation of this draft',
  ...over,
});

const drafted = (states: Partial<Record<'survey' | 'outputs' | 'sections' | 'steps' | 'references', StageState>>) =>
  (['survey', 'outputs', 'sections', 'steps', 'references'] as const).map((stage) => ({
    stage,
    state: states[stage] ?? 'pending',
    completedAt: null,
  }));

/** A draft in progress: samples ready, brief saved, drafting done, nothing evaluated. */
const inputs = (over: Partial<OverviewInputs> = {}): OverviewInputs => ({
  draft: 2,
  published: 1,
  briefSaved: true,
  samples: { total: 6, preparing: 0, failed: 0 },
  stages: drafted({ survey: 'accepted', outputs: 'accepted', sections: 'accepted', steps: 'accepted', references: 'accepted' }),
  revise: null,
  evaluation: { running: false, complete: false },
  gate: gate(),
  ...over,
});

const stateOf = (i: OverviewInputs, stage: (typeof OVERVIEW_STAGES)[number]): OverviewState =>
  overviewStates(i).find((e) => e.stage === stage)!.state;

describe('briefSaved', () => {
  const brief = (body: Partial<Brief['body']>): Brief => ({
    projectId: 'p',
    version: 1,
    createdAt: '2026-10-13T00:00:00Z',
    body: { purpose: '', outputs: '', exampleOutput: '', glossary: '', variants: '', rules: '', answers: [], ...body },
  });
  it.each([
    [null, false],
    [brief({}), false],
    [brief({ purpose: '   ' }), false],
    [brief({ rules: 'totals add up' }), true],
    [brief({ answers: [{ question: 'q', answer: 'a' }] }), true],
  ])('%#: %o → %s', (b, saved) => {
    expect(briefSaved(b)).toBe(saved);
  });
});

describe('overviewStates', () => {
  it('lists the ten stages in order', () => {
    expect(overviewStates(inputs()).map((e) => e.stage)).toEqual([...OVERVIEW_STAGES]);
  });

  it('shows every stage done when no draft is open', () => {
    const states = overviewStates(inputs({ draft: null, briefSaved: false, samples: { total: 0, preparing: 0, failed: 0 } }));
    expect(new Set(states.map((e) => e.state))).toEqual(new Set(['accepted']));
  });

  it.each([
    [{ total: 0, preparing: 0, failed: 0 }, 'warn'],
    [{ total: 3, preparing: 1, failed: 1 }, 'warn'],
    [{ total: 3, preparing: 1, failed: 0 }, 'running'],
    [{ total: 3, preparing: 0, failed: 0 }, 'accepted'],
  ] as const)('samples %o → %s', (samples, state) => {
    expect(stateOf(inputs({ samples }), 'samples')).toBe(state);
  });

  it.each([
    [true, 'accepted'],
    [false, 'warn'],
  ] as const)('brief saved %s → %s', (saved, state) => {
    expect(stateOf(inputs({ briefSaved: saved }), 'brief')).toBe(state);
  });

  it('takes survey to references from the stage views, pending when missing', () => {
    const i = inputs({ stages: drafted({ survey: 'skipped', outputs: 'stale', sections: 'proposed', steps: 'running' }).slice(0, 4) });
    expect(overviewStates(i).slice(2, 7).map((e) => e.state)).toEqual(['skipped', 'stale', 'proposed', 'running', 'pending']);
  });

  it.each([
    [{ running: false, complete: false }, gate(), 'pending'],
    [{ running: true, complete: false }, gate(), 'running'],
    [{ running: false, complete: true }, gate({ score: 0.86 }), 'warn'],
    [{ running: true, complete: true }, gate({ score: 0.95, passes: true }), 'accepted'],
  ] as const)('evaluate %o with %o → %s', (evaluation, g, state) => {
    expect(stateOf(inputs({ evaluation, gate: g }), 'evaluate')).toBe(state);
  });

  it.each([
    [null, 'pending'],
    ['running', 'running'],
    ['ready', 'proposed'],
    ['accepted', 'accepted'],
    ['partially_accepted', 'accepted'],
    ['rejected', 'pending'],
    ['failed', 'pending'],
  ] as const)('revise %s → %s', (revise, state) => {
    expect(stateOf(inputs({ revise }), 'revise')).toBe(state);
  });

  it.each([
    [gate({ score: 0.95, passes: true }), 'ready'],
    [gate({ score: 0.5 }), 'locked'],
    [gate(), 'locked'],
  ] as const)('publish with %o → %s', (g, state) => {
    expect(stateOf(inputs({ gate: g }), 'publish')).toBe(state);
  });
});

describe('phaseOf', () => {
  it.each([
    ['published, no draft', inputs({ draft: null }), { phase: 'published', done: 10 }],
    ['brief missing', inputs({ briefSaved: false }), { phase: 'prepare', done: 6 }],
    ['steps proposed', inputs({ stages: drafted({ survey: 'accepted', outputs: 'accepted', sections: 'accepted', steps: 'proposed' }) }), { phase: 'draft', done: 5 }],
    ['skipped counts as done', inputs({ stages: drafted({ survey: 'skipped', outputs: 'accepted', sections: 'accepted', steps: 'accepted' }) }), { phase: 'verify', done: 6 }],
    ['revise never run does not hold the phase', inputs({ evaluation: { running: false, complete: true }, gate: gate({ score: 0.95, passes: true }) }), { phase: 'verify', done: 8 }],
  ] as const)('%s', (_, i, expected) => {
    expect(phaseOf(overviewStates(i), i.draft)).toEqual(expected);
  });
});

describe('nextAction', () => {
  it.each([
    ['no draft', inputs({ draft: null, published: 3 }), { kind: 'start_version', stage: null, label: 'Start v4' }],
    ['never published, no draft', inputs({ draft: null, published: null }), { kind: 'start_version', stage: null, label: 'Start v1' }],
    ['stale first', inputs({ briefSaved: false, stages: drafted({ survey: 'accepted', outputs: 'accepted', sections: 'stale', steps: 'proposed' }) }), { kind: 'refresh', stage: 'sections', label: 'Refresh Sections' }],
    ['proposal', inputs({ stages: drafted({ survey: 'accepted', outputs: 'accepted', sections: 'accepted', steps: 'proposed' }) }), { kind: 'decide', stage: 'steps', label: 'Decide on Steps' }],
    ['revise proposal', inputs({ revise: 'ready' }), { kind: 'decide', stage: 'revise', label: 'Decide on Revise' }],
    ['brief', inputs({ briefSaved: false, samples: { total: 0, preparing: 0, failed: 0 } }), { kind: 'brief', stage: 'brief', label: 'Write the brief' }],
    ['no samples', inputs({ samples: { total: 0, preparing: 0, failed: 0 } }), { kind: 'samples', stage: 'samples', label: 'Add samples' }],
    ['failed samples', inputs({ samples: { total: 4, preparing: 0, failed: 1 } }), { kind: 'samples', stage: 'samples', label: 'Fix samples' }],
    ['running', inputs({ stages: drafted({ survey: 'accepted', outputs: 'accepted', sections: 'accepted', steps: 'accepted', references: 'running' }) }), { kind: 'running', stage: 'references', label: 'References running' }],
    ['gate fails', inputs({ evaluation: { running: false, complete: true }, gate: gate({ score: 0.86 }) }), { kind: 'below_threshold', stage: 'evaluate', label: 'Holdout below 90%' }],
    ['gate passes', inputs({ evaluation: { running: false, complete: true }, gate: gate({ score: 0.93, passes: true }) }), { kind: 'publish', stage: 'publish', label: 'Publish v2' }],
    ['nothing evaluated yet', inputs(), { kind: 'continue', stage: 'evaluate', label: 'Start Evaluate' }],
    ['drafting not started', inputs({ stages: drafted({}) }), { kind: 'continue', stage: 'survey', label: 'Start Survey' }],
  ] as const)('%s', (_, i, expected) => {
    expect(nextAction(i)).toEqual(expected);
  });

  it('never suggests an unrun Revise', () => {
    const done = drafted({ survey: 'accepted', outputs: 'accepted', sections: 'accepted', steps: 'accepted', references: 'accepted' });
    const i = inputs({ stages: done, evaluation: { running: false, complete: true }, gate: gate({ score: 0.9, passes: true }) });
    expect(nextAction(i)?.stage).toBe('publish');
  });
});

describe('urgency', () => {
  it.each([
    ['no draft', inputs({ draft: null }), null],
    ['stale beats everything', inputs({ briefSaved: false, stages: drafted({ survey: 'accepted', outputs: 'accepted', sections: 'stale', steps: 'proposed' }) }), { stage: 'sections', kind: 'stale' }],
    ['proposal', inputs({ stages: drafted({ survey: 'accepted', outputs: 'accepted', sections: 'accepted', steps: 'proposed' }) }), { stage: 'steps', kind: 'proposed' }],
    ['gate failing beats samples and brief', inputs({ briefSaved: false, samples: { total: 3, preparing: 0, failed: 1 }, evaluation: { running: false, complete: true }, gate: gate({ score: 0.5 }) }), { stage: 'evaluate', kind: 'gate' }],
    ['failed samples beat the brief', inputs({ briefSaved: false, samples: { total: 3, preparing: 0, failed: 1 } }), { stage: 'samples', kind: 'samples' }],
    ['new project: samples first', inputs({ briefSaved: false, samples: { total: 0, preparing: 0, failed: 0 }, stages: drafted({}) }), { stage: 'samples', kind: 'samples' }],
    ['empty brief', inputs({ briefSaved: false }), { stage: 'brief', kind: 'brief' }],
    ['first stage not started', inputs({ stages: drafted({ survey: 'accepted' }) }), { stage: 'outputs', kind: 'pending' }],
    ['all done, gate passes', inputs({ evaluation: { running: false, complete: true }, gate: gate({ score: 0.95, passes: true }) }), null],
  ] as const)('%s', (_, i, expected) => {
    expect(urgency(i)).toEqual(expected);
  });
});

describe('runsState', () => {
  it.each([
    [{ total: 0, unfinished: 0, awaitingReview: 0 }, 'pending'],
    [{ total: 3, unfinished: 1, awaitingReview: 1 }, 'running'],
    [{ total: 3, unfinished: 0, awaitingReview: 1 }, 'warn'],
    [{ total: 3, unfinished: 0, awaitingReview: 0 }, 'accepted'],
  ] as const)('%o → %s', (runs, state) => {
    expect(runsState(runs)).toBe(state);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project shared packages/shared/test/overview.test.ts`
Expected: FAIL — `overviewStates` (and the rest) are not exported.

- [ ] **Step 3: Implement `packages/shared/src/overview.ts`**

```ts
import type { StageState, StageView } from './drafting.js';
import type { GateView } from './evaluation.js';
import type { Brief, ProposalStatus } from './workbench.js';

/**
 * The ten steps of a document type as the Workbench list and Overview map show them
 * (docs/design/workbench-redesign/WORKBENCH-HANDOFF.md). Derived, never stored.
 */
export const OVERVIEW_STAGES = [
  'samples',
  'brief',
  'survey',
  'outputs',
  'sections',
  'steps',
  'references',
  'evaluate',
  'revise',
  'publish',
] as const;
export type OverviewStage = (typeof OVERVIEW_STAGES)[number];

/** `ready`: the publish gate passes; `locked`: it does not; `warn`: needs you, without a proposal. */
export type OverviewState = StageState | 'ready' | 'locked' | 'warn';

export const OVERVIEW_LABEL: Record<OverviewStage, string> = {
  samples: 'Samples',
  brief: 'Brief',
  survey: 'Survey',
  outputs: 'Outputs',
  sections: 'Sections',
  steps: 'Steps',
  references: 'References',
  evaluate: 'Evaluate',
  revise: 'Revise',
  publish: 'Publish',
};

export type OverviewPhase = 'prepare' | 'draft' | 'verify' | 'published';

export type NextActionKind =
  | 'refresh'
  | 'decide'
  | 'brief'
  | 'samples'
  | 'running'
  | 'below_threshold'
  | 'publish'
  | 'start_version'
  | 'continue';

export interface NextAction {
  kind: NextActionKind;
  stage: OverviewStage | null;
  label: string;
}

export interface OverviewInputs {
  /** The open draft version; null when every version is published. */
  draft: number | null;
  published: number | null;
  /** See `briefSaved`. */
  briefSaved: boolean;
  /** Dev and holdout samples: all of them, those still preparing, those whose prepare failed. */
  samples: { total: number; preparing: number; failed: number };
  /** Survey, outputs, sections, steps and references, as `GET /stages` returns them. */
  stages: readonly StageView[];
  /** The newest revise proposal's status; null when revise never ran. */
  revise: ProposalStatus | null;
  /** Evaluations of the open draft (dev or holdout): one is queued or running / one finished. */
  evaluation: { running: boolean; complete: boolean };
  gate: GateView;
}

export interface OverviewEntry {
  stage: OverviewStage;
  state: OverviewState;
}

export type UrgencyKind = 'stale' | 'proposed' | 'gate' | 'samples' | 'brief' | 'pending';

const PHASE: Record<OverviewStage, Exclude<OverviewPhase, 'published'>> = {
  samples: 'prepare',
  brief: 'prepare',
  survey: 'draft',
  outputs: 'draft',
  sections: 'draft',
  steps: 'draft',
  references: 'verify',
  evaluate: 'verify',
  revise: 'verify',
  publish: 'verify',
};

const isDone = (state: OverviewState) => state === 'accepted' || state === 'skipped';

/** Revise is optional and Publish is the goal: neither is a step still to do. */
const firstToDo = (entries: readonly OverviewEntry[]) =>
  entries.find((e) => e.stage !== 'revise' && e.stage !== 'publish' && !isDone(e.state));

/** A brief counts as saved once any field or survey answer has text. */
export function briefSaved(brief: Brief | null): boolean {
  if (brief === null) return false;
  const { answers, ...text } = brief.body;
  return answers.length > 0 || Object.values(text).some((value) => value.trim() !== '');
}

function samplesState({ total, preparing, failed }: OverviewInputs['samples']): OverviewState {
  if (total === 0 || failed > 0) return 'warn';
  return preparing > 0 ? 'running' : 'accepted';
}

function reviseState(status: ProposalStatus | null): OverviewState {
  if (status === 'running') return 'running';
  if (status === 'ready') return 'proposed';
  if (status === 'accepted' || status === 'partially_accepted') return 'accepted';
  return 'pending';
}

function evaluateState({ running, complete }: OverviewInputs['evaluation'], gate: GateView) {
  if (gate.passes) return 'accepted';
  if (running) return 'running';
  return complete ? 'warn' : 'pending';
}

/** The ten stages' states; with no open draft every stage is done. */
export function overviewStates(inputs: OverviewInputs): OverviewEntry[] {
  if (inputs.draft === null) return OVERVIEW_STAGES.map((stage) => ({ stage, state: 'accepted' }));
  const drafted = (stage: OverviewStage): OverviewState =>
    inputs.stages.find((s) => s.stage === stage)?.state ?? 'pending';
  const state: Record<OverviewStage, OverviewState> = {
    samples: samplesState(inputs.samples),
    brief: inputs.briefSaved ? 'accepted' : 'warn',
    survey: drafted('survey'),
    outputs: drafted('outputs'),
    sections: drafted('sections'),
    steps: drafted('steps'),
    references: drafted('references'),
    evaluate: evaluateState(inputs.evaluation, inputs.gate),
    revise: reviseState(inputs.revise),
    publish: inputs.gate.passes ? 'ready' : 'locked',
  };
  return OVERVIEW_STAGES.map((stage) => ({ stage, state: state[stage] }));
}

/** The phase of the first stage still to do, and how many stages are accepted or skipped. */
export function phaseOf(
  entries: readonly OverviewEntry[],
  draft: number | null,
): { phase: OverviewPhase; done: number } {
  const done = entries.filter((e) => isDone(e.state)).length;
  if (draft === null) return { phase: 'published', done };
  const todo = firstToDo(entries);
  return { phase: todo ? PHASE[todo.stage] : 'verify', done };
}

/** What the person should do next (the list's Next action column); first match wins. */
export function nextAction(
  inputs: OverviewInputs,
  entries: readonly OverviewEntry[] = overviewStates(inputs),
): NextAction | null {
  if (inputs.draft === null) {
    return { kind: 'start_version', stage: null, label: `Start v${(inputs.published ?? 0) + 1}` };
  }
  const first = (state: OverviewState) => entries.find((e) => e.state === state)?.stage;
  const stale = first('stale');
  if (stale) return { kind: 'refresh', stage: stale, label: `Refresh ${OVERVIEW_LABEL[stale]}` };
  const proposed = first('proposed');
  if (proposed) {
    return { kind: 'decide', stage: proposed, label: `Decide on ${OVERVIEW_LABEL[proposed]}` };
  }
  if (!inputs.briefSaved) return { kind: 'brief', stage: 'brief', label: 'Write the brief' };
  if (inputs.samples.total === 0) return { kind: 'samples', stage: 'samples', label: 'Add samples' };
  if (inputs.samples.failed > 0) return { kind: 'samples', stage: 'samples', label: 'Fix samples' };
  const running = first('running');
  if (running) {
    return { kind: 'running', stage: running, label: `${OVERVIEW_LABEL[running]} running` };
  }
  const { gate } = inputs;
  if (gate.score !== null && !gate.passes) {
    const percent = Math.round(gate.threshold * 100);
    return { kind: 'below_threshold', stage: 'evaluate', label: `Holdout below ${percent}%` };
  }
  if (gate.passes) return { kind: 'publish', stage: 'publish', label: `Publish v${inputs.draft}` };
  const todo = firstToDo(entries);
  return todo
    ? { kind: 'continue', stage: todo.stage, label: `Start ${OVERVIEW_LABEL[todo.stage]}` }
    : null;
}

/**
 * The most urgent stage for the Overview's Next banner: stale > proposal waiting > gate failing
 * > samples missing or failed > empty brief > first stage not started.
 */
export function urgency(
  inputs: OverviewInputs,
  entries: readonly OverviewEntry[] = overviewStates(inputs),
): { stage: OverviewStage; kind: UrgencyKind } | null {
  if (inputs.draft === null) return null;
  const first = (state: OverviewState) => entries.find((e) => e.state === state)?.stage;
  const stale = first('stale');
  if (stale) return { stage: stale, kind: 'stale' };
  const proposed = first('proposed');
  if (proposed) return { stage: proposed, kind: 'proposed' };
  if (entries.find((e) => e.stage === 'evaluate')?.state === 'warn') {
    return { stage: 'evaluate', kind: 'gate' };
  }
  if (entries.find((e) => e.stage === 'samples')?.state === 'warn') {
    return { stage: 'samples', kind: 'samples' };
  }
  if (!inputs.briefSaved) return { stage: 'brief', kind: 'brief' };
  const todo = firstToDo(entries.filter((e) => e.state === 'pending'));
  return todo ? { stage: todo.stage, kind: 'pending' } : null;
}

/** The Test runs tab: any unfinished → running; any awaiting review → needs you. */
export function runsState(runs: {
  total: number;
  unfinished: number;
  awaitingReview: number;
}): OverviewState {
  if (runs.unfinished > 0) return 'running';
  if (runs.awaitingReview > 0) return 'warn';
  return runs.total > 0 ? 'accepted' : 'pending';
}
```

Note on `runsState`: an awaiting-review job is not "unfinished" for this count — callers count `queued`/`running` as unfinished and `awaiting_review` separately (PR 3 builds the inputs).

Add to `packages/shared/src/index.ts`: `export * from './overview.js';`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project shared packages/shared/test/overview.test.ts` → PASS
Run: `npx prettier --write packages/shared/src/overview.ts packages/shared/test/overview.test.ts`, then `npm run typecheck && npm run lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/overview.ts packages/shared/src/index.ts packages/shared/test/overview.test.ts
git commit -m "Workbench overview: shared stage states, phase, next action and urgency"
```

---

### Task 2: Tokens, `stageStyle`, `StageStatusIcon`, `StageLegend`

**Files:**
- Modify: `apps/web/src/styles/tokens.css` (three blocks)
- Create: `apps/web/src/styles/stages.css`
- Modify: `apps/web/src/main.tsx` (import `./styles/stages.css` after `./styles.css`)
- Create: `apps/web/src/ui/stageStyle.ts`, `apps/web/src/ui/StageStatusIcon.tsx` (exports `StageStatusIcon` and `StageLegend`)
- Test: `apps/web/test/stage-ui.test.tsx` (create)

**Interfaces:**
- Consumes: `OverviewState` from `@ih/shared` (Task 1).
- Produces:
  - `type DisplayState = OverviewState | 'none'`; `type StageTone = 'ok' | 'warn' | 'accent' | 'alert' | 'skip' | 'lock' | 'neutral'`
  - `interface StageStyle { label: string; tone: StageTone; circle: 'filled' | 'ring' | 'track' | 'dashed' | 'none'; glyph: string | null; fill: string }`
  - `stageStyle(state: DisplayState): StageStyle`; `TONE_COLOR: Record<StageTone, string>`
  - `StageStatusIcon({ state, label?, size?, decorative? })` — `null` for `none`
  - `StageLegend({ states?, label? })` — a list; default states `['accepted','proposed','running','stale','skipped','locked','pending']`

- [ ] **Step 1: Write the failing test** — `apps/web/test/stage-ui.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StageLegend, StageStatusIcon } from '../src/ui/StageStatusIcon.js';
import { stageStyle, TONE_COLOR, type DisplayState } from '../src/ui/stageStyle.js';

const STATES: DisplayState[] = [
  'accepted',
  'ready',
  'proposed',
  'warn',
  'running',
  'stale',
  'skipped',
  'pending',
  'locked',
];

describe('stageStyle', () => {
  it.each([
    ['accepted', 'Accepted', 'ok', 'filled', 'M6 10.5l2.7 2.7L14 7.8', 'var(--ih-ok-bg)'],
    ['ready', 'Ready to publish', 'ok', 'filled', 'M6 10.5l2.7 2.7L14 7.8', 'var(--ih-ok-bg)'],
    ['proposed', 'Needs you', 'warn', 'filled', 'M10 5.6v5.2M10 14.1v.2', 'var(--ih-warn-bg)'],
    ['warn', 'Needs you', 'warn', 'filled', 'M10 5.6v5.2M10 14.1v.2', 'var(--ih-warn-bg)'],
    ['running', 'Running', 'accent', 'track', 'M10 3.6a6.4 6.4 0 1 1-6.4 6.4', 'var(--ih-info-bg)'],
    ['stale', 'Stale', 'alert', 'filled', 'M13.6 8.2a4 4 0 1 0 .3 3.4M14 5v3.3h-3.3', 'var(--ih-alert-bg)'],
    ['skipped', 'Skipped', 'skip', 'ring', 'M6 10h7M10.4 7l3 3-3 3', 'var(--ih-skip-bg)'],
    ['pending', 'Not started', 'neutral', 'dashed', null, 'var(--ih-surface)'],
    ['locked', 'Locked', 'lock', 'filled', 'M7.4 9.4V8a2.6 2.6 0 0 1 5.2 0v1.4M6.6 9.4h6.8v4.8H6.6z', 'var(--ih-lock-bg)'],
    ['none', '', 'neutral', 'none', null, 'var(--ih-accent-soft)'],
  ] as const)('%s', (state, label, tone, circle, glyph, fill) => {
    expect(stageStyle(state)).toEqual({ label, tone, circle, glyph, fill });
  });

  it('colours every tone from a token', () => {
    for (const color of Object.values(TONE_COLOR)) expect(color).toMatch(/^var\(--ih-[a-z-]+\)$/);
  });
});

describe('StageStatusIcon', () => {
  it.each(STATES)('labels the %s state', (state) => {
    render(<StageStatusIcon state={state} />);
    expect(screen.getByRole('img', { name: stageStyle(state).label })).toHaveAttribute(
      'data-state',
      state,
    );
  });

  it('takes a fuller label', () => {
    render(<StageStatusIcon state="stale" label="Sections: Stale — outputs changed" />);
    expect(screen.getByRole('img', { name: 'Sections: Stale — outputs changed' })).toBeInTheDocument();
  });

  it('is hidden from assistive tech when decorative', () => {
    const { container } = render(<StageStatusIcon state="accepted" decorative />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws nothing for a tab without a status', () => {
    const { container } = render(<StageStatusIcon state="none" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('fills the circle in the tone and draws the glyph in the surface colour', () => {
    const { container } = render(<StageStatusIcon state="stale" />);
    expect(container.querySelector('circle')!.style.fill).toBe('var(--ih-alert-fg)');
    expect(container.querySelector('path')!.style.stroke).toBe('var(--ih-surface)');
  });

  it('draws a ring glyph in the tone colour and a dashed ring when not started', () => {
    const skipped = render(<StageStatusIcon state="skipped" />).container;
    expect(skipped.querySelector('circle')!.style.fill).toBe('none');
    expect(skipped.querySelector('path')!.style.stroke).toBe('var(--ih-skip-fg)');
    const pending = render(<StageStatusIcon state="pending" />).container;
    expect(pending.querySelector('circle')).toHaveAttribute('stroke-dasharray', '2.6 2.6');
    expect(pending.querySelector('path')).toBeNull();
  });

  it('spins only while running', () => {
    expect(render(<StageStatusIcon state="running" />).container.querySelector('svg')).toHaveClass('spin');
    expect(render(<StageStatusIcon state="accepted" />).container.querySelector('svg')).not.toHaveClass('spin');
  });
});

describe('StageLegend', () => {
  it('names each state once, with decorative icons', () => {
    render(<StageLegend />);
    const legend = screen.getByRole('list', { name: 'Status legend' });
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Accepted',
      'Needs you',
      'Running',
      'Stale',
      'Skipped',
      'Locked',
      'Not started',
    ]);
    expect(within(legend).queryAllByRole('img')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/test/stage-ui.test.tsx`
Expected: FAIL — `../src/ui/StageStatusIcon.js` cannot be resolved.

- [ ] **Step 3: Add the tokens** to `apps/web/src/styles/tokens.css`:

At the end of the `:root, :root[data-theme='light'] { … }` block (after `--ih-ok-fg: #17633a;`):

```css
  --ih-skip-bg: #ede8fb;
  --ih-skip-fg: #5b3bb0;
  --ih-lock-bg: #fbe6f0;
  --ih-lock-fg: #9b1d58;
  --ih-flow: #0a5bb0;
  --ih-side: #0e7c72;
  --ih-band: rgba(255, 255, 255, 0.72);
  --ih-band-bd: #c9d2de;
```

At the end of the `:root[data-theme='dark'] { … }` block AND at the end of the `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }` block:

```css
  --ih-skip-bg: #261d44;
  --ih-skip-fg: #c7b8ff;
  --ih-lock-bg: #3d1729;
  --ih-lock-fg: #f7a8cc;
  --ih-flow: #6fb0f5;
  --ih-side: #3dd6c2;
  --ih-band: rgba(255, 255, 255, 0.035);
  --ih-band-bd: #2a374a;
```

(Lower-case hex matches the file's style; the values equal the handoff's.)

- [ ] **Step 4: Implement `apps/web/src/ui/stageStyle.ts`**

```ts
import type { OverviewState } from '@ih/shared';

/** A stage state, or `none` for tabs without one (Overview, Template). */
export type DisplayState = OverviewState | 'none';
export type StageTone = 'ok' | 'warn' | 'accent' | 'alert' | 'skip' | 'lock' | 'neutral';

export interface StageStyle {
  /** Plain-words status: legends, tooltips, accessible names. */
  label: string;
  tone: StageTone;
  /** filled: tone disc + surface glyph; ring: tone outline + tone glyph; track: border ring + tone arc. */
  circle: 'filled' | 'ring' | 'track' | 'dashed' | 'none';
  glyph: string | null;
  /** Box fill on the Overview map. */
  fill: string;
}

const CHECK = 'M6 10.5l2.7 2.7L14 7.8';
const NEEDS_YOU = 'M10 5.6v5.2M10 14.1v.2';

/** The one state → style mapping (handoff §2): rail icons, map boxes, list segments, legends. */
const STYLES: Record<DisplayState, StageStyle> = {
  accepted: { label: 'Accepted', tone: 'ok', circle: 'filled', glyph: CHECK, fill: 'var(--ih-ok-bg)' },
  ready: { label: 'Ready to publish', tone: 'ok', circle: 'filled', glyph: CHECK, fill: 'var(--ih-ok-bg)' },
  proposed: { label: 'Needs you', tone: 'warn', circle: 'filled', glyph: NEEDS_YOU, fill: 'var(--ih-warn-bg)' },
  warn: { label: 'Needs you', tone: 'warn', circle: 'filled', glyph: NEEDS_YOU, fill: 'var(--ih-warn-bg)' },
  running: {
    label: 'Running',
    tone: 'accent',
    circle: 'track',
    glyph: 'M10 3.6a6.4 6.4 0 1 1-6.4 6.4',
    fill: 'var(--ih-info-bg)',
  },
  stale: {
    label: 'Stale',
    tone: 'alert',
    circle: 'filled',
    glyph: 'M13.6 8.2a4 4 0 1 0 .3 3.4M14 5v3.3h-3.3',
    fill: 'var(--ih-alert-bg)',
  },
  skipped: {
    label: 'Skipped',
    tone: 'skip',
    circle: 'ring',
    glyph: 'M6 10h7M10.4 7l3 3-3 3',
    fill: 'var(--ih-skip-bg)',
  },
  pending: { label: 'Not started', tone: 'neutral', circle: 'dashed', glyph: null, fill: 'var(--ih-surface)' },
  locked: {
    label: 'Locked',
    tone: 'lock',
    circle: 'filled',
    glyph: 'M7.4 9.4V8a2.6 2.6 0 0 1 5.2 0v1.4M6.6 9.4h6.8v4.8H6.6z',
    fill: 'var(--ih-lock-bg)',
  },
  none: { label: '', tone: 'neutral', circle: 'none', glyph: null, fill: 'var(--ih-accent-soft)' },
};

export function stageStyle(state: DisplayState): StageStyle {
  return STYLES[state];
}

export const TONE_COLOR: Record<StageTone, string> = {
  ok: 'var(--ih-ok-fg)',
  warn: 'var(--ih-warn-fg)',
  accent: 'var(--ih-accent)',
  alert: 'var(--ih-alert-fg)',
  skip: 'var(--ih-skip-fg)',
  lock: 'var(--ih-lock-fg)',
  neutral: 'var(--ih-border-strong)',
};
```

- [ ] **Step 5: Implement `apps/web/src/ui/StageStatusIcon.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { stageStyle, TONE_COLOR, type DisplayState, type StageStyle } from './stageStyle.js';

function circleStyle(style: StageStyle, color: string): CSSProperties {
  if (style.circle === 'filled') return { fill: color, stroke: color };
  if (style.circle === 'track') return { fill: 'none', stroke: 'var(--ih-border)' };
  return { fill: 'none', stroke: color };
}

/**
 * A stage's status as a 20×20 icon (handoff §2). Colours via `style`: CSS variables do not
 * resolve in SVG presentation attributes. `decorative` when nearby text already says the status.
 */
export function StageStatusIcon({
  state,
  label,
  size = 20,
  decorative = false,
}: {
  state: DisplayState;
  label?: string;
  size?: number;
  decorative?: boolean;
}) {
  const style = stageStyle(state);
  if (style.circle === 'none') return null;
  const color = TONE_COLOR[style.tone];
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': label ?? style.label };
  return (
    <svg
      className={state === 'running' ? 'stage-icon spin' : 'stage-icon'}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      focusable="false"
      data-state={state}
      {...a11y}
    >
      <circle
        cx="10"
        cy="10"
        r="8.25"
        strokeWidth={2}
        strokeDasharray={style.circle === 'dashed' ? '2.6 2.6' : undefined}
        style={circleStyle(style, color)}
      />
      {style.glyph && (
        <path
          d={style.glyph}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ stroke: style.circle === 'filled' ? 'var(--ih-surface)' : color }}
        />
      )}
    </svg>
  );
}

const LEGEND: DisplayState[] = ['accepted', 'proposed', 'running', 'stale', 'skipped', 'locked', 'pending'];

/** Icon + words for each state shown nearby (rail, list footer). */
export function StageLegend({
  states = LEGEND,
  label = 'Status legend',
}: {
  states?: DisplayState[];
  label?: string;
}) {
  return (
    <ul className="stage-legend" aria-label={label}>
      {states.map((state) => (
        <li key={state}>
          <StageStatusIcon state={state} size={14} decorative />
          {stageStyle(state).label}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: Create `apps/web/src/styles/stages.css`** and import it in `apps/web/src/main.tsx` right after `import './styles.css';`:

```css
/* Workbench stage status primitives (docs/design/workbench-redesign/WORKBENCH-HANDOFF.md §2). */
.stage-icon {
  display: inline-block;
  flex: none;
  vertical-align: middle;
}
@keyframes ih-spin {
  to {
    transform: rotate(360deg);
  }
}
.stage-icon.spin {
  animation: ih-spin 1.2s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .stage-icon.spin {
    animation: none;
  }
}
.stage-legend {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 12px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--ih-muted);
  font-size: var(--ih-text-xs);
}
.stage-legend li {
  display: flex;
  align-items: center;
  gap: 6px;
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run apps/web/test/stage-ui.test.tsx` → PASS
Run: `npx prettier --write` on the changed files, then `npm run typecheck && npm run lint` → clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/styles/tokens.css apps/web/src/styles/stages.css apps/web/src/main.tsx apps/web/src/ui/stageStyle.ts apps/web/src/ui/StageStatusIcon.tsx apps/web/test/stage-ui.test.tsx
git commit -m "Workbench UI: status tokens, one state-to-style mapping, status icon and legend"
```

---

### Task 3: `ProgressStrip`, `NextAction`, `PhasePanel`

**Files:**
- Create: `apps/web/src/ui/ProgressStrip.tsx`, `apps/web/src/ui/NextAction.tsx`, `apps/web/src/ui/PhasePanel.tsx`
- Modify: `apps/web/src/styles/stages.css` (append)
- Modify: `CLAUDE.md` (the **UI:** bullet)
- Test: `apps/web/test/stage-ui.test.tsx` (append)

**Interfaces:**
- Consumes: `OVERVIEW_LABEL`, `OverviewEntry`, `OverviewState`, `NextAction` (type), `NextActionKind` from `@ih/shared` (Task 1); `stageStyle`, `StageStatusIcon` (Task 2).
- Produces:
  - `ProgressStrip({ stages: readonly OverviewEntry[] })` — `role="img"`, name `Progress: Samples Accepted, Brief Needs you, …`; one `.seg.seg-<state>` per stage with `title="<Stage>: <label>"`.
  - `NEXT_ACTION_STATE: Record<NextActionKind, OverviewState>`; `NextAction({ action, href? })` — link when `href`, else text; decorative icon + label; `data-tone`.
  - `PhasePanel({ title, range, children, className? })` — `<section aria-label={title}>` with the label and range top-right.

- [ ] **Step 1: Write the failing tests** — append to `apps/web/test/stage-ui.test.tsx` (merge imports at the top):

```tsx
import { OVERVIEW_STAGES, type OverviewEntry } from '@ih/shared';
import { NextAction, NEXT_ACTION_STATE } from '../src/ui/NextAction.js';
import { PhasePanel } from '../src/ui/PhasePanel.js';
import { ProgressStrip } from '../src/ui/ProgressStrip.js';

const entries: OverviewEntry[] = OVERVIEW_STAGES.map((stage, i) => ({
  stage,
  state: i < 5 ? 'accepted' : i === 5 ? 'proposed' : i === 9 ? 'locked' : 'pending',
}));

describe('ProgressStrip', () => {
  it('spells out every stage in its accessible name', () => {
    render(<ProgressStrip stages={entries} />);
    expect(
      screen.getByRole('img', {
        name:
          'Progress: Samples Accepted, Brief Accepted, Survey Accepted, Outputs Accepted, ' +
          'Sections Accepted, Steps Needs you, References Not started, Evaluate Not started, ' +
          'Revise Not started, Publish Locked',
      }),
    ).toBeInTheDocument();
  });

  it('draws one titled segment per stage in the state style', () => {
    const { container } = render(<ProgressStrip stages={entries} />);
    const segments = [...container.querySelectorAll('.seg')];
    expect(segments).toHaveLength(10);
    expect(segments[5]).toHaveClass('seg-proposed');
    expect(segments[5]).toHaveAttribute('title', 'Steps: Needs you');
    expect(segments[9]).toHaveClass('seg-locked');
  });
});

describe('NextAction', () => {
  it('maps every kind to a state', () => {
    expect(NEXT_ACTION_STATE).toEqual({
      refresh: 'stale',
      decide: 'proposed',
      brief: 'warn',
      samples: 'warn',
      running: 'running',
      below_threshold: 'warn',
      publish: 'ready',
      start_version: 'pending',
      continue: 'pending',
    });
  });

  it('links to the tab and reads as its label only', () => {
    render(
      <NextAction
        action={{ kind: 'refresh', stage: 'sections', label: 'Refresh Sections' }}
        href="#/workbench/invoice/sections"
      />,
    );
    const link = screen.getByRole('link', { name: 'Refresh Sections' });
    expect(link).toHaveAttribute('href', '#/workbench/invoice/sections');
    expect(link).toHaveAttribute('data-tone', 'alert');
    expect(within(link).queryByRole('img')).toBeNull();
  });

  it('is plain text without a link', () => {
    render(<NextAction action={{ kind: 'start_version', stage: null, label: 'Start v4' }} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Start v4').closest('.next-action')).toHaveAttribute('data-tone', 'neutral');
  });
});

describe('PhasePanel', () => {
  it('is a labelled region with its stage range', () => {
    render(
      <PhasePanel title="Prepare" range="stages 1–2">
        <a href="#/x">Samples</a>
      </PhasePanel>,
    );
    const panel = screen.getByRole('region', { name: 'Prepare' });
    expect(panel).toHaveTextContent('stages 1–2');
    expect(within(panel).getByRole('link', { name: 'Samples' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/web/test/stage-ui.test.tsx`
Expected: FAIL — `../src/ui/NextAction.js` cannot be resolved.

- [ ] **Step 3: Implement**

`apps/web/src/ui/ProgressStrip.tsx`:

```tsx
import { OVERVIEW_LABEL, type OverviewEntry } from '@ih/shared';
import { stageStyle } from './stageStyle.js';

/** Ten segments, one per overview stage (handoff §1); the name spells out every stage. */
export function ProgressStrip({ stages }: { stages: readonly OverviewEntry[] }) {
  const said = (e: OverviewEntry) => `${OVERVIEW_LABEL[e.stage]} ${stageStyle(e.state).label}`;
  return (
    <span className="progress-strip" role="img" aria-label={`Progress: ${stages.map(said).join(', ')}`}>
      {stages.map((e) => (
        <span
          key={e.stage}
          className={`seg seg-${e.state}`}
          title={`${OVERVIEW_LABEL[e.stage]}: ${stageStyle(e.state).label}`}
        />
      ))}
    </span>
  );
}
```

`apps/web/src/ui/NextAction.tsx`:

```tsx
import type { NextAction as Action, NextActionKind, OverviewState } from '@ih/shared';
import { StageStatusIcon } from './StageStatusIcon.js';
import { stageStyle } from './stageStyle.js';

/** The icon and tone each next-action kind shows (handoff §1). */
export const NEXT_ACTION_STATE: Record<NextActionKind, OverviewState> = {
  refresh: 'stale',
  decide: 'proposed',
  brief: 'warn',
  samples: 'warn',
  running: 'running',
  below_threshold: 'warn',
  publish: 'ready',
  start_version: 'pending',
  continue: 'pending',
};

/** Status icon + verb phrase in the state's tone; a link to the right tab when `href` is given. */
export function NextAction({ action, href }: { action: Action; href?: string }) {
  const state = NEXT_ACTION_STATE[action.kind];
  const content = (
    <>
      <StageStatusIcon state={state} size={16} decorative />
      <span>{action.label}</span>
    </>
  );
  const tone = stageStyle(state).tone;
  return href === undefined ? (
    <span className="next-action" data-tone={tone}>
      {content}
    </span>
  ) : (
    <a className="next-action" data-tone={tone} href={href}>
      {content}
    </a>
  );
}
```

`apps/web/src/ui/PhasePanel.tsx`:

```tsx
import type { ReactNode } from 'react';

/** A phase group on the Overview map (handoff §3): label and stage range sit top-right. */
export function PhasePanel({
  title,
  range,
  className,
  children,
}: {
  title: string;
  range: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className ? `phase-panel ${className}` : 'phase-panel'} aria-label={title}>
      <header className="phase-panel-head">
        <span className="phase-panel-title">{title}</span>
        <span className="phase-panel-range">{range}</span>
      </header>
      {children}
    </section>
  );
}
```

Append to `apps/web/src/styles/stages.css`:

```css
.progress-strip {
  display: inline-flex;
  gap: 3px;
}
.progress-strip .seg {
  width: 13px;
  height: 10px;
  border-radius: 2px;
  border: 1.5px solid transparent;
}
.seg-accepted {
  background: var(--ih-ok-fg);
}
.seg-skipped {
  background: var(--ih-skip-bg);
  border-color: var(--ih-skip-fg);
}
.seg-proposed,
.seg-warn {
  background: var(--ih-warn-fg);
}
.seg-running {
  background: var(--ih-accent);
}
.seg-stale {
  background: var(--ih-alert-fg);
}
.seg-ready {
  background: var(--ih-ok-bg);
  border-color: var(--ih-ok-fg);
}
.seg-locked {
  background: var(--ih-lock-bg);
  border-color: var(--ih-lock-fg);
}
.progress-strip .seg-pending {
  background: transparent;
  border: 1px dashed var(--ih-border-strong);
}
.next-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.next-action[data-tone='ok'] {
  color: var(--ih-ok-fg);
}
.next-action[data-tone='warn'] {
  color: var(--ih-warn-fg);
}
.next-action[data-tone='accent'] {
  color: var(--ih-accent);
}
.next-action[data-tone='alert'] {
  color: var(--ih-alert-fg);
}
.next-action[data-tone='neutral'] {
  color: var(--ih-muted);
}
.phase-panel {
  position: relative;
  border-radius: 14px;
  background: var(--ih-band);
  border: 1px solid var(--ih-band-bd);
}
.phase-panel-head {
  display: flex;
  justify-content: flex-end;
  align-items: baseline;
  gap: 8px;
  padding: 10px 14px 0;
}
.phase-panel-title {
  font-size: var(--ih-text-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.phase-panel-range {
  font-size: var(--ih-text-xs);
  color: var(--ih-muted);
}
```

`CLAUDE.md`, the **UI:** bullet — before the sentence about the Workbench redesign handoff, add: "Workbench stage status: `packages/shared/src/overview.ts` derives the ten overview stages' states, phase, next action and urgency (pure, table-tested, shared by API and web); `ui/stageStyle.ts` is the one state → style mapping behind `StageStatusIcon`, `StageLegend`, `ProgressStrip`, `NextAction` and the map boxes (new tokens `--ih-skip-*`, `--ih-lock-*`, `--ih-flow`, `--ih-side`, `--ih-band*`; CSS in `styles/stages.css`)."

- [ ] **Step 4: Run the tests**

Run: `npx vitest run apps/web/test/stage-ui.test.tsx` → PASS
Run: `npx prettier --write` on the changed files; `npm run check` → green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/ProgressStrip.tsx apps/web/src/ui/NextAction.tsx apps/web/src/ui/PhasePanel.tsx apps/web/src/styles/stages.css apps/web/test/stage-ui.test.tsx CLAUDE.md
git commit -m "Workbench UI: progress strip, next action and phase panel"
```
