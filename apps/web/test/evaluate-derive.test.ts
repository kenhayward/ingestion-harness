import { describe, expect, it } from 'vitest';
import type { Comparison, GateHint, IterationSummary } from '@ih/shared';
import {
  accuracyLabel,
  accuracyList,
  accuracyTone,
  devScore,
  gateTag,
  gateTitle,
  hintText,
  historyBars,
  historyRows,
  historySummary,
  latestOf,
  offOutputs,
  outputsDiffering,
  parseThreshold,
  tableDiff,
} from '../src/workbench/evaluate.js';
import { iterationView, publishGateView } from './fake-api.js';

const h = (o: Partial<IterationSummary>): IterationSummary => iterationView(o);
const acc = (id: string, matched: number, total: number) => ({
  id,
  matched,
  total,
  accuracy: matched / total,
});
const table = (id: string, o: Partial<Comparison['tables'][number]> = {}) => ({
  id,
  expected: 2,
  actual: 2,
  matched: 2,
  missing: [],
  extra: [],
  changed: [],
  cells: 4,
  cellsTotal: 4,
  columns: {},
  ...o,
});

describe('accuracyTone', () => {
  it.each([
    [0.69, 0.9, 'low'],
    [0.7, 0.9, 'below'],
    [0.89, 0.9, 'below'],
    [0.9, 0.9, 'ok'],
    [0.6, 0.5, 'ok'],
    [1, 1, 'ok'],
  ] as const)('%s against %s is %s', (accuracy, threshold, tone) => {
    expect(accuracyTone(accuracy, threshold)).toBe(tone);
  });

  it('puts the tone in words for the bar label', () => {
    expect(accuracyLabel(acc('due_date', 0, 2), 0.9)).toBe('due_date: 0%, 0 of 2, under 70%');
    expect(accuracyLabel(acc('total', 5, 6), 0.9)).toBe('total: 83%, 5 of 6, under the threshold');
    expect(accuracyLabel(acc('qty', 115, 116), 0.9)).toBe(
      'qty: 99%, 115 of 116, meets the threshold',
    );
  });
});

describe('accuracyList', () => {
  it('lists worst first and only counts what is at 100%', () => {
    const list = accuracyList(
      { fields: [acc('c', 2, 2), acc('a', 0, 2), acc('b', 1, 2)], columns: [acc('t.x', 13, 14)] },
      2,
    );
    expect(list.rows.map((a) => a.id)).toEqual(['a', 'b']);
    expect(list).toMatchObject({ more: 1, perfect: 1 });
  });
});

describe('offOutputs / outputsDiffering / tableDiff', () => {
  const c: Comparison = {
    score: 0.5,
    fields: [
      { id: 'sent_on', expected: '2026-03-01', actual: '2026-01-03', match: false },
      { id: 'sender', expected: 'Acme', actual: 'Acme', match: true },
    ],
    tables: [table('lines', { missing: [{ qty: 1 }], actual: 1, matched: 1 }), table('fees')],
  };
  it('names the differing fields, then the tables with a differing row', () => {
    expect(offOutputs(c)).toEqual(['sent_on', 'lines']);
    expect(outputsDiffering(c)).toEqual({ differ: 2, of: 4 });
  });
  it.each([
    [table('fees'), '2 rows'],
    [table('lines', { actual: 1, missing: [{ qty: 1 }] }), '1 row · 1 missing'],
    [
      table('lines', {
        actual: 3,
        extra: [{ qty: 9 }],
        changed: [{ expected: { qty: 1 }, actual: { qty: 2 }, columns: ['qty'] }],
      }),
      '3 rows · 1 changed · 1 extra',
    ],
  ])('describes a table result', (t, text) => {
    expect(tableDiff(t)).toBe(text);
  });
});

describe('latestOf / devScore', () => {
  const g = crypto.randomUUID();
  const list = [
    h({ id: 'h4', set: 'holdout', templateVersion: 4, score: 0.88 }),
    h({ id: 'run', status: 'running', score: null, templateVersion: 4 }),
    h({ id: 'fast', model: 'fast', templateVersion: 4, score: 0.7 }),
    h({ id: 'cmp', groupId: g, model: 'default', templateVersion: 4, score: 0.99 }),
    h({ id: 'd4', templateVersion: 4, score: 0.91 }),
    h({ id: 'd3', templateVersion: 3, score: 0.92 }),
  ];
  it('takes the newest run of a set that is not part of a comparison', () => {
    expect(latestOf(list, 'dev')?.id).toBe('run');
    expect(latestOf(list, 'holdout')?.id).toBe('h4');
    expect(latestOf([], 'dev')).toBeNull();
  });
  it('scores dev with the newest complete template-model run of the version', () => {
    expect(devScore(list, 4)).toBe(0.91);
    expect(devScore(list, 3)).toBe(0.92);
    expect(devScore(list, 5)).toBeNull();
    expect(devScore(list, null)).toBeNull();
  });
});

