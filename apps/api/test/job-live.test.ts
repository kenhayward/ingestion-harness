import {
  PREPARE_PROGRESS_EVENT,
  SEGMENTED_EVENT,
  STEP_PROGRESS_EVENT,
  type JobLive,
  type JobSummary,
} from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { MemoryJobWatch } from '../src/jobs/watch.js';
import { fakePdf, multipart, testApp } from './helpers.js';

async function seedJob(overrides: Parameters<typeof testApp>[0] = {}) {
  const watch = new MemoryJobWatch();
  const ctx = await testApp({ jobWatch: watch, ...overrides });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/documents',
    ...multipart({ specId: 'demo' }, { filename: 'a.pdf', content: fakePdf }),
  });
  const id = (res.json() as JobSummary).id;
  const set = (changes: Partial<JobSummary>) =>
    ctx.repo.jobs.set(id, { ...ctx.repo.jobs.get(id)!, ...changes });
  const start = () => set({ status: 'running', startedAt: ctx.repo.now() });
  return { ...ctx, watch, id, set, start };
}

/** The `event: job` messages of an SSE body, parsed. */
function messages(body: string): JobLive[] {
  return body
    .split('\n\n')
    .filter((block) => block.includes('event: job'))
    .map((block) => JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as JobLive);
}

const step = { step: 'head', index: 1, of: 2, attempt: 1, chunk: null, occurrence: null };

describe('GET /api/jobs/:id progress', () => {
  it("is a running extraction's latest progress event of this attempt", async () => {
    const r = await seedJob();
    const progress = async () => (await r.app.inject(`/api/jobs/${r.id}`)).json().progress;
    expect(await progress()).toBeNull(); // queued
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, step); // an earlier attempt's
    r.start();
    expect(await progress()).toBeNull();
    r.repo.addEvent(r.id, 'info', PREPARE_PROGRESS_EVENT, { stage: 'ocr', page: 2, of: 5 });
    expect(await progress()).toEqual({ kind: 'prepare', stage: 'ocr', page: 2, of: 5 });
    r.repo.addEvent(r.id, 'info', SEGMENTED_EVENT, { pages: 5, sections: ['header'] });
    expect(await progress()).toEqual({ kind: 'segmented' });
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, step);
    expect(await progress()).toEqual({ kind: 'step', ...step });
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, { step: 'head' }); // malformed
    expect(await progress()).toBeNull();
    r.set({ status: 'succeeded' });
    expect(await progress()).toBeNull();
  });

  it('is null for a running publish or step re-run', async () => {
    const r = await seedJob();
    r.start();
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, step);
    r.set({ task: 'rerun' });
    expect((await r.app.inject(`/api/jobs/${r.id}`)).json().progress).toBeNull();
  });
});

describe('stage times', () => {
  it('are when this attempt finished reading and found the sections, kept once it finishes', async () => {
    const r = await seedJob();
    const times = async () => (await r.app.inject(`/api/jobs/${r.id}`)).json().stageTimes;
    expect(await times()).toEqual({ readAt: null, segmentedAt: null }); // queued
    r.repo.addEvent(r.id, 'info', SEGMENTED_EVENT, {}); // an earlier attempt's
    r.start();
    expect(await times()).toEqual({ readAt: null, segmentedAt: null });
    r.repo.addEvent(r.id, 'info', PREPARE_PROGRESS_EVENT, { stage: 'text', page: 2, of: 2 });
    r.repo.addEvent(r.id, 'info', PREPARE_PROGRESS_EVENT, { stage: 'ocr', page: 2, of: 2 });
    r.repo.addEvent(r.id, 'info', SEGMENTED_EVENT, { pages: 2, sections: [] });
    const [, ocr, segmented] = r.repo.events.get(r.id)!.slice(-3);
    const expected = { readAt: ocr!.at, segmentedAt: segmented!.at };
    expect(await times()).toEqual(expected);
    r.set({ status: 'succeeded' });
    expect(await times()).toEqual(expected);
  });

  it('are sent on the live stream too', async () => {
    const r = await seedJob();
    r.start();
    r.repo.addEvent(r.id, 'info', SEGMENTED_EVENT, {});
    r.set({ status: 'succeeded' });
    const [sent] = messages((await r.app.inject(`/api/jobs/${r.id}/events`)).body);
    expect(sent!.stageTimes).toEqual({
      readAt: null,
      segmentedAt: r.repo.events.get(r.id)!.at(-1)!.at,
    });
  });
});

