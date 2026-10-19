# Delivery bridge, phase 1: contract and skeleton — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public sink contract package and a standalone bridge service. The bridge takes
signed delivery requests, runs them against an in-process sink port through a Postgres queue, and
reports outcomes as signed events. It is proven against a scriptable fake sink. Nothing in CT
Studio calls it yet.

**Architecture:**
- `packages/bridge-contract` holds the Zod schemas for both APIs (producer ↔ bridge and
  bridge ↔ sink), request signing, the idempotency key, shared JSON fixtures and a conformance
  suite.
- `apps/bridge` is a Fastify service with its own Postgres schema `bridge` and its own migration
  runner. It has ports with in-memory fakes:
  - `SinkPort`;
  - `PackageStore`;
  - `DeliveryRepo`;
  - `EventSender`;
  - `TargetRepo`.
- A delivery runner and an event dispatcher are plain functions, driven by a loop in `server.ts`.

**Tech stack:** Node 24, TypeScript (ESM, `.js` import suffixes), Fastify 5, Zod 4,
`@fastify/swagger`, `pg`, vitest 3. The stack matches `apps/api`, but the bridge imports nothing
from it.

**Spec:** [docs/superpowers/specs/2026-10-19-delivery-bridge-design.md](../specs/2026-10-19-delivery-bridge-design.md)
(phase 1 row; sections "Where it lives", "Talking to the bridge", "The package", "Delivering",
"Idempotency, replace and skip", "Sink contract").

## Global constraints

