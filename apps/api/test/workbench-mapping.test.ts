import { describe, expect, it } from 'vitest';
import {
  preparedTextKey,
  preparedTriageKey,
  reviewedDocumentKey,
  type BriefBody,
  type SampleView,
  type StageView,
} from '@ih/shared';
import { MemoryOntologyRepo } from '../src/ontologies/repo.js';
import { MAX_OBSERVED_VALUES, observedValues } from '../src/workbench/mapping.js';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);
const acme = { ontologyId: 'acme', version: 1, role: 'vocabulary' as const };

async function project() {
  const ontologies = new MemoryOntologyRepo();
  const ctx = await testApp({ ontologies });
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/ontologies',
    ...multipart(
      { id: 'acme', label: 'Acme terms' },
      { filename: 'acme.ttl', content: Buffer.from('# acme\n'), contentType: 'text/turtle' },
    ),
  });
  expect(res.statusCode).toBe(202);
  const brief = (body: Partial<BriefBody>) =>
    ctx.app.inject({ method: 'PUT', url: '/api/workbench/projects/letter/brief', payload: body });
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
    await ctx.store.put(
      'runs',
      preparedTextKey(s.sha256),
      Buffer.from(
        JSON.stringify({ sha256: s.sha256, pages: [{ number: 1, text: 'x', ocr: false }] }),
      ),
      'application/json',
    );
    return s;
  };
  /** A finished test run of the sample whose document says `sender`. */
  const run = async (s: SampleView, sender: string, reviewed = false) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/test-runs',
      payload: { sampleIds: [s.id] },
    });
    const { id } = (res.json().jobs as { id: string }[])[0]!;
    const job = ctx.repo.jobs.get(id)!;
    ctx.repo.jobs.set(id, { ...job, status: 'succeeded' });
    const key = `letter/v1/document/${job.documentId}.json`;
    ctx.repo.outputs.set(id, [
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
    const doc = {
      fields: { sender: { value: sender, evidence: `From: ${sender}`, page: 1 } },
      tables: {},
    };
    await ctx.store.put(
      reviewed ? 'runs' : 'outputs',
      reviewed ? reviewedDocumentKey(id) : key,
      Buffer.from(JSON.stringify(doc)),
      'application/json',
    );
    return id;
  };
  const skip = (stage: string) =>
    ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/stages/${stage}/skip` });
  const start = () =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/mapping' });
  const stages = async () =>
    (await ctx.app.inject('/api/workbench/projects/letter/stages')).json() as StageView[];
  return { ...ctx, ontologies, brief, add, run, skip, start, stages };
}

describe('the mapping stage (ADR 0011)', () => {
  it('refuses without vocabulary ontologies in the brief, before outputs, and on an unready version', async () => {
    const { brief, skip, start, ontologies } = await project();
    await brief({ purpose: 'Letters', ontologies: [{ ...acme, role: 'shapes' }] });
    expect((await start()).json()).toEqual({
      error: 'pin a vocabulary ontology on the Survey tab first',
    });
    await brief({ purpose: 'Letters', ontologies: [acme] });
    expect((await start()).json()).toEqual({ error: 'complete the outputs stage first' });
    await skip('survey');
    await skip('outputs');
    const unready = await start();
    expect(unready.statusCode).toBe(409);
    expect(unready.json()).toEqual({ error: 'ontology acme v1 is not ready' });
    ontologies.markReady('acme', 1);
    await brief({ purpose: 'Letters', ontologies: [{ ...acme, version: 9 }] });
    expect((await start()).json()).toEqual({ error: 'ontology acme v9 is not in the library' });
  });

  it('sends the brief vocabulary, the guidance and the values observed in dev runs', async () => {
    const { brief, skip, start, add, run, repo, ontologies } = await project();
    ontologies.markReady('acme', 1);
    await brief({ purpose: 'Letters', ontologies: [acme], ontologyGuidance: 'Prefer acme' });
    await skip('survey');
    await skip('outputs');
    const s1 = await add(1);
    const s2 = await add(2);
    await add(3, 'holdout');
    await run(s1, 'Acme Ltd', true);
    await run(s2, 'Acme Ltd');
    const res = await start();
    expect(res.statusCode).toBe(202);
    const params = repo.draftJobs.get(res.json().id)!.params;
    expect(params.stage).toBe('mapping');
    expect(params.mapping).toEqual({
      versions: [{ id: 'acme', version: 1, localOnly: false, label: 'Acme terms' }],
      guidance: 'Prefer acme',
      observed: {
        sender: [{ value: 'Acme Ltd', count: 2, snippet: 'From: Acme Ltd', sample: 's1.pdf' }],
      },
    });
  });

  it('keeps at most 20 distinct values per output, most frequent first, lists one per item', () => {
    const docs = Array.from({ length: 25 }, (_, n) => ({
      sample: `s${n}.pdf`,
      doc: {
        fields: { sender: { value: n < 3 ? 'Common' : `Name ${n}`, evidence: `From ${n}` } },
        tables: { lines: [{ sku: 'A1', tags: ['x', 'y'] }] },
      },
    }));
    const observed = observedValues(docs);
    expect(observed.sender).toHaveLength(MAX_OBSERVED_VALUES);
    expect(observed.sender![0]).toEqual({
      value: 'Common',
      count: 3,
      snippet: 'From 0',
      sample: 's0.pdf',
    });
    expect(observed['lines.sku']).toEqual([
      { value: 'A1', count: 25, snippet: null, sample: 's0.pdf' },
    ]);
    expect(observed['lines.tags']!.map((v) => v.value)).toEqual(['x', 'y']);
  });

  it('is stale after the outputs complete again, can be kept, then stale again', async () => {
    const { brief, skip, stages, workbench, app, ontologies } = await project();
    ontologies.markReady('acme', 1);
    await brief({ purpose: 'Letters', ontologies: [acme] });
    await skip('survey');
    await skip('outputs');
    expect((await stages()).find((s) => s.stage === 'mapping')?.state).toBe('pending');
    await skip('mapping');
    expect((await stages()).find((s) => s.stage === 'mapping')?.state).toBe('skipped');
    await new Promise((r) => setTimeout(r, 5));
    await skip('outputs');
    expect((await stages()).find((s) => s.stage === 'mapping')?.state).toBe('stale');
    const keep = () =>
      app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/mapping/confirm' });
    expect((await keep()).statusCode).toBe(201);
    expect((await stages()).find((s) => s.stage === 'mapping')?.state).toBe('skipped');
    expect((await keep()).json()).toEqual({ error: 'stage mapping is not stale' });
    await new Promise((r) => setTimeout(r, 5));
    await brief({ purpose: 'Letters', ontologies: [acme], ontologyGuidance: 'new' });
    expect((await stages()).find((s) => s.stage === 'mapping')?.state).toBe('stale');
    expect((await workbench.listConfirms('letter')).map((c) => c.stage)).toEqual(['mapping']);
  });

  it('shows in the overview, not used without ontologies, and with its figures', async () => {
    const { app, brief, ontologies, templates } = await project();
    const overview = async () =>
      (await app.inject('/api/workbench/projects/letter/overview')).json() as {
        stages: { stage: string; state: string; status: string; metrics: { value: string }[] }[];
      };
    // RDF on (Outputs tab), so what is missing is the vocabulary.
    await templates.updateDraft('letter', 1, {
      ...letter(1),
      delivery: { formats: ['csv', 'json', 'rdf'] },
    });
    let item = (await overview()).stages.find((i) => i.stage === 'mapping')!;
    expect(item).toMatchObject({
      state: 'skipped',
      status: 'Not used: no vocabulary is pinned on Survey',
    });
    ontologies.markReady('acme', 1);
    await brief({ purpose: 'Letters', ontologies: [acme] });
    await templates.updateDraft('letter', 1, {
      ...letter(1),
      semantics: {
        prefixes: { a: 'https://a.example/' },
        document: { class: 'a:L' },
        fields: { sender: { property: 'a:s' } },
      },
    });
    item = (await overview()).stages.find((i) => i.stage === 'mapping')!;
    expect(item.state).toBe('pending');
    expect(item.metrics.map((m) => m.value)).toEqual(['1 / 1', '1']);
  });

  it('queues embeddings for brief versions the embedding model has not embedded, once', async () => {
    const { brief, skip, start, ontologies, llm } = await project();
    llm.seedSettings({ embedding_model: 'local/nomic' });
    ontologies.markReady('acme', 1);
    await brief({ purpose: 'Letters', ontologies: [acme] });
    await skip('survey');
    await skip('outputs');
    expect((await start()).statusCode).toBe(202);
    expect(ontologies.embedJobs).toEqual([
      { ontologyId: 'acme', version: 1, model: 'local/nomic' },
    ]);
    await start();
    expect(ontologies.embedJobs).toHaveLength(1); // already queued
  });
});
