import { describe, expect, it } from 'vitest';
import type { TemplateSummary } from '../src/api/client.js';
import { qualityLine, shapeLine } from '../src/templates/quality.js';

const summary = (o: Partial<TemplateSummary> = {}): TemplateSummary => ({
  sections: 5,
  fields: 9,
  tables: 1,
  references: 0,
  draftIssues: null,
  lastRegression: null,
  regressionRunning: false,
  ...o,
});

describe('shapeLine', () => {
  it.each([
    [summary(), '5 sections · 9 fields · 1 table'],
    [summary({ sections: 1, fields: 1, tables: 0 }), '1 section · 1 field · 0 tables'],
  ])('%#', (s, text) => expect(shapeLine(s)).toBe(text));
});

describe('qualityLine', () => {
  const run = (matched: number, total: number) => ({ version: 4, matched, total, at: '' });
  it.each<[TemplateSummary, number | null, string, string]>([
    [
      summary({ draftIssues: 2, references: 3, lastRegression: run(3, 3) }),
      4,
      'Draft v4 has 2 validation issues',
      'warn',
    ],
    [summary({ draftIssues: 1 }), 4, 'Draft v4 has 1 validation issue', 'warn'],
    [
      summary({ draftIssues: 0, references: 3, lastRegression: run(3, 3) }),
      4,
      'Regression: 3 of 3 references match',
      'ok',
    ],
    [
      summary({ references: 3, lastRegression: run(2, 3) }),
      null,
      'Regression: 2 of 3 references match',
      'warn',
    ],
    [summary({ references: 3, regressionRunning: true }), 4, 'Regression running…', 'muted'],
    [summary({ references: 0 }), null, 'No reference documents yet', 'muted'],
    [summary({ references: 1 }), null, '1 reference · no regression run yet', 'muted'],
    [summary({ references: 2 }), null, '2 references · no regression run yet', 'muted'],
  ])('%#: %s', (s, draft, text, tone) => expect(qualityLine(s, draft)).toEqual({ text, tone }));
});