- **Imports.** The bridge never imports from `apps/api`, `apps/web` or `worker`. It imports only
  `@ih/bridge-contract`. CT Studio code reaches it only through the contract (spec, "Where it
  lives").
- **No vendor names.** No product, vendor or private-repository names of any external sink in code,
  fixtures, tests or docs. External sinks are "external sinks".
- **Migrations.** Forward-only. The bridge's migrations go in `db/bridge-migrations/`, are named
  `YYYYMMDDHHMM_description.sql` (UTC), are applied into schema `bridge`, and are tracked in
  `bridge.schema_migrations`.
- **Routes.** Every route is documented with a Zod `schema` and appears in the bridge's OpenAPI
  document. A test fails on an undocumented route (this is CT Studio's rule).
- **Tests.** Unit tests touch no network, Postgres or S3. Postgres tests are opt-in through
  `IH_TEST_DATABASE_URL`, live in `apps/bridge/test/integration/`, and run with
  `npm run test:integration`.
- **The gate.** `npm run check` stays the one gate. The bridge joins it through the root vitest
  projects and the workspace `typecheck` script.
- **TDD.** Red first, every task.
- **Signing.** HMAC-SHA256, compared in constant time. The replay window is 300 seconds.
- **Package retention.** `BRIDGE_PACKAGE_RETENTION_DAYS` defaults to `30`.
- **Errors.** One shape everywhere: `{ class, code, message, details? }`, where `class` is
  `needs_user` or `retryable`. Every response carries an `x-request-id` header.

## Decisions this plan makes (within "left to the builder")

- **Package transport is JSON, not multipart.** File and image bytes travel base64-encoded in the
  package's `files[].content`. This lets one HMAC cover the exact body bytes. The body limit is
  `BRIDGE_MAX_PACKAGE_MB` (default `50`). Task 15 updates the spec's "Transport" line to match.
- **Signing headers:**
  - `x-bridge-timestamp` (Unix seconds);
  - `x-bridge-nonce` (uuid);
  - `x-bridge-signature`: hex HMAC-SHA256 of
    `METHOD\nPATH_WITH_QUERY\nTIMESTAMP\nNONCE\nSHA256_HEX(BODY)`.
- **The destination schema** is a list of field descriptors, not raw JSON Schema:
  `{ id, label, kind: 'fixed' | 'pattern', required, overridable, browse }`. It carries the same
  information the spec asks for and is simpler to render.
- **The idempotency key** is the hex SHA-256 of `${sourceSha256}\n${recipeId}\n${recipeVersion}`.
- **Delivery statuses:**
  - `queued` → `running` → one of `waiting` (a sink job is pending), `succeeded`, `skipped`,
    `needs_user` or `failed`;
  - from `running`, back to `queued` with a later `run_after` on a retryable error.

  Retries default to 8 attempts, with backoff of `min(2^attempt × 15 s, 1 h)`.
- **Events** are written to an outbox table in the same transaction as the status change. A
  dispatcher sends them, and each delivery's events carry a sequence number that increases.

## Review focus

1. **A replayed or reordered signed request** must be refused even within the window: a seen
   nonce gives 401. A body changed after signing must be refused. → Task 3 and Task 9 tests.
2. **Two runners claiming at once** must never run the same delivery twice (`SKIP LOCKED`).
   → the Task 7 Pg integration test.
3. **A runner killed mid-delivery** must not strand a delivery as `running` forever. A delivery
   whose claim is older than its lease (`BRIDGE_LEASE_SECONDS`, default `300`) is claimable
   again. → the Task 7 contract test "reclaims an expired lease".
4. **A delivery request naming several targets where one is invalid** is refused as a whole, with
   no partial insert: one bad target gives 422 and creates no package or deliveries. → Task 10
   test.
5. **The events endpoint being down for hours** must not lose events or block deliveries. Events
   stay in the outbox with backoff, and deliveries carry on. → Task 12 test.

---

### Task 1: Contract package scaffold and error schema

**Files:**
- Create: `packages/bridge-contract/package.json` (`name: "@ih/bridge-contract"`,
  `"type": "module"`, `"license": "Apache-2.0"`, `exports` exactly like `packages/shared`, and a
  dependency on `zod` `^4.6.7`)
- Create: `packages/bridge-contract/tsconfig.json` and `tsconfig.build.json`, copied in shape from
  `packages/shared`
- Create: `packages/bridge-contract/vitest.config.ts` (project `name: 'bridge-contract'`)
- Create: `packages/bridge-contract/src/index.ts`, which re-exports every module below
- Create: `packages/bridge-contract/src/errors.ts`
- Modify: `vitest.config.ts` (root), adding `'packages/bridge-contract/vitest.config.ts'` to
  `projects`
- Test: `packages/bridge-contract/test/errors.test.ts`

**Interfaces:**
- Produces:
  - `ErrorClassSchema = z.enum(['needs_user', 'retryable'])`
  - `BridgeErrorSchema = z.strictObject({ class: ErrorClassSchema, code: z.string().regex(/^[a-z][a-z0-9_]*$/), message: z.string().min(1), details: z.record(z.string(), z.unknown()).optional() })`
  - `type BridgeError = z.infer<typeof BridgeErrorSchema>`
  - `ERROR_CODES`: a frozen record from code to class:
    - `needs_user`: `credential_rejected`, `credential_mfa_required`, `credential_missing`,
      `connection_missing`, `name_conflict`, `content_rejected`, `target_missing`,
      `pattern_unresolved`, `instance_not_allowed`, `unsupported_part`;
    - `retryable`: `instance_unavailable`, `sink_unavailable`, `timeout`, `internal`.
  - `type ErrorCode = keyof typeof ERROR_CODES`
  - `bridgeError(code: ErrorCode, message: string, details?: Record<string, unknown>): BridgeError`

- [ ] **Step 1: Write the failing tests**

```ts
it('takes its class from the code', () => {
  expect(bridgeError('name_conflict', 'taken')).toEqual({ class: 'needs_user', code: 'name_conflict', message: 'taken' });
  expect(bridgeError('timeout', 'slow').class).toBe('retryable');
});
it('refuses unknown fields and bad codes', () => {
  expect(BridgeErrorSchema.safeParse({ class: 'retryable', code: 'Bad-Code', message: 'x' }).success).toBe(false);
  expect(BridgeErrorSchema.safeParse({ class: 'retryable', code: 'timeout', message: 'x', extra: 1 }).success).toBe(false);
});
```

- [ ] **Step 2: Run them and see them fail.** Run
  `npx vitest run --project bridge-contract`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `errors.ts`, `index.ts` and the package files.
- [ ] **Step 4: Run them again.** Same command. Expected: PASS. Also run `npm run typecheck`.
  Expected: no errors.
- [ ] **Step 5: Commit.** `git commit -m "bridge-contract: package and error shape"`

### Task 2: Package schema and idempotency key

**Files:**
- Create: `packages/bridge-contract/src/package.ts`
- Create: `packages/bridge-contract/src/idempotency.ts`
- Test: `packages/bridge-contract/test/package.test.ts`

**Interfaces:**
- Produces (all `z.strictObject` unless noted):
  - `ActingUserSchema`: `{ id: z.string().min(1), name: z.string(), email: z.string().email().nullable() }`
  - `ProvenanceSchema`: `{ sourceSha256: z.string().regex(/^[0-9a-f]{64}$/), sourceFilename: z.string(), jobId: z.string(), recipeId: z.string(), recipeVersion: z.number().int().positive(), approver: ActingUserSchema.nullable(), extractedAt: z.string().datetime().nullable(), publishedAt: z.string().datetime() }`
  - `PackageFileSchema`: `{ output: z.string().min(1), format: z.string(), contentType: z.string(), name: z.string().min(1), content: z.string().base64() }`
  - `DataFieldSchema`: `{ id, title: z.string().nullable(), type: z.string(), value: z.unknown(), unit: z.string().nullable() }`
  - `DataTableSchema`: `{ id, title: z.string().nullable(), columns: z.array(z.strictObject({ id, title: z.string().nullable(), type: z.string() })), rows: z.array(z.record(z.string(), z.unknown())) }`
  - `PackageDataSchema`: `{ fields: z.array(DataFieldSchema), tables: z.array(DataTableSchema) }`
  - `PackageRdfSchema`: `{ graphName: z.string().url(), version: z.number().int().positive(), turtle: z.string() }`
  - `NarrativeBlockSchema`: a discriminated union on `type`, of `paragraph` `{ text }`, `list` `{ ordered: boolean, items: z.array(z.string()) }`, `table` `{ tableId: z.string() }` and `figure` `{ imageId: z.string(), caption: z.string().nullable() }`. It is defined now but never filled in phases 1–2.
  - `PackageImageSchema`: `{ id, contentType, content: z.string().base64() }`
  - `PackageSchema`: `{ kind: z.enum(['document', 'graph']), contractVersion: z.literal(1), producer: z.strictObject({ name: z.string(), deployment: z.string() }), idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/), provenance: ProvenanceSchema.nullable(), naming: z.record(z.string(), z.string()), files: z.array(PackageFileSchema), data: PackageDataSchema.nullable(), rdf: PackageRdfSchema.nullable(), narrative: z.array(NarrativeBlockSchema).nullable(), images: z.array(PackageImageSchema).nullable() }`
    - Refinement: `kind: 'document'` needs `provenance`.
    - Refinement: `files[].name` values must be unique.
  - `type BridgePackage = z.infer<typeof PackageSchema>`
  - `PACKAGE_PARTS = ['files', 'data', 'rdf', 'narrative', 'images'] as const`, with `type PackagePart = (typeof PACKAGE_PARTS)[number]`
  - `partsOf(p: BridgePackage): PackagePart[]` lists the non-empty parts (`files` when the array is not empty).
  - `idempotencyKey(sourceSha256: string, recipeId: string, recipeVersion: number): string`, implemented with `node:crypto` `createHash('sha256')`.

- [ ] **Step 1: Write the failing tests**

```ts
it('derives a stable key from source, recipe and version', () => {
  const a = idempotencyKey('a'.repeat(64), 'invoice', 3);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(idempotencyKey('a'.repeat(64), 'invoice', 3)).toBe(a);
  expect(idempotencyKey('a'.repeat(64), 'invoice', 4)).not.toBe(a);
  expect(a).toBe(createHash('sha256').update(`${'a'.repeat(64)}\ninvoice\n3`).digest('hex'));
});
it('needs provenance on a document package and unique file names', () => {
  expect(PackageSchema.safeParse({ ...docPackage, provenance: null }).success).toBe(false);
  expect(PackageSchema.safeParse({ ...docPackage, files: [file('a.csv'), file('a.csv')] }).success).toBe(false);
  expect(PackageSchema.safeParse({ ...docPackage, kind: 'graph', provenance: null }).success).toBe(true);
});
it('lists the parts a package carries', () => {
  expect(partsOf({ ...docPackage, data: null, rdf: null })).toEqual(['files']);
});
```

  `docPackage` and `file()` are test builders in `packages/bridge-contract/test/builders.ts`,
  which Task 4's fixtures also use.
- [ ] **Step 2: Run them and see them fail.** Run
  `npx vitest run --project bridge-contract test/package.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `package.ts` and `idempotency.ts`, and export them from `index.ts`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge-contract: package schema and idempotency key"`

### Task 3: Request signing and verification

**Files:**
- Create: `packages/bridge-contract/src/signing.ts`
- Test: `packages/bridge-contract/test/signing.test.ts`

**Interfaces:**
- Produces:
  - `SIGNATURE_HEADERS = { timestamp: 'x-bridge-timestamp', nonce: 'x-bridge-nonce', signature: 'x-bridge-signature' } as const`
  - `REPLAY_WINDOW_SECONDS = 300`
  - `signRequest(key: string, req: { method: string; path: string; body: Buffer | string }, now?: () => number, nonce?: () => string): Record<string, string>`. It returns the three headers.
  - `interface NonceStore { seen(nonce: string, expiresAtSeconds: number): boolean }`. It returns `true` when the nonce was already seen, and records it either way.
  - `class MemoryNonceStore implements NonceStore`. It prunes expired entries on each call.
  - `verifyRequest(key: string, req: { method: string; path: string; body: Buffer | string; headers: Record<string, string | string[] | undefined> }, nonces: NonceStore, now?: () => number): { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'replayed' | 'bad_signature' }`
    - The comparison uses `crypto.timingSafeEqual` on equal-length buffers.
    - A signature of the wrong length is `bad_signature`.

- [ ] **Step 1: Write the failing tests**

```ts
const key = 'k'.repeat(32);
it('accepts what it signed', () => {
  const h = signRequest(key, { method: 'POST', path: '/v1/deliveries', body: '{"a":1}' }, () => 1000, () => 'n1');
  expect(verifyRequest(key, { method: 'POST', path: '/v1/deliveries', body: '{"a":1}', headers: h }, new MemoryNonceStore(), () => 1000)).toEqual({ ok: true });
});
it.each([
  ['changed body', { body: '{"a":2}' }, 'bad_signature'],
  ['other path', { path: '/v1/other' }, 'bad_signature'],
  ['wrong key', { key: 'x'.repeat(32) }, 'bad_signature'],
])('refuses a %s', (_n, change, reason) => { /* sign original, verify with the change applied; expect { ok: false, reason } */ });
it('refuses a stale timestamp and a replayed nonce', () => {
  // signed at t=1000: verified at t=1301 -> 'stale'; verified twice at t=1000 with one store -> second is 'replayed'
});
it('refuses missing headers', () => { /* {} headers -> 'missing' */ });
```

- [ ] **Step 2: Run them and see them fail.** Run
  `npx vitest run --project bridge-contract test/signing.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `signing.ts` with `node:crypto` `createHmac` and `createHash`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge-contract: HMAC request signing with replay window"`

### Task 4: Sink API and producer API schemas, with shared fixtures

**Files:**
- Create: `packages/bridge-contract/src/sink-api.ts`
- Create: `packages/bridge-contract/src/producer-api.ts`
- Create: `packages/bridge-contract/test/fixtures/describe.json`, `package-document.json`,
  `package-graph.json`, `delivery-request.json`, `delivery-view.json`, `event.json`, `error.json`
- Test: `packages/bridge-contract/test/fixtures.test.ts`

**Interfaces:**
- Produces, in `sink-api.ts`:
  - `CredentialFieldSchema`: `{ id, label, secret: z.boolean() }`
  - `DestinationFieldSchema`: `{ id, label, kind: z.enum(['fixed', 'pattern']), required: z.boolean(), overridable: z.boolean(), browse: z.boolean() }`
  - `CapabilitiesSchema`: `{ browse: z.boolean(), replace: z.boolean(), withdraw: z.boolean(), readBack: z.boolean(), accepts: z.array(z.enum(PACKAGE_PARTS)).min(1) }`
  - `SinkDescribeSchema`: `{ name: z.string(), contractVersion: z.literal(1), connectionKind: z.enum(['shared', 'personal']), instances: z.array(z.strictObject({ id, label })), credentialFields: z.array(CredentialFieldSchema), destinationFields: z.array(DestinationFieldSchema), capabilities: CapabilitiesSchema }`
  - `DestinationSchema = z.record(z.string(), z.string())`. These are resolved values, with patterns already applied.
  - `CredentialSchema = z.record(z.string(), z.string())`
  - `ConnectionTestRequestSchema`: `{ instanceId, credential: CredentialSchema }`
  - `ConnectionTestResultSchema`: `{ ok: z.literal(true), identity: z.string() }`
  - `BrowseRequestSchema`: `{ instanceId, credential: CredentialSchema.nullable(), field: z.string(), parentId: z.string().nullable(), cursor: z.string().nullable() }`
  - `BrowseNodeSchema`: `{ id, label, kind: z.string(), hasChildren: z.boolean(), selectable: z.boolean() }`
  - `BrowseResultSchema`: `{ nodes: z.array(BrowseNodeSchema), nextCursor: z.string().nullable() }`
  - `ReceiptSchema`: `{ written: z.array(z.strictObject({ kind: z.string(), id: z.string(), label: z.string().nullable(), url: z.string().url().nullable() })) }`
  - `SinkDeliverRequestSchema`: `{ instanceId, credential: CredentialSchema.nullable(), destination: DestinationSchema, idempotencyKey, actingUser: ActingUserSchema.nullable(), package: PackageSchema }`
  - `SinkDeliverResultSchema`: a discriminated union on `status`:
    - `{ status: 'succeeded', receipt: ReceiptSchema }`
    - `{ status: 'pending', sinkJobId: z.string() }`
  - `SinkJobStatusSchema`: a discriminated union on `status`:
    - `{ status: 'pending' }`
    - `{ status: 'succeeded', receipt }`
    - `{ status: 'failed', error: BridgeErrorSchema }`
- Produces, in `producer-api.ts`:
  - `DeliveryStatusSchema = z.enum(['queued', 'running', 'waiting', 'succeeded', 'skipped', 'needs_user', 'failed'])`
  - `CreateDeliveriesRequestSchema`: `{ targets: z.array(z.string().min(1)).min(1), actingUser: ActingUserSchema.nullable(), overrides: z.record(z.string(), z.record(z.string(), z.string())).default({}), package: PackageSchema }`. `overrides` is keyed by target id, then by field id.
  - `CreateDeliveriesResultSchema`: `{ packageId: z.string().uuid(), deliveries: z.array(z.strictObject({ targetId, deliveryId: z.string().uuid() })) }`
  - `DeliveryViewSchema`: `{ id, packageId, targetId, status: DeliveryStatusSchema, attempts: z.number().int(), error: BridgeErrorSchema.nullable(), receipt: ReceiptSchema.nullable(), skippedFor: z.string().uuid().nullable(), createdAt, updatedAt }`
  - `BridgeEventSchema`: `{ eventId: z.string().uuid(), deliveryId: z.string().uuid(), sequence: z.number().int().positive(), status: DeliveryStatusSchema, error: BridgeErrorSchema.nullable(), receipt: ReceiptSchema.nullable(), at: z.string().datetime() }`
  - `SinkViewSchema`: `{ id, name, status: z.enum(['available', 'unavailable']), contractVersion: z.number().int(), capabilities: CapabilitiesSchema, connectionKind }`
  - `TargetViewSchema`: `{ id, label, sinkId, instanceId: z.string().nullable(), destination: DestinationSchema }`

- [ ] **Step 1: Write the failing test.** Every fixture parses with its schema, and
  `package-document.json` round-trips unchanged:

```ts
it.each([
  ['describe.json', SinkDescribeSchema], ['package-document.json', PackageSchema], ['package-graph.json', PackageSchema],
  ['delivery-request.json', CreateDeliveriesRequestSchema], ['delivery-view.json', DeliveryViewSchema],
  ['event.json', BridgeEventSchema], ['error.json', BridgeErrorSchema],
])('%s parses', (file, schema) => {
  const json = JSON.parse(readFileSync(fixture(file), 'utf8'));
  expect(schema.parse(json)).toEqual(json);
});
```

  `package-document.json` has one fields CSV, one table CSV, `document.json` and `data` with one
  field and one table. `package-graph.json` has `kind: 'graph'`, `provenance: null` and `rdf`
  set.
- [ ] **Step 2: Run it and see it fail.** Run
  `npx vitest run --project bridge-contract test/fixtures.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules and write the fixtures.
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge-contract: sink and producer API schemas with shared fixtures"`

### Task 5: Bridge app scaffold, config and health

**Files:**
- Create: `apps/bridge/package.json`:
  - `name: "@ih/bridge"`;
  - scripts `dev`, `build`, `start`, `typecheck`, `migrate` on the `apps/api` pattern;
  - dependencies `@ih/bridge-contract`, `fastify`, `@fastify/swagger`, `pg` and `zod`, at the
    versions `apps/api` uses;
  - devDependencies `@types/pg`, `@types/node`, `tsx`, `@apidevtools/swagger-parser`.
- Create: `apps/bridge/tsconfig.json`, `tsconfig.build.json` and `vitest.config.ts`
  (`name: 'bridge'`, an alias for `@ih/bridge-contract` to its `src/index.ts` as `apps/api` does
  for shared, and exclude `test/integration/**`)
- Create: `apps/bridge/src/config.ts`, `apps/bridge/src/app.ts`, `apps/bridge/src/routes/health.ts`
- Modify: the root `vitest.config.ts` (add `'apps/bridge/vitest.config.ts'`) and `package.json`
  (`dev:bridge`)
- Test: `apps/bridge/test/config.test.ts`, `apps/bridge/test/health.test.ts`,
  `apps/bridge/test/helpers.ts`

**Interfaces:**
- Produces:
  - `BridgeConfig`, from `loadBridgeConfig(env = process.env): BridgeConfig`. It throws one
    `Invalid bridge configuration:\n  <path>: <message>…` error listing every problem, and uses the
    same `blank` and `optional` treatment of `''` as `apps/api/src/config.ts`. Its keys:
    - `HOST` (default `'0.0.0.0'`);
    - `PORT` (default `3100`);
    - `LOG_LEVEL`;
    - `DATABASE_URL` (url);
    - `BRIDGE_CLIENT_KEY` (min 32 characters);
    - `BRIDGE_EVENTS_URL` (url, optional);
    - `BRIDGE_MAX_PACKAGE_MB` (default `50`);
    - `BRIDGE_PACKAGE_RETENTION_DAYS` (default `30`);
    - `BRIDGE_MAX_ATTEMPTS` (default `8`);
    - `BRIDGE_LEASE_SECONDS` (default `300`).
  - `interface BridgeDeps { config: Pick<BridgeConfig, 'BRIDGE_CLIENT_KEY' | 'BRIDGE_MAX_PACKAGE_MB'>; deliveries: DeliveryRepo; packages: PackageStore; targets: TargetRepo; sinks: SinkRegistry; nonces: NonceStore; ready: () => Promise<boolean>; logger?: FastifyBaseLogger | false }`. Later tasks define these types, so for now declare the deps that are present and add the rest as each task lands.
  - `buildBridge(deps: BridgeDeps): Promise<FastifyInstance>`
  - `GET /healthz` returns `{ status: 'ok' }`. `GET /readyz` returns `{ status: 'ready' }` (200) or `{ status: 'not ready' }` (503), from `deps.ready()`. Both are unsigned.
  - `testBridge(over?: Partial<BridgeDeps>)` in `test/helpers.ts`, built from the memory fakes.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists every config problem at once', () => {
  expect(() => loadBridgeConfig({ DATABASE_URL: 'nope', BRIDGE_CLIENT_KEY: 'short' })).toThrow(
    /Invalid bridge configuration:[\s\S]*DATABASE_URL[\s\S]*BRIDGE_CLIENT_KEY/);
});
it('applies defaults and treats blanks as unset', () => {
  const c = loadBridgeConfig({ DATABASE_URL: 'postgres://x/y', BRIDGE_CLIENT_KEY: 'k'.repeat(32), BRIDGE_EVENTS_URL: '' });
  expect(c).toMatchObject({ PORT: 3100, BRIDGE_MAX_ATTEMPTS: 8, BRIDGE_LEASE_SECONDS: 300, BRIDGE_PACKAGE_RETENTION_DAYS: 30 });
  expect(c.BRIDGE_EVENTS_URL).toBeUndefined();
});
it('answers health unsigned and readiness from deps', async () => {
  const app = await testBridge({ ready: async () => false });
  expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok' });
  expect((await app.inject('/readyz')).statusCode).toBe(503);
});
```

- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run --project bridge`. Expected:
  FAIL.
