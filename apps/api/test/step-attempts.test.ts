import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { StepRun } from '@ih/shared';
import { testApp } from './helpers.js';

/** A step's model log (the Pipeline tab's "Needs a retry" warning opens it). */
async function seed() {
  const ctx = await testApp();
  const job = async (filename: string) => {
    const documentId = randomUUID();
    return ctx.repo.createDocumentAndJob(
      {
        id: documentId,
        filename,
        sha256: filename,
        sizeBytes: 1,
        specId: 'tdemo',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `tdemo/v1/${documentId}.pdf`,
      },
      null,
    );
  };
  return { ...ctx, job };
}

const run = (stepId: string, attempts: number, startedAt: string, more: Partial<StepRun> = {}) => ({
  id: 1,
  stepId,
  trigger: 'process' as const,
  model: 'local/qwen',
  attempts,
  inputTokens: 10,
  outputTokens: 5,
  status: 'succeeded' as const,
  cached: false,
  error: null,
  startedAt,
  finishedAt: startedAt,
  ...more,
});

const attempt = (n: number, errors: string[] = []) =>
  Buffer.from(
    JSON.stringify({
      n,
      prompt: `prompt ${n}`,
      response: `{"rows": ${n}}`,
      errors,
      input_tokens: 100 * n,
      output_tokens: null,
    }),
  );

describe('GET /api/templates/:id/steps/:step/retried-runs', () => {
  it('lists the runs of the step that needed more than one attempt, newest first', async () => {
    const { app, repo, job } = await seed();
    const a = await job('a.pdf');
    const b = await job('b.pdf');
    const c = await job('c.pdf');
    repo.stepRuns.set(a.id, [
      run('data', 3, '2026-10-20T10:00:00Z'),
      run('head', 4, '2026-10-20T10:00:00Z'),
    ]);
    repo.stepRuns.set(b.id, [run('data', 1, '2026-10-20T11:00:00Z')]);
    repo.stepRuns.set(c.id, [
      run('data', 2, '2026-10-20T12:00:00Z'),
      run('data', 2, '2026-10-20T12:30:00Z', { trigger: 'rerun', status: 'failed' }),
    ]);
    const res = await app.inject('/api/templates/tdemo/steps/data/retried-runs');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      runs: [
        {
          jobId: c.id,
          fileName: 'c.pdf',
          version: 1,
          startedAt: '2026-10-20T12:30:00Z',
          attempts: 2,
          model: 'local/qwen',
          status: 'failed',
          trigger: 'rerun',
        },
        {
          jobId: a.id,
          fileName: 'a.pdf',
          version: 1,
          startedAt: '2026-10-20T10:00:00Z',
          attempts: 3,
          model: 'local/qwen',
          status: 'succeeded',
          trigger: 'process',
        },
      ],
    });
  });

  it('leaves out cached runs and keeps the newest ten', async () => {
    const { app, repo, job } = await seed();
    for (let i = 0; i < 12; i++) {
      const j = await job(`s${i}.pdf`);
      repo.stepRuns.set(j.id, [run('data', 2, `2026-10-20T10:${String(i).padStart(2, '0')}:00Z`)]);
    }
    const cached = await job('cached.pdf');
    repo.stepRuns.set(cached.id, [run('data', 2, '2026-10-21T00:00:00Z', { cached: true })]);
    const runs = (await app.inject('/api/templates/tdemo/steps/data/retried-runs')).json().runs;
    expect(runs.map((r: { fileName: string }) => r.fileName)).toEqual(
      [11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map((i) => `s${i}.pdf`),
    );
  });
});

describe('GET /api/jobs/:id/steps/:step/attempts', () => {
  it("returns the step's saved attempts, its own call first, then its chunks", async () => {
    const { app, store, job } = await seed();
    const j = await job('a.pdf');
    const put = (key: string, body: Buffer) => store.put('runs', key, body, 'application/json');
    await put(`${j.id}/data/attempt-2.json`, attempt(2));
    await put(`${j.id}/data/attempt-1.json`, attempt(1, ['rows/0/qty: not a number']));
    await put(`${j.id}/data.chunk-2/attempt-1.json`, attempt(1));
    await put(`${j.id}/data.chunk-10/attempt-1.json`, attempt(1));
    await put(`${j.id}/database/attempt-1.json`, attempt(1)); // another step
    await put(`${j.id}/data/notes.json`, attempt(1)); // not an attempt
    const res = await app.inject(`/api/jobs/${j.id}/steps/data/attempts`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.calls.map((c: { label: string }) => c.label)).toEqual([
      'data',
      'data.chunk-2',
      'data.chunk-10',
    ]);
    expect(body.calls[0].attempts).toEqual([
      {
        n: 1,
        prompt: 'prompt 1',
        response: '{"rows": 1}',
        errors: ['rows/0/qty: not a number'],
        inputTokens: 100,
        outputTokens: null,
      },
      {
        n: 2,
        prompt: 'prompt 2',
        response: '{"rows": 2}',
        errors: [],
        inputTokens: 200,
        outputTokens: null,
      },
    ]);
  });

  it('is a 404 when the step saved no attempts, or for a malformed job id', async () => {
    const { app, job } = await seed();
    const j = await job('a.pdf');
    const none = await app.inject(`/api/jobs/${j.id}/steps/data/attempts`);
    expect(none.statusCode).toBe(404);
    expect(none.json().error).toBe('no saved attempts for step data of this job');
    expect((await app.inject('/api/jobs/nope/steps/data/attempts')).statusCode).toBe(404);
  });

  it('skips an attempt file that is not valid JSON', async () => {
    const { app, store, job } = await seed();
    const j = await job('a.pdf');
    await store.put('runs', `${j.id}/data/attempt-1.json`, Buffer.from('{'), 'application/json');
    await store.put('runs', `${j.id}/data/attempt-2.json`, attempt(2), 'application/json');
    const body = (await app.inject(`/api/jobs/${j.id}/steps/data/attempts`)).json();
    expect(body.calls[0].attempts.map((a: { n: number }) => a.n)).toEqual([2]);
  });
});
