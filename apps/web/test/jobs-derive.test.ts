import { describe, expect, it } from 'vitest';
import type { JobStatus, JobSummary, StepRun } from '@ih/shared';
import {
  chipCounts,
  choiceName,
  draftingModelName,
  inChip,
  jobDuration,
  jobNote,
  menuPosition,
  modelDisplayName,
  modelLabel,
  primaryAction,
  progressSteps,
  relativeTime,
  statusLabel,
  statusTone,
} from '../src/jobs/derive.js';
import { job, MODEL_CHOICES } from './fake-api.js';

const run = (o: Partial<StepRun> = {}): StepRun => ({
  id: 1,
  stepId: 'header',
  trigger: 'process',
  model: 'local/m',
  attempts: 1,
  inputTokens: 1,
  outputTokens: 1,
  status: 'succeeded',
  cached: false,
  error: null,
  startedAt: '2026-10-12T10:00:00Z',
  finishedAt: '2026-10-12T10:00:05Z',
  ...o,
});

describe('statusLabel / statusTone / primaryAction', () => {
  it.each<[JobStatus, string, string, string | null]>([
    ['queued', 'Queued', 'neutral', 'cancel'],
    ['running', 'Running', 'info', 'cancel'],
    ['awaiting_review', 'Awaiting review', 'warn', 'review'],
    ['needs_review', 'Needs review', 'alert', 'retry'],
    ['failed', 'Failed', 'danger', 'retry'],
    ['succeeded', 'Succeeded', 'ok', 'view'],
    ['rejected', 'Rejected', 'neutral', null],
    ['cancelled', 'Cancelled', 'neutral', 'retry'],
  ])('%s', (status, label, tone, action) => {
    expect(statusLabel(status)).toBe(label);
    expect(statusTone(status)).toBe(tone);
    expect(primaryAction(job({ status }))).toBe(action);
  });
});

describe('jobNote', () => {
  it.each<[JobSummary, string, string]>([
    [job({ status: 'queued' }), 'Waiting for a worker', 'muted'],
    [job({ status: 'running' }), 'Extracting…', 'muted'],
    [
      job({ status: 'awaiting_review', reviewReasons: ['Total off', 'Row 4'] }),
      'Total off',
      'warn',
    ],
    [job({ status: 'awaiting_review', reviewReasons: null }), 'Waiting for a reviewer', 'warn'],
    [
      job({ status: 'needs_review', error: 'Missing section: Deviations' }),
      'Missing section: Deviations',
      'warn',
    ],
    [job({ status: 'needs_review', error: null }), 'Needs an operator', 'warn'],
    [job({ status: 'failed', error: 'Provider unreachable' }), 'Provider unreachable', 'danger'],
    [job({ status: 'failed', error: null }), 'Failed', 'danger'],
    [job({ status: 'succeeded' }), 'Published', 'muted'],
    [job({ status: 'succeeded', test: true }), 'Test run · not published', 'muted'],
    [job({ status: 'rejected', reviewer: 'khd1' }), 'Rejected by khd1', 'muted'],
    [job({ status: 'rejected', reviewer: null }), 'Rejected', 'muted'],
    [job({ status: 'cancelled' }), 'Cancelled by operator', 'muted'],
  ])('%#: %s', (j, text, tone) => expect(jobNote(j)).toEqual({ text, tone }));
});

describe('chips', () => {
  const jobs = (
    [
      'queued',
      'running',
      'awaiting_review',
      'needs_review',
      'failed',
      'succeeded',
      'rejected',
      'cancelled',
    ] as const
  ).map((status) => job({ status }));

  it('counts each group', () => {
    expect(chipCounts(jobs)).toEqual({ all: 8, attention: 3, active: 2, done: 3 });
    expect(chipCounts([])).toEqual({ all: 0, attention: 0, active: 0, done: 0 });
  });

  it('filters by chip', () => {
    expect(jobs.filter((j) => inChip(j, 'attention')).map((j) => j.status)).toEqual([
      'awaiting_review',
      'needs_review',
      'failed',
    ]);
    expect(jobs.filter((j) => inChip(j, 'all'))).toHaveLength(8);
  });
});