- [ ] **Step 3: Implement** the files listed above. Run `npm ci` after adding the workspace.
- [ ] **Step 4: Run them again.** Expected: PASS. `npm run typecheck` and `npm run lint` are both
  clean.
- [ ] **Step 5: Commit.** `git commit -m "bridge: app scaffold, config and health"`

### Task 6: Bridge migration runner and first schema

**Files:**
- Create: `apps/bridge/src/db/migrate.ts`, `apps/bridge/src/db/migrate-cli.ts`
- Create: `db/bridge-migrations/202610191200_bridge_core.sql`
- Create: `apps/bridge/vitest.integration.config.ts`
- Modify: `package.json` (root) so `test:integration` runs both configs:
  `vitest run --config apps/api/vitest.integration.config.ts && vitest run --config apps/bridge/vitest.integration.config.ts`
- Test: `apps/bridge/test/integration/migrate.test.ts`, which is skipped without
  `IH_TEST_DATABASE_URL`

**Interfaces:**
- Produces:
  - `migrateBridge(databaseUrl: string, dir: string): Promise<string[]>`. It behaves like
    `apps/api/src/db/migrate.ts` with these differences:
    1. It runs `CREATE SCHEMA IF NOT EXISTS bridge` first.
    2. It records applied files in `bridge.schema_migrations`.
    3. Its advisory lock key is `727275`.
    4. Each file runs with `SET LOCAL search_path TO bridge`.
