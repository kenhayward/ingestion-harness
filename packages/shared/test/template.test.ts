import { describe, expect, it } from 'vitest';
import { TemplateSchema } from '../src/template.js';

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
    expect(t.pipeline[0]).toMatchObject({ model: 'default', maxTokens: 16000 });
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
