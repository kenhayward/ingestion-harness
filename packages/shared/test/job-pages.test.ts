import { describe, expect, it } from 'vitest';
import {
  JobPageQuerySchema,
  jobMatches,
  pageOfJobs,
  type JobSummary,
  type JobStatus,
} from '../src/index.js';

/** Job n: created n minutes after the epoch, so a higher n is newer. */
const job = (n: number, status: JobStatus = 'succeeded', extra: Partial<JobSummary> = {}) =>
  ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    documentId: 'd',
    filename: `doc-${n}.pdf`,
    contentType: 'application/pdf',
    specId: 'letter',
    specVersion: 1,
    status,
    modelOverride: null,
    modelsUsed: [],
    attempts: 1,
    error: null,
    createdAt: new Date(n * 60_000).toISOString(),
    updatedAt: new Date(n * 60_000).toISOString(),
    ...extra,
  }) as JobSummary;
const ids = (jobs: readonly JobSummary[]) => jobs.map((j) => Number(j.id.slice(-12)));
/** Ten jobs, 1 (oldest) to 10 (newest); 3 and 7 failed, 9 running. */
const ten = Array.from({ length: 10 }, (_, i) => {
  const n = i + 1;
  return job(n, n === 3 || n === 7 ? 'failed' : n === 9 ? 'running' : 'succeeded');
});
const page = (q: Record<string, unknown>, jobs = ten) =>
  pageOfJobs(jobs, JobPageQuerySchema.parse(q));

describe('pageOfJobs', () => {
  it('starts at the newest jobs, with counts for every group', () => {
    const p = page({ size: 4 });
    expect(ids(p.jobs)).toEqual([10, 9, 8, 7]);
    expect(p).toMatchObject({ start: 0, total: 10, hasNewer: false, hasOlder: true });
    expect(p.counts).toEqual({ all: 10, attention: 2, active: 1, done: 7 });
  });

  it('pages older and newer from a job, by its place, not a page number', () => {
    const older = page({ size: 4, before: ten[6]!.id }); // older than job 7
    expect(ids(older.jobs)).toEqual([6, 5, 4, 3]);
    expect(older).toMatchObject({ start: 4, hasNewer: true, hasOlder: true });
    const last = page({ size: 4, before: ten[2]!.id });
    expect(ids(last.jobs)).toEqual([2, 1]);
    expect(last).toMatchObject({ start: 8, hasOlder: false });
    const newer = page({ size: 4, after: ten[2]!.id }); // the four just newer than job 3
    expect(ids(newer.jobs)).toEqual([7, 6, 5, 4]);
    expect(newer.start).toBe(3);
    const from = page({ size: 4, from: ten[5]!.id }); // job 6 and older
    expect(ids(from.jobs)).toEqual([6, 5, 4, 3]);
  });

  it('fills a page near the top rather than showing a short one', () => {
    const p = page({ size: 4, after: ten[7]!.id }); // only 9 and 10 are newer than 8
    expect(ids(p.jobs)).toEqual([10, 9, 8, 7]);
    expect(p.start).toBe(0);
  });

  it('filters by group, keeping every group counted', () => {
    const p = page({ size: 4, group: 'attention' });
    expect(ids(p.jobs)).toEqual([7, 3]);
    expect(p).toMatchObject({ total: 2, hasOlder: false });
    expect(p.counts.all).toBe(10);
    // A cursor need not be in the view: job 9 is running.
    expect(ids(page({ size: 4, group: 'attention', before: ten[8]!.id }).jobs)).toEqual([7, 3]);
  });

  it('searches, every word somewhere, and counts within the search', () => {
    const jobs = [...ten, job(11, 'failed', { filename: 'Invoice March.pdf' })];
    const p = page({ size: 4, q: 'march invoice' }, jobs);
    expect(ids(p.jobs)).toEqual([11]);
    expect(p.counts).toEqual({ all: 1, attention: 1, active: 0, done: 0 });
  });

  it('starts at the newest when the job it pages from is gone', () => {
    const p = page({ size: 4, before: '00000000-0000-4000-8000-000000000099' });
    expect(ids(p.jobs)).toEqual([10, 9, 8, 7]);
    expect(p.start).toBe(0);
  });

  it('answers an empty list', () => {
    expect(page({ size: 4 }, [])).toEqual({
      jobs: [],
      start: 0,
      total: 0,
      hasNewer: false,
      hasOlder: false,
      counts: { all: 0, attention: 0, active: 0, done: 0 },
    });
  });
});

describe('jobMatches', () => {
  it.each([
    ['', true],
    ['doc-4', true],
    ['DOC-4 letter', true],
    ['doc-4 invoice', false],
    ['failed', false],
    ['succeeded', true],
    ['local/qwen', true],
    ['main', true],
  ])('%j → %s', (q, expected) => {
    expect(
      jobMatches(job(4, 'succeeded', { modelOverride: 'main', modelsUsed: ['local/qwen'] }), q),
    ).toBe(expected);
  });
});

describe('JobPageQuerySchema', () => {
  it('takes one place to page from at most, and a size of 1 to 100', () => {
    const id = ten[0]!.id;
    expect(JobPageQuerySchema.safeParse({ before: id, after: id }).success).toBe(false);
    expect(JobPageQuerySchema.safeParse({ size: '0' }).success).toBe(false);
    expect(JobPageQuerySchema.safeParse({ size: '101' }).success).toBe(false);
    expect(JobPageQuerySchema.parse({ size: '20', mine: '1' })).toMatchObject({
      size: 20,
      mine: '1',
    });
    expect(JobPageQuerySchema.parse({}).size).toBe(25);
  });
});
