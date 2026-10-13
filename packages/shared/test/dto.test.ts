import { describe, expect, it } from 'vitest';
import {
  BriefVersionViewSchema,
  ComparisonSchema,
  ExportViewSchema,
  FeedbackItemSchema,
  GateViewSchema,
  PublishGateViewSchema,
  IterationViewSchema,
  ModelInfoSchema,
  isOffered,
  PrepareErrorSchema,
  ProjectSummarySchema,
  ProjectViewSchema,
  ProposalViewSchema,
  PublicationSchema,
  ReferenceDetailSchema,
  ReferenceRowSchema,
  ReferenceSchema,
  ReviewEditSchema,
  SampleViewSchema,
  SegmentationViewSchema,
  StageViewSchema,
  StepRunSchema,
} from '../src/index.js';

const edit = {
  id: 1,
  at: '2026-10-13T09:00:00.000Z',
  field: null,
  table: 'results',
  row: 2,
  column: 'value',
  oldValue: '1.0',
  newValue: '1.5',
  editor: 'Ken',
  reason: null,
};

const step = {
  id: 7,
  stepId: 'head',
  trigger: 'process',
  model: 'local/qwen',
  attempts: 1,
  inputTokens: 1200,
  outputTokens: null,
  status: 'succeeded',
  cached: false,
  error: null,
  startedAt: '2026-10-13T09:00:00.000Z',
  finishedAt: '2026-10-13T09:00:05.000Z',
};

const model = {
  ref: 'local/qwen',
  provider: 'local',
  providerKind: 'openai-chat',
  modelId: 'qwen',
  displayName: null,
  enabled: true,
  discoveredAt: '2026-10-13T09:00:00.000Z',
  curated: true,
};

const reference = {
  id: '00000000-0000-4000-8000-000000000001',
  templateId: 'letter',
  templateVersion: 2,
  name: 'March letter',
  documentId: '00000000-0000-4000-8000-000000000002',
  sourceJobId: null,
  copiedFrom: null,
  verifiedOutputs: { fields: [] },
  supersededAt: null,
  expected: { fields: { sender: 'Ken' }, tables: { lines: [{ qty: 1 }] } },
  createdAt: '2026-10-13T09:00:00.000Z',
};

const comparison = {
  score: 0.5,
  fields: [{ id: 'sender', expected: 'Ken', actual: 'Ken', match: true }],
  tables: [
    {
      id: 'lines',
      expected: 1,
      actual: 1,
      matched: 0,
      missing: [],
      extra: [],
      changed: [{ expected: { qty: 1 }, actual: { qty: 2 }, columns: ['qty'] }],
      cells: 0,
      cellsTotal: 1,
      columns: { qty: { matched: 0, total: 1 } },
    },
  ],
};

const project = {
  id: 'letter',
  name: 'Letter',
  createdAt: '2026-10-13T09:00:00.000Z',
  dataPolicy: 'local',
  dataPolicyChangedAt: null,
  dataPolicyChangedBy: null,
  publishThreshold: 0.9,
  thresholdSetBy: null,
  thresholdSetAt: null,
};

const projectView = {
  project,
  draft: 2,
  published: 1,
  brief: {
    projectId: 'letter',
    version: 1,
    body: {
      purpose: 'Letters',
      outputs: '',
      exampleOutput: '',
      glossary: '',
      variants: '',
      rules: '',
      answers: [],
    },
    createdAt: '2026-10-13T09:00:00.000Z',
  },
};

const sample = {
  id: '00000000-0000-4000-8000-000000000003',
  projectId: 'letter',
  documentId: '00000000-0000-4000-8000-000000000004',
  filename: 'march.pdf',
  sizeBytes: 1024,
  sha256: 'ab'.repeat(32),
  role: 'dev',
  addedForVersion: 1,
  createdAt: '2026-10-13T09:00:00.000Z',
  state: 'ready',
  prepareJobId: '00000000-0000-4000-8000-000000000005',
  error: null,
  prepare: { stage: 'ocr', page: 1, of: 3 },
  prepareError: null,
  triage: { sha256: 'ab'.repeat(32), pageCount: 2, ocrPages: [], chars: 900, ocrModel: null },
  holdoutRuns: 0,
};

const briefVersion = {
  version: 2,
  createdAt: '2026-10-13T09:00:00.000Z',
  changedSections: ['glossary'],
  usedBy: ['outputs'],
};

const exportView = {
  jobId: '00000000-0000-4000-8000-000000000006',
  status: 'succeeded',
  error: null,
  createdAt: '2026-10-13T09:00:00.000Z',
  updatedAt: '2026-10-13T09:00:01.000Z',
  briefVersion: 3,
  devSamples: 6,
  bytes: 3_100_000,
};

const at = '2026-10-13T09:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const iteration = {
  id: id(10),
  projectId: 'letter',
  templateVersion: 2,
  briefVersion: 1,
  set: 'dev',
  model: null,
  groupId: null,
  uncached: false,
  createdAt: at,
  status: 'complete',
  score: 0.5,
  completed: 1,
  total: 1,
  cache: { reused: 1, total: 2 },
  scorecard: {
    score: 0.5,
    completed: 1,
    total: 1,
    fields: [{ id: 'sender', matched: 1, total: 1, accuracy: 1 }],
    columns: [],
  },
  samples: [
    {
      sampleId: id(3),
      filename: 'march.pdf',
      jobId: id(11),
      status: 'succeeded',
      error: null,
      comparison,
    },
  ],
};

