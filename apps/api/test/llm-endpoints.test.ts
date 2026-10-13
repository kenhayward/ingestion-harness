import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryLlmConfigRepo } from '../src/llm/repo.js';
import { decryptSecret, secretsKeys } from '../src/llm/secrets.js';
import { accessApp, testApp } from './helpers.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../packages/shared/test/fixtures/llm-secret.json', import.meta.url),
    'utf8',
  ),
) as { key: string };
const keys = secretsKeys({ LLM_SECRETS_KEY: fixture.key })!;

/** An env-seeded `local` endpoint (as the worker writes it), the default choice `cheap` -> local/qwen and the OCR model. */
async function setup(withKeys = true) {
  const llm = new MemoryLlmConfigRepo();
  llm.seedEnv(
    {
      name: 'local',
      kind: 'openai-chat',
      baseUrl: 'http://host:1234/v1',
      location: 'local',
      apiKeyEnv: 'LOCAL_LLM_API_KEY',
    },
    ['qwen', 'olmocr'],
  );
  llm.discovered('local', 'llama-3', 'Llama 3');
  llm.seedChoice({ id: 'cheap', label: 'Cheap', ref: 'local/qwen' });
  llm.seedSettings({ default_choice: 'cheap', ocr_model: 'local/olmocr' });
  const ctx = await testApp({ llm, llmSecrets: withKeys ? keys : null });
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) => ctx.app.inject({ method, url: `/api/llm${url}`, ...(payload ? { payload } : {}) });
  return { ...ctx, llm, call };
}

