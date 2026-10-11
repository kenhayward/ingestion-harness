# Results Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Results page that lists published documents and shows each one's delivered outputs, read back from the configured final target (`TARGET_S3_*`).

**Architecture:** The API gets a second `ObjectStore` for the target, built from `TARGET_S3_*` with the worker's fallback to `S3_*`. Every read of a `job_outputs` object picks its store by `stage`. New `GET /api/results` (list, from a new `listPublished` repo method) and `GET /api/results/:jobId` (published outputs + parsed `document.json` + template labels) endpoints feed two new React views (`#/results`, `#/results/<jobId>`) behind the existing `Api` port.

**Tech Stack:** Fastify 5 + Zod 3 (API), React + Vitest + Testing Library (web), Zod schemas in `@ih/shared`, Postgres via `pg`.

**Spec:** `docs/superpowers/specs/2026-10-11-results-page-design.md`

## Global Constraints

- TDD: every behaviour change starts with a failing test, run it and see the expected failure, then implement (CLAUDE.md).
- Unit tests never touch the network, Postgres, S3 or an LLM: use `MemoryRepo`, `MemoryObjectStore`, `fakeApi()`.
- TypeScript: ESM with `.js` import suffixes, Zod at every boundary, no `any` without a comment.
- `TARGET_S3_*` fall back to `S3_*` exactly like `worker/src/ingest_worker/config.py`; empty string = unset; `TARGET_S3_BUCKET` default `ingest-published`; `TARGET_S3_PREFIX` default `''`.
- Published `object_key`s already include the target prefix: never prepend `prefix` again when reading.
- No worker change and no DB migration.
- `npm run check` (or at minimum `npm run lint && npm run format:check && npm run typecheck && npm test`) green before the final commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Reviewed jobs have both a draft and a published `document` output with the same id.** Detail and the download default must read the *published* one from the *target* store. Pinned in Task 3 (download default) and Task 5 (detail ignores the draft).
2. **Corrupt or schema-invalid `document.json` in the target.** Expect `documentError: 'invalid document'` and a 200 with metadata, not a 500. Pinned in Task 5.
3. **"Load more" with the microsecond timestamps Postgres stores.** The cursor is an ISO string truncated to milliseconds, so comparing it against raw `max(created_at)` would repeat rows. The SQL compares at millisecond precision; MemoryRepo behaviour is pinned in Task 4, and PgRepo uses `date_trunc('milliseconds', …)`.
4. **The job's template version can't be resolved** (deleted or unknown) while a document exists. Expect fields and tables to render from the document's own keys (`definition.kind === 'unknown'`). Pinned in Task 5 (API) and Task 9 (UI).
5. **Non-scalar field values** (arrays, objects, null, booleans) in published documents. Expect arrays to show comma-joined, objects as JSON, null as `—`, and booleans as text. Pinned in Task 9.

---

### Task 1: Shared result schemas

**Files:**
- Create: `packages/shared/src/results.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/results.test.ts`

