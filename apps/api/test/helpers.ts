import { MemoryMappingMemoryRepo } from '../src/mapping-memory/repo.js';
import { DocumentSpecSchema, TemplateSchema, type Role } from '@ih/shared';
import type { FastifyInstance } from 'fastify';
import { MemoryAccessRepo, type AccessRepo } from '../src/access/repo.js';
import { MemoryGitHubSyncRepo } from '../src/github-sync/repo.js';
import { MemoryProfileRepo } from '../src/profile/repo.js';
import { buildApp, type AppDeps } from '../src/app.js';
import { MemoryLlmConfigRepo } from '../src/llm/repo.js';
import { MemoryOntologyRepo } from '../src/ontologies/repo.js';
import { MemoryLinkedDataRepo } from '../src/linked-data/repo.js';
import { MemoryMaintenanceRepo } from '../src/maintenance/repo.js';
import { MemoryRepo } from '../src/repositories/memory.js';
import { MemoryS3KeyIssuer } from '../src/s3keys/issuer.js';
import { MemoryS3KeyRepo } from '../src/s3keys/repo.js';
import { S3KeyService } from '../src/s3keys/service.js';
import { SpecRegistry } from '../src/specs/spec-registry.js';
import { MemoryPublishTargetRepo } from '../src/publish-targets/repo.js';
import { TargetStores } from '../src/publish-targets/stores.js';
import { cacheS3 } from './target-views.js';
import { HandoffCodes } from '../src/bridge/handoff.js';
import { SinkCatalog } from '../src/bridge/sinks.js';
import { FakeBridgeApi } from './fake-bridge.js';

/** The key test bridges sign their calls to the API with (BRIDGE_CLIENT_KEY). */
export const TEST_BRIDGE_KEY = 'b'.repeat(32);
import { MemoryObjectStore, type ObjectStore } from '../src/storage/object-store.js';
import type { S3Options } from '../src/storage/s3.js';
import { MemoryTemplateRepo } from '../src/templates/repo.js';
import { MemoryWatchRepo } from '../src/watches/repo.js';
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

/** The internal store options test target stores are built with (`ctx.targetStore`). */
export const TEST_INTERNAL_S3: S3Options = {
  endpoint: 'http://seaweed.test:8333',
  region: 'us-east-1',
  accessKeyId: 'internal',
  secretAccessKey: 'internal-secret',
};

/**
 * The test app. `targetStore` is the store of every internal publishing target (the seeded
 * `default`: bucket `published`, prefix `pub/`); an external target gets the store
 * `endpointStores` holds for its endpoint (one is made on first use). `targetOptions` records
 * every set of options a target store was built with.
 */