- The schema in `202610191200_bridge_core.sql`, with every table in `bridge`:
  - `targets (id text PK, label text NOT NULL, sink_id text NOT NULL, instance_id text, destination jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`
  - `packages (id uuid PK, kind text NOT NULL CHECK (kind IN ('document','graph')), idempotency_key text NOT NULL, manifest jsonb NOT NULL, staged_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz)`. `manifest` is the package without `files[].content` and `images[].content`.
  - `deliveries (id uuid PK, package_id uuid NOT NULL REFERENCES packages, target_id text NOT NULL REFERENCES targets, idempotency_key text NOT NULL, acting_user jsonb, overrides jsonb NOT NULL DEFAULT '{}', status text NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','skipped','needs_user','failed')), attempts int NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, sink_job_id text, error jsonb, receipt jsonb, skipped_for uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`
  - `INDEX deliveries_claim ON deliveries (run_after) WHERE status IN ('queued','waiting')`
  - `INDEX deliveries_key ON deliveries (target_id, idempotency_key, status)`
  - `events (id uuid PK, delivery_id uuid NOT NULL REFERENCES deliveries, sequence int NOT NULL, body jsonb NOT NULL, sent_at timestamptz, attempts int NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(), UNIQUE (delivery_id, sequence))`

- [ ] **Step 1: Write the failing test.** On a throwaway database, `migrateBridge` returns
  `['202610191200_bridge_core.sql']` the first time and `[]` the second. Afterwards
  `SELECT to_regclass('bridge.deliveries')` is not null, and `public` has no `deliveries` table.
