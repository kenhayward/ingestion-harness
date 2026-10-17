import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  outputKey,
  preparedTriageKey,
  type ComparisonView,
  type IterationView,
  type SampleView,
} from '@ih/shared';
import { accessApp, letter, multipart, seedModelChoices, testApp } from './helpers.js';

const fakePdf = Buffer.from('%PDF-1.7\n%%EOF\n');

/** ADR 0010, phase 4c: people pick a model choice, by label, everywhere a model is chosen. */
describe('model choices for everyone', () => {
  it('lists the choices people may pick, with their location, for any signed-in user', async () => {
    const ctx = await accessApp();
    seedModelChoices(ctx);
    const res = await ctx.app.inject({
      url: '/api/models/choices',
      headers: { cookie: ctx.userCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      choices: [
        {
          id: 'main',
          label: 'Main Production Model',
          description: '',
          ref: 'local/qwen',
          location: 'local',
          isDefault: true,
        },
        expect.objectContaining({ id: 'cloud', location: 'external', isDefault: false }),
        expect.objectContaining({ id: 'fast', label: 'Fast model', ref: 'local/small' }),
      ],
    });
  });
});

describe('a job model is a model choice', () => {
  const upload = (ctx: Awaited<ReturnType<typeof testApp>>, model: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo', model }, { filename: 'a.pdf', content: fakePdf }),
    });

  it.each(['fast', 'default'])('uploads with the choice %s', async (model) => {
    const ctx = await testApp();
    seedModelChoices(ctx);
    const res = await upload(ctx, model);
    expect(res.statusCode).toBe(201);
    expect(res.json().modelOverride).toBe(model);
  });

  it('refuses a name that is no model choice', async () => {
    const ctx = await testApp();
    seedModelChoices(ctx);
    const res = await upload(ctx, 'nope');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown model choice nope');
    // The drafting model belongs to the pipeline: no job may name it.
    expect((await upload(ctx, 'draft')).json().error).toBe('unknown model choice draft');
  });

  it('retries with a model choice', async () => {
    const ctx = await testApp();
    seedModelChoices(ctx);
    const job = await ctx.repo.createDocumentAndJob(
      {
        id: randomUUID(),
        filename: 'a.pdf',
        sha256: 'x',
        sizeBytes: 1,
        specId: 'demo',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: 'demo/v1/a.pdf',
      },
      null,
    );
    ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status: 'failed' });
    const retry = (model: string) =>
      ctx.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry`, payload: { model } });
    expect((await retry('nope')).json().error).toBe('unknown model choice nope');
    const res = await retry('cloud');
    expect(res.statusCode).toBe(200);
    expect(res.json().modelOverride).toBe('cloud');
  });
});

/** A local-only project with one verified dev reference. */
async function project() {
  const ctx = await testApp();
  seedModelChoices(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const s = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/samples',
      ...multipart({ role: 'dev' }, { filename: 's1.pdf', content: fakePdf }),
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
  const job = await ctx.repo.createWorkbenchJob(
    {
      id: randomUUID(),
      filename: s.filename,
      sha256: s.sha256,
      sizeBytes: 1,
      specId: 'letter',
      specVersion: 1,
      bucket: 'inbox',
      objectKey: `letter/${s.id}`,
    },
    { projectId: 'letter', task: 'process' },
  );
  await ctx.repo.createReference({
    templateId: 'letter',
    name: s.filename,
    documentId: job.documentId,
    sourceJobId: job.id,
    expected: { fields: { sender: 'Acme' }, tables: {} },
  });
  const post = (url: string, payload: object) =>
    ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter${url}`, payload });
  return { ...ctx, post };
}

