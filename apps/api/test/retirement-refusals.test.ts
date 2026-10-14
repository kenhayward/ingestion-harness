import { describe, expect, it } from 'vitest';
import { stringify as toYaml } from 'yaml';
import { fakePdf, letter, multipart, testApp } from './helpers.js';

const RETIRED = 'Letter is retired: unretire it to use it again';

/** letter v1 published, v2 draft, one finished upload; then letter is retired. */
async function retired() {
  const ctx = await testApp();
  await ctx.templates.create('letter', 1, letter(1), 'published');
  await ctx.templates.create('letter', 2, letter(2), 'draft');
  const upload = await ctx.app.inject({
    method: 'POST',
    url: '/api/documents',
    ...multipart({ specId: 'letter' }, { filename: 'a.pdf', content: fakePdf }),
  });
  expect(upload.statusCode).toBe(201);
  const job = upload.json();
  ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status: 'failed' });
  await ctx.templates.retire('letter', 'ken');
  return { ...ctx, job };
}

describe('new work for a retired document type (D4)', () => {
  it.each([
    [
      'an upload',
      () => ({
        method: 'POST' as const,
        url: '/api/documents',
        ...multipart({ specId: 'letter' }, { filename: 'b.pdf', content: fakePdf }),
      }),
    ],
    [
      'a test run of the draft',
      () => ({
        method: 'POST' as const,
        url: '/api/documents',
        ...multipart(
          { specId: 'letter', specVersion: '2', test: 'true' },
          { filename: 'b.pdf', content: fakePdf },
        ),
      }),
    ],
    [
      'a new draft',
      () => ({ method: 'POST' as const, url: '/api/templates/letter/drafts', payload: {} }),
    ],
    [
      'publishing the draft',
      () => ({ method: 'POST' as const, url: '/api/templates/letter/versions/2/publish' }),
    ],
    [
      'a regression run',
      () => ({ method: 'POST' as const, url: '/api/templates/letter/versions/1/regression' }),
    ],
    [
      'a YAML import as a draft',
      () => ({
        method: 'POST' as const,
        url: '/api/templates/import',
        payload: { yaml: toYaml(letter(3)) },
      }),
    ],
    [
      'a YAML import published',
      () => ({
        method: 'POST' as const,
        url: '/api/templates/import',
        payload: { yaml: toYaml(letter(3)), publish: true },
      }),
    ],
  ])('refuses %s with a 409 and queues nothing', async (_name, request) => {
    const ctx = await retired();
    const count = async () => ({
      jobs: ctx.repo.jobs.size,
      versions: (await ctx.templates.list()).length,
      objects: ctx.store.objects.size, // an upload stores nothing on refusal
    });
    const before = await count();
    const res = await ctx.app.inject(request());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(RETIRED);
    expect(await count()).toEqual(before);
  });

  it('refuses a retry or re-process of an old job of the type', async () => {
    const { app, job, repo } = await retired();
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(RETIRED);
    expect(repo.jobs.get(job.id)?.status).toBe('failed');
  });

  it('refuses a new database type under a retired legacy id, named by its spec title', async () => {
    const { app, templates } = await testApp();
    await templates.retire('demo', null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { id: 'demo', name: 'Demo again' },
    });
    expect(res.statusCode).toBe(409);
    // The newest spec file's title (the test registry's newest demo spec is 'Demo v2').
    expect(res.json().error).toBe('Demo v2 is retired: unretire it to use it again');
    const upload = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo' }, { filename: 'b.pdf', content: fakePdf }),
    });
    expect(upload.statusCode).toBe(409);
  });
});

describe('what stays allowed for a retired document type (D5)', () => {
  it('saves and deletes the draft and reads versions', async () => {
    const { app } = await retired();
    const save = await app.inject({
      method: 'PUT',
      url: '/api/templates/letter/versions/2',
      payload: { definition: { ...letter(2), name: 'Letter' } },
    });
    expect(save.statusCode).toBe(200);
    expect((await app.inject('/api/templates/letter/versions/1')).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/templates/letter/versions/2' })).statusCode,
    ).toBe(204);
  });

  it('approves a production job already awaiting review: queued to publish and deliver (D5, decided)', async () => {
    const { app, job, repo } = await retired();
    expect(job.test).toBe(false); // a production upload, not a test run
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'awaiting_review' });
    const approve = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/approve`,
      payload: { reviewer: 'kh' },
    });
    expect(approve.statusCode).toBe(200);
    // The same as for an active type: the worker's publish task delivers it to the target.
    expect(approve.json()).toMatchObject({
      id: job.id,
      status: 'queued',
      task: 'publish',
      test: false,
      reviewer: 'kh',
    });
  });

  it('rejects a job of a retired type awaiting review', async () => {
    const { app, job, repo } = await retired();
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'awaiting_review' });
    const reject = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/reject`,
      payload: { reason: 'type retired' },
    });
    expect(reject.statusCode).toBe(200);
  });

  it('works again after an unretire', async () => {
    const { app } = await retired();
    await app.inject({ method: 'DELETE', url: '/api/specs/letter/retirement' });
    const upload = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'letter' }, { filename: 'c.pdf', content: fakePdf }),
    });
    expect(upload.statusCode).toBe(201);
  });
});