- [ ] **Step 2: Run it and see it fail.** Run
  `IH_TEST_DATABASE_URL=… npx vitest run --config apps/bridge/vitest.integration.config.ts`.
  Expected: FAIL. Without the variable it is skipped.
- [ ] **Step 3: Implement** the runner, the CLI (it reads `DATABASE_URL` and
  `BRIDGE_MIGRATIONS_DIR`, defaulting to `../../../../db/bridge-migrations`) and the SQL.
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: own schema and migration runner"`

### Task 7: DeliveryRepo port, memory and Pg adapters, and contract test

**Files:**
- Create: `apps/bridge/src/deliveries/repo.ts` (the port and `MemoryDeliveryRepo`) and
  `apps/bridge/src/deliveries/pg.ts` (`PgDeliveryRepo`)
- Test: `apps/bridge/test/deliveries-contract.ts`, `apps/bridge/test/deliveries-repo.test.ts`
  (memory), `apps/bridge/test/integration/deliveries-pg.test.ts`

**Interfaces:**
- Produces:

```ts
export interface NewPackage { id: string; kind: 'document' | 'graph'; idempotencyKey: string; manifest: unknown; stagedKey: string; expiresAt: Date | null }
export interface NewDelivery { id: string; targetId: string; actingUser: ActingUser | null; overrides: Record<string, string> }
export interface DeliveryRow { id: string; packageId: string; targetId: string; idempotencyKey: string; actingUser: ActingUser | null;
  overrides: Record<string, string>; status: DeliveryStatus; attempts: number; runAfter: Date; sinkJobId: string | null;
  error: BridgeError | null; receipt: Receipt | null; skippedFor: string | null; createdAt: Date; updatedAt: Date }
export type Transition =
  | { status: 'succeeded'; receipt: Receipt } | { status: 'waiting'; sinkJobId: string; runAfter: Date }
  | { status: 'skipped'; skippedFor: string } | { status: 'needs_user' | 'failed'; error: BridgeError }
  | { status: 'queued'; runAfter: Date; error: BridgeError };   // a retry
export interface DeliveryRepo {
  /** One transaction: the package, its deliveries (status 'queued') and a 'queued' event each. */
  create(pkg: NewPackage, deliveries: NewDelivery[], now: Date): Promise<void>;
  /** Claims one due delivery ('queued' or 'waiting', run_after <= now, lease free or expired): status 'running', attempts+1, lease_until = now + lease. */
  claim(now: Date, leaseSeconds: number): Promise<DeliveryRow | null>;
  /** One transaction: status change, lease cleared, the next event (sequence+1) written to the outbox. */
  transition(id: string, t: Transition, now: Date): Promise<void>;
  get(id: string): Promise<DeliveryRow | null>;
  /** The newest 'succeeded' delivery for this target and key, excluding `exceptId`. */
  latestSucceeded(targetId: string, idempotencyKey: string, exceptId: string): Promise<DeliveryRow | null>;
  getPackage(id: string): Promise<NewPackage | null>;
  /** Outbox: due unsent events, oldest first; markSent / retryEvent. */
  dueEvents(now: Date, limit: number): Promise<{ id: string; body: BridgeEvent; attempts: number }[]>;
  markSent(eventId: string, now: Date): Promise<void>;
  retryEvent(eventId: string, runAfter: Date): Promise<void>;
}
```

  The `waiting` transition sets `run_after` to the next poll time. `claim` treats `waiting` like
  `queued`, and the runner then polls instead of delivering.
- Test: `deliveriesContract(name, make: () => Promise<DeliveryRepo>)`, with these cases:
  - "create writes queued deliveries and one event each, sequence 1";
  - "claim takes the oldest due delivery and leases it";
  - "claim skips a delivery leased by someone else";
  - "reclaims an expired lease" (Review focus 3);
  - "a retry requeues with run_after and keeps the error";
  - "transition writes the next event with sequence+1";
  - "latestSucceeded finds the newest success for target and key, excluding the asking delivery".

  The Pg file also has "two claims in parallel never return the same delivery" (Review focus 2),
  run as 20 deliveries and 10 concurrent claimers, asserting the claimed ids are unique.

- [ ] **Step 1: Write the contract and the memory test file.** These are the cases above.
- [ ] **Step 2: Run them and see them fail.** Run
  `npx vitest run --project bridge test/deliveries-repo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `MemoryDeliveryRepo`.** Run the test again. Expected: PASS.
- [ ] **Step 4: Implement `PgDeliveryRepo`.**
  - `claim` uses
    `UPDATE … WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`.
  - `transition` and the event write share one transaction, with the sequence from
    `COALESCE(MAX(sequence), 0) + 1` for that delivery.
  - Run the integration test with `IH_TEST_DATABASE_URL` set. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: delivery repo with lease-based claiming and outbox"`

### Task 8: Package store, target repo and sink port with a scriptable fake sink

