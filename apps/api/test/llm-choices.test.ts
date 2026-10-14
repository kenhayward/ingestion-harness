import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppDeps } from '../src/app.js';
import { MemoryLlmConfigRepo } from '../src/llm/repo.js';
import { MemoryOntologyRepo } from '../src/ontologies/repo.js';
import { accessApp, multipart, testApp } from './helpers.js';

const offered = (ref: string, curated = true) => ({
  ref,
  provider: ref.split('/')[0]!,
  providerKind: 'openai-chat' as const,
  modelId: ref.slice(ref.indexOf('/') + 1),
  displayName: null,
  enabled: true,
  discoveredAt: '',
  curated,
});

/** Two offered models, the choice `main` (the default) and the pipeline settings. */
async function setup() {
  return setupWith({});
}

async function setupWith(overrides: Partial<AppDeps>) {
  const llm = new MemoryLlmConfigRepo();
  llm.seedEnv(
    { name: 'local', kind: 'openai-chat', baseUrl: 'http://host:1234/v1', location: 'local' },
    ['qwen', 'olmocr'],
  );
  llm.seedChoice({ id: 'main', label: 'Default model', ref: 'local/qwen' });
  llm.seedSettings({
    default_choice: 'main',
    drafting_model: 'local/qwen',
    ocr_model: 'local/olmocr',
  });
  const ctx = await testApp({ llm, ...overrides });
  ctx.repo.models = [
    offered('local/qwen'),
    offered('local/olmocr'),
    offered('ryzen/openai/gpt-oss-20b'),
    offered('local/advertised', false),
  ];
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) => ctx.app.inject({ method, url: `/api/llm${url}`, ...(payload ? { payload } : {}) });
  return { ...ctx, llm, call };
}