export async function testApp(overrides: Partial<AppDeps> & { targetStore?: ObjectStore } = {}) {
  const { targetStore: givenTargetStore, ...deps } = overrides;
  const repo = new MemoryRepo();
  const store = new MemoryObjectStore();
  const targetStore = givenTargetStore ?? new MemoryObjectStore();
  const templates = new MemoryTemplateRepo();
  const githubSync = new MemoryGitHubSyncRepo();
  const workbench = new MemoryWorkbenchRepo(repo, templates, githubSync);
  const llm = new MemoryLlmConfigRepo();
  const ontologies = new MemoryOntologyRepo();
  const mappingMemory = new MemoryMappingMemoryRepo();
  const usedRepo = (deps.repo ?? repo) as MemoryRepo;
  const usedTemplates = (deps.templates ?? templates) as MemoryTemplateRepo;
  const s3KeyRepo = new MemoryS3KeyRepo();
  const watches = new MemoryWatchRepo();
  const usedWatches = (deps.watches ?? watches) as MemoryWatchRepo;
  const targets = new MemoryPublishTargetRepo({
    publishedDefinitions: async () =>
      [...usedTemplates.records.values()]
        .filter((r) => r.status === 'published')
        .map((r) => ({
          id: r.id,
          version: r.version,
          definition: r.definition as { delivery?: { publishTo?: string | string[] } },
        })),
    deliveredCount: async (id) => {
      const outputs = [...usedRepo.outputs.values()]
        .flat()
        .filter((o) => o.stage === 'published' && o.targetId === id).length;
      // Another sink's target records no outputs: its deliveries are what it was handed.
      const delivered = outputs
        ? 0
        : [...usedRepo.deliveries.values()].filter((d) => d.targetId === id).length;
      return outputs + delivered + usedRepo.graphVersions.filter((v) => v.targetId === id).length;
    },
    consumerCount: async (id) => s3KeyRepo.grantCount(id),
    pendingJobCount: async (id) =>
      usedRepo.backgroundJobs.filter(
        (j) =>
          j.task === 'withdraw' &&
          (j.status === 'queued' || j.status === 'running') &&
          withdrawTargets(j.params).includes(id),
      ).length,
    watchCount: async (id) => usedWatches.countForTarget(id),
  });
  // The default as the API's seed leaves it (written to the bridge, then cached).
  await cacheS3(
    targets,
    { id: 'default', label: 'Default', kind: 'internal', bucket: 'published', prefix: 'pub/' },
    { source: 'env', seededAt: new Date().toISOString() },
  );
  const targetStores = new TargetStores({ internal: TEST_INTERNAL_S3, make: () => targetStore });
  const bridge = new FakeBridgeApi();
  bridge.fallback = targetStore;
  const app = await buildApp({
    bridgeAuth: {
      key: TEST_BRIDGE_KEY,
      publicUrl: 'https://ct.example.com/bridge',
      codes: new HandoffCodes(),
    },
    repo,
    store,
    targets,
    targetStores,
    bridge,
    // Fresh on every request in tests: they change the fake bridge's sinks as they go.
    sinks: new SinkCatalog({ ttlMs: 0 }),
    templates,
    workbench,
    specs: SpecRegistry.fromDefinitions([
      { kind: 'spec', id: 'demo', version: 1, spec: demoSpec },
      { kind: 'spec', id: 'demo', version: 2, spec: { ...demoSpec, version: 2, title: 'Demo v2' } },
      { kind: 'template', id: 'tdemo', version: 1, template: demoTemplate },
    ]),
    buckets: { inbox: 'inbox', outputs: 'outputs', runs: 'runs', backups: 'backups' },
    bridgeStagingBucket: 'ingest-bridge',
    maxUploadBytes: 1024 * 1024,
    access: null, // access enforcement is covered by access.test.ts
    profiles: new MemoryProfileRepo(),
    githubSync,
    llm,
    ontologies,
    mappingMemory,
    watches,
    ontologyFetch: { hosts: ['w3id.org'], maxBytes: 104857600 },
    linkedData: new MemoryLinkedDataRepo(),
    maintenance: new MemoryMaintenanceRepo(),
    llmSecrets: null,
    backup: null,
    backupUploads: null,
    s3Keys: new S3KeyService({
      repo: s3KeyRepo,
      issuer: new MemoryS3KeyIssuer(),
      targets: deps.targets ?? targets,
      endpoint: null,
    }),
    ...deps,
  });
  installConformance(app);
  const targetRepo = (deps.targets ?? targets) as MemoryPublishTargetRepo;
  const theBridge = (deps.bridge ?? bridge) as FakeBridgeApi;
  /**
   * Puts every live cached target the fake bridge lacks on it (removed ids stay removed), without
   * counting puts: the cache then reads as a pull from a bridge that holds these targets.
   */
  const mirror = async (): Promise<void> => {
    for (const { id } of await targetRepo.list()) {
      const r = await targetRepo.get(id);
      if (!r || theBridge.targets.has(id) || theBridge.removed.has(id)) continue;
      const { label, sinkId, instanceId, connectionId, destination } = r;
      theBridge.targets.set(id, { label, sinkId, instanceId, connectionId, destination });
    }
  };
  await mirror();
  // A test passing its own `llm` keeps it; the default one is a MemoryLlmConfigRepo.
  const llmRepo = (deps.llm ?? llm) as MemoryLlmConfigRepo;
  const ontologyRepo = (deps.ontologies ?? ontologies) as MemoryOntologyRepo;
  return {
    app,
    repo,
    store,
    targetStore,
    targets: targetRepo,
    targetStores: deps.targetStores ?? targetStores,
    bridge: theBridge,
    /** Puts target rows a test cached through the repo on the fake bridge (routes write their own). */
    mirror,
    templates,
    workbench,
    githubSync: (deps.githubSync ?? githubSync) as MemoryGitHubSyncRepo,
    llm: llmRepo,
    ontologies: ontologyRepo,
    mappingMemory: (deps.mappingMemory ?? mappingMemory) as MemoryMappingMemoryRepo,
    watches: usedWatches,
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
 * the cookie is a full session. Their email is `<name, lower case, dashes>@example.test` unless
 * given.
 */
export async function signInNewUser(
  app: FastifyInstance,
  access: AccessRepo,
  name: string,
  role: Role = 'designer',
  email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@example.test`,
) {
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
export async function accessApp(overrides: Parameters<typeof testApp>[0] = {}) {
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

/** The target ids a withdraw job's params name (objects and graphs). */
function withdrawTargets(params: unknown): string[] {
  const p = params as { objects?: { target?: string }[]; graphs?: { target?: string }[] };
  return [...(p.objects ?? []), ...(p.graphs ?? [])].flatMap((e) => (e.target ? [e.target] : []));
}
