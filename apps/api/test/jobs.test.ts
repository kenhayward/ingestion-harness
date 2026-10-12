import { describe, expect, it } from 'vitest';
import { UnreachableStore, demoTemplate, fakePdf, multipart, testApp } from './helpers.js';

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
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
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

  it.each(['publish', 'rerun'] as const)(
    'retrying a cancelled %s job keeps its task (an approval or re-run is not lost)',
    async (task) => {
      const { app, repo, job } = await seedJob();
      repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'queued', task });
      await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
      const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` });
      expect(res.json()).toMatchObject({ status: 'queued', task });
    },
  );

  it('retrying a failed job still re-runs processing', async () => {
    const { app, repo, job } = await seedJob();
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'failed', task: 'publish' });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` });
    expect(res.json()).toMatchObject({ status: 'queued', task: 'process' });
  });

  it('retries a cancelled job', async () => {
    const { app, job } = await seedJob();
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'queued', task: 'process', attempts: 0 });
  });
});

describe('retry with a model', () => {
  const model = (ref: string, enabled = true) => ({
    ref,
    provider: ref.split('/')[0]!,
    providerKind: 'anthropic' as const,
    modelId: ref.split('/')[1]!,
    displayName: null,
    enabled,
    discoveredAt: '',
  });

  async function failedJob(modelOverride: string | null = 'anthropic/old') {
    const ctx = await seedJob();
    ctx.repo.models = [model('anthropic/new'), model('anthropic/off', false)];
    ctx.repo.jobs.set(ctx.job.id, {
      ...ctx.repo.jobs.get(ctx.job.id)!,
      status: 'failed',
      modelOverride,
    });
    return ctx;
  }
  const retry = (ctx: Awaited<ReturnType<typeof seedJob>>, payload?: object) =>
    ctx.app.inject({ method: 'POST', url: `/api/jobs/${ctx.job.id}/retry`, payload });

  it('uses the model sent with the retry', async () => {
    const ctx = await failedJob();
    const res = await retry(ctx, { model: 'anthropic/new' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'queued', modelOverride: 'anthropic/new' });
  });

  it('clears the override with null (spec default)', async () => {
    const ctx = await failedJob();
    expect((await retry(ctx, { model: null })).json()).toMatchObject({ modelOverride: null });
  });

  it('keeps the old override when no model is sent', async () => {
    const ctx = await failedJob();
    expect((await retry(ctx)).json()).toMatchObject({ modelOverride: 'anthropic/old' });
  });

  it.each(['anthropic/unknown', 'anthropic/off'])('rejects %s', async (ref) => {
    const ctx = await failedJob();
    const res = await retry(ctx, { model: ref });
    expect(res.statusCode).toBe(400);
    expect(ctx.repo.jobs.get(ctx.job.id)!.status).toBe('failed');
  });
});

describe('models used', () => {
  it('lists the distinct models a job ran on, oldest first', async () => {
    const { app, repo, job } = await seedJob();
    const run = (model: string | null, startedAt: string) => ({
      id: 1,
      stepId: 's',
      trigger: 'process' as const,
      model,
      attempts: 1,
      inputTokens: null,
      outputTokens: null,
      status: 'succeeded' as const,
      cached: false,
      error: null,
      startedAt,
      finishedAt: startedAt,
    });
    repo.stepRuns.set(job.id, [
      run('local/qwen', '2026-10-01T00:00:00Z'),
      run('anthropic/haiku', '2026-10-02T00:00:00Z'),
      run('local/qwen', '2026-10-03T00:00:00Z'),
      run(null, '2026-10-04T00:00:00Z'),
    ]);
    const listed = (await app.inject('/api/jobs')).json()[0];
    expect(listed.modelsUsed).toEqual(['local/qwen', 'anthropic/haiku']);
    expect((await app.inject(`/api/jobs/${job.id}`)).json().modelsUsed).toEqual([
      'local/qwen',
      'anthropic/haiku',
    ]);
  });

  it('is empty before any step ran', async () => {
    const { app } = await seedJob();
    expect((await app.inject('/api/jobs')).json()[0].modelsUsed).toEqual([]);
  });
});

