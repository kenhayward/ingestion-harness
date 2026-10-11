import { describe, expect, it } from 'vitest';
import { UnreachableStore, fakePdf, multipart, testApp } from './helpers.js';

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

describe('job output downloads by stage', () => {
  const reviewedOutputs = [
    {
      outputId: 'lines',
      stage: 'draft' as const,
      format: 'csv' as const,
      bucket: 'outputs',
      key: 'demo/v2/lines/x.csv',
      rowCount: 1,
    },
    {
      outputId: 'lines',
      stage: 'published' as const,
      format: 'csv' as const,
      bucket: 'published',
      key: 'pub/demo/v2/lines/x.csv',
      rowCount: 1,
    },
  ];

  it('reads published outputs from the target store and prefers them by default', async () => {
    const { app, repo, store, targetStore, job } = await seedJob();
    repo.outputs.set(job.id, reviewedOutputs);
    await store.put('outputs', 'demo/v2/lines/x.csv', Buffer.from('draft\n'), 'text/csv');
    await targetStore.put(
      'published',
      'pub/demo/v2/lines/x.csv',
      Buffer.from('published\n'),
      'text/csv',
    );

    expect((await app.inject(`/api/jobs/${job.id}/outputs/lines`)).body).toBe('published\n');
    expect((await app.inject(`/api/jobs/${job.id}/outputs/lines?stage=published`)).body).toBe(
      'published\n',
    );
    expect((await app.inject(`/api/jobs/${job.id}/outputs/lines?stage=draft`)).body).toBe(
      'draft\n',
    );
    expect((await app.inject(`/api/jobs/${job.id}/outputs/lines?stage=bogus`)).statusCode).toBe(
      400,
    );
  });

  it('serves inline for previews and attachment by default', async () => {
    const { app, repo, targetStore, job } = await seedJob();
    repo.outputs.set(job.id, reviewedOutputs);
    await targetStore.put('published', 'pub/demo/v2/lines/x.csv', Buffer.from('a\n'), 'text/csv');
    const inline = await app.inject(`/api/jobs/${job.id}/outputs/lines?stage=published&inline=1`);
    expect(inline.headers['content-disposition']).toBe('inline; filename="x.csv"');
    const download = await app.inject(`/api/jobs/${job.id}/outputs/lines`);
    expect(download.headers['content-disposition']).toBe('attachment; filename="x.csv"');
    const notInline = await app.inject(`/api/jobs/${job.id}/outputs/lines?inline=0`);
    expect(notInline.headers['content-disposition']).toBe('attachment; filename="x.csv"');
    expect(inline.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });

  it('reports a published object missing from the target as 404', async () => {
    const { app, repo, job } = await seedJob();
    repo.outputs.set(job.id, reviewedOutputs);
    const res = await app.inject(`/api/jobs/${job.id}/outputs/lines?stage=published`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'output object missing from target' });
  });

  it('returns 502 when the target cannot be reached', async () => {
    const ctx = await testApp({ targetStore: new UnreachableStore() });
    const job = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/documents',
        ...multipart({ specId: 'demo' }, { filename: 'a.pdf', content: fakePdf }),
      })
    ).json();
    ctx.repo.outputs.set(job.id, reviewedOutputs);
    const res = await ctx.app.inject(`/api/jobs/${job.id}/outputs/lines`);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'target storage unavailable' });
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

describe('GET /api/jobs/:id/pages/:n', () => {
  it('serves the JPEG page preview rendered by the worker', async () => {
    const { app, store, job } = await seedJob();
    await store.put('runs', `${job.id}/pages/page-2.jpg`, Buffer.from('jpeg-bytes'), 'image/jpeg');
    const res = await app.inject(`/api/jobs/${job.id}/pages/2`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body).toBe('jpeg-bytes');
  });

  it('404s for missing pages and rejects bad page numbers', async () => {
    const { app, job } = await seedJob();
    expect((await app.inject(`/api/jobs/${job.id}/pages/9`)).statusCode).toBe(404);
    expect((await app.inject(`/api/jobs/${job.id}/pages/0`)).statusCode).toBe(400);
    expect((await app.inject(`/api/jobs/${job.id}/pages/x`)).statusCode).toBe(400);
  });
});

describe('job cancellation', () => {
  it('cancels queued and running jobs and records an event', async () => {
    const { app, repo, job } = await seedJob();
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: job.id, status: 'cancelled' });
    expect(repo.events.get(job.id)?.at(-1)).toMatchObject({ level: 'warn', message: 'cancelled' });

    const running = await seedJob();
    running.repo.jobs.set(running.job.id, {
      ...running.repo.jobs.get(running.job.id)!,
      status: 'running',
    });
    const res2 = await running.app.inject({
      method: 'POST',
      url: `/api/jobs/${running.job.id}/cancel`,
    });
    expect(res2.json()).toMatchObject({ status: 'cancelled' });
  });

  it.each([
    'succeeded',
    'failed',
    'needs_review',
    'awaiting_review',
    'rejected',
    'cancelled',
  ] as const)('refuses to cancel a %s job', async (status) => {
    const { app, repo, job } = await seedJob();
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    expect(res.statusCode).toBe(409);
  });

  it('404s for unknown jobs', async () => {
    const { app } = await testApp();
    const unknown = `/api/jobs/${crypto.randomUUID()}/cancel`;
    expect((await app.inject({ method: 'POST', url: unknown })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/jobs/nope/cancel' })).statusCode).toBe(
      404,
    );
  });

  it('retries a cancelled job', async () => {
    const { app, job } = await seedJob();
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'queued', task: 'process', attempts: 0 });
  });
});
