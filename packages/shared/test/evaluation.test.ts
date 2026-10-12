import { describe, expect, it } from 'vitest';
import {
  buildScorecard,
  finishedJob,
  JOB_STATUSES,
  type Comparison,
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
