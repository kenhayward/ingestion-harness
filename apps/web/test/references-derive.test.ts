import { describe, expect, it } from 'vitest';
import type { ReferenceRow } from '@ih/shared';
import {
  correctionSummary,
  matchesFilter,
  readyBanner,
  reviewHref,
  rowLine,
  rowProgress,
  rowStatus,
  runsSummary,
  runsTitle,
  tracker,
  trackerLabel,
  unverifiedCount,
} from '../src/workbench/references.js';
import { referenceInfo, referenceRow } from './fake-api.js';

type Run = NonNullable<ReferenceRow['run']>;
const run = (status: Run['status'], progress: Run['progress'] = null): Run => ({
  jobId: 'j1',
  status,
  error: null,
  modelOverride: 'draft',
  progress,
});
const saved = (o = {}) => referenceRow({ reference: referenceInfo(o) });

describe('tracker and status', () => {
  it.each<[string, ReferenceRow, [boolean, boolean, boolean], string]>([
    ['not run', referenceRow(), [false, false, false], 'Not run'],
    ['queued', referenceRow({ run: run('queued') }), [false, false, false], 'Waiting for a worker'],
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

describe('run progress', () => {
  const step = { step: 'lines', index: 2, of: 3, attempt: 1, chunk: null, occurrence: null };
  it.each<[string, ReferenceRow, string | null]>([
    ['no run', referenceRow(), null],
    ['queued', referenceRow({ run: run('queued') }), null],
    ['running, nothing reported', referenceRow({ run: run('running') }), 'Starting…'],
    [
      'reading the text layer',
      referenceRow({
        run: run('running', { kind: 'prepare', stage: 'text', page: 0, of: 4, pages: 4 }),
      }),
      'Reading 4 pages',
    ],
    [
      'OCR',
      referenceRow({
        run: run('running', { kind: 'prepare', stage: 'ocr', page: 2, of: 5, pages: 5 }),
      }),
      'OCR page 2 of 5',
    ],
    [
      'segmented',
      referenceRow({ run: run('running', { kind: 'segmented' }) }),
      'Found the sections',
    ],
    [
      'a step',
      referenceRow({ run: run('running', { kind: 'step', ...step }) }),
      'Step 2 of 3 · lines',
    ],
    [
      'a retried chunk',
      referenceRow({
        run: run('running', { kind: 'step', ...step, attempt: 2, chunk: { n: 1, of: 2 } }),
      }),
      'Step 2 of 3 · lines · chunk 1 of 2 · attempt 2',
    ],
    ['awaiting review', referenceRow({ run: run('awaiting_review') }), null],
  ])('%s', (_name, row, text) => {
    expect(rowProgress(row)).toBe(text);
  });

  it('counts the unverified samples whose runs are going or done', () => {
    const rows = [
      referenceRow({ run: run('running') }),
      referenceRow({ run: run('queued') }),
      referenceRow({ run: run('queued') }),
      referenceRow({ run: run('awaiting_review') }),
      referenceRow({ run: run('needs_review') }),
      referenceRow(),
      saved(),
    ];
    expect(runsSummary(rows)).toEqual({ running: 1, queued: 2, finished: 2, total: 5 });
    expect(runsSummary([referenceRow({ run: run('awaiting_review') }), saved()])).toBeNull();
  });
});

describe('the header while reference runs are going', () => {
  const step = { step: 'lines', index: 2, of: 6, attempt: 1, chunk: null, occurrence: null };
  const going = run('running', { kind: 'step', ...step });
  it.each<[string, ReferenceRow[], string | null]>([
    ['nothing active', [referenceRow({ run: run('awaiting_review') })], null],
    [
      'one running, the first of five',
      [
        referenceRow({ run: going }),
        ...Array.from({ length: 4 }, () => referenceRow({ run: run('queued') })),
      ],
      'Running document 1 of 5 · Step 2 of 6 · lines',
    ],
    [
      'one running after two finished',
      [
        referenceRow({ run: run('awaiting_review') }),
        referenceRow({ run: run('needs_review') }),
        referenceRow({ run: run('running') }),
      ],
      'Running document 3 of 3 · Starting…',
    ],
    [
      'two running at once',
      [
        referenceRow({ run: going }),
        referenceRow({ run: run('running') }),
        referenceRow({ run: run('awaiting_review') }),
        referenceRow({ run: run('queued') }),
      ],
      'Running documents 2 and 3 of 4 · 1 finished',
    ],
    [
      'only waiting',
      [referenceRow({ run: run('queued') }), referenceRow({ run: run('awaiting_review') })],
      'Waiting for a worker · 1 of 2 finished',
    ],
  ])('%s', (_name, rows, text) => {
    expect(runsTitle(rows)).toBe(text);
  });
});
