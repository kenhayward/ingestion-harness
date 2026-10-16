import { describe, expect, it } from 'vitest';
import { graphPreviewKey, preparedTextKey, preparedTriageKey, type SampleView } from '@ih/shared';
import { SEGMENT_PRIORITY } from '../src/repositories/types.js';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

const SEMANTICS = {
  prefixes: { ex: 'https://ex.example/def/' },
  document: { class: 'ex:Letter' },
  local: [{ iri: 'ex:Letter', kind: 'class', label: 'Letter' }],
};
const mapped = { ...letter(1), semantics: SEMANTICS };

async function project({ base = true, definition = mapped as object } = {}) {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, definition as Record<string, unknown>);
  if (base) {
    await ctx.app.deps.linkedData.save(
      { customerName: 'Acme', customerSlug: 'acme', baseIri: null },
      'test',
    );
  }
  const add = async (n: number, role = 'dev') => {
    const sample = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    const job = ctx.repo.jobs.get(sample.prepareJobId!)!;
    ctx.repo.jobs.set(job.id, { ...job, status: 'succeeded' });
    const triage = { sha256: sample.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
    await ctx.store.put(
      'runs',
      preparedTriageKey(sample.sha256),
      Buffer.from(JSON.stringify(triage)),
      'application/json',
    );
    await ctx.store.put(
      'runs',
      preparedTextKey(sample.sha256),
      Buffer.from(
        JSON.stringify({ sha256: sample.sha256, pages: [{ number: 1, text: 'hi', ocr: false }] }),
      ),
      'application/json',
    );
    return sample;
  };
  /** A dev test run of the sample, finished with a draft document. */
  const runOf = async (sample: SampleView, status = 'succeeded') => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/test-runs',
      payload: { sampleIds: [sample.id] },
    });
    const { id } = (res.json().jobs as { id: string }[])[0]!;
    const job = ctx.repo.jobs.get(id)!;
    ctx.repo.jobs.set(id, { ...job, status: status as typeof job.status });
    ctx.repo.outputs.set(id, [
      {
        outputId: 'document',
        stage: 'draft',
        format: 'json',
        bucket: 'outputs',
        key: `letter/v1/document/${job.documentId}.json`,
        rowCount: null,
      },
    ]);
    return id;
  };
  const preview = (payload: object = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/graph-previews',
      payload,
    });
  return { ...ctx, add, runOf, preview };
}

describe('graph previews', () => {
  it('queues a preview of the newest finished run of each dev sample, with the draft', async () => {
    const { add, runOf, preview, repo } = await project();
    const s1 = await add(1);
    const s2 = await add(2);
    await add(3, 'holdout');
    await runOf(s1, 'succeeded');
    const newest = await runOf(s1, 'awaiting_review');
    await runOf(s2, 'running');

    const res = await preview();
    expect(res.statusCode).toBe(202);
    const view = res.json();
    expect(view).toMatchObject({ status: 'queued', error: null, result: null });
    const stored = repo.graphJobs.get(view.jobId)!;
    expect(repo.priorities.get(view.jobId)).toBe(SEGMENT_PRIORITY);
    expect(stored.params).toEqual({
      samples: [
        {
          sampleId: s1.id,
          jobId: newest,
          fileName: 's1.pdf',
          sha256: s1.sha256,
          documentKey: `letter/v1/document/${repo.jobs.get(newest)!.documentId}.json`,
        },
      ],
      definition: mapped,
    });
  });

  it('replaces the previous preview and deletes its result', async () => {
    const { add, runOf, preview, repo, store } = await project();
    await runOf(await add(1));
    const first = (await preview()).json().jobId as string;
    await store.put(
      'runs',
      graphPreviewKey('letter', first),
      Buffer.from('{}'),
      'application/json',
    );
    const second = (await preview()).json().jobId as string;
    expect(second).not.toBe(first);
    expect(repo.graphJobs.has(first)).toBe(false);
    expect(await store.get('runs', graphPreviewKey('letter', first))).toBeNull();
  });

  it.each<[string, object, number, string]>([
    [
      'without a base IRI',
      { base: false },
      409,
      'set the customer under Administration > Linked data',
    ],
    [
      'without a mapping',
      { definition: letter(1) },
      409,
      'the recipe has no ontology mapping: add one on the Mapping tab',
    ],
  ])('refuses %s', async (_name, options, status, error) => {
    const { add, runOf, preview } = await project(options);
    await runOf(await add(1));
    const res = await preview();
    expect(res.statusCode).toBe(status);
    expect(res.json().error).toBe(error);
  });

  it('refuses holdout samples, unknown samples and samples without a finished run', async () => {
    const { add, runOf, preview } = await project();
    const s1 = await add(1);
    const held = await add(2, 'holdout');
    const s3 = await add(3);
    await runOf(s1);
    await runOf(s3, 'queued');
    expect((await preview({ sampleIds: [held.id] })).json()).toEqual({
      error: 'graph previews use dev samples only',
    });
    expect(
      (await preview({ sampleIds: ['00000000-0000-4000-8000-000000000000'] })).statusCode,
    ).toBe(400);
    const none = await preview({ sampleIds: [s3.id] });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe('s3.pdf has no finished test run: run it first');
    expect((await preview({ sampleIds: [s1.id] })).statusCode).toBe(202);
  });

  it('refuses when no dev sample has a finished run', async () => {
    const { add, preview } = await project();
    await add(1);
    const res = await preview();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no finished test runs to preview: run the samples first');
  });

  it('returns the result once the worker wrote it', async () => {
    const { add, runOf, preview, repo, store, app } = await project();
    const s1 = await add(1);
    await runOf(s1);
    const jobId = (await preview()).json().jobId as string;
    const url = `/api/workbench/projects/letter/graph-previews/${jobId}`;
    expect((await app.inject(url)).json()).toMatchObject({ jobId, status: 'queued', result: null });

    const result = {
      samples: [
        {
          sampleId: s1.id,
          fileName: 's1.pdf',
          turtle: '<a> <b> <c> .\n',
          triples: 1,
          report: { conforms: true, results: [] },
        },
      ],
    };
    repo.graphJobs.set(jobId, { ...repo.graphJobs.get(jobId)!, status: 'succeeded' });
    await store.put(
      'runs',
      graphPreviewKey('letter', jobId),
      Buffer.from(JSON.stringify(result)),
      'application/json',
    );
    expect((await app.inject(url)).json()).toEqual({
      jobId,
      status: 'succeeded',
      error: null,
      result,
    });

    await store.delete('runs', graphPreviewKey('letter', jobId));
    expect((await app.inject(url)).json()).toMatchObject({ error: 'result missing', result: null });
    const missing = await app.inject(
      '/api/workbench/projects/letter/graph-previews/00000000-0000-4000-8000-000000000000',
    );
    expect(missing.statusCode).toBe(404);
  });
});
