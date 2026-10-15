import type { JobStatus, JobSummary } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { jobNotices } from '../src/pwa/notify.js';
import { job } from './fake-api.js';

const ME = { name: 'ken', userId: 'u-ken' };
const mine = (id: string, status: JobStatus, more: Partial<JobSummary> = {}) =>
  job({ id, status, createdBy: ME.name, createdByUser: ME.userId, filename: `${id}.pdf`, ...more });

describe('jobNotices (toasts for your jobs, docs/design/pwa.md)', () => {
  it.each<[string, JobStatus, JobStatus, Partial<JobSummary>, object | null]>([
    [
      'awaiting review',
      'running',
      'awaiting_review',
      {},
      { tag: 'ct-job-a', title: 'Ready for review', body: 'a.pdf', href: '#/review/a' },
    ],
    [
      'published',
      'running',
      'succeeded',
      {},
      { tag: 'ct-job-a', title: 'Done', body: 'a.pdf', href: '#/results/a' },
    ],
    [
      'a test run done',
      'running',
      'succeeded',
      { test: true },
      { tag: 'ct-job-a', title: 'Done', body: 'a.pdf', href: '#/jobs' },
    ],
    [
      'needs review, with the reason',
      'running',
      'needs_review',
      { error: 'section Totals not found' },
      {
        tag: 'ct-job-a',
        title: 'Needs attention',
        body: 'a.pdf: section Totals not found',
        href: '#/jobs',
      },
    ],
    [
      'failed',
      'queued',
      'failed',
      {},
      { tag: 'ct-job-a', title: 'Needs attention', body: 'a.pdf', href: '#/jobs' },
    ],
    ['cancelled', 'running', 'cancelled', {}, null],
    ['rejected', 'running', 'rejected', {}, null],
    ['still running', 'queued', 'running', {}, null],
    ['already finished before (approved later)', 'awaiting_review', 'succeeded', {}, null],
  ])('%s', (_, from, to, more, notice) => {
    const notices = jobNotices([mine('a', from, more)], [mine('a', to, more)], ME);
    expect(notices).toEqual(notice ? [notice] : []);
  });

  it('ignores other people’s jobs', () => {
    const theirs = (status: JobStatus) => job({ id: 'b', status, createdBy: 'ops' });
    expect(jobNotices([theirs('running')], [theirs('awaiting_review')], ME)).toEqual([]);
  });

  it('ignores a job by someone else who has (or had) my name', () => {
    const namesake = (status: JobStatus) =>
      job({ id: 'd', status, createdBy: 'ken', createdByUser: 'u-other' });
    expect(jobNotices([namesake('running')], [namesake('succeeded')], ME)).toEqual([]);
  });

  it('still announces my jobs after I am renamed (by id)', () => {
    const renamed = { ...ME, name: 'Kenneth' };
    expect(jobNotices([mine('a', 'running')], [mine('a', 'succeeded')], renamed)).toHaveLength(1);
  });

  it('announces older jobs without an id by name', () => {
    const legacy = (status: JobStatus) => job({ id: 'e', status, createdBy: 'ken' });
    expect(jobNotices([legacy('running')], [legacy('succeeded')], ME)).toHaveLength(1);
  });

  it('ignores jobs nobody is recorded as queuing (no access control)', () => {
    const anon = (status: JobStatus) => job({ id: 'c', status, createdBy: null });
    expect(jobNotices([anon('running')], [anon('succeeded')], ME)).toEqual([]);
  });

  it('counts a job that started and finished between two polls', () => {
    expect(jobNotices([], [mine('a', 'awaiting_review')], ME)).toEqual([
      expect.objectContaining({ tag: 'ct-job-a', title: 'Ready for review' }),
    ]);
  });

  it('sums up several of your jobs finishing at once', () => {
    const before = ['a', 'b', 'c', 'd'].map((id) => mine(id, 'running'));
    const after = [
      mine('a', 'awaiting_review'),
      mine('b', 'awaiting_review'),
      mine('c', 'failed'),
      mine('d', 'succeeded'),
    ];
    expect(jobNotices(before, after, ME)).toEqual([
      {
        tag: 'ct-jobs-summary',
        title: '4 of your jobs finished',
        body: '2 ready for review · 1 needs attention · 1 done',
        href: '#/jobs',
      },
    ]);
  });

  it('leaves out a cancelled job from the summary', () => {
    const before = ['a', 'b', 'c'].map((id) => mine(id, 'running'));
    const after = [mine('a', 'succeeded'), mine('b', 'succeeded'), mine('c', 'cancelled')];
    expect(jobNotices(before, after, ME)).toEqual([
      expect.objectContaining({ title: '2 of your jobs finished', body: '2 done' }),
    ]);
  });
});
