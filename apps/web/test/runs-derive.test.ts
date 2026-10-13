import { describe, expect, it } from 'vitest';
import type { ModelChoice, TestRun } from '@ih/shared';
import {
  batchSegments,
  batchSubtitle,
  batchTitle,
  formatDuration,
  olderText,
  progressText,
  queueText,
  runAction,
  runBatches,
  runBlockedReason,
  runDetail,
  runDuration,
  runLabel,
  runSamples,
  segmentsText,
  splitBatches,
  type RunBatch,
} from '../src/workbench/runs.js';
import { sampleView, testRunView } from './fake-api.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, s)).toISOString();

describe('runBatches', () => {
  it('groups by batch, newest first, rows by file; runs outside a batch go to others', () => {
    const old1 = testRunView({
      batchId: 'b1',
      status: 'succeeded',
      filename: 'b.pdf',
      createdAt: at(0),
    });
    const old2 = testRunView({
      batchId: 'b1',
      status: 'succeeded',
      filename: 'a.pdf',
      createdAt: at(1),
    });
    const fresh = testRunView({
      batchId: 'b2',
      filename: 'c.pdf',
      createdAt: at(30),
      status: 'running',
    });
    const loose = testRunView({ batchId: null, filename: 'ref.pdf' });
    const { batches, others } = runBatches([old1, fresh, loose, old2]);
    expect(batches.map((b) => b.id)).toEqual(['b2', 'b1']);
    expect(batches[1]!.runs.map((r) => r.filename)).toEqual(['a.pdf', 'b.pdf']);
    expect(batches[1]!.createdAt).toBe(at(0));
    expect(batches.map((b) => b.active)).toEqual([true, false]);
    expect(others).toEqual([loose]);
  });
});

describe('splitBatches', () => {
  const b = (id: string, active = false) => ({ id, active }) as RunBatch;
  it.each([
    [[b('1'), b('2')], ['1', '2'], []],
    [
      [b('1'), b('2'), b('3'), b('4')],
      ['1', '2'],
      ['3', '4'],
    ],
    [[b('1'), b('2'), b('3', true)], ['1', '2', '3'], []],
  ])('%#', (batches, shown, hidden) => {
    const split = splitBatches(batches);
    expect(split.shown.map((x) => x.id)).toEqual(shown);
    expect(split.hidden.map((x) => x.id)).toEqual(hidden);
  });
});

describe('batch header', () => {
  const batch = (runs: TestRun[], extra: Partial<RunBatch> = {}): RunBatch => ({
    id: 'b',
    createdAt: at(0),
    specVersion: 4,
    createdBy: 'ken',
    modelOverride: null,
    runs,
    active: false,
    ...extra,
  });

  it('counts statuses in a fixed order with their tones', () => {
    const segments = batchSegments(
      batch([
        testRunView({ status: 'running' }),
        testRunView({ status: 'succeeded' }),
        testRunView({ status: 'awaiting_review' }),
        testRunView({ status: 'succeeded' }),
        testRunView({ status: 'failed' }),
      ]),
    );
    expect(segments.map((s) => [s.status, s.count, s.tone])).toEqual([
      ['succeeded', 2, 'ok'],
      ['awaiting_review', 1, 'warn'],
      ['running', 1, 'info'],
      ['failed', 1, 'danger'],
    ]);
    expect(segmentsText(segments)).toBe('2 succeeded · 1 awaiting review · 1 running · 1 failed');
  });

  it('titles a batch by time and draft version, "Just now" within a minute', () => {
    const b1 = batch([]);
    expect(batchTitle(b1, Date.parse(at(30)))).toBe('Just now · draft v4');
    expect(batchTitle(b1, Date.parse(at(0)) + 3600_000)).toMatch(/^12 Oct, \d\d:\d\d · draft v4$/);
  });

  it('says how many samples, who started it and which models ran', () => {
    const choices = [{ id: 'fast', label: 'Fast model' }] as ModelChoice[];
    expect(batchSubtitle(batch([testRunView(), testRunView()]), choices)).toBe(
      "2 dev samples · started by ken · recipe's models",
    );
    expect(
      batchSubtitle(batch([testRunView()], { createdBy: null, modelOverride: 'fast' }), choices),
    ).toBe('1 dev sample · Fast model');
    expect(batchSubtitle(batch([testRunView()], { modelOverride: 'gone' }), choices)).toBe(
      '1 dev sample · started by ken · gone',
    );
  });

  it('summarises hidden batches by version', () => {
    expect(olderText([batch([]), batch([], { specVersion: 3 }), batch([])])).toBe(
      'Older batches: 3 more on v3 and v4',
    );
    expect(olderText([batch([], { specVersion: 2 })])).toBe('Older batches: 1 more on v2');
  });
});