describe('LLM endpoints API', () => {
  it('lists endpoints with their curated models and discovered suggestions, never a key', async () => {
    const { call } = await setup();
    const res = await call('GET', '/endpoints');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        name: 'local',
        kind: 'openai-chat',
        baseUrl: 'http://host:1234/v1',
        location: 'local',
        enabled: true,
        source: 'env',
        editedAt: null,
        updatedBy: null,
        apiKeyEnv: 'LOCAL_LLM_API_KEY',
        keySet: false,
        models: [
          { modelId: 'llama-3', displayName: 'Llama 3', curated: false, enabled: true },
          { modelId: 'olmocr', displayName: null, curated: true, enabled: true },
          { modelId: 'qwen', displayName: null, curated: true, enabled: true },
        ],
      },
    ]);
  });

  it('adds an endpoint with its models and an encrypted key', async () => {
    const { call, llm } = await setup();
    const res = await call('POST', '/endpoints', {
      name: 'gpu2',
      kind: 'openai-chat',
      baseUrl: 'http://192.168.1.140:8000/v1',
      location: 'local',
      apiKey: 'sk-gpu2',
      models: ['llama-4-70b'],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: 'gpu2',
      source: 'ui',
      keySet: true,
      models: [{ modelId: 'llama-4-70b', curated: true }],
    });
    expect(JSON.stringify(res.json())).not.toContain('sk-gpu2');
    const stored = llm.storedKey('gpu2')!;
    expect(stored).toMatch(/^v1:/);
    expect(decryptSecret(stored, keys)).toBe('sk-gpu2');
    const again = await call('POST', '/endpoints', {
      name: 'gpu2',
      kind: 'openai-chat',
      baseUrl: 'http://elsewhere/v1',
      location: 'local',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('an endpoint named gpu2 already exists');
  });

  it.each([
    [{ name: 'GPU 2', kind: 'openai-chat', baseUrl: 'http://x/v1', location: 'local' }],
    [{ name: 'gpu2', kind: 'grpc', baseUrl: 'http://x/v1', location: 'local' }],
    [{ name: 'gpu2', kind: 'openai-chat', baseUrl: null, location: 'local' }],
    [{ name: 'gpu2', kind: 'openai-chat', baseUrl: 'not a url', location: 'local' }],
    [{ name: 'gpu2', kind: 'openai-chat', baseUrl: 'http://x/v1', location: 'nearby' }],
    [{ name: 'gpu2', kind: 'openai-chat', baseUrl: 'http://x/v1', location: 'local', extra: 1 }],
  ])('refuses an invalid endpoint %o', async (body) => {
    const { call } = await setup();
    expect((await call('POST', '/endpoints', body)).statusCode).toBe(400);
  });

  it('lets an Anthropic endpoint go without a base URL', async () => {
    const { call } = await setup();
    const res = await call('POST', '/endpoints', {
      name: 'claude',
      kind: 'anthropic',
      baseUrl: null,
      location: 'external',
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses to store a key without LLM_SECRETS_KEY', async () => {
    const { call } = await setup(false);
    const body = {
      name: 'gpu2',
      kind: 'openai-chat',
      baseUrl: 'http://x/v1',
      location: 'local',
      apiKey: 'sk',
    };
    const res = await call('POST', '/endpoints', body);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('LLM_SECRETS_KEY is not set: the API cannot store keys');
    expect((await call('PATCH', '/endpoints/local', { apiKey: 'sk' })).statusCode).toBe(409);
  });

  it('edits an endpoint, recording that an admin did (so .env no longer changes it)', async () => {
    const { call } = await setup();
    const res = await call('PATCH', '/endpoints/local', {
      baseUrl: 'http://other:1234/v1',
      apiKey: 'sk-new',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ baseUrl: 'http://other:1234/v1', keySet: true });
    expect(res.json().editedAt).not.toBeNull();
    const cleared = await call('PATCH', '/endpoints/local', { apiKey: null });
    expect(cleared.json().keySet).toBe(false);
    expect((await call('PATCH', '/endpoints/nope', { enabled: false })).statusCode).toBe(404);
    expect((await call('PATCH', '/endpoints/local', {})).statusCode).toBe(400);
  });

  it('records who edited it', async () => {
    const llm = new MemoryLlmConfigRepo();
    llm.seedEnv(
      { name: 'gpu2', kind: 'openai-chat', baseUrl: 'http://x/v1', location: 'local' },
      [],
    );
    const { app, adminCookie } = await accessApp({ llm, llmSecrets: keys });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/llm/endpoints/gpu2',
      payload: { location: 'external' },
      headers: { cookie: adminCookie },
    });
    expect(res.json()).toMatchObject({ location: 'external', updatedBy: 'admin' });
  });

  it('refuses to disable an endpoint or drop a model a choice or a pipeline setting uses', async () => {
    const { call } = await setup();
    const off = await call('PATCH', '/endpoints/local', { enabled: false });
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toBe('model choice Cheap uses local/qwen: point it elsewhere first');
    const drop = await call('PUT', '/endpoints/local/models', { models: ['qwen'] });
    expect(drop.statusCode).toBe(409);
    expect(drop.json().error).toBe('the OCR model uses local/olmocr: point it elsewhere first');
  });

  it('sets the curated models exactly, adding new ones and suggestions', async () => {
    const { call } = await setup();
    const res = await call('PUT', '/endpoints/local/models', {
      models: ['qwen', 'olmocr', 'llama-3', 'mistral-small'],
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().models.map((m: { modelId: string; curated: boolean }) => [m.modelId, m.curated]),
    ).toEqual([
      ['llama-3', true],
      ['mistral-small', true],
      ['olmocr', true],
      ['qwen', true],
    ]);
    const fewer = await call('PUT', '/endpoints/local/models', { models: ['qwen', 'olmocr'] });
    expect(
      fewer
        .json()
        .models.filter((m: { curated: boolean }) => m.curated)
        .map((m: { modelId: string }) => m.modelId),
    ).toEqual(['olmocr', 'qwen']);
    expect((await call('PUT', '/endpoints/nope/models', { models: [] })).statusCode).toBe(404);
    expect(
      (await call('PUT', '/endpoints/local/models', { models: ['has space'] })).statusCode,
    ).toBe(400);
  });

  it('deletes an endpoint added in the UI; one from .env can only be disabled', async () => {
    const { call } = await setup();
    await call('POST', '/endpoints', {
      name: 'gpu2',
      kind: 'openai-chat',
      baseUrl: 'http://x/v1',
      location: 'local',
    });
    expect((await call('DELETE', '/endpoints/gpu2')).statusCode).toBe(204);
    expect((await call('DELETE', '/endpoints/gpu2')).statusCode).toBe(404);
    const env = await call('DELETE', '/endpoints/local');
    expect(env.statusCode).toBe(409);
    expect(env.json().error).toBe('local comes from .env: disable it instead');
  });

  it('is for admins only', async () => {
    const { app, userCookie } = await accessApp();
    const res = await app.inject({ url: '/api/llm/endpoints', headers: { cookie: userCookie } });
    expect(res.statusCode).toBe(403);
  });
});
