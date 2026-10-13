import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatCount,
  loadPageSize,
  nextHref,
  pagerPages,
  phaseLine,
  recentProjects,
  rememberProject,
  savePageSize,
} from '../src/workbench/listDerive.js';
import { projectListItem } from './fake-api.js';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('pagerPages', () => {
  it.each([
    [1, 1, [1]],
    [1, 5, [1, 2, 3, 4, 5]],
    [1, 40, [1, 2, 3, '…', 40]],
    [20, 40, [1, '…', 19, 20, 21, '…', 40]],
    [40, 40, [1, '…', 38, 39, 40]],
    [3, 40, [1, 2, 3, 4, '…', 40]],
  ] as const)('page %i of %i', (current, last, expected) => {
    expect(pagerPages(current, last)).toEqual(expected);
  });
});

describe('phaseLine', () => {
  it.each([
    [{ phase: 'draft' as const, done: 5 }, 'Draft · 5 of 10 done'],
    [{ phase: 'prepare' as const, done: 1 }, 'Prepare · 1 of 10 done'],
    [{ phase: 'verify' as const, done: 9 }, 'Verify · 9 of 10 done'],
    [{ phase: 'published' as const, done: 10 }, 'Published · no open draft'],
  ])('%o', (over, text) => {
    expect(phaseLine(projectListItem(over))).toBe(text);
  });
});

describe('nextHref', () => {
  it.each([
    [
      { kind: 'decide' as const, stage: 'steps' as const, label: 'Decide on Steps' },
      '#/workbench/letter/steps',
    ],
    [
      { kind: 'publish' as const, stage: 'publish' as const, label: 'Publish v2' },
      '#/workbench/letter/evaluate',
    ],
    [
      { kind: 'start_version' as const, stage: null, label: 'Start v4' },
      '#/workbench/letter/template',
    ],
  ])('%o', (next, href) => {
    expect(nextHref(projectListItem({ next }))).toBe(href);
  });
});

describe('page size', () => {
  it('defaults to 25 and remembers 25, 50 or 100', () => {
    expect(loadPageSize()).toBe(25);
    savePageSize(50);
    expect(loadPageSize()).toBe(50);
  });
  it('ignores garbage and storage that throws', () => {
    localStorage.setItem('ih.wbPageSize', '7');
    expect(loadPageSize()).toBe(25);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadPageSize()).toBe(25);
  });
});

describe('recent projects', () => {
  it('keeps the ten most recently opened, newest first, without duplicates', () => {
    for (let n = 0; n < 12; n++) rememberProject(`p${n}`);
    rememberProject('p5');
    const recent = recentProjects();
    expect(recent[0]).toBe('p5');
    expect(recent).toHaveLength(10);
    expect(new Set(recent).size).toBe(10);
  });
  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => rememberProject('x')).not.toThrow();
  });
});

describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(1000)).toBe('1,000');
    expect(formatCount(37)).toBe('37');
  });
});