describe('Workbench evaluations pick model choices', () => {
  it('evaluates with any model choice', async () => {
    const { post } = await project();
    const res = await post('/evaluations', { model: 'fast' });
    expect(res.statusCode).toBe(201);
    expect((res.json() as IterationView).model).toBe('fast');
  });

  it('refuses a name that is no choice, and an external choice for a local-only project', async () => {
    const { post, workbench } = await project();
    expect((await post('/evaluations', { model: 'draft' })).json().error).toBe(
      'unknown model choice draft',
    );
    const external = await post('/evaluations', { model: 'cloud' });
    expect(external.statusCode).toBe(400);
    expect(external.json().error).toBe(
      'Cloud model runs on an external endpoint: this project is local-only',
    );
    expect(await workbench.listIterations('letter')).toEqual([]);
  });

  it('compares the choices asked for, in that order', async () => {
    const { post, app } = await project();
    const res = await post('/evaluations/compare', { models: ['fast', 'main'] });
    expect(res.statusCode).toBe(201);
    const comparison = res.json() as ComparisonView;
    expect(comparison.iterations.map((i) => i.model)).toEqual(['fast', 'main']);
    const again = (
      await app.inject(`/api/workbench/projects/letter/comparisons/${comparison.groupId}`)
    ).json() as ComparisonView;
    expect(again.iterations.map((i) => i.model)).toEqual(['fast', 'main']);
  });

  it('compares every choice the project may use when none are named', async () => {
    const { post } = await project();
    const comparison = (await post('/evaluations/compare', {})).json() as ComparisonView;
    // The default first, then by label; the external choice is left out of a local project.
    expect(comparison.iterations.map((i) => i.model)).toEqual(['main', 'fast']);
  });

  it.each([
    [{ models: ['main'] }, 'compare at least two model choices'],
    [{ models: ['main', 'main'] }, 'compare at least two model choices'],
    [
      { models: ['main', 'cloud'] },
      'Cloud model runs on an external endpoint: this project is local-only',
    ],
    [{ models: ['main', 'nope'] }, 'unknown model choice nope'],
  ])('refuses the comparison %o', async (body, error) => {
    const { post, workbench } = await project();
    const res = await post('/evaluations/compare', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
    expect(await workbench.listIterations('letter')).toEqual([]);
  });

  it('scores a comparison member like any iteration', async () => {
    const { post, repo, store, app } = await project();
    const comparison = (
      await post('/evaluations/compare', { models: ['main', 'fast'] })
    ).json() as ComparisonView;
    for (const run of (await repo.listProjectRuns('letter')).filter((r) => r.job.referenceId)) {
      const key = outputKey('letter', 1, 'document', run.job.documentId, 'json');
      await store.put(
        'outputs',
        key,
        Buffer.from(JSON.stringify({ fields: { sender: { value: 'Acme' } }, tables: {} })),
        'application/json',
      );
      repo.outputs.set(run.job.id, [
        {
          outputId: 'document',
          stage: 'draft',
          format: 'json',
          bucket: 'outputs',
          key,
          rowCount: null,
          targetId: null,
        },
      ]);
      repo.jobs.set(run.job.id, { ...run.job, status: 'succeeded' });
    }
    const view = (
      await app.inject(`/api/workbench/projects/letter/comparisons/${comparison.groupId}`)
    ).json() as ComparisonView;
    expect(view.iterations.map((i) => [i.model, i.score])).toEqual([
      ['main', 1],
      ['fast', 1],
    ]);
  });
});

describe('template steps name model choices', () => {
  const withModel = (model: string, version = 1) => ({
    ...letter(version),
    pipeline: [{ type: 'extract', id: 'head', fields: ['sender'], sections: ['all'], model }],
  });

  it('flags a draft step naming a model instead of a choice, and refuses to publish it', async () => {
    const ctx = await testApp();
    seedModelChoices(ctx);
    await ctx.templates.create('letter', 1, withModel('local/qwen'), 'draft');
    const view = await ctx.app.inject('/api/templates/letter/versions/1');
    expect(view.json().issues).toEqual([
      {
        path: 'pipeline.0.model',
        message: 'step "head": pick a model choice instead of the model local/qwen',
      },
    ]);
    const publish = await ctx.app.inject({
      method: 'POST',
      url: '/api/templates/letter/versions/1/publish',
    });
    expect(publish.statusCode).toBe(400);
  });

  it('keeps running a published step that names a model (legacy)', async () => {
    const ctx = await testApp();
    seedModelChoices(ctx);
    await ctx.templates.create('letter', 1, withModel('local/qwen'), 'published');
    expect((await ctx.app.inject('/api/templates/letter/versions/1')).json().issues).toEqual([]);
  });

  it('accepts a draft step naming a choice', async () => {
    const ctx = await testApp();
    seedModelChoices(ctx);
    await ctx.templates.create('letter', 1, withModel('fast'), 'draft');
    expect((await ctx.app.inject('/api/templates/letter/versions/1')).json().issues).toEqual([]);
  });
});

describe('Workbench dev test runs pick a model choice (phase 4d)', () => {
  it('runs the draft with the choice picked, or the template models without one', async () => {
    const { post, repo } = await project();
    const res = await post('/test-runs', { model: 'fast' });
    expect(res.statusCode).toBe(201);
    expect(res.json().jobs.map((j: { modelOverride: string | null }) => j.modelOverride)).toEqual([
      'fast',
    ]);
    const plain = await post('/test-runs', {});
    expect(plain.json().jobs[0].modelOverride).toBeNull();
    expect(repo.jobs.size).toBeGreaterThan(0);
  });

  it('refuses a name that is no choice, or an external one for a local-only project', async () => {
    const { post } = await project();
    expect((await post('/test-runs', { model: 'nope' })).json().error).toBe(
      'unknown model choice nope',
    );
    const external = await post('/test-runs', { model: 'cloud' });
    expect(external.statusCode).toBe(400);
    expect(external.json().error).toBe(
      'Cloud model runs on an external endpoint: this project is local-only',
    );
  });
});

describe('the document type model (inherited by steps naming none)', () => {
  const withTypeModel = (model: string) => ({ ...letter(1), model });

  it('checks it like a step model: a choice, never a raw model in a draft', async () => {
    const ctx = await testApp();
    seedModelChoices(ctx);
    ctx.llm.seedChoice({ id: 'gone', label: 'Gone', ref: 'ryzen/other' });
    await ctx.templates.create('letter', 1, withTypeModel('local/qwen'), 'draft');
    const issuesOf = async () =>
      (await ctx.app.inject('/api/templates/letter/versions/1')).json().issues;
    expect(await issuesOf()).toEqual([
      { path: 'model', message: 'pick a model choice instead of the model local/qwen' },
    ]);
    await ctx.templates.updateDraft('letter', 1, withTypeModel('gone'));
    expect(await issuesOf()).toEqual([
      {
        path: 'model',
        message:
          'model choice gone uses ryzen/other, which is not offered: add it under Administration > Models',
      },
    ]);
    await ctx.templates.updateDraft('letter', 1, withTypeModel('fast'));
    expect(await issuesOf()).toEqual([]);
  });
  it('lists it with the document types, for the pickers', async () => {
    const ctx = await testApp();
    await ctx.templates.create('letter', 1, withTypeModel('fast'), 'published');
    await ctx.templates.create('memo', 1, { ...letter(1), id: 'memo' }, 'published');
    const specs = (await ctx.app.inject('/api/specs')).json() as { id: string; model?: string }[];
    expect(specs.find((s) => s.id === 'letter')?.model).toBe('fast');
    expect(specs.find((s) => s.id === 'memo')).not.toHaveProperty('model');
    expect(specs.find((s) => s.id === 'demo')).not.toHaveProperty('model'); // spec.yaml
  });
});
