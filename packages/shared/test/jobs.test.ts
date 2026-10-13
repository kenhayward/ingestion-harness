import { describe, expect, it } from 'vitest';
import { JobSummarySchema } from '../src/index.js';

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