describe('GET /api/jobs/:id/events', () => {
  it('is 404 for an unknown job', async () => {
    const r = await seedJob();
    expect((await r.app.inject(`/api/jobs/${crypto.randomUUID()}/events`)).statusCode).toBe(404);
    expect((await r.app.inject('/api/jobs/nope/events')).statusCode).toBe(404);
  });

  it('sends a finished job once and ends', async () => {
    const r = await seedJob();
    r.set({ status: 'succeeded' });
    const res = await r.app.inject(`/api/jobs/${r.id}/events`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');
    const sent = messages(res.body);
    expect(sent.map((m) => m.job.status)).toEqual(['succeeded']);
    expect(sent[0]!.progress).toBeNull();
    expect(r.watch.listeners(r.id)).toBe(0);
  });

  it('pushes each change it is told about until the job finishes', async () => {
    const r = await seedJob();
    const pending = r.app.inject(`/api/jobs/${r.id}/events`);
    await until(() => r.watch.listeners(r.id) === 1);
    r.start();
    r.watch.changed(r.id);
    await tick();
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, step);
    r.watch.changed(r.id);
    await tick();
    r.watch.changed(r.id); // nothing new: not sent again
    await tick();
    r.set({ status: 'awaiting_review' });
    r.watch.changed(r.id);
    const sent = messages((await pending).body);
    expect(sent.map((m) => [m.job.status, m.progress?.kind ?? null])).toEqual([
      ['queued', null],
      ['running', null],
      ['running', 'step'],
      ['awaiting_review', null],
    ]);
    expect(r.watch.listeners(r.id)).toBe(0);
  });

  it('re-reads the job on each heartbeat, so a missed notification is caught up', async () => {
    const r = await seedJob({ liveHeartbeatMs: 20 });
    const pending = r.app.inject(`/api/jobs/${r.id}/events`);
    await until(() => r.watch.listeners(r.id) === 1);
    r.set({ status: 'failed' }); // never notified
    const res = await pending;
    expect(res.body).toContain(': ping');
    expect(messages(res.body).map((m) => m.job.status)).toEqual(['queued', 'failed']);
  });

  it('says so and ends when the job is deleted', async () => {
    const r = await seedJob();
    const pending = r.app.inject(`/api/jobs/${r.id}/events`);
    await until(() => r.watch.listeners(r.id) === 1);
    r.repo.jobs.delete(r.id);
    r.watch.changed(r.id);
    expect((await pending).body).toContain('event: gone');
  });

  it('works without a watch, on heartbeats alone', async () => {
    const r = await seedJob({ jobWatch: null, liveHeartbeatMs: 20 });
    const pending = r.app.inject(`/api/jobs/${r.id}/events`);
    await tick();
    r.set({ status: 'succeeded' });
    expect(messages((await pending).body).map((m) => m.job.status)).toEqual([
      'queued',
      'succeeded',
    ]);
  });

  it('ends open streams when the app closes', async () => {
    const r = await seedJob();
    const pending = r.app.inject(`/api/jobs/${r.id}/events`);
    await until(() => r.watch.listeners(r.id) === 1);
    await r.app.close();
    expect(messages((await pending).body)).toHaveLength(1);
    expect(r.watch.listeners(r.id)).toBe(0);
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await tick();
  expect(ok()).toBe(true);
}
