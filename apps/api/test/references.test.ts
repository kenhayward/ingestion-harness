import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

const definition = (version = 1, instructions = 'one') => ({
  id: 'letter',
  version,
  name: 'Letter',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: {
    fields: [{ id: 'sender', type: 'text' }],
    tables: [{ id: 'lines', columns: [{ id: 'item', type: 'text' }] }],
  },
  pipeline: [
    { type: 'extract', id: 'head', fields: ['sender'], sections: ['all'], instructions },
    { type: 'extract', id: 'rows', table: 'lines', sections: ['all'] },
  ],
});

const draftDocument = (sender: string, items: string[]) => ({
  fields: { sender: { value: sender, evidence: null, page: 1 } },
  tables: { lines: items.map((item) => ({ item })) },
  checks: {},
  issues: [],
});

/** A finished job of letter v1 with its draft document.json in the outputs bucket. */
async function processedJob(
  ctx: Awaited<ReturnType<typeof testApp>>,
  doc = draftDocument('ACME Ltd', ['bolts', 'nuts']),
  status: 'succeeded' | 'awaiting_review' = 'succeeded',
  version = 1,
) {
  const documentId = randomUUID();
  const job = await ctx.repo.createDocumentAndJob(
    {
      id: documentId,
      filename: 'letter.pdf',
      sha256: 'abc',
      sizeBytes: 10,
      specId: 'letter',
      specVersion: version,
      bucket: 'inbox',
      objectKey: `letter/v1/${documentId}.pdf`,
    },
    null,
  );
  const key = `letter/v${version}/document/${documentId}.json`;
  await ctx.store.put('outputs', key, Buffer.from(JSON.stringify(doc)), 'application/json');
  ctx.repo.outputs.set(job.id, [
    {
      outputId: 'document',
      stage: 'draft',
      format: 'json',
      bucket: 'outputs',
      key,
      rowCount: null,
    },
  ]);
  ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status });
  return job;
}

async function setup() {
  const ctx = await testApp();
  await ctx.templates.create('letter', 1, definition(1), 'published');
  await ctx.templates.create('letter', 2, definition(2, 'two'), 'draft');
  return ctx;
}

const post = (url: string, payload: object) => ({ method: 'POST' as const, url, payload });

