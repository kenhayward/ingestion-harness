import { describe, expect, it } from 'vitest';
import { queueSummary } from '../src/jobs/queue-summary.js';
import { testApp } from './helpers.js';

const doc = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  filename: `q${n}.pdf`,
  sha256: String(n).repeat(64),
  sizeBytes: 1,
  specId: 'letter',
  specVersion: 1,
  bucket: 'inbox',
  objectKey: `letter/v1/q${n}.pdf`,
});

describe('queueSummary (TR4)', () => {
  it.each([
    ['an empty queue starts right away', { queued: 0, running: 2, medianSeconds: null }, 0],
    ['no timing history: count only', { queued: 3, running: 1, medianSeconds: null }, null],
    ['one busy worker', { queued: 2, running: 1, medianSeconds: 60 }, 120],
    ['workers share the queue', { queued: 3, running: 2, medianSeconds: 40 }, 60],
    ['an idle queue counts one worker', { queued: 2, running: 0, medianSeconds: 30.4 }, 61],
  ])('%s', (_name, stats, eta) => {
    expect(queueSummary(stats)).toEqual({
      ahead: stats.queued,
      running: stats.running,
      etaSeconds: eta,
    });
  });
});

describe('GET /api/queue/summary', () => {
  it('counts the queue and estimates from recent timed runs', async () => {
    const { app, repo } = await testApp();
    expect((await app.inject('/api/queue/summary')).json()).toEqual({
      ahead: 0,
      running: 0,
      etaSeconds: 0,
    });
    // Four jobs: the first two stay queued, c runs, d finished 60 s after it started.
    const [, , c, d] = await Promise.all(
      [1, 2, 3, 4].map((n) => repo.createDocumentAndJob(doc(n), null)),
    );
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    repo.jobs.set(c!.id, { ...c!, status: 'running', startedAt: iso(5_000) });
    repo.jobs.set(d!.id, {
      ...d!,
      status: 'succeeded',
      startedAt: iso(100_000),
      finishedAt: iso(40_000), // took 60 s
    });
    expect((await app.inject('/api/queue/summary')).json()).toEqual({
      ahead: 2,
      running: 1,
      etaSeconds: 120,
    });
  });

  it('ignores runs that finished more than a day ago', async () => {
    const { app, repo } = await testApp();
    const [, old] = await Promise.all([1, 2].map((n) => repo.createDocumentAndJob(doc(n), null)));
    const day = 24 * 3600_000;
    repo.jobs.set(old!.id, {
      ...old!,
      status: 'succeeded',
      startedAt: new Date(Date.now() - day - 120_000).toISOString(),
      finishedAt: new Date(Date.now() - day - 60_000).toISOString(),
    });
    expect((await app.inject('/api/queue/summary')).json()).toEqual({
      ahead: 1,
      running: 0,
      etaSeconds: null,
    });
  });
});
