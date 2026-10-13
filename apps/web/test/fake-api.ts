import { vi } from 'vitest';
import type {
  FeedbackItem,
  GateView,
  IterationView,
  JobSummary,
  ProjectListItem,
  ProjectListPage,
  ProjectOverview,
  ProjectView,
  ProposalView,
  Publication,
  ReferenceRow,
  SampleView,
  SegmentationView,
} from '@ih/shared';
import { OVERVIEW_STAGES, OVERVIEW_TABS } from '@ih/shared';
import {
  outputPath,
  type Api,
  type CleanupRequest,
  type TemplateRecordView,
} from '../src/api/client.js';

export function referenceRow(overrides: Partial<ReferenceRow> = {}): ReferenceRow {
  return {
    sampleId: crypto.randomUUID(),
    filename: 'a.pdf',
    sha256: 'sha-a',
    reference: null,
    run: null,
    ...overrides,
  };
}

export function iterationView(overrides: Partial<IterationView> = {}): IterationView {
  return {
    id: crypto.randomUUID(),
    projectId: 'letter',
    templateVersion: 2,
    briefVersion: 1,
    set: 'dev',
    model: null,
    groupId: null,
    uncached: false,
    createdAt: '2026-10-12T10:00:00.000Z',
    status: 'complete',
    score: 0.75,
    completed: 2,
    total: 2,
    cache: { reused: 0, total: 0 },
    scorecard: {
      score: 0.75,
      completed: 2,
      total: 2,
      fields: [
        { id: 'sent_on', matched: 1, total: 2, accuracy: 0.5 },
        { id: 'sender', matched: 2, total: 2, accuracy: 1 },
      ],
      columns: [],
    },
    samples: [
      {
        sampleId: 's1',
        filename: 'a.pdf',
        jobId: 'j1',
        status: 'succeeded',
        error: null,
        comparison: {
          score: 0.5,
          fields: [
            { id: 'sent_on', expected: '2026-03-01', actual: '2026-01-03', match: false },
            { id: 'sender', expected: 'Acme', actual: 'Acme', match: true },
          ],
          tables: [],
        },
      },
      {
        sampleId: 's2',
        filename: 'b.pdf',
        jobId: 'j2',
        status: 'succeeded',
        error: null,
        comparison: {
          score: 1,
          fields: [
            { id: 'sent_on', expected: '2026-04-02', actual: '2026-04-02', match: true },
            { id: 'sender', expected: 'Globex', actual: 'Globex', match: true },
          ],
          tables: [],
        },
      },
    ],
    ...overrides,
  };
}

export function feedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: crypto.randomUUID(),
    projectId: 'letter',
    target: 'field',
    targetId: 'sender',
    sampleId: null,
    iterationId: null,
    body: 'Use the letterhead name',
    createdAt: '2026-10-12T10:00:00.000Z',
    resolvedBy: null,
    ...overrides,
  };
}

export function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
    filename: 'invoice.pdf',
    contentType: 'application/pdf',
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
    listS3Keys: vi.fn(async () => ({ bucket: 'ingest-published', endpoint: null, consumers: [] })),
    createS3Key: vi.fn(async () => {
      throw new Error('createS3Key not stubbed');
    }),
    rotateS3Key: vi.fn(async () => {
      throw new Error('rotateS3Key not stubbed');
    }),
    revokeS3Key: vi.fn(async () => undefined),
    deleteS3Consumer: vi.fn(async () => undefined),
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
    archiveUrl: (jobId) => `/api/results/${jobId}/archive`,
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
      templateVersion: null,
      copiedFrom: null,
      verifiedOutputs: null,
      supersededAt: null,
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
    listProjectPage: vi.fn(async () => projectListPage()),
    listPins: vi.fn(async () => []),
    pin: vi.fn(async () => undefined),
    unpin: vi.fn(async () => undefined),
    createProject: vi.fn(async () => {
      throw new Error('createProject not stubbed');
    }),
    setDataPolicy: vi.fn(async () => {
      throw new Error('setDataPolicy not stubbed');
    }),
    startStage: vi.fn(async () => {
      throw new Error('startStage not stubbed');
    }),
    listProposals: vi.fn(async () => []),
    decideProposal: vi.fn(async () => {
      throw new Error('decideProposal not stubbed');
    }),
    skipStage: vi.fn(async () => {
      throw new Error('skipStage not stubbed');
    }),
    listStages: vi.fn(async () => []),
    listReferenceRows: vi.fn(async () => []),
    proposeReferences: vi.fn(async () => {
      throw new Error('proposeReferences not stubbed');
    }),
    startEvaluation: vi.fn(async () => {
      throw new Error('startEvaluation not stubbed');
    }),
    startComparison: vi.fn(async () => {
      throw new Error('startComparison not stubbed');
    }),
    getComparison: vi.fn(async () => {
      throw new Error('getComparison not stubbed');
    }),
    listIterations: vi.fn(async () => []),
    listFeedback: vi.fn(async () => []),
    addFeedback: vi.fn(async () => {
      throw new Error('addFeedback not stubbed');
    }),
    deleteFeedback: vi.fn(async () => {
      throw new Error('deleteFeedback not stubbed');
    }),
    getIteration: vi.fn(async () => {
      throw new Error('getIteration not stubbed');
    }),
    restoreIteration: vi.fn(async () => {
      throw new Error('restoreIteration not stubbed');
    }),
    startHoldoutReferenceRuns: vi.fn(async () => {
      throw new Error('startHoldoutReferenceRuns not stubbed');
    }),
    setPublishThreshold: vi.fn(async () => {
      throw new Error('setPublishThreshold not stubbed');
    }),
    getPublishGate: vi.fn(async () => gateView()),
    getProjectOverview: vi.fn(async () => projectOverview()),
    publish: vi.fn(async () => {
      throw new Error('publish not stubbed');
    }),
    listPublications: vi.fn(async () => []),
    getProject: vi.fn(async () => {
      throw new Error('getProject not stubbed');
    }),
    deleteProject: vi.fn(async () => {
      throw new Error('deleteProject not stubbed');
    }),
    startExport: vi.fn(async () => {
      throw new Error('startExport not stubbed');
    }),
    listExports: vi.fn(async () => []),
    exportBundleUrl: (id, jobId) => `/api/workbench/projects/${id}/exports/${jobId}/bundle`,
    importBundle: vi.fn(async () => {
      throw new Error('importBundle not stubbed');
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
    startSegmentation: vi.fn(async () => {
      throw new Error('startSegmentation not stubbed');
    }),
    getSegmentation: vi.fn(async () => {
      throw new Error('getSegmentation not stubbed');
    }),
    ...overrides,
  };
}

