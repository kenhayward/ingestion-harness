import { vi } from 'vitest';
import type { JobSummary } from '@ih/shared';
import type { Api, TemplateRecordView } from '../src/api/client.js';

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
    test: false,
    referenceId: null,
    reviewReasons: null,
    reviewer: null,
    reviewNote: null,
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function templateView(
  definition: Record<string, unknown>,
  status: 'draft' | 'published' = 'draft',
): TemplateRecordView {
  return {
    record: {
      id: String(definition.id),
      version: Number(definition.version),
      status,
      definition,
      createdAt: '',
      updatedAt: '',
      publishedAt: null,
    },
    issues: [],
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
    getReview: vi.fn(async () => {
      throw new Error('getReview not stubbed');
    }),
    addEdit: vi.fn(async () => ({}) as never),
    approve: vi.fn(async () => job({ status: 'queued' })),
    reject: vi.fn(async () => job({ status: 'rejected' })),
    pageUrl: (jobId, page) => `/api/jobs/${jobId}/pages/${page}`,
    listTemplates: vi.fn(async () => []),
    getStepRuns: vi.fn(async () => []),
    rerunStep: vi.fn(async () => job({ status: 'queued' })),
    createTemplate: vi.fn(async (id: string, name: string) =>
      templateView({ id, version: 1, name }),
    ),
    getTemplate: vi.fn(async () => {
      throw new Error('getTemplate not stubbed');
    }),
    saveTemplate: vi.fn(async (_id: string, _v: number, d: Record<string, unknown>) =>
      templateView(d),
    ),
    publishTemplate: vi.fn(async () => templateView({ id: 'x', version: 1 }, 'published')),
    newDraft: vi.fn(async () => templateView({ id: 'x', version: 2 })),
    deleteDraft: vi.fn(async () => undefined),
    importTemplate: vi.fn(async () => templateView({ id: 'memo', version: 4 })),
    exportUrl: (id, version) => `/api/templates/${id}/versions/${version}/export`,
    testRun: vi.fn(async () => job({ test: true })),
    ...overrides,
  };
}
