import type { DraftProgress, DraftRun } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { draftRunView } from '../src/workbench/draft-run.js';

const T0 = Date.parse('2026-10-16T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const progress = (over: Partial<DraftProgress>, atS: number, phaseAtS = atS) => ({
  stage: 'survey' as const,
  phase: 'model' as const,
  samples: 3,
  attempt: 1,
  of: 2,
  round: 1,
  ...over,
  at: at(atS),
  phaseAt: at(phaseAtS),
});

const running = (p: DraftRun['progress']): DraftRun => ({
  status: 'running',
  since: at(0),
  progress: p,
});
const states = (v: ReturnType<typeof draftRunView>) => v.phases.map((p) => `${p.label}:${p.state}`);

describe('draftRunView (issue #151)', () => {
  it('waits for a worker while queued, counting from when it was queued', () => {
    const v = draftRunView(
      'survey',
      { status: 'queued', since: at(0), progress: null },
      T0 + 75_000,
    );
    expect(v.headline).toBe('Queued for 01:15');
    expect(states(v)).toEqual([
      'Waiting for a worker:current',
      'Reading the dev samples:pending',
      'Drafting with the model:pending',
    ]);
    expect(v.phases[0]!.elapsed).toBe('01:15');
  });

  it('reads the samples first, before the worker reports anything', () => {
    const v = draftRunView('survey', running(null), T0 + 4_000);
    expect(v.headline).toBe('Running for 00:04');
    expect(states(v)).toEqual([
      'Waiting for a worker:done',
      'Reading the dev samples:current',
      'Drafting with the model:pending',
    ]);
  });

  it('says how many samples it read and how long the model has been at it', () => {
    const v = draftRunView('survey', running(progress({}, 30)), T0 + 150_000);
    expect(v.headline).toBe('Running for 02:30');
    expect(states(v)).toEqual([
      'Waiting for a worker:done',
      'Reading the dev samples:done',
      'Drafting with the model:current',
    ]);
    expect(v.phases[1]!.detail).toBe('3 samples');
    const model = v.phases[2]!;
    expect(model.elapsed).toBe('02:00');
    expect(model.detail).toBe('This can take several minutes.');
  });

  it('says when the first reply failed the checks and it asked again', () => {
    const v = draftRunView(
      'outputs',
      running(progress({ stage: 'outputs', attempt: 2 }, 60)),
      T0 + 61_000,
    );
    expect(v.phases.at(-1)!.detail).toBe(
      'The first reply did not pass the checks: asking again (try 2 of 2).',
    );
  });

  it('counts the tokens of a reply as it streams', () => {
    const first = draftRunView('survey', running(progress({ tokens: 1300 }, 30)), T0 + 40_000);
    expect(first.phases.at(-1)!.detail).toBe('~1,300 tokens received so far.');
    const again = draftRunView(
      'survey',
      running(progress({ attempt: 2, tokens: 80 }, 30)),
      T0 + 40_000,
    );
    expect(again.phases.at(-1)!.detail).toBe(
      'The first reply did not pass the checks: asking again (try 2 of 2). ~80 tokens received so far.',
    );
  });

  it('says which tool is running on the same line as the token count', () => {
    const tool = { name: 'test_anchors', summary: 'Testing 4 anchors on 6 dev samples' };
    const testing = draftRunView(
      'sections',
      running(progress({ stage: 'sections', tokens: 1300, tool, toolCalls: 3 }, 30)),
      T0 + 40_000,
    );
    expect(testing.phases.find((p) => p.state === 'current')!.detail).toBe(
      '~1,300 tokens received so far · Testing 4 anchors on 6 dev samples.',
    );
    const between = draftRunView(
      'sections',
      running(progress({ stage: 'sections', tokens: 2100, tool: null, toolCalls: 5 }, 30)),
      T0 + 40_000,
    );
    expect(between.phases.find((p) => p.state === 'current')!.detail).toBe(
      '~2,100 tokens received so far · 5 tool calls.',
    );
    const one = draftRunView(
      'revise',
      running(progress({ stage: 'revise', tokens: null, tool: null, toolCalls: 1 }, 30)),
      T0 + 40_000,
    );
    expect(one.phases.find((p) => p.state === 'current')!.detail).toBe('1 tool call.');
    const unstreamed = draftRunView(
      'sections',
      running(progress({ stage: 'sections', tokens: null, tool, toolCalls: 1 }, 30)),
      T0 + 40_000,
    );
    expect(unstreamed.phases.find((p) => p.state === 'current')!.detail).toBe(
      'Testing 4 anchors on 6 dev samples.',
    );
    const started = draftRunView(
      'sections',
      running(progress({ stage: 'sections', tokens: null, tool: null, toolCalls: 0 }, 30)),
      T0 + 40_000,
    );
    expect(started.phases.find((p) => p.state === 'current')!.detail).toBe(
      'This can take several minutes.',
    );
  });

  it('says why a queued run waits: a paused queue, or a retry after an error', () => {
    const queued = (over: Partial<DraftRun>): DraftRun => ({
      status: 'queued',
      since: at(0),
      progress: null,
      ...over,
    });
    const waiting = (run: DraftRun) => draftRunView('survey', run, T0 + 10_000).phases[0]!.detail;
    expect(waiting(queued({}))).toBeNull();
    expect(waiting(queued({ paused: true }))).toBe(
      'The job queue is paused: this starts when an admin resumes it (Administration > Backup).',
    );
    expect(
      waiting(queued({ retry: { attempt: 2, of: 3, error: 'LLMError: openai 503: busy' } })),
    ).toBe(
      'The last try failed, so it will be tried again (try 2 of 3): LLMError: openai 503: busy',
    );
    const long = 'x'.repeat(400);
    expect(waiting(queued({ retry: { attempt: 3, of: 3, error: long } }))).toBe(
      `The last try failed, so it will be tried again (try 3 of 3): ${'x'.repeat(200)}…`,
    );
  });

  it('times the model from when the try began, not from its latest token count (issue #181)', () => {
    // The try began at 30 s; the streamed reply's token counts arrive every few seconds.
    const v = draftRunView('survey', running(progress({ tokens: 900 }, 55, 30)), T0 + 58_000);
    expect(v.phases.at(-1)!.elapsed).toBe('00:28');
  });

  it('adds the anchor check for sections, and the second round when anchors missed', () => {
    const first = draftRunView(
      'sections',
      running(progress({ stage: 'sections', phase: 'anchors', attempt: null, of: null }, 40)),
      T0 + 41_000,
    );
    expect(states(first)).toEqual([
      'Waiting for a worker:done',
      'Reading the dev samples:done',
      'Drafting with the model:done',
      'Testing the anchors on the samples:current',
    ]);
    const second = draftRunView(
      'sections',
      running(progress({ stage: 'sections', round: 2 }, 50)),
      T0 + 51_000,
    );
    expect(states(second)).toEqual([
      'Waiting for a worker:done',
      'Reading the dev samples:done',
      'Drafting with the model:done',
      'Testing the anchors on the samples:done',
      'Fixing the anchors that missed:current',
      'Testing the fixed anchors:pending',
    ]);
  });

  it('names the Pipeline stage check after the occurrences, and its second round', () => {
    const first = draftRunView(
      'steps',
      running(progress({ stage: 'steps', phase: 'anchors', attempt: null, of: null }, 40)),
      T0 + 41_000,
    );
    expect(states(first)).toEqual([
      'Waiting for a worker:done',
      'Reading the dev samples:done',
      'Drafting with the model:done',
      "Checking the steps on the samples' occurrences:current",
    ]);
    const second = draftRunView(
      'steps',
      running(progress({ stage: 'steps', round: 2 }, 50)),
      T0 + 51_000,
    );
    expect(states(second)).toEqual([
      'Waiting for a worker:done',
      'Reading the dev samples:done',
      'Drafting with the model:done',
      "Checking the steps on the samples' occurrences:done",
      'Setting occurrence filters:current',
      'Checking the filters:pending',
    ]);
  });

  it('shows the ontology suggestions step once the survey reaches it', () => {
    const v = draftRunView(
      'survey',
      running(progress({ phase: 'suggestions', attempt: null, of: null }, 90)),
      T0 + 91_000,
    );
    expect(states(v).at(-1)).toBe('Queuing ontology suggestions:current');
    expect(states(v).at(-2)).toBe('Drafting with the model:done');
  });
});