**Files:**
- Create: `apps/bridge/src/packages/store.ts` (`PackageStore`, `MemoryPackageStore`)
- Create: `apps/bridge/src/targets/repo.ts` (`TargetRepo`, `MemoryTargetRepo`) and
  `apps/bridge/src/targets/pg.ts` (`PgTargetRepo`)
- Create: `apps/bridge/src/sinks/port.ts` (`SinkPort`, `SinkRegistry`, `MapSinkRegistry`)
- Create: `apps/bridge/src/sinks/fake.ts` (`FakeSink`)
- Test: `apps/bridge/test/fake-sink.test.ts`, `apps/bridge/test/targets-contract.ts`,
  `apps/bridge/test/targets-repo.test.ts`, `apps/bridge/test/integration/targets-pg.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PackageStore { put(key: string, pkg: BridgePackage): Promise<void>; get(key: string): Promise<BridgePackage | null>; delete(key: string): Promise<void> }
export interface Target { id: string; label: string; sinkId: string; instanceId: string | null; destination: Record<string, string> }
export interface TargetRepo { get(id: string): Promise<Target | null>; list(): Promise<Target[]>; put(t: Target): Promise<void> }
export interface SinkPort {
  describe(): Promise<SinkDescribe>;
  testConnection(req: ConnectionTestRequest): Promise<ConnectionTestResult>;
  browse(req: BrowseRequest): Promise<BrowseResult>;
  deliver(req: SinkDeliverRequest): Promise<SinkDeliverResult>;
  deliveryStatus(sinkJobId: string): Promise<SinkJobStatus>;
}
/** Thrown by a sink to refuse with a contract error. Anything else thrown by a sink is treated as retryable 'internal'. */
export class SinkError extends Error { constructor(readonly error: BridgeError) }
export interface SinkRegistry { get(id: string): SinkPort | null; ids(): string[] }
export class MapSinkRegistry implements SinkRegistry { constructor(sinks: Record<string, SinkPort>) }
export class FakeSink implements SinkPort {
  constructor(describe?: Partial<SinkDescribe>);
  /** The next deliver() calls answer in this order; after the script runs out: succeeded with an empty receipt. */
  script(...steps: Array<'succeed' | 'pending' | { error: ErrorCode } | { throw: string } | { delayMs: number }>): this;
  /** Answers for deliveryStatus(), in order. */
  scriptStatus(...steps: Array<'pending' | 'succeed' | { error: ErrorCode }>): this;
  readonly delivered: SinkDeliverRequest[];
}
```

  `put` on `TargetRepo` is an upsert. Admin routes for targets come in phase 2.

- [ ] **Step 1: Write the failing tests**
  - The fake sink plays its script in order, throws `SinkError` for `{ error }`, throws a plain
    `Error` for `{ throw }`, and records every request in `delivered`.
  - Its default `describe()` parses with `SinkDescribeSchema`.
  - `targetsContract` covers put, get and list, and that put overwrites.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run --project bridge`. Expected:
  FAIL.
- [ ] **Step 3: Implement** everything listed. `PgTargetRepo` uses `bridge.targets`.
- [ ] **Step 4: Run them again.** Expected: PASS, and the integration test passes with
  `IH_TEST_DATABASE_URL`.
- [ ] **Step 5: Commit.** `git commit -m "bridge: package store, target repo, sink port and fake sink"`

### Task 9: Signed-request guard and request ids

**Files:**
- Create: `apps/bridge/src/http/guard.ts`
- Modify: `apps/bridge/src/app.ts`
- Test: `apps/bridge/test/guard.test.ts`

**Interfaces:**
- Consumes: `verifyRequest` and `NonceStore` (Task 3).
- Produces:
  - `registerGuard(app, { key, nonces })`. An `onRequest` and `preValidation` pair for every
    `/v1/*` route.
    - It parses the body as a raw `Buffer`. Register `addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: BRIDGE_MAX_PACKAGE_MB × 2^20 })`, then verify, then `JSON.parse`.
    - A failure answers 401 with
      `bridgeError('credential_rejected', 'request signature refused', { reason })`.
    - `/healthz`, `/readyz` and `/docs/*` are unsigned.
  - Every response carries `x-request-id`, using the request's own id when it sends one.
  - Test helper `signedInject(app, key, { method, url, body })` in `test/helpers.ts`.

- [ ] **Step 1: Write the failing tests**
  - An unsigned `GET /v1/sinks` gives 401 with `reason: 'missing'`.
  - A signed request gives 200.
  - The same signed request sent twice gives 401 `replayed` (Review focus 1).
  - A body changed after signing gives 401 `bad_signature`.
  - `/healthz` gives 200 unsigned.
  - Every response has `x-request-id`.
  - This needs a stub `GET /v1/sinks` route. Task 13 replaces it.
- [ ] **Step 2: Run them and see them fail.** Run
  `npx vitest run --project bridge test/guard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the guard.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: signed-request guard"`

### Task 10: `POST /v1/deliveries`, validated before it is accepted

**Files:**
- Create: `apps/bridge/src/routes/deliveries.ts`
- Create: `apps/bridge/src/deliveries/accept.ts`
- Test: `apps/bridge/test/deliveries-route.test.ts`

**Interfaces:**
- Consumes: `DeliveryRepo.create`, `TargetRepo.get`, `SinkRegistry.get`, `PackageStore.put`.
- Produces:
  - `acceptDeliveries(deps, req: CreateDeliveriesRequest, now: Date, ids: () => string): Promise<CreateDeliveriesResult>`. It throws `SinkError` (needs_user) on the first problem, before writing anything. It checks, for every target:
    1. **The target exists.** Otherwise `target_missing`, with `details.targetId`.
    2. **Its sink is registered.** Otherwise `sink_unavailable`, which is retryable.
    3. **The sink accepts every part.** Each part in `partsOf(package)` must appear in the sink's
       `capabilities.accepts`. Otherwise `unsupported_part`, with `details.part`.
  - Once every check passes, it calls `packages.put(stagedKey, pkg)` with
    `stagedKey = packages/<packageId>.json`, then `deliveries.create(...)` with
    `expiresAt = now + BRIDGE_PACKAGE_RETENTION_DAYS`.
  - `POST /v1/deliveries` answers 202 with `CreateDeliveriesResultSchema`, 422 with
    `BridgeErrorSchema` for needs_user, and 503 for retryable.
  - `GET /v1/deliveries/:id` answers 200 with `DeliveryViewSchema`, or 404.

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts a package for two targets and queues one delivery each', async () => {
  const res = await signedInject(app, KEY, { method: 'POST', url: '/v1/deliveries', body: request(['t1', 't2']) });
  expect(res.statusCode).toBe(202);
  const { deliveries } = CreateDeliveriesResultSchema.parse(res.json());
  expect(deliveries.map((d) => d.targetId)).toEqual(['t1', 't2']);
  for (const d of deliveries) expect((await repo.get(d.deliveryId))?.status).toBe('queued');
});
it('refuses the whole request when one target is missing, writing nothing', async () => {
  const res = await signedInject(app, KEY, { method: 'POST', url: '/v1/deliveries', body: request(['t1', 'nope']) });
  expect(res.statusCode).toBe(422);
  expect(res.json()).toMatchObject({ class: 'needs_user', code: 'target_missing', details: { targetId: 'nope' } });
  expect(await packages.get(anyKey)).toBeNull(); // and repo holds no deliveries
});
it('refuses a part the sink does not accept', async () => { /* FakeSink accepts ['files']; package with data -> 422 unsupported_part */ });
it('reads a delivery back', async () => { /* GET /v1/deliveries/:id -> DeliveryViewSchema, unknown id -> 404 */ });
```

- [ ] **Step 2: Run them and see them fail.** Run
  `npx vitest run --project bridge test/deliveries-route.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `accept.ts` and the routes, with Zod-documented `schema` blocks.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: accept deliveries, all or nothing"`

