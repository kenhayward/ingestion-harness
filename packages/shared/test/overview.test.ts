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

const drafted = (
  states: Partial<Record<'survey' | 'outputs' | 'sections' | 'steps' | 'references', StageState>>,
) =>
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
  stages: drafted({
    survey: 'accepted',
    outputs: 'accepted',
    sections: 'accepted',
    steps: 'accepted',
    references: 'accepted',
  }),
  revise: null,
  evaluation: { running: false },
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
    body: {
      purpose: '',
      outputs: '',
      exampleOutput: '',
      glossary: '',
      variants: '',
      rules: '',
      answers: [],
      ...body,
    },
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
    const states = overviewStates(
      inputs({ draft: null, briefSaved: false, samples: { total: 0, preparing: 0, failed: 0 } }),
    );
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
    const i = inputs({
      stages: drafted({
        survey: 'skipped',
        outputs: 'stale',
        sections: 'proposed',
        steps: 'running',
      }).slice(0, 4),
    });
    expect(
      overviewStates(i)
        .slice(2, 7)
        .map((e) => e.state),
    ).toEqual(['skipped', 'stale', 'proposed', 'running', 'pending']);
  });

  it.each([
    [{ running: false }, gate(), 'pending'],
    [{ running: false }, gate({ iterationId: 'it1', score: null }), 'warn'],
    [{ running: true }, gate(), 'running'],
    [{ running: false }, gate({ iterationId: 'it1', score: 0.86 }), 'warn'],
    [{ running: true }, gate({ iterationId: 'it1', score: 0.95, passes: true }), 'accepted'],
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
    [
      'steps proposed',
      inputs({
        stages: drafted({
          survey: 'accepted',
          outputs: 'accepted',
          sections: 'accepted',
          steps: 'proposed',
        }),
      }),
      { phase: 'draft', done: 5 },
    ],
    [
      'skipped counts as done',
      inputs({
        stages: drafted({
          survey: 'skipped',
          outputs: 'accepted',
          sections: 'accepted',
          steps: 'accepted',
        }),
      }),
      { phase: 'verify', done: 6 },
    ],
    [
      'revise never run does not hold the phase',
      inputs({
        evaluation: { running: false },
        gate: gate({ iterationId: 'it1', score: 0.95, passes: true }),
      }),
      { phase: 'verify', done: 8 },
    ],
  ] as const)('%s', (_, i, expected) => {
    expect(phaseOf(overviewStates(i), i.draft)).toEqual(expected);
  });
});

