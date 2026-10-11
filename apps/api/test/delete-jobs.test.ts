import type { JobOutput, JobStatus } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import { fakePdf, multipart, testApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof testApp>>;

async function upload(ctx: Ctx, filename = 'a.pdf') {
  return (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'tdemo' }, { filename, content: fakePdf }),
    })
  ).json();
}

const draft = (jobId: string): JobOutput => ({
  outputId: 'document',
  stage: 'draft',
  format: 'json',
  bucket: 'outputs',
  key: `tdemo/v1/document/${jobId}.json`,
  rowCount: null,
});
const published = (jobId: string): JobOutput => ({
  outputId: 'document',
  stage: 'published',
  format: 'json',
  bucket: 'published',
  key: `pub/tdemo/v1/document/${jobId}.json`,
  rowCount: null,
});

/** A finished job with a draft, a published copy, run files and its inbox PDF in storage. */
async function finishedJob(ctx: Ctx, status: JobStatus = 'succeeded') {
  const job = await upload(ctx);
  ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status });
  ctx.repo.outputs.set(job.id, [draft(job.id), published(job.id)]);
  const json = (s: string) => Buffer.from(s);
  await ctx.store.put('outputs', draft(job.id).key, json('{}'), 'application/json');
  await ctx.targetStore.put('published', published(job.id).key, json('{}'), 'application/json');
  await ctx.store.put('runs', `${job.id}/head/attempt-1.json`, json('{}'), 'application/json');
  await ctx.store.put('runs', `${job.id}/pages/page-1.jpg`, json('x'), 'image/jpeg');
  await ctx.store.put('runs', 'ocr-cache/abc/p1.txt', json('x'), 'text/plain');
  const doc = ctx.repo.documents.get(job.documentId)!;
  return { job, doc };
}

const del = (ctx: Ctx, id: string) => ctx.app.inject({ method: 'DELETE', url: `/api/jobs/${id}` });

describe('DELETE /api/jobs/:id', () => {
  it('deletes the job, its document and internal files, keeping published copies and the OCR cache', async () => {
    const ctx = await testApp();
    const { job, doc } = await finishedJob(ctx);
    expect(await ctx.store.get(doc.bucket, doc.objectKey)).not.toBeNull();

    expect((await del(ctx, job.id)).statusCode).toBe(204);
    expect(ctx.repo.jobs.has(job.id)).toBe(false);
    expect(ctx.repo.documents.has(job.documentId)).toBe(false);
    expect(await ctx.store.get('outputs', draft(job.id).key)).toBeNull();
    expect(await ctx.store.get('runs', `${job.id}/pages/page-1.jpg`)).toBeNull();
    expect(await ctx.store.get('runs', `${job.id}/head/attempt-1.json`)).toBeNull();
    expect(await ctx.store.get(doc.bucket, doc.objectKey)).toBeNull();
    expect(await ctx.targetStore.get('published', published(job.id).key)).not.toBeNull();
    expect(await ctx.store.get('runs', 'ocr-cache/abc/p1.txt')).not.toBeNull();
  });

  it.each(['queued', 'running', 'awaiting_review'] as const)(
    'refuses to delete a %s job',
    async (status) => {
      const ctx = await testApp();
      const job = await upload(ctx);
      ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status });
      expect((await del(ctx, job.id)).statusCode).toBe(409);
      expect(ctx.repo.jobs.has(job.id)).toBe(true);
    },
  );

  it.each(['failed', 'needs_review', 'rejected', 'cancelled'] as const)(
    'deletes a %s job',
    async (status) => {
      const ctx = await testApp();
      const { job } = await finishedJob(ctx, status);
      expect((await del(ctx, job.id)).statusCode).toBe(204);
    },
  );

  it('keeps a PDF that another document row shares (regression runs)', async () => {
    const ctx = await testApp();
    const { job, doc } = await finishedJob(ctx);
    ctx.repo.documents.set('other-doc', { ...doc, id: 'other-doc' });
    await del(ctx, job.id);
    expect(await ctx.store.get(doc.bucket, doc.objectKey)).not.toBeNull();
  });

  it('keeps the document and PDF of a regression reference', async () => {
    const ctx = await testApp();
    const { job, doc } = await finishedJob(ctx);
    await ctx.repo.createReference({
      templateId: 'tdemo',
      name: 'ref',
      documentId: job.documentId,
      sourceJobId: job.id,
      expected: { fields: {}, tables: {} },
    });
    expect((await del(ctx, job.id)).statusCode).toBe(204);
    expect(ctx.repo.jobs.has(job.id)).toBe(false);
    expect(ctx.repo.documents.has(job.documentId)).toBe(true);
    expect(await ctx.store.get(doc.bucket, doc.objectKey)).not.toBeNull();
  });

  it('still deletes the job when storage clean-up fails', async () => {
    class BrokenDeletes extends MemoryObjectStore {
      override async delete(): Promise<void> {
        throw new Error('ECONNREFUSED');
      }
      override async deletePrefix(): Promise<number> {
        throw new Error('ECONNREFUSED');
      }
    }
    const ctx = await testApp({ store: new BrokenDeletes() });
    const job = await upload(ctx);
    ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status: 'failed' });
    expect((await del(ctx, job.id)).statusCode).toBe(204);
    expect(ctx.repo.jobs.has(job.id)).toBe(false);
  });

  it('404s for unknown ids', async () => {
    const ctx = await testApp();
    expect((await del(ctx, crypto.randomUUID())).statusCode).toBe(404);
    expect((await del(ctx, 'nope')).statusCode).toBe(404);
  });
});

describe('POST /api/jobs/cleanup', () => {
  async function aged(ctx: Ctx, status: JobStatus, daysAgo: number) {
    const job = await upload(ctx);
    const updatedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status, updatedAt });
    return job;
  }
  const cleanup = (ctx: Ctx, payload: unknown) =>
    ctx.app.inject({ method: 'POST', url: '/api/jobs/cleanup', payload: payload as object });

  it('previews and deletes finished jobs older than N days only', async () => {
    const ctx = await testApp();
    await aged(ctx, 'succeeded', 40);
    await aged(ctx, 'failed', 31);
    const recent = await aged(ctx, 'succeeded', 5);
    const oldRunning = await aged(ctx, 'running', 90);

    expect((await cleanup(ctx, { olderThanDays: 30, dryRun: true })).json()).toEqual({ count: 2 });
    expect(ctx.repo.jobs.size).toBe(4);

    expect((await cleanup(ctx, { olderThanDays: 30, dryRun: false })).json()).toEqual({
      deleted: 2,
    });
    expect([...ctx.repo.jobs.keys()].sort()).toEqual([recent.id, oldRunning.id].sort());
  });

  it('returns zero when nothing matches and validates input', async () => {
    const ctx = await testApp();
    await aged(ctx, 'succeeded', 1);
    expect((await cleanup(ctx, { olderThanDays: 30, dryRun: true })).json()).toEqual({ count: 0 });
    for (const payload of [
      { olderThanDays: 0, dryRun: true },
      { olderThanDays: 'x', dryRun: true },
      { olderThanDays: 30 },
    ]) {
      expect((await cleanup(ctx, payload)).statusCode).toBe(400);
    }
  });
});
