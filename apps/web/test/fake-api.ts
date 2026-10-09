import { vi } from 'vitest';
import type { JobSummary } from '@ih/shared';
import type { Api } from '../src/api/client.js';

export function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
    filename: 'invoice.pdf',
    specId: 'process-validation-protocol',
    specVersion: 1,
    status: 'queued',
    modelOverride: null,
    attempts: 0,
    error: null,
    task: 'process',
    reviewReasons: null,
    reviewer: null,
    reviewNote: null,
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listSpecs: vi.fn(async () => [
      { id: 'process-validation-protocol', version: 1, title: 'Process Validation Protocol' },
    ]),
    listModels: vi.fn(async () => []),
    listJobs: vi.fn(async () => []),
    getJob: vi.fn(),
    retryJob: vi.fn(async () => job()),
    upload: vi.fn(async () => job()),
    outputUrl: (jobId, outputId) => `/api/jobs/${jobId}/outputs/${outputId}`,
    ...overrides,
  };
}
