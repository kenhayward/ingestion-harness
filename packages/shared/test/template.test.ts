import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deliveryFormats, stepModel, TemplateSchema } from '../src/template.js';

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
      'bad check path',
      (v) =>
        withPipeline([...v.pipeline.slice(0, 3), { ...v.pipeline[3], values: 'results.nope' }]),
      'unknown field or column',
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
