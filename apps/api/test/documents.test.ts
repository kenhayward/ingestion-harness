import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DOCX_MIME } from '../src/uploads.js';
import { docx, para } from './docx-fixtures.js';
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

  it('stores a Word document as .docx with its content type, judged by its bytes', async () => {
    const { app, store, repo } = await testApp();
    const body = docx();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      // Named .pdf on purpose: the bytes decide, not the name.
      ...multipart({ specId: 'demo' }, { filename: 'report.pdf', content: body }),
    });
    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job).toMatchObject({ filename: 'report.pdf', contentType: DOCX_MIME });
    const doc = repo.documents.get(job.documentId)!;
    expect(doc).toMatchObject({
      objectKey: `demo/v2/${job.documentId}.docx`,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    expect(store.objects.get(`inbox/${doc.objectKey}`)).toEqual({ body, contentType: DOCX_MIME });
  });

  it('records PDFs as application/pdf', async () => {
    const { app } = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo' }, { filename: 'a.pdf', content: fakePdf }),
    });
    expect(res.json().contentType).toBe('application/pdf');
  });

  it('refuses a Word document with tracked changes', async () => {
    const { app, repo, store } = await testApp();
    const tracked = docx({ body: para('a') + '<w:p><w:del w:id="1"><w:r/></w:del></w:p>' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo' }, { filename: 'a.docx', content: tracked }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/^the Word document has tracked changes/);
    expect(repo.jobs.size).toBe(0);
    expect(store.objects.size).toBe(0);
  });

  it('rejects non-PDF content', async () => {
    const { app, repo } = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo' }, { filename: 'a.pdf', content: Buffer.from('hello') }),
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'file is not a PDF or Word document (.docx)' });
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
