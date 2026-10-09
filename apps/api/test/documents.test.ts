import { describe, expect, it } from 'vitest';
import { fakePdf, multipart, testApp } from './helpers.js';

describe('POST /api/documents', () => {
  it('stores the PDF in the inbox bucket and enqueues a job against the latest spec version', async () => {
    const { app, store, repo } = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo' }, { filename: 'inv.pdf', content: fakePdf }),
    });

    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job).toMatchObject({
      status: 'queued',
      specId: 'demo',
      specVersion: 2,
      filename: 'inv.pdf',
    });

    const doc = repo.documents.get(job.documentId)!;
    expect(doc.objectKey).toBe(`demo/v2/${job.documentId}.pdf`);
    expect(await store.get('inbox', doc.objectKey)).toEqual(fakePdf);
  });

  it('honours an explicit spec version', async () => {
    const { app } = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo', specVersion: '1' }, { filename: 'a.pdf', content: fakePdf }),
    });
    expect(res.json().specVersion).toBe(1);
  });

  it('rejects unknown specs', async () => {
    const { app } = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'nope' }, { filename: 'a.pdf', content: fakePdf }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-PDF content', async () => {
    const { app, repo } = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo' }, { filename: 'a.pdf', content: Buffer.from('hello') }),
    });
    expect(res.statusCode).toBe(415);
    expect(repo.jobs.size).toBe(0);
  });

  it('rejects a model override that has not been discovered', async () => {
    const { app } = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo', model: 'x/y' }, { filename: 'a.pdf', content: fakePdf }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a discovered, enabled model override', async () => {
    const { app, repo } = await testApp();
    repo.models = [
      {
        ref: 'anthropic/claude-opus-5-5',
        provider: 'anthropic',
        providerKind: 'anthropic',
        modelId: 'claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        enabled: true,
        discoveredAt: new Date().toISOString(),
      },
    ];
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart(
        { specId: 'demo', model: 'anthropic/claude-opus-5-5' },
        { filename: 'a.pdf', content: fakePdf },
      ),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().modelOverride).toBe('anthropic/claude-opus-5-5');
  });
});
