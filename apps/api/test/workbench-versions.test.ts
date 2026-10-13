import { describe, expect, it } from 'vitest';
import {
  outputKey,
  preparedTriageKey,
  type IterationView,
  type ReferenceRow,
  type SampleView,
  type StageView,
} from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const add = async (n: number, role = 'dev') => {
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    const prep = ctx.repo.jobs.get(s.prepareJobId!)!;
    ctx.repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
    const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
    await ctx.store.put(
      'runs',
      preparedTriageKey(s.sha256),
      Buffer.from(JSON.stringify(triage)),
      'application/json',
    );
    return s;
  };
  const skipAll = async () => {
    for (const stage of ['survey', 'outputs', 'sections', 'steps']) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/workbench/projects/letter/stages/${stage}/skip`,
      });
    }
  };
  const rows = async (set = 'dev') =>
    (
      await ctx.app.inject(`/api/workbench/projects/letter/references?set=${set}`)
    ).json() as ReferenceRow[];
  const stage = async () =>
    ((await ctx.app.inject('/api/workbench/projects/letter/stages')).json() as StageView[]).find(
      (s) => s.stage === 'references',
    );
  /** A verified reference for sample `s` at `version`, as Save as reference would pin it. */
  const verify = async (s: SampleView, version: number, name = s.filename) => {
    const doc = [...ctx.repo.documents.values()].find((d) => d.sha256 === s.sha256)!;
    const outputs = (await ctx.templates.get('letter', version))!.definition.outputs;
    return ctx.repo.createReference({
      templateId: 'letter',
      name,
      documentId: doc.id,
      sourceJobId: null,
      expected: { fields: { sender: 'Acme' }, tables: {} },
      templateVersion: version,
      verifiedOutputs: outputs,
    });
  };
  /** Publish v1 and open draft v2 (optionally with changed outputs and pipeline). */
  const nextVersion = async (outputs?: unknown, pipeline?: unknown) => {
    await ctx.templates.publish('letter', 1);
    await ctx.templates.create(
      'letter',
      2,
      { ...letter(2), ...(outputs ? { outputs } : {}), ...(pipeline ? { pipeline } : {}) },
      'draft',
    );
  };
  /** Finish an evaluation job with a draft document whose sender is Acme. */
  const finish = async (jobId: string, version: number) => {
    const job = ctx.repo.jobs.get(jobId)!;
    const key = outputKey('letter', version, 'document', job.documentId, 'json');
    await ctx.store.put(
      'outputs',
      key,
      Buffer.from(JSON.stringify({ fields: { sender: { value: 'Acme' } }, tables: {} })),
      'application/json',
    );
    ctx.repo.outputs.set(jobId, [
      {
        outputId: 'document',
        stage: 'draft',
        format: 'json',
        bucket: 'outputs',
        key,
        rowCount: null,
      },
    ]);
    ctx.repo.jobs.set(jobId, { ...job, status: 'succeeded' });
  };
  return { ...ctx, add, skipAll, rows, stage, verify, nextVersion, finish };
}

describe('references across versions (workbench)', () => {
  it('carries v1 references to draft v2; unchanged outputs keep them verified', async () => {
    const { add, skipAll, rows, stage, verify, nextVersion, repo } = await project();
    const s = await add(1);
    await skipAll();
    const v1 = await verify(s, 1);
    await nextVersion();
    const [row] = await rows();
    expect(row!.reference).toMatchObject({ version: 2, carriedFrom: 1, outdated: [] });
    expect(row!.reference!.id).not.toBe(v1.id);
    expect((await stage())!.state).toBe('accepted');
    expect((await repo.listReferences('letter', 1)).map((r) => r.id)).toEqual([v1.id]);
  });

  it('marks carried references outdated when outputs changed, and runs them again', async () => {
    const { app, add, skipAll, rows, stage, verify, nextVersion } = await project();
    const s = await add(1);
    await skipAll();
    await verify(s, 1);
    await nextVersion(
      {
        fields: [
          { id: 'sender', type: 'text' },
          { id: 'date', type: 'date' },
        ],
      },
      // the new field must be extracted, or the draft is not valid (400)
      [{ type: 'extract', id: 'head', fields: ['sender', 'date'], sections: ['all'] }],
    );
    const [row] = await rows();
    expect(row!.reference).toMatchObject({ version: 2, carriedFrom: 1, outdated: ['field:date'] });
    expect((await stage())!.state).not.toBe('accepted');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/stages/references',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().jobs).toHaveLength(1);
  });

  it('re-verifying replaces the outdated copy; v1 keeps its reference', async () => {
    const { add, skipAll, rows, verify, nextVersion, repo } = await project();
    const s = await add(1);
    await skipAll();
    const v1 = await verify(s, 1);
    await nextVersion({ fields: [{ id: 'sender', type: 'date' }] });
    await rows(); // carries forward
    const fresh = await verify(s, 2);
    const [row] = await rows();
    expect(row!.reference).toMatchObject({
      id: fresh.id,
      version: 2,
      carriedFrom: null,
      outdated: [],
    });
    expect((await repo.listReferences('letter', 1)).map((r) => r.id)).toEqual([v1.id]);
  });

  it('does not evaluate outdated references', async () => {
    const { app, add, skipAll, verify, nextVersion } = await project();
    const s = await add(1);
    await skipAll();
    await verify(s, 1);
    await nextVersion({ fields: [{ id: 'sender', type: 'date' }] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/evaluations',
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      'no verified references for the dev samples; verify some on the References tab first',
    );
  });

  it('samples added for v2 do not change v1 regression', async () => {
    const { app, add, skipAll, rows, verify, nextVersion } = await project();
    const s1 = await add(1);
    await skipAll();
    await verify(s1, 1);
    await nextVersion();
    await rows(); // opening the References tab carries v1's references to draft v2
    const s2 = await add(2);
    await verify(s2, 2);
    const v1 = await app.inject('/api/templates/letter/references?version=1');
    expect((v1.json() as { name: string }[]).map((r) => r.name)).toEqual(['s1.pdf']);
    const v2 = await app.inject('/api/templates/letter/references?version=2');
    expect((v2.json() as { name: string }[]).map((r) => r.name).sort()).toEqual([
      's1.pdf',
      's2.pdf',
    ]);
  });

  it("reuses a version's references when its draft is deleted and recreated", async () => {
    const { add, skipAll, rows, verify, nextVersion, templates } = await project();
    const s = await add(1);
    await skipAll();
    await verify(s, 1);
    await nextVersion();
    await rows();
    await templates.deleteDraft('letter', 2);
    await templates.create(
      'letter',
      2,
      { ...letter(2), outputs: { fields: [{ id: 'sender', type: 'date' }] } },
      'draft',
    );
    const [row] = await rows();
    expect(row!.reference).toMatchObject({
      version: 2,
      carriedFrom: 1,
      outdated: ['field:sender'],
    });
  });

  it("keeps an iteration's comparison after its reference is superseded", async () => {
    // Evaluate on draft v1, then re-verify the sample at v1: the iteration still shows a score.
    const { app, add, skipAll, verify, finish, repo } = await project();
    const s = await add(1);
    await skipAll();
    const ref = await verify(s, 1);
    const started = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/evaluations',
      payload: {},
    });
    expect(started.statusCode).toBe(201);
    const iteration = started.json() as IterationView;
    const [jobId] = (await repo.listProjectRuns('letter'))
      .filter((r) => r.job.referenceId === ref.id)
      .map((r) => r.job.id);
    await finish(jobId!, 1);

    await verify(s, 1, 'renamed'); // supersedes `ref`
    const view = (
      await app.inject(`/api/workbench/projects/letter/iterations/${iteration.id}`)
    ).json() as IterationView;
    expect(view.samples[0]!.comparison).toMatchObject({ score: 1 });
  });

  it('holdout: outdated references are run again and keep the publish gate closed', async () => {
    const { app, add, rows, verify, nextVersion, finish, repo } = await project();
    const a = await add(1, 'holdout');
    const b = await add(2, 'holdout');
    await verify(a, 1);
    await verify(b, 1);
    await nextVersion({ fields: [{ id: 'sender', type: 'date' }] });
    expect((await rows('holdout')).map((r) => r.reference!.outdated)).toEqual([
      ['field:sender'],
      ['field:sender'],
    ]);
    const fresh = await verify(a, 2); // only `a` re-verified for v2
    const runs = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/holdout/reference-runs',
    });
    expect(runs.statusCode).toBe(201);
    expect((runs.json().jobs as { documentId: string }[]).map((j) => j.documentId)).toHaveLength(1);

    const started = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/evaluations',
      payload: { set: 'holdout' },
    });
    expect(started.statusCode).toBe(201);
    expect((started.json() as IterationView).total).toBe(1);
    const [jobId] = (await repo.listProjectRuns('letter'))
      .filter((r) => r.job.referenceId === fresh.id)
      .map((r) => r.job.id);
    await finish(jobId!, 2);
    const gate = (await app.inject('/api/workbench/projects/letter/publish-gate')).json();
    expect(gate).toMatchObject({
      passes: false,
      reason: 'holdout evaluation covered 1 of 2 holdout samples',
    });
  });
});