describe('progressSteps', () => {
  const states = (j: JobSummary, runs: StepRun[] | null) =>
    progressSteps(j, runs).map((s) => s.state);

  it.each<[string, JobSummary, StepRun[] | null, string[]]>([
    ['queued', job({ status: 'queued' }), [], ['todo', 'todo', 'todo', 'todo', 'todo']],
    [
      'running, nothing extracted yet',
      job({ status: 'running' }),
      [],
      ['current', 'todo', 'todo', 'todo', 'todo'],
    ],
    [
      'running, extracting',
      job({ status: 'running' }),
      [run()],
      ['done', 'done', 'current', 'todo', 'todo'],
    ],
    [
      'awaiting review',
      job({ status: 'awaiting_review' }),
      [run()],
      ['done', 'done', 'done', 'done', 'wait'],
    ],
    ['succeeded', job({ status: 'succeeded' }), [run()], ['done', 'done', 'done', 'done', 'done']],
    ['rejected', job({ status: 'rejected' }), [run()], ['done', 'done', 'done', 'done', 'fail']],
    [
      'needs_review before any step run',
      job({ status: 'needs_review', error: 'Missing section: Deviations' }),
      [],
      ['todo', 'todo', 'todo', 'todo', 'todo'],
    ],
    [
      'failed before any step run',
      job({ status: 'failed', error: 'OCR provider unreachable' }),
      [],
      ['todo', 'todo', 'todo', 'todo', 'todo'],
    ],
    [
      'failed step',
      job({ status: 'failed' }),
      [run({ status: 'failed' })],
      ['done', 'done', 'fail', 'todo', 'todo'],
    ],
    [
      'needs_review after extraction',
      job({ status: 'needs_review', error: 'schema never satisfied' }),
      [run()],
      ['done', 'done', 'done', 'fail', 'todo'],
    ],
    [
      'cancelled mid-extraction',
      job({ status: 'cancelled' }),
      [run()],
      ['done', 'done', 'fail', 'todo', 'todo'],
    ],
    [
      // No step runs proves nothing about where it stopped (legacy specs record none, config
      // errors stop before any call): claim no stage, the callout carries the message.
      'stopped, runs failed to load',
      job({ status: 'failed', error: 'boom' }),
      null,
      ['todo', 'todo', 'todo', 'todo', 'todo'],
    ],
    [
      'runs not loaded yet',
      job({ status: 'awaiting_review' }),
      null,
      ['done', 'done', 'done', 'done', 'wait'],
    ],
  ])('%s', (_name, j, runs, expected) => expect(states(j, runs)).toEqual(expected));

  it('labels and describes each step', () => {
    const steps = progressSteps(job({ status: 'awaiting_review' }), []);
    expect(steps.map((s) => s.label)).toEqual([
      'Text & OCR',
      'Sections',
      'Extraction',
      'Validation',
      'Review & publish',
    ]);
    expect(steps.map((s) => s.text)).toEqual(['Done', 'Done', 'Done', 'Done', 'Waiting for you']);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  it.each([
    ['2026-10-12T11:59:40Z', 'Just now'],
    ['2026-10-12T11:59:00Z', '1 min ago'],
    ['2026-10-12T11:54:00Z', '6 min ago'],
    ['2026-10-12T11:00:00Z', '1 h ago'],
    ['2026-10-12T09:00:00Z', '3 h ago'],
    ['2026-10-11T09:00:00Z', 'Yesterday'],
    ['2026-10-05T09:00:00Z', '7 days ago'],
    ['2026-10-12T12:00:30Z', 'Just now'], // clock skew: never "in the future"
  ])('%s → %s', (iso, text) => expect(relativeTime(iso, now)).toBe(text));

  it('falls back to the date after 30 days', () => {
    expect(relativeTime('2026-08-01T09:00:00Z', now)).toBe(
      new Date('2026-08-01T09:00:00Z').toLocaleDateString(),
    );
  });
});

describe('modelDisplayName', () => {
  it.each<[string, string]>([
    ['main', 'Main Production Model'],
    ['cloud', 'Cloud model'],
    ['default', 'Main Production Model'],
    ['local/qwen', 'Main Production Model'],
    ['cloud/claude', 'Cloud model'],
    ['local/unknown', 'Model no longer offered'],
    ['gone', 'Model no longer offered'],
    ['draft', 'Drafting model'],
  ])('%s -> %s', (name, text) => expect(modelDisplayName(name, MODEL_CHOICES)).toBe(text));

  it('never shows a ref when there are no choices', () => {
    expect(modelDisplayName('local/qwen', [])).toBe('Model no longer offered');
  });
});

describe('choiceName', () => {
  it.each<[string, string]>([
    ['main', 'Main Production Model'],
    ['default', 'Main Production Model'],
    ['fast', 'fast'],
    ['draft', 'Drafting model'],
    ['local/qwen', 'Main Production Model'],
    ['local/other', 'Model no longer offered'],
  ])('%s -> %s', (name, text) => expect(choiceName(name, MODEL_CHOICES)).toBe(text));
});

describe('draftingModelName', () => {
  it.each<[string | null, string]>([
    ['local/qwen', 'Main Production Model'],
    ['local/other', 'Drafting model'],
    [null, 'Drafting model'],
  ])('%s -> %s', (ref, text) => expect(draftingModelName(ref, MODEL_CHOICES)).toBe(text));
});

describe('modelLabel', () => {
  it.each<[JobSummary, string]>([
    [job({ modelsUsed: ['local/qwen', 'cloud/claude'] }), 'Main Production Model, Cloud model'],
    [job({ modelsUsed: ['local/qwen', 'main'] }), 'Main Production Model'],
    [job({ modelsUsed: ['a/x', 'b/y'] }), 'Model no longer offered'],
    [job({ modelsUsed: [], modelOverride: 'cloud' }), 'Cloud model'],
    [job({ modelsUsed: [], modelOverride: 'a/x' }), 'Model no longer offered'],
    [job({ modelsUsed: [], modelOverride: null }), 'Spec default'],
    [job({ modelsUsed: ['x/unmatched'], modelOverride: 'draft' }), 'Drafting model'],
    [job({ modelsUsed: ['local/qwen'], modelOverride: 'draft' }), 'Main Production Model'],
    [job({ modelsUsed: [], modelOverride: 'draft' }), 'Drafting model'],
  ])('%#', (j, text) => expect(modelLabel(j, MODEL_CHOICES)).toBe(text));
});

describe('menuPosition', () => {
  const viewport = { width: 1440, height: 900 };
  const rect = (left: number, top: number) => ({ left, right: left + 34, top, bottom: top + 34 });
  it.each([
    ['right-aligned under the button', rect(1300, 300), viewport, { left: 1114, top: 338 }],
    [
      'clamped inside the left edge (phones)',
      rect(100, 300),
      { width: 390, height: 844 },
      { left: 8, top: 338 },
    ],
    ['clamped inside the right edge', rect(1420, 300), viewport, { left: 1212, top: 338 }],
    ['flipped above near the bottom', rect(1300, 820), viewport, { left: 1114, bottom: 84 }],
  ])('%s', (_name, button, vp, expected) => expect(menuPosition(button, vp)).toEqual(expected));
});

describe('jobDuration', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const at = (s: number) => new Date(now - 3600_000 + s * 1000).toISOString();
  it.each<[string, Partial<JobSummary>, string | null]>([
    ['finished', { status: 'succeeded', startedAt: at(0), finishedAt: at(94) }, '01:34'],
    [
      'awaiting review',
      { status: 'awaiting_review', startedAt: at(0), finishedAt: at(1384) },
      '23:04',
    ],
    ['over an hour', { status: 'failed', startedAt: at(0), finishedAt: at(3725) }, '1:02:05'],
    ['running counts up to now', { status: 'running', startedAt: at(3540) }, '01:00'],
    ['queued', { status: 'queued', startedAt: null }, null],
    [
      'queued for a retry keeps no time',
      { status: 'queued', startedAt: at(0), finishedAt: at(9) },
      null,
    ],
    ['never timed (older jobs, other tasks)', { status: 'succeeded', startedAt: null }, null],
    // Approving or re-running a step reuses the row: the extraction's time stands.
    [
      'a step re-run keeps the extraction time',
      { status: 'running', task: 'rerun', startedAt: at(0), finishedAt: at(20) },
      '00:20',
    ],
  ])('%s', (_name, o, text) => {
    expect(jobDuration({ ...job(), ...o }, now)).toBe(text);
  });
});
