import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deliveryFormats,
  deliveryTargets,
  setDeliveryTarget,
  stepModel,
  TemplateSchema,
  type DeliveryTarget,
} from '../src/template.js';
import { deliveryPublishTo } from '../src/publish-targets.js';

const valid = {
  id: 'demo',
  version: 1,
  name: 'Demo document',
  document: {
    sections: [
      { id: 'head', anchor: '\\A' },
      { id: 'body', anchor: '^BODY' },
    ],
  },
  outputs: {
    fields: [
      { id: 'product', type: 'text', description: 'Medicinal product name' },
      { id: 'executed_on', type: 'date' },
      { id: 'kind', type: 'enum', enum: ['protocol', 'report'] },
    ],
    tables: [
      {
        id: 'results',
        columns: [
          { id: 'batch', type: 'text' },
          { id: 'value', type: 'decimal' },
        ],
      },
    ],
  },
  pipeline: [
    { type: 'extract', id: 'header', fields: ['product', 'kind'], sections: ['head'] },
    { type: 'extract', id: 'date', fields: ['executed_on'], sections: ['head'] },
    { type: 'extract', id: 'data', table: 'results', sections: ['body'], chunkPages: 1 },
    { type: 'check', id: 'c', values: 'results.batch', reference: 'results.batch' },
  ],
};

type Raw = typeof valid;
const withPipeline = (pipeline: unknown[]) => ({ ...valid, pipeline });
const issues = (raw: unknown) => {
  const result = TemplateSchema.safeParse(raw);
  return result.success ? '' : JSON.stringify(result.error.issues);
};

describe('TemplateSchema', () => {
  it('parses with defaults', () => {
    const t = TemplateSchema.parse(valid);
    expect(t.review.required).toBe('on_warnings');
    expect(t.document.pageMarkers).toBe(true);
    expect(t.document.dateOrder).toBe('DMY');
    expect(t.pipeline[0]).toMatchObject({ model: 'default', maxTokens: 64000 });
  });

  it('accepts context from earlier steps only', () => {
    const later = { ...valid.pipeline[1], context: { batches: 'results.batch' } };
    const ok = {
      ...valid,
      pipeline: [valid.pipeline[0], valid.pipeline[2], later, valid.pipeline[3]],
    };
    expect(issues(ok)).toBe('');
    const early = { ...valid.pipeline[0], context: { batches: 'results.batch' } };
    expect(issues(withPipeline([early, ...valid.pipeline.slice(1)]))).toContain(
      'not filled by an earlier step',
    );
  });

  it.each<[string, (v: Raw) => unknown, string]>([
    [
      'field filled twice',
      (v) => withPipeline([...v.pipeline, { ...v.pipeline[1], id: 'again' }]),
      'filled by more than one step',
    ],
    ['field not filled', (v) => withPipeline(v.pipeline.slice(1)), 'not filled by any step'],
    [
      'unknown section',
      (v) => withPipeline([{ ...v.pipeline[0], sections: ['nope'] }, ...v.pipeline.slice(1)]),
      'unknown section',
    ],
    [
      'chunked field step',
      (v) => withPipeline([{ ...v.pipeline[0], chunkPages: 2 }, ...v.pipeline.slice(1)]),
      'only table steps can be chunked',
    ],
    [
      'enum without values',
      (v) => ({
        ...v,
        outputs: {
          ...v.outputs,
          fields: [...v.outputs.fields.slice(0, 2), { id: 'kind', type: 'enum' }],
        },
      }),
      'enum values',
    ],
    [
      'reserved table id',
      (v) => ({
        ...v,
        outputs: { ...v.outputs, tables: [{ ...v.outputs.tables[0]!, id: 'issues' }] },
        pipeline: [...v.pipeline.slice(0, 2), { ...v.pipeline[2], table: 'issues' }],
      }),
      'reserved',
    ],
    [
      'graph is reserved for the RDF output',
      (v) => ({
        ...v,
        outputs: { ...v.outputs, tables: [{ ...v.outputs.tables[0]!, id: 'graph' }] },
        pipeline: [...v.pipeline.slice(0, 2), { ...v.pipeline[2], table: 'graph' }],
      }),
      'reserved',
    ],
    [
      'bad check path',
      (v) =>
        withPipeline([...v.pipeline.slice(0, 3), { ...v.pipeline[3], values: 'results.nope' }]),
      'unknown field or column',
    ],
    [
      'bare table as a check path',
      (v) => withPipeline([...v.pipeline.slice(0, 3), { ...v.pipeline[3], values: 'results' }]),
      'is a table, so name one of its columns: results.batch, results.value',
    ],
    [
      'step with neither fields nor table',
      (v) => withPipeline([{ ...v.pipeline[0], fields: [] }, ...v.pipeline.slice(1)]),
      'fields or a table',
    ],
  ])('rejects %s', (_label, mutate, message) => {
    expect(issues(mutate(structuredClone(valid)))).toContain(message);
  });
});

