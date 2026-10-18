import { describe, expect, it } from 'vitest';
import type { DraftChange } from '@ih/shared';
import { changeDiff, changeParts, changeVerb, modelsInChip } from '../src/workbench/changes.js';
import { MODEL_CHOICES } from './fake-api.js';

describe('changeParts', () => {
  it.each([
    [
      {
        op: 'putStep',
        reason: 'r',
        step: {
          type: 'extract',
          id: 'header',
          fields: ['supplier_name', 'invoice_number'],
          sections: ['header', 'supplier'],
        },
      },
      {
        kind: 'EXTRACT',
        tone: 'info',
        id: 'header',
        text: 'fills supplier_name, invoice_number from header, supplier',
      },
    ],
    [
      {
        op: 'putStep',
        reason: 'r',
        step: {
          type: 'extract',
          id: 'line_items',
          table: 'line_items',
          fields: [],
          sections: ['line_items'],
        },
      },
      {
        kind: 'EXTRACT',
        tone: 'info',
        id: 'line_items',
        text: 'fills table line_items from line_items',
      },
    ],
    [
      {
        op: 'putStep',
        reason: 'r',
        step: {
          type: 'check',
          id: 'totals-match',
          values: 'line_items.amount',
          reference: 'subtotal',
        },
      },
      {
        kind: 'CHECK',
        tone: 'neutral',
        id: 'totals-match',
        text: 'line_items.amount against subtotal',
      },
    ],
    [
      {
        op: 'putField',
        reason: 'r',
        field: { id: 'currency', type: 'enum', enum: ['EUR', 'USD'] },
      },
      { kind: 'FIELD', tone: 'ok', id: 'currency', text: 'enum: EUR, USD' },
    ],
    [
      {
        op: 'putTable',
        reason: 'r',
        table: { id: 'lines', columns: [{ id: 'qty' }, { id: 'amount' }] },
      },
      { kind: 'TABLE', tone: 'ok', id: 'lines', text: 'columns qty, amount' },
    ],
    [
      {
        op: 'putSection',
        reason: 'r',
        section: { id: 'totals', anchor: 'Total', required: false },
      },
      { kind: 'SECTION', tone: 'info', id: 'totals', text: '/Total/ (optional)' },
    ],
    [
      { op: 'removeStep', reason: 'r', id: 'old' },
      { kind: 'REMOVE', tone: 'danger', id: 'old', text: 'remove this step' },
    ],
    [
      { op: 'removeOutput', reason: 'r', id: 'x' },
      { kind: 'REMOVE', tone: 'danger', id: 'x', text: 'remove this output' },
    ],
    [
      { op: 'removeSection', reason: 'r', id: 's' },
      { kind: 'REMOVE', tone: 'danger', id: 's', text: 'remove this section' },
    ],
    [
      { op: 'setPreamble', reason: 'r', preamble: 'Be careful' },
      { kind: 'PREAMBLE', tone: 'neutral', id: null, text: 'Set the prompt preamble' },
    ],
    [
      { op: 'setCopies', reason: 'r', copies: null },
      { kind: 'COPIES', tone: 'neutral', id: null, text: 'No copy selection' },
    ],
  ])('%#', (change, parts) => {
    expect(changeParts(change as unknown as DraftChange)).toEqual(parts);
  });
});

const def = {
  document: {
    sections: [
      { id: 'header', anchor: '^INVOICE', required: true },
      { id: 'totals', anchor: 'Total' },
    ],
  },
  outputs: {
    fields: [
      { id: 'invoice_date', type: 'date' },
      { id: 'currency', type: 'enum', enum: ['GBP', 'EUR'] },
    ],
    tables: [{ id: 'lines', columns: [{ id: 'qty', type: 'decimal' }, { id: 'amount' }] }],
  },
  pipeline: [
    { type: 'extract', id: 'header', fields: ['invoice_date'], sections: ['header'] },
    { type: 'extract', id: 'lines', table: 'lines', sections: ['totals'], chunkPages: 3 },
    { type: 'extract', id: 'totals', fields: ['currency'], sections: ['totals', 'payment'] },
  ],
};

