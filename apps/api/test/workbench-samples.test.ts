import { describe, expect, it } from 'vitest';
import { MAX_SAMPLES, preparedTextKey, preparedTriageKey, type SampleView } from '@ih/shared';
import { WORKBENCH_PRIORITY } from '../src/repositories/types.js';
import { multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

async function withProject(id = 'letter') {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id, name: 'Letter' },
  });
  const upload = async (content: Buffer, fields: Record<string, string> = {}, project = id) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/workbench/projects/${project}/samples`,
      ...multipart(fields, { filename: 'a.pdf', content }),
    });
  /** Simulate the worker finishing the sample's prepare job. */
  const prepared = async (sample: SampleView, pages = ['HEADER\nbody', 'page two']) => {
    ctx.repo.jobs.set(sample.prepareJobId!, {
      ...ctx.repo.jobs.get(sample.prepareJobId!)!,
      status: 'succeeded',
    });
    const text = {
      sha256: sample.sha256,
      pages: pages.map((t, i) => ({ number: i + 1, text: t, ocr: i === 1 })),
    };
    const triage = {
      sha256: sample.sha256,
      pageCount: pages.length,
      ocrPages: [2],
      chars: 18,
      ocrModel: 'local/olmocr',
    };
    await ctx.store.put(
      'runs',
      preparedTextKey(sample.sha256),
      Buffer.from(JSON.stringify(text)),
      'application/json',
    );
    await ctx.store.put(
      'runs',
      preparedTriageKey(sample.sha256),
      Buffer.from(JSON.stringify(triage)),
      'application/json',
    );
  };
  return { ...ctx, upload, prepared };
}

describe('workbench samples', () => {
  it('stores the PDF and queues its preparation behind production work', async () => {
    const { app, repo, store, upload } = await withProject();
    const res = await upload(pdf(1));
    expect(res.statusCode).toBe(201);
    const sample = res.json() as SampleView;
    expect(sample).toMatchObject({
      filename: 'a.pdf',
      role: 'dev',
      addedForVersion: 1,
      state: 'preparing',
      triage: null,
      error: null,
    });
    const job = repo.jobs.get(sample.prepareJobId!)!;
    expect(job).toMatchObject({ task: 'prepare', test: true, projectId: 'letter', specVersion: 1 });
    expect(repo.priorities.get(job.id)).toBe(WORKBENCH_PRIORITY);
    expect(await store.get('inbox', `letter/v1/${sample.documentId}.pdf`)).not.toBeNull();
    expect((await app.inject('/api/jobs')).json()).toEqual([]); // prepare jobs stay off the Jobs page
  });

  it('takes a holdout role at upload and rejects a bad one', async () => {
    const { upload } = await withProject();
    expect((await upload(pdf(1), { role: 'holdout' })).json().role).toBe('holdout');
    expect((await upload(pdf(2), { role: 'gold' })).statusCode).toBe(400);
  });

  it('refuses non-PDFs, duplicates, full projects and unknown projects', async () => {
    const { upload, store } = await withProject();
    expect((await upload(Buffer.from('hello'))).statusCode).toBe(415);
    expect((await upload(pdf(1))).statusCode).toBe(201);
    const duplicate = await upload(pdf(1));
    expect(duplicate.statusCode).toBe(409);
    expect(store.objects.size).toBe(1); // nothing stored for the refused uploads
    for (let n = 2; n <= MAX_SAMPLES; n++) expect((await upload(pdf(n))).statusCode).toBe(201);
    expect((await upload(pdf(99))).statusCode).toBe(409);
    expect((await upload(pdf(100), {}, 'nope')).statusCode).toBe(404);
  });

  it('allows the same PDF in two projects', async () => {
    const { app, upload } = await withProject();
    await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'memo', name: 'Memo' },
    });
    expect((await upload(pdf(1))).statusCode).toBe(201);
    expect((await upload(pdf(1), {}, 'memo')).statusCode).toBe(201);
  });

  it('shows triage and serves text once prepared', async () => {
    const { app, upload, prepared } = await withProject();
    const sample = (await upload(pdf(1))).json() as SampleView;
    const base = `/api/workbench/projects/letter/samples/${sample.id}`;
    expect((await app.inject(`${base}/text`)).statusCode).toBe(409);
    await prepared(sample);
    const [listed] = (await app.inject('/api/workbench/projects/letter/samples')).json();
    expect(listed).toMatchObject({ state: 'ready', triage: { pageCount: 2, ocrPages: [2] } });
    const text = (await app.inject(`${base}/text`)).json();
    expect(text.pages.map((p: { text: string }) => p.text)).toEqual(['HEADER\nbody', 'page two']);
  });

  it('reports a failed preparation with its error', async () => {
    const { app, repo, upload } = await withProject();
    const sample = (await upload(pdf(1))).json() as SampleView;
    repo.jobs.set(sample.prepareJobId!, {
      ...repo.jobs.get(sample.prepareJobId!)!,
      status: 'failed',
      error: 'OCR server unreachable',
    });
    const [listed] = (await app.inject('/api/workbench/projects/letter/samples')).json();
    expect(listed).toMatchObject({ state: 'failed', error: 'OCR server unreachable' });
  });

  it('changes roles and removes samples', async () => {
    const { app, upload } = await withProject();
    const sample = (await upload(pdf(1))).json() as SampleView;
    const url = `/api/workbench/projects/letter/samples/${sample.id}`;
    const patched = await app.inject({ method: 'PATCH', url, payload: { role: 'holdout' } });
    expect(patched.json()).toMatchObject({ role: 'holdout' });
    expect((await app.inject({ method: 'PATCH', url, payload: { role: 'x' } })).statusCode).toBe(
      400,
    );
    const missing = '/api/workbench/projects/letter/samples/not-a-uuid';
    expect(
      (await app.inject({ method: 'PATCH', url: missing, payload: { role: 'dev' } })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(404);
    expect((await app.inject('/api/workbench/projects/letter/samples')).json()).toEqual([]);
  });
});
