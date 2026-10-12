import type { JobStatus } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { effectiveView } from '../src/review/effective.js';
import { flaggedTargets, reviewQueue, targetKey } from '../src/review/queue.js';
import { job } from './fake-api.js';
import { reviewData } from './review-fixture.js';

describe('reviewQueue', () => {
  const at = (id: string, minute: number, status: JobStatus = 'awaiting_review') =>
    job({ id, status, createdAt: `2026-10-12T10:${String(minute).padStart(2, '0')}:00Z` });
  const jobs = [at('c', 30), at('a', 10), at('x', 5, 'succeeded'), at('b', 20)];

  it.each([
    ['a', { position: 1, total: 3, next: 'b' }],
    ['b', { position: 2, total: 3, next: 'c' }],
    ['c', { position: 3, total: 3, next: 'a' }], // wraps
    ['x', { position: null, total: 3, next: 'a' }], // not in the queue: oldest first
    ['gone', { position: null, total: 3, next: 'a' }], // polled away
  ])('%s', (id, expected) => expect(reviewQueue(jobs, id)).toEqual(expected));

  it('has no next when the current job is the only one', () => {
    expect(reviewQueue([at('a', 10)], 'a')).toEqual({ position: 1, total: 1, next: null });
    expect(reviewQueue([], 'a')).toEqual({ position: null, total: 0, next: null });
  });
});

describe('flaggedTargets', () => {
  it('lists flagged fields, then flagged cells in order', () => {
    const data = reviewData();
    data.document.issues.push({
      step: 'head',
      target: 'kind',
      row: null,
      column: null,
      raw: 'x',
      message: 'not an option',
    });
    const targets = flaggedTargets(effectiveView(data), data.template);
    expect(targets.map(targetKey)).toEqual(['field:kind', 'results:2:batch', 'results:2:value']);
  });

  it('drops a target once it is edited', () => {
    const data = reviewData({
      edits: [
        {
          id: 1,
          at: '',
          field: null,
          table: 'results',
          row: 2,
          column: 'value',
          oldValue: 'Complies',
          newValue: '98',
          editor: null,
          reason: null,
        },
      ],
    });
    expect(flaggedTargets(effectiveView(data), data.template).map(targetKey)).toEqual([
      'results:2:batch',
    ]);
  });
});
