import { describe, expect, it } from 'vitest';
import type { ReferenceRow } from '@ih/shared';
import {
  correctionSummary,
  matchesFilter,
  readyBanner,
  reviewHref,
  rowLine,
  rowStatus,
  tracker,
  trackerLabel,
  unverifiedCount,
} from '../src/workbench/references.js';
import { referenceInfo, referenceRow } from './fake-api.js';

const run = (status: NonNullable<ReferenceRow['run']>['status']) => ({
  jobId: 'j1',
  status,
  error: null,
  modelOverride: 'draft',
});
const saved = (o = {}) => referenceRow({ reference: referenceInfo(o) });

describe('tracker and status', () => {
  it.each<[string, ReferenceRow, [boolean, boolean, boolean], string]>([
    ['not run', referenceRow(), [false, false, false], 'Not run'],
    ['running', referenceRow({ run: run('running') }), [false, false, false], 'Running'],
    [
      'awaiting review',
      referenceRow({ run: run('awaiting_review') }),
      [true, false, false],
      'Awaiting review',
    ],
    [
      'approved, not saved',
      referenceRow({ run: run('succeeded') }),
      [true, true, false],
      'Reviewed — save it as the reference',
    ],
    [
      'run failed',
      referenceRow({ run: run('needs_review') }),
      [false, false, false],
      'Run needs attention',
    ],
    ['verified', saved(), [true, true, true], 'Verified'],
    [
      'outdated',
      saved({ outdated: ['field:due_date'] }),
      [true, true, false],
      'Re-verify: due_date changed',
    ],
  ])('%s', (_name, row, steps, status) => {
    const t = tracker(row);
    expect([t.ran, t.reviewed, t.saved]).toEqual(steps);
    expect(rowStatus(row)).toBe(status);
  });

  it('labels the tracker with every step', () => {
    expect(trackerLabel({ ran: true, reviewed: true, saved: false })).toBe(
      'Run: done · Reviewed: done · Saved: not yet',
    );
  });
});

describe('row text', () => {
  it.each<[string, ReferenceRow, RegExp | string]>([
    ['no reference', referenceRow(), 'Not verified yet'],
    ['verified at this version', saved({ version: 4 }), /^Verified in v4 · /],
    ['carried', saved({ version: 4, carriedFrom: 3 }), /^Carried from v3 · /],
    [
      're-verified',
      saved({ version: 4, reverified: { from: 3, changed: [] } }),
      /^Re-verified in v4 · .+ · was v3$/,
    ],
    ['unpinned', saved({ version: null }), /^Verified · /],
  ])('%s', (_name, row, expected) => {
    const line = rowLine(row);
    if (typeof expected === 'string') expect(line).toBe(expected);
    else expect(line).toMatch(expected);
  });

  it.each<[string, ReferenceRow, string]>([
    ['no reference', referenceRow(), ''],
    ['nothing changed', saved({ corrections: [] }), 'No corrections'],
    ['unknown', saved({ corrections: null }), 'Corrections unknown'],
    [
      'corrected outputs, once each, entered ones left to the strip',
      saved({
        corrections: [
          { key: 'line_items[1].qty', kind: 'corrected', proposed: '1' },
          { key: 'line_items[2].qty', kind: 'corrected', proposed: '2' },
          { key: 'total', kind: 'corrected', proposed: '3' },
          { key: 'due_date', kind: 'entered', proposed: null },
        ],
      }),
      'Corrected: line_items, total',
    ],
    [
      'only entered',
      saved({ corrections: [{ key: 'due_date', kind: 'entered', proposed: null }] }),
      'No corrections',
    ],
  ])('%s', (_name, row, expected) => {
    expect(correctionSummary(row)).toBe(expected);
  });

  it('links Review to the source run of a reference, else the latest run', () => {
    expect(reviewHref(saved({ sourceJobId: 'src' }))).toBe('#/review/src');
    expect(reviewHref(referenceRow({ run: run('awaiting_review') }))).toBe('#/review/j1');
    expect(reviewHref(referenceRow({ run: run('running') }))).toBeNull();
    expect(reviewHref(referenceRow())).toBeNull();
  });
});

describe('filters, counts and the ready banner', () => {
  const corrected = saved({ corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }] });
  const clean = saved();
  const outdated = saved({ outdated: ['field:vat'] });
  const open = referenceRow({ run: run('running') });
  const none = referenceRow();

  it.each<[string, ReferenceRow, boolean, boolean]>([
    ['corrected', corrected, true, false],
    ['clean', clean, false, false],
    ['outdated', outdated, false, true],
    ['running', open, false, true],
    ['nothing yet', none, false, true],
  ])('%s', (_name, row, isCorrected, needsYou) => {
    expect(matchesFilter(row, 'all')).toBe(true);
    expect(matchesFilter(row, 'corrected')).toBe(isCorrected);
    expect(matchesFilter(row, 'needs')).toBe(needsYou);
  });

  it('counts unverified samples without an active run', () => {
    expect(unverifiedCount([corrected, outdated, open, none])).toBe(2);
  });

  it.each<[string, ReferenceRow[], ReferenceRow[], { ready: boolean; text: string }]>([
    ['no dev samples', [], [clean], { ready: false, text: '' }],
    ['one unverified', [clean, none], [clean], { ready: false, text: '' }],
    [
      'all verified',
      [clean, corrected],
      [clean],
      { ready: true, text: '2 dev and 1 holdout references match the draft v4 outputs.' },
    ],
    [
      'with re-verifications',
      [
        saved({ reverified: { from: 3, changed: ['field:due_date'] } }),
        saved({ reverified: { from: 3, changed: ['field:due_date', 'table:line_items.qty'] } }),
      ],
      [],
      {
        ready: true,
        text: '2 dev and 0 holdout references match the draft v4 outputs. 2 were re-verified this version because these outputs changed: due_date, line_items.qty.',
      },
    ],
  ])('%s', (_name, dev, holdout, expected) => {
    expect(readyBanner(dev, holdout, 4)).toEqual(expected);
  });

  it('says published vN when no draft is open', () => {
    expect(readyBanner([clean], [], 3, false).text).toBe(
      '1 dev and 0 holdout references match the published v3 outputs.',
    );
  });

  it('names outdated outputs without their field:/table: prefix', () => {
    expect(rowStatus(saved({ outdated: ['field:vat', 'table:lines'] }))).toBe(
      'Re-verify: vat, lines changed',
    );
  });
});
