import { describe, expect, it } from 'vitest';
import type { BriefVersionView, SurveyBody } from '@ih/shared';
import {
  briefStatus,
  compareOf,
  csvPreview,
  openQuestions,
  versionChangeText,
} from '../src/workbench/brief.js';

const now = Date.parse('2026-10-13T12:00:00.000Z');
const view = (version: number, o: Partial<BriefVersionView> = {}): BriefVersionView => ({
  version,
  createdAt: '2026-10-11T12:00:00.000Z',
  changedSections: [],
  usedBy: [],
  ...o,
});

describe('briefStatus', () => {
  it.each([
    [0, 'Saved as v3 · 2 days ago'],
    [1, 'Saved as v3 · 2 days ago · 1 field changed since'],
    [2, 'Saved as v3 · 2 days ago · 2 fields changed since'],
  ])('%i unsaved', (changed, text) => {
    expect(briefStatus(3, '2026-10-11T12:00:00.000Z', changed, now)).toBe(text);
  });

  it('lower-cases the age mid-sentence', () => {
    expect(briefStatus(1, '2026-10-12T11:00:00.000Z', 0, now)).toBe('Saved as v1 · yesterday');
    expect(briefStatus(1, '2026-10-13T11:59:30.000Z', 0, now)).toBe('Saved as v1 · just now');
  });
});

describe('versionChangeText', () => {
  it.each<[string, BriefVersionView, string]>([
    ['the first', view(1, { changedSections: ['purpose'] }), 'First brief'],
    ['one section', view(2, { changedSections: ['exampleOutput'] }), 'Example output'],
    ['several', view(3, { changedSections: ['variants', 'rules'] }), 'Variants, rules'],
    ['answers', view(4, { changedSections: ['answers'] }), 'Survey answers'],
    ['nothing (saved twice)', view(5), 'No changes'],
  ])('%s', (_name, v, text) => {
    expect(versionChangeText(v)).toBe(text);
  });
});

describe('csvPreview', () => {
  it.each<[string, string, ReturnType<typeof csvPreview>]>([
    ['empty', '', null],
    ['a header only', 'a,b', null],
    ['one column', 'a\n1', null],
    [
      'quoted cells, blank lines dropped',
      'invoice,description,amount\nINV-1,"Nitrile gloves, M (100)",85.00\n\n',
      {
        header: ['invoice', 'description', 'amount'],
        rows: [['INV-1', 'Nitrile gloves, M (100)', '85.00']],
      },
    ],
  ])('%s', (_name, text, preview) => {
    expect(csvPreview(text)).toEqual(preview);
  });
});

describe('openQuestions', () => {
  const survey: SurveyBody = {
    summary: '',
    structure: [],
    variants: [],
    candidates: [],
    questions: [
      { question: 'Which copy?', why: '' },
      { question: 'Date format?', why: '' },
      { question: 'Currency?', why: '' },
    ],
  };
  it('counts questions without a saved answer', () => {
    expect(
      openQuestions(survey, [
        { question: 'Which copy?', answer: 'Executed' },
        { question: 'Date format?', answer: '  ' },
      ]),
    ).toBe(2);
  });
});

describe('compareOf', () => {
  const versions = [view(3), view(2), view(1)];
  it.each<[number, [number, number] | null]>([
    [3, [2, 3]],
    [2, [2, 3]],
    [1, [1, 3]],
  ])('v%i', (version, pair) => {
    expect(compareOf(version, versions)).toEqual(pair);
  });
  it('has nothing to compare with one version', () => {
    expect(compareOf(1, [view(1)])).toBeNull();
  });
});
