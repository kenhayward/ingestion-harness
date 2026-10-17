import { describe, expect, it } from 'vitest';
import {
  draftingKey,
  exportKey,
  graphPreviewKey,
  ontologySuggestionsKey,
  outputKey,
  preparedTextKey,
  preparedTriageKey,
  type ExportView,
  type IterationView,
  type ProjectView,
  type ProposalView,
  type SampleView,
} from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

const BRIEF = {
  purpose: 'Letters.',
  outputs: 'The sender.',
  exampleOutput: '',
  glossary: 'Sender: who signed it.',
  variants: '',
  rules: '',
  answers: [{ question: 'Is the sender always printed?', answer: 'Yes, top left.' }],
  ontologies: [{ ontologyId: 'acme', version: 1, role: 'vocabulary' }],
  ontologyGuidance: 'Prefer acme terms.',
};

/** A project with a sample, a brief, proposals, runs, a reference, feedback and an export. */
async function project() {
  const ctx = await testApp();
  const { app, repo, store, templates, workbench } = ctx;
  await app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await templates.updateDraft('letter', 1, {
    ...letter(1),
    delivery: { formats: ['csv', 'json', 'rdf'] },
    semantics: { document: { class: 'a:Letter' } },
  });
  const sample = (
    await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/samples',
      ...multipart({ role: 'dev' }, { filename: 's1.pdf', content: pdf(1) }),
    })
  ).json() as SampleView;
  const prep = repo.jobs.get(sample.prepareJobId!)!;
  repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
  const triage = { sha256: sample.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
  await store.put('runs', preparedTriageKey(sample.sha256), json(triage), 'application/json');
  await store.put('runs', preparedTextKey(sample.sha256), json({ pages: [] }), 'application/json');

  await workbench.saveBrief('letter', BRIEF as never);
  await workbench.addSkip('letter', 'survey');
  await workbench.addConfirm('letter', 'outputs', '2026-10-13T09:00:00.000Z');
  const proposal = (
    await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/outputs' })
  ).json() as ProposalView;
  await store.put('runs', draftingKey('letter', proposal.id), json({}), 'application/json');
  await store.put('runs', graphPreviewKey('letter', 'g1'), json({}), 'application/json');
  await store.put('runs', ontologySuggestionsKey('letter', 'sg1'), json({}), 'application/json');

  const source = await repo.createWorkbenchJob(
    {
      id: crypto.randomUUID(),
      filename: sample.filename,
      sha256: sample.sha256,
      sizeBytes: 1,
      specId: 'letter',
      specVersion: 1,
      bucket: 'inbox',
      objectKey: 'letter/v1/reference-source.pdf',
    },
    { projectId: 'letter', task: 'process' },
  );
  repo.jobs.set(source.id, { ...repo.jobs.get(source.id)!, status: 'succeeded' });
  await repo.createReference({
    templateId: 'letter',
    name: sample.filename,
    documentId: source.documentId,
    sourceJobId: source.id,
    expected: { fields: { sender: 'Acme' }, tables: {} },
  });
  const iteration = (
    await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/evaluations' })
  ).json() as IterationView;
  const [runId] = (await workbench.getIteration('letter', iteration.id))!.jobIds;
  const run = repo.jobs.get(runId!)!;
  const draftKey = outputKey('letter', 1, 'document', run.documentId, 'json');
  await store.put('outputs', draftKey, json({ fields: {}, tables: {} }), 'application/json');
  repo.outputs.set(run.id, [
    {
      outputId: 'document',
      stage: 'draft',
      format: 'json',
      bucket: 'outputs',
      key: draftKey,
      rowCount: null,
      targetId: null,
    },
  ]);
  repo.jobs.set(run.id, { ...run, status: 'succeeded' });
  await workbench.createFeedback({
    projectId: 'letter',
    target: 'field',
    targetId: 'sender',
    sampleId: sample.id,
    iterationId: iteration.id,
    body: 'The sender is the letterhead.',
  });
  const exported = (
    await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/export' })
  ).json() as ExportView;
  await store.put(
    'runs',
    exportKey('letter', exported.jobId),
    Buffer.from('zip'),
    'application/zip',
  );

  const reset = () => app.inject({ method: 'POST', url: '/api/workbench/projects/letter/reset' });
  return { ...ctx, sample, run, draftKey, reset };
}

const keys = (store: { objects: Map<string, unknown> }) => [...store.objects.keys()];

