import type { JobOutput } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { fakePdf, multipart, testApp } from './helpers.js';

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
