import { describe, expect, it } from 'vitest';
import { ModelInfoSchema, ReviewEditSchema, StepRunSchema } from '../src/index.js';

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

describe.each([
  ['ReviewEdit', ReviewEditSchema, edit, 'at'],
  ['StepRun', StepRunSchema, step, 'trigger'],
  ['ModelInfo', ModelInfoSchema, model, 'providerKind'],
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
