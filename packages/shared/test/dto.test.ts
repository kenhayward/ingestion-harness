import { describe, expect, it } from 'vitest';
import {
  ComparisonSchema,
  ModelInfoSchema,
  ReferenceSchema,
  ReviewEditSchema,
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

describe.each([
  ['ReviewEdit', ReviewEditSchema, edit, 'at'],
  ['StepRun', StepRunSchema, step, 'trigger'],
  ['ModelInfo', ModelInfoSchema, model, 'providerKind'],
  ['Reference', ReferenceSchema, reference, 'expected'],
  ['Comparison', ComparisonSchema, comparison, 'score'],
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
