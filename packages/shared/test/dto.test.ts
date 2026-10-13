import { describe, expect, it } from 'vitest';
import {
  ComparisonSchema,
  ExportViewSchema,
  ModelInfoSchema,
  ProjectSummarySchema,
  ProjectViewSchema,
  ReferenceSchema,
  ReviewEditSchema,
  SampleViewSchema,
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
  triage: { sha256: 'ab'.repeat(32), pageCount: 2, ocrPages: [], chars: 900, ocrModel: null },
  holdoutRuns: 0,
};

const exportView = {
  jobId: '00000000-0000-4000-8000-000000000006',
  status: 'succeeded',
  error: null,
  createdAt: '2026-10-13T09:00:00.000Z',
  updatedAt: '2026-10-13T09:00:01.000Z',
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
  ['ExportView', ExportViewSchema, exportView, 'status'],
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
