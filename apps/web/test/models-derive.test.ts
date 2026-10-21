import type { LlmEndpointView, LlmModelView } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { modelAt, offeredModels, optionText, sourceText } from '../src/models/derive.js';

const model = (modelId: string, over: Partial<LlmModelView> = {}): LlmModelView => ({
  modelId,
  displayName: null,
  curated: true,
  enabled: true,
  maxOutputTokens: null,
  maxConcurrentCalls: null,
  ...over,
});

const endpoint = (over: Partial<LlmEndpointView> = {}): LlmEndpointView => ({
  name: 'local',
  kind: 'openai-chat',
  baseUrl: null,
  location: 'local',
  enabled: true,
  toolCalls: true,
  source: 'env',
  editedAt: null,
  updatedBy: null,
  apiKeyEnv: null,
  keySet: false,
  models: [],
  ...over,
});

const endpoints = [
  endpoint({
    models: [
      model('qwen', { displayName: 'Qwen 3' }),
      model('raw'),
      model('found', { curated: false }),
      model('off', { enabled: false }),
    ],
  }),
  endpoint({ name: 'cloud', location: 'external', models: [model('sonnet')] }),
  endpoint({ name: 'gone', enabled: false, models: [model('x')] }),
];

describe('offeredModels', () => {
  it('lists curated, enabled models of enabled endpoints by ref, named', () => {
    expect(offeredModels(endpoints).map((m) => [m.ref, m.name, m.location])).toEqual([
      ['cloud/sonnet', 'sonnet', 'external'],
      ['local/qwen', 'Qwen 3', 'local'],
      ['local/raw', 'raw', 'local'],
    ]);
  });
});

describe('modelAt and optionText', () => {
  it.each([
    ['local/qwen', 'Qwen 3 · local'],
    ['local/found', 'found · local'], // known but not offered: still named
    ['cloud/sonnet', 'sonnet · cloud'],
    ['local/missing', 'local/missing'],
    ['nowhere/qwen', 'nowhere/qwen'],
  ])('%s → %s', (ref, text) => {
    expect(optionText(ref, endpoints)).toBe(text);
  });

  it('says where the model runs', () => {
    expect(modelAt('cloud/sonnet', endpoints)).toEqual({
      name: 'sonnet',
      endpoint: 'cloud',
      location: 'external',
    });
    expect(modelAt('local/missing', endpoints)).toBeNull();
  });
});

describe('sourceText', () => {
  it.each([
    [{}, 'from .env'],
    [{ editedAt: '2026-10-13T10:00:00.000Z', updatedBy: 'Ken' }, 'edited by Ken'],
    [{ editedAt: '2026-10-13T10:00:00.000Z' }, 'edited here'],
    [{ source: 'ui' as const, updatedBy: 'Ann' }, 'added here by Ann'],
    [{ source: 'ui' as const }, 'added here'],
  ])('%o → %s', (over, text) => {
    expect(sourceText(endpoint(over))).toBe(text);
  });
});
