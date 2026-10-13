import { describe, expect, it } from 'vitest';
import {
  buildScorecard,
  gateHints,
  MAX_GATE_HINTS,
  type Accuracy,
  type GateHint,
  comparisonRows,
  FeedbackBodySchema,
  MAX_FIELD_DIFFS,
  PublishBodySchema,
  ThresholdBodySchema,
  publishGate,
  type GateCandidate,
  failureDiffs,
  finishedJob,
  JOB_STATUSES,
  type Comparison,
  type IterationView,
  type JobStatus,
  type SampleResult,
} from '../src/index.js';

const comparison = (
  score: number,
  fields: [string, boolean][],
  columns: Record<string, { matched: number; total: number }> = {},
): Comparison => ({
  score,
  fields: fields.map(([id, match]) => ({ id, expected: 'e', actual: match ? 'e' : 'x', match })),
  tables: Object.keys(columns).length
    ? [
        {
          id: 'items',
          expected: 1,
          actual: 1,
          matched: 0,
          missing: [],
          extra: [],
          changed: [],
          cells: 0,
          cellsTotal: 0,
          columns,
        },
      ]
    : [],
});

const sample = (over: Partial<SampleResult>): SampleResult => ({
  sampleId: 's',
  filename: 'a.pdf',
  jobId: 'j',
  status: 'succeeded',
  error: null,
  comparison: null,
  ...over,
});

describe('finishedJob', () => {
  // Every status, so a new one fails here (and in the type checker) until it is classified.
  const expected: Record<JobStatus, boolean> = {
    queued: false,
    running: false,
    succeeded: true,
    failed: true,
    needs_review: true,
    awaiting_review: true,
    rejected: true,
    cancelled: true,
  };

  it('classifies every job status', () => {
    expect(Object.keys(expected).sort()).toEqual([...JOB_STATUSES].sort());
  });

  it.each(JOB_STATUSES.map((s) => [s, expected[s]] as const))('%s → %s', (status, finished) => {
    expect(finishedJob(status)).toBe(finished);
  });

  it('treats a missing job as finished', () => {
    expect(finishedJob(null)).toBe(true);
  });
});

describe('buildScorecard', () => {
  it('averages compared samples and ranks fields and columns worst first', () => {
    const card = buildScorecard([
      sample({
        comparison: comparison(
          1,
          [
            ['date', true],
            ['ref', true],
          ],
          { name: { matched: 2, total: 2 } },
        ),
      }),
      sample({
        sampleId: 't',
        comparison: comparison(
          0.5,
          [
            ['date', false],
            ['ref', true],
          ],
          { name: { matched: 1, total: 2 } },
        ),
      }),
      sample({ sampleId: 'u', status: 'failed', error: 'boom' }),
    ]);
    expect(card.score).toBe(0.75);
    expect(card).toMatchObject({ completed: 2, total: 3 });
    expect(card.fields).toEqual([
      { id: 'date', matched: 1, total: 2, accuracy: 0.5 },
      { id: 'ref', matched: 2, total: 2, accuracy: 1 },
    ]);
    expect(card.columns).toEqual([{ id: 'items.name', matched: 3, total: 4, accuracy: 0.75 }]);
  });

  it('has no score when nothing was compared', () => {
    expect(buildScorecard([sample({ status: 'running' })])).toMatchObject({
      score: null,
      completed: 0,
      total: 1,
      fields: [],
      columns: [],
    });
  });
});

describe('comparisonRows', () => {
  const view = (
    model: 'default' | 'fast' | null,
    score: number | null,
    fields: [string, number][],
  ): IterationView => ({
    id: model ?? 'tmpl',
    projectId: 'letter',
    templateVersion: 2,
    briefVersion: null,
    set: 'dev',
    model,
    groupId: 'g1',
    uncached: false,
    createdAt: '2026-10-12T10:00:00.000Z',
    status: 'complete',
    score,
    completed: 1,
    total: 1,
    cache: { reused: 0, total: 0 },
    scorecard: {
      score,
      completed: 1,
      total: 1,
      fields: fields.map(([id, accuracy]) => ({ id, matched: 0, total: 1, accuracy })),
      columns: [],
    },
    samples: [],
  });

  it('lines up overall and per-field accuracy by model', () => {
    expect(
      comparisonRows([
        view('default', 0.5, [
          ['sender', 1],
          ['date', 0],
        ]),
        view('fast', null, [['sender', 0.5]]),
      ]),
    ).toEqual([
      { id: 'score', byModel: { default: 0.5, fast: null } },
      { id: 'date', byModel: { default: 0, fast: null } },
      { id: 'sender', byModel: { default: 1, fast: 0.5 } },
    ]);
  });

  it('labels the template-models iteration "template"', () => {
    expect(comparisonRows([view(null, 1, [])])).toEqual([
      { id: 'score', byModel: { template: 1 } },
    ]);
  });
});