describe('POST /api/workbench/projects/:id/reset', () => {
  it('is 404 for an unknown project', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/workbench/projects/nope/reset' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project not found' });
  });

  it('keeps the samples and the written brief, and removes everything else', async () => {
    const ctx = await project();
    const { app, repo, store, templates, workbench, sample, run, draftKey, reset } = ctx;
    const inbox = keys(store).filter((k) => k.startsWith('inbox/'));

    const res = await reset();
    expect(res.statusCode).toBe(200);
    const view = res.json() as ProjectView;
    expect(view.draft).toBe(1);

    // The samples, ready as before (their prepare jobs and documents stay).
    const samples = (await app.inject('/api/workbench/projects/letter/samples')).json() as {
      id: string;
      state: string;
    }[];
    expect(samples).toEqual([expect.objectContaining({ id: sample.id, state: 'ready' })]);
    expect(repo.jobs.has(sample.prepareJobId!)).toBe(true);
    for (const key of inbox) expect(keys(store)).toContain(key);
    expect(keys(store)).toContain(`runs/${preparedTextKey(sample.sha256)}`);

    // The brief: one version with the written sections only.
    expect(workbench.briefs.filter((b) => b.projectId === 'letter')).toEqual([
      expect.objectContaining({
        version: 1,
        body: {
          ...BRIEF,
          answers: [],
          ontologies: [],
          ontologyGuidance: '',
        },
      }),
    ]);

    // The draft: an empty recipe of the same name and version, with a fresh change log.
    const draft = (await templates.get('letter', 1))!;
    expect(draft.status).toBe('draft');
    expect(draft.definition).toEqual({
      id: 'letter',
      version: 1,
      name: 'Letter',
      document: { ocr: 'auto', sections: [{ id: 'all', anchor: '\\A' }] },
      outputs: { fields: [], tables: [] },
      pipeline: [],
      review: { required: 'on_warnings' },
    });
    expect(await templates.listChanges('letter', 1)).toEqual([
      expect.objectContaining({ source: 'started', summary: 'Draft v1 reset' }),
    ]);

    // Everything else is gone.
    const ofLetter = <T extends { projectId: string | null }>(rows: Iterable<T>) =>
      [...rows].filter((r) => r.projectId === 'letter');
    expect(ofLetter(repo.jobs.values()).map((j) => j.id)).toEqual([sample.prepareJobId]);
    const others = [repo.draftJobs, repo.exportJobs, repo.segmentJobs, repo.suggestJobs];
    for (const jobs of others as Map<string, { projectId: string | null }>[]) {
      expect(ofLetter(jobs.values())).toEqual([]);
    }
    expect(repo.outputs.has(run.id)).toBe(false);
    expect([...repo.references.values()].filter((r) => r.templateId === 'letter')).toEqual([]);
    for (const rows of [
      workbench.proposals,
      workbench.skips,
      workbench.confirms,
      workbench.iterations,
      workbench.feedback,
    ] as { projectId: string }[][]) {
      expect(ofLetter(rows)).toEqual([]);
    }
    const left = keys(store);
    for (const prefix of ['drafting', 'exports', 'graphs', 'ontology-suggestions']) {
      expect(left.filter((k) => k.startsWith(`runs/${prefix}/letter/`))).toEqual([]);
    }
    expect(left).not.toContain(`outputs/${draftKey}`);

    // The overview starts again: the survey is the next thing to do.
    const overview = (await app.inject('/api/workbench/projects/letter/overview')).json() as {
      stages: { stage: string; state: string }[];
    };
    expect(overview.stages.find((s) => s.stage === 'survey')!.state).toBe('pending');
  });

  it('saves no brief when nothing was written', async () => {
    const ctx = await project();
    await ctx.workbench.saveBrief('letter', {
      ...BRIEF,
      purpose: '',
      outputs: '',
      glossary: '',
    } as never);
    expect((await ctx.reset()).statusCode).toBe(200);
    expect(ctx.workbench.briefs.filter((b) => b.projectId === 'letter')).toEqual([]);
  });

  it('resets only the open draft of a published type, keeping its publications', async () => {
    const ctx = await project();
    const { templates, workbench, reset } = ctx;
    const published = (await templates.get('letter', 1))!.definition;
    await templates.publish('letter', 1);
    await workbench.recordPublication({
      projectId: 'letter',
      version: 1,
      iterationId: null,
      score: null,
      threshold: 0.9,
      overrideReason: null,
      publishedBy: null,
    });
    await templates.create('letter', 2, { ...letter(2), name: 'Letter' }, 'draft');

    expect((await reset()).statusCode).toBe(200);
    expect((await templates.get('letter', 1))!.definition).toEqual(published);
    expect((await templates.get('letter', 2))!.definition).toMatchObject({
      version: 2,
      outputs: { fields: [], tables: [] },
    });
    expect(workbench.publications.filter((p) => p.projectId === 'letter')).toHaveLength(1);
  });
});
