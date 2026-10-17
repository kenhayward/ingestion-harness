import { describe, expect, it } from 'vitest';
import type { StageView } from '@ih/shared';
import {
  answerProgress,
  candidateCounts,
  saveAnswersLabel,
  seenInText,
  skipBanner,
  skipBannerText,
} from '../src/workbench/survey.js';

const qs = [
  { question: 'A?', why: 'a' },
  { question: 'B?', why: 'b' },
  { question: 'C?', why: 'c' },
];

describe('answerProgress', () => {
  it.each<
    [string, { question: string; answer: string }[], Record<string, string>, number, string[]]
  >([
    ['nothing yet', [], {}, 0, []],
    ['saved answers count as answered, not unsaved', [{ question: 'A?', answer: 'x' }], {}, 1, []],
    ['typed answers count and are unsaved', [], { 'B?': ' y ' }, 1, ['B?']],
    [
      'typing the saved answer again is not a change',
      [{ question: 'A?', answer: 'x' }],
      { 'A?': 'x' },
      1,
      [],
    ],
    [
      'clearing a saved answer unanswers it, and is saved as a removal',
      [{ question: 'A?', answer: 'x' }],
      { 'A?': '' },
      0,
      ['A?'],
    ],
    ['blank typing is not an answer', [], { 'C?': '   ' }, 0, []],
  ])('%s', (_name, saved, typed, answered, unsaved) => {
    const p = answerProgress(qs, saved, typed);
    expect(p.answered).toBe(answered);
    expect(p.of).toBe(3);
    expect(p.unsaved.map((u) => u.question)).toEqual(unsaved);
  });

  it('trims what it would save', () => {
    expect(answerProgress(qs, [], { 'B?': ' y ' }).unsaved).toEqual([
      { question: 'B?', answer: 'y' },
    ]);
  });
});

describe('saveAnswersLabel', () => {
  it.each([
    [0, 4, 'Save answers to brief (v4)'],
    [1, 4, 'Save 1 answer to brief (v4)'],
    [2, 1, 'Save 2 answers to brief (v1)'],
  ])('%i answers, next v%i', (n, next, expected) => {
    expect(saveAnswersLabel(n, next)).toBe(expected);
  });
});

describe('skipBanner', () => {
  const T1 = '2026-10-03T09:00:00.000Z';
  const T2 = '2026-10-05T09:00:00.000Z';
  const stage = (o: Partial<StageView> & Pick<StageView, 'stage'>): StageView => ({
    state: 'pending',
    completedAt: null,
    skippedAt: null,
    ...o,
  });
  const skipped = [
    stage({ stage: 'survey', state: 'proposed', completedAt: T1, skippedAt: T1 }),
    stage({ stage: 'outputs', state: 'accepted', completedAt: T2 }),
    stage({ stage: 'sections', state: 'skipped', completedAt: T2, skippedAt: T2 }),
    stage({ stage: 'steps' }),
  ];
  const ready = { status: 'ready' as const, createdAt: '2026-10-13T09:00:00.000Z' };

  it.each<[string, StageView[], typeof ready | null, ReturnType<typeof skipBanner>]>([
    [
      'a skip in force and a newer survey',
      skipped,
      ready,
      { skippedAt: T1, later: ['outputs', 'sections'] },
    ],
    ['no survey run since', skipped, null, null],
    [
      'the survey ran before the skip',
      skipped,
      { ...ready, createdAt: '2026-10-01T00:00:00.000Z' },
      null,
    ],
    [
      'accepted since: the skip no longer counts',
      [stage({ stage: 'survey', state: 'accepted', completedAt: T2, skippedAt: T1 })],
      { ...ready, status: 'accepted' as never },
      null,
    ],
    ['never skipped', [stage({ stage: 'survey', state: 'proposed' })], ready, null],
  ])('%s', (_name, stages, proposal, expected) => {
    expect(skipBanner(stages, proposal)).toEqual(expected);
  });

  it('names the stages that will go stale', () => {
    expect(skipBannerText({ skippedAt: T1, later: ['outputs', 'sections', 'steps'] })).toMatch(
      /^You skipped this stage on .+, then ran it again\. Accepting replaces the skip — Outputs, Sections and Pipeline were completed without it and will be marked stale so you can re-propose them\.$/,
    );
    expect(skipBannerText({ skippedAt: T1, later: ['outputs'] })).toMatch(
      /Outputs was completed without it and will be marked stale so you can re-propose it\.$/,
    );
    expect(skipBannerText({ skippedAt: T1, later: [] })).toMatch(/Accepting replaces the skip\.$/);
  });
});

describe('seenInText and candidateCounts', () => {
  it.each([
    [{ n: 3, of: 6 }, '3 of 6 samples'],
    [{ n: 1, of: 1 }, '1 of 1 sample'],
    [{ n: 0, of: 0 }, null],
    [undefined, null],
  ])('%j', (seen, expected) => {
    expect(seenInText(seen)).toBe(expected);
  });

  it('counts fields and tables', () => {
    const c = (kind: 'field' | 'table') => ({ name: 'x', description: '', where: '', kind });
    expect(candidateCounts([c('field'), c('field'), c('table')])).toBe('2 fields · 1 table');
    expect(candidateCounts([])).toBe('0 fields · 0 tables');
  });
});
