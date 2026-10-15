import { describe, expect, it } from 'vitest';
import type { BriefVersionView, ExportView, SurveyBody } from '@ih/shared';
import {
  restoredNote,
  briefStatus,
  compareOf,
  csvPreview,
  exportStatusText,
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

describe('exportStatusText', () => {
  const exp = (o: Partial<ExportView>): ExportView => ({
    jobId: 'j1',
    status: 'succeeded',
    error: null,
    createdAt: 't',
    updatedAt: 't',
    briefVersion: 3,
    devSamples: 6,
    bytes: 3_250_000,
    ...o,
  });
  it.each<[string, Partial<ExportView>, string]>([
    ['ready with every fact', {}, 'Export ready · brief v3 · 6 dev samples · 3.1 MB'],
    [
      'one sample, no brief, size unknown',
      { briefVersion: null, devSamples: 1, bytes: null },
      'Export ready · no brief · 1 dev sample',
    ],
    [
      'facts unreadable',
      { briefVersion: null, devSamples: null, bytes: null },
      'Export ready · no brief',
    ],
    ['running', { status: 'running' }, 'Export running…'],
    ['queued', { status: 'queued' }, 'Export queued…'],
    ['failed', { status: 'needs_review', error: 'boom' }, 'Export failed: boom'],
    ['cancelled', { status: 'cancelled' }, 'Export cancelled'],
  ])('%s', (_name, o, text) => {
    expect(exportStatusText(exp(o))).toBe(text);
  });
});

describe('restoredNote', () => {
  it.each([
    [
      2,
      2,
      'Restored your unsaved changes from your last visit: save them as a new version, or discard them.',
    ],
    [
      2,
      3,
      'Restored your unsaved changes, made on v2. The brief is now v3: check them before saving.',
    ],
    [
      null,
      1,
      'Restored your unsaved changes, made before the first version. The brief is now v1: check them before saving.',
    ],
    [
      null,
      null,
      'Restored your unsaved changes from your last visit: save them as a new version, or discard them.',
    ],
  ])('edits made on %s, saved now %s', (from, now, note) => {
    expect(restoredNote(from, now)).toBe(note);
  });
});