describe('references', () => {
  it('saves a finished job as a reference, preferring the reviewed document', async () => {
    const ctx = await setup();
    const job = await processedJob(ctx);
    await ctx.store.put(
      'runs',
      `${job.id}/reviewed-document.json`,
      Buffer.from(JSON.stringify(draftDocument('ACME Limited', ['bolts', 'nuts']))),
      'application/json',
    );
    const res = await ctx.app.inject(
      post('/api/templates/letter/references', { jobId: job.id, name: 'acme-2023' }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: 'acme-2023',
      templateId: 'letter',
      sourceJobId: job.id,
      expected: {
        fields: { sender: 'ACME Limited' },
        tables: { lines: [{ item: 'bolts' }, { item: 'nuts' }] },
      },
    });
    expect((await ctx.app.inject('/api/templates/letter/references')).json()).toHaveLength(1);
    const dup = await ctx.app.inject(
      post('/api/templates/letter/references', { jobId: job.id, name: 'acme-2023' }),
    );
    expect(dup.statusCode).toBe(409);
  });

  it('only accepts finished jobs of the same document type', async () => {
    const ctx = await setup();
    const waiting = await processedJob(ctx, undefined, 'awaiting_review');
    const res = await ctx.app.inject(
      post('/api/templates/letter/references', { jobId: waiting.id, name: 'x' }),
    );
    expect(res.statusCode).toBe(400);
    const other = await ctx.app.inject(
      post('/api/templates/memo/references', { jobId: waiting.id, name: 'x' }),
    );
    expect(other.statusCode).toBe(404);
  });

  it('deletes references', async () => {
    const ctx = await setup();
    const job = await processedJob(ctx);
    const ref = (
      await ctx.app.inject(post('/api/templates/letter/references', { jobId: job.id, name: 'a' }))
    ).json();
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/templates/letter/references/${ref.id}`,
    });
    expect(res.statusCode).toBe(204);
    expect((await ctx.app.inject('/api/templates/letter/references')).json()).toEqual([]);
  });
});

describe('regression runs', () => {
  it('runs every reference against a version as test jobs and scores them', async () => {
    const ctx = await setup();
    const source = await processedJob(ctx);
    await ctx.app.inject(
      post('/api/templates/letter/references', { jobId: source.id, name: 'acme' }),
    );

    const started = await ctx.app.inject(post('/api/templates/letter/versions/2/regression', {}));
    expect(started.statusCode).toBe(201);
    const [run] = started.json().jobs;
    expect(run).toMatchObject({ specVersion: 2, test: true, status: 'queued' });
    expect(ctx.repo.documents.get(run.documentId)!.objectKey).toBe(
      ctx.repo.documents.get(source.documentId)!.objectKey,
    ); // same PDF, new document row for the draft version

    let report = (await ctx.app.inject('/api/templates/letter/versions/2/regression')).json();
    expect(report.items[0]).toMatchObject({
      reference: { name: 'acme' },
      job: { status: 'queued' },
      comparison: null,
    });

    // the worker finishes the test job with one changed value
    const key = `letter/v2/document/${run.documentId}.json`;
    await ctx.store.put(
      'outputs',
      key,
      Buffer.from(JSON.stringify(draftDocument('ACME Ltd', ['bolts']))),
      'application/json',
    );
    ctx.repo.outputs.set(run.id, [
      {
        outputId: 'document',
        stage: 'draft',
        format: 'json',
        bucket: 'outputs',
        key,
        rowCount: null,
      },
    ]);
    ctx.repo.jobs.set(run.id, { ...ctx.repo.jobs.get(run.id)!, status: 'succeeded' });

    report = (await ctx.app.inject('/api/templates/letter/versions/2/regression')).json();
    // sender matches; lines: 1 of 2 expected cells (one row missing) -> 2 of 3
    expect(report.items[0].comparison.score).toBeCloseTo(2 / 3);
    expect(report.items[0].comparison.tables[0].missing).toEqual([{ item: 'nuts' }]);
    expect(report.summary).toMatchObject({ references: 1, completed: 1 });
    expect(report.summary.averageScore).toBeCloseTo(2 / 3);
  });

  it('needs at least one reference', async () => {
    const ctx = await setup();
    const res = await ctx.app.inject(post('/api/templates/letter/versions/2/regression', {}));
    expect(res.statusCode).toBe(400);
  });
});

describe('version diff', () => {
  it('compares two versions structurally', async () => {
    const ctx = await setup();
    const res = await ctx.app.inject('/api/templates/letter/diff?from=1&to=2');
    expect(res.json().changes).toEqual([
      { kind: 'changed', path: 'pipeline[head].instructions', before: 'one', after: 'two' },
    ]);
    expect((await ctx.app.inject('/api/templates/letter/diff?from=1&to=9')).statusCode).toBe(404);
  });
});

describe('document type summaries (GET /api/templates)', () => {
  const summaryOf = async (ctx: Awaited<ReturnType<typeof testApp>>, id: string) =>
    (await ctx.app.inject('/api/templates')).json().find((t: { id: string }) => t.id === id)
      .summary;

  /** A finished regression run of letter v2 against the 'acme' reference, scoring `items`. */
  async function finishedRegression(ctx: Awaited<ReturnType<typeof testApp>>, items: string[]) {
    const source = await processedJob(ctx);
    await ctx.app.inject(
      post('/api/templates/letter/references', { jobId: source.id, name: 'acme' }),
    );
    const [run] = (
      await ctx.app.inject(post('/api/templates/letter/versions/2/regression', {}))
    ).json().jobs;
    const key = `letter/v2/document/${run.documentId}.json`;
    await ctx.store.put(
      'outputs',
      key,
      Buffer.from(JSON.stringify(draftDocument('ACME Ltd', items))),
      'application/json',
    );
    ctx.repo.outputs.set(run.id, [
      {
        outputId: 'document',
        stage: 'draft',
        format: 'json',
        bucket: 'outputs',
        key,
        rowCount: null,
      },
    ]);
    ctx.repo.jobs.set(run.id, {
      ...ctx.repo.jobs.get(run.id)!,
      status: 'succeeded',
      // An earlier run: a later re-run must sort after it even within the same millisecond.
      createdAt: '2026-10-12T09:00:00.000Z',
      updatedAt: '2026-10-12T10:00:00.000Z',
    });
  }

  it('summarises shape, references and draft issues', async () => {
    const ctx = await setup();
    expect(await summaryOf(ctx, 'letter')).toEqual({
      sections: 1,
      fields: 1,
      tables: 1,
      references: 0,
      draftIssues: 0,
      lastRegression: null,
      regressionRunning: false,
    });
  });

  it('says a re-run is in progress instead of scoring its unfinished jobs', async () => {
    const ctx = await setup();
    await finishedRegression(ctx, ['bolts', 'nuts']);
    await ctx.app.inject(post('/api/templates/letter/versions/2/regression', {}));
    expect(await summaryOf(ctx, 'letter')).toMatchObject({
      lastRegression: null,
      regressionRunning: true,
    });
  });

  it('reports the last regression of the version shown (draft first)', async () => {
    const ctx = await setup();
    await finishedRegression(ctx, ['bolts', 'nuts']);
    expect(await summaryOf(ctx, 'letter')).toMatchObject({
      references: 1,
      lastRegression: { version: 2, matched: 1, total: 1, at: '2026-10-12T10:00:00.000Z' },
    });
  });

  it('counts a reference with differences as not matched', async () => {
    const ctx = await setup();
    await finishedRegression(ctx, ['bolts']);
    expect((await summaryOf(ctx, 'letter')).lastRegression).toMatchObject({ matched: 0, total: 1 });
  });

  it('counts 0 for a malformed draft instead of failing the list', async () => {
    const ctx = await setup();
    await ctx.templates.create('memo', 1, { id: 'memo', version: 1, name: 'Memo' }, 'draft');
    const res = await ctx.app.inject('/api/templates');
    expect(res.statusCode).toBe(200);
    const memo = (await summaryOf(ctx, 'memo')) as { sections: number; draftIssues: number };
    expect(memo).toMatchObject({ sections: 0, fields: 0, tables: 0, references: 0 });
    expect(memo.draftIssues).toBeGreaterThan(0);
  });

  it('leaves lastRegression null when regression documents cannot be read', async () => {
    const ctx = await setup();
    await finishedRegression(ctx, ['bolts', 'nuts']);
    ctx.store.get = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const res = await ctx.app.inject('/api/templates');
    expect(res.statusCode).toBe(200);
    expect((await summaryOf(ctx, 'letter')).lastRegression).toBeNull();
  });
});

describe('references across versions', () => {
  const project = (ctx: Awaited<ReturnType<typeof setup>>) =>
    ctx.app.inject(post('/api/workbench/projects', { id: 'letter', name: 'Letter' }));

  it('pins a Workbench type reference to the job version and its outputs', async () => {
    const ctx = await setup();
    await project(ctx);
    const job = await processedJob(ctx, undefined, 'succeeded', 2);
    const res = await ctx.app.inject(
      post('/api/templates/letter/references', { jobId: job.id, name: 'r' }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      templateVersion: 2,
      verifiedOutputs: definition(2, 'two').outputs,
    });
    const v1 = await ctx.app.inject('/api/templates/letter/references?version=1');
    expect(v1.json()).toEqual([]);
    const v2 = await ctx.app.inject('/api/templates/letter/references?version=2');
    expect((v2.json() as { name: string }[]).map((r) => r.name)).toEqual(['r']);
  });

  it('carries the earlier version forward before pinning a save to a new version', async () => {
    const ctx = await setup();
    await project(ctx);
    const j1 = await processedJob(ctx, undefined, 'succeeded', 1);
    await ctx.repo.createReference({
      templateId: 'letter',
      name: 'v1',
      documentId: j1.documentId,
      sourceJobId: j1.id,
      expected: { fields: {}, tables: {} },
      templateVersion: 1,
      verifiedOutputs: definition(1).outputs,
    });
    const j2 = await processedJob(ctx, undefined, 'succeeded', 2);
    // processedJob always uses sha256 'abc'; a different PDF, or the save would supersede the copy
    const d2 = ctx.repo.documents.get(j2.documentId)!;
    ctx.repo.documents.set(d2.id, { ...d2, sha256: 'def' });
    const res = await ctx.app.inject(
      post('/api/templates/letter/references', { jobId: j2.id, name: 'v2' }),
    );
    expect(res.statusCode).toBe(201);
    const v2 = await ctx.app.inject('/api/templates/letter/references?version=2');
    expect((v2.json() as { name: string }[]).map((r) => r.name).sort()).toEqual(['v1', 'v2']);
  });

  it('leaves other types unpinned: a reference applies to every version', async () => {
    const ctx = await setup();
    const job = await processedJob(ctx, undefined, 'succeeded', 1);
    const res = await ctx.app.inject(
      post('/api/templates/letter/references', { jobId: job.id, name: 'r' }),
    );
    expect(res.json()).toMatchObject({ templateVersion: null, verifiedOutputs: null });
    const v2 = await ctx.app.inject('/api/templates/letter/references?version=2');
    expect((v2.json() as { name: string }[]).map((r) => r.name)).toEqual(['r']);
  });

  it('rejects a bad version query', async () => {
    const ctx = await setup();
    const res = await ctx.app.inject('/api/templates/letter/references?version=zero');
    expect(res.statusCode).toBe(400);
  });

  it('runs regression of a version on its own references only, leaving outdated ones out', async () => {
    const ctx = await setup();
    await project(ctx);
    const outputs = definition(1).outputs;
    const j1 = await processedJob(ctx, undefined, 'succeeded', 1);
    const j2 = await processedJob(ctx, undefined, 'succeeded', 2);
    await ctx.repo.createReference({
      templateId: 'letter',
      name: 'v1',
      documentId: j1.documentId,
      sourceJobId: j1.id,
      expected: { fields: {}, tables: {} },
      templateVersion: 1,
      verifiedOutputs: outputs,
    });
    await ctx.repo.createReference({
      templateId: 'letter',
      name: 'v2',
      documentId: j2.documentId,
      sourceJobId: j2.id,
      expected: { fields: {}, tables: {} },
      templateVersion: 2,
      verifiedOutputs: { fields: [{ id: 'gone' }], tables: [] }, // verified against other outputs
    });
    const r1 = await ctx.app.inject(post('/api/templates/letter/versions/1/regression', {}));
    expect(r1.statusCode).toBe(201);
    expect(r1.json().jobs).toHaveLength(1);
    const r2 = await ctx.app.inject(post('/api/templates/letter/versions/2/regression', {}));
    expect(r2.statusCode).toBe(400); // v2's only reference is outdated
    const report = await ctx.app.inject('/api/templates/letter/versions/1/regression');
    expect(report.json().summary.references).toBe(1);
    // the version listing is the regression set: outdated references are left out
    const listed = await ctx.app.inject('/api/templates/letter/references?version=2');
    expect(listed.json()).toEqual([]);
  });

  describe('the outputs a saved reference was verified against', () => {
    const save = (ctx: Awaited<ReturnType<typeof setup>>, jobId: string) =>
      ctx.app.inject(post('/api/templates/letter/references', { jobId, name: 'r' }));
    const backdate = (ctx: Awaited<ReturnType<typeof setup>>, jobId: string) =>
      ctx.repo.jobs.set(jobId, {
        ...ctx.repo.jobs.get(jobId)!,
        createdAt: '2000-01-01T00:00:00.000Z',
      });
    const changed = { fields: [{ id: 'sender', type: 'date' }], tables: [] };

    it("prefer the run's snapshot (params.outputs) over the draft", async () => {
      const ctx = await setup();
      await project(ctx);
      const job = await processedJob(ctx, undefined, 'succeeded', 2);
      ctx.repo.jobParams.set(job.id, { forceReview: true, outputs: changed });
      backdate(ctx, job.id); // the snapshot is trusted even after a draft edit
      await ctx.templates.updateDraft('letter', 2, definition(2, 'edited'));
      const res = await save(ctx, job.id);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ templateVersion: 2, verifiedOutputs: changed });
    });

    it('refuses a draft run without a snapshot when the draft changed after the run', async () => {
      const ctx = await setup();
      await project(ctx);
      const job = await processedJob(ctx, undefined, 'succeeded', 2);
      backdate(ctx, job.id);
      await ctx.templates.updateDraft('letter', 2, definition(2, 'edited'));
      const res = await save(ctx, job.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('the draft changed after this run; run it again');
      expect(await ctx.repo.listReferences('letter')).toEqual([]);
    });

    it("use a published version's outputs", async () => {
      const ctx = await setup();
      await project(ctx);
      const job = await processedJob(ctx, undefined, 'succeeded', 1);
      backdate(ctx, job.id); // a published version cannot change
      const res = await save(ctx, job.id);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        templateVersion: 1,
        verifiedOutputs: definition(1).outputs,
      });
    });

    it('never trust a run of a version that no longer exists', async () => {
      const ctx = await setup();
      await project(ctx);
      const job = await processedJob(ctx, undefined, 'succeeded', 3);
      const res = await save(ctx, job.id);
      expect(res.statusCode).toBe(201);
      expect(res.json().templateVersion).toBe(3);
      expect(res.json().verifiedOutputs).toEqual({});
      await ctx.templates.create('letter', 3, definition(3), 'draft');
      const listed = await ctx.app.inject('/api/templates/letter/references?version=3');
      expect(listed.json()).toEqual([]); // outdated: re-verify first
    });
  });
});
