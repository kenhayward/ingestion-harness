import { vi } from 'vitest';
import type { JobSummary } from '@ih/shared';
import { outputPath, type Api, type TemplateRecordView } from '../src/api/client.js';

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
    cancelJob: vi.fn(async (id: string) => job({ id, status: 'cancelled' })),
    deleteJob: vi.fn(async () => undefined),
    cleanupJobs: vi.fn(async (_days: number, dryRun: boolean) =>
      dryRun ? { count: 0 } : { deleted: 0 },
    ),
    upload: vi.fn(async () => job()),
    outputUrl: (jobId, outputId, opts) => outputPath('/api', jobId, outputId, opts),
    getOutputText: vi.fn(async () => ''),
    listResults: vi.fn(async () => []),
    getResult: vi.fn(async () => {
      throw new Error('getResult not stubbed');
    }),
    getReview: vi.fn(async () => {
      throw new Error('getReview not stubbed');
    }),
    addEdit: vi.fn(async () => ({}) as never),
    approve: vi.fn(async () => job({ status: 'queued' })),
    reject: vi.fn(async () => job({ status: 'rejected' })),
    pageUrl: (jobId, page) => `/api/jobs/${jobId}/pages/${page}`,
    listTemplates: vi.fn(async () => []),
    getStepRuns: vi.fn(async () => []),
    listReferences: vi.fn(async () => []),
    getMetrics: vi.fn(async (templateId: string) => ({
      templateId,
      versions: [],
      steps: [],
      topEdited: [],
    })),
    createReference: vi.fn(async (templateId: string, jobId: string, name: string) => ({
      id: 'ref-1',
      templateId,
      name,
      documentId: 'doc',
      sourceJobId: jobId,
      expected: { fields: {}, tables: {} },
      createdAt: '',
    })),
    deleteReference: vi.fn(async () => undefined),
    runRegression: vi.fn(async () => ({ jobs: [] })),
    getRegression: vi.fn(async () => ({
      items: [],
      summary: { references: 0, completed: 0, averageScore: null },
    })),
    diffVersions: vi.fn(async (_id: string, from: number, to: number) => ({
      from,
      to,
      changes: [],
    })),
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