describe('failureDiffs', () => {
  const result = (
    sampleId: string,
    filename: string,
    score: number,
    mismatches: number,
  ): SampleResult => ({
    sampleId,
    filename,
    jobId: `j-${sampleId}`,
    status: 'succeeded',
    error: null,
    comparison: {
      score,
      fields: [
        { id: 'ok', expected: 'a', actual: 'a', match: true },
        ...Array.from({ length: mismatches }, (_, i) => ({
          id: `f${i}`,
          expected: 'e',
          actual: 'x',
          match: false,
        })),
      ],
      tables: [
        {
          id: 'items',
          expected: 2,
          actual: 2,
          matched: 1,
          missing: [{ name: 'Nut' }],
          extra: [],
          changed: Array.from({ length: 7 }, () => ({
            expected: { qty: 1 },
            actual: { qty: 2 },
            columns: ['qty'],
          })),
          cells: 1,
          cellsTotal: 2,
          columns: {},
        },
      ],
    },
  });

  it('keeps only imperfect dev samples, capped', () => {
    const diffs = failureDiffs(
      [result('s1', 'a.pdf', 0.5, 25), result('s2', 'b.pdf', 1, 0), result('s3', 'c.pdf', 0.2, 1)],
      new Set(['s1', 's2']),
    );
    expect(diffs.map((d) => d.sample)).toEqual(['a.pdf']);
    expect(diffs[0]!.fields).toHaveLength(MAX_FIELD_DIFFS);
    expect(diffs[0]!.fields[0]).toEqual({ id: 'f0', expected: 'e', actual: 'x' });
    expect(diffs[0]!.tables).toEqual([
      expect.objectContaining({ id: 'items', missing: 1, extra: 0 }),
    ]);
    expect(diffs[0]!.tables[0]!.changed).toHaveLength(5);
  });

  it('skips samples without a comparison or a sample id', () => {
    expect(
      failureDiffs(
        [
          { ...result('s1', 'a.pdf', 0.5, 1), comparison: null },
          { ...result('s1', 'a.pdf', 0.5, 1), sampleId: null },
        ],
        new Set(['s1']),
      ),
    ).toEqual([]);
  });
});