const proposal = {
  id: id(12),
  stage: 'outputs',
  status: 'ready',
  error: null,
  briefVersion: 1,
  model: 'local/qwen',
  body: { changes: [{ op: 'removeOutput', id: 'sender', reason: 'unused' }], notes: '' },
  acceptedChanges: null,
  createdAt: at,
  decidedAt: null,
};

const referenceRow = {
  sampleId: id(3),
  filename: 'march.pdf',
  sha256: 'ab'.repeat(32),
  reference: {
    id: id(1),
    name: 'March',
    createdAt: at,
    version: 2,
    carriedFrom: null,
    outdated: [],
    sourceJobId: null,
    verifiedBy: null,
    corrections: null,
    reverified: { from: 1, changed: ['field:due_date'] },
  },
  run: null,
};

const referenceDetail = {
  sampleId: id(3),
  filename: 'march.pdf',
  role: 'holdout',
  reference: {
    id: id(1),
    name: 'March',
    createdAt: at,
    version: 2,
    carriedFrom: 1,
    outdated: [],
    sourceJobId: id(4),
    verifiedBy: 'ken',
    corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }],
    reverified: null,
  },
  run: { jobId: id(4), modelOverride: null, models: ['local/qwen'] },
  values: [
    {
      id: 'total',
      kind: 'field',
      value: '2',
      provenance: 'corrected',
      proposed: '1',
      corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }],
    },
  ],
  corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }],
};

describe.each([
  ['ReviewEdit', ReviewEditSchema, edit, 'at'],
  ['StepRun', StepRunSchema, step, 'trigger'],
  ['ModelInfo', ModelInfoSchema, model, 'providerKind'],
  ['Reference', ReferenceSchema, reference, 'expected'],
  ['Comparison', ComparisonSchema, comparison, 'score'],
  [
    'ProjectSummary',
    ProjectSummarySchema,
    { ...project, draft: 2, published: 1, samples: 3 },
    'samples',
  ],
  ['ProjectView', ProjectViewSchema, projectView, 'brief'],
  ['SampleView', SampleViewSchema, sample, 'state'],
  [
    'PrepareError',
    PrepareErrorSchema,
    { code: 'password', message: 'PDF is password-protected' },
    'code',
  ],
  ['ExportView', ExportViewSchema, exportView, 'status'],
  ['BriefVersionView', BriefVersionViewSchema, briefVersion, 'usedBy'],
  ['IterationView', IterationViewSchema, iteration, 'scorecard'],
  ['ProposalView', ProposalViewSchema, proposal, 'stage'],
  ['ReferenceRow', ReferenceRowSchema, referenceRow, 'reference'],
  ['ReferenceDetail', ReferenceDetailSchema, referenceDetail, 'values'],
  [
    'StageView',
    StageViewSchema,
    { stage: 'survey', state: 'accepted', completedAt: at, skippedAt: null },
    'skippedAt',
  ],
  [
    'SegmentationView',
    SegmentationViewSchema,
    { jobId: id(13), status: 'running', error: null, result: null },
    'status',
  ],
  [
    'FeedbackItem',
    FeedbackItemSchema,
    {
      id: id(14),
      projectId: 'letter',
      target: 'field',
      targetId: 'sender',
      sampleId: null,
      iterationId: null,
      body: 'Use the letterhead name.',
      createdAt: at,
      resolvedBy: null,
    },
    'body',
  ],
  [
    'GateView',
    GateViewSchema,
    { threshold: 0.9, iterationId: null, score: null, passes: false, reason: 'no run' },
    'passes',
  ],
  [
    'PublishGateView',
    PublishGateViewSchema,
    {
      threshold: 0.9,
      iterationId: null,
      score: null,
      passes: false,
      reason: 'no run',
      hints: [{ key: 'sender', accuracy: 0, cause: 'no_step', stage: 'steps' }],
    },
    'hints',
  ],
  [
    'Publication',
    PublicationSchema,
    {
      id: id(15),
      projectId: 'letter',
      version: 2,
      iterationId: id(10),
      score: 0.95,
      threshold: 0.9,
      overrideReason: null,
      publishedBy: 'Ken',
      publishedAt: at,
    },
    'version',
  ],
] as const)('%s schema', (_name, schema, example, required) => {
  it('accepts a full value', () => {
    expect(schema.parse(example)).toEqual(example);
  });

  it(`requires ${required}`, () => {
    const rest: Record<string, unknown> = { ...example };
    delete rest[required];
    expect(schema.safeParse(rest).success).toBe(false);
  });
});

describe('isOffered', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
  ])('enabled %s, curated %s → offered %s', (enabled, curated, offered) => {
    expect(isOffered({ ...model, enabled, curated })).toBe(offered);
  });
});
