import { describe, expect, it } from 'vitest';
import { preparedTriageKey, type ReferenceRow, type SampleView, type StageView } from '@ih/shared';
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
  const propose = () =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/references' });
  const rows = async () =>
    (await ctx.app.inject('/api/workbench/projects/letter/references')).json() as ReferenceRow[];
  const stage = async () =>
    ((await ctx.app.inject('/api/workbench/projects/letter/stages')).json() as StageView[]).find(
      (s) => s.stage === 'references',
    );
  return { ...ctx, add, skipAll, propose, rows, stage };
}

describe('references stage', () => {
  it('waits for the earlier stages', async () => {
    const { add, propose } = await project();
    await add(1);
    const res = await propose();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('finish the survey stage first (accept or skip it)');
  });

  it('runs the draft model on dev samples without a reference, carrying the data policy', async () => {
    const { add, skipAll, propose, repo, rows, stage } = await project();
    const dev = await add(1);
    await add(2, 'holdout');
    await skipAll();
    expect((await stage())!.state).toBe('pending');
    const res = await propose();
    expect(res.statusCode).toBe(201);
    const [job] = res.json().jobs as {
      id: string;
      modelOverride: string;
      referenceId: string | null;
    }[];
    expect(job).toMatchObject({ modelOverride: 'draft', referenceId: null });
    expect(repo.jobParams.get(job!.id)).toEqual({ dataPolicy: 'local' });
    expect((await stage())!.state).toBe('running');
    expect(await rows()).toEqual([
      {
        sampleId: dev.id,
        filename: 's1.pdf',
        sha256: dev.sha256,
        reference: null,
        run: { jobId: job!.id, status: 'queued', error: null, modelOverride: 'draft' },
      },
    ]);
  });

  it('is accepted once every dev sample has a reference, and refuses to propose again', async () => {
    const { add, skipAll, propose, repo, rows, stage } = await project();
    await add(1);
    await skipAll();
    const [job] = (await propose()).json().jobs as { id: string; documentId: string }[];
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'succeeded' });
    await repo.createReference({
      templateId: 'letter',
      name: 's1',
      documentId: job!.documentId,
      sourceJobId: job!.id,
      expected: { fields: { sender: 'Acme' }, tables: {} },
    });
    expect((await rows())[0]!.reference).toMatchObject({ name: 's1' });
    expect((await stage())!.state).toBe('accepted');
    const again = await propose();
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('every dev sample already has a reference');
  });

  it('can be skipped', async () => {
    const { app, add, skipAll, stage } = await project();
    await add(1);
    await skipAll();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/stages/references/skip',
    });
    expect(res.statusCode).toBe(201);
    expect((await stage())!.state).toBe('skipped');
  });
});
