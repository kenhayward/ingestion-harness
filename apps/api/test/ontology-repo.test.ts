import { describe, expect, it } from 'vitest';
import { MemoryOntologyRepo, type NewOntologyVersion } from '../src/ontologies/repo.js';

const input = (over: Partial<NewOntologyVersion> = {}): NewOntologyVersion => ({
  ontologyId: 'pv',
  meta: {
    label: 'Process validation',
    description: '',
    tags: ['industry:pharma'],
    localOnly: false,
  },
  fileName: 'pv.ttl',
  mediaType: 'text/turtle',
  sourceKey: 'ontologies/pv/sources/aaa.ttl',
  sha256: 'aaa',
  bytes: 10,
  by: 'Ken',
  ...over,
});

const C = 'https://example.org/pv#';

async function seeded() {
  const repo = new MemoryOntologyRepo();
  await repo.createVersion(input());
  repo.markReady('pv', 1, {
    stats: { triples: 9, classes: 3, properties: 1, concepts: 0, schemes: 0, shapes: 0 },
  });
  repo.seedTerms('pv', 1, [
    { iri: `${C}Document`, kind: 'class', label: 'Document', root: true, childCount: 1 },
    {
      iri: `${C}Protocol`,
      kind: 'class',
      label: 'Protocol',
      parents: [`${C}Document`],
      altLabels: ['Validation protocol'],
    },
    { iri: `${C}Batch`, kind: 'class', label: 'Batch', root: true },
    {
      iri: `${C}hasBatch`,
      kind: 'object_property',
      label: 'has batch',
      root: true,
      domain: [`${C}Protocol`],
      range: [`${C}Batch`],
    },
    {
      iri: `${C}BatchShape`,
      kind: 'shape',
      label: 'Batch shape',
      root: true,
      domain: [`${C}Batch`],
    },
  ]);
  return repo;
}

describe('MemoryOntologyRepo', () => {
  it('creates an ontology with its first version and a queued job', async () => {
    const repo = new MemoryOntologyRepo();
    const result = await repo.createVersion(input());
    expect(result).toMatchObject({
      ok: true,
      version: { ontologyId: 'pv', version: 1, status: 'queued' },
    });
    expect(repo.jobs).toEqual([
      {
        id: expect.any(String),
        createdBy: 'Ken',
        params: {
          ontologyId: 'pv',
          version: 1,
          sourceKey: 'ontologies/pv/sources/aaa.ttl',
          fileName: 'pv.ttl',
          mediaType: 'text/turtle',
        },
      },
    ]);
    const [summary] = await repo.list({ retired: false });
    expect(summary).toMatchObject({
      id: 'pv',
      label: 'Process validation',
      versionCount: 1,
      latest: { version: 1 },
    });
  });

  it('needs a label for a new ontology and refuses the same bytes twice', async () => {
    const repo = new MemoryOntologyRepo();
    expect(await repo.createVersion(input({ meta: null }))).toEqual({
      ok: false,
      reason: 'needs-label',
    });
    await repo.createVersion(input());
    expect(await repo.createVersion(input({ meta: null }))).toEqual({
      ok: false,
      reason: 'duplicate',
      version: 1,
    });
    const second = await repo.createVersion(input({ meta: null, sha256: 'bbb', sourceKey: 'k2' }));
    expect(second).toMatchObject({ ok: true, version: { version: 2 } });
    expect((await repo.get('pv'))!.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('patches metadata, retires and hides retired ontologies by default', async () => {
    const repo = await seeded();
    expect(await repo.update('nope', { label: 'x' })).toBeNull();
    const updated = await repo.update('pv', {
      label: 'PV',
      tags: ['customer:acme'],
      localOnly: true,
      retired: true,
    });
    expect(updated).toMatchObject({
      label: 'PV',
      tags: ['customer:acme'],
      localOnly: true,
      retiredAt: expect.any(String),
    });
    expect(await repo.list({ retired: false })).toEqual([]);
    expect(await repo.list({ retired: true })).toHaveLength(1);
    expect(await repo.update('pv', { retired: false })).toMatchObject({ retiredAt: null });
  });

  it('refuses to delete a version still importing; the last version takes the ontology', async () => {
    const repo = new MemoryOntologyRepo();
    await repo.createVersion(input());
    expect(await repo.deleteVersion('pv', 1)).toEqual({ result: 'busy' });
    repo.markFailed('pv', 1, 'cannot read');
    expect(await repo.deleteVersion('pv', 2)).toEqual({ result: 'missing' });
    expect(await repo.deleteVersion('pv', 1)).toEqual({
      result: 'deleted',
      sha256: 'aaa',
      fileName: 'pv.ttl',
    });
    expect(await repo.get('pv')).toBeNull();
  });

  it('pages roots, children and searches within a group', async () => {
    const repo = await seeded();
    const roots = await repo.terms('pv', 1, {
      group: 'classes',
      root: true,
      offset: 0,
      limit: 100,
    });
    expect(roots!.items.map((t) => t.label)).toEqual(['Batch', 'Document']);
    const children = await repo.terms('pv', 1, {
      group: 'classes',
      parent: `${C}Document`,
      offset: 0,
      limit: 100,
    });
    expect(children!.items.map((t) => t.label)).toEqual(['Protocol']);
    // Alt labels match; an exact label ranks first.
    const found = await repo.terms('pv', 1, { q: 'protocol', offset: 0, limit: 100 });
    expect(found!.items.map((t) => t.label)).toEqual(['Protocol']);
    const paged = await repo.terms('pv', 1, { group: 'classes', offset: 1, limit: 1 });
    expect(paged).toMatchObject({ total: 3, offset: 1, limit: 1, items: [{ label: 'Document' }] });
    expect(await repo.terms('pv', 9, { offset: 0, limit: 10 })).toBeNull();
  });

  it('describes a term with its neighbours', async () => {
    const repo = await seeded();
    const batch = await repo.term('pv', 1, `${C}Batch`);
    expect(batch).toMatchObject({
      label: 'Batch',
      asRange: [{ iri: `${C}hasBatch`, label: 'has batch', kind: 'object_property' }],
      asDomain: [],
      shapes: [{ iri: `${C}BatchShape`, label: 'Batch shape', kind: 'shape' }],
    });
    const protocol = await repo.term('pv', 1, `${C}Protocol`);
    expect(protocol!.parentTerms).toEqual([
      { iri: `${C}Document`, label: 'Document', kind: 'class' },
    ]);
    const doc = await repo.term('pv', 1, `${C}Document`);
    expect(doc!.children.map((c) => c.label)).toEqual(['Protocol']);
    const prop = await repo.term('pv', 1, `${C}hasBatch`);
    expect(prop!.domainTerms.map((r) => r.label)).toEqual(['Protocol']);
    expect(prop!.rangeTerms.map((r) => r.label)).toEqual(['Batch']);
    expect(await repo.term('pv', 1, `${C}Nope`)).toBeNull();
  });
});
