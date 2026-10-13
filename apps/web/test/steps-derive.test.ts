import { describe, expect, it } from 'vitest';
import type { OutputCoverage } from '@ih/shared';
import {
  coverageHeadline,
  outputsLine,
  RETRY_WARN_ATTEMPTS,
  retryWarning,
  sectionIds,
  stepCards,
  stepFigures,
} from '../src/workbench/steps.js';

const DEF = {
  document: { sections: [{ id: 'header' }, { id: 'line_items' }, { id: 'totals' }] },
  outputs: {
    fields: [{ id: 'supplier_name' }, { id: 'invoice_date' }],
    tables: [{ id: 'line_items', columns: [{ id: 'amount' }] }],
  },
  pipeline: [
    {
      type: 'extract',
      id: 'header',
      fields: ['supplier_name', 'invoice_date'],
      sections: ['header'],
    },
    {
      type: 'extract',
      id: 'line_items',
      table: 'line_items',
      sections: ['line_items'],
      chunkPages: 3,
      model: 'local/qwen3.8-27b-mtp',
    },
    { type: 'check', id: 'totals-match', values: 'line_items.amount', reference: 'subtotal' },
  ],
};

describe('stepCards', () => {
  it('numbers the steps and says what each fills and reads', () => {
    expect(stepCards(DEF)).toEqual([
      {
        number: 1,
        id: 'header',
        kind: 'EXTRACT',
        model: 'default',
        fills: ['supplier_name', 'invoice_date'],
        reads: ['header'],
        chunkPages: null,
        compares: null,
      },
      {
        number: 2,
        id: 'line_items',
        kind: 'EXTRACT',
        model: 'local/qwen3.8-27b-mtp',
        fills: ['line_items'],
        reads: ['line_items'],
        chunkPages: 3,
        compares: null,
      },
      {
        number: 3,
        id: 'totals-match',
        kind: 'CHECK',
        model: null,
        fills: [],
        reads: [],
        chunkPages: null,
        compares: 'line_items.amount = subtotal',
      },
    ]);
    expect(stepCards({})).toEqual([]);
  });

  it.each([
    [{ values: 'a.b', reference: 'c' }, 'a.b = c'],
    [{ values: 'a.b' }, 'a.b'],
    [{ reference: 'c' }, 'c'],
    [{}, null],
  ])('describes a check step without undefined (%j)', (rest, compares) => {
    const cards = stepCards({ pipeline: [{ type: 'check', id: 'x', ...rest }] });
    expect(cards[0]?.compares).toBe(compares);
  });

  it('lists the sections and the outputs line', () => {
    expect(sectionIds(DEF)).toEqual(['header', 'line_items', 'totals']);
    expect(outputsLine(DEF)).toBe('Outputs: 2 fields · line_items');
    expect(outputsLine({ outputs: { fields: [{ id: 'a' }] } })).toBe('Outputs: 1 field');
  });
});

const cov = (uncovered: string[], multiple: string[] = []): OutputCoverage => ({
  outputs: [],
  uncovered,
  multiple,
});

describe('coverageHeadline', () => {
  it.each<[OutputCoverage, OutputCoverage | null, { tone: 'ok' | 'warn'; text: string }]>([
    [cov([]), null, { tone: 'ok', text: 'Every output is filled by exactly one step' }],
    [cov([], ['total']), null, { tone: 'warn', text: '1 output is filled by more than one step' }],
    [cov(['due_date']), null, { tone: 'warn', text: '1 output not filled by any step' }],
    [
      cov(['due_date'], ['total', 'tax']),
      null,
      {
        tone: 'warn',
        text: '1 output not filled by any step; 2 filled by more than one step',
      },
    ],
    [
      cov(['due_date'], ['total']),
      cov([], ['total']),
      {
        tone: 'warn',
        text: '1 output not filled by any step — the proposal fixes it; 1 filled by more than one step',
      },
    ],
    [
      cov(['due_date']),
      cov([]),
      { tone: 'warn', text: '1 output not filled by any step — the proposal fixes it' },
    ],
    [
      cov(['a', 'b']),
      cov([]),
      { tone: 'warn', text: '2 outputs not filled by any step — the proposal fixes them' },
    ],
    [
      cov(['a', 'b']),
      cov(['b']),
      { tone: 'warn', text: '2 outputs not filled by any step — the proposal fixes 1' },
    ],
    [
      cov(['a']),
      cov(['a']),
      { tone: 'warn', text: '1 output not filled by any step — the proposal does not fix it' },
    ],
  ])('%#', (now, after, expected) => {
    expect(coverageHeadline(now, after)).toEqual(expected);
  });
});

const metric = (avgAttempts: number, failures = 0, avgSeconds: number | null = 6) => ({
  stepId: 's',
  runs: 18,
  reruns: 0,
  failures,
  avgAttempts,
  avgOutputTokens: null,
  avgSeconds,
});

describe('step figures', () => {
  it('formats the figures and flags failures and retries', () => {
    expect(stepFigures(metric(1.1))).toEqual({
      runs: '18',
      failed: '0',
      attempts: '1.1',
      avgTime: '6 s',
      failedWarn: false,
      attemptsWarn: false,
    });
    expect(stepFigures(metric(2, 1, null))).toEqual({
      runs: '18',
      failed: '1',
      attempts: '2.0',
      avgTime: '—',
      failedWarn: true,
      attemptsWarn: true,
    });
    expect(stepFigures(undefined)).toBeNull();
  });

  it('explains a step that keeps retrying, in plain words', () => {
    expect(retryWarning(metric(1.4))).toBeNull();
    expect(retryWarning(undefined)).toBeNull();
    expect(retryWarning(metric(RETRY_WARN_ATTEMPTS))).toBe(
      'Needs a retry on many runs (1.5 attempts on average): the first answer often fails the checks. Narrow the sections it reads or add instructions on the Template tab.',
    );
  });
});
