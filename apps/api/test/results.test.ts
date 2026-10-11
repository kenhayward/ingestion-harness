import type { JobOutput } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { UnreachableStore, fakePdf, multipart, testApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof testApp>>;

async function upload(ctx: Ctx, specId: string, filename: string) {
  return (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId }, { filename, content: fakePdf }),
    })
  ).json();
}

const out = (
  outputId: string,
  stage: 'draft' | 'published',
  rowCount: number | null = 1,
): JobOutput => ({
  outputId,
  stage,
  format: outputId === 'document' ? 'json' : 'csv',
  bucket: stage === 'published' ? 'published' : 'outputs',
  key: `${stage === 'published' ? 'pub/' : ''}tdemo/v1/${outputId}/doc.${outputId === 'document' ? 'json' : 'csv'}`,
  rowCount,
});

/** Mark a job published at `at` with the given outputs. */
function publish(ctx: Ctx, jobId: string, at: string, outputs: JobOutput[]) {
  ctx.repo.outputs.set(jobId, outputs);
  ctx.repo.publishedAt.set(jobId, at);
}

describe('GET /api/results', () => {
  it('lists only non-test jobs with published outputs, newest publish first', async () => {
    const ctx = await testApp();
    const older = await upload(ctx, 'tdemo', 'older.pdf');
    const newer = await upload(ctx, 'tdemo', 'newer.pdf');
    const draftOnly = await upload(ctx, 'tdemo', 'draft.pdf');
    const test = await upload(ctx, 'tdemo', 'test.pdf');
    ctx.repo.jobs.set(test.id, { ...ctx.repo.jobs.get(test.id)!, test: true });
    publish(ctx, older.id, '2026-10-01T00:00:00.000Z', [
      out('document', 'published', null),
      out('issues', 'published', 2),
    ]);
    publish(ctx, newer.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    ctx.repo.outputs.set(draftOnly.id, [out('document', 'draft', null)]);
    publish(ctx, test.id, '2026-10-03T00:00:00.000Z', [out('document', 'published', null)]);

    const res = await ctx.app.inject('/api/results');
    expect(res.statusCode).toBe(200);
    expect(res.json().map((r: { filename: string }) => r.filename)).toEqual([
      'newer.pdf',
      'older.pdf',
    ]);
    expect(res.json()[1]).toMatchObject({
      jobId: older.id,
      specId: 'tdemo',
      specVersion: 1,
      publishedAt: '2026-10-01T00:00:00.000Z',
      reviewer: null,
      reviewedAt: null,
      outputCount: 2,
      issueCount: 2,
    });
    expect(res.json()[0].issueCount).toBeNull();
  });

  it('filters by document type and pages with a before cursor', async () => {
    const ctx = await testApp();
    const a = await upload(ctx, 'tdemo', 'a.pdf');
    const b = await upload(ctx, 'tdemo', 'b.pdf');
    const other = await upload(ctx, 'demo', 'other.pdf');
    publish(ctx, a.id, '2026-10-01T00:00:00.000Z', [out('document', 'published', null)]);
    publish(ctx, b.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    publish(ctx, other.id, '2026-10-03T00:00:00.000Z', [out('all', 'published', null)]);

    const typed = (await ctx.app.inject('/api/results?templateId=tdemo')).json();
    expect(typed.map((r: { filename: string }) => r.filename)).toEqual(['b.pdf', 'a.pdf']);
    const page1 = (await ctx.app.inject('/api/results?limit=1')).json();
    expect(page1.map((r: { filename: string }) => r.filename)).toEqual(['other.pdf']);
    const page2 = (
      await ctx.app.inject(
        `/api/results?limit=1&before=${encodeURIComponent(page1[0].publishedAt)}`,
      )
    ).json();
    expect(page2.map((r: { filename: string }) => r.filename)).toEqual(['b.pdf']);
  });

  it('validates the query', async () => {
    const { app } = await testApp();
    expect((await app.inject('/api/results?limit=0')).statusCode).toBe(400);
    expect((await app.inject('/api/results?limit=500')).statusCode).toBe(400);
    expect((await app.inject('/api/results?before=yesterday')).statusCode).toBe(400);
  });
});

const doc = {
  document_id: 'doc',
  fields: { product: { value: 'Aspirin' }, executed_on: { value: '2026-10-01' } },
  tables: { results: [{ batch: 'B1', value: 1.5 }] },
  checks: {},
  issues: [],
  review: {
    reviewer: 'Ken',
    note: 'ok',
    reviewed_at: '2026-10-02T00:00:00Z',
    edits: [{ field: 'product', value: 'Aspirin' }],
  },
  published_at: '2026-10-02T00:00:01Z',
};
const put = (
  store: { put: Ctx['targetStore']['put'] },
  bucket: string,
  key: string,
  body: unknown,
) =>
  store.put(
    bucket,
    key,
    Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    'application/json',
  );

describe('GET /api/results/:jobId', () => {
  it('returns the published document from the target (not the draft), with template labels', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:01.000Z', [
      out('document', 'draft', null),
      out('document', 'published', null),
      out('results', 'published', 1),
    ]);
    await put(ctx.store, 'outputs', 'tdemo/v1/document/doc.json', {
      ...doc,
      fields: { product: { value: 'DRAFT' } },
    });
    // Key is used exactly as recorded (already prefixed): never prefix it again.
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', doc);

    const res = await ctx.app.inject(`/api/results/${job.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.job).toMatchObject({ id: job.id, filename: 'a.pdf' });
    expect(body.job.outputs).toBeUndefined();
    expect(body.target).toEqual({ bucket: 'published', prefix: 'pub/' });
    expect(body.outputs.map((o: JobOutput) => `${o.outputId}:${o.stage}`)).toEqual([
      'document:published',
      'results:published',
    ]);
    expect(body.document.fields.product.value).toBe('Aspirin');
    expect(body.documentError).toBeNull();
    expect(body.definition.kind).toBe('template');
    expect(body.definition.fields.map((f: { id: string }) => f.id)).toEqual([
      'product',
      'executed_on',
    ]);
    expect(body.definition.tables[0].columns.map((c: { id: string }) => c.id)).toEqual([
      'batch',
      'value',
    ]);
  });

  it('reports a document missing from the target without failing', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    const body = (await ctx.app.inject(`/api/results/${job.id}`)).json();
    expect(body).toMatchObject({ document: null, documentError: 'missing from target' });
  });

  it('reports an invalid document without failing', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', '{not json');
    expect((await ctx.app.inject(`/api/results/${job.id}`)).json()).toMatchObject({
      document: null,
      documentError: 'invalid document',
    });
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', { fields: 'nope' });
    expect((await ctx.app.inject(`/api/results/${job.id}`)).json().documentError).toBe(
      'invalid document',
    );
  });

  it('reports an unreachable target without failing', async () => {
    const ctx = await testApp({ targetStore: new UnreachableStore() });
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    const res = await ctx.app.inject(`/api/results/${job.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      document: null,
      documentError: 'target storage unavailable',
    });
  });

  it('does not read a document for legacy spec jobs', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'demo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('all', 'published', null)]);
    expect((await ctx.app.inject(`/api/results/${job.id}`)).json()).toMatchObject({
      document: null,
      documentError: null,
      definition: { kind: 'spec' },
    });
  });

  it('marks the definition unknown when the job version cannot be resolved', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, specVersion: 99 });
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', doc);
    const body = (await ctx.app.inject(`/api/results/${job.id}`)).json();
    expect(body.definition).toEqual({ kind: 'unknown' });
    expect(body.document.fields.product.value).toBe('Aspirin');
  });

  it('404s for unknown, unpublished and test jobs', async () => {
    const ctx = await testApp();
    expect((await ctx.app.inject('/api/results/not-a-uuid')).statusCode).toBe(404);
    expect((await ctx.app.inject(`/api/results/${crypto.randomUUID()}`)).statusCode).toBe(404);
    const draft = await upload(ctx, 'tdemo', 'draft.pdf');
    ctx.repo.outputs.set(draft.id, [out('document', 'draft', null)]);
    expect((await ctx.app.inject(`/api/results/${draft.id}`)).statusCode).toBe(404);
    const test = await upload(ctx, 'tdemo', 'test.pdf');
    ctx.repo.jobs.set(test.id, { ...ctx.repo.jobs.get(test.id)!, test: true });
    publish(ctx, test.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    expect((await ctx.app.inject(`/api/results/${test.id}`)).statusCode).toBe(404);
  });
});
