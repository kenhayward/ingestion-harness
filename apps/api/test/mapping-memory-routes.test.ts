import { describe, expect, it } from 'vitest';
import { draftingKey, type MappingMemoryDetail, type MappingMemoryPage } from '@ih/shared';
import { MemoryOntologyRepo } from '../src/ontologies/repo.js';
import { multipart, testApp } from './helpers.js';

const E = 'https://ex.example/v#';
const TTL = Buffer.from('@prefix owl: <http://www.w3.org/2002/07/owl#> .\n');

function definition(property = 'ex:batchNumber'): Record<string, unknown> {
  return {
    id: 'letter',
    version: 1,
    name: 'Letter',
    document: { sections: [{ id: 'all', anchor: '\\A' }] },
    outputs: { fields: [{ id: 'lot', name: 'Batch number', type: 'text' }] },
    pipeline: [{ type: 'extract', id: 'head', fields: ['lot'], sections: ['all'] }],
    semantics: {
      ontologies: [{ id: 'exo', version: 1 }],
      prefixes: { ex: E },
      document: { class: 'ex:Letter', iri: 'doc/{source}' },
      fields: { lot: { property } },
    },
  };
}

/** The definition before any mapping was accepted. */
function withoutMapping(definition: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(definition).filter(([k]) => k !== 'semantics'));
}

async function setup() {
  const ontologies = new MemoryOntologyRepo();
  const ctx = await testApp({ ontologies });
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/api/ontologies',
    ...multipart(
      { id: 'exo', label: 'Exo' },
      { filename: 'exo.ttl', content: TTL, contentType: 'text/turtle' },
    ),
  });
  expect(made.statusCode).toBe(202);
  ontologies.markReady('exo', 1);
  ontologies.seedTerms('exo', 1, [
    { iri: `${E}Letter`, kind: 'class', label: 'Letter' },
    {
      iri: `${E}batchNumber`,
      kind: 'datatype_property',
      label: 'batch number',
      altLabels: ['lot number'],
      definition: 'The identifier of a batch.',
    },
    { iri: `${E}lot`, kind: 'datatype_property', label: 'lot', deprecated: true },
  ]);
  // A draft without a mapping yet: saving one is the designer's acceptance.
  const plain = withoutMapping(definition());
  await ctx.templates.create('letter', 1, plain, 'draft');
  return ctx;
}

const save = (definition: Record<string, unknown>) => ({
  method: 'PUT' as const,
  url: '/api/templates/letter/versions/1',
  payload: { definition },
});

describe('capture through the routes', () => {
  it('a hand save of a recipe records its answers, labelled', async () => {
    const { app } = await setup();
    expect((await app.inject(save(definition()))).statusCode).toBe(200);
    const page = (await app.inject({ url: '/api/ontologies/memory' })).json<MappingMemoryPage>();
    const lot = page.entries.find((e) => e.name === 'Batch number')!;
    expect(lot).toMatchObject({
      answer: { form: 'literal', property: `${E}batchNumber` },
      votes: 1,
      status: 'learned',
      stale: null,
      recipes: [{ id: 'letter', path: 'lot', version: 1 }],
    });
    expect(page.labels[`${E}batchNumber`]).toEqual({
      label: 'batch number',
      kind: 'datatype_property',
      deprecated: false,
      ontology: 'exo@1',
      altLabels: ['lot number'],
      definition: 'The identifier of a batch.',
    });
  });

  it('says why an entry is stale', async () => {
    const { app } = await setup();
    await app.inject(save(definition('ex:lot')));
    const page = (
      await app.inject({ url: '/api/ontologies/memory?q=batch' })
    ).json<MappingMemoryPage>();
    expect(page.entries[0]!.stale).toBe('lot is deprecated in exo v1');
  });
});

describe('/api/ontologies/memory', () => {
  it('confirms, rejects and filters by status', async () => {
    const { app } = await setup();
    await app.inject(save(definition()));
    const [entry] = (
      await app.inject({ url: '/api/ontologies/memory?q=batch' })
    ).json<MappingMemoryPage>().entries;
    const confirmed = await app.inject({
      method: 'PATCH',
      url: `/api/ontologies/memory/${entry!.id}`,
      payload: { status: 'confirmed', note: 'Checked against the AFO guide.' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<MappingMemoryDetail>().entry).toMatchObject({
      status: 'confirmed',
      note: 'Checked against the AFO guide.',
    });
    const review = (
      await app.inject({ url: '/api/ontologies/memory?status=review' })
    ).json<MappingMemoryPage>();
    expect(review.entries.map((e) => e.name)).not.toContain('Batch number');
    const one = await app.inject({ url: `/api/ontologies/memory/${entry!.id}` });
    expect(one.json<MappingMemoryDetail>().entry.status).toBe('confirmed');
  });

  it('corrects an answer with library terms only', async () => {
    const { app } = await setup();
    await app.inject(save(definition()));
    const [entry] = (
      await app.inject({ url: '/api/ontologies/memory?q=batch' })
    ).json<MappingMemoryPage>().entries;
    const unknown = await app.inject({
      method: 'PATCH',
      url: `/api/ontologies/memory/${entry!.id}`,
      payload: { answer: { form: 'literal', property: 'https://nowhere.example/x' } },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe('not in the ontology library: https://nowhere.example/x');
    const fixed = await app.inject({
      method: 'PATCH',
      url: `/api/ontologies/memory/${entry!.id}`,
      payload: { answer: { form: 'literal', property: `${E}lot` } },
    });
    expect(fixed.json<MappingMemoryDetail>().entry).toMatchObject({ status: 'confirmed' });
  });

  it('adds an entry by hand, confirmed, and deletes it', async () => {
    const { app } = await setup();
    const added = await app.inject({
      method: 'POST',
      url: '/api/ontologies/memory',
      payload: {
        kind: 'column',
        name: 'Lot no.',
        type: 'text',
        answer: { form: 'literal', property: `${E}batchNumber` },
      },
    });
    expect(added.statusCode).toBe(201);
    const { entry } = added.json<MappingMemoryDetail>();
    expect(entry).toMatchObject({ status: 'confirmed', ontologies: ['exo'], votes: 0 });
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/ontologies/memory/${entry.id}` }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/ontologies/memory/${entry.id}` }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ url: `/api/ontologies/memory/${entry.id}` })).statusCode).toBe(404);
  });

  it('leaves out entries of ontologies no longer in the library', async () => {
    const { app, mappingMemory } = await setup();
    await mappingMemory.create(
      {
        kind: 'field',
        signatureKey: 'value|gone|text|',
        name: 'Gone',
        description: '',
        type: 'text',
        unit: '',
        answer: { form: 'literal', property: 'https://old.example/p' },
        ontologies: ['retired-one'],
        note: null,
        external: false,
      },
      'Ada',
    );
    const page = (await app.inject({ url: '/api/ontologies/memory' })).json<MappingMemoryPage>();
    expect(page.entries.map((e) => e.name)).not.toContain('Gone');
  });
});

