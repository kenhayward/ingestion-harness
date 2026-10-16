import { describe, expect, it } from 'vitest';
import {
  EMPTY_FACTS,
  OPTIONAL_STAGES,
  OVERVIEW_STAGES,
  OVERVIEW_TABS,
  ProjectOverviewSchema,
  boxMetrics,
  briefSaved,
  nextAction,
  overviewItems,
  overviewNext,
  overviewStates,
  phaseOf,
  runsState,
  urgency,
  type Brief,
  type GateView,
  type MetricFacts,
  type OverviewInputs,
  type OverviewState,
  type StatusContext,
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
      ontologies: [],
      ontologyGuidance: '',
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
        .filter((e) => ['survey', 'outputs', 'sections', 'steps', 'references'].includes(e.stage))
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
    [gate({ iterationId: 'it1', score: 0.5 }), 'ready'],
    [gate(), 'ready'],
  ] as const)('publish with %o → %s (the gate never locks it)', (g, state) => {
    expect(stateOf(inputs({ gate: g }), 'publish')).toBe(state);
  });
});

describe('phaseOf', () => {
  it.each([
    ['published, no draft', inputs({ draft: null }), { phase: 'published', done: 11 }],
    ['brief missing', inputs({ briefSaved: false }), { phase: 'prepare', done: 7 }],
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
      { phase: 'draft', done: 6 },
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
      { phase: 'verify', done: 7 },
    ],
    [
      'revise never run does not hold the phase',
      inputs({
        evaluation: { running: false },
        gate: gate({ iterationId: 'it1', score: 0.95, passes: true }),
      }),
      { phase: 'verify', done: 9 },
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
      'running beats a failing gate',
      inputs({ evaluation: { running: true }, gate: gate({ iterationId: 'it1', score: 0.5 }) }),
      { kind: 'running', stage: 'evaluate', label: 'Evaluate running' },
    ],
    [
      'nothing evaluated yet: evaluation is optional',
      inputs(),
      { kind: 'publish', stage: 'publish', label: 'Publish v2' },
    ],
    [
      'a revision applied since the last evaluation: evaluate it on dev',
      inputs({ revise: 'accepted', evaluation: { running: false, revisedSince: true } }),
      { kind: 'continue', stage: 'evaluate', label: 'Evaluate v2 on dev' },
    ],
    [
      'an evaluation of the revision running beats evaluating it again',
      inputs({ revise: 'accepted', evaluation: { running: true, revisedSince: true } }),
      { kind: 'running', stage: 'evaluate', label: 'Evaluate running' },
    ],
    [
      'no references yet: references are optional',
      inputs({
        stages: drafted({
          survey: 'accepted',
          outputs: 'accepted',
          sections: 'accepted',
          steps: 'accepted',
          references: 'pending',
        }),
      }),
      { kind: 'publish', stage: 'publish', label: 'Publish v2' },
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
      'a running step is not overtaken',
      inputs({
        stages: drafted({
          survey: 'accepted',
          outputs: 'accepted',
          sections: 'accepted',
          steps: 'accepted',
          references: 'running',
        }),
      }),
      null,
    ],
    [
      'unverified references are not urgent',
      inputs({
        stages: drafted({
          survey: 'accepted',
          outputs: 'accepted',
          sections: 'accepted',
          steps: 'accepted',
          references: 'pending',
        }),
      }),
      null,
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

const ctx = (over: Partial<StatusContext> = {}, i: OverviewInputs = inputs()): StatusContext => ({
  inputs: i,
  briefVersion: 3,
  runs: { total: 0, unfinished: 0, awaitingReview: 0 },
  openFeedback: 0,
  facts: EMPTY_FACTS,
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
    [{ total: 4, preparing: 1, failed: 0 }, 'running', '1 of 4 preparing'],
    [{ total: 4, preparing: 0, failed: 0 }, 'accepted', 'Ready'],
  ] as const)('samples %o', (samples, state, text) => {
    expect(status(ctx({}, inputs({ samples })), 'samples')).toMatchObject({
      stage: 'samples',
      state,
      status: text,
    });
  });

  it('says which brief version is saved', () => {
    expect(status(ctx(), 'brief').status).toBe('Saved v3');
    expect(status(ctx({ briefVersion: null }), 'brief').status).toBe('Saved');
    expect(status(ctx({ briefVersion: null }, inputs({ briefSaved: false })), 'brief').status).toBe(
      'Not written yet',
    );
  });

  it.each([
    ['accepted', 'Accepted'],
    ['skipped', 'Skipped'],
    ['proposed', 'Needs your decision'],
    ['running', 'Running'],
    ['pending', 'Not started'],
  ] as const)('drafting stage %s → %s', (state, text) => {
    expect(status(ctx({}, inputs({ stages: drafted({ outputs: state }) })), 'outputs').status).toBe(
      text,
    );
  });

  it('says References are verified, or optional when not started', () => {
    expect(status(ctx(), 'references').status).toBe('Verified');
    const none = inputs({
      stages: drafted({
        survey: 'accepted',
        outputs: 'accepted',
        sections: 'accepted',
        steps: 'accepted',
        references: 'pending',
      }),
    });
    expect(status(ctx({}, none), 'references').status).toBe('Optional, not started');
  });

  it('names the earlier stage that made a stage stale', () => {
    const stages = [
      { stage: 'survey' as const, state: 'accepted' as const, completedAt: '2026-10-13T09:00:00Z' },
      {
        stage: 'outputs' as const,
        state: 'accepted' as const,
        completedAt: '2026-10-13T11:00:00Z',
      },
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
    [inputs(), 'pending', 'Optional, not run on holdout yet'],
    [inputs({ evaluation: { running: true } }), 'running', 'Running'],
    [inputs({ gate: gate({ iterationId: 'it1', score: 0.86 }) }), 'warn', 'Holdout 86%, below 90%'],
    [
      inputs({ gate: gate({ iterationId: 'it1', score: 0.896 }) }),
      'warn',
      'Holdout 89.6%, below 90.0%',
    ],
    [
      inputs({ gate: gate({ iterationId: 'it1', score: 0.95, passes: false }) }),
      'warn',
      'Re-run holdout',
    ],
    [
      inputs({ gate: gate({ iterationId: 'it1', score: 0.93, passes: true }) }),
      'accepted',
      'Holdout 93% passes',
    ],
  ] as const)('evaluate %#', (i, state, text) => {
    expect(status(ctx({}, i), 'evaluate')).toMatchObject({
      stage: 'evaluate',
      state,
      status: text,
    });
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
    expect(status(ctx(), 'publish')).toMatchObject({
      stage: 'publish',
      state: 'ready',
      status: 'Ready to publish v2',
    });
    const ready = inputs({ gate: gate({ iterationId: 'it1', score: 0.93, passes: true }) });
    expect(status(ctx({}, ready), 'publish').status).toBe('Ready to publish v2');
    expect(status(ctx(), 'template')).toMatchObject({
      stage: 'template',
      state: 'none',
      status: 'Draft v2',
    });
    expect(
      status(ctx({ runs: { total: 6, unfinished: 2, awaitingReview: 1 } }), 'runs'),
    ).toMatchObject({
      stage: 'runs',
      state: 'running',
      status: '2 test runs in progress · 1 awaiting review',
    });
    expect(
      status(ctx({ runs: { total: 3, unfinished: 1, awaitingReview: 0 } }), 'runs').status,
    ).toBe('1 test run in progress');
    expect(
      status(ctx({ runs: { total: 6, unfinished: 0, awaitingReview: 1 } }), 'runs').status,
    ).toBe('1 awaiting review');
    expect(
      status(ctx({ runs: { total: 6, unfinished: 0, awaitingReview: 0 } }), 'runs').status,
    ).toBe('6 finished');
    expect(status(ctx(), 'runs').status).toBe('No runs yet');
  });

  it('does not invent a published version', () => {
    const items = overviewItems(ctx({}, inputs({ draft: null, published: null })));
    expect(items.find((x) => x.stage === 'publish')!.status).toBe('Not published');
    expect(items.find((x) => x.stage === 'template')!.status).toBe('Not published');
  });

  it('shows a fully published type as done', () => {
    const items = overviewItems(ctx({}, inputs({ draft: null, published: 3 })));
    expect(items.find((x) => x.stage === 'publish')!.status).toBe('v3 published');
    expect(items.find((x) => x.stage === 'outputs')).toMatchObject({
      stage: 'outputs',
      state: 'accepted',
      status: 'Done',
    });
    expect(items.find((x) => x.stage === 'template')!.status).toBe('v3 published');
  });
});

describe('overviewNext', () => {
  it.each([
    ['no draft', inputs({ draft: null }), null],
    [
      'stale',
      inputs({
        stages: drafted({
          survey: 'accepted',
          outputs: 'accepted',
          sections: 'stale',
          steps: 'proposed',
        }),
      }),
      {
        stage: 'sections',
        title: 'Next: refresh Sections',
        reason: 'An earlier stage changed after Sections was accepted.',
      },
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
      {
        stage: 'steps',
        title: 'Next: decide on Steps',
        reason: 'A proposal is waiting for your decision.',
      },
    ],
    [
      'gate below threshold',
      inputs({
        gate: gate({
          iterationId: 'it1',
          score: 0.5,
          reason: 'holdout score 50% is below the threshold 90%',
        }),
      }),
      {
        stage: 'evaluate',
        title: 'Next: raise the holdout score',
        reason: 'Holdout score 50% is below the threshold 90%.',
      },
    ],
    [
      'gate without a usable score',
      inputs({
        gate: gate({
          iterationId: 'it1',
          score: 0.95,
          reason: 'holdout evaluation covered 1 of 2 holdout samples',
        }),
      }),
      {
        stage: 'evaluate',
        title: 'Next: re-run the holdout evaluation',
        reason: 'Holdout evaluation covered 1 of 2 holdout samples.',
      },
    ],
    [
      'no samples',
      inputs({ samples: { total: 0, preparing: 0, failed: 0 } }),
      {
        stage: 'samples',
        title: 'Next: add sample documents',
        reason: 'Upload 3–8 dev samples and a few holdout samples.',
      },
    ],
    [
      'failed samples',
      inputs({ samples: { total: 4, preparing: 0, failed: 2 } }),
      {
        stage: 'samples',
        title: 'Next: fix the failed samples',
        reason: '2 samples could not be prepared.',
      },
    ],
    [
      'brief',
      inputs({ briefSaved: false }),
      {
        stage: 'brief',
        title: 'Next: write the brief',
        reason: 'Describe the document and what to extract from it.',
      },
    ],
    [
      'not started',
      inputs({ stages: drafted({ survey: 'accepted' }) }),
      { stage: 'outputs', title: 'Next: start Outputs', reason: 'The stages before it are done.' },
    ],
    [
      'falls back to publishing',
      inputs({
        gate: gate({
          iterationId: 'it1',
          score: 0.93,
          passes: true,
          reason: 'holdout score 93% meets the threshold 90%',
        }),
      }),
      {
        stage: 'publish',
        title: 'Next: publish v2',
        reason: 'Holdout score 93% meets the threshold 90%.',
      },
    ],
    [
      'falls back to publishing without an evaluation',
      inputs(),
      {
        stage: 'publish',
        title: 'Next: publish v2',
        reason: 'References and evaluation are optional.',
      },
    ],
    [
      'suggests evaluating a revision before publishing',
      inputs({ revise: 'partially_accepted', evaluation: { running: false, revisedSince: true } }),
      {
        stage: 'evaluate',
        title: 'Next: evaluate v2 on dev',
        reason: 'A revision was applied since the last evaluation: see whether it helped.',
      },
    ],
    [
      'falls back to a running stage',
      inputs({
        stages: drafted({
          survey: 'accepted',
          outputs: 'accepted',
          sections: 'accepted',
          steps: 'accepted',
          references: 'running',
        }),
      }),
      {
        stage: 'references',
        title: 'Waiting for References',
        reason: 'The References stage is running; this page updates when it finishes.',
      },
    ],
    [
      'falls back to samples preparing',
      inputs({ samples: { total: 2, preparing: 1, failed: 0 } }),
      {
        stage: 'samples',
        title: 'Waiting for Samples',
        reason: 'Samples are being prepared; this page updates when they finish.',
      },
    ],
    [
      'stale names the stage that changed',
      inputs({
        stages: [
          { stage: 'survey', state: 'accepted', completedAt: '2026-10-13T09:00:00Z' },
          { stage: 'outputs', state: 'accepted', completedAt: '2026-10-13T11:00:00Z' },
          { stage: 'sections', state: 'stale', completedAt: '2026-10-13T10:00:00Z' },
          { stage: 'steps', state: 'pending', completedAt: null },
        ],
      }),
      {
        stage: 'sections',
        title: 'Next: refresh Sections',
        reason: 'Outputs changed after Sections was accepted.',
      },
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
        retired: null,
      },
      stages: overviewItems(ctx({}, i)),
      next: overviewNext(i),
      gate: i.gate,
    });
    expect(parsed.success).toBe(true);
  });
});

const facts = (over: Partial<MetricFacts> = {}): MetricFacts => ({ ...EMPTY_FACTS, ...over });
const rows = (f: MetricFacts, tab: (typeof OVERVIEW_TABS)[number], i: OverviewInputs = inputs()) =>
  boxMetrics(f, i)[tab].map((m) => [m.label, m.value, m.at]);

describe('boxMetrics', () => {
  it('gives every tab exactly two rows', () => {
    const all = boxMetrics(EMPTY_FACTS, inputs());
    expect(Object.keys(all).sort()).toEqual([...OVERVIEW_TABS].sort());
    for (const tab of OVERVIEW_TABS) expect(all[tab]).toHaveLength(2);
  });

  it('shows dashes, never null or NaN, when nothing is known', () => {
    const text = JSON.stringify(boxMetrics(EMPTY_FACTS, inputs()));
    expect(text).not.toMatch(/null"|NaN|undefined/);
  });

  it.each([
    [
      'samples',
      facts({ samples: { dev: 6, holdout: 2, ocrPages: 3, pages: 41 } }),
      [
        ['Dev · holdout', '6 · 2', null],
        ['OCR pages', '3 of 41', null],
      ],
    ],
    [
      'brief',
      facts({ brief: { answers: 5, updatedAt: '2026-10-11T10:00:00Z' } }),
      [
        ['Answers', '5', null],
        ['Updated', '—', '2026-10-11T10:00:00Z'],
      ],
    ],
    [
      'template',
      facts({ template: { steps: 4, sections: 5, editedAt: '2026-10-13T09:00:00Z' } }),
      [
        ['Steps · sections', '4 · 5', null],
        ['Hand edit', '—', '2026-10-13T09:00:00Z'],
      ],
    ],
    [
      'runs',
      facts({ runs: { total: 6, awaitingReview: 1 } }),
      [
        ['Runs', '6', null],
        ['Awaiting review', '1', null],
      ],
    ],
    [
      'survey',
      facts({ survey: { answered: 3, questions: 4, fields: 9, tables: 1 } }),
      [
        ['Questions', '3 of 4 answered', null],
        ['Fields · tables', '9 · 1', null],
      ],
    ],
    [
      'survey',
      EMPTY_FACTS,
      [
        ['Questions', '—', null],
        ['Fields · tables', '—', null],
      ],
    ],
    [
      'outputs',
      facts({ outputs: { fields: 9, tables: 1, applied: 8, proposed: 9 } }),
      [
        ['Fields · tables', '9 · 1', null],
        ['Changes applied', '8 of 9', null],
      ],
    ],
    [
      'sections',
      facts({
        sections: { anchorsFound: 6, devSamples: 6 },
        template: { steps: 4, sections: 5, editedAt: null },
      }),
      [
        ['Sections', '5', null],
        ['Anchors found', '6 / 6 dev', null],
      ],
    ],
    [
      'steps',
      facts({ steps: { proposed: 4, model: 'qwen3.8-27b' } }),
      [
        ['Proposed changes', '4', null],
        ['Model', 'qwen3.8-27b', null],
      ],
    ],
    [
      'references',
      facts({ references: { devVerified: 6, devTotal: 6, holdoutVerified: 2, holdoutTotal: 2 } }),
      [
        ['Dev', '6 / 6', null],
        ['Holdout', '2 / 2', null],
      ],
    ],
    [
      'evaluate',
      facts({ evaluate: { dev: 0.91, holdout: 0.88 } }),
      [
        ['Dev score', '91%', null],
        ['Holdout score', '88%', null],
      ],
    ],
    [
      'revise',
      facts({ revise: { open: 3, lastAt: '2026-10-13T10:00:00Z' } }),
      [
        ['Feedback items', '3', null],
        ['Last revision', '—', '2026-10-13T10:00:00Z'],
      ],
    ],
    [
      'publish',
      facts({ publish: { live: 3 } }),
      [
        ['Needs holdout', '≥ 90%', null],
        ['Live version', 'v3', null],
      ],
    ],
    [
      'publish',
      EMPTY_FACTS,
      [
        ['Needs holdout', '≥ 90%', null],
        ['Live version', '—', null],
      ],
    ],
  ] as const)('%s', (tab, f, expected) => {
    expect(rows(f, tab)).toEqual(expected);
  });

  it('puts the metrics on the overview items', () => {
    const items = overviewItems(ctx({ facts: facts({ runs: { total: 6, awaitingReview: 1 } }) }));
    expect(items.find((x) => x.stage === 'runs')!.metrics).toEqual([
      { label: 'Runs', value: '6', at: null },
      { label: 'Awaiting review', value: '1', at: null },
    ]);
  });
});

describe('the mapping stage in the overview (ADR 0011)', () => {
  it.each<[string, OverviewInputs['mapping'], string, string]>([
    [
      'not used without ontologies in the brief',
      undefined,
      'skipped',
      'Not used: no vocabulary is pinned on Survey',
    ],
    [
      'not used, said so',
      { used: false, state: 'pending' },
      'skipped',
      'Not used: no vocabulary is pinned on Survey',
    ],
    [
      'not used while RDF is off, whatever is pinned',
      { used: true, rdf: false, state: 'accepted' },
      'skipped',
      'Not used: RDF is off on the Outputs tab',
    ],
    [
      'RDF off is said before a missing vocabulary',
      { used: false, rdf: false, state: 'pending' },
      'skipped',
      'Not used: RDF is off on the Outputs tab',
    ],
    [
      'optional once ontologies are chosen',
      { used: true, state: 'pending' },
      'pending',
      'Optional, not started',
    ],
    ['a proposal to decide', { used: true, state: 'proposed' }, 'proposed', 'Needs your decision'],
    ['mapped', { used: true, state: 'accepted' }, 'accepted', 'Mapped'],
    [
      'stale',
      { used: true, state: 'stale' },
      'stale',
      "Stale — the outputs or the brief's ontologies changed",
    ],
  ])('%s', (_name, mapping, state, status) => {
    const i = inputs({ mapping });
    expect(stateOf(i, 'mapping')).toBe(state);
    const item = overviewItems({
      inputs: i,
      briefVersion: 1,
      runs: { total: 0, unfinished: 0, awaitingReview: 0 },
      openFeedback: 0,
      facts: { ...EMPTY_FACTS, mapping: { mapped: 3, outputs: 5, ontologies: 2 } },
    }).find((e) => e.stage === 'mapping')!;
    expect(item.status).toBe(status);
    expect(item.metrics.map((m) => `${m.label} ${m.value}`)).toEqual([
      'Mapped outputs 3 / 5',
      'Ontologies 2',
    ]);
  });

  it('is optional: never the next step and never holding the phase', () => {
    const i = inputs({ mapping: { used: true, state: 'pending' } });
    expect(nextAction(i)?.stage).not.toBe('mapping');
    expect(OPTIONAL_STAGES).toContain('mapping');
  });

  it('asks for a refresh when stale', () => {
    const i = inputs({ mapping: { used: true, state: 'stale' } });
    expect(nextAction(i)).toMatchObject({
      kind: 'refresh',
      stage: 'mapping',
      label: 'Refresh Mapping',
    });
  });
});
