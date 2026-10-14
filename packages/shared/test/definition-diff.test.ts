import { describe, expect, it } from 'vitest';
import {
  changeSubject,
  describeDefinitionChange,
  diffDefinitions,
  MAX_CHANGE_CHIPS,
  TemplateChangeSchema,
} from '../src/index.js';

const base = {
  id: 'invoice',
  version: 4,
  name: 'Invoice',
  document: {
    sections: [
      { id: 'header', anchor: '^INVOICE' },
      { id: 'supplier', anchor: '^(From|Supplier)\\b' },
    ],
  },
  outputs: {
    fields: [{ id: 'total', type: 'number' }],
    tables: [{ id: 'lines', columns: [{ id: 'item', type: 'text' }] }],
  },
  pipeline: [
    { type: 'extract', id: 'header', fields: ['total'], sections: ['header'] },
    { type: 'extract', id: 'totals', fields: [], sections: ['totals', 'payment'] },
  ],
};
type Def = typeof base;
const edit = (f: (d: Def) => void): Def => {
  const d = structuredClone(base);
  f(d);
  return d;
};

describe('changeSubject', () => {
  it.each([
    ['outputs.fields[due_date]', 'field due_date'],
    ['outputs.fields[due_date].type', 'field due_date'],
    ['outputs.tables[lines]', 'table lines'],
    ['outputs.tables[lines].columns[qty].type', 'column lines.qty'],
    ['outputs.fields order', 'the outputs'],
    ['document.sections[supplier].anchor', 'section supplier'],
    ['document.sections order', 'the sections'],
    ['document.copies.anchor', 'the copy selection'],
    ['document.ocr', 'the document settings'],
    ['pipeline[totals].sections', 'step totals'],
    ['pipeline order', 'the pipeline'],
    ['review.required', 'the review setting'],
    ['model', "the document type's model"],
    ['semantics.fields.sender.property', 'the ontology mapping'],
    ['delivery.formats', 'the delivered formats'],
    ['preamble', 'the preamble'],
    ['name', 'the name'],
  ])('%s -> %s', (path, subject) => expect(changeSubject(path)).toBe(subject));
});

describe('describeDefinitionChange', () => {
  it.each<[string, Def, Pick<ReturnType<typeof describeDefinitionChange>, 'summary' | 'diff'>]>([
    [
      'a new field',
      edit((d) => d.outputs.fields.push({ id: 'due_date', type: 'date' })),
      { summary: 'Added field due_date', diff: ['+ due_date'] },
    ],
    [
      'a widened anchor',
      edit((d) => (d.document.sections[1]!.anchor = '^(From|Supplier|Vendor)\\b')),
      {
        summary: 'Changed section supplier',
        diff: ['^(From|Supplier)\\b → ^(From|Supplier|Vendor)\\b'],
      },
    ],
    [
      'a section a step no longer reads',
      edit((d) => (d.pipeline[1]!.sections = ['totals'])),
      { summary: 'Changed step totals', diff: ['− payment'] },
    ],
    [
      'a removed table',
      edit((d) => (d.outputs.tables = [])),
      { summary: 'Removed table lines', diff: ['− lines'] },
    ],
    [
      'a new column',
      edit((d) => d.outputs.tables[0]!.columns.push({ id: 'qty', type: 'text' })),
      { summary: 'Added column lines.qty', diff: ['+ qty'] },
    ],
    [
      'two subjects',
      edit((d) => {
        d.outputs.fields.push({ id: 'due_date', type: 'date' });
        d.name = 'Supplier invoice';
      }),
      // Subjects in definition order: `name` comes before `outputs`.
      {
        summary: 'Changed the name and 1 more',
        diff: ['Invoice → Supplier invoice', '+ due_date'],
      },
    ],
    [
      'swapped steps',
      edit((d) => d.pipeline.reverse()),
      { summary: 'Changed the pipeline', diff: ['reordered'] },
    ],
  ])('%s', (_name, after, expected) => {
    expect(describeDefinitionChange(base, after)).toMatchObject(expected);
  });

  it('says a new preamble in words', () => {
    expect(
      describeDefinitionChange(base, { ...base, preamble: 'Invoices from UK suppliers.' }),
    ).toMatchObject({
      subjects: ['the preamble'],
      summary: 'Changed the preamble',
      diff: ['preamble added'],
    });
  });

  it('clips long values in a chip', () => {
    const after = { ...base, name: 'x'.repeat(61) };
    expect(describeDefinitionChange(base, after).diff).toEqual([`Invoice → ${'x'.repeat(39)}…`]);
  });

  it('counts nothing for an identical definition or a version bump', () => {
    for (const after of [structuredClone(base), { ...base, version: 5 }]) {
      expect(describeDefinitionChange(base, after)).toEqual({
        subjects: [],
        summary: 'No changes',
        diff: [],
        count: 0,
      });
    }
  });

  it(`keeps at most ${MAX_CHANGE_CHIPS} chips, the summary naming the rest`, () => {
    const after = edit((d) => {
      for (const n of [1, 2, 3, 4, 5, 6]) d.outputs.fields.push({ id: `f${n}`, type: 'text' });
    });
    const text = describeDefinitionChange(base, after);
    expect(text.diff).toEqual(['+ f1', '+ f2', '+ f3', '+ f4']);
    expect(text.summary).toBe('Added field f1 and 5 more');
    expect(text.count).toBe(6);
  });

  it('reads unfinished drafts (non-objects count as empty)', () => {
    expect(describeDefinitionChange(null, { name: 'A' }).summary).toBe('Changed the name');
  });
});

describe('diffDefinitions (moved from the API)', () => {
  it('matches items by id', () => {
    const after = edit((d) => d.outputs.fields.unshift({ id: 'due_date', type: 'date' }));
    expect(diffDefinitions(base, after)).toEqual([
      { kind: 'added', path: 'outputs.fields[due_date]', after: { id: 'due_date', type: 'date' } },
    ]);
  });
});

describe('TemplateChangeSchema', () => {
  const entry = {
    id: '7',
    version: 4,
    at: '2026-10-12T08:40:00.000Z',
    source: 'proposal',
    stage: 'outputs',
    proposalId: '6f1c2c1e-0000-4000-8000-000000000001',
    summary: 'Added field due_date',
    diff: ['+ due_date'],
    by: 'Ken',
  };
  it('parses a log entry', () => expect(TemplateChangeSchema.parse(entry)).toEqual(entry));
  it('refuses an unknown source', () =>
    expect(TemplateChangeSchema.safeParse({ ...entry, source: 'survey' }).success).toBe(false));
});

describe('an absent list is an empty one', () => {
  const absent = (key: 'fields' | 'tables') => {
    const d = structuredClone(base) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    delete d.outputs[key];
    return d;
  };
  const empty = (key: 'fields' | 'tables') => {
    const d = structuredClone(base) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    d.outputs[key] = [];
    return d;
  };

  it.each(['fields', 'tables'] as const)('absent %s against [] is no change, both ways', (key) => {
    expect(diffDefinitions(absent(key), empty(key))).toEqual([]);
    expect(diffDefinitions(empty(key), absent(key))).toEqual([]);
  });

  it('absent tables against one table is that table added, and removed the other way', () => {
    expect(diffDefinitions(absent('tables'), base)).toEqual([
      { kind: 'added', path: 'outputs.tables[lines]', after: base.outputs.tables[0] },
    ]);
    expect(diffDefinitions(base, absent('tables'))).toEqual([
      { kind: 'removed', path: 'outputs.tables[lines]', before: base.outputs.tables[0] },
    ]);
  });
});