**Interfaces:**
- Produces: `ResultSummarySchema`/`ResultSummary`, `PublishedDocumentSchema`/`PublishedDocument`, `ResultDefinition`, `ResultDetailSchema`/`ResultDetail`, `DocumentError` (`'missing from target' | 'target storage unavailable' | 'invalid document'`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/results.test.ts
import { describe, expect, it } from 'vitest';
import { PublishedDocumentSchema, ResultDetailSchema, ResultSummarySchema } from '../src/index.js';

// Shape written by worker template_pipeline.render_document + publish_template_job.
const publishedDocument = {
  document_id: 'd1',
  job_id: 'j1',
  template: { id: 'tdemo', version: 1, name: 'Template demo' },
  extracted_at: '2026-10-11T10:00:00+00:00',
  page_count: 3,
  models: ['local/qwen'],
  fields: { product: { value: 'Aspirin', raw: 'ASPIRIN', page: 1 }, executed_on: { value: null } },
  tables: { results: [{ batch: 'B1', value: 1.5 }] },
  checks: { batch_check: { rows: [{ value: 'B1', status: 'ok', matched: 'B1', distance: 0, count: 1 }] } },
  issues: [{ step: 'data', target: 'results', row: 1, column: 'value', raw: 'x', message: 'bad' }],
  review_required: true,
  review_reasons: ['issues'],
  review: {
    decision: 'approved',
    reviewer: 'Ken',
    note: null,
    reviewed_at: '2026-10-11T11:00:00+00:00',
    edits: [{ field: 'product', table: null, row: null, column: null, value: 'Aspirin', editor: 'Ken', reason: null, at: '2026-10-11T10:59:00+00:00' }],
  },
  published_at: '2026-10-11T11:00:01+00:00',
};

describe('result schemas', () => {
  it('parses a published template document and keeps unknown keys', () => {
    const doc = PublishedDocumentSchema.parse(publishedDocument);
    expect(doc.fields.product?.value).toBe('Aspirin');
    expect(doc.review?.edits[0]?.field).toBe('product');
    expect((doc as Record<string, unknown>).page_count).toBe(3);
  });

  it('defaults missing collections', () => {
    const doc = PublishedDocumentSchema.parse({ document_id: 'd1' });
    expect(doc).toMatchObject({ fields: {}, tables: {}, checks: {}, issues: [] });
  });

  it('validates summaries and details', () => {
    expect(
      ResultSummarySchema.parse({
        jobId: 'j1', documentId: 'd1', filename: 'a.pdf', specId: 'tdemo', specVersion: 1,
        publishedAt: '2026-10-11T11:00:01.000Z', reviewer: null, reviewedAt: null,
        outputCount: 4, issueCount: null,
      }).outputCount,
    ).toBe(4);
    expect(() =>
      ResultDetailSchema.parse({
        job: {}, target: { bucket: 'b', prefix: '' }, outputs: [], document: null,
        documentError: 'nope', definition: { kind: 'spec' },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project shared packages/shared/test/results.test.ts`
Expected: FAIL, because `PublishedDocumentSchema` is not exported.

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/results.ts
import { z } from 'zod';
import { JobOutputSchema, JobSummarySchema } from './jobs.js';
import { TableDefSchema, ValueDefSchema } from './template.js';

/** One published (non-test) job in GET /api/results, newest publish first. */
export const ResultSummarySchema = z.object({
  jobId: z.string(),
  documentId: z.string(),
  filename: z.string(),
  specId: z.string(),
  specVersion: z.number().int(),
  publishedAt: z.string(),
  /** Null when published without review, or approved without a name (see reviewedAt). */
  reviewer: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  outputCount: z.number().int(),
  /** row_count of the published `issues` output; null when there is none (legacy specs). */
  issueCount: z.number().int().nullable(),
});
export type ResultSummary = z.infer<typeof ResultSummarySchema>;

const Row = z.record(z.string(), z.unknown());

export const PublishedEditSchema = z
  .object({
    field: z.string().nullable().optional(),
    table: z.string().nullable().optional(),
    row: z.number().int().nullable().optional(),
    column: z.string().nullable().optional(),
    value: z.unknown(),
  })
  .passthrough();

/** document.json as published by the worker (template jobs). Unknown keys pass through. */
export const PublishedDocumentSchema = z
  .object({
    document_id: z.string(),
    fields: z.record(z.string(), z.object({ value: z.unknown() }).passthrough()).default({}),
    tables: z.record(z.string(), z.array(Row)).default({}),
    checks: z.record(z.string(), z.object({ rows: z.array(Row) }).passthrough()).default({}),
    issues: z.array(Row).default([]),
    review: z
      .object({
        reviewer: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
        reviewed_at: z.string().nullable().optional(),
        edits: z.array(PublishedEditSchema).default([]),
      })
      .passthrough()
      .optional(),
    published_at: z.string().optional(),
  })
  .passthrough();
export type PublishedDocument = z.infer<typeof PublishedDocumentSchema>;

export const ResultDefinitionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('template'),
    fields: z.array(ValueDefSchema),
    tables: z.array(TableDefSchema),
  }),
  z.object({ kind: z.literal('spec') }),
  /** The job's document type/version could not be resolved. */
  z.object({ kind: z.literal('unknown') }),
]);
export type ResultDefinition = z.infer<typeof ResultDefinitionSchema>;

export const DocumentErrorSchema = z.enum([
  'missing from target',
  'target storage unavailable',
  'invalid document',
]);
export type DocumentError = z.infer<typeof DocumentErrorSchema>;

export const ResultDetailSchema = z.object({
  job: JobSummarySchema,
  target: z.object({ bucket: z.string(), prefix: z.string() }),
  /** Published outputs only. */
  outputs: z.array(JobOutputSchema),
  document: PublishedDocumentSchema.nullable(),
  documentError: DocumentErrorSchema.nullable(),
  definition: ResultDefinitionSchema,
});
export type ResultDetail = z.infer<typeof ResultDetailSchema>;
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './results.js';
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run --project shared packages/shared/test/results.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/results.ts packages/shared/src/index.ts packages/shared/test/results.test.ts
git commit -m "Add shared Results schemas" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: API target configuration

**Files:**
- Modify: `apps/api/src/config.ts`
- Test: `apps/api/test/config.test.ts`

**Interfaces:**
- Produces: `targetConfig(config: Config): TargetConfig` where `TargetConfig = { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string; prefix: string }`.

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe('loadConfig', …)` in `apps/api/test/config.test.ts`, and change the import to `import { loadConfig, targetConfig } from '../src/config.js';`)

```ts
  it('resolves the target like the worker: TARGET_S3_* falling back to S3_*', () => {
    expect(targetConfig(loadConfig(base))).toEqual({
      endpoint: 'http://localhost:8333',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      bucket: 'ingest-published',
      prefix: '',
    });
    expect(
      targetConfig(
        loadConfig({
          ...base,
          TARGET_S3_ENDPOINT: 'https://s3.eu-west-2.amazonaws.com',
          TARGET_S3_REGION: 'eu-west-2',
          TARGET_S3_ACCESS_KEY: 'AK',
          TARGET_S3_SECRET_KEY: 'SK',
          TARGET_S3_BUCKET: 'lake',
          TARGET_S3_PREFIX: 'ingest/',
        }),
      ),
    ).toEqual({
      endpoint: 'https://s3.eu-west-2.amazonaws.com',
      region: 'eu-west-2',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      bucket: 'lake',
      prefix: 'ingest/',
    });
  });

  it('treats empty TARGET_S3_* values (docker-compose defaults) as unset', () => {
    const t = targetConfig(
      loadConfig({
        ...base,
        TARGET_S3_ENDPOINT: '',
        TARGET_S3_REGION: '',
        TARGET_S3_ACCESS_KEY: '',
        TARGET_S3_SECRET_KEY: '',
        TARGET_S3_BUCKET: '',
        TARGET_S3_PREFIX: '',
      }),
    );
    expect(t).toMatchObject({ endpoint: 'http://localhost:8333', accessKeyId: 'k', bucket: 'ingest-published', prefix: '' });
  });

  it('rejects a malformed target endpoint', () => {
    expect(() => loadConfig({ ...base, TARGET_S3_ENDPOINT: 'not a url' })).toThrow(/TARGET_S3_ENDPOINT/);
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run --project api apps/api/test/config.test.ts`
Expected: FAIL, because `targetConfig` is not exported.

- [ ] **Step 3: Implement** in `apps/api/src/config.ts`

Add above `EnvSchema`:

```ts
/** docker-compose passes unset optional variables as ''. */
const blank = (v: unknown) => (v === '' ? undefined : v);
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blank, schema.optional());
```

Add to the `EnvSchema` object (after `S3_BUCKET_RUNS`):

```ts
  // Final target for published outputs (read back by the Results page). Mirrors the worker:
  // any unset value falls back to the S3_* connection above.
  TARGET_S3_ENDPOINT: optional(z.string().url()),
  TARGET_S3_REGION: optional(z.string()),
  TARGET_S3_ACCESS_KEY: optional(z.string()),
  TARGET_S3_SECRET_KEY: optional(z.string()),
  TARGET_S3_BUCKET: z.preprocess(blank, z.string().default('ingest-published')),
  TARGET_S3_PREFIX: z.preprocess(blank, z.string().default('')),
```

Append to the file:

```ts
export interface TargetConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
}

/** The publish target, resolved exactly like worker/src/ingest_worker/config.py. */
export function targetConfig(c: Config): TargetConfig {
  return {
    endpoint: c.TARGET_S3_ENDPOINT ?? c.S3_ENDPOINT,
    region: c.TARGET_S3_REGION ?? c.S3_REGION,
    accessKeyId: c.TARGET_S3_ACCESS_KEY ?? c.S3_ACCESS_KEY,
    secretAccessKey: c.TARGET_S3_SECRET_KEY ?? c.S3_SECRET_KEY,
    bucket: c.TARGET_S3_BUCKET,
    prefix: c.TARGET_S3_PREFIX,
  };
}
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run --project api apps/api/test/config.test.ts`
Expected: PASS. Also run `npm run typecheck`, expected clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config.ts apps/api/test/config.test.ts
git commit -m "API: read TARGET_S3_* config with the worker's fallback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Target store in the API, stage-aware downloads

**Files:**
- Create: `apps/api/src/storage/stage.ts`
- Modify: `apps/api/src/app.ts` (`AppDeps`), `apps/api/src/server.ts`, `apps/api/test/helpers.ts`, `apps/api/src/routes/jobs.ts:31-49`
- Test: `apps/api/test/jobs.test.ts`

**Interfaces:**
- Consumes: `targetConfig` (Task 2).
- Produces: `AppDeps.targetStore: ObjectStore`, `AppDeps.target: { bucket: string; prefix: string }`; `storeFor(deps, stage): ObjectStore`; `testApp(overrides?: Partial<AppDeps>)` returning `{ app, repo, store, targetStore, templates }`; download URL `GET /api/jobs/:id/outputs/:outputId?stage=draft|published&inline=1`.

- [ ] **Step 1: Update the test helper** (needed so the tests compile). In `apps/api/test/helpers.ts` change `testApp`:

```ts
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
```

Add `import type { AppDeps } from '../src/app.js';` to the imports. Note: when `overrides.targetStore` is given, the returned `targetStore` is the default memory store, not the override. Tests that pass an override keep their own reference.

- [ ] **Step 2: Write the failing tests** (add to `describe('jobs API', …)` in `apps/api/test/jobs.test.ts`; add `UnreachableStore` to the helpers import)

```ts
  const reviewedOutputs = [
    { outputId: 'lines', stage: 'draft' as const, format: 'csv' as const, bucket: 'outputs', key: 'demo/v2/lines/x.csv', rowCount: 1 },
    { outputId: 'lines', stage: 'published' as const, format: 'csv' as const, bucket: 'published', key: 'pub/demo/v2/lines/x.csv', rowCount: 1 },
  ];

  it('reads published outputs from the target store and prefers them by default', async () => {
    const { app, repo, store, targetStore, job } = await seedJob();
    repo.outputs.set(job.id, reviewedOutputs);
    await store.put('outputs', 'demo/v2/lines/x.csv', Buffer.from('draft\n'), 'text/csv');
    await targetStore.put('published', 'pub/demo/v2/lines/x.csv', Buffer.from('published\n'), 'text/csv');

    expect((await app.inject(`/api/jobs/${job.id}/outputs/lines`)).body).toBe('published\n');
    expect((await app.inject(`/api/jobs/${job.id}/outputs/lines?stage=published`)).body).toBe('published\n');
    expect((await app.inject(`/api/jobs/${job.id}/outputs/lines?stage=draft`)).body).toBe('draft\n');
    expect((await app.inject(`/api/jobs/${job.id}/outputs/lines?stage=bogus`)).statusCode).toBe(400);
  });

  it('serves inline for previews and attachment by default', async () => {
    const { app, repo, targetStore, job } = await seedJob();
    repo.outputs.set(job.id, reviewedOutputs);
    await targetStore.put('published', 'pub/demo/v2/lines/x.csv', Buffer.from('a\n'), 'text/csv');
    const inline = await app.inject(`/api/jobs/${job.id}/outputs/lines?stage=published&inline=1`);
    expect(inline.headers['content-disposition']).toBe('inline; filename="x.csv"');
    const download = await app.inject(`/api/jobs/${job.id}/outputs/lines`);
    expect(download.headers['content-disposition']).toBe('attachment; filename="x.csv"');
  });

  it('reports a published object missing from the target as 404', async () => {
    const { app, repo, job } = await seedJob();
    repo.outputs.set(job.id, reviewedOutputs);
    const res = await app.inject(`/api/jobs/${job.id}/outputs/lines?stage=published`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'output object missing from target' });
  });

  it('returns 502 when the target cannot be reached', async () => {
    const ctx = await testApp({ targetStore: new UnreachableStore() });
    const job = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/documents',
        ...multipart({ specId: 'demo' }, { filename: 'a.pdf', content: fakePdf }),
      })
    ).json();
    ctx.repo.outputs.set(job.id, reviewedOutputs);
    const res = await ctx.app.inject(`/api/jobs/${job.id}/outputs/lines`);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'target storage unavailable' });
  });
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run --project api apps/api/test/jobs.test.ts`
Expected: FAIL on typecheck or at runtime. `targetStore` is unknown in `AppDeps`, and the default download returns the draft body.

- [ ] **Step 4: Implement**

`apps/api/src/app.ts`, in `AppDeps` after `store`:

```ts
  /** Final publish target (`TARGET_S3_*`); published job outputs are read from here. */
  targetStore: ObjectStore;
  target: { bucket: string; prefix: string };
```

Create `apps/api/src/storage/stage.ts`:

```ts
import type { AppDeps } from '../app.js';
import type { ObjectStore } from './object-store.js';

/** Draft outputs live in the outputs bucket (API store); published ones in the final target. */
export function storeFor(
  deps: Pick<AppDeps, 'store' | 'targetStore'>,
  stage: 'draft' | 'published',
): ObjectStore {
  return stage === 'published' ? deps.targetStore : deps.store;
}
```

`apps/api/src/server.ts`: change the import to `import { loadConfig, targetConfig } from './config.js';`, add `const target = targetConfig(config);` after `const config = loadConfig();`, and add to the `buildApp({...})` object after `store`:

```ts
  targetStore: new S3ObjectStore({
    endpoint: target.endpoint,
    region: target.region,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
  }),
  target: { bucket: target.bucket, prefix: target.prefix },
```

`apps/api/src/routes/jobs.ts`: add `import { storeFor } from '../storage/stage.js';` and replace the whole `'/jobs/:id/outputs/:outputId'` handler with:

```ts
  app.get<{
    Params: { id: string; outputId: string };
    Querystring: { stage?: string; inline?: string };
  }>('/jobs/:id/outputs/:outputId', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    const { stage, inline } = req.query;
    if (stage !== undefined && stage !== 'draft' && stage !== 'published') {
      return reply.code(400).send({ error: 'stage must be draft or published' });
    }
    const job = await app.deps.repo.getJob(req.params.id);
    const matches = (job?.outputs ?? []).filter(
      (o) => o.outputId === req.params.outputId && (stage === undefined || o.stage === stage),
    );
    // A reviewed job has a draft and a published copy: default to what was delivered.
    const output = matches.find((o) => o.stage === 'published') ?? matches[0];
    if (!output) return reply.code(404).send({ error: 'output not found' });

    const where = output.stage === 'published' ? 'target' : 'storage';
    let body: Buffer | null;
    try {
      body = await storeFor(app.deps, output.stage).get(output.bucket, output.key);
    } catch (err) {
      req.log.warn({ err, bucket: output.bucket }, 'output read failed');
      return reply.code(502).send({ error: `${where === 'target' ? 'target ' : ''}storage unavailable` });
    }
    if (!body) return reply.code(404).send({ error: `output object missing from ${where}` });
    const filename = output.key.split('/').pop() ?? `${output.outputId}.${output.format}`;
    return reply
      .header('content-type', output.format === 'csv' ? 'text/csv' : 'application/json')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`)
      .send(body);
  });
```

- [ ] **Step 5: Run them and confirm they pass**

Run: `npx vitest run --project api` (the whole API project, since `testApp` changed)
Expected: PASS, including the existing `downloads an output object` test. Run `npm run typecheck`, expected clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/server.ts apps/api/src/storage/stage.ts apps/api/src/routes/jobs.ts apps/api/test/helpers.ts apps/api/test/jobs.test.ts
git commit -m "API: read published outputs from the target store; stage-aware downloads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `listPublished` repo method and `GET /api/results`

**Files:**
- Modify: `apps/api/src/repositories/types.ts`, `apps/api/src/repositories/memory.ts`, `apps/api/src/repositories/pg.ts`, `apps/api/src/app.ts`, `deploy/scripts/smoke-test.sh`
- Create: `apps/api/src/routes/results.ts`
- Test: `apps/api/test/results.test.ts`

**Interfaces:**
- Consumes: `ResultSummary` (Task 1), `testApp` (Task 3).
- Produces: `IngestionRepo.listPublished(q: ListPublishedQuery): Promise<ResultSummary[]>` with `ListPublishedQuery = { limit: number; templateId?: string; before?: string }`; `MemoryRepo.publishedAt: Map<string, string>` (jobId → ISO publish time, defaults to `job.updatedAt`); `resultRoutes` plugin registered under `/api`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/test/results.test.ts
import type { JobOutput } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { fakePdf, multipart, testApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof testApp>>;

async function upload(ctx: Ctx, specId: string, filename: string) {
  return (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId }, { filename, content: fakePdf }),
    })
  ).json();
}

const out = (outputId: string, stage: 'draft' | 'published', rowCount: number | null = 1): JobOutput => ({
  outputId,
  stage,
  format: outputId === 'document' ? 'json' : 'csv',
  bucket: stage === 'published' ? 'published' : 'outputs',
  key: `${stage === 'published' ? 'pub/' : ''}tdemo/v1/${outputId}/doc.${outputId === 'document' ? 'json' : 'csv'}`,
  rowCount,
});

/** Mark a job published at `at` with the given outputs. */
function publish(ctx: Ctx, jobId: string, at: string, outputs: JobOutput[]) {
  ctx.repo.outputs.set(jobId, outputs);
  ctx.repo.publishedAt.set(jobId, at);
}

describe('GET /api/results', () => {
  it('lists only non-test jobs with published outputs, newest publish first', async () => {
    const ctx = await testApp();
    const older = await upload(ctx, 'tdemo', 'older.pdf');
    const newer = await upload(ctx, 'tdemo', 'newer.pdf');
    const draftOnly = await upload(ctx, 'tdemo', 'draft.pdf');
    const test = await upload(ctx, 'tdemo', 'test.pdf');
    ctx.repo.jobs.set(test.id, { ...ctx.repo.jobs.get(test.id)!, test: true });
    publish(ctx, older.id, '2026-10-01T00:00:00.000Z', [out('document', 'published', null), out('issues', 'published', 2)]);
    publish(ctx, newer.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    ctx.repo.outputs.set(draftOnly.id, [out('document', 'draft', null)]);
    publish(ctx, test.id, '2026-10-03T00:00:00.000Z', [out('document', 'published', null)]);

    const res = await ctx.app.inject('/api/results');
    expect(res.statusCode).toBe(200);
    expect(res.json().map((r: { filename: string }) => r.filename)).toEqual(['newer.pdf', 'older.pdf']);
    expect(res.json()[1]).toMatchObject({
      jobId: older.id,
      specId: 'tdemo',
      specVersion: 1,
      publishedAt: '2026-10-01T00:00:00.000Z',
      reviewer: null,
      reviewedAt: null,
      outputCount: 2,
      issueCount: 2,
    });
    expect(res.json()[0].issueCount).toBeNull();
  });

  it('filters by document type and pages with a before cursor', async () => {
    const ctx = await testApp();
    const a = await upload(ctx, 'tdemo', 'a.pdf');
    const b = await upload(ctx, 'tdemo', 'b.pdf');
    const other = await upload(ctx, 'demo', 'other.pdf');
    publish(ctx, a.id, '2026-10-01T00:00:00.000Z', [out('document', 'published', null)]);
    publish(ctx, b.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    publish(ctx, other.id, '2026-10-03T00:00:00.000Z', [out('all', 'published', null)]);

    const typed = (await ctx.app.inject('/api/results?templateId=tdemo')).json();
    expect(typed.map((r: { filename: string }) => r.filename)).toEqual(['b.pdf', 'a.pdf']);
    const page1 = (await ctx.app.inject('/api/results?limit=1')).json();
    expect(page1.map((r: { filename: string }) => r.filename)).toEqual(['other.pdf']);
    const page2 = (
      await ctx.app.inject(`/api/results?limit=1&before=${encodeURIComponent(page1[0].publishedAt)}`)
    ).json();
    expect(page2.map((r: { filename: string }) => r.filename)).toEqual(['b.pdf']);
  });

  it('validates the query', async () => {
    const { app } = await testApp();
    expect((await app.inject('/api/results?limit=0')).statusCode).toBe(400);
    expect((await app.inject('/api/results?limit=500')).statusCode).toBe(400);
    expect((await app.inject('/api/results?before=yesterday')).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run --project api apps/api/test/results.test.ts`
Expected: FAIL, because `repo.publishedAt` is undefined and `/api/results` returns 404.

- [ ] **Step 3: Implement the repo port and MemoryRepo**

`apps/api/src/repositories/types.ts`: add `ResultSummary` to the `@ih/shared` import, then add:

```ts
export interface ListPublishedQuery {
  limit: number;
  templateId?: string;
  /** ISO timestamp: only results published strictly before it (millisecond precision). */
  before?: string;
}
```

and in `IngestionRepo` after `getJob`:

```ts
  /** Non-test jobs with at least one published output, newest publish first. */
  listPublished(query: ListPublishedQuery): Promise<ResultSummary[]>;
```

`apps/api/src/repositories/memory.ts`: add `ResultSummary` to the `@ih/shared` import and `type ListPublishedQuery` to the `./types.js` import. Add the field after `outputs`:

```ts
  /** jobId -> ISO publish time (job_outputs.created_at in Postgres); defaults to updatedAt. */
  readonly publishedAt = new Map<string, string>();
```

and the method after `getJob`:

```ts
  async listPublished({ limit, templateId, before }: ListPublishedQuery): Promise<ResultSummary[]> {
    return [...this.jobs.values()]
      .filter((j) => !j.test && (!templateId || j.specId === templateId))
      .flatMap((j): ResultSummary[] => {
        const published = (this.outputs.get(j.id) ?? []).filter((o) => o.stage === 'published');
        const at = this.publishedAt.get(j.id) ?? j.updatedAt;
        if (published.length === 0 || (before && at >= before)) return [];
        return [
          {
            jobId: j.id,
            documentId: j.documentId,
            filename: j.filename,
            specId: j.specId,
            specVersion: j.specVersion,
            publishedAt: at,
            reviewer: j.reviewer,
            reviewedAt: j.reviewedAt,
            outputCount: published.length,
            issueCount: published.find((o) => o.outputId === 'issues')?.rowCount ?? null,
          },
        ];
      })
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, limit);
  }
```

- [ ] **Step 4: Implement PgRepo** (`apps/api/src/repositories/pg.ts`; add `ResultSummary` to the `@ih/shared` import and `type ListPublishedQuery` to the `./types.js` import; add after `getJob`)

```ts
  async listPublished({ limit, templateId, before }: ListPublishedQuery): Promise<ResultSummary[]> {
    // Publish time = latest published job_outputs.created_at, compared at millisecond precision
    // because the `before` cursor is an ISO string (ms) taken from a previous page.
    const { rows } = await this.pool.query<{
      id: string;
      document_id: string;
      filename: string;
      spec_id: string;
      spec_version: number;
      reviewer: string | null;
      reviewed_at: Date | null;
      published_at: Date;
      output_count: number;
      issue_count: number | null;
    }>(
      `SELECT j.id, j.document_id, d.filename, d.spec_id, d.spec_version, j.reviewer, j.reviewed_at,
              date_trunc('milliseconds', max(o.created_at)) AS published_at,
              count(*)::int AS output_count,
              max(o.row_count) FILTER (WHERE o.output_id = 'issues') AS issue_count
         FROM jobs j
         JOIN documents d ON d.id = j.document_id
         JOIN job_outputs o ON o.job_id = j.id AND o.stage = 'published'
        WHERE NOT j.test AND ($1::text IS NULL OR d.spec_id = $1)
        GROUP BY j.id, d.id
       HAVING ($2::timestamptz IS NULL OR date_trunc('milliseconds', max(o.created_at)) < $2)
        ORDER BY published_at DESC, j.id
        LIMIT $3`,
      [templateId ?? null, before ?? null, limit],
    );
    return rows.map((r) => ({
      jobId: r.id,
      documentId: r.document_id,
      filename: r.filename,
      specId: r.spec_id,
      specVersion: r.spec_version,
      publishedAt: r.published_at.toISOString(),
      reviewer: r.reviewer,
      reviewedAt: r.reviewed_at?.toISOString() ?? null,
      outputCount: r.output_count,
      issueCount: r.issue_count,
    }));
  }
```

- [ ] **Step 5: Implement the list route**

```ts
// apps/api/src/routes/results.ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const ListQuery = z.object({
  templateId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});

/** Published results: what each document delivered to the final target. */
export const resultRoutes: FastifyPluginAsync = async (app) => {
  app.get('/results', async (req, reply) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) {
      const error = query.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error });
    }
    return app.deps.repo.listPublished(query.data);
  });
};
```

`apps/api/src/app.ts`: add `import { resultRoutes } from './routes/results.js';` and register `await app.register(resultRoutes, { prefix: '/api' });` after `referenceRoutes`.

`deploy/scripts/smoke-test.sh`: append `check /api/results`. This exercises `PgRepo.listPublished`'s SQL against real Postgres in the CI compose smoke test.

- [ ] **Step 6: Run them and confirm they pass**

Run: `npx vitest run --project api` and `npm run typecheck`
Expected: PASS and clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/repositories apps/api/src/routes/results.ts apps/api/src/app.ts apps/api/test/results.test.ts deploy/scripts/smoke-test.sh
git commit -m "API: list published results (GET /api/results)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `GET /api/results/:jobId`

**Files:**
- Modify: `apps/api/src/routes/results.ts`
- Test: `apps/api/test/results.test.ts`

**Interfaces:**
- Consumes: `storeFor` (Task 3), `resolveDefinition` (`apps/api/src/templates/definitions.ts`, returns `Resolved | null`; `Resolved = { ok: true; definition: Definition; draft } | { ok: false; error }`; `Definition = { kind: 'spec', … } | { kind: 'template', template: Template, … }`), `PublishedDocumentSchema`, `ResultDetail` (Task 1).
- Produces: `GET /api/results/:jobId` → `ResultDetail` (200) or `{ error }` (404).

- [ ] **Step 1: Write the failing tests** (append to `apps/api/test/results.test.ts`; add `UnreachableStore` to the helpers import)

```ts
const doc = {
  document_id: 'doc',
  fields: { product: { value: 'Aspirin' }, executed_on: { value: '2026-10-01' } },
  tables: { results: [{ batch: 'B1', value: 1.5 }] },
  checks: {},
  issues: [],
  review: { reviewer: 'Ken', note: 'ok', reviewed_at: '2026-10-02T00:00:00Z', edits: [{ field: 'product', value: 'Aspirin' }] },
  published_at: '2026-10-02T00:00:01Z',
};
const put = (store: { put: Ctx['targetStore']['put'] }, bucket: string, key: string, body: unknown) =>
  store.put(bucket, key, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), 'application/json');

describe('GET /api/results/:jobId', () => {
  it('returns the published document from the target (not the draft), with template labels', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:01.000Z', [
      out('document', 'draft', null),
      out('document', 'published', null),
      out('results', 'published', 1),
    ]);
    await put(ctx.store, 'outputs', 'tdemo/v1/document/doc.json', { ...doc, fields: { product: { value: 'DRAFT' } } });
    // Key is used exactly as recorded (already prefixed): never prefix it again.
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', doc);

    const res = await ctx.app.inject(`/api/results/${job.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.job).toMatchObject({ id: job.id, filename: 'a.pdf' });
    expect(body.job.outputs).toBeUndefined();
    expect(body.target).toEqual({ bucket: 'published', prefix: 'pub/' });
    expect(body.outputs.map((o: JobOutput) => `${o.outputId}:${o.stage}`)).toEqual(['document:published', 'results:published']);
    expect(body.document.fields.product.value).toBe('Aspirin');
    expect(body.documentError).toBeNull();
    expect(body.definition.kind).toBe('template');
    expect(body.definition.fields.map((f: { id: string }) => f.id)).toEqual(['product', 'executed_on']);
    expect(body.definition.tables[0].columns.map((c: { id: string }) => c.id)).toEqual(['batch', 'value']);
  });

  it('reports a document missing from the target without failing', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    const body = (await ctx.app.inject(`/api/results/${job.id}`)).json();
    expect(body).toMatchObject({ document: null, documentError: 'missing from target' });
  });

  it('reports an invalid document without failing', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', '{not json');
    expect((await ctx.app.inject(`/api/results/${job.id}`)).json()).toMatchObject({
      document: null,
      documentError: 'invalid document',
    });
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', { fields: 'nope' });
    expect((await ctx.app.inject(`/api/results/${job.id}`)).json().documentError).toBe('invalid document');
  });

  it('reports an unreachable target without failing', async () => {
    const ctx = await testApp({ targetStore: new UnreachableStore() });
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    const res = await ctx.app.inject(`/api/results/${job.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ document: null, documentError: 'target storage unavailable' });
  });

  it('does not read a document for legacy spec jobs', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'demo', 'a.pdf');
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('all', 'published', null)]);
    expect((await ctx.app.inject(`/api/results/${job.id}`)).json()).toMatchObject({
      document: null,
      documentError: null,
      definition: { kind: 'spec' },
    });
  });

  it('marks the definition unknown when the job’s version cannot be resolved', async () => {
    const ctx = await testApp();
    const job = await upload(ctx, 'tdemo', 'a.pdf');
    ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, specVersion: 99 });
    publish(ctx, job.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    await put(ctx.targetStore, 'published', 'pub/tdemo/v1/document/doc.json', doc);
    const body = (await ctx.app.inject(`/api/results/${job.id}`)).json();
    expect(body.definition).toEqual({ kind: 'unknown' });
    expect(body.document.fields.product.value).toBe('Aspirin');
  });

  it('404s for unknown, unpublished and test jobs', async () => {
    const ctx = await testApp();
    expect((await ctx.app.inject('/api/results/not-a-uuid')).statusCode).toBe(404);
    expect((await ctx.app.inject(`/api/results/${crypto.randomUUID()}`)).statusCode).toBe(404);
    const draft = await upload(ctx, 'tdemo', 'draft.pdf');
    ctx.repo.outputs.set(draft.id, [out('document', 'draft', null)]);
    expect((await ctx.app.inject(`/api/results/${draft.id}`)).statusCode).toBe(404);
    const test = await upload(ctx, 'tdemo', 'test.pdf');
    ctx.repo.jobs.set(test.id, { ...ctx.repo.jobs.get(test.id)!, test: true });
    publish(ctx, test.id, '2026-10-02T00:00:00.000Z', [out('document', 'published', null)]);
    expect((await ctx.app.inject(`/api/results/${test.id}`)).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run --project api apps/api/test/results.test.ts`
Expected: the new tests FAIL with 404 for every detail request.

- [ ] **Step 3: Implement** (in `apps/api/src/routes/results.ts`, add the imports and the route inside `resultRoutes`)

```ts
import {
  JobSummarySchema,
  PublishedDocumentSchema,
  type DocumentError,
  type PublishedDocument,
  type ResultDefinition,
  type ResultDetail,
} from '@ih/shared';
import { storeFor } from '../storage/stage.js';
import { resolveDefinition } from '../templates/definitions.js';

const UUID = z.string().uuid();
```

```ts
  app.get<{ Params: { jobId: string } }>('/results/:jobId', async (req, reply) => {
    if (!UUID.safeParse(req.params.jobId).success) {
      return reply.code(404).send({ error: 'result not found' });
    }
    const found = await app.deps.repo.getJob(req.params.jobId);
    const outputs = found?.outputs.filter((o) => o.stage === 'published') ?? [];
    if (!found || found.test || outputs.length === 0) {
      return reply.code(404).send({ error: 'result not found' });
    }
    // Strip `outputs` (all stages) from the job: the schema drops unknown keys.
    const job = JobSummarySchema.parse(found);

    const resolved = await resolveDefinition(app.deps, job.specId, job.specVersion);
    const definition: ResultDefinition = !resolved?.ok
      ? { kind: 'unknown' }
      : resolved.definition.kind === 'template'
        ? {
            kind: 'template',
            fields: resolved.definition.template.outputs.fields,
            tables: resolved.definition.template.outputs.tables,
          }
        : { kind: 'spec' };

    let document: PublishedDocument | null = null;
    let documentError: DocumentError | null = null;
    const docOutput = outputs.find((o) => o.outputId === 'document' && o.format === 'json');
    if (docOutput && definition.kind !== 'spec') {
      let body: Buffer | null = null;
      try {
        body = await storeFor(app.deps, 'published').get(docOutput.bucket, docOutput.key);
        if (!body) documentError = 'missing from target';
      } catch (err) {
        req.log.warn({ err, bucket: docOutput.bucket }, 'published document read failed');
        documentError = 'target storage unavailable';
      }
      if (body) {
        let json: unknown;
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          json = undefined;
        }
        const parsed = PublishedDocumentSchema.safeParse(json);
        if (parsed.success) document = parsed.data;
        else documentError = 'invalid document';
      }
    }

    const detail: ResultDetail = {
      job,
      target: app.deps.target,
      outputs,
      document,
      documentError,
      definition,
    };
    return detail;
  });
```

Note: `{ fields: 'nope' }` fails because `document_id` is missing and `fields` is not a record. Both cases give `invalid document`.

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run --project api` and `npm run typecheck && npm run lint`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/results.ts apps/api/test/results.test.ts
git commit -m "API: result detail read back from the target (GET /api/results/:jobId)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web `Api` port, routes and navigation

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/src/router.ts`, `apps/web/src/App.tsx`
- Create: `apps/web/src/results/ResultsPage.tsx` (placeholder export replaced in Task 8), `apps/web/src/results/ResultDetail.tsx` (placeholder replaced in Task 9)
- Test: `apps/web/test/router.test.ts`, `apps/web/test/App.test.tsx`

**Interfaces:**
- Consumes: `ResultSummary`, `ResultDetail` (Task 1).
- Produces:
  - `Api.listResults(query?: { templateId?: string; before?: string }): Promise<ResultSummary[]>`
  - `Api.getResult(jobId: string): Promise<ResultDetail>`
  - `Api.getOutputText(jobId: string, outputId: string, stage: 'draft' | 'published'): Promise<string>`
  - `Api.outputUrl(jobId, outputId, opts?: OutputUrlOptions)` where `OutputUrlOptions = { stage?: 'draft' | 'published'; inline?: boolean }`
  - `outputPath(base, jobId, outputId, opts?)` exported from `client.ts`
  - Routes `{ name: 'results' }` and `{ name: 'result'; jobId: string }`
  - Components `ResultsPage({ api })` and `ResultDetailView({ api, jobId })`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/test/router.test.ts
import { describe, expect, it } from 'vitest';
import { outputPath } from '../src/api/client.js';
import { parseHash } from '../src/router.js';

describe('parseHash', () => {
  it.each([
    ['#/results', { name: 'results' }],
    ['#/results/abc-123', { name: 'result', jobId: 'abc-123' }],
    ['#/templates', { name: 'templates' }],
    ['#/review/j1', { name: 'review', jobId: 'j1' }],
    ['', { name: 'jobs' }],
  ])('%s', (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });
});

describe('outputPath', () => {
  it.each([
    [undefined, '/api/jobs/j/outputs/o'],
    [{ stage: 'published' as const }, '/api/jobs/j/outputs/o?stage=published'],
    [{ stage: 'published' as const, inline: true }, '/api/jobs/j/outputs/o?stage=published&inline=1'],
  ])('%o', (opts, url) => {
    expect(outputPath('/api', 'j', 'o', opts)).toBe(url);
  });
});
```

Add to `apps/web/test/App.test.tsx`:

```tsx
  it('links to Results and marks it current on results pages', async () => {
    window.location.hash = '#/results';
    render(<App api={fakeApi()} pollMs={0} />);
    const link = await screen.findByRole('link', { name: 'Results' });
    expect(link).toHaveAttribute('href', '#/results');
    expect(link).toHaveAttribute('aria-current', 'page');
    window.location.hash = '';
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run --project web apps/web/test/router.test.ts apps/web/test/App.test.tsx`
Expected: FAIL, because `outputPath` is not exported, the results routes parse as `jobs`, and there's no Results link.

- [ ] **Step 3: Implement**

`apps/web/src/router.ts`: extend `Route` with `| { name: 'results' } | { name: 'result'; jobId: string }`, and add before the `#/templates` check in `parseHash`:

```ts
  const result = /^#\/results\/([^/]+)$/.exec(hash);
  if (result) return { name: 'result', jobId: decodeURIComponent(result[1]!) };
  if (hash === '#/results') return { name: 'results' };
```

Update the doc comment to list `#/results, #/results/<jobId>`.

`apps/web/src/api/client.ts`: add `ResultDetail, ResultSummary` to the `@ih/shared` type import, then add:

```ts
export interface OutputUrlOptions {
  stage?: 'draft' | 'published';
  /** Serve with content-disposition inline (previews) instead of attachment. */
  inline?: boolean;
}

export function outputPath(
  base: string,
  jobId: string,
  outputId: string,
  opts: OutputUrlOptions = {},
): string {
  const params = new URLSearchParams();
  if (opts.stage) params.set('stage', opts.stage);
  if (opts.inline) params.set('inline', '1');
  const qs = params.toString();
  return `${base}/jobs/${jobId}/outputs/${outputId}${qs ? `?${qs}` : ''}`;
}
```

In the `Api` interface, replace `outputUrl(jobId: string, outputId: string): string;` with:

```ts
  outputUrl(jobId: string, outputId: string, opts?: OutputUrlOptions): string;
  /** Published or draft output body as text (Results previews). Rejects with the API error. */
  getOutputText(jobId: string, outputId: string, stage: 'draft' | 'published'): Promise<string>;
  listResults(query?: { templateId?: string; before?: string }): Promise<ResultSummary[]>;
  getResult(jobId: string): Promise<ResultDetail>;
```

In `createHttpApi`, replace the `outputUrl` line with:

```ts
    outputUrl: (jobId, outputId, opts) => outputPath(base, jobId, outputId, opts),
    getOutputText: async (jobId, outputId, stage) => {
      const res = await fetch(outputPath(base, jobId, outputId, { stage, inline: true }));
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ? String(body.error) : `${res.status} ${res.statusText}`);
      }
      return res.text();
    },
    listResults: (query = {}) => {
      const params = new URLSearchParams();
      if (query.templateId) params.set('templateId', query.templateId);
      if (query.before) params.set('before', query.before);
      const qs = params.toString();
      return fetch(`${base}/results${qs ? `?${qs}` : ''}`).then(json<ResultSummary[]>);
    },
    getResult: (jobId) => fetch(`${base}/results/${jobId}`).then(json<ResultDetail>),
```

`apps/web/test/fake-api.ts`: add `import { outputPath } from '../src/api/client.js';` (merge it with the existing type import), and in `fakeApi` replace the `outputUrl` line with:

```ts
    outputUrl: (jobId, outputId, opts) => outputPath('/api', jobId, outputId, opts),
    getOutputText: vi.fn(async () => ''),
    listResults: vi.fn(async () => []),
    getResult: vi.fn(async () => {
      throw new Error('getResult not stubbed');
    }),
```

Create placeholders so `App.tsx` compiles (Tasks 8 and 9 replace them):

```tsx
// apps/web/src/results/ResultsPage.tsx
import type { Api } from '../api/client.js';

export function ResultsPage(_props: { api: Api }) {
  return <h2>Results</h2>;
}
```

```tsx
// apps/web/src/results/ResultDetail.tsx
import type { Api } from '../api/client.js';

export function ResultDetailView(_props: { api: Api; jobId: string }) {
  return <h2>Result</h2>;
}
```

`apps/web/src/App.tsx`: import both components, and add page branches before the final `else`:

```tsx
  } else if (route.name === 'results') {
    page = <ResultsPage api={api} />;
  } else if (route.name === 'result') {
    page = <ResultDetailView key={route.jobId} api={api} jobId={route.jobId} />;
```

Insert the nav link between Jobs and Document types:

```tsx
        <a
          href="#/results"
          aria-current={route.name === 'results' || route.name === 'result' ? 'page' : undefined}
        >
          Results
        </a>
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run --project web` and `npm run typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/src/router.ts apps/web/src/App.tsx apps/web/src/results apps/web/test/router.test.ts apps/web/test/App.test.tsx
git commit -m "Web: Results routes, nav link and API port methods" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: CSV parser for previews

**Files:**
- Create: `apps/web/src/results/csv.ts`
- Test: `apps/web/test/csv.test.ts`

**Interfaces:**
- Produces: `parseCsv(text: string): string[][]`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/csv.test.ts
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/results/csv.js';

describe('parseCsv', () => {
  it.each([
    ['', []],
    ['a,b\n1,2\n', [['a', 'b'], ['1', '2']]],
    ['a,b\r\n1,2', [['a', 'b'], ['1', '2']]],
    ['a,\n', [['a', '']]],
    ['"x,y",z\n', [['x,y', 'z']]],
    ['"say ""hi""",1\n', [['say "hi"', '1']]],
    ['"line 1\nline 2",x\n', [['line 1\nline 2', 'x']]],
    [',,\n', [['', '', '']]],
  ])('%j', (text, rows) => {
    expect(parseCsv(text)).toEqual(rows);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project web apps/web/test/csv.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/results/csv.ts
/** RFC 4180 CSV: commas, LF or CRLF rows, quoted fields with "" escapes and embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run --project web apps/web/test/csv.test.ts`
Expected: PASS (8 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/results/csv.ts apps/web/test/csv.test.ts
git commit -m "Web: CSV parser for result previews" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Results list page

**Files:**
- Modify: `apps/web/src/results/ResultsPage.tsx` (replace the placeholder)
- Test: `apps/web/test/ResultsPage.test.tsx`

**Interfaces:**
- Consumes: `Api.listResults`, `Api.listSpecs` (returns `{ id, version, title }[]`, one per version), `ResultSummary`.
- Produces: `ResultsPage({ api }: { api: Api })`; `RESULTS_PAGE_SIZE = 50` (must equal the API default limit).

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/test/ResultsPage.test.tsx
import type { ResultSummary } from '@ih/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ResultsPage } from '../src/results/ResultsPage.js';
import { fakeApi } from './fake-api.js';

const result = (o: Partial<ResultSummary> = {}): ResultSummary => ({
  jobId: crypto.randomUUID(),
  documentId: 'd',
  filename: 'a.pdf',
  specId: 'pvp',
  specVersion: 3,
  publishedAt: '2026-10-02T09:00:00.000Z',
  reviewer: null,
  reviewedAt: null,
  outputCount: 5,
  issueCount: 2,
  ...o,
});

describe('ResultsPage', () => {
  it('lists published documents with links to their results', async () => {
    const r = result({ filename: 'protocol.pdf', reviewer: 'Ken', reviewedAt: '2026-10-02T08:00:00Z' });
    const auto = result({ filename: 'auto.pdf', issueCount: null });
    const unnamed = result({ filename: 'unnamed.pdf', reviewedAt: '2026-10-02T08:00:00Z' });
    render(<ResultsPage api={fakeApi({ listResults: vi.fn(async () => [r, auto, unnamed]) })} />);

    const link = await screen.findByRole('link', { name: 'protocol.pdf' });
    expect(link).toHaveAttribute('href', `#/results/${r.jobId}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText('pvp v3')).toBeInTheDocument();
    expect(within(row).getByText('Ken')).toBeInTheDocument();
    const autoRow = screen.getByRole('link', { name: 'auto.pdf' }).closest('tr')!;
    expect(within(autoRow).getByText('auto')).toBeInTheDocument();
    expect(within(autoRow).getByText('—')).toBeInTheDocument();
    const unnamedRow = screen.getByRole('link', { name: 'unnamed.pdf' }).closest('tr')!;
    expect(within(unnamedRow).getByText('unnamed reviewer')).toBeInTheDocument();
  });

  it('filters by document type', async () => {
    const listResults = vi.fn(async () => [result()]);
    const api = fakeApi({
      listResults,
      listSpecs: vi.fn(async () => [
        { id: 'pvp', version: 2, title: 'Process Validation Protocol' },
        { id: 'pvp', version: 3, title: 'Process Validation Protocol' },
        { id: 'invoice', version: 1, title: 'Invoice' },
      ]),
    });
    render(<ResultsPage api={api} />);
    const select = await screen.findByLabelText('Document type');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All',
      'Invoice',
      'Process Validation Protocol',
    ]);
    await userEvent.selectOptions(select, 'pvp');
    expect(listResults).toHaveBeenLastCalledWith({ templateId: 'pvp', before: undefined });
  });

  it('loads more with the last publish time as the cursor', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) =>
      result({ filename: `p1-${i}.pdf`, publishedAt: `2026-10-02T09:00:${String(59 - i).padStart(2, '0')}.000Z` }),
    );
    const listResults = vi
      .fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([result({ filename: 'p2.pdf' })]);
    render(<ResultsPage api={fakeApi({ listResults })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(listResults).toHaveBeenLastCalledWith({ templateId: undefined, before: page1[49]!.publishedAt });
    expect(await screen.findByRole('link', { name: 'p2.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'p1-0.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('explains the empty state and shows load errors', async () => {
    const { unmount } = render(<ResultsPage api={fakeApi()} />);
    expect(await screen.findByText(/No published results yet/)).toHaveTextContent(
      'Test runs and rejected documents never appear here.',
    );
    unmount();
    render(<ResultsPage api={fakeApi({ listResults: vi.fn(async () => { throw new Error('boom'); }) })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load results: boom');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run --project web apps/web/test/ResultsPage.test.tsx`
Expected: FAIL, because the placeholder renders only a heading.

- [ ] **Step 3: Implement** (replace `apps/web/src/results/ResultsPage.tsx`)

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { ResultSummary } from '@ih/shared';
import type { Api } from '../api/client.js';

/** Must match the API's default `limit` for GET /api/results. */
export const RESULTS_PAGE_SIZE = 50;

const when = (iso: string) => new Date(iso).toLocaleString();

function reviewedBy(r: ResultSummary): string {
  if (!r.reviewedAt) return 'auto';
  return r.reviewer ?? 'unnamed reviewer';
}

export function ResultsPage({ api }: { api: Api }) {
  const [types, setTypes] = useState<{ id: string; title: string }[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [rows, setRows] = useState<ResultSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listSpecs().then(
      (specs) => {
        const byId = new Map(specs.map((s) => [s.id, s.title]));
        setTypes(
          [...byId].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title)),
        );
      },
      () => setTypes([]),
    );
  }, [api]);

  const load = useCallback(
    async (before?: string) => {
      try {
        const page = await api.listResults({ templateId: templateId || undefined, before });
        setRows((current) => (before ? [...current, ...page] : page));
        setHasMore(page.length === RESULTS_PAGE_SIZE);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoaded(true);
      }
    },
    [api, templateId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="results">
      <h2>Results</h2>
      <label className="filter">
        Document type
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">All</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">Failed to load results: {error}</p>}
      {loaded && !error && rows.length === 0 ? (
        <p>No published results yet. Test runs and rejected documents never appear here.</p>
      ) : (
        <table aria-label="Published results">
          <thead>
            <tr>
              <th>Document</th>
              <th>Type</th>
              <th>Published</th>
              <th>Reviewed by</th>
              <th>Issues</th>
              <th>Files</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.jobId}>
                <td>
                  <a href={`#/results/${r.jobId}`}>{r.filename}</a>
                </td>
                <td>
                  {r.specId} v{r.specVersion}
                </td>
                <td>{when(r.publishedAt)}</td>
                <td>{reviewedBy(r)}</td>
                <td>{r.issueCount ?? '—'}</td>
                <td>{r.outputCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {hasMore && (
        <button type="button" onClick={() => void load(rows.at(-1)?.publishedAt)}>
          Load more
        </button>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run --project web apps/web/test/ResultsPage.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/results/ResultsPage.tsx apps/web/test/ResultsPage.test.tsx
git commit -m "Web: Results list page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Result detail page

**Files:**
- Modify: `apps/web/src/results/ResultDetail.tsx` (replace the placeholder), `apps/web/src/styles.css`
- Create: `apps/web/test/result-fixture.ts`
- Test: `apps/web/test/ResultDetail.test.tsx`

**Interfaces:**
- Consumes: `Api.getResult`, `Api.outputUrl`, `Api.getOutputText` (Task 6), `parseCsv` (Task 7), `display` (`apps/web/src/review/effective.ts`: `null/undefined/'' → '—'`, arrays → comma-joined, else `String(v)`), `ResultDetail`, `PublishedDocument`, `ResultDefinition` (Task 1).
- Produces: `ResultDetailView({ api, jobId })`; `PREVIEW_ROWS = 500`.

- [ ] **Step 1: Write the fixture and failing tests**

```ts
// apps/web/test/result-fixture.ts
import type { ResultDetail } from '@ih/shared';
import { job } from './fake-api.js';

export function resultDetail(overrides: Partial<ResultDetail> = {}): ResultDetail {
  const j = job({ id: 'j1', filename: 'protocol.pdf', specId: 'pvp', specVersion: 3, status: 'succeeded', reviewer: 'Ken', reviewNote: 'Checked', reviewedAt: '2026-10-02T08:00:00Z' });
  return {
    job: j,
    target: { bucket: 'ingest-published', prefix: 'pvp/' },
    outputs: [
      { outputId: 'document', stage: 'published', format: 'json', bucket: 'ingest-published', key: 'pvp/x/document/d.json', rowCount: null },
      { outputId: 'results', stage: 'published', format: 'csv', bucket: 'ingest-published', key: 'pvp/x/results/d.csv', rowCount: 2 },
    ],
    document: {
      document_id: 'd',
      fields: {
        product: { value: 'Aspirin' },
        batches: { value: ['B1', 'B2'] },
        approved: { value: true },
        extra: { value: { lot: 7 } },
        missing: { value: null },
      },
      tables: { results: [{ batch: 'B1', value: 1.5 }, { batch: 'B2', value: 2 }] },
      checks: { batch_check: { rows: [{ value: 'B1', status: 'ok' }] } },
      issues: [{ step: 'data', target: 'results', row: 2, column: 'value', message: 'unreadable' }],
      review: { reviewer: 'Ken', note: 'Checked', reviewed_at: '2026-10-02T08:00:00Z', edits: [
        { field: 'product', value: 'Aspirin' },
        { table: 'results', row: 2, column: 'value', value: 2 },
      ] },
      published_at: '2026-10-02T08:00:01Z',
    },
    documentError: null,
    definition: {
      kind: 'template',
      fields: [
        { id: 'product', name: 'Product', type: 'text' },
        { id: 'batches', type: 'list' },
        { id: 'approved', type: 'boolean' },
        { id: 'extra', type: 'text' },
        { id: 'missing', name: 'Missing value', type: 'text' },
      ],
      tables: [{ id: 'results', name: 'Test results', columns: [{ id: 'batch', name: 'Batch', type: 'text' }, { id: 'value', type: 'decimal' }] }],
    },
    ...overrides,
  };
}
```

```tsx
// apps/web/test/ResultDetail.test.tsx
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResultDetailView } from '../src/results/ResultDetail.js';
import { fakeApi } from './fake-api.js';
import { resultDetail } from './result-fixture.js';

const valueOf = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;

describe('ResultDetailView', () => {
  it('shows the header, review, target and published downloads', async () => {
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => resultDetail()) })} jobId="j1" />);
    expect(await screen.findByRole('heading', { name: /protocol\.pdf/ })).toHaveTextContent('pvp v3');
    expect(valueOf('Review')).toHaveTextContent('Approved by Ken — Checked');
    expect(valueOf('Target')).toHaveTextContent('ingest-published/pvp/');
    const downloads = screen.getByRole('navigation', { name: 'Downloads' });
    expect(within(downloads).getByRole('link', { name: 'results.csv' })).toHaveAttribute(
      'href',
      '/api/jobs/j1/outputs/results?stage=published',
    );
  });

  it('renders labelled fields with formatted values and edit markers', async () => {
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => resultDetail()) })} jobId="j1" />);
    expect(await screen.findByText('Product', { selector: 'dt' })).toBeInTheDocument();
    expect(valueOf('Product')).toHaveTextContent('Aspirin');
    expect(within(valueOf('Product') as HTMLElement).getByText('edited')).toBeInTheDocument();
    expect(valueOf('batches')).toHaveTextContent('B1, B2');
    expect(valueOf('approved')).toHaveTextContent('true');
    expect(valueOf('extra')).toHaveTextContent('{"lot":7}');
    expect(valueOf('Missing value')).toHaveTextContent('—');
  });

  it('renders tables with template headings and marks edited cells', async () => {
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => resultDetail()) })} jobId="j1" />);
    const table = await screen.findByRole('table', { name: 'Test results' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['#', 'Batch', 'value']);
    const cell = within(table).getAllByRole('row')[2]!.querySelectorAll('td')[2]!;
    expect(cell).toHaveTextContent('2');
    expect(cell).toHaveClass('edited-cell');
  });

  it('keeps checks and issues collapsed with counts', async () => {
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => resultDetail()) })} jobId="j1" />);
    const issues = (await screen.findByText('Issues (1)')).closest('details')!;
    expect(issues).not.toHaveAttribute('open');
    expect(screen.getByText('Checks (1)').closest('details')).not.toHaveAttribute('open');
  });

  it('falls back to document keys when the template is unknown', async () => {
    const detail = resultDetail({ definition: { kind: 'unknown' } });
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => detail) })} jobId="j1" />);
    expect(await screen.findByText('product', { selector: 'dt' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'results' })).toBeInTheDocument();
  });

  it('shows document errors with the target and keeps downloads', async () => {
    const detail = resultDetail({ document: null, documentError: 'missing from target' });
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => detail) })} jobId="j1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Published document missing from target (bucket ingest-published).',
    );
    expect(screen.getByRole('navigation', { name: 'Downloads' })).toBeInTheDocument();
  });

  it('previews legacy outputs: CSV truncated to 500 rows, JSON pretty, failures inline', async () => {
    const csv = ['a,b', ...Array.from({ length: 501 }, (_, i) => `${i},"x,${i}"`)].join('\n');
    const detail = resultDetail({
      document: null,
      definition: { kind: 'spec' },
      outputs: [
        { outputId: 'lines', stage: 'published', format: 'csv', bucket: 'b', key: 'k/lines.csv', rowCount: 501 },
        { outputId: 'all', stage: 'published', format: 'json', bucket: 'b', key: 'k/all.json', rowCount: null },
        { outputId: 'gone', stage: 'published', format: 'csv', bucket: 'b', key: 'k/gone.csv', rowCount: 1 },
      ],
    });
    const getOutputText = vi.fn(async (_j: string, outputId: string) => {
      if (outputId === 'lines') return csv;
      if (outputId === 'all') return '{"a":1}';
      throw new Error('output object missing from target');
    });
    render(<ResultDetailView api={fakeApi({ getResult: vi.fn(async () => detail), getOutputText })} jobId="j1" />);
    const lines = await screen.findByRole('table', { name: 'lines.csv' });
    expect(within(lines).getAllByRole('row')).toHaveLength(501); // header + 500
    expect(within(lines).getByText('x,0')).toBeInTheDocument();
    expect(screen.getByText('Showing 500 of 501 rows')).toBeInTheDocument();
    expect(await screen.findByText(/"a": 1/)).toBeInTheDocument();
    expect(await screen.findByText('gone.csv: output object missing from target')).toBeInTheDocument();
    expect(getOutputText).toHaveBeenCalledWith('j1', 'lines', 'published');
  });

  it('shows not found with a way back', async () => {
    const api = fakeApi({ getResult: vi.fn(async () => { throw new Error('result not found'); }) });
    render(<ResultDetailView api={api} jobId="j1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('result not found');
    expect(screen.getByRole('link', { name: '← Results' })).toHaveAttribute('href', '#/results');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run --project web apps/web/test/ResultDetail.test.tsx`
Expected: FAIL, because the placeholder renders only a heading.

- [ ] **Step 3: Implement** (replace `apps/web/src/results/ResultDetail.tsx`)

```tsx
import { useEffect, useState } from 'react';
import type { JobOutput, PublishedDocument, ResultDefinition, ResultDetail } from '@ih/shared';
import type { Api } from '../api/client.js';
import { display } from '../review/effective.js';
import { parseCsv } from './csv.js';

export const PREVIEW_ROWS = 500;

type Col = { id: string; name?: string };
type TableCols = { id: string; name?: string; columns: Col[] };

const label = (c: { id: string; name?: string }) => c.name ?? c.id;

function format(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return display(value);
}

export function ResultDetailView({ api, jobId }: { api: Api; jobId: string }) {
  const [result, setResult] = useState<ResultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getResult(jobId).then(setResult, (err: Error) => setError(err.message));
  }, [api, jobId]);

  const back = <a href="#/results">← Results</a>;
  if (error) {
    return (
      <section className="result-detail">
        {back}
        <p role="alert">{error}</p>
      </section>
    );
  }
  if (!result) return <p>Loading…</p>;

  const { job, target, outputs, document, documentError, definition } = result;
  const review = job.reviewedAt
    ? `Approved by ${job.reviewer ?? 'unnamed reviewer'}${job.reviewNote ? ` — ${job.reviewNote}` : ''}`
    : 'Published without review';
  const published = document?.published_at ?? job.updatedAt;

  return (
    <section className="result-detail">
      {back}
      <h2>
        {job.filename}{' '}
        <small>
          {job.specId} v{job.specVersion}
        </small>
      </h2>
      <dl className="result-meta">
        <dt>Published</dt>
        <dd>{new Date(published).toLocaleString()}</dd>
        <dt>Review</dt>
        <dd>{review}</dd>
        <dt>Target</dt>
        <dd>
          <code>
            {target.bucket}/{target.prefix}
          </code>
        </dd>
      </dl>
      <nav aria-label="Downloads" className="downloads">
        {outputs.map((o) => (
          <a key={o.outputId} href={api.outputUrl(job.id, o.outputId, { stage: 'published' })}>
            {o.outputId}.{o.format}
          </a>
        ))}
      </nav>
      {documentError && (
        <p role="alert">
          Published document {documentError} (bucket {target.bucket}).
        </p>
      )}
      {document ? (
        <DocumentView document={document} definition={definition} />
      ) : (
        !documentError && <OutputPreviews api={api} jobId={job.id} outputs={outputs} />
      )}
    </section>
  );
}

function DocumentView({
  document,
  definition,
}: {
  document: PublishedDocument;
  definition: ResultDefinition;
}) {
  const edits = document.review?.edits ?? [];
  const fields: Col[] =
    definition.kind === 'template'
      ? definition.fields
      : Object.keys(document.fields).map((id) => ({ id }));
  const tables: TableCols[] =
    definition.kind === 'template'
      ? definition.tables
      : Object.entries(document.tables).map(([id, rows]) => ({
          id,
          columns: Object.keys(rows[0] ?? {}).map((c) => ({ id: c })),
        }));
  const checks = Object.entries(document.checks);
  const issueColumns = ['step', 'target', 'row', 'column', 'message'];

  return (
    <>
      {fields.length > 0 && (
        <section aria-label="Fields">
          <h3>Fields</h3>
          <dl className="result-fields">
            {fields.map((f) => (
              <div key={f.id}>
                <dt>{label(f)}</dt>
                <dd>
                  {format(document.fields[f.id]?.value)}
                  {edits.some((e) => e.field === f.id) && <small className="edited">edited</small>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {tables.map((t) => {
        const rows = document.tables[t.id] ?? [];
        return (
          <section key={t.id}>
            <h3>
              {label(t)} <small>({rows.length} rows)</small>
            </h3>
            <div className="table-scroll">
              <table aria-label={label(t)}>
                <thead>
                  <tr>
                    <th>#</th>
                    {t.columns.map((c) => (
                      <th key={c.id}>{label(c)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      {t.columns.map((c) => {
                        const edited = edits.some(
                          (e) => e.table === t.id && e.row === i + 1 && e.column === c.id,
                        );
                        return (
                          <td
                            key={c.id}
                            className={edited ? 'edited-cell' : undefined}
                            title={edited ? 'edited in review' : undefined}
                          >
                            {format(row[c.id])}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      <details>
        <summary>Checks ({checks.length})</summary>
        {checks.map(([id, check]) => (
          <SimpleTable
            key={id}
            label={id}
            header={Object.keys(check.rows[0] ?? {})}
            rows={check.rows.map((r) => Object.keys(check.rows[0] ?? {}).map((k) => format(r[k])))}
          />
        ))}
      </details>
      <details>
        <summary>Issues ({document.issues.length})</summary>
        <SimpleTable
          label="Issues"
          header={issueColumns}
          rows={document.issues.map((i) => issueColumns.map((k) => format(i[k])))}
        />
      </details>
    </>
  );
}

function SimpleTable({ label: name, header, rows }: { label: string; header: string[]; rows: string[][] }) {
  return (
    <div className="table-scroll">
      <table aria-label={name}>
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutputPreviews({ api, jobId, outputs }: { api: Api; jobId: string; outputs: JobOutput[] }) {
  return (
    <>
      {outputs.map((o) => (
        <OutputPreview key={o.outputId} api={api} jobId={jobId} output={o} />
      ))}
    </>
  );
}

function OutputPreview({ api, jobId, output }: { api: Api; jobId: string; output: JobOutput }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const name = `${output.outputId}.${output.format}`;

  useEffect(() => {
    api.getOutputText(jobId, output.outputId, 'published').then(setText, (err: Error) =>
      setFailed(err.message),
    );
  }, [api, jobId, output.outputId]);

  if (failed) return <p className="hint">{`${name}: ${failed}`}</p>;
  if (text === null) return <p>Loading {name}…</p>;
  if (output.format === 'json') {
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON after all: show it raw.
    }
    return (
      <section>
        <h3>{name}</h3>
        <pre>{pretty}</pre>
      </section>
    );
  }
  const [header = [], ...body] = parseCsv(text);
  return (
    <section>
      <h3>{name}</h3>
      <SimpleTable label={name} header={header} rows={body.slice(0, PREVIEW_ROWS)} />
      {body.length > PREVIEW_ROWS && (
        <p className="hint">{`Showing ${PREVIEW_ROWS} of ${body.length} rows`}</p>
      )}
    </section>
  );
}
```

Append to `apps/web/src/styles.css`:

```css

/* Results */
.result-meta,
.result-fields {
  display: grid;
  grid-template-columns: 12rem 1fr;
  gap: 0.35rem 1rem;
  margin: 0.75rem 0;
}
.result-fields > div {
  display: contents;
}
.result-meta dt,
.result-fields dt {
  font-weight: 600;
}
.result-meta dd,
.result-fields dd {
  margin: 0;
}
.downloads {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  margin: 0.5rem 0 1rem;
}
.result-detail details {
  margin: 1rem 0;
}
.result-detail pre {
  overflow: auto;
  max-height: 60vh;
}
@media (max-width: 700px) {
  .result-meta,
  .result-fields {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run --project web` and `npm run typecheck && npm run lint && npm run format:check`
Expected: PASS and clean. Run `npx prettier --write` on changed files if the format check fails.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/results/ResultDetail.tsx apps/web/src/styles.css apps/web/test/result-fixture.ts apps/web/test/ResultDetail.test.tsx
git commit -m "Web: result detail page (fields, tables, checks, issues, legacy previews)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, ADR and full verification

**Files:**
- Create: `docs/adr/0004-api-reads-publish-target.md`
- Modify: `docs/architecture.md`, `CLAUDE.md`, `deploy/README.md`

- [ ] **Step 1: Write the ADR**

```markdown
# 0004 — The API reads the publish target for the Results page

**Status:** accepted · 2026-10-11

## Context
Published outputs go to a deployment-wide final target (`TARGET_S3_*`), which may be a
different S3 endpoint from the internal SeaweedFS. The Results page must show what was actually
delivered.

## Decision
The API resolves the same `TARGET_S3_*` variables as the worker (falling back to `S3_*`) and
holds a second `ObjectStore` for the target. Every read of a `job_outputs` object picks the
store by `stage` (`storeFor`): draft → outputs bucket, published → target.

## Consequences
- Results show exactly what was delivered. Objects later deleted from the target are reported as
  missing rather than reconstructed.
- The API now holds target credentials, so give it read access to the target (write access is
  only needed by the worker).
- No schema or worker change: `job_outputs` already records bucket, prefixed key and publish time.
```

- [ ] **Step 2: Update docs**
  - `docs/architecture.md`: after the paragraph mentioning the final target (`TARGET_S3_*`, around line 29), add: "The **Results** page (`#/results`, `GET /api/results`, `GET /api/results/:jobId`) reads published outputs back from the target. The API resolves `TARGET_S3_*` like the worker ([ADR 0004](adr/0004-api-reads-publish-target.md))."
  - `CLAUDE.md`, in "Rules of the road", after the **Review** bullet: "- **Results:** `apps/web/src/results/` + `apps/api/src/routes/results.ts` read published outputs from the target store (`AppDeps.targetStore`, `storeFor(stage)`); the API reads `TARGET_S3_*` via `targetConfig` (same fallback as the worker)."
  - `deploy/README.md`: add a bullet to the `## Notes` section: "- **Final target (`TARGET_S3_*`):** the worker writes published outputs there and the API reads them back for the Results page. Empty values fall back to the internal SeaweedFS (`S3_*`). For an external target, give the credentials write access for the worker and at least read access for the API."

- [ ] **Step 3: Full verification**

Run: `npm run check`
Expected: lint, format, typecheck and all TS tests green. If `uv` is unavailable locally, the worker steps can't run. No worker files changed; say so in the PR, and CI covers them.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0004-api-reads-publish-target.md docs/architecture.md CLAUDE.md deploy/README.md
git commit -m "Docs: Results page and ADR 0004 (API reads the publish target)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
