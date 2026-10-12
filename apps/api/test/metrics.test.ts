import { randomUUID } from 'node:crypto';
import type { JobStatus } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof testApp>>;

async function job(
  ctx: Ctx,
  version: number,
  status: JobStatus,
  opts: { test?: boolean; reasons?: string[]; minutes?: number } = {},
) {
  const documentId = randomUUID();
  const created = await ctx.repo.createDocumentAndJob(
    {
      id: documentId,
      filename: 'x.pdf',
      sha256: 'x',
      sizeBytes: 1,
      specId: 'pvp',
      specVersion: version,
      bucket: 'inbox',
      objectKey: `pvp/${documentId}.pdf`,
    },
    null,
    opts.test ?? false,
  );
  const start = new Date('2026-10-09T10:00:00Z');
  const end = new Date(start.getTime() + (opts.minutes ?? 0) * 60_000);
  ctx.repo.jobs.set(created.id, {
    ...ctx.repo.jobs.get(created.id)!,
    status,
    reviewReasons: opts.reasons ?? null,
    createdAt: start.toISOString(),
    updatedAt: end.toISOString(),
  });
  return created.id;
}

const run = (stepId: string, extra: Record<string, unknown> = {}) => ({
  id: 1,
  stepId,
  trigger: 'process' as const,
  model: 'local/qwen',
  attempts: 1,
  inputTokens: 1000,
  outputTokens: 200,
  status: 'succeeded' as const,
  cached: false,
  error: null,
  startedAt: '2026-10-09T10:00:00Z',
  finishedAt: '2026-10-09T10:00:30Z',
  ...extra,
});

const edit = (target: Partial<{ field: string; table: string; row: number; column: string }>) => ({
  field: null,
  table: null,
  row: null,
  column: null,
  oldValue: null,
  newValue: 'x',
  editor: null,
  reason: null,
  ...target,
});

describe('GET /api/templates/:id/metrics', () => {
  it('aggregates jobs, reviews, edits and step runs per version and step', async () => {
    const ctx = await testApp();
    const a = await job(ctx, 3, 'succeeded', { reasons: ['2 unmatched'], minutes: 16 });
    const b = await job(ctx, 3, 'succeeded', { minutes: 2 });
    await job(ctx, 3, 'awaiting_review', { reasons: ['1 issue'] });
    await job(ctx, 4, 'succeeded', { test: true, minutes: 14 });

    await ctx.repo.addEdit(a, edit({ table: 'batches', row: 1, column: 'batch_number' }));
    await ctx.repo.addEdit(a, edit({ table: 'batches', row: 2, column: 'batch_number' }));
    await ctx.repo.addEdit(a, edit({ field: 'conclusion_date' }));
    ctx.repo.stepRuns.set(a, [
      run('test_results', {
        attempts: 14,
        outputTokens: 57000,
        finishedAt: '2026-10-09T10:07:00Z',
      }),
      run('outcome'),
      run('outcome', { trigger: 'rerun', attempts: 1 }),
    ]);
    ctx.repo.stepRuns.set(b, [
      run('test_results', { attempts: 16, outputTokens: 60000 }),
      run('outcome', { status: 'failed', error: 'x' }),
    ]);

    const res = await ctx.app.inject('/api/templates/pvp/metrics');
    expect(res.statusCode).toBe(200);
    const m = res.json();

    const v3 = m.versions.find((v: { version: number }) => v.version === 3);
    expect(v3).toMatchObject({
      jobs: 3,
      testJobs: 0,
      byStatus: { succeeded: 2, awaiting_review: 1 },
      reviewed: 2,
      reviewRate: 2 / 3,
      editsPerReviewed: 1.5,
      avgProcessingSeconds: 9 * 60, // succeeded jobs only: (16 + 2) / 2 minutes
    });
    expect(m.versions.find((v: { version: number }) => v.version === 4)).toMatchObject({
      jobs: 0,
      testJobs: 1,
    });

    const results = m.steps.find((s: { stepId: string }) => s.stepId === 'test_results');
    expect(results).toMatchObject({
      runs: 2,
      reruns: 0,
      failures: 0,
      avgAttempts: 15,
      avgOutputTokens: 58500,
    });
    expect(results.avgSeconds).toBe((7 * 60 + 30) / 2);
    expect(m.steps.find((s: { stepId: string }) => s.stepId === 'outcome')).toMatchObject({
      runs: 3,
      reruns: 1,
      failures: 1,
    });

    expect(m.topEdited).toEqual([
      { target: 'batches.batch_number', edits: 2 },
      { target: 'conclusion_date', edits: 1 },
    ]);
  });

  it('leaves cached step runs out of the step statistics (no model was called)', async () => {
    const ctx = await testApp();
    const a = await job(ctx, 1, 'succeeded', { test: true });
    const b = await job(ctx, 1, 'succeeded', { test: true });
    ctx.repo.stepRuns.set(a, [
      run('header', { attempts: 3, outputTokens: 300, finishedAt: '2026-10-09T10:01:00Z' }),
    ]);
    ctx.repo.stepRuns.set(b, [
      run('header', {
        cached: true,
        attempts: 0,
        inputTokens: null,
        outputTokens: null,
        finishedAt: '2026-10-09T10:00:00Z',
      }),
      run('only_cached', { cached: true, attempts: 0 }),
    ]);
    const m = (await ctx.app.inject('/api/templates/pvp/metrics')).json();
    expect(m.steps).toEqual([
      {
        stepId: 'header',
        runs: 1,
        reruns: 0,
        failures: 0,
        avgAttempts: 3,
        avgOutputTokens: 300,
        avgSeconds: 60,
      },
    ]);
  });

  it('does not count sample preparation jobs as test jobs', async () => {
    const ctx = await testApp();
    const id = await job(ctx, 1, 'succeeded', { test: true });
    ctx.repo.jobs.set(id, { ...ctx.repo.jobs.get(id)!, task: 'prepare' });
    await job(ctx, 1, 'succeeded', { test: true });
    const m = (await ctx.app.inject('/api/templates/pvp/metrics')).json();
    expect(m.versions.find((v: { version: number }) => v.version === 1)).toMatchObject({
      jobs: 0,
      testJobs: 1,
    });
  });

  it('is empty, not an error, for a type without jobs', async () => {
    const ctx = await testApp();
    const m = (await ctx.app.inject('/api/templates/none/metrics')).json();
    expect(m).toEqual({ templateId: 'none', versions: [], steps: [], topEdited: [] });
  });
});
