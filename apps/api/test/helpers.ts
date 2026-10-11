import { DocumentSpecSchema, TemplateSchema } from '@ih/shared';
import { buildApp, type AppDeps } from '../src/app.js';
import { MemoryRepo } from '../src/repositories/memory.js';
import { SpecRegistry } from '../src/specs/spec-registry.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import { MemoryTemplateRepo } from '../src/templates/repo.js';

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

/** A document template (review workflow): two fields and one table. */
export const demoTemplate = TemplateSchema.parse({
  id: 'tdemo',
  version: 1,
  name: 'Template demo',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: {
    fields: [
      { id: 'product', type: 'text' },
      { id: 'executed_on', type: 'date' },
    ],
    tables: [
      {
        id: 'results',
        columns: [
          { id: 'batch', type: 'text' },
          { id: 'value', type: 'decimal' },
        ],
      },
    ],
  },
  pipeline: [
    { type: 'extract', id: 'head', fields: ['product', 'executed_on'], sections: ['all'] },
    { type: 'extract', id: 'data', table: 'results', sections: ['all'] },
  ],
});

export async function testApp(overrides: Partial<AppDeps> = {}) {
  const repo = new MemoryRepo();
  const store = new MemoryObjectStore();
  const targetStore = new MemoryObjectStore();
  const templates = new MemoryTemplateRepo();
  const app = await buildApp({
    repo,
    store,
    targetStore,
    target: { bucket: 'published', prefix: 'pub/' },
    templates,
    specs: SpecRegistry.fromDefinitions([
      { kind: 'spec', id: 'demo', version: 1, spec: demoSpec },
      { kind: 'spec', id: 'demo', version: 2, spec: { ...demoSpec, version: 2, title: 'Demo v2' } },
      { kind: 'template', id: 'tdemo', version: 1, template: demoTemplate },
    ]),
    buckets: { inbox: 'inbox', outputs: 'outputs', runs: 'runs' },
    maxUploadBytes: 1024 * 1024,
    ...overrides,
  });
  return { app, repo, store, targetStore, templates };
}

/** An object store whose reads fail like an unreachable S3 endpoint. */
export class UnreachableStore extends MemoryObjectStore {
  override async get(): Promise<Buffer | null> {
    throw new Error('connect ECONNREFUSED');
  }
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
