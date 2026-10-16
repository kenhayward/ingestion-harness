import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  JobSummarySchema,
  isMine,
  RepublishParamsSchema,
  StepProgressSchema,
  TestRunSchema,
  WithdrawParamsSchema,
} from '../src/index.js';

const summary = {
  id: '6f1c2c1e-0000-4000-8000-000000000001',
  documentId: '6f1c2c1e-0000-4000-8000-000000000002',
  filename: 'a.pdf',
  contentType: 'application/pdf',
  specId: 'letter',
  specVersion: 2,
  status: 'succeeded',
  modelOverride: null,
  modelsUsed: [],
  attempts: 1,
  error: null,
  task: 'process',
  test: true,
  referenceId: null,
  projectId: 'letter',
  createdBy: null,
  createdByUser: null,
  reviewReasons: null,
  reviewer: null,
  reviewNote: null,
  reviewedAt: null,
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:01:00.000Z',
};

describe('JobSummary timing and batch (TR2)', () => {
  it('carries the batch and the extraction times', () => {
    const parsed = JobSummarySchema.parse({
      ...summary,
      batchId: '6f1c2c1e-0000-4000-8000-000000000003',
      startedAt: '2026-10-13T10:00:05.000Z',
      finishedAt: '2026-10-13T10:00:36.000Z',
    });
    expect(parsed).toMatchObject({ batchId: expect.any(String), startedAt: expect.any(String) });
  });

  it('allows a job outside any batch and never timed', () => {
    expect(
      JobSummarySchema.safeParse({ ...summary, batchId: null, startedAt: null, finishedAt: null })
        .success,
    ).toBe(true);
  });

  it('requires the fields (every producer sets them)', () => {
    expect(JobSummarySchema.safeParse(summary).success).toBe(false);
  });
});

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/step-progress.json', import.meta.url), 'utf8'),
) as { templateRun: unknown[]; beforeRepeats: object; repeating: object };

describe('step progress (TR3)', () => {
  it.each(fixture.templateRun.map((e, i) => [i, e] as const))(
    "parses the worker's event %i",
    (_i, event) => {
      expect(StepProgressSchema.parse(event)).toEqual(event);
    },
  );

  it('reads an event from before repeating sections as no occurrence', () => {
    expect(StepProgressSchema.parse(fixture.beforeRepeats)).toEqual({
      ...fixture.beforeRepeats,
      occurrence: null,
    });
  });

  it('reads the occurrence of a repeating step', () => {
    expect(StepProgressSchema.parse(fixture.repeating)).toEqual(fixture.repeating);
  });

  it.each([
    ['a zero attempt', { step: 'a', index: 1, of: 1, attempt: 0, chunk: null }],
    ['a missing chunk key', { step: 'a', index: 1, of: 1, attempt: 1 }],
    ['a half chunk', { step: 'a', index: 1, of: 1, attempt: 1, chunk: { n: 1 } }],
  ])('rejects %s', (_name, event) => {
    expect(StepProgressSchema.safeParse(event).success).toBe(false);
  });

  it('a test run is a job summary with its progress', () => {
    const run = {
      ...summary,
      status: 'running',
      batchId: null,
      startedAt: '2026-10-13T10:00:05.000Z',
      finishedAt: null,
      progress: fixture.templateRun[2],
    };
    expect(TestRunSchema.parse(run).progress).toEqual(fixture.templateRun[2]);
    expect(TestRunSchema.safeParse({ ...run, progress: null }).success).toBe(true);
  });
});

describe('withdraw and republish params (ADR 0011 step 7; shared with the worker)', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/withdraw-params.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown[]> & { republish: Record<string, unknown[]> };
  it.each(fixture.valid!.map((v) => [v]))('accepts %j', (params) => {
    expect(WithdrawParamsSchema.parse(params)).toEqual(params);
  });
  it.each(fixture.invalid!.map((v) => [v]))('refuses %j', (params) => {
    expect(WithdrawParamsSchema.safeParse(params).success).toBe(false);
  });
  it('republish names the type', () => {
    for (const v of fixture.republish.valid!) expect(RepublishParamsSchema.parse(v)).toEqual(v);
    for (const v of fixture.republish.invalid!) {
      expect(RepublishParamsSchema.safeParse(v).success).toBe(false);
    }
  });
});

describe('isMine', () => {
  const ken = { name: 'ken', userId: 'u-ken' };
  it.each([
    ['my id', { createdBy: 'ken', createdByUser: 'u-ken' }, true],
    ['my id under an old name (renamed)', { createdBy: 'Kenneth', createdByUser: 'u-ken' }, true],
    ['a namesake: my name, another id', { createdBy: 'ken', createdByUser: 'u-other' }, false],
    ['an older job with my name and no id', { createdBy: 'ken', createdByUser: null }, true],
    ['an older job with another name', { createdBy: 'ops', createdByUser: null }, false],
    ['nobody (no access control)', { createdBy: null, createdByUser: null }, false],
  ] as const)('%s', (_case, job, mine) => {
    expect(isMine(job, ken)).toBe(mine);
  });

  it('a user without an id only matches older jobs by name', () => {
    const local = { name: 'ken', userId: null };
    expect(isMine({ createdBy: 'ken', createdByUser: 'u-ken' }, local)).toBe(false);
    expect(isMine({ createdBy: 'ken', createdByUser: null }, local)).toBe(true);
  });
});
