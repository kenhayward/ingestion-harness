import { describe, expect, it } from 'vitest';
import type { TemplateChangeInput } from '@ih/shared';
import {
  reconcileAll,
  recordRecipe,
  rememberingTemplates,
  votesOf,
  type CaptureDeps,
} from '../src/mapping-memory/capture.js';
import { MemoryMappingMemoryRepo } from '../src/mapping-memory/repo.js';
import { MemoryTemplateRepo } from '../src/templates/repo.js';

const change = (source: TemplateChangeInput['source']): TemplateChangeInput => ({
  source,
  stage: null,
  proposalId: null,
  summary: source,
  diff: [],
  by: 'Ken',
});

function definition(property = 'ex:batchNumber', version = 1): Record<string, unknown> {
  return {
    id: 'letter',
    version,
    name: 'Letter',
    outputs: { fields: [{ id: 'lot', name: 'Batch number', type: 'text' }] },
    semantics: {
      ontologies: [{ id: 'exo', version: 1 }],
      prefixes: { ex: 'https://ex.example/v#' },
      document: { class: 'ex:Letter', iri: 'doc/{source}' },
      fields: { lot: { property } },
    },
  };
}

function setup(policy: 'local' | 'external' | null = null) {
  const inner = new MemoryTemplateRepo();
  const memory = new MemoryMappingMemoryRepo();
  const deps: CaptureDeps = { templates: inner, memory, policyOf: async () => policy };
  const templates = rememberingTemplates(inner, (id, by) =>
    recordRecipe(deps, id, by).then(() => {}),
  );
  return { inner, memory, deps, templates };
}

const lotAnswers = async (memory: MemoryMappingMemoryRepo) =>
  (await memory.list({})).entries
    .filter((e) => e.name === 'Batch number')
    .map((e) => [e.answer, e.votes]);

describe('votesOf', () => {
  it('turns a recipe mapping into one vote per output, defaults keyed by the ontologies', () => {
    const def = {
      ...definition(),
      semantics: {
        ...(definition().semantics as object),
        valueNodes: { link: 'ex:hasDatum', value: 'ex:value' },
      },
    };
    const votes = votesOf(def, 3, true);
    expect(votes.map((v) => [v.path, v.signatureKey, v.kind, v.external, v.version])).toEqual([
      ['', 'document|letter||', 'document', true, 3],
      ['lot', 'value|batch number|text|', 'field', true, 3],
      ['#valueNodes', 'defaults|exo', 'document', true, 3],
    ]);
  });
});

describe('capture: one vote per recipe and output', () => {
  it('records a hand save and moves the vote when the recipe is saved again', async () => {
    const { memory, templates } = setup();
    await templates.create('letter', 1, definition(), 'draft', change('started'));
    await templates.updateDraft('letter', 1, definition(), { change: change('hand') });
    expect(await lotAnswers(memory)).toEqual([
      [{ form: 'literal', property: 'https://ex.example/v#batchNumber' }, 1],
    ]);
    await templates.updateDraft('letter', 1, definition('ex:lot'), { change: change('hand') });
    expect(await lotAnswers(memory)).toEqual([
      [{ form: 'literal', property: 'https://ex.example/v#lot' }, 1],
    ]);
  });

  it('records nothing for an import until a designer saves or publishes it', async () => {
    const { memory, templates } = setup();
    await templates.create('letter', 1, definition(), 'draft', change('import'));
    await templates.updateDraft('letter', 1, definition(), { change: change('import') });
    expect((await memory.list({})).total).toBe(0);
    await templates.publish('letter', 1, 'Ken');
    expect((await lotAnswers(memory)).length).toBe(1);
  });

  it('falls back to the published version when the draft is deleted', async () => {
    const { memory, templates } = setup();
    await templates.create('letter', 1, definition(), 'draft', change('started'));
    await templates.publish('letter', 1, 'Ken');
    await templates.create('letter', 2, definition('ex:lot', 2), 'draft', change('started'));
    await templates.updateDraft('letter', 2, definition('ex:lot', 2), { change: change('hand') });
    expect((await lotAnswers(memory))[0]![0]).toMatchObject({
      property: 'https://ex.example/v#lot',
    });
    await templates.deleteDraft('letter', 2);
    expect((await lotAnswers(memory))[0]![0]).toMatchObject({
      property: 'https://ex.example/v#batchNumber',
    });
  });

  it('removes a retired type votes and restores them when it is unretired', async () => {
    const { memory, templates } = setup();
    await templates.create('letter', 1, definition(), 'draft', change('started'));
    await templates.publish('letter', 1, 'Ken');
    expect((await memory.list({})).total).toBeGreaterThan(0);
    await templates.retire('letter', 'Ada');
    expect((await memory.list({})).total).toBe(0);
    await templates.unretire('letter');
    expect((await lotAnswers(memory)).length).toBe(1);
  });

  it('marks votes from a project that allows external models', async () => {
    const { memory, templates } = setup('external');
    await templates.create('letter', 1, definition(), 'draft', change('started'));
    await templates.updateDraft('letter', 1, definition(), { change: change('hand') });
    expect(memory.votes.every((v) => v.external)).toBe(true);
  });

  it('never fails a write when recording fails', async () => {
    const inner = new MemoryTemplateRepo();
    const templates = rememberingTemplates(inner, async () => {
      throw new Error('memory down');
    });
    await templates.create('letter', 1, definition(), 'draft', change('started'));
    expect(
      await templates.updateDraft('letter', 1, definition(), { change: change('hand') }),
    ).not.toBeNull();
  });
});

describe('reconcileAll', () => {
  it('backfills every recipe, but not a draft only an import wrote', async () => {
    const inner = new MemoryTemplateRepo();
    const memory = new MemoryMappingMemoryRepo();
    const deps: CaptureDeps = { templates: inner, memory, policyOf: async () => null };
    await inner.create('letter', 1, definition(), 'published');
    await inner.create('letter', 2, definition('ex:imported', 2), 'draft', change('import'));
    await reconcileAll(deps);
    expect(await lotAnswers(memory)).toEqual([
      [{ form: 'literal', property: 'https://ex.example/v#batchNumber' }, 1],
    ]);
  });

  it('drops the votes of a recipe that is gone', async () => {
    const inner = new MemoryTemplateRepo();
    const memory = new MemoryMappingMemoryRepo();
    const deps: CaptureDeps = { templates: inner, memory, policyOf: async () => null };
    await inner.create('letter', 1, definition(), 'published');
    await reconcileAll(deps);
    inner.records.clear();
    await reconcileAll(deps);
    expect((await memory.list({})).total).toBe(0);
  });
});