### Task 11: Delivery runner (deliver, poll, retry, skip)

**Files:**
- Create: `apps/bridge/src/deliveries/runner.ts`
- Test: `apps/bridge/test/runner.test.ts`

**Interfaces:**
- Consumes: Tasks 7, 8 and 10.
- Produces:
  - `backoff(attempt: number): number` gives `Math.min(2 ** attempt * 15, 3600)` seconds.
  - `runOnce(deps: { deliveries, packages, targets, sinks, maxAttempts, leaseSeconds, pollSeconds = 30 }, now: Date): Promise<'idle' | 'worked'>`. It claims one delivery, then:
    1. **A `waiting` delivery with a `sinkJobId`.** Call `sink.deliveryStatus`:
       - `pending` → transition to `waiting`, with `runAfter = now + pollSeconds`;
       - `succeeded` → `succeeded`;
       - `failed` → apply the error rules in step 5.
    2. **Otherwise, check for a skip.** If the sink's capabilities have `replace` false **and**
       `withdraw` false, and `latestSucceeded(targetId, key, id)` exists, transition to `skipped`
       with `skippedFor`.
    3. **Otherwise, deliver.** Load the package from the store. If it is missing, transition to
       `failed` with `internal`, "package expired". Then call `sink.deliver` with:
       - `destination = { ...target.destination, ...overrides }`;
       - `credential: null` (connections come in phase 2);
       - `actingUser`;
       - `idempotencyKey`.
    4. **Map the answer.** `succeeded` → `succeeded`. `pending` → `waiting`, with
       `runAfter = now + pollSeconds`.
    5. **On an error.**
       - A `SinkError` of class `needs_user` → `needs_user`.
       - A retryable `SinkError`, or any other thrown value (as `internal`), → `queued` with
         `runAfter = now + backoff(attempts)`, while `attempts < maxAttempts`. Otherwise
         `failed`.
    6. **A target or sink that has vanished.** `target_missing` → `needs_user`.
       `sink_unavailable` → the retry path.

- [ ] **Step 1: Write the failing tests.** Each uses `FakeSink`, memory repos and a fixed clock.
  - "delivers and records the receipt", which checks the destination merged with the overrides,
    in `sink.delivered[0]`.
  - "a pending answer waits, then a poll completes it".
  - "a needs_user refusal stops without retry".
  - "a retryable error requeues with backoff 30 s, 60 s, … and fails after maxAttempts". This uses
    `maxAttempts: 3` and asserts `run_after` deltas `[30, 60]`, then `failed`.
  - "a thrown non-contract error is retryable 'internal'".
  - "skips a second delivery of the same key to a sink without replace or withdraw, pointing at
    the first".
  - "does not skip when the sink can replace".
  - "returns 'idle' when nothing is due".
- [ ] **Step 2: Run them and see them fail.** Run
  `npx vitest run --project bridge test/runner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `runOnce` and `backoff`.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: delivery runner with poll, retry and skip"`

### Task 12: Event dispatcher

**Files:**
- Create: `apps/bridge/src/events/dispatch.ts` (`EventSender`, `HttpEventSender`,
  `MemoryEventSender`, `dispatchOnce`)
- Test: `apps/bridge/test/events.test.ts`

**Interfaces:**
- Produces:
  - `interface EventSender { send(event: BridgeEvent): Promise<void> }`. It throws on any failure.
  - `class HttpEventSender implements EventSender { constructor(url: string, key: string, fetchImpl = fetch) }`. It POSTs JSON with `signRequest` headers to `url`, and anything other than a 2xx response throws.
  - `dispatchOnce(deps: { deliveries: DeliveryRepo; sender: EventSender }, now: Date, limit = 50): Promise<number>`. It sends due events oldest first and calls `markSent`. On a failure it calls `retryEvent(id, now + backoff(attempts + 1))` and carries on with the next event. It returns the number sent.

- [ ] **Step 1: Write the failing tests**
  - "sends due events in order and marks them sent".
  - "an unreachable endpoint keeps events with backoff and does not block later ones" (Review
    focus 5). The sender fails on event 1 and succeeds on event 2. Afterwards event 1 is unsent
    with a later `run_after`, and event 2 is sent.
  - "HttpEventSender signs what it sends". A stub `fetchImpl` captures the request, and
    `verifyRequest` on it is `{ ok: true }`.
- [ ] **Step 2: Run them and see them fail.** Run
  `npx vitest run --project bridge test/events.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the dispatcher and senders.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: signed event outbox dispatcher"`

### Task 13: Sinks and targets read routes, OpenAPI document and coverage test

**Files:**
- Create: `apps/bridge/src/routes/catalog.ts` (`GET /v1/sinks`, `GET /v1/targets`)
- Create: `apps/bridge/src/openapi.ts`, which registers `@fastify/swagger` with Zod schemas
  through `z.toJSONSchema` (draft-7, `io: 'input'`) and serves `/docs/openapi.json`
- Create: `apps/bridge/openapi.json`, the committed document, regenerated by
  `npm run openapi -w @ih/bridge`
- Test: `apps/bridge/test/openapi.test.ts`, `apps/bridge/test/catalog.test.ts`

**Interfaces:**
- Produces:
  - `GET /v1/sinks` gives `{ sinks: SinkView[] }`, from each registered sink's `describe()`. A
    sink whose `describe()` throws is shown as `status: 'unavailable'`, with
    `capabilities.accepts: ['files']` and other values zeroed.
  - `GET /v1/targets` gives `{ targets: TargetView[] }`.