describe('Workbench writes record the recipe', () => {
  async function project() {
    const ctx = await setup();
    await ctx.templates.deleteDraft('letter', 1);
    const made = await ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'letter', name: 'Letter' },
    });
    expect(made.statusCode).toBe(201);
    return ctx;
  }

  it('records a Workbench publish', async () => {
    const { app, templates, mappingMemory } = await project();
    await templates.updateDraft('letter', 1, definition()); // no change: records nothing
    expect((await mappingMemory.list({})).total).toBe(0);
    const published = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/publish',
      payload: {},
    });
    expect(published.statusCode).toBe(201);
    expect(mappingMemory.votes.some((v) => v.templateId === 'letter' && v.path === 'lot')).toBe(
      true,
    );
  });

  it('a reset of a project whose draft holds the mapping forgets the recipe', async () => {
    const { app, mappingMemory } = await project();
    expect((await app.inject(save(definition()))).statusCode).toBe(200);
    expect(mappingMemory.votes.some((v) => v.templateId === 'letter')).toBe(true);
    const reset = await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/reset' });
    expect(reset.statusCode).toBe(200);
    expect(mappingMemory.votes.filter((v) => v.templateId === 'letter')).toEqual([]);
  });

  it('a mapping decision marks the accepted remembered answers and refuses the others', async () => {
    const { app, repo, store, templates, workbench, mappingMemory } = await project();
    const twoFields: Record<string, unknown> = {
      ...definition(),
      outputs: {
        fields: [
          { id: 'lot', name: 'Batch number', type: 'text' },
          { id: 'maker', name: 'Maker', type: 'text' },
        ],
      },
      pipeline: [{ type: 'extract', id: 'head', fields: ['lot', 'maker'], sections: ['all'] }],
    };
    const plain = withoutMapping(twoFields);
    await templates.updateDraft('letter', 1, plain);
    const memo = (name: string, property: string) =>
      mappingMemory.create(
        {
          kind: 'field',
          signatureKey: `value|${name.toLowerCase()}|text|`,
          name,
          description: '',
          type: 'text',
          unit: '',
          answer: { form: 'literal', property },
          ontologies: ['exo'],
          note: null,
          external: false,
        },
        'Ada',
      );
    const lot = await memo('Batch number', `${E}batchNumber`);
    const maker = await memo('Maker', `${E}batchNumber`);
    const job = await repo.createDraftJob('letter', {});
    repo.draftJobs.set(job.id, { ...repo.draftJobs.get(job.id)!, status: 'succeeded' });
    await workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'mapping',
      briefVersion: null,
      baseVersion: 1,
      baseDefinition: plain,
    });
    const meta = (entryId: string) => ({ entryId, votes: 1, status: 'confirmed' as const });
    const body = {
      notes: '',
      changes: [
        {
          op: 'setDocumentMapping',
          document: { class: `${E}Letter`, iri: 'doc/{source}' },
          ontologies: [{ id: 'exo', version: 1 }],
          prefixes: { ex: E },
          reason: 'r',
        },
        {
          op: 'putFieldMapping',
          field: 'lot',
          mapping: { property: 'ex:batchNumber' },
          reason: 'Remembered',
          remembered: meta(lot.id),
        },
        {
          op: 'putFieldMapping',
          field: 'maker',
          mapping: { property: 'ex:batchNumber' },
          reason: 'Remembered',
          remembered: meta(maker.id),
        },
      ],
    };
    await store.put(
      'runs',
      draftingKey('letter', job.id),
      Buffer.from(
        JSON.stringify({
          stage: 'mapping',
          model: 'm',
          body,
          usage: { inputTokens: 1, outputTokens: 2 },
        }),
      ),
      'application/json',
    );
    const decided = await app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/proposals/${job.id}/decision`,
      payload: { decision: 'accepted', changes: [0, 1] },
    });
    expect(decided.statusCode).toBe(200);
    const vote = mappingMemory.votes.find((v) => v.templateId === 'letter' && v.path === 'lot');
    expect(vote).toMatchObject({ entryId: lot.id, originEntryId: lot.id });
    expect(await mappingMemory.get(maker.id)).toMatchObject({ refusals: 1 });
  });
});
