import { describe, expect, it, vi } from 'vitest';
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
  type ProposalView,
  type SampleView,
} from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';
import type { RemovedProject } from '../src/workbench/repo.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  /** A sample; its prepare job finishes (with prepared text) unless `ready` is false. */
  const add = async (n: number, ready = true) => {
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role: 'dev' }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    if (!ready) return s;
    const prep = ctx.repo.jobs.get(s.prepareJobId!)!;
    ctx.repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
    const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
    await ctx.store.put('runs', preparedTriageKey(s.sha256), json(triage), 'application/json');
    await ctx.store.put('runs', preparedTextKey(s.sha256), json({ pages: [] }), 'application/json');
    return s;
  };
  const remove = () => ctx.app.inject({ method: 'DELETE', url: '/api/workbench/projects/letter' });
  return { ...ctx, add, remove };
}

/** Every object key in the memory store, as `bucket/key`. */
const keys = (store: { objects: Map<string, unknown> }) => [...store.objects.keys()];

describe('DELETE /api/workbench/projects/:id', () => {
  it('deletes every row and internal file of an unpublished project', async () => {
    const ctx = await project();
    const { app, repo, store, templates, workbench, add, remove } = ctx;
    const ready = await add(1);
    const queued = await add(2, false);
    expect(repo.jobs.get(queued.prepareJobId!)!.status).toBe('queued');
    await app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/brief',
      payload: {
        purpose: 'Letters.',
        outputs: 'The sender.',
        exampleOutput: '',
        glossary: '',
        variants: '',
        rules: '',
        answers: [],
      },
    });
    await workbench.addSkip('letter', 'survey');
    await workbench.addConfirm('letter', 'outputs', '2026-10-13T09:00:00.000Z');

    // A draft job with its drafting object.
    const proposal = (
      await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/outputs' })
    ).json() as ProposalView;
    expect(repo.draftJobs.has(proposal.id)).toBe(true);
    await store.put('runs', draftingKey('letter', proposal.id), json({}), 'application/json');
    await store.put('runs', graphPreviewKey('letter', 'g1'), json({}), 'application/json');
    await store.put('runs', ontologySuggestionsKey('letter', 'sg1'), json({}), 'application/json');
    await repo.createSuggestJob('letter', {
      surveyProposalId: 'p1',
      candidates: [],
      library: [],
      pinned: [],
      dataPolicy: 'local',
    });

    // A verified reference and an evaluation iteration whose test run wrote a draft output.
    const source = await repo.createWorkbenchJob(
      {
        id: crypto.randomUUID(),
        filename: ready.filename,
        sha256: ready.sha256,
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
      name: ready.filename,
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
      },
    ]);
    repo.jobs.set(run.id, { ...run, status: 'succeeded' });
    await store.put('runs', `${run.id}/extract/attempt-1.json`, json({}), 'application/json');

    await workbench.createFeedback({
      projectId: 'letter',
      target: 'field',
      targetId: 'sender',
      sampleId: ready.id,
      iterationId: iteration.id,
      body: 'The sender is the letterhead.',
    });

    // A finished export with its zip.
    const exported = (
      await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/export' })
    ).json() as ExportView;
    const exportJob = repo.exportJobs.get(exported.jobId)!;
    repo.exportJobs.set(exported.jobId, { ...exportJob, status: 'succeeded' });
    await store.put(
      'runs',
      exportKey('letter', exported.jobId),
      Buffer.from('zip'),
      'application/zip',
    );

    const inbox = keys(store).filter((k) => k.startsWith('inbox/'));
    expect(inbox).toHaveLength(2);

    const res = await remove();
    expect(res.statusCode).toBe(204);

    expect((await app.inject('/api/workbench/projects/letter')).statusCode).toBe(404);
    expect((await templates.list()).filter((t) => t.id === 'letter')).toEqual([]);

    expect([...repo.jobs.values()].filter((j) => j.projectId === 'letter')).toEqual([]);
    expect([...repo.draftJobs.values()].filter((j) => j.projectId === 'letter')).toEqual([]);
    expect([...repo.exportJobs.values()].filter((j) => j.projectId === 'letter')).toEqual([]);
    expect([...repo.segmentJobs.values()].filter((j) => j.projectId === 'letter')).toEqual([]);
    expect(repo.outputs.has(run.id)).toBe(false);
    expect([...repo.references.values()].filter((r) => r.templateId === 'letter')).toEqual([]);
    expect([...repo.documents.values()].filter((d) => d.specId === 'letter')).toEqual([]);
    expect(repo.sampleDocuments.size).toBe(0);
    expect(workbench.projects.has('letter')).toBe(false);
    expect(await workbench.listConfirms('letter')).toEqual([]);
    for (const rows of [
      [...workbench.samples.values()],
      workbench.briefs,
      workbench.proposals,
      workbench.skips,
      workbench.confirms,
      workbench.iterations,
      workbench.publications,
      workbench.feedback,
    ]) {
      expect(rows.filter((r) => r.projectId === 'letter')).toEqual([]);
    }

    const left = keys(store);
    for (const key of inbox) expect(left).not.toContain(key);
    expect(left.filter((k) => k.startsWith('runs/drafting/letter/'))).toEqual([]);
    expect(left.filter((k) => k.startsWith('runs/exports/letter/'))).toEqual([]);
    expect(left.filter((k) => k.startsWith('runs/graphs/letter/'))).toEqual([]);
    expect(left.filter((k) => k.startsWith('runs/ontology-suggestions/letter/'))).toEqual([]);
    expect([...repo.suggestJobs.values()].filter((j) => j.projectId === 'letter')).toEqual([]);
    expect(left.filter((k) => k.startsWith(`runs/${run.id}/`))).toEqual([]);
    expect(left).not.toContain(`outputs/${draftKey}`);
    // The prepared text is a content cache keyed by sha256: kept.
    expect(left).toContain(`runs/${preparedTextKey(ready.sha256)}`);
  });

  it('refuses a published document type and removes nothing', async () => {
    const { app, repo, store, templates, workbench, add, remove } = await project();
    await add(1);
    await templates.publish('letter', 1);
    const jobs = repo.jobs.size;
    const objects = keys(store);

    const res = await remove();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      'letter has a published version; published document types keep their project',
    );
    expect((await app.inject('/api/workbench/projects/letter')).statusCode).toBe(200);
    expect(repo.jobs.size).toBe(jobs);
    expect(await workbench.listSamples('letter')).toHaveLength(1);
    expect(keys(store)).toEqual(objects);
    expect(await templates.get('letter', 1)).not.toBeNull();
  });

  it('answers 404 for an unknown project', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/workbench/projects/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('frees the id for a new project', async () => {
    const { app, add, remove } = await project();
    await add(1);
    expect((await remove()).statusCode).toBe(204);
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'letter', name: 'Letter again' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('keeps a sample PDF that another document row shares', async () => {
    const { repo, store, workbench, add, remove } = await project();
    const s = await add(1);
    const sample = (await workbench.listSamples('letter')).find((r) => r.id === s.id)!;
    const other = await repo.createDocumentAndJob(
      {
        id: crypto.randomUUID(),
        filename: 'shared.pdf',
        sha256: sample.sha256,
        sizeBytes: 1,
        specId: 'demo',
        specVersion: 1,
        bucket: sample.bucket,
        objectKey: sample.objectKey,
      },
      null,
    );

    expect((await remove()).statusCode).toBe(204);
    expect(keys(store)).toContain(`${sample.bucket}/${sample.objectKey}`);
    expect(repo.documents.has(other.documentId)).toBe(true);
    expect(repo.jobs.has(other.id)).toBe(true);
  });
});

describe('MemoryWorkbenchRepo.deleteProject', () => {
  const testDoc = (name: string) => ({
    id: crypto.randomUUID(),
    filename: `${name}.pdf`,
    sha256: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'),
    sizeBytes: 1,
    specId: 'letter',
    specVersion: 1,
    bucket: 'inbox',
    objectKey: `letter/v1/${name}.pdf`,
  });

  it('refuses a published type inside the repo and removes nothing', async () => {
    const { repo, templates, workbench, add } = await project();
    await add(1);
    await templates.create('letter', 2, letter(2), 'draft');
    await templates.publish('letter', 1);
    const jobs = repo.jobs.size;

    expect(await workbench.deleteProject('letter')).toBe('published');
    expect(workbench.projects.has('letter')).toBe(true);
    expect(repo.jobs.size).toBe(jobs);
    expect(await workbench.listSamples('letter')).toHaveLength(1);
    expect((await templates.list()).filter((t) => t.id === 'letter')).toHaveLength(2);
  });

  it('deletes the draft template rows and their change log with the project', async () => {
    const { templates, workbench } = await project();
    const change = {
      source: 'hand' as const,
      stage: null,
      proposalId: null,
      summary: 'Changed the name',
      diff: [],
      by: null,
    };
    await templates.create('letter', 2, letter(2), 'draft', change);
    await templates.create('other', 1, letter(1), 'draft', change);

    expect(await workbench.deleteProject('letter')).not.toBeNull();
    expect((await templates.list()).filter((t) => t.id === 'letter')).toEqual([]);
    expect(await templates.listChanges('letter', 2)).toEqual([]);
    expect(await templates.get('other', 1)).not.toBeNull();
    expect(await templates.listChanges('other', 1)).toHaveLength(1);
  });

  it('deletes the project-less test jobs of the type and their documents', async () => {
    const { repo, store, workbench, remove } = await project();
    const upload = testDoc('templates-page');
    await store.put('inbox', upload.objectKey, pdf(9), 'application/pdf');
    const testRun = await repo.createDocumentAndJob(upload, null, true);
    const production = await repo.createDocumentAndJob(testDoc('production'), null, false);
    const deleteProject = vi.spyOn(workbench, 'deleteProject');

    expect((await remove()).statusCode).toBe(204);
    const removed = (await deleteProject.mock.results[0]!.value) as RemovedProject;
    expect(removed.jobs.map((j) => j.jobId)).toContain(testRun.id);
    expect(removed.documents).toContainEqual({ bucket: 'inbox', key: upload.objectKey });
    expect(repo.jobs.has(testRun.id)).toBe(false);
    expect(repo.documents.has(testRun.documentId)).toBe(false);
    expect(keys(store)).not.toContain(`inbox/${upload.objectKey}`);
    // Only test jobs: anything else is not the project's to delete.
    expect(repo.jobs.has(production.id)).toBe(true);
    expect(repo.documents.has(production.documentId)).toBe(true);
  });

  it("clears other templates' references to a deleted source job", async () => {
    const { repo, workbench } = await project();
    const source = await repo.createWorkbenchJob(testDoc('source'), {
      projectId: 'letter',
      task: 'process',
    });
    const other = await repo.createDocumentAndJob({ ...testDoc('kept'), specId: 'demo' }, null);
    const kept = await repo.createReference({
      templateId: 'demo',
      name: 'kept',
      documentId: other.documentId,
      sourceJobId: source.id,
      expected: { fields: {}, tables: {} },
    });

    expect(await workbench.deleteProject('letter')).not.toBeNull();
    expect(repo.references.get(kept.id)).toMatchObject({ sourceJobId: null });
  });
});
