import { DocumentSpecSchema, TemplateSchema } from '@ih/shared';
import type { FastifyInstance } from 'fastify';
import { MemoryAccessRepo, type AccessRepo } from '../src/access/repo.js';
import { buildApp, type AppDeps } from '../src/app.js';
import { MemoryLlmConfigRepo } from '../src/llm/repo.js';
import { MemoryOntologyRepo } from '../src/ontologies/repo.js';
import { MemoryLinkedDataRepo } from '../src/linked-data/repo.js';
import { MemoryRepo } from '../src/repositories/memory.js';
import { MemoryS3KeyIssuer } from '../src/s3keys/issuer.js';
import { MemoryS3KeyRepo } from '../src/s3keys/repo.js';
import { S3KeyService } from '../src/s3keys/service.js';
import { SpecRegistry } from '../src/specs/spec-registry.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import { MemoryTemplateRepo } from '../src/templates/repo.js';
import { MemoryWorkbenchRepo } from '../src/workbench/repo.js';
import { installConformance } from './openapi-conformance.js';

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

/** A minimal valid `letter` template definition (workbench tests). */
export const letter = (version = 1) => ({
  id: 'letter',
  version,
  name: 'Letter',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: 'sender', type: 'text' }] },
  pipeline: [{ type: 'extract', id: 'head', fields: ['sender'], sections: ['all'] }],
});

export async function testApp(overrides: Partial<AppDeps> = {}) {
  const repo = new MemoryRepo();
  const store = new MemoryObjectStore();
  const targetStore = new MemoryObjectStore();
  const templates = new MemoryTemplateRepo();
  const workbench = new MemoryWorkbenchRepo(repo, templates);
  const llm = new MemoryLlmConfigRepo();
  const ontologies = new MemoryOntologyRepo();
  const app = await buildApp({
    repo,
    store,
    targetStore,
    target: { bucket: 'published', prefix: 'pub/' },
    templates,
    workbench,
    specs: SpecRegistry.fromDefinitions([
      { kind: 'spec', id: 'demo', version: 1, spec: demoSpec },
      { kind: 'spec', id: 'demo', version: 2, spec: { ...demoSpec, version: 2, title: 'Demo v2' } },
      { kind: 'template', id: 'tdemo', version: 1, template: demoTemplate },
    ]),
    buckets: { inbox: 'inbox', outputs: 'outputs', runs: 'runs' },
    maxUploadBytes: 1024 * 1024,
    access: null, // access enforcement is covered by access.test.ts
    llm,
    ontologies,
    ontologyFetch: { hosts: ['w3id.org'], maxBytes: 104857600 },
    linkedData: new MemoryLinkedDataRepo(),
    llmSecrets: null,
    s3Keys: new S3KeyService({
      repo: new MemoryS3KeyRepo(),
      issuer: new MemoryS3KeyIssuer(),
      bucket: 'published',
      endpoint: null,
    }),
    ...overrides,
  });
  installConformance(app);
  // A test passing its own `llm` keeps it; the default one is a MemoryLlmConfigRepo.
  const llmRepo = (overrides.llm ?? llm) as MemoryLlmConfigRepo;
  const ontologyRepo = (overrides.ontologies ?? ontologies) as MemoryOntologyRepo;
  return {
    app,
    repo,
    store,
    targetStore,
    templates,
    workbench,
    llm: llmRepo,
    ontologies: ontologyRepo,
  };
}

/**
 * Model choices as an admin set them up (ADR 0010): `main` (the default) and `fast` on the
 * local endpoint, `cloud` on an external one, all three models offered.
 */
export function seedModelChoices(ctx: { repo: MemoryRepo; llm: MemoryLlmConfigRepo }) {
  ctx.llm.seedEnv(
    { name: 'local', kind: 'openai-chat', baseUrl: 'http://host:1234/v1', location: 'local' },
    ['qwen', 'small'],
  );
  ctx.llm.seedEnv({ name: 'cloud', kind: 'anthropic', baseUrl: null, location: 'external' }, [
    'claude',
  ]);
  ctx.llm.seedChoice({ id: 'main', label: 'Main Production Model', ref: 'local/qwen' });
  ctx.llm.seedChoice({ id: 'fast', label: 'Fast model', ref: 'local/small' });
  ctx.llm.seedChoice({ id: 'cloud', label: 'Cloud model', ref: 'cloud/claude' });
  ctx.llm.seedSettings({ default_choice: 'main', drafting_model: 'local/qwen' });
  ctx.repo.models = ['local/qwen', 'local/small', 'cloud/claude'].map((ref) => ({
    ref,
    provider: ref.slice(0, ref.indexOf('/')),
    providerKind: 'openai-chat' as const,
    modelId: ref.slice(ref.indexOf('/') + 1),
    displayName: null,
    enabled: true,
    discoveredAt: '',
    curated: true,
  }));
}

/** The session cookie a sign-in response set, as a `cookie` header value. */
export const sessionCookie = (res: { headers: Record<string, unknown> }) =>
  `ih_session=${/ih_session=([^;]*)/.exec(String(res.headers['set-cookie']))?.[1] ?? ''}`;

/** Sign in through the route; returns the cookie header (empty session when refused). */
export async function signIn(app: FastifyInstance, login: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login, password },
  });
  return sessionCookie(res);
}

/** The password `signInNewUser` gives every user it makes. */
export const TEST_PASSWORD = 'a long test phrase';

/**
 * Add a user, sign in with their one-time password and change it to TEST_PASSWORD (ADR 0013):
 * the cookie is a full session. Their email is `<name, lower case, dashes>@example.test`.
 */
export async function signInNewUser(
  app: FastifyInstance,
  access: AccessRepo,
  name: string,
  role: 'admin' | 'user' = 'user',
) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@example.test`;
  const created = await access.createUser({ name, email, role }, null);
  if (typeof created === 'string') throw new Error(created);
  const cookie = await signIn(app, email, created.password);
  const changed = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: { cookie },
    payload: { currentPassword: created.password, newPassword: TEST_PASSWORD },
  });
  if (changed.statusCode !== 204) throw new Error(`password change: ${changed.body}`);
  return { cookie, user: created.user, email };
}

/** An app with access control on (so the auth routes exist), signed-in cookies for both roles. */
export async function accessApp(overrides: Partial<AppDeps> = {}) {
  const access = new MemoryAccessRepo();
  const ctx = await testApp({ access, ...overrides });
  const adminPassword = await access.rotateAdminPassword();
  return {
    ...ctx,
    access,
    adminPassword,
    adminCookie: await signIn(ctx.app, 'admin', adminPassword),
    userCookie: (await signInNewUser(ctx.app, access, 'user')).cookie,
  };
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
  file?:
    | { filename: string; content: Buffer; contentType?: string }
    | { filename: string; content: Buffer; contentType?: string }[],
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
  for (const f of file === undefined ? [] : Array.isArray(file) ? file : [file]) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.contentType ?? 'application/pdf'}\r\n\r\n`,
      ),
      f.content,
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

/** Full method + path list from Fastify's route tree (children are printed relative). */
export function registeredRoutes(tree: string): { method: string; path: string }[] {
  const stack: string[] = [];
  return tree.split('\n').flatMap((line) => {
    const m = /^([│ ]*)[├└]── (\S+) \(([^)]+)\)/.exec(line);
    if (!m) return [];
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack.push(m[2]!);
    const path = stack.join('');
    return m[3]!.split(', ').map((method) => ({ method, path }));
  });
}
