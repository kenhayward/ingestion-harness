import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

const DRAFT = {
  document_id: 'filled-in-by-seed',
  fields: {
    product: { value: 'Richfer', evidence: 'Product: Richfer', page: 1 },
    executed_on: { value: '2023-02-16', evidence: 'Made 16/02/2023', page: 1 },
  },
  tables: {
    results: [
      { batch: 'G1', value: 137.8 },
      { batch: 'GX', value: 'Complies' },
    ],
  },
  checks: {},
  issues: [],
  review_required: true,
  review_reasons: ['1 normalisation issue(s)'],
};

/** A template job whose draft is waiting for review. */
async function seed(status: 'awaiting_review' | 'queued' = 'awaiting_review') {
  const ctx = await testApp();
  const documentId = randomUUID();
  const job = await ctx.repo.createDocumentAndJob(
    {
      id: documentId,
      filename: 'scan.pdf',
      sha256: 'x',
      sizeBytes: 1,
      specId: 'tdemo',
      specVersion: 1,
      bucket: 'inbox',
      objectKey: `tdemo/v1/${documentId}.pdf`,
    },
    null,
  );
  const key = `tdemo/v1/document/${documentId}.json`;
  await ctx.store.put(
    'outputs',
    key,
    Buffer.from(JSON.stringify({ ...DRAFT, document_id: documentId })),
    'application/json',
  );
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
  ctx.repo.jobs.set(job.id, {
    ...ctx.repo.jobs.get(job.id)!,
    status,
    reviewReasons: status === 'awaiting_review' ? DRAFT.review_reasons : null,
  });
  return { ...ctx, job };
}

const post = (url: string, payload: object) => ({ method: 'POST' as const, url, payload });

describe('GET /api/jobs/:id/review', () => {
  it('returns the draft document, the template and the edits so far', async () => {
    const { app, job } = await seed();
    const res = await app.inject(`/api/jobs/${job.id}/review`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.job.status).toBe('awaiting_review');
    expect(body.document.fields.product.value).toBe('Richfer');
    expect(body.template.outputs.tables[0].id).toBe('results');
    expect(body.edits).toEqual([]);
  });

  it('404s for jobs without a draft document', async () => {
    const { app, repo, job } = await seed();
    repo.outputs.set(job.id, []);
    expect((await app.inject(`/api/jobs/${job.id}/review`)).statusCode).toBe(404);
  });
});

describe('POST /api/jobs/:id/edits', () => {
  it('records field and cell edits with the value they replace', async () => {
    const { app, job } = await seed();
    const first = await app.inject(
      post(`/api/jobs/${job.id}/edits`, {
        field: 'executed_on',
        value: '17/02/2023',
        editor: 'kh',
      }),
    );
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      field: 'executed_on',
      oldValue: '2023-02-16',
      newValue: '17/02/2023',
      editor: 'kh',
    });

    const second = await app.inject(
      post(`/api/jobs/${job.id}/edits`, { field: 'executed_on', value: '18/02/2023' }),
    );
    expect(second.json().oldValue).toBe('17/02/2023'); // replaces the previous edit, not the draft

    const cell = await app.inject(
      post(`/api/jobs/${job.id}/edits`, {
        table: 'results',
        row: 2,
        column: 'value',
        value: '98.5',
      }),
    );
    expect(cell.json()).toMatchObject({
      table: 'results',
      row: 2,
      column: 'value',
      oldValue: 'Complies',
    });

    const review = (await app.inject(`/api/jobs/${job.id}/review`)).json();
    expect(review.edits).toHaveLength(3);
  });

  it.each([
    [{ field: 'nope', value: 1 }, 'unknown field'],
    [{ table: 'nope', row: 1, column: 'batch', value: 'x' }, 'unknown table'],
    [{ table: 'results', row: 1, column: 'nope', value: 'x' }, 'unknown column'],
    [{ table: 'results', row: 3, column: 'batch', value: 'x' }, 'row 3'],
    [{ value: 'x' }, 'invalid edit'],
  ])('rejects %j', async (payload, message) => {
    const { app, job } = await seed();
    const res = await app.inject(post(`/api/jobs/${job.id}/edits`, payload));
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(message);
  });

  it('only accepts edits while the job is awaiting review', async () => {
    const { app, job } = await seed('queued');
    const res = await app.inject(
      post(`/api/jobs/${job.id}/edits`, { field: 'product', value: 'x' }),
    );
    expect(res.statusCode).toBe(409);
  });
});

describe('approve / reject', () => {
  it('approval re-queues the job as a publish task with the reviewer recorded', async () => {
    const { app, job } = await seed();
    const res = await app.inject(
      post(`/api/jobs/${job.id}/approve`, { reviewer: 'kh', note: 'checked vs scan' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'queued',
      task: 'publish',
      reviewer: 'kh',
      reviewNote: 'checked vs scan',
    });
    expect(res.json().reviewedAt).toBeTruthy();
    // a second decision is a conflict
    expect((await app.inject(post(`/api/jobs/${job.id}/approve`, {}))).statusCode).toBe(409);
  });

  it('rejection needs a reason and is final', async () => {
    const { app, job } = await seed();
    expect((await app.inject(post(`/api/jobs/${job.id}/reject`, {}))).statusCode).toBe(400);
    const res = await app.inject(
      post(`/api/jobs/${job.id}/reject`, { reviewer: 'kh', reason: 'wrong document type' }),
    );
    expect(res.json()).toMatchObject({ status: 'rejected', reviewNote: 'wrong document type' });
    const edit = await app.inject(
      post(`/api/jobs/${job.id}/edits`, { field: 'product', value: 'x' }),
    );
    expect(edit.statusCode).toBe(409);
  });

  it('lists the review queue', async () => {
    const { app } = await seed();
    const queue = (await app.inject('/api/jobs?status=awaiting_review')).json();
    expect(queue).toHaveLength(1);
    expect(queue[0].reviewReasons).toEqual(['1 normalisation issue(s)']);
  });
});
