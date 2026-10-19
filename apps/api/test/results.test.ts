import { TemplateSchema, type JobOutput } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { SpecRegistry } from '../src/specs/spec-registry.js';
import { UnreachableStore, demoTemplate, fakePdf, multipart, testApp } from './helpers.js';

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
  targetId: stage === 'published' ? 'default' : null,
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

  it('pages through results published in the same millisecond with a (time, id) cursor', async () => {
    const ctx = await testApp();
    const jobs = [
      await upload(ctx, 'tdemo', 'one.pdf'),
      await upload(ctx, 'tdemo', 'two.pdf'),
      await upload(ctx, 'tdemo', 'three.pdf'),
    ];
    for (const j of jobs) {
      publish(ctx, j.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    }
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 3; page++) {
      const rows = (await ctx.app.inject(`/api/results?limit=1${cursor}`)).json();
      expect(rows).toHaveLength(1);
      seen.push(rows[0].jobId);
      cursor = `&before=${encodeURIComponent(rows[0].publishedAt)}&beforeId=${rows[0].jobId}`;
    }
    expect(new Set(seen).size).toBe(3);
    expect((await ctx.app.inject(`/api/results?limit=1${cursor}`)).json()).toEqual([]);
  });

  it('compares the before cursor as a time, not text (timezone offsets)', async () => {
    const ctx = await testApp();
    const early = await upload(ctx, 'tdemo', 'early.pdf');
    const late = await upload(ctx, 'tdemo', 'late.pdf');
    publish(ctx, early.id, '2026-10-02T00:30:00.000Z', [out('document', 'published', null)]);
    publish(ctx, late.id, '2026-10-02T01:30:00.000Z', [out('document', 'published', null)]);
    // 01:00+01:00 is 00:00Z: both results are later, so nothing is before it.
    const rows = (
      await ctx.app.inject(`/api/results?before=${encodeURIComponent('2026-10-02T01:00:00+01:00')}`)
    ).json();
    expect(rows).toEqual([]);
  });

  it('shows reviewed, auto-approved or with-issues results only, with the other filters', async () => {
    const ctx = await testApp();
    const reviewed = await upload(ctx, 'tdemo', 'reviewed.pdf');
    const auto = await upload(ctx, 'tdemo', 'auto.pdf');
    const issues = await upload(ctx, 'tdemo', 'issues.pdf');
    const clean = await upload(ctx, 'tdemo', 'clean-issues.pdf');
    for (const id of [reviewed.id, issues.id]) {
      const job = ctx.repo.jobs.get(id)!;
      ctx.repo.jobs.set(id, { ...job, reviewer: 'Ken', reviewedAt: '2026-10-01T00:00:00.000Z' });
    }
    publish(ctx, reviewed.id, '2026-10-01T00:00:00.000Z', [out('document', 'published', null)]);
    publish(ctx, auto.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    publish(ctx, issues.id, '2026-10-03T00:00:00.000Z', [
      out('document', 'published', null),
      out('issues', 'published', 3),
    ]);
    // An issues output with no rows is not "with issues".
    publish(ctx, clean.id, '2026-10-04T00:00:00.000Z', [
      out('document', 'published', null),
      out('issues', 'published', 0),
    ]);
    const names = async (qs: string) =>
      (await ctx.app.inject(`/api/results?${qs}`))
        .json()
        .map((r: { filename: string }) => r.filename);
    expect(await names('show=reviewed')).toEqual(['issues.pdf', 'reviewed.pdf']);
    expect(await names('show=auto')).toEqual(['clean-issues.pdf', 'auto.pdf']);
    expect(await names('show=issues')).toEqual(['issues.pdf']);
    expect(await names('show=reviewed&q=rev')).toEqual(['reviewed.pdf']);
    expect((await ctx.app.inject('/api/results?show=everything')).statusCode).toBe(400);
  });

  it('validates the query', async () => {
    const { app } = await testApp();
    expect((await app.inject('/api/results?limit=0')).statusCode).toBe(400);
    expect((await app.inject('/api/results?limit=500')).statusCode).toBe(400);
    expect((await app.inject('/api/results?before=yesterday')).statusCode).toBe(400);
    expect((await app.inject('/api/results?beforeId=nope')).statusCode).toBe(400);
    expect((await app.inject(`/api/results?q=${'x'.repeat(101)}`)).statusCode).toBe(400);
  });

  it("lists each result's published outputs (name, format, rows), not drafts", async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-01T00:00:00.000Z', [
      out('results', 'published', 3),
      out('document', 'draft', null),
      out('document', 'published', null),
    ]);
    const [row] = (await ctx.app.inject('/api/results')).json();
    expect(row.outputs).toEqual([
      { outputId: 'document', format: 'json', name: 'doc.json', rowCount: null },
      { outputId: 'results', format: 'csv', name: 'doc.csv', rowCount: 3 },
    ]);
    expect(row.outputCount).toBe(2);
  });

  it('filters by file name, case-insensitively, with % and _ literal', async () => {
    const ctx = await testApp();
    const names = ['Acme_Invoice.pdf', 'acme-2.pdf', '100%.pdf', 'other.pdf'];
    for (const [i, name] of names.entries()) {
      const job = await upload(ctx, 'tdemo', name);
      publish(ctx, job.id, `2026-10-0${i + 1}T00:00:00.000Z`, [out('document', 'published', null)]);
    }
    const files = async (q: string) =>
      (await ctx.app.inject(`/api/results?q=${encodeURIComponent(q)}`))
        .json()
        .map((r: { filename: string }) => r.filename)
        .sort();
    expect(await files('ACME')).toEqual(['Acme_Invoice.pdf', 'acme-2.pdf']);
    expect(await files('_')).toEqual(['Acme_Invoice.pdf']);
    expect(await files('%')).toEqual(['100%.pdf']);
    expect(await files('  ')).toHaveLength(4);
  });

  it('pages with q and a cursor', async () => {
    const ctx = await testApp();
    for (const [i, name] of ['acme-1.pdf', 'other.pdf', 'acme-2.pdf'].entries()) {
      const job = await upload(ctx, 'tdemo', name);
      publish(ctx, job.id, `2026-10-0${i + 1}T00:00:00.000Z`, [out('document', 'published', null)]);
    }
    const page1 = (await ctx.app.inject('/api/results?q=acme&limit=1')).json();
    expect(page1.map((r: { filename: string }) => r.filename)).toEqual(['acme-2.pdf']);
    const cursor = `before=${encodeURIComponent(page1[0].publishedAt)}&beforeId=${page1[0].jobId}`;
    const page2 = (await ctx.app.inject(`/api/results?q=acme&limit=1&${cursor}`)).json();
    expect(page2.map((r: { filename: string }) => r.filename)).toEqual(['acme-1.pdf']);
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
    expect(body.target).toEqual({
      id: 'default',
      label: 'Default',
      bucket: 'published',
      prefix: 'pub/',
    });
    expect(body.publishedAt).toBe('2026-10-02T00:00:01.000Z');
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

  it("carries the recipe's ontology pins, prefixes and local terms, to name the graph's terms", async () => {
    const semantics = {
      ontologies: [{ id: 'acme', version: 2 }],
      prefixes: { acme: 'https://acme.example/def/' },
      document: { class: 'acme:Batch' },
      local: [{ iri: 'acme:lotCode', kind: 'datatype_property', label: 'Lot code' }],
    };
    const template = TemplateSchema.parse({ ...demoTemplate, semantics });
    const ctx = await testApp({
      specs: SpecRegistry.fromDefinitions([
        { kind: 'template', id: 'tdemo', version: 1, template },
      ]),
    });
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('results', 'published')]);
    const body = (await ctx.app.inject(`/api/results/${job.id}`)).json();
    expect(body.definition.semantics).toEqual({
      ontologies: [{ id: 'acme', version: 2 }],
      prefixes: { acme: 'https://acme.example/def/' },
      local: [{ iri: 'acme:lotCode', kind: 'datatype_property', label: 'Lot code' }],
    });
    // A recipe without a mapping has none.
    const plain = await testApp();
    const other = await upload(plain, 'tdemo', 'b.pdf');
    publish(plain, other.id, '2026-10-02T00:00:00.000Z', [out('results', 'published')]);
    expect(
      (await plain.app.inject(`/api/results/${other.id}`)).json().definition,
    ).not.toHaveProperty('semantics');
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

describe('GET /api/results/:jobId/archive', () => {
  const unzip = async (body: Buffer) => {
    const { unzipSync, strFromU8 } = await import('fflate');
    return Object.fromEntries(
      Object.entries(unzipSync(new Uint8Array(body))).map(([name, data]) => [
        name,
        strFromU8(data),
      ]),
    );
  };

  it('names the zip after a Word document without its extension', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'Batch 8.docx');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', { fields: {} });
    const res = await ctx.app.inject(`/api/results/${job.id}/archive`);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Batch 8\.zip"/);
  });

  it('zips every published output, one entry per output', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'Batch 7 – final.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [
      out('document', 'published', null),
      out('issues', 'published', 2),
      out('issues', 'draft', 2),
      {
        outputId: 'graph',
        stage: 'published',
        format: 'rdf',
        bucket: 'published',
        key: 'pub/tdemo/v1/graph/doc.ttl',
        rowCount: 1,
        targetId: 'default',
      },
    ]);
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', { fields: {} });
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/issues/doc.csv', 'a,b\n1,2\n');
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/graph/doc.ttl', '<a> <b> <c> .\n');

    const res = await ctx.app.inject(`/api/results/${job.id}/archive`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="Batch 7 _ final\.zip"/,
    );
    expect(res.headers['content-disposition']).toContain(
      "filename*=UTF-8''Batch%207%20%E2%80%93%20final.zip",
    );
    expect(await unzip(res.rawPayload)).toEqual({
      'document.json': '{"fields":{}}',
      'issues.csv': 'a,b\n1,2\n',
      'graph.ttl': '<a> <b> <c> .\n',
    });
  });

  it('is 404 for test runs, unpublished jobs and unknown ids', async () => {
    const ctx = await testApp();
    const draft = await upload(ctx, 'tdemo', 'draft.pdf');
    ctx.repo.outputs.set(draft.id, [out('document', 'draft', null)]);
    const test = await upload(ctx, 'tdemo', 'test.pdf');
    ctx.repo.jobs.set(test.id, { ...ctx.repo.jobs.get(test.id)!, test: true });
    publish(ctx, test.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    for (const id of [draft.id, test.id, '00000000-0000-4000-8000-000000000000', 'nope']) {
      expect((await ctx.app.inject(`/api/results/${id}/archive`)).statusCode).toBe(404);
    }
  });

  it('fails rather than sending a partial archive', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [
      out('document', 'published', null),
      out('issues', 'published', 2),
    ]);
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', { fields: {} });
    const missing = await ctx.app.inject(`/api/results/${job.id}/archive`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('output object missing from target');

    const down = await testApp({ targetStore: new UnreachableStore() });
    const other = await upload(down, 'tdemo', 'a.pdf');
    publish(down, other.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    const res = await down.app.inject(`/api/results/${other.id}/archive`);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('publishing target Default unavailable');
  });

  it('the archive still fails rather than sending a partial zip when the bridge read fails', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [
      out('document', 'published', null),
      out('issues', 'published', 2),
    ]);
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', { fields: {} });
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/issues/doc.csv', 'a,b\n');
    expect((await ctx.app.inject(`/api/results/${job.id}/archive`)).statusCode).toBe(200);
    ctx.bridge.failReads = new Error('the bridge could not be reached');
    const res = await ctx.app.inject(`/api/results/${job.id}/archive`);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('publishing target Default unavailable');
    expect(res.headers['content-type']).not.toBe('application/zip');
  });
});