export function projectOverview(overrides: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    project: projectView(),
    stages: OVERVIEW_TABS.map((stage) => ({
      stage,
      state: stage === 'template' ? ('none' as const) : ('pending' as const),
      status: stage === 'template' ? 'Draft v1' : 'Not started',
      metrics: [
        { label: 'Figure', value: '—', at: null },
        { label: 'Other', value: '—', at: null },
      ],
    })),
    next: null,
    gate: gateView(),
    ...overrides,
  };
}

export function gateView(overrides: Partial<GateView> = {}): GateView {
  return {
    threshold: 0.9,
    iterationId: null,
    score: null,
    passes: false,
    reason: 'no complete holdout evaluation of the current draft',
    ...overrides,
  };
}

export function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: crypto.randomUUID(),
    projectId: 'letter',
    version: 1,
    iterationId: null,
    score: 0.95,
    threshold: 0.9,
    overrideReason: null,
    publishedBy: 'admin',
    publishedAt: '2026-10-12T12:00:00.000Z',
    ...overrides,
  };
}

export function projectView(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    project: {
      id: 'letter',
      name: 'Letter',
      createdAt: '2026-10-12T00:00:00.000Z',
      dataPolicy: 'local',
      dataPolicyChangedAt: null,
      dataPolicyChangedBy: null,
      publishThreshold: 0.9,
      thresholdSetBy: null,
      thresholdSetAt: null,
    },
    draft: 1,
    published: null,
    brief: null,
    ...overrides,
  };
}

export function projectListItem(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
  const states = [
    'accepted',
    'accepted',
    'accepted',
    'accepted',
    'accepted',
    'proposed',
    'pending',
    'pending',
    'pending',
    'locked',
  ] as const;
  return {
    ...projectView().project,
    draft: 2,
    published: 1,
    samples: 6,
    stages: OVERVIEW_STAGES.map((stage, i) => ({ stage, state: states[i]! })),
    phase: 'draft',
    done: 5,
    next: { kind: 'decide', stage: 'steps', label: 'Decide on Steps' },
    holdoutScore: null,
    devSamples: 4,
    holdoutSamples: 2,
    lastActivityAt: '2026-10-13T08:00:00.000Z',
    flags: { attention: true, running: false, ready: false },
    ...overrides,
  };
}

export function projectListPage(overrides: Partial<ProjectListPage> = {}): ProjectListPage {
  return {
    items: [projectListItem()],
    total: 1,
    facets: { all: 1, attention: 0, running: 0, ready: 0, progress: 1, published: 0 },
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
    holdoutRuns: 0,
    ...overrides,
  };
}

export function segmentationView(overrides: Partial<SegmentationView> = {}): SegmentationView {
  return { jobId: 'seg-1', status: 'succeeded', error: null, result: null, ...overrides };
}

export function changeProposalView(overrides: Partial<ProposalView> = {}): ProposalView {
  return proposalView({
    stage: 'outputs',
    body: {
      notes: 'Dates are DMY in every sample.',
      changes: [
        {
          op: 'putField',
          field: { id: 'protocol_number', type: 'text', description: 'Protocol id' },
          reason: 'header',
        },
        { op: 'putField', field: { id: 'approved_on', type: 'date' }, reason: 'approval page' },
      ],
    },
    acceptedChanges: null,
    ...overrides,
  });
}

export function proposalView(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id: crypto.randomUUID(),
    stage: 'survey',
    status: 'ready',
    error: null,
    briefVersion: 1,
    acceptedChanges: null,
    model: 'local/qwen',
    body: {
      summary: 'Process validation protocols, blank and executed.',
      structure: [{ name: 'Approvals', description: 'Signatures', howToFind: 'PROTOCOL APPROVAL' }],
      variants: ['Executed copy follows the blank one'],
      candidates: [
        {
          name: 'protocol_number',
          description: 'Protocol id',
          where: 'page header',
          kind: 'field',
        },
      ],
      questions: [
        { question: 'Which copy should be extracted?', why: 'Some PDFs hold two copies' },
      ],
    },
    createdAt: '2026-10-13T00:00:00.000Z',
    decidedAt: null,
    ...overrides,
  };
}
