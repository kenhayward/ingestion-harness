import { describe, expect, it } from 'vitest';
import { fakePdf, multipart, testApp } from './helpers.js';

async function seedJob() {
  const ctx = await testApp();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/documents',
    ...multipart({ specId: 'demo' }, { filename: 'a.pdf', content: fakePdf }),
  });
  return { ...ctx, job: res.json() };
}

describe('jobs API', () => {
  it('lists jobs and filters by status', async () => {
    const { app } = await seedJob();
    expect((await app.inject('/api/jobs')).json()).toHaveLength(1);
    expect((await app.inject('/api/jobs?status=failed')).json()).toHaveLength(0);
    expect((await app.inject('/api/jobs?status=bogus')).statusCode).toBe(400);
  });

  it('returns job detail with outputs, 404 for unknown ids', async () => {
    const { app, job } = await seedJob();
    const res = await app.inject(`/api/jobs/${job.id}`);
    expect(res.json()).toMatchObject({ id: job.id, outputs: [] });
    expect((await app.inject('/api/jobs/not-a-uuid')).statusCode).toBe(404);
    expect((await app.inject(`/api/jobs/${crypto.randomUUID()}`)).statusCode).toBe(404);
  });

  it('only retries jobs in a failed/needs_review state', async () => {
    const { app, repo, job } = await seedJob();
    expect(
      (await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` })).statusCode,
    ).toBe(409);

    repo.jobs.set(job.id, {
      ...repo.jobs.get(job.id)!,
      status: 'failed',
      attempts: 3,
      error: 'boom',
    });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'queued', attempts: 0, error: null });
  });

  it('downloads an output object', async () => {
    const { app, repo, store, job } = await seedJob();
    repo.outputs.set(job.id, [
      {
        outputId: 'lines',
        stage: 'draft',
        format: 'csv',
        bucket: 'outputs',
        key: 'demo/v2/lines/x.csv',
        rowCount: 1,
      },
    ]);
    await store.put('outputs', 'demo/v2/lines/x.csv', Buffer.from('a,b\n1,2\n'), 'text/csv');

    const res = await app.inject(`/api/jobs/${job.id}/outputs/lines`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toBe('a,b\n1,2\n');
  });
});

describe('specs and models API', () => {
  it('lists all spec versions and fetches the latest by default', async () => {
    const { app } = await testApp();
    expect(
      (await app.inject('/api/specs'))
        .json()
        .filter((s: { id: string }) => s.id === 'demo')
        .map((s: { version: number }) => s.version),
    ).toEqual([1, 2]);
    expect((await app.inject('/api/specs/demo')).json().version).toBe(2);
    expect((await app.inject('/api/specs/demo?version=1')).json().version).toBe(1);
    expect((await app.inject('/api/specs/missing')).statusCode).toBe(404);
  });

  it('hides disabled models unless all=true', async () => {
    const { app, repo } = await testApp();
    const base = { providerKind: 'openai-chat' as const, displayName: null, discoveredAt: '' };
    repo.models = [
      { ...base, ref: 'local/a', provider: 'local', modelId: 'a', enabled: true },
      { ...base, ref: 'local/b', provider: 'local', modelId: 'b', enabled: false },
    ];
    expect((await app.inject('/api/models')).json()).toHaveLength(1);
    expect((await app.inject('/api/models?all=true')).json()).toHaveLength(2);
  });
});