describe('stepModel (steps inherit the document type model)', () => {
  // Same table as worker/tests/test_template.py::test_steps_inherit_the_document_types_model.
  it.each<[string | undefined, string | undefined, string]>([
    [undefined, undefined, 'default'],
    ['fast', undefined, 'fast'],
    ['fast', 'default', 'fast'],
    ['fast', 'main', 'main'],
    [undefined, 'main', 'main'],
  ])('template %s, step %s -> %s', (templateModel, step, runs) => {
    const raw = {
      ...valid,
      ...(templateModel ? { model: templateModel } : {}),
      pipeline: [
        { ...valid.pipeline[0]!, ...(step ? { model: step } : {}) },
        ...valid.pipeline.slice(1),
      ],
    };
    const t = TemplateSchema.parse(raw);
    const step0 = t.pipeline[0]!;
    if (step0.type !== 'extract') throw new Error('expected an extract step');
    expect(stepModel(t, step0)).toBe(runs);
  });

  it('refuses an empty document type model', () => {
    expect(TemplateSchema.safeParse({ ...valid, model: '' }).success).toBe(false);
  });
});

describe('recipe semantics and delivery (shared with the worker)', () => {
  const semanticsFixture = JSON.parse(
    readFileSync(new URL('./fixtures/template-semantics.json', import.meta.url), 'utf8'),
  ) as { base: object; cases: { name: string; valid: boolean; patch: object }[] };

  it.each(semanticsFixture.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const result = TemplateSchema.safeParse({ ...semanticsFixture.base, ...c.patch });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(c.valid);
  });

  it('delivers CSV and JSON unless the recipe says otherwise', () => {
    const base = semanticsFixture.base as Parameters<typeof deliveryFormats>[0];
    expect(deliveryFormats(base)).toEqual(['csv', 'json']);
    expect(deliveryFormats({ ...base, delivery: { formats: ['json'] } })).toEqual(['json']);
  });
});

describe('delivery targets (S3 and RDF)', () => {
  const MAPPING = { document: { class: 'ex:Doc', iri: 'doc/{source}' } };
  const plain = { id: 't', outputs: { fields: [], tables: [] } };

  it.each([
    ['the default (CSV and JSON)', plain, { s3: true, rdf: false }],
    ['JSON only', { ...plain, delivery: { formats: ['json'] } }, { s3: true, rdf: false }],
    ['RDF only', { ...plain, delivery: { formats: ['rdf'] } }, { s3: false, rdf: true }],
    ['both', { ...plain, delivery: { formats: ['csv', 'json', 'rdf'] } }, { s3: true, rdf: true }],
    // A mapping not (yet) delivered still counts as RDF: turning RDF off removes it.
    ['a mapping without rdf delivered', { ...plain, semantics: MAPPING }, { s3: true, rdf: true }],
  ])('%s', (_name, definition, targets) => {
    expect(deliveryTargets(definition)).toEqual(targets);
  });

  it.each<[string, Record<string, unknown>, DeliveryTarget, boolean, Record<string, unknown>]>([
    [
      'RDF on adds rdf after CSV and JSON',
      plain,
      'rdf',
      true,
      { ...plain, delivery: { formats: ['csv', 'json', 'rdf'] } },
    ],
    [
      'RDF off removes rdf and the mapping, back to the default',
      { ...plain, semantics: MAPPING, delivery: { formats: ['csv', 'json', 'rdf'] } },
      'rdf',
      false,
      plain,
    ],
    [
      'RDF off on an undelivered mapping removes the mapping',
      { ...plain, semantics: MAPPING },
      'rdf',
      false,
      plain,
    ],
    [
      'S3 off keeps only rdf',
      { ...plain, semantics: MAPPING, delivery: { formats: ['csv', 'json', 'rdf'] } },
      's3',
      false,
      { ...plain, semantics: MAPPING, delivery: { formats: ['rdf'] } },
    ],
    [
      'S3 off on an undelivered mapping delivers its RDF',
      { ...plain, semantics: MAPPING },
      's3',
      false,
      { ...plain, semantics: MAPPING, delivery: { formats: ['rdf'] } },
    ],
    [
      'S3 on adds CSV and JSON',
      { ...plain, semantics: MAPPING, delivery: { formats: ['rdf'] } },
      's3',
      true,
      { ...plain, semantics: MAPPING, delivery: { formats: ['csv', 'json', 'rdf'] } },
    ],
    [
      'S3 on with RDF already off is the default',
      { ...plain, delivery: { formats: ['json'] } },
      's3',
      true,
      plain,
    ],
  ])('%s', (_name, definition, target, on, expected) => {
    expect(setDeliveryTarget(definition, target, on)).toEqual(expected);
  });

  it('never turns off the last target', () => {
    expect(() => setDeliveryTarget(plain, 's3', false)).toThrow(/at least one/);
    const rdfOnly = { ...plain, semantics: MAPPING, delivery: { formats: ['rdf'] } };
    expect(() => setDeliveryTarget(rdfOnly, 'rdf', false)).toThrow(/at least one/);
  });

  it('leaves the definition it was given alone', () => {
    const before = { ...plain, semantics: MAPPING };
    setDeliveryTarget(before, 'rdf', false);
    expect(before.semantics).toBe(MAPPING);
  });
});

