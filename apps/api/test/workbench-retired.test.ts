import { describe, expect, it } from 'vitest';
import { multipart, testApp } from './helpers.js';
import type { InjectOptions } from 'fastify';

const RETIRED = 'Letter is retired: unretire it to use it again';
const pdf = Buffer.from('%PDF-1.7\n% sample\n%%EOF\n');
const SID = '00000000-0000-4000-8000-000000000001';

async function retiredProject() {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.retire('letter', 'ken');
  const counts = () => ({
    jobs: ctx.repo.jobs.size,
    drafts: ctx.repo.draftJobs.size,
    samples: ctx.workbench.samples.size,
    iterations: ctx.workbench.iterations.length,
  });
  return { ...ctx, counts };
}

const P = '/api/workbench/projects/letter';

describe('Workbench work for a retired document type (D4)', () => {
  it.each([
    ['publish', { method: 'POST', url: `${P}/publish`, payload: {} }],
    ['dev test runs', { method: 'POST', url: `${P}/test-runs`, payload: {} }],
    ...['survey', 'outputs', 'sections', 'steps', 'references', 'revise'].map(
      (stage) =>
        [
          `the ${stage} stage`,
          { method: 'POST', url: `${P}/stages/${stage}`, payload: {} },
        ] as const,
    ),
    ['holdout reference runs', { method: 'POST', url: `${P}/holdout/reference-runs` }],
    ['a re-verify', { method: 'POST', url: `${P}/references/${SID}/run` }],
    ['an evaluation', { method: 'POST', url: `${P}/evaluations`, payload: {} }],
    ['a model comparison', { method: 'POST', url: `${P}/evaluations/compare`, payload: {} }],
  ] as const)('refuses %s with a 409 and queues nothing', async (_name, request) => {
    const ctx = await retiredProject();
    const before = ctx.counts();
    const res = await ctx.app.inject(request as InjectOptions);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(RETIRED);
    expect(ctx.counts()).toEqual(before);
  });

  it('refuses a sample upload before reading the file', async () => {
    const ctx = await retiredProject();
    const before = ctx.counts();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `${P}/samples`,
      ...multipart({ role: 'dev' }, { filename: 's.pdf', content: pdf }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(RETIRED);
    expect(ctx.counts()).toEqual(before);
  });

  it('refuses a project for a retired type that has none yet', async () => {
    const { app, templates } = await testApp();
    await templates.create('memo', 1, { id: 'memo', version: 1, name: 'Memo' }, 'published');
    await templates.retire('memo', null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'memo' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Memo is retired: unretire it to use it again');
    expect(await templates.list()).toHaveLength(1); // no next draft was opened
  });
});

describe('what a retired Workbench project still allows (D5)', () => {
  it.each([
    ['reading the project', { method: 'GET', url: P }],
    ['the overview', { method: 'GET', url: `${P}/overview` }],
    ['saving the brief', { method: 'PUT', url: `${P}/brief`, payload: { purpose: 'QA' } }],
    [
      'adding feedback',
      { method: 'POST', url: `${P}/feedback`, payload: { text: 'Dates are wrong' } },
    ],
    ['an anchor preview', { method: 'POST', url: `${P}/segmentations`, payload: {} }],
    ['a bundle export', { method: 'POST', url: `${P}/export` }],
    [
      'saving the draft',
      {
        method: 'PUT',
        url: '/api/templates/letter/versions/1',
        payload: { definition: { id: 'letter', version: 1, name: 'Letter' } },
      },
    ],
    ['deleting the project', { method: 'DELETE', url: P }],
  ] as const)('allows %s', async (_name, request) => {
    const ctx = await retiredProject();
    const res = await ctx.app.inject(request as InjectOptions);
    // Other refusals (no samples yet, …) are fine: only the retired one must not happen.
    const body = (res.body ? res.json() : {}) as { error?: unknown };
    expect(body.error ?? '').not.toBe(RETIRED);
    expect(res.statusCode).not.toBe(500);
  });
});