describe('run rows', () => {
  it.each([
    [
      { step: 'totals', index: 3, of: 3, attempt: 2, chunk: null },
      'Step 3 of 3 · totals · attempt 2',
    ],
    [
      { step: 'line_items', index: 2, of: 3, attempt: 1, chunk: { n: 2, of: 2 } },
      'Step 2 of 3 · line_items · chunk 2 of 2',
    ],
  ])('progress %#', (p, text) => expect(progressText(p)).toBe(text));

  it.each<[Partial<TestRun>, string, string]>([
    [{ status: 'queued' }, 'Waiting for a worker', 'muted'],
    [
      { status: 'queued', attempts: 1, error: 'timeout' },
      'Retrying after attempt 1: timeout',
      'warn',
    ],
    [{ status: 'running' }, 'Starting…', 'info'],
    [
      { status: 'running', progress: { step: 'totals', index: 3, of: 3, attempt: 1, chunk: null } },
      'Step 3 of 3 · totals',
      'info',
    ],
    [
      { status: 'awaiting_review', reviewReasons: ['Check flagged a', 'b'] },
      'Check flagged a; b',
      'warn',
    ],
    [{ status: 'awaiting_review', reviewReasons: null }, 'Waiting for your review', 'warn'],
    [
      { status: 'failed', error: 'invalid JSON', attempts: 3 },
      'invalid JSON (after 3 attempts)',
      'danger',
    ],
    [{ status: 'failed', error: null, attempts: 1 }, 'Failed', 'danger'],
    [{ status: 'needs_review', error: 'refused' }, 'refused', 'warn'],
    [
      { status: 'succeeded', attempts: 1, reviewedAt: null },
      'Finished · nothing to review',
      'muted',
    ],
    [
      { status: 'succeeded', attempts: 2, reviewedAt: at(9), reviewer: 'ken' },
      'Approved by ken · took 2 attempts',
      'muted',
    ],
    [{ status: 'rejected', reviewNote: 'wrong' }, 'Rejected: wrong', 'muted'],
    [{ status: 'cancelled' }, 'Cancelled', 'muted'],
  ])('detail %j', (fields, text, tone) => {
    expect(runDetail(testRunView(fields))).toEqual({ text, tone });
  });

  it.each([
    [0, '00:00'],
    [31.4, '00:31'],
    [125, '02:05'],
    [1384, '23:04'],
    [3725, '1:02:05'],
    [-3, '00:00'],
  ])('formats %s s as %s', (s, text) => expect(formatDuration(s)).toBe(text));

  it('times finished runs from start to finish and running ones up to now', () => {
    const now = Date.parse(at(50));
    expect(
      runDuration(testRunView({ status: 'succeeded', startedAt: at(0), finishedAt: at(31) }), now),
    ).toBe('00:31');
    expect(runDuration(testRunView({ status: 'running', startedAt: at(6) }), now)).toBe('00:44');
    expect(
      runDuration(testRunView({ status: 'queued', startedAt: at(0), finishedAt: at(9) }), now),
    ).toBe('—');
    expect(runDuration(testRunView({ status: 'succeeded', startedAt: null }), now)).toBe('—');
  });

  it('says what a running re-run or publish is doing, not the extraction step', () => {
    const progress = { step: 'totals', index: 3, of: 3, attempt: 1, chunk: null };
    expect(runDetail(testRunView({ status: 'running', task: 'rerun', progress })).text).toBe(
      'Re-running a step',
    );
    expect(runDetail(testRunView({ status: 'running', task: 'publish', progress })).text).toBe(
      'Finishing the review',
    );
  });

  it("does not count a running re-run or publish from the extraction's start", () => {
    const now = Date.parse(at(500));
    for (const task of ['rerun', 'publish'] as const) {
      expect(runDuration(testRunView({ status: 'running', task, startedAt: at(0) }), now)).toBe(
        '—',
      );
      expect(
        runDuration(
          testRunView({ status: 'running', task, startedAt: at(0), finishedAt: at(31) }),
          now,
        ),
      ).toBe('00:31');
    }
  });

  it.each([
    ['awaiting_review', 'review-now'],
    ['succeeded', 'review'],
    ['failed', 'retry'],
    ['needs_review', 'retry'],
    ['cancelled', 'retry'],
    ['queued', null],
    ['running', null],
    ['rejected', null],
  ] as const)('%s → %s', (status, action) => {
    expect(runAction(testRunView({ status }))).toBe(action);
  });
});

describe('samples and the run button', () => {
  it('offers dev samples only; preparing and failed ones are not selectable, with a reason', () => {
    const choices = runSamples([
      sampleView({ filename: 'a.pdf' }),
      sampleView({ filename: 'h.pdf', role: 'holdout' }),
      sampleView({ filename: 'p.pdf', state: 'preparing' }),
      sampleView({
        filename: 'f.pdf',
        state: 'failed',
        prepareError: { code: 'password', message: 'PDF is password-protected' },
      }),
    ]);
    expect(choices.map((c) => [c.sample.filename, c.selectable, c.reason])).toEqual([
      ['a.pdf', true, null],
      ['p.pdf', false, 'Still preparing'],
      ['f.pdf', false, 'Preparation failed: PDF is password-protected'],
    ]);
  });

  it('labels and blocks the run button', () => {
    expect(runLabel(6)).toBe('Run on 6 dev samples');
    expect(runLabel(1)).toBe('Run on 1 dev sample');
    expect(runBlockedReason(null, 3)).toBe(
      'Every version is published: start the next version on the Recipe tab first',
    );
    expect(runBlockedReason(4, 0)).toBe('Select at least one prepared dev sample');
    expect(runBlockedReason(4, 2)).toBeNull();
  });

  it.each([
    [null, null],
    [{ ahead: 0, running: 0, etaSeconds: 0 }, 'Queue: empty, runs start right away'],
    [{ ahead: 3, running: 1, etaSeconds: null }, 'Queue: 3 jobs ahead'],
    [{ ahead: 1, running: 1, etaSeconds: 40 }, 'Queue: 1 job ahead · under a minute'],
    [{ ahead: 3, running: 1, etaSeconds: 120 }, 'Queue: 3 jobs ahead · about 2 min'],
    [{ ahead: 90, running: 1, etaSeconds: 7200 }, 'Queue: 90 jobs ahead · about 2 h'],
  ])('queue %j', (q, text) => expect(queueText(q)).toBe(text));
});
