import { describe, expect, it } from 'vitest';
import type { DraftChange } from '@ih/shared';
import { changeParts } from '../src/workbench/changes.js';

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
      { kind: 'REMOVE', tone: 'alert', id: 'old', text: 'remove this step' },
    ],
    [
      { op: 'removeOutput', reason: 'r', id: 'x' },
      { kind: 'REMOVE', tone: 'alert', id: 'x', text: 'remove this output' },
    ],
    [
      { op: 'removeSection', reason: 'r', id: 's' },
      { kind: 'REMOVE', tone: 'alert', id: 's', text: 'remove this section' },
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