describe('nextAction', () => {
  it.each([
    [
      'no draft',
      inputs({ draft: null, published: 3 }),
      { kind: 'start_version', stage: null, label: 'Start v4' },
    ],
    [
      'never published, no draft',
      inputs({ draft: null, published: null }),
      { kind: 'start_version', stage: null, label: 'Start v1' },
    ],
    [
      'stale first',
      inputs({
        briefSaved: false,
        stages: drafted({
          survey: 'accepted',
          outputs: 'accepted',
          sections: 'stale',
          steps: 'proposed',
        }),
      }),
      { kind: 'refresh', stage: 'sections', label: 'Refresh Sections' },
    ],
    [
      'proposal',
      inputs({
        stages: drafted({
          survey: 'accepted',
          outputs: 'accepted',
          sections: 'accepted',
          steps: 'proposed',
        }),
      }),
      { kind: 'decide', stage: 'steps', label: 'Decide on Steps' },
    ],
    [
      'revise proposal',
      inputs({ revise: 'ready' }),
      { kind: 'decide', stage: 'revise', label: 'Decide on Revise' },
    ],
    [
      'brief',
      inputs({ briefSaved: false, samples: { total: 0, preparing: 0, failed: 0 } }),
      { kind: 'brief', stage: 'brief', label: 'Write the brief' },
    ],
    [
      'no samples',
      inputs({ samples: { total: 0, preparing: 0, failed: 0 } }),
      { kind: 'samples', stage: 'samples', label: 'Add samples' },
    ],
    [
      'failed samples',
      inputs({ samples: { total: 4, preparing: 0, failed: 1 } }),
      { kind: 'samples', stage: 'samples', label: 'Fix samples' },
    ],
    [
      'running',
      inputs({
        stages: drafted({
          survey: 'accepted',
          outputs: 'accepted',
          sections: 'accepted',
          steps: 'accepted',
          references: 'running',
        }),
      }),
      { kind: 'running', stage: 'references', label: 'References running' },
    ],
    [
      'gate fails',
      inputs({ gate: gate({ iterationId: 'it1', score: 0.86 }) }),
      { kind: 'below_threshold', stage: 'evaluate', label: 'Holdout below 90%' },
    ],
    [
      'gate passes',
      inputs({
        evaluation: { running: false },
        gate: gate({ iterationId: 'it1', score: 0.93, passes: true }),
      }),
      { kind: 'publish', stage: 'publish', label: 'Publish v2' },
    ],
    [
      'coverage incomplete after a holdout run',
      inputs({ gate: gate({ iterationId: 'it1', score: 0.95, passes: false }) }),
      { kind: 'below_threshold', stage: 'evaluate', label: 'Re-run holdout' },
    ],
    [
      'dev-only evaluation does not fail the gate',
      inputs(),
      { kind: 'continue', stage: 'evaluate', label: 'Start Evaluate' },
    ],
    [
      'nothing evaluated yet',
      inputs(),
      { kind: 'continue', stage: 'evaluate', label: 'Start Evaluate' },
    ],
    [
      'drafting not started',
      inputs({ stages: drafted({}) }),
      { kind: 'continue', stage: 'survey', label: 'Start Survey' },
    ],
  ] as const)('%s', (_, i, expected) => {
    expect(nextAction(i)).toEqual(expected);
  });

  it('never suggests an unrun Revise', () => {
    const done = drafted({
      survey: 'accepted',
      outputs: 'accepted',
      sections: 'accepted',
      steps: 'accepted',
      references: 'accepted',
    });
    const i = inputs({
      stages: done,
      evaluation: { running: false },
      gate: gate({ iterationId: 'it1', score: 0.9, passes: true }),
    });
    expect(nextAction(i)?.stage).toBe('publish');
  });
});

describe('urgency', () => {
  it.each([
    ['no draft', inputs({ draft: null }), null],
    [
      'stale beats everything',
      inputs({
        briefSaved: false,
        stages: drafted({
          survey: 'accepted',
          outputs: 'accepted',
          sections: 'stale',
          steps: 'proposed',
        }),
      }),
      { stage: 'sections', kind: 'stale' },
    ],
    [
      'proposal',
      inputs({
        stages: drafted({
          survey: 'accepted',
          outputs: 'accepted',
          sections: 'accepted',
          steps: 'proposed',
        }),
      }),
      { stage: 'steps', kind: 'proposed' },
    ],
    [
      'gate failing beats samples and brief',
      inputs({
        briefSaved: false,
        samples: { total: 3, preparing: 0, failed: 1 },
        gate: gate({ iterationId: 'it1', score: 0.5 }),
      }),
      { stage: 'evaluate', kind: 'gate' },
    ],
    [
      'failed samples beat the brief',
      inputs({ briefSaved: false, samples: { total: 3, preparing: 0, failed: 1 } }),
      { stage: 'samples', kind: 'samples' },
    ],
    [
      'new project: samples first',
      inputs({
        briefSaved: false,
        samples: { total: 0, preparing: 0, failed: 0 },
        stages: drafted({}),
      }),
      { stage: 'samples', kind: 'samples' },
    ],
    ['empty brief', inputs({ briefSaved: false }), { stage: 'brief', kind: 'brief' }],
    [
      'first stage not started',
      inputs({ stages: drafted({ survey: 'accepted' }) }),
      { stage: 'outputs', kind: 'pending' },
    ],
    [
      'all done, gate passes',
      inputs({
        evaluation: { running: false },
        gate: gate({ iterationId: 'it1', score: 0.95, passes: true }),
      }),
      null,
    ],
  ] as const)('%s', (_, i, expected) => {
    expect(urgency(i)).toEqual(expected);
  });

  it('agrees with nextAction on a failing holdout gate', () => {
    const i = inputs({ gate: gate({ iterationId: 'it1', score: 0.5 }) });
    expect(urgency(i)).toEqual({ stage: 'evaluate', kind: 'gate' });
    expect(nextAction(i)?.kind).toBe('below_threshold');
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