- [ ] **Step 1: Write the failing tests.**
  - `openapi.test.ts`:
    - the document is valid OpenAPI 3.1 (`SwaggerParser.validate`);
    - every registered route except `/docs/*` appears in `paths`;
    - the committed `apps/bridge/openapi.json` equals the generated document.
  - `catalog.test.ts`: two fake sinks, one of them with a `describe` that throws, give one
    `available` and one `unavailable` sink.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run --project bridge`. Expected:
  FAIL.
- [ ] **Step 3: Implement** the routes and `openapi.ts`, then write `openapi.json`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: catalog routes and OpenAPI document"`

### Task 14: Conformance suite, run against the fake sink served over HTTP

**Files:**
- Create: `packages/bridge-contract/src/conformance/suite.ts`
- Create: `packages/bridge-contract/src/conformance/cli.ts`. It runs the suite from env:
  - `SINK_URL`, `SINK_KEY`, `SINK_INSTANCE`;
  - `SINK_CREDENTIAL` (JSON);
  - `SINK_DESTINATION` (JSON).

  It exits non-zero on any failure.
- Create: `apps/bridge/src/sinks/serve.ts`, holding `serveSink(sink: SinkPort, key: string): Promise<FastifyInstance>`. It exposes a `SinkPort` over the sink contract's HTTP routes, with the guard from Task 9:
  - `GET /describe`;
  - `POST /connections:test`;
  - `POST /browse`;
  - `POST /deliveries`;
  - `GET /deliveries/:sinkJobId`.

  It is used by tests now, and in phase 6 as a reference for the HTTP sink adapter.
- Test: `apps/bridge/test/conformance-fake.test.ts`

**Interfaces:**
- Produces:
  - `conformanceSuite(opts: { url: string; key: string; instanceId: string; credential: Record<string, string> | null; destination: Record<string, string>; fetchImpl?: typeof fetch }): Promise<{ name: string; ok: boolean; detail?: string }[]>`. It is plain async checks, with no vitest dependency, so the CLI runs anywhere. The checks:
    1. **describe** parses, and its `contractVersion` is `1`.
    2. **Unsigned refused.** An unsigned `GET /describe` gives 401.
    3. **connections:test** answers either `ConnectionTestResultSchema` or a `BridgeErrorSchema`
       with a 4xx.
    4. **browse** (when `capabilities.browse` is set): the first page parses with
       `BrowseResultSchema`.
    5. **deliver** of the `package-document.json` fixture answers with `SinkDeliverResultSchema`.
       If the answer is `pending`, `deliveryStatus` is polled until it is not, for at most 60
       seconds.
    6. **Same key again** (when `capabilities.replace` is set): delivering the same key again also
       succeeds.
    7. **Errors.** Every error body seen parses with `BridgeErrorSchema`.
  - The fixtures from Task 4 ship inside the package (`src/conformance/fixtures/` copies them at
    build time, through a `prebuild` script).

- [ ] **Step 1: Write the failing test.** Start `serveSink(new FakeSink(), KEY)` on an ephemeral
  port. `conformanceSuite(...)` returns every check `ok: true`. A second `FakeSink` scripted
  `{ error: 'content_rejected' }` with a malformed error body (a test-only `rawError` hook) makes
  check 7 `ok: false`.
- [ ] **Step 2: Run it and see it fail.** Run
  `npx vitest run --project bridge test/conformance-fake.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the suite, the CLI and `serveSink`.
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge-contract: conformance suite, passing against the fake sink"`

### Task 15: Server entry, Pg wiring, release assets and docs

**Files:**
- Create: `apps/bridge/src/server.ts`. It loads the config, runs `migrateBridge`, and builds the
  Pg repos with `MemoryPackageStore`; phase 2 replaces that with S3. It builds an empty
  `MapSinkRegistry`. It starts two loops:
  - the runner: `runOnce` until `'idle'`, then sleep 1 s;
  - the dispatcher: `dispatchOnce`, then sleep 2 s, only when `BRIDGE_EVENTS_URL` is set.

  It stops both loops on `SIGTERM`.
- Create: `deploy/docker/bridge.Dockerfile`, in the pattern of `api.Dockerfile`. It builds
  `@ih/bridge-contract` and `@ih/bridge`, copies `db/bridge-migrations`, and has
  `EXPOSE 3100` and `CMD ["node", "apps/bridge/dist/server.js"]`. It is not added to compose
  yet; phase 2 does that.
- Create: `deploy/docker/bridge-conformance.Dockerfile`, which runs
  `node packages/bridge-contract/dist/conformance/cli.js`.
- Modify: `.github/workflows/ci.yml`. In the `tag` job (pushes to `main`), after the calendar tag
  is created, build `bridge-conformance.Dockerfile`, push it to
  `ghcr.io/${{ github.repository_owner }}/ct-bridge-conformance:<calendar tag>`, and attach
  `apps/bridge/openapi.json` to the tag's GitHub release. This adds `packages: write` permission
  to that job only.
- Modify: the CLAUDE.md contracts table. Add rows for the package, the delivery request, the
  delivery view and the event, as TS-only for now, with Python arriving in phase 2. Also add one
  line under the architecture section saying `apps/bridge` exists and imports nothing from the
  apps.
- Modify: `docs/superpowers/specs/2026-10-19-delivery-bridge-design.md`. Change "Transport" to
  "JSON with base64 file contents, one HMAC over the exact body", and add the destination-fields
  note.
- Create: `apps/bridge/README.md`, covering what the bridge is, how to run it with
  `npm run dev:bridge`, its env vars, and the conformance image.
- Test: `apps/bridge/test/server-wiring.test.ts`. `buildFromConfig(config, { pool })`, factored
  out of `server.ts`, returns an app whose `/readyz` is 200 when the pool answers `SELECT 1`. It
  uses a stub pool.

- [ ] **Step 1: Write the failing test.** The test above.
- [ ] **Step 2: Run it and see it fail.** Expected: FAIL.
- [ ] **Step 3: Implement** `server.ts`, `buildFromConfig`, both Dockerfiles, the CI change and the
  docs.
- [ ] **Step 4: Verify.**
  - `npm run check` passes.
  - `docker build -f deploy/docker/bridge.Dockerfile .` succeeds.
  - With a throwaway Postgres: `DATABASE_URL=… BRIDGE_CLIENT_KEY=$(openssl rand -hex 32) npm run dev:bridge`,
    then `curl localhost:3100/readyz` gives `{"status":"ready"}`.
- [ ] **Step 5: Commit.** `git commit -m "bridge: server entry, images, release assets and docs"`

---

## Done when (spec phase 1 row)

- The conformance suite passes against the fake sink (Task 14).
- `npm run check` is green.
- The opt-in Pg integration tests pass against a throwaway database.
