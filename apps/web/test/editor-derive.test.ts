import { describe, expect, it } from 'vitest';
import {
  publishBlocker,
  recentTestRuns,
  stepSummary,
  tabCounts,
} from '../src/templates/editor-derive.js';
import { job } from './fake-api.js';

describe('publishBlocker', () => {
  it.each<[boolean, number, string | null]>([
    [true, 2, 'Save the draft before publishing'],
    [true, 0, 'Save the draft before publishing'],
    [false, 1, 'Fix 1 validation issue'],
    [false, 3, 'Fix 3 validation issues'],
    [false, 0, null],
  ])('dirty %s, %i issues', (dirty, issues, reason) =>
    expect(publishBlocker(dirty, issues)).toBe(reason),
  );
});

describe('tabCounts', () => {
  it('counts what is there and 0 for what is missing', () => {
    expect(
      tabCounts({
        document: { sections: [{}, {}] },
        outputs: { fields: [{}], tables: 'oops' },
        pipeline: [{}, {}, {}],
      }),
    ).toEqual({ sections: 2, fields: 1, tables: 0, steps: 3 });
    expect(tabCounts({})).toEqual({ sections: 0, fields: 0, tables: 0, steps: 0 });
  });
});

describe('stepSummary', () => {
  it.each<[Record<string, unknown>, string]>([
    [
      { type: 'extract', fields: ['a', 'b'], sections: ['header', 'supplier'] },
      '2 fields · reads header, supplier · default model',
    ],
    [
      { type: 'extract', fields: ['a'], sections: ['header'], model: 'local/x' },
      '1 field · reads header · local/x',
    ],
    [{ type: 'extract', fields: [], sections: [] }, '0 fields · default model'],
    [
      { type: 'extract', table: 'lines', chunkPages: 2, model: 'm', sections: ['all'] },
      'Table lines · 2 pages per call · m',
    ],
    [{ type: 'extract', table: 'lines', fields: [] }, 'Table lines · default model'],
    [
      { type: 'check', values: 'lines.batch', reference: 'header.batches' },
      'lines.batch vs header.batches',
    ],
    [{ type: 'check', values: '', reference: '' }, 'not set up yet'],
    [{ type: 'other' }, ''],
  ])('%j', (step, text) => expect(stepSummary(step)).toBe(text));
});

describe('recentTestRuns', () => {
  const at = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, '0')}:00Z`;
  it('lists the newest test runs of this type, without regression runs', () => {
    const jobs = [
      job({ id: 'a', specId: 'letter', test: true, createdAt: at(1) }),
      job({ id: 'b', specId: 'letter', test: true, createdAt: at(3) }),
      job({ id: 'c', specId: 'other', test: true, createdAt: at(4) }),
      job({ id: 'd', specId: 'letter', test: false, createdAt: at(5) }),
      job({ id: 'e', specId: 'letter', test: true, referenceId: 'r', createdAt: at(6) }),
    ];
    expect(recentTestRuns(jobs, 'letter').map((j) => j.id)).toEqual(['b', 'a']);
  });

  it('keeps at most n', () => {
    const jobs = Array.from({ length: 8 }, (_, i) =>
      job({ id: `j${i}`, specId: 'letter', test: true, createdAt: at(i) }),
    );
    expect(recentTestRuns(jobs, 'letter').map((j) => j.id)).toEqual(['j7', 'j6', 'j5', 'j4', 'j3']);
  });
});