describe('model choices API', () => {
  it('lists the choices and the pipeline settings', async () => {
    const { call } = await setup();
    const res = await call('GET', '/choices');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      choices: [
        {
          id: 'main',
          label: 'Default model',
          description: '',
          ref: 'local/qwen',
          source: 'env',
          editedAt: null,
          updatedBy: null,
        },
      ],
      settings: {
        defaultChoice: 'main',
        draftingModel: 'local/qwen',
        ocrModel: 'local/olmocr',
        embeddingModel: null,
      },
    });
  });

  it('sets the embedding model only on an endpoint that serves embeddings, and clears it', async () => {
    const { call, llm, repo } = await setup();
    llm.seedEnv({ name: 'claude', kind: 'anthropic', baseUrl: null, location: 'external' }, [
      'sonnet',
    ]);
    repo.models = [...repo.models, offered('claude/sonnet')];
    const refused = await call('PUT', '/settings', { embeddingModel: 'claude/sonnet' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('the embedding model needs an OpenAI-compatible endpoint');
    expect(
      (await call('PUT', '/settings', { embeddingModel: 'local/advertised' })).statusCode,
    ).toBe(409);
    const set = await call('PUT', '/settings', { embeddingModel: 'local/olmocr' });
    expect(set.json().settings.embeddingModel).toBe('local/olmocr');
    const cleared = await call('PUT', '/settings', { embeddingModel: null });
    expect(cleared.json().settings.embeddingModel).toBeNull();
  });

  it('adds a labelled choice, its id made from the label', async () => {
    const { call } = await setup();
    const res = await call('POST', '/choices', {
      label: 'Main Production Model',
      description: 'What production uses',
      ref: 'ryzen/openai/gpt-oss-20b',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: 'main-production-model',
      label: 'Main Production Model',
      description: 'What production uses',
      ref: 'ryzen/openai/gpt-oss-20b',
      source: 'ui',
    });
    expect(res.json().editedAt).not.toBeNull();
    // Same label again: the id gets a suffix, the label is free.
    const again = await call('POST', '/choices', {
      label: 'Main Production Model',
      ref: 'local/qwen',
    });
    expect(again.json().id).toBe('main-production-model-2');
  });

  it.each([
    [{ label: 'Test', ref: 'local/advertised' }, 409, 'model local/advertised is not offered'],
    [{ label: 'Test', ref: 'qwen' }, 400, null],
    [{ label: '', ref: 'local/qwen' }, 400, null],
    [{ label: 'OCR', id: 'ocr', ref: 'local/qwen' }, 400, null],
    [{ label: 'Taken', id: 'main', ref: 'local/qwen' }, 409, 'a model choice main already exists'],
  ])('refuses %o', async (body, status, error) => {
    const { call } = await setup();
    const res = await call('POST', '/choices', body);
    expect(res.statusCode).toBe(status);
    if (error) expect(res.json().error).toContain(error);
  });

  it('renames and repoints a choice, recording who did', async () => {
    const llm = new MemoryLlmConfigRepo();
    llm.seedChoice({ id: 'main', label: 'Default model', ref: 'local/qwen' });
    const { app, repo, adminCookie } = await accessApp({ llm });
    repo.models = [offered('local/qwen'), offered('local/qwen3-32b')];
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/llm/choices/main',
      payload: { label: 'Main Production Model', ref: 'local/qwen3-32b' },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'main',
      label: 'Main Production Model',
      ref: 'local/qwen3-32b',
      updatedBy: 'admin',
    });
    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/llm/choices/nope',
      payload: { label: 'x' },
      headers: { cookie: adminCookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('sets the default choice and the pipeline models', async () => {
    const { call } = await setup();
    await call('POST', '/choices', { label: 'Test', ref: 'ryzen/openai/gpt-oss-20b' });
    const res = await call('PUT', '/settings', {
      defaultChoice: 'test',
      ocrModel: 'local/qwen',
      draftingModel: 'ryzen/openai/gpt-oss-20b',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({
      defaultChoice: 'test',
      ocrModel: 'local/qwen',
      draftingModel: 'ryzen/openai/gpt-oss-20b',
      embeddingModel: null,
    });
    expect((await call('PUT', '/settings', { defaultChoice: 'nope' })).json().error).toBe(
      'no model choice nope',
    );
    expect((await call('PUT', '/settings', { ocrModel: 'local/advertised' })).statusCode).toBe(409);
    expect((await call('PUT', '/settings', {})).statusCode).toBe(400);
  });

  it('refuses to delete the default choice, or one a template or an unfinished job names', async () => {
    const { call, templates, repo } = await setup();
    await call('POST', '/choices', { label: 'Test', ref: 'local/qwen' });
    await call('POST', '/choices', { label: 'Spare', ref: 'local/qwen' });
    const isDefault = await call('DELETE', '/choices/main');
    expect(isDefault.statusCode).toBe(409);
    expect(isDefault.json().error).toBe(
      'Default model is the default choice: make another choice the default first',
    );

    await templates.create(
      'letter',
      2,
      {
        id: 'letter',
        version: 2,
        name: 'Letter',
        pipeline: [
          { type: 'extract', id: 'head', fields: ['x'], sections: ['all'], model: 'test' },
        ],
      },
      'draft',
    );
    const byTemplate = await call('DELETE', '/choices/test');
    expect(byTemplate.statusCode).toBe(409);
    expect(byTemplate.json().error).toBe('Test is used by letter v2 (step head)');

    const job = await repo.createDocumentAndJob(
      {
        id: randomUUID(),
        filename: 'a.pdf',
        sha256: 'x',
        sizeBytes: 1,
        specId: 'demo',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: 'demo/v1/a.pdf',
      },
      'spare',
    );
    const byJob = await call('DELETE', '/choices/spare');
    expect(byJob.statusCode).toBe(409);
    expect(byJob.json().error).toBe('Spare is used by 1 unfinished job');
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'succeeded' });
    expect((await call('DELETE', '/choices/spare')).statusCode).toBe(204);
    expect((await call('DELETE', '/choices/spare')).statusCode).toBe(404);
  });

  it('refuses to withdraw a model a choice or a pipeline setting uses', async () => {
    const { call } = await setup();
    const res = await call('PUT', '/endpoints/local/models', { models: ['qwen'] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('the OCR model uses local/olmocr: point it elsewhere first');
    const off = await call('PATCH', '/endpoints/local', { enabled: false });
    expect(off.json().error).toBe(
      'model choice Default model uses local/qwen: point it elsewhere first',
    );
  });

  it('asks the workers to discover an endpoint now', async () => {
    const { call, llm } = await setup();
    const res = await call('POST', '/endpoints/local/discover');
    expect(res.statusCode).toBe(202);
    expect(llm.discoverRequested('local')).toBe(true);
    expect((await call('POST', '/endpoints/nope/discover')).statusCode).toBe(404);
  });

  it('is for admins only', async () => {
    const { app, userCookie } = await accessApp();
    for (const url of ['/api/llm/choices']) {
      const res = await app.inject({ url, headers: { cookie: userCookie } });
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('changing the embedding model (ADR 0011)', () => {
  it('queues one embed job per ready ontology version, and none when it stays the same', async () => {
    const ontologies = new MemoryOntologyRepo();
    const { call, app } = await setupWith({ ontologies });
    for (const id of ['acme', 'pharma']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ontologies',
        ...multipart(
          { id, label: id },
          { filename: `${id}.ttl`, content: Buffer.from(`# ${id}\n`), contentType: 'text/turtle' },
        ),
      });
      expect(res.statusCode).toBe(202);
    }
    ontologies.markReady('acme', 1); // pharma v1 is still queued: its import embeds it
    await call('PUT', '/settings', { embeddingModel: 'local/olmocr' });
    expect(ontologies.embedJobs).toEqual([{ ontologyId: 'acme', version: 1 }]);
    await call('PUT', '/settings', { embeddingModel: 'local/olmocr' });
    await call('PUT', '/settings', { embeddingModel: null });
    expect(ontologies.embedJobs).toHaveLength(1);
  });
});