describe('FeedbackBodySchema', () => {
  it('accepts a targeted comment and rejects bad targets and empty bodies', () => {
    expect(
      FeedbackBodySchema.safeParse({
        target: 'field',
        targetId: 'sent_on',
        body: 'Use the executed copy',
      }).success,
    ).toBe(true);
    expect(FeedbackBodySchema.safeParse({ target: 'page', targetId: 'x', body: 'b' }).success).toBe(
      false,
    );
    expect(
      FeedbackBodySchema.safeParse({ target: 'field', targetId: 'Sent On', body: 'b' }).success,
    ).toBe(false);
    expect(FeedbackBodySchema.safeParse({ target: 'field', targetId: 'x', body: '' }).success).toBe(
      false,
    );
    expect(
      FeedbackBodySchema.safeParse({ target: 'field', targetId: 'x', body: 'b', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('publishGate', () => {
  const c = (over: Partial<GateCandidate>): GateCandidate => ({
    id: 'i1',
    status: 'complete',
    score: 0.95,
    matchesDraft: true,
    createdAt: '2026-10-12T10:00:00.000Z',
    completed: 2,
    total: 2,
    model: null,
    covered: 2,
    holdoutSamples: 2,
    ...over,
  });

  it('passes on the newest complete holdout run of the current draft', () => {
    expect(
      publishGate({
        threshold: 0.9,
        candidates: [
          c({ id: 'old', score: 0.5, createdAt: '2026-10-12T09:00:00.000Z' }),
          c({ id: 'new' }),
        ],
      }),
    ).toEqual({
      threshold: 0.9,
      iterationId: 'new',
      score: 0.95,
      passes: true,
      reason: 'holdout score 95% meets the threshold 90%',
    });
  });

  it('fails below the threshold', () => {
    expect(publishGate({ threshold: 0.9, candidates: [c({ score: 0.82 })] })).toMatchObject({
      passes: false,
      reason: 'holdout score 82% is below the threshold 90%',
    });
  });

  it('ignores running runs and runs of an older draft', () => {
    const gate = publishGate({
      threshold: 0.9,
      candidates: [
        c({ id: 'running', status: 'running' }),
        c({ id: 'stale', matchesDraft: false }),
      ],
    });
    expect(gate).toEqual({
      threshold: 0.9,
      iterationId: null,
      score: null,
      passes: false,
      reason: 'no complete holdout evaluation of the current draft',
    });
  });

  it('handles the threshold edges', () => {
    expect(publishGate({ threshold: 0, candidates: [c({ score: 0 })] }).passes).toBe(true);
    expect(publishGate({ threshold: 1, candidates: [c({ score: 0.99 })] }).passes).toBe(false);
    expect(publishGate({ threshold: 1, candidates: [c({ score: 1 })] }).passes).toBe(true);
    expect(publishGate({ threshold: 0.5, candidates: [c({ score: null })] }).passes).toBe(false);
  });

  it('ignores runs with a model override (only the template own models count)', () => {
    const gate = publishGate({
      threshold: 0.9,
      candidates: [
        c({ id: 'template', score: 0.5, createdAt: '2026-10-12T09:00:00.000Z' }),
        c({ id: 'fast', model: 'fast', score: 1 }),
      ],
    });
    expect(gate).toMatchObject({ iterationId: 'template', passes: false, score: 0.5 });
    expect(publishGate({ threshold: 0.9, candidates: [c({ model: 'fast' })] })).toMatchObject({
      iterationId: null,
      passes: false,
      reason: 'no complete holdout evaluation of the current draft',
    });
  });

  it.each([
    [
      'a sample was not compared',
      { completed: 1, total: 2, score: 1 },
      'holdout evaluation compared 1 of 2 samples',
    ],
    [
      'a ready holdout sample was not evaluated',
      { covered: 1, holdoutSamples: 2, score: 1 },
      'holdout evaluation covered 1 of 2 holdout samples',
    ],
    [
      'coverage is reported before comparisons',
      { covered: 1, holdoutSamples: 3, completed: 0, total: 1 },
      'holdout evaluation covered 1 of 3 holdout samples',
    ],
    [
      'comparisons are reported before the score',
      { completed: 1, total: 2, score: 0.1 },
      'holdout evaluation compared 1 of 2 samples',
    ],
    ['there is no score', { score: null }, 'holdout evaluation produced no score'],
    [
      'the rounded percentages tie (one decimal)',
      { score: 0.899 },
      'holdout score 89.9% is below the threshold 90.0%',
    ],
  ] as [string, Partial<GateCandidate>, string][])('fails when %s', (_name, over, reason) => {
    const gate = publishGate({ threshold: 0.9, candidates: [c({ id: 'run', ...over })] });
    expect(gate).toMatchObject({ iterationId: 'run', passes: false, reason });
  });

  it('keeps whole percentages when the rounded values agree with the verdict', () => {
    expect(publishGate({ threshold: 0.9, candidates: [c({ score: 0.904 })] }).reason).toBe(
      'holdout score 90% meets the threshold 90%',
    );
  });
});

describe('publish bodies', () => {
  it('validates override reasons and thresholds', () => {
    expect(PublishBodySchema.safeParse({}).success).toBe(true);
    expect(PublishBodySchema.safeParse({ overrideReason: 'too short' }).success).toBe(false);
    expect(
      PublishBodySchema.safeParse({ overrideReason: 'Holdout sample 3 is a known bad scan' })
        .success,
    ).toBe(true);
    expect(ThresholdBodySchema.safeParse({ publishThreshold: 0.8 }).success).toBe(true);
    expect(ThresholdBodySchema.safeParse({ publishThreshold: 1.2 }).success).toBe(false);
    expect(ThresholdBodySchema.safeParse({ publishThreshold: -0.1 }).success).toBe(false);
  });
});

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
  type Case = [
    string,
    number,
    { fields: Accuracy[]; columns: Accuracy[] },
    unknown,
    [string, GateHint['cause']][],
  ];

  it.each<Case>([
    [
      'nothing below the threshold',
      0.9,
      { fields: [acc('sender', 2, 2)], columns: [] },
      definition,
      [],
    ],
    [
      'at the threshold is not below it',
      0.9,
      { fields: [acc('sender', 9, 10)], columns: [] },
      definition,
      [],
    ],
    [
      'a filled output that is often wrong',
      0.9,
      { fields: [acc('sender', 1, 2)], columns: [] },
      definition,
      [['sender', 'low_accuracy']],
    ],
    [
      'an output no step fills',
      0.9,
      { fields: [acc('due_date', 0, 2)], columns: [] },
      definition,
      [['due_date', 'no_step']],
    ],
    [
      'a key the draft does not define',
      0.9,
      { fields: [acc('vat', 0, 2)], columns: [] },
      definition,
      [['vat', 'no_step']],
    ],
    [
      'a column takes its table coverage',
      0.95,
      { fields: [], columns: [acc('line_items.qty', 13, 14)] },
      definition,
      [['line_items.qty', 'low_accuracy']],
    ],
    [
      'a column of an undefined table',
      0.9,
      { fields: [], columns: [acc('lines.qty', 0, 4)] },
      definition,
      [['lines.qty', 'no_step']],
    ],
    [
      'worst first, no_step before low_accuracy on a tie, then by key',
      0.9,
      {
        fields: [acc('sender', 0, 2), acc('due_date', 0, 2), acc('vat', 0, 2)],
        columns: [acc('line_items.qty', 1, 2)],
      },
      definition,
      [
        ['due_date', 'no_step'],
        ['vat', 'no_step'],
        ['sender', 'low_accuracy'],
        ['line_items.qty', 'low_accuracy'],
      ],
    ],
    [
      'a malformed definition: nothing is filled',
      0.9,
      { fields: [acc('sender', 0, 1)], columns: [] },
      null,
      [['sender', 'no_step']],
    ],
  ])('%s', (_name, threshold, scorecard, def, expected) => {
    expect(
      gateHints({ threshold, scorecard, definition: def }).map((h) => [h.key, h.cause]),
    ).toEqual(expected);
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