describe('changeVerb and changeDiff', () => {
  it.each([
    [{ op: 'putField', reason: 'r', field: { id: 'due_date', type: 'date' } }, 'NEW', '+ due_date'],
    [
      {
        op: 'putField',
        reason: 'r',
        field: { id: 'currency', type: 'enum', enum: ['GBP', 'EUR', 'USD'] },
      },
      'CHANGED',
      'values GBP, EUR → GBP, EUR, USD',
    ],
    [
      {
        op: 'putField',
        reason: 'r',
        field: { id: 'invoice_date', type: 'text', description: 'Printed DMY' },
      },
      'CHANGED',
      'type date → text, description edited',
    ],
    [{ op: 'putField', reason: 'r', field: { id: 'invoice_date', type: 'date' } }, 'CHANGED', null],
    [{ op: 'removeOutput', reason: 'r', id: 'currency' }, 'REMOVED', '− currency'],
    [
      {
        op: 'putTable',
        reason: 'r',
        table: {
          id: 'lines',
          columns: [{ id: 'qty', type: 'decimal' }, { id: 'amount' }, { id: 'unit_price' }],
        },
      },
      'CHANGED',
      '+ unit_price',
    ],
    [
      {
        op: 'putTable',
        reason: 'r',
        table: { id: 'lines', columns: [{ id: 'qty', type: 'integer' }] },
      },
      'CHANGED',
      '− amount, ~ qty',
    ],
    [
      {
        op: 'putSection',
        reason: 'r',
        section: { id: 'totals', anchor: '^TOTAL', required: false },
      },
      'CHANGED',
      'anchor /Total/ → /^TOTAL/, required → optional',
    ],
    [{ op: 'removeSection', reason: 'r', id: 'totals' }, 'REMOVED', '− totals'],
    [
      {
        op: 'putStep',
        reason: 'r',
        step: {
          type: 'extract',
          id: 'header',
          fields: ['invoice_date', 'due_date'],
          sections: ['header'],
        },
      },
      'CHANGED',
      '+ due_date',
    ],
    [
      {
        op: 'putStep',
        reason: 'r',
        step: { type: 'extract', id: 'lines', table: 'lines', sections: ['totals'], chunkPages: 2 },
      },
      'CHANGED',
      'chunk pages 3 → 2',
    ],
    [
      {
        op: 'putStep',
        reason: 'r',
        step: { type: 'extract', id: 'totals', fields: ['currency'], sections: ['totals'] },
      },
      'CHANGED',
      '− reads payment',
    ],
    [
      {
        op: 'putStep',
        reason: 'r',
        step: {
          type: 'extract',
          id: 'header',
          fields: ['invoice_date'],
          sections: ['header'],
          model: 'cloud',
          maxAttempts: 3,
        },
      },
      'CHANGED',
      'model Main Production Model → Cloud model, attempts 2 → 3',
    ],
    [
      {
        op: 'putStep',
        reason: 'r',
        step: { type: 'check', id: 'totals-match', values: 'lines.amount', reference: 'total' },
      },
      'NEW',
      '+ totals-match',
    ],
    [{ op: 'removeStep', reason: 'r', id: 'lines' }, 'REMOVED', '− lines'],
    [{ op: 'setPreamble', reason: 'r', preamble: 'Be careful' }, 'NEW', null],
    [{ op: 'setPreamble', reason: 'r', preamble: '' }, 'REMOVED', null],
    [{ op: 'setCopies', reason: 'r', copies: null }, 'REMOVED', null],
  ])('%#', (change, verb, diff) => {
    const c = change as unknown as DraftChange;
    expect(changeVerb(c, def)).toBe(verb);
    expect(changeDiff(c, def, MODEL_CHOICES)).toBe(diff);
  });
});

describe('model names in diffs', () => {
  const step = (model: string | undefined) =>
    ({
      op: 'putStep',
      reason: 'r',
      step: { type: 'extract', id: 'header', fields: ['a'], sections: ['header'], model },
    }) as unknown as DraftChange;
  const withModel = (model: string) => ({
    pipeline: [{ type: 'extract', id: 'header', fields: ['a'], sections: ['header'], model }],
  });

  it.each([
    ['draft', 'cloud', 'model Drafting model → Cloud model'],
    ['local/legacy', 'main', 'model Model no longer offered → Main Production Model'],
    ['fast', 'local/qwen', 'model Model no longer offered → Main Production Model'],
  ])('a step model change %s → %s shows names', (from, to, text) => {
    const diff = changeDiff(step(to), withModel(from), MODEL_CHOICES);
    expect(diff).toBe(text);
    expect(diff).not.toContain('local/');
  });
});

describe('modelsInChip', () => {
  it.each([
    ['main → cloud', 'Main Production Model → Cloud model'],
    ['default → draft', 'Main Production Model → Drafting model'],
    ['local/qwen → local/other', 'Main Production Model → Model no longer offered'],
    ['fast → cloud', 'Model no longer offered → Cloud model'],
    ['+ due_date', '+ due_date'],
    ['text → number', 'text → number'],
    [
      '^(From|Supplier)\b → ^(From|Supplier|Vendor)\b',
      '^(From|Supplier)\b → ^(From|Supplier|Vendor)\b',
    ],
    ['instructions edited', 'instructions edited'],
  ])('%s', (chip, text) => expect(modelsInChip(chip, MODEL_CHOICES)).toBe(text));
});

describe('value node changes', () => {
  it.each<[string, Record<string, unknown>, string]>([
    [
      'with the recipe default link',
      { node: { class: 'afr:WaterContent', unit: 'unit:PERCENT' } },
      'node of afr:WaterContent · unit unit:PERCENT',
    ],
    [
      'with its own link and value property',
      { property: 'obo:hasOutput', node: { class: 'afr:Assay', value: 'qudt:numericValue' } },
      'obo:hasOutput → node of afr:Assay · value qudt:numericValue',
    ],
  ])('a node %s', (_name, mapping, text) => {
    const change = { op: 'putFieldMapping', field: 'water', mapping, reason: '' } as DraftChange;
    expect(changeParts(change)).toEqual({ kind: 'MAPPING', tone: 'ok', id: 'water', text });
  });
});
