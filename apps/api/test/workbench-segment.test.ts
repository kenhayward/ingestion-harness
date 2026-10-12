import { describe, expect, it } from 'vitest';
import { preparedTriageKey, segmentationKey, type SampleView } from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);
const doc = { sections: [{ id: 'all', anchor: '\\A' }] };

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const add = async (n: number, role = 'dev', ready = true) => {
    const sample = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    if (ready) {
      const job = ctx.repo.jobs.get(sample.prepareJobId!)!;
      ctx.repo.jobs.set(job.id, { ...job, status: 'succeeded' });
      const triage = {
        sha256: sample.sha256,
        pageCount: 1,
        ocrPages: [],
        chars: 5,
        ocrModel: null,
      };
      await ctx.store.put(
        'runs',
        preparedTriageKey(sample.sha256),
        Buffer.from(JSON.stringify(triage)),
        'application/json',
      );
    }
    return sample;
  };
  const start = (payload: object = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/segmentations',
      payload,
    });
  return { ...ctx, add, start };
}

describe('workbench segmentation', () => {
  it('queues a preview of the draft anchors over every prepared sample', async () => {
    const { repo, add, start } = await project();
    const dev = await add(1);
    const holdout = await add(2, 'holdout');
    await add(3, 'dev', false);
    const res = await start();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'queued', error: null, result: null });
    const stored = repo.segmentJobs.get(res.json().jobId)!;
    expect(stored.params.samples).toEqual([
      { sampleId: dev.id, sha256: dev.sha256 },
      { sampleId: holdout.id, sha256: holdout.sha256 },
    ]);
    expect(stored.params.document.sections).toEqual(
      letter(1).document.sections.map((s) => ({ ...s, required: true })),
    );
  });

  it('previews candidate anchors and validates them', async () => {
    const { repo, add, start } = await project();
    await add(1);
    const res = await start({ document: doc });
    expect(repo.segmentJobs.get(res.json().jobId)!.params.document).toEqual({
      sections: [{ id: 'all', anchor: '\\A', required: true }],
      pageMarkers: true,
    });
    expect((await start({ document: { sections: [] } })).statusCode).toBe(400);
  });

  it('refuses without prepared samples, and for unknown projects', async () => {
    const { app, add, start } = await project();
    await add(1, 'dev', false);
    expect((await start()).statusCode).toBe(409);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/nope/segmentations',
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('returns the grid once the worker has written it, and drops replaced previews', async () => {
    const { app, repo, store, add, start } = await project();
    const sample = await add(1);
    const first = (await start({ document: doc })).json().jobId as string;
    const grid = {
      anchorErrors: {},
      samples: [
        {
          sampleId: sample.id,
          firstPage: 1,
          pageCount: 1,
          error: null,
          missingRequired: [],
          sections: [{ id: 'all', found: true, page: 1, line: 'HEADER', chars: 10 }],
        },
      ],
    };
    repo.segmentJobs.set(first, { ...repo.segmentJobs.get(first)!, status: 'succeeded' });
    await store.put(
      'runs',
      segmentationKey('letter', first),
      Buffer.from(JSON.stringify(grid)),
      'application/json',
    );
    const url = (id: string) => `/api/workbench/projects/letter/segmentations/${id}`;
    expect((await app.inject(url(first))).json()).toEqual({
      jobId: first,
      status: 'succeeded',
      error: null,
      result: grid,
    });

    const second = (await start({ document: doc })).json().jobId as string;
    expect((await app.inject(url(first))).statusCode).toBe(404);
    expect(await store.get('runs', segmentationKey('letter', first))).toBeNull();
    expect((await app.inject(url(second))).json()).toMatchObject({
      status: 'queued',
      result: null,
    });
    expect((await app.inject(url('not-a-uuid'))).statusCode).toBe(404);
  });
});
