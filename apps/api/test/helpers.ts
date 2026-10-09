import { DocumentSpecSchema } from '@ih/shared';
import { buildApp } from '../src/app.js';
import { MemoryRepo } from '../src/repositories/memory.js';
import { SpecRegistry } from '../src/specs/spec-registry.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';

export const demoSpec = DocumentSpecSchema.parse({
  id: 'demo',
  version: 1,
  title: 'Demo',
  document: { sections: [{ id: 'header', anchor: '^HEADER' }] },
  extractions: [
    { id: 'head', sections: ['header'], prompt: 'prompts/head.md.j2', schema: { type: 'object' } },
  ],
  outputs: [{ id: 'all', format: 'json', from: '*' }],
});

export async function testApp() {
  const repo = new MemoryRepo();
  const store = new MemoryObjectStore();
  const app = await buildApp({
    repo,
    store,
    specs: SpecRegistry.fromSpecs([demoSpec, { ...demoSpec, version: 2, title: 'Demo v2' }]),
    buckets: { inbox: 'inbox', outputs: 'outputs' },
    maxUploadBytes: 1024 * 1024,
  });
  return { app, repo, store };
}

/** Build a multipart body for app.inject(). Fields are written before the file. */
export function multipart(
  fields: Record<string, string>,
  file?: { filename: string; content: Buffer; contentType?: string },
) {
  const boundary = '----ihtestboundary';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType ?? 'application/pdf'}\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export const fakePdf = Buffer.from('%PDF-1.7\n%fake test pdf\n%%EOF\n');