describe('repeating sections (shared with the worker)', () => {
  type Case = {
    name: string;
    valid: boolean;
    error: string | null;
    sections?: object[];
    pipeline?: object[];
  };
  const fx = JSON.parse(
    readFileSync(new URL('./fixtures/repeating-sections.json', import.meta.url), 'utf8'),
  ) as { base: { document: object }; cases: Case[] };
  const definition = (c: Case) => ({
    ...fx.base,
    document: { ...fx.base.document, ...(c.sections ? { sections: c.sections } : {}) },
    ...(c.pipeline ? { pipeline: c.pipeline } : {}),
  });

  it.each(fx.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const result = TemplateSchema.safeParse(definition(c));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(c.valid);
    if (!c.valid) {
      expect(result.error!.issues.map((i) => i.message).join('\n')).toContain(c.error);
    }
  });

  it('parses a recipe without repeat to itself', () => {
    const plain = TemplateSchema.parse(
      definition(fx.cases.find((c) => c.name === 'no repeat anywhere')!),
    );
    for (const s of plain.document.sections) {
      expect(Object.keys(s)).not.toContain('repeat');
      expect(Object.keys(s)).not.toContain('key');
      expect(Object.keys(s)).not.toContain('keyFrom');
    }
    for (const s of plain.pipeline) expect(Object.keys(s)).not.toContain('keyColumn');
  });
});

describe('delivery.publishTo (publishing targets, shared with the worker)', () => {
  const cases = (
    JSON.parse(readFileSync(new URL('./fixtures/publish-targets.json', import.meta.url), 'utf8')) as {
      delivery: { name: string; definition: object; formats: string[]; publishTo: string }[];
    }
  ).delivery;
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const t = TemplateSchema.parse({ ...valid, ...c.definition });
    expect(deliveryFormats(t)).toEqual(c.formats);
    expect(deliveryPublishTo(t)).toBe(c.publishTo);
  });
  it('names the default target when none is set', () => {
    expect(deliveryPublishTo({})).toBe('default');
  });
  it('refuses a bad target id', () => {
    const r = TemplateSchema.safeParse({ ...valid, delivery: { publishTo: 'Bad Id' } });
    expect(r.success).toBe(false);
  });
  it('keeps publishTo when a delivery switch changes', () => {
    const def = { ...valid, delivery: { publishTo: 'finance-lake' } };
    const rdf = setDeliveryTarget(def, 'rdf', true) as { delivery: unknown };
    expect(rdf.delivery).toEqual({ formats: ['csv', 'json', 'rdf'], publishTo: 'finance-lake' });
    expect(setDeliveryTarget(rdf, 'rdf', false)).toEqual(def);
  });
});
