import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MemoryLlmConfigRepo } from '../src/llm/repo.js';
import { testApp } from './helpers.js';

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
  ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status });
  return { ...ctx, job };
}

const post = (url: string, payload: object) => ({ method: 'POST' as const, url, payload });

const offered = (ref: string, curated = true) => ({
  ref,
  provider: ref.split('/')[0]!,
  providerKind: 'openai-chat' as const,
  modelId: ref.slice(ref.indexOf('/') + 1),
  displayName: null,
  enabled: true,
  discoveredAt: '',
  curated,
});

describe('step runs and re-runs', () => {
  it('lists the recorded step runs of a job', async () => {
    const { app, repo, job } = await seed();
    repo.stepRuns.set(job.id, [
      {
        id: 1,
        stepId: 'data',
        trigger: 'process',
        model: 'local/qwen',
        attempts: 2,
        inputTokens: 900,
        outputTokens: 300,
        status: 'succeeded',
        cached: false,
        error: null,
        startedAt: '2026-10-09T10:00:00Z',
        finishedAt: '2026-10-09T10:01:00Z',
      },
    ]);
    const res = await app.inject(`/api/jobs/${job.id}/steps`);
    expect(res.json()).toMatchObject([{ stepId: 'data', model: 'local/qwen', attempts: 2 }]);
  });

  it('re-queues a single extract step with optional model and guidance', async () => {
    const { app, repo, job } = await seed();
    repo.models = [offered('other/better')];
    const res = await app.inject(
      post(`/api/jobs/${job.id}/steps/data/rerun`, {
        model: 'other/better',
        instructions: 'Results are numeric.',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'queued', task: 'rerun' });
  });

  it('passes page images for the model to read, and validates them', async () => {
    const { app, repo, job } = await seed();
    const res = await app.inject(
      post(`/api/jobs/${job.id}/steps/head/rerun`, { pageImages: [59] }),
    );
    expect(res.statusCode).toBe(200);
    expect(repo.reruns.get(job.id)).toEqual({ step: 'head', pageImages: [59] });
    const bad = await app.inject(post(`/api/jobs/${job.id}/steps/head/rerun`, { pageImages: [0] }));
    expect(bad.statusCode).toBe(400);
  });

  it.each([['nope', 400, 'no extract step']])('rejects step %s', async (step, code, message) => {
    const { app, job } = await seed();
    const res = await app.inject(post(`/api/jobs/${job.id}/steps/${step}/rerun`, {}));
    expect(res.statusCode).toBe(code);
    expect(res.json().error).toContain(message);
  });

  it('only re-runs steps of documents in review', async () => {
    const { app, job } = await seed('queued');
    expect((await app.inject(post(`/api/jobs/${job.id}/steps/data/rerun`, {}))).statusCode).toBe(
      409,
    );
  });

  it("refuses when a reviewer already edited that step's outputs", async () => {
    const { app, repo, job } = await seed();
    await repo.addEdit(job.id, {
      field: null,
      table: 'results',
      row: 1,
      column: 'value',
      oldValue: 1,
      newValue: 2,
      editor: null,
      reason: null,
    });
    const res = await app.inject(post(`/api/jobs/${job.id}/steps/data/rerun`, {}));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('edits');
    // other steps are still fine
    expect((await app.inject(post(`/api/jobs/${job.id}/steps/head/rerun`, {}))).statusCode).toBe(
      200,
    );
  });
});

describe('re-run models (only configured models run, ADR 0010)', () => {
  it.each([
    ['other/advertised', 'model other/advertised is not offered: add it on the Models page'],
    ['nope', 'unknown model choice nope'],
  ])('refuses %s', async (model, error) => {
    const { app, repo, job } = await seed();
    repo.models = [offered('other/better'), offered('other/advertised', false)];
    const res = await app.inject(post(`/api/jobs/${job.id}/steps/data/rerun`, { model }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
    expect(repo.jobs.get(job.id)!.status).toBe('awaiting_review');
  });

  it('accepts a model choice that points at an offered model', async () => {
    const { app, repo, job } = await seed();
    repo.models = [offered('other/better')];
    const { llm } = app.deps as unknown as { llm: MemoryLlmConfigRepo };
    llm.seedChoice({ id: 'fast', label: 'Fast', ref: 'other/better' });
    const res = await app.inject(post(`/api/jobs/${job.id}/steps/data/rerun`, { model: 'fast' }));
    expect(res.statusCode).toBe(200);
  });
});
