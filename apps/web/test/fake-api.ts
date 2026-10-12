import { vi } from 'vitest';
import type { JobSummary, ProjectView, SampleView } from '@ih/shared';
import {
  outputPath,
  type Api,
  type CleanupRequest,
  type TemplateRecordView,
} from '../src/api/client.js';

export function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
    filename: 'invoice.pdf',
    specId: 'process-validation-protocol',
    specVersion: 1,
    status: 'queued',
    modelOverride: null,
    modelsUsed: [],
    attempts: 0,
    error: null,
    task: 'process',
    test: false,
    referenceId: null,
    projectId: null,
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

/** fakeApi() plus a way to simulate the session ending (a 401 mid-use). */
export type FakeApi = Api & { expireSession(): void };

export function fakeApi(overrides: Partial<Api> = {}): FakeApi {
  const listeners = new Set<() => void>();
  return {
    expireSession: () => listeners.forEach((l) => l()),
    me: vi.fn(async () => ({ role: 'admin' as const, label: 'admin', expiresAt: null })),
    login: vi.fn(async () => ({ role: 'admin' as const, label: 'admin', expiresAt: null })),
    logout: vi.fn(async () => undefined),
    listTokens: vi.fn(async () => []),
    createToken: vi.fn(async () => {
      throw new Error('createToken not stubbed');
    }),
    revokeToken: vi.fn(async () => undefined),
    deleteToken: vi.fn(async () => undefined),
    onUnauthorized: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listSpecs: vi.fn(async () => [
      { id: 'process-validation-protocol', version: 1, title: 'Process Validation Protocol' },
    ]),
    listModels: vi.fn(async () => []),
    listJobs: vi.fn(async () => []),
    getJob: vi.fn(async (id: string) => ({ ...job({ id }), outputs: [] })),
    retryJob: vi.fn(async () => job()),
    cancelJob: vi.fn(async (id: string) => job({ id, status: 'cancelled' })),
    deleteJob: vi.fn(async () => undefined),
    cleanupJobs: vi.fn(async (req: CleanupRequest) =>
      req.dryRun ? { count: 0, cutoff: '' } : { deleted: 0, remaining: 0, cutoff: '' },
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
    documentUrl: (jobId) => `/api/jobs/${jobId}/document`,
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
    listProjects: vi.fn(async () => []),
    createProject: vi.fn(async () => {
      throw new Error('createProject not stubbed');
    }),
    getProject: vi.fn(async () => {
      throw new Error('getProject not stubbed');
    }),
    listSamples: vi.fn(async () => []),
    uploadSample: vi.fn(async () => {
      throw new Error('uploadSample not stubbed');
    }),
    setSampleRole: vi.fn(async () => {
      throw new Error('setSampleRole not stubbed');
    }),
    removeSample: vi.fn(async () => undefined),
    getSampleText: vi.fn(async () => ({ sha256: '', pages: [] })),
    saveBrief: vi.fn(async () => {
      throw new Error('saveBrief not stubbed');
    }),
    runDevTests: vi.fn(async () => ({ jobs: [] })),
    listTestRuns: vi.fn(async () => []),
    ...overrides,
  };
}

export function projectView(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    project: { id: 'letter', name: 'Letter', createdAt: '2026-10-12T00:00:00.000Z' },
    draft: 1,
    published: null,
    brief: null,
    ...overrides,
  };
}

export function sampleView(overrides: Partial<SampleView> = {}): SampleView {
  return {
    id: crypto.randomUUID(),
    projectId: 'letter',
    documentId: crypto.randomUUID(),
    filename: 'sample.pdf',
    sizeBytes: 1000,
    sha256: 'abc',
    role: 'dev',
    addedForVersion: 1,
    createdAt: '2026-10-12T00:00:00.000Z',
    state: 'ready',
    prepareJobId: crypto.randomUUID(),
    error: null,
    triage: { sha256: 'abc', pageCount: 3, ocrPages: [2], chars: 900, ocrModel: 'local/olmocr' },
    ...overrides,
  };
}