describe('historyRows', () => {
  it('collapses a model comparison into one row, models in order, best score', () => {
    const g = crypto.randomUUID();
    const rows = historyRows([
      h({ id: 'x3', model: 'draft', groupId: g, score: 0.89 }),
      h({ id: 'x2', model: 'fast', groupId: g, score: 0.84 }),
      h({ id: 'x1', model: 'default', groupId: g, score: 0.91 }),
      h({ id: 't', uncached: true, score: 0.86 }),
      h({ id: 'r', set: 'holdout', status: 'running', score: null }),
    ]);
    expect(rows.map((r) => [r.label, r.score, r.id, r.running, r.set])).toEqual([
      ['Compare · default 91 · fast 84 · draft 89', 0.91, 'x3', false, 'dev'],
      ["Recipe's models · fresh", 0.86, 't', false, 'dev'],
      ["Recipe's models", null, 'r', true, 'holdout'],
    ]);
  });
});

describe('historyBars / historySummary', () => {
  const list = [
    h({ id: 'h4', set: 'holdout', templateVersion: 4, score: 0.88 }),
    h({ id: 'run', status: 'running', score: null }),
    h({ id: 'fast', model: 'fast', score: 0.7 }),
    h({ id: 'cmp', groupId: crypto.randomUUID(), model: 'default', score: 0.91 }),
    h({ id: 'd4', templateVersion: 4, score: 0.91 }),
    h({ id: 'd3', templateVersion: 3, score: 0.92 }),
  ];
  it('keeps finished template-model runs, oldest first, dimming other versions', () => {
    expect(historyBars(list, 4)).toEqual([
      { id: 'd3', version: 3, set: 'dev', score: 0.92, dimmed: true },
      { id: 'd4', version: 4, set: 'dev', score: 0.91, dimmed: false },
      { id: 'h4', version: 4, set: 'holdout', score: 0.88, dimmed: false },
    ]);
    expect(historyBars(list, null).map((b) => b.dimmed)).toEqual([true, false, false]);
    expect(historyBars(list, 4, 2).map((b) => b.id)).toEqual(['d4', 'h4']);
  });
  it('summarises the chart in words', () => {
    expect(historySummary(historyBars(list, 4), 0.9)).toBe(
      '3 runs with the recipe’s models; latest dev 91% (v4); latest holdout 88% (v4); threshold 90%',
    );
    expect(historySummary(historyBars(list.slice(4), 4), 0.9)).toBe(
      '2 runs with the recipe’s models; latest dev 91% (v4); no holdout run; threshold 90%',
    );
    expect(historySummary([], 0.9)).toBe('No runs with the recipe’s models yet');
  });
});

describe('parseThreshold', () => {
  const error = { error: 'Enter a whole percentage from 0 to 100' };
  it.each([
    ['90', { value: 0.9 }],
    ['0', { value: 0 }],
    ['100', { value: 1 }],
    [' 75 ', { value: 0.75 }],
    ['', error],
    ['  ', error],
    ['101', error],
    ['-1', error],
    ['85.5', error],
    ['abc', error],
    ['1e1', error],
    ['+5', error],
    ['0x10', error],
  ])('%j', (text, expected) => {
    expect(parseThreshold(text)).toEqual(expected);
  });
});

describe('gateTag / gateTitle', () => {
  const below = publishGateView({
    iterationId: crypto.randomUUID(),
    score: 0.88,
    reason: 'holdout score 88% is below the threshold 90%',
  });
  it.each([
    ['no draft', null, null, { label: 'PUBLISHED', tone: 'ok' }],
    [
      'passing',
      publishGateView({ passes: true, score: 0.95 }),
      4,
      { label: 'MEETS THRESHOLD', tone: 'ok' },
    ],
    ['below', below, 4, { label: 'BELOW THRESHOLD', tone: 'warn' }],
    ['no deciding run', publishGateView(), 4, { label: 'NOT MEASURED', tone: 'neutral' }],
    ['still loading', null, 4, { label: 'NOT MEASURED', tone: 'neutral' }],
  ] as const)('%s', (_name, gate, draft, tag) => {
    expect(gateTag(gate, draft)).toEqual(tag);
  });
  it('titles the card with the gate reason', () => {
    expect(gateTitle(below, 4, 3)).toBe(
      'Publish v4 — holdout score 88% is below the threshold 90%',
    );
    expect(gateTitle(null, 4, 3)).toBe('Publish v4');
    expect(gateTitle(null, null, 3)).toBe('v3 is live. Start the next version on the Recipe tab.');
    expect(gateTitle(null, null, null)).toBe('Nothing to publish');
  });
});

describe('hintText', () => {
  it.each<[GateHint, string]>([
    [
      { key: 'due_date', accuracy: 0, cause: 'no_step', stage: 'steps' },
      'due_date scores 0% on holdout: no step of the draft fills it.',
    ],
    [
      { key: 'po_number', accuracy: 0.5, cause: 'low_accuracy', stage: 'revise' },
      'po_number is right on 50% of holdout values. Comment on its dev mismatches, then revise.',
    ],
  ])('%j', (hint, text) => {
    expect(hintText(hint)).toBe(text);
  });
});