describe('retry moves to the latest version', () => {
  async function failed(specId: string, overrides: Record<string, unknown> = {}) {
    const ctx = await testApp();
    const job = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/documents',
        ...multipart({ specId, specVersion: '1' }, { filename: 'a.pdf', content: fakePdf }),
      })
    ).json();
    ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status: 'failed', ...overrides });
    return { ...ctx, job };
  }
  const publishV2 = (ctx: Awaited<ReturnType<typeof testApp>>) =>
    ctx.templates.create('tdemo', 2, { ...demoTemplate, version: 2 }, 'published');
  const retry = (ctx: Awaited<ReturnType<typeof testApp>>, id: string) =>
    ctx.app.inject({ method: 'POST', url: `/api/jobs/${id}/retry` });

  it('re-runs a failed job on the latest published template version', async () => {
    const ctx = await failed('tdemo');
    expect(ctx.job.specVersion).toBe(1);
    await publishV2(ctx);
    const res = await retry(ctx, ctx.job.id);
    expect(res.json()).toMatchObject({ status: 'queued', specVersion: 2 });
    expect(ctx.repo.documents.get(ctx.job.documentId)!.specVersion).toBe(2);
  });

  it('moves a legacy spec job to the newest spec file', async () => {
    const ctx = await failed('demo');
    expect(ctx.job.specVersion).toBe(1);
    expect((await retry(ctx, ctx.job.id)).json()).toMatchObject({ specVersion: 2 });
  });

  it('stays on the version it has when that is already the latest', async () => {
    const ctx = await failed('tdemo');
    expect((await retry(ctx, ctx.job.id)).json()).toMatchObject({ specVersion: 1 });
  });

  it.each([
    ['a draft test run', { test: true }],
    ['a regression run', { referenceId: 'ref-1' }],
    ['a cancelled publish', { status: 'cancelled', task: 'publish' }],
  ])('keeps the version for %s', async (_name, overrides) => {
    const ctx = await failed('tdemo', overrides);
    await publishV2(ctx);
    const res = await retry(ctx, ctx.job.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ specVersion: 1 });
  });
});

describe('re-running a succeeded job', () => {
  it('re-processes it on the latest version and discards the earlier review', async () => {
    const ctx = await testApp();
    const job = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/documents',
        ...multipart(
          { specId: 'tdemo', specVersion: '1' },
          { filename: 'a.pdf', content: fakePdf },
        ),
      })
    ).json();
    ctx.repo.jobs.set(job.id, {
      ...ctx.repo.jobs.get(job.id)!,
      status: 'succeeded',
      task: 'publish',
      reviewer: 'Ken',
      reviewNote: 'ok',
      reviewedAt: '2026-10-01T00:00:00Z',
      reviewReasons: ['1 issue'],
    });
    await ctx.repo.addEdit(job.id, {
      field: 'product',
      table: null,
      row: null,
      column: null,
      oldValue: 'a',
      newValue: 'b',
      editor: 'Ken',
      reason: null,
    });
    await ctx.templates.create('tdemo', 2, { ...demoTemplate, version: 2 }, 'published');

    const res = await ctx.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'queued',
      task: 'process',
      specVersion: 2,
      reviewer: null,
      reviewNote: null,
      reviewedAt: null,
      reviewReasons: null,
    });
    expect(await ctx.repo.listEdits(job.id)).toEqual([]);
  });

  it('keeps the review of failed jobs untouched (nothing to discard)', async () => {
    const { app, repo, job } = await seedJob();
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'failed', reviewer: 'Ken' });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` });
    expect(res.json()).toMatchObject({ status: 'queued', reviewer: 'Ken' });
  });
});

describe('GET /api/jobs/:id/document', () => {
  it('serves the uploaded PDF inline', async () => {
    const { app, job } = await seedJob();
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/document` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="a.pdf"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('keeps quotes and line breaks in the file name from breaking the header', async () => {
    const { app, job, repo } = await seedJob();
    // Multipart can't carry these names, but the filename column is user data: set it directly.
    const doc = repo.documents.get(job.documentId)!;
    repo.documents.set(doc.id, { ...doc, filename: 'a"b\r\nX-Evil: 1.pdf' });
    const res = await app.inject({ url: `/api/jobs/${job.id}/document` });
    expect(res.headers['content-disposition']).toBe('inline; filename="a_b__X-Evil: 1.pdf"');
    expect(res.headers['x-evil']).toBeUndefined();
  });

  it('serves non-ASCII file names (RFC 5987) instead of failing', async () => {
    const { app, job, repo } = await seedJob();
    const doc = repo.documents.get(job.documentId)!;
    repo.documents.set(doc.id, { ...doc, filename: "Invoice – März 請求書 (Ken's).pdf" });
    const res = await app.inject({ url: `/api/jobs/${job.id}/document` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `inline; filename="Invoice _ M_rz ___ (Ken's).pdf"; filename*=UTF-8''Invoice%20%E2%80%93%20M%C3%A4rz%20%E8%AB%8B%E6%B1%82%E6%9B%B8%20%28Ken%27s%29.pdf`,
    );
  });

  it('reports an unreachable inbox store as 502', async () => {
    const ctx = await testApp({ store: new UnreachableStore() });
    const job = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/documents',
        ...multipart({ specId: 'demo' }, { filename: 'a.pdf', content: fakePdf }),
      })
    ).json();
    const res = await ctx.app.inject({ url: `/api/jobs/${job.id}/document` });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'storage unavailable' });
  });

  it('404s for bad ids, unknown jobs and a missing inbox object', async () => {
    const { app, job, store } = await seedJob();
    expect((await app.inject({ url: '/api/jobs/not-a-uuid/document' })).statusCode).toBe(404);
    const unknown = await app.inject({ url: `/api/jobs/${crypto.randomUUID()}/document` });
    expect(unknown.statusCode).toBe(404);
    store.objects.clear();
    expect((await app.inject({ url: `/api/jobs/${job.id}/document` })).statusCode).toBe(404);
  });
});
