# Delivery bridge, phase 2: S3 behind the bridge — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every S3 publication goes through the bridge. Behaviour stays as it is today, with the
same object keys:

- auto-publish;
- approve-and-publish;
- republish;
- withdraw;
- Results and zip read-back;
- Test connection;
- S3 read keys;
- the `default` target.

CT Studio no longer holds any target secret. Admins manage S3 credentials as shared connections
on the bridge's own connections page.

**Architecture:**

- **The bridge** gains a built-in `s3` sink, `bridge.connections` (shared connections, encrypted
  under `BRIDGE_SECRETS_KEY`), synchronous S3 object routes for targets, an S3 package store, and
  a minimal server-rendered connections page. The page is reached through a one-time handoff code
  that CT Studio mints.
- **The worker** builds a package from the outputs it already renders, then submits it through a
  Python bridge client. The job then waits in a new `delivering` status.
- **CT Studio's API** receives the bridge's signed events, finalises jobs, mirrors its target
  registry to the bridge, and reads published files back through the bridge.

**Tech stack:** as in phase 1, plus Python (httpx, Pydantic v2, mypy strict) in the worker, and
`@aws-sdk/client-s3` in the bridge.

**Spec:** [docs/superpowers/specs/2026-10-19-delivery-bridge-design.md](../specs/2026-10-19-delivery-bridge-design.md),
the phase 2 row. **Builds on:** [phase 1 plan](2026-10-19-delivery-bridge-1-contract-and-skeleton.md),
whose names (packages, routes, schemas, ports, statuses) this plan uses unchanged.

## Global constraints

- Everything in phase 1's Global constraints still applies.
- **Object keys don't move.** A published object's bucket and key are byte-for-byte what they are
  today: `{prefix}{spec}/v{ver}/{output}/{doc}.{fmt}` and
  `{prefix}graphs/{sha256}/{template}/v{n}.ttl`.
- **No target secret in CT Studio.** No plaintext or encrypted target secret is stored in CT
  Studio tables, sent by its web client, or accepted by its API once Task 9 lands. The
  `secret_key_enc` values are moved, then nulled (spec, anti-goals).
- **Same contract on both sides.** Python and TypeScript change together. Every cross-language
  shape gets a fixture under `packages/bridge-contract/test/fixtures/` that the worker tests also
  read, and a row in CLAUDE.md's contracts table.
- **Tests stay offline.** The bridge's S3 sink is tested with a `MemoryObjectStore`-style fake
  behind its own `ObjectStorePort`. The worker uses an `httpx.MockTransport`, and the API uses a
  fake bridge client.
- **Operator access.** Operators can't reach any new CT Studio route; `operatorMayCall` stays
  closed. The bridge-facing routes in CT Studio's API (`/api/bridge/*`) authenticate by signature,
  not by session.
- **Upgrades change nothing visible.** A deployment upgrading with targets, read keys and recipes
  in place keeps delivering to the same buckets and keys with no admin action. The one new thing
  is that external credentials are now managed on the connections page.

## Decisions this plan makes (within "left to the builder", recorded in the spec by Task 16)

- **CT Studio keeps `publish_targets` for now, as its recipient registry.** It holds id, label,
  kind, bucket and prefix, and keeps its usage, locking, read-key grants and backup copy rules.
  It is **mirrored** to `bridge.targets` on every write, and reconciled at API start. The bridge
  is authoritative for the sink, destination and connection. Merging the two into one registry is
  left to phase 4. This keeps the many foreign keys to `publish_targets` (`job_outputs`,
  `published_graphs`, `published_graph_versions`, `s3_consumer_targets`) untouched.
- **Read-back and withdraw use target object routes**, not per-delivery routes. These are
  `POST /v1/targets/{id}/objects:read|put|delete` with `{ bucket, key }`. The bridge refuses a
  bucket that isn't the target's bucket, or a key outside its prefix. This keeps outputs delivered
  before the bridge readable and withdrawable, since they have no delivery id. Only sinks with
  `readBack` or `withdraw` support these routes.
- **The graph's versioned Turtle copy is written synchronously in phase 2.** `objects:put` is
  called inside the graph registry's lock, exactly where `target.store.put` is today. Fuseki
  stays a direct worker call until phase 3, which moves both into the package.
- **The worker uses hand-written Pydantic models**, not generated ones. This follows the repo's
  existing cross-language pattern. Shared fixtures keep the two sides equal.
- **A new job status, `delivering`.** The job is in this status after the package is accepted,
  and until every delivery is terminal. Delivering jobs can't be cancelled: the bridge owns them.
- **A delivery that ends `needs_user` puts the job back in `awaiting_review`.** The review reason
  is `<target label>: <message>`. Approving re-queues `publish` as today, and the idempotency key
  makes the re-delivery safe.

## Review focus

1. **An upgrade with an external target whose keys come from `.env`** (`access_key_env`) must keep
   delivering. The move turns those env names into a bridge connection that reads the same env
   vars in the bridge container. → Task 8 test "env-keyed default target becomes an env
   connection".
2. **Events arriving twice, out of order, or after a reconcile poll already finalised the job**
   must not move the job backwards or finalise it twice. → Task 11 tests on `last_sequence` and
   terminal states.
3. **A withdraw for an output delivered before the bridge existed** (no delivery id) must still
   delete it. → Task 12 test.
4. **A restore from another deployment's backup** must keep the live deployment's connections.
   Their ciphertexts are under the live `BRIDGE_SECRETS_KEY`. The restored bridge targets must be
   re-mirrored from the restored `publish_targets`. → Task 15 tests.
5. **A bridge that is down when the worker submits** must give a retried job, not a needs-review
   job, and the outputs must not be recorded as published. → Task 6 test "connection refused is
   retryable and records nothing".

---

### Task 1: Bridge secrets and the connections store

**Files:**
- Create: `apps/bridge/src/secrets.ts`
- Create: `apps/bridge/src/connections/repo.ts` (port and memory implementation) and
  `apps/bridge/src/connections/pg.ts`
- Create: `db/bridge-migrations/202610201000_connections.sql`
- Modify: `apps/bridge/src/config.ts`. Add `BRIDGE_SECRETS_KEY` (required, same format as
  `LLM_SECRETS_KEY`, parsed by `parseMasterKey`) and `BRIDGE_SECRETS_KEY_PREVIOUS` (optional).
- Test: `apps/bridge/test/secrets.test.ts`, `apps/bridge/test/connections-contract.ts`,
  `apps/bridge/test/connections-repo.test.ts`, `apps/bridge/test/integration/connections-pg.test.ts`

**Interfaces:**
- `secrets.ts` uses the same algorithm and format as `apps/api/src/llm/secrets.ts`: AES-256-GCM,
  `v1:` + base64(nonce12 | ciphertext | tag16). It is copied, not imported. It produces:
  - `parseMasterKey`
  - `encryptSecret(plaintext: string, keys: SecretsKeys): string`
  - `decryptSecret(stored: string, keys: SecretsKeys): string`

  Its test decrypts `packages/shared/test/fixtures/llm-secret.json`, so the formats are proven
  identical.
- The SQL creates, in `bridge`:
  - `connections (id text PK CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'), kind text NOT NULL CHECK (kind IN ('shared','personal')), owner text, sink_id text NOT NULL, instance_id text, name text NOT NULL, fields jsonb NOT NULL DEFAULT '{}', secret_enc text, secret_env text, status text NOT NULL DEFAULT 'untested' CHECK (status IN ('ok','needs_attention','untested')), status_reason text, last_used_at timestamptz, created_at …, updated_at …, CHECK (kind = 'personal') = (owner IS NOT NULL))`
  - `ALTER TABLE targets ADD COLUMN connection_id text REFERENCES connections(id)`

  `fields` holds the non-secret credential fields. Exactly one secret field per S3 connection is
  stored as `secret_enc`, or read from the env var named by `secret_env`, which must be in
  `CREDENTIAL_ENV_NAMES`.
- The port:

```ts
export interface Connection { id: string; kind: 'shared' | 'personal'; owner: string | null; sinkId: string; instanceId: string | null;
  name: string; fields: Record<string, string>; secretSet: boolean; secretEnv: string | null; status: 'ok' | 'needs_attention' | 'untested';
  statusReason: string | null; lastUsedAt: Date | null }
export interface ConnectionRepo {
  list(filter: { kind?: 'shared' | 'personal'; owner?: string }): Promise<Connection[]>;
  get(id: string): Promise<Connection | null>;
  put(c: Omit<Connection, 'secretSet' | 'lastUsedAt'> & { secretEnc?: string | null }): Promise<void>;  // secretEnc undefined = keep stored
  remove(id: string): Promise<'deleted' | 'missing' | 'in_use'>;   // in_use: a target names it
  secretOf(id: string): Promise<{ secretEnc: string | null; secretEnv: string | null } | null>;
  mark(id: string, status: Connection['status'], reason: string | null, usedAt?: Date): Promise<void>;
}
```

  `CREDENTIAL_ENV_NAMES` is the same allowlist as `apps/api/src/publish-targets/stores.ts` L28,
  copied, with a test asserting the two lists are equal by reading both source files.

- [ ] **Step 1: Write the failing tests.**
  - Secrets: decrypts the shared fixture's `ciphertext` and `previousCiphertext`; encrypting then
    decrypting returns the input.
  - Contract:
    - "put then get hides the secret (`secretSet` only)";
    - "put without `secretEnc` keeps the stored secret";
    - "remove refuses a connection a target names";
    - "personal needs an owner, shared refuses one" (the database CHECK, and the same rule
      enforced in memory);
    - "mark records status, reason and last used".
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run --project bridge`. Expected:
  FAIL.
- [ ] **Step 3: Implement** the files and the migration.
- [ ] **Step 4: Run them again.** Expected: PASS, and the Pg test passes with
  `IH_TEST_DATABASE_URL`.
- [ ] **Step 5: Commit.** `git commit -m "bridge: encrypted shared connections"`

### Task 2: S3 object port, S3 package store, and the built-in `s3` sink

**Files:**
- Create: `apps/bridge/src/s3/store.ts` (`ObjectStorePort`, `MemoryObjectStore`,
  `S3ObjectStore`)
- Create: `apps/bridge/src/packages/s3.ts` (`S3PackageStore implements PackageStore`, JSON at
  `packages/<id>.json` in bucket `BRIDGE_STAGING_BUCKET`)
- Create: `apps/bridge/src/sinks/s3.ts` (`S3Sink implements SinkPort` plus target object
  operations)
- Create: `apps/bridge/src/sinks/probe.ts`, ported from `apps/api/src/publish-targets/probe.ts`
  with the same steps and messages
- Modify: `apps/bridge/src/config.ts`. Add these bridge settings:
  - `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY` and `S3_SECRET_KEY`: the deployment's own
    SeaweedFS, for internal targets and staging;
  - `BRIDGE_STAGING_BUCKET` (default `ingest-bridge`).
- Test: `apps/bridge/test/s3-sink.test.ts`, `apps/bridge/test/probe.test.ts`

**Interfaces:**
- `ObjectStorePort` has the methods `put(bucket, key, body: Buffer, contentType)`,
  `get(bucket, key): Promise<Buffer | null>`, `delete(bucket, key)`, `ping(bucket)` and
  `ensureBucket(bucket)`.
- `S3ObjectStore` is constructed with
  `{ endpoint, region, accessKeyId, secretAccessKey, forcePathStyle, sse: 'none' | 'AES256' | 'aws:kms', kmsKeyId, storageClass }`.
  It uses `@aws-sdk/client-s3`, the same way the API's `S3ObjectStore` does.
- `S3Sink`:
  - **Built-in connection.** The sink's id is `'s3'`, and the built-in connection is id
    `internal`: a shared connection with no stored secret, which uses the bridge's own `S3_*`.
    Task 8 seeds it as a row so that targets can reference it.
  - **`describe()`.**
    - `connectionKind: 'shared'`;
    - `instances: []`, because an S3 connection carries its endpoint in its fields;
    - `credentialFields`: `endpoint`, `region`, `accessKeyId`, `secretAccessKey` (secret) and
      `forcePathStyle`;
    - `destinationFields`: `bucket` (fixed, browse) and `prefix` (fixed), plus fixed `sse`,
      `kmsKeyId` and `storageClass`;
    - `capabilities`:
      `{ browse: false, replace: true, withdraw: true, readBack: true, accepts: ['files'] }`.

    S3 browsing is left for phase 6, and `files` is the only part S3 accepts in phase 2.
  - **Building a store.** The sink holds a `StoreResolver` that builds an `ObjectStorePort` from a
    connection and the target's destination (sse, kms, storageClass), caching it per connection
    id and `updated_at`.
  - **`deliver(req)`.** For each file in `req.package.files`, it calls
    `put(destination.bucket, destination.prefix + file.name, Buffer.from(file.content, 'base64'), file.contentType)`.
    It returns `{ status: 'succeeded', receipt: { written: [{ kind: 'object', id: <key>, label: file.output, url: null }] } }`.
  - **Errors.** S3 errors map to contract errors:
    - access denied → `credential_rejected` (needs_user);
    - no such bucket → `content_rejected`, with `details.bucket`;
    - network or 5xx → `instance_unavailable` (retryable).
  - **`testConnection(req)`.** Runs `probe` under the destination's prefix, if one is given.
  - **Target object operations**, which are not part of `SinkPort`. Each refuses a bucket other
    than the target's, and a key that doesn't start with the target's prefix, with
    `content_rejected`. They are:
    - `readObject(target, bucket, key): Promise<Buffer | null>`
    - `putObject(target, bucket, key, body, contentType)`
    - `deleteObject(target, bucket, key)`

- [ ] **Step 1: Write the failing tests.**
  - "delivers every file at prefix + name with its content type". Use a memory store, and assert
    `objects.get('pub', 'out/demo/v1/fields/doc1.csv')` is the decoded bytes with
    `text/csv; charset=utf-8`.
  - "maps AccessDenied to `credential_rejected`, NoSuchBucket to `content_rejected`, ECONNREFUSED
    to `instance_unavailable`". Use a store fake that throws the AWS SDK error names.
  - "refuses object operations outside the target's bucket or prefix".
  - "probe writes, reads and deletes under the prefix and names the failed step". Port the cases
    from `apps/api/test/publish-targets-routes.test.ts` that cover `probeTarget`.
  - "S3PackageStore round-trips a package".
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the files.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: built-in s3 sink and S3 package staging"`

### Task 3: Runner passes shared credentials; target admin and object routes

**Files:**
- Modify: `apps/bridge/src/deliveries/runner.ts`. Resolve `target.connectionId` to a credential
  through `ConnectionRepo` and the secrets, and pass it to `deliver`. When the error is
  `credential_rejected` or `credential_mfa_required`, call
  `connections.mark(id, 'needs_attention', message)`. On success, mark it `ok` with `usedAt`.
- Create: `apps/bridge/src/routes/targets.ts`
- Test: `apps/bridge/test/targets-routes.test.ts`, plus new runner cases

**Interfaces:**
- `PUT /v1/targets/:id` (signed) takes
  `{ label, sinkId, instanceId, connectionId, destination }`. It is an upsert, and returns 200
  with a `TargetView`. It refuses with 422 when:
  - the sink is unknown;
  - the connection is missing or belongs to another sink;
  - a required destination field is missing.
- `DELETE /v1/targets/:id` returns 204, or 409 when deliveries reference the target.
- `POST /v1/targets/:id/objects:read` takes `{ bucket, key }` and returns
  `{ content: base64 } | 404`.
- `POST /v1/targets/:id/objects:put` takes `{ bucket, key, contentType, content: base64 }` and
  returns 204.
- `POST /v1/targets/:id/objects:delete` takes `{ objects: { bucket, key }[] }` and returns
  `{ deleted: number }`. A missing object counts as deleted.
- `POST /v1/targets/:id:test`, and `POST /v1/targets:test` for unsaved settings
  (`{ connectionId, destination }`), both return
  `{ ok, step: 'connect' | 'write' | 'read' | 'delete' | null, message }`. That is the shape of
  `TargetTestResultSchema` in `@ih/shared`; the bridge redefines it in `@ih/bridge-contract` as
  `TargetTestResultSchema`, and a fixture keeps the two equal.
- The object routes answer 405, with `unsupported_part`, for a sink without `readBack` or
  `withdraw`.

- [ ] **Step 1: Write the failing tests.**
  - Routes: upsert and read back; the 422 cases; 409 on delete when in use; read, put and delete
    round trip against a memory S3; prefix escape gives 422.
  - Runner: "passes the connection's decrypted secret as the credential"; "a rejected credential
    marks the connection needs_attention".
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the changes.
- [ ] **Step 4: Run them again.** Expected: PASS. Then regenerate and commit
  `apps/bridge/openapi.json`.
- [ ] **Step 5: Commit.** `git commit -m "bridge: target admin, object routes and connection credentials"`

### Task 4: Handoff and the connections page (shared slice)

**Files:**
- Create: `apps/bridge/src/page/session.ts` (signed session cookie, CSRF token),
  `apps/bridge/src/page/routes.ts` and `apps/bridge/src/page/html.ts` (server-rendered templates,
  no client JS)
- Create: `apps/bridge/src/producer/client.ts` (`ProducerClient`: signed calls back to CT Studio)
- Modify: `apps/bridge/src/config.ts`. Add:
  - `BRIDGE_PRODUCER_URL`: CT Studio's API base, for example `http://api:3000/api`;
  - `BRIDGE_PUBLIC_URL`: the page's origin and path, for example `https://bridge.example.com` or
    `https://ct.example.com/bridge`;
  - `BRIDGE_COOKIE_SECURE` (default `true`).
- Test: `apps/bridge/test/page.test.ts`

**Interfaces:**
- `ProducerClient.redeem(code: string): Promise<ActingUser & { role: 'admin' | 'designer' | 'operator' }>`. It calls the signed `POST {BRIDGE_PRODUCER_URL}/bridge/handoff/redeem` with `{ code }` (Task 10 adds that route).
- The page routes are unsigned and use the page session:
  - **`GET /connections/start?code=…`** redeems the code, then sets `bridge_session`, which is
    `HttpOnly`, `SameSite=Lax`, `Path=/` under `BRIDGE_PUBLIC_URL`'s path, `Secure` when
    `BRIDGE_COOKIE_SECURE` is set, and lasts 30 minutes. It holds the user, the role and a CSRF
    token, HMAC-signed with `BRIDGE_CLIENT_KEY`. It then answers 303 to `/connections`. A bad or
    used code gives 401 with a plain page saying "This link has expired. Open Connections again
    from CT Studio."
  - **`GET /connections`** lists the shared connections for admins (name, sink, endpoint, status,
    last used, "Secret stored" or "Keys from <ENV>"). For non-admins in phase 2 it shows "Personal
    connections arrive later".
  - **`POST /connections`** (admin, CSRF) creates a connection. The form has `name`, `id` and the
    sink's credential fields. It runs `testConnection` first, and saves only on a pass, or when
    `saveUntested=on` is set.
  - **`POST /connections/:id`** (admin, CSRF) updates a connection. A blank secret keeps the
    stored one.
  - **`POST /connections/:id/test`** (admin, CSRF).
  - **`POST /connections/:id/delete`** (admin, CSRF). A connection in use gives an inline error
    naming the targets.
- Every page response carries `Content-Security-Policy: default-src 'self'; form-action 'self'; frame-ancestors 'none'`
  and `Cache-Control: no-store`. Secrets are never echoed back into the HTML.

- [ ] **Step 1: Write the failing tests.**
  - "start with a good code sets the session and redirects; a reused code is refused" (the stub
    `ProducerClient` is one-shot).
  - "a POST without a CSRF token is 403".
  - "non-admins cannot create shared connections".
  - "create runs the test and refuses to save a failing connection unless saveUntested".
  - "the secret is never in any response body".
  - "update with a blank secret keeps the stored one".
  - "responses carry the CSP and no-store headers".
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the page and the client.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: connections page for shared connections"`

### Task 5: Python contract models and signing

**Files:**
- Create: `worker/src/ingest_worker/bridge/__init__.py`, `bridge/models.py`,
  `bridge/signing.py`
- Create: `packages/bridge-contract/test/fixtures/signing.json`. It holds
  `{ key, method, path, timestamp, nonce, body, signature }`, produced by the TS `signRequest`
  and asserted by a new case in `packages/bridge-contract/test/signing.test.ts`.
- Test: `worker/tests/test_bridge_models.py`, `worker/tests/test_bridge_signing.py`

**Interfaces:**
- `models.py`: Pydantic v2 models mirroring phase 1's schemas field for field, with
  `model_config = ConfigDict(extra="forbid", populate_by_name=True)` and camelCase aliases. They
  are:
  - `ActingUser`, `Provenance`, `PackageFile`, `DataField`, `DataTable`, `PackageData`,
    `PackageRdf`, `BridgePackage`;
  - `CreateDeliveriesRequest`, `CreateDeliveriesResult`, `DeliveryView`;
  - `BridgeError`, `BridgeEvent`, `TargetTestResult`.
- `idempotency_key(source_sha256: str, recipe_id: str, recipe_version: int) -> str`
- `signing.py`: `sign_request(key: str, method: str, path: str, body: bytes, *, now: Callable[[], int] = …, nonce: Callable[[], str] = …) -> dict[str, str]`

- [ ] **Step 1: Write the failing tests.**
  - Each of `package-document.json`, `package-graph.json`, `delivery-request.json`,
    `delivery-view.json`, `event.json` and `error.json` validates and re-serialises
    (`model_dump(by_alias=True, mode="json")`) equal to the file.
  - `idempotency_key` matches the TS case values.
  - `sign_request` with the fixture's clock and nonce gives the fixture's `signature`.
- [ ] **Step 2: Run them and see them fail.** Run
  `uv run --directory worker pytest tests/test_bridge_models.py tests/test_bridge_signing.py`.
  Expected: FAIL.
- [ ] **Step 3: Implement** the modules.
- [ ] **Step 4: Run them again.** Expected: PASS. `npm run worker:lint` is clean (mypy strict).
- [ ] **Step 5: Commit.** `git commit -m "worker: bridge contract models and request signing"`

### Task 6: Worker bridge client

**Files:**
- Create: `worker/src/ingest_worker/bridge/client.py`
- Modify: `worker/src/ingest_worker/config.py`. Add `bridge_url: str` (required: `BRIDGE_URL`)
  and `bridge_client_key: str` (required: `BRIDGE_CLIENT_KEY`) to `Settings`. Remove the unused
  `target_*` fields (`config.py` L31-36, L74-79), and update `tests/test_config.py`.
- Test: `worker/tests/test_bridge_client.py`

**Interfaces:**

```python
class BridgeUnavailable(Exception): ...            # retryable: connection refused, timeout, 5xx, 503 retryable class
class BridgeRefused(DocumentError):                 # needs_user: 4xx with a needs_user BridgeError
    def __init__(self, error: BridgeError) -> None: ...   # message = error.message; .error kept
class BridgeClient(Protocol):
    def deliver(self, request: CreateDeliveriesRequest) -> CreateDeliveriesResult: ...
    def read_object(self, target_id: str, bucket: str, key: str) -> bytes | None: ...
    def put_object(self, target_id: str, bucket: str, key: str, body: bytes, content_type: str) -> None: ...
    def delete_objects(self, target_id: str, objects: list[tuple[str, str]]) -> int: ...
class HttpBridgeClient:  # implements BridgeClient
    def __init__(self, base_url: str, key: str, *, transport: httpx.BaseTransport | None = None, timeout: float = 60.0) -> None: ...
```

  Every request is signed with `sign_request` over the exact JSON bytes it sends. `FakeBridge`
  goes in `worker/tests/fakes.py`. It implements `BridgeClient` over a dict of S3 objects, and
  records `.requests: list[CreateDeliveriesRequest]`. Scripted refusals take a `BridgeError`.

- [ ] **Step 1: Write the failing tests**, using `httpx.MockTransport`:
  - "deliver signs the request and parses the 202";
  - "a needs_user 422 raises BridgeRefused carrying the error";
  - "connection refused, a timeout or a 503 raise BridgeUnavailable" (Review focus 5);
  - "read_object returns None on 404";
  - "delete_objects returns the count".
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the client and `FakeBridge`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "worker: signed bridge client"`

### Task 7: Worker builds packages and delivers through the bridge

**Files:**
- Create: `worker/src/ingest_worker/bridge/package.py`
- Modify: `worker/src/ingest_worker/pipeline.py`:
  - `Target` loses `store`, and becomes `Target(id, bucket, prefix)`;
  - `PipelineDeps` gains `bridge: BridgeClient | None = None`;
  - `publish_outputs` is replaced by `deliver_outputs`.
- Modify: `worker/src/ingest_worker/publish_targets.py`. `LiveTargets` now builds metadata-only
  `Target`s, so `_store_of`, `S3Settings`, `StoreFactory` and the decryption all go. It still
  raises `TargetMissing`.
- Modify: `worker/src/ingest_worker/main.py` L110-128 and L203-211, and
  `worker/src/ingest_worker/template_pipeline.py` L306-312 and L317-368.
- Modify: `worker/src/ingest_worker/queue.py`:
  - `JobQueue` and `PgJobQueue` gain `delivering(job, outputs, outputs_bucket, deliveries: list[tuple[str, str]]) -> None`,
    where each tuple is (target id, delivery id);
  - `record_published` gains `delivery_id: str | None`.
- Create: `db/migrations/202610201100_job_deliveries.sql`. It contains:
  - `ALTER TYPE job_status ADD VALUE 'delivering'`;
  - `ALTER TABLE job_outputs ADD COLUMN delivery_id uuid`;
  - `CREATE TABLE job_deliveries (delivery_id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs ON DELETE CASCADE, target_id text NOT NULL REFERENCES publish_targets(id), status text NOT NULL, error jsonb, receipt jsonb, last_sequence int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`;
  - `CREATE INDEX job_deliveries_job ON job_deliveries (job_id)`.
- Modify: `packages/shared/src/jobs.ts`. Add `'delivering'` to `JOB_STATUSES`, and update the
  shared and web places that switch on status (the TypeScript compiler lists them).
- Test: `worker/tests/test_bridge_package.py`, and updates to `test_template_pipeline.py`,
  `test_review.py`, `test_main.py` and `test_queue_integration.py`

**Interfaces:**
- `build_package(*, job: ClaimedJob, template: Template, document: dict[str, Any], outputs: list[RenderedOutput], approver: ActingUser | None, deployment: str) -> BridgePackage`:
  - `kind='document'`;
  - `files`: one per output, with `name = o.key`, which is today's unprefixed key;
  - `output = o.output_id`;
  - `contentType = content_type(o.format)`;
  - `data` from `document["fields"]` and `document["tables"]`;
  - `provenance` from the job and `document`: `sourceSha256` is the document's sha256 and
    `publishedAt = document["published_at"]`. If `ClaimedJob` doesn't carry the document's sha256
    and `created_by_user`/`created_by` yet, add them to `CLAIM_SQL`'s `RETURNING`/join and to the
    dataclass in this task.
  - `naming = {}`;
  - `rdf = narrative = images = None`.
- `acting_user_for(job: ClaimedJob, queue: JobQueue) -> ActingUser | None`: the reviewer when the
  job was reviewed, otherwise the uploader (`jobs.created_by_user`, `created_by`), otherwise
  `None`. The precedence is the spec's.
- `deliver_outputs(deps: PipelineDeps, job: ClaimedJob, package: BridgePackage, target: Target, acting: ActingUser | None) -> tuple[list[RenderedOutput], str]`:
  - It calls `deps.bridge.deliver(CreateDeliveriesRequest(targets=[target.id], actingUser=acting, package=package))`.
  - It returns the outputs re-keyed with `target.prefix` (as `publish_outputs` did), and the
    delivery id.
  - `BridgeRefused` and `BridgeUnavailable` propagate. The first is a `DocumentError`, so the job
    goes to review. The second is a plain exception, so the job is retried.
- **Auto-publish branch** (`main.py`): `deliver_outputs`, then `queue.record_published(job, published, target, delivery_id)`, then the graph as before, then
  `queue.delivering(job, result.outputs, deps.buckets.outputs, [(target.id, delivery_id)])` in
  place of `queue.complete`.
- **Publish task** (`main.py` L112-128): likewise, `queue.delivering` replaces `queue.complete`.
- **`publish_graph`'s copy**: `deps.bridge.put_object(target.id, target.bucket, target.prefix + graph_version_key(...), body, "text/turtle")`
  replaces `target.store.put(...)`, at the same place inside `registry.publish`'s `write`.

- [ ] **Step 1: Write the failing tests.**
  - `test_bridge_package.py`: a document with two fields and one table gives a package that
    validates, with `files[*].name` equal to today's `output_key(...)` values. The package's
    `idempotencyKey` is `idempotency_key(<document sha256>, template.id, template.version)`.
  - Update `test_template_pipeline.py`'s publish cases to use `FakeBridge`. The fake records one
    request naming the recipe's target. Every file key, joined with the prefix, equals the key the
    old test asserted. `FakeQueue.delivering` is called instead of `complete`.
  - "a refused delivery (`target_missing`) sends the job to review with the bridge's message".
  - "connection refused is retryable and records nothing". `FakeBridge` raises
    `BridgeUnavailable`, then `FakeQueue.published == []` and `failed` is set (Review focus 5).
  - "the graph copy goes through put_object at today's key".
  - "auto-published jobs act as the uploader; reviewed ones as the reviewer".
- [ ] **Step 2: Run them and see them fail.** Run `npm run worker:test`. Expected: FAIL in the new
  and changed cases.
- [ ] **Step 3: Implement** the changes. Then wire `HttpBridgeClient(settings.bridge_url, settings.bridge_client_key)`
  into `_Worker.__init__` (`main.py` L321-423), and remove `S3Settings` from there and from
  `rdf_rebuild.py` L402-425.
- [ ] **Step 4: Run them again.** `npm run worker:test` and `npm run worker:lint` pass.
  `npm test` passes, because the shared `delivering` status compiles across the web code.
- [ ] **Step 5: Commit.** `git commit -m "worker: deliver published outputs through the bridge"`

### Task 8: Moving targets and secrets to the bridge (mirror plus one-off move)

**Files:**
- Create: `apps/api/src/bridge/client.ts`. This is `BridgeApi`, the CT Studio API's signed client.
  It imports `signRequest` and the schemas from `@ih/bridge-contract`.
- Create: `apps/api/src/bridge/mirror.ts`
- Create: `db/migrations/202610201200_targets_moved.sql`, adding
  `ALTER TABLE publish_targets ADD COLUMN moved_to_bridge_at timestamptz, ADD COLUMN connection_id text`
- Modify: `apps/api/src/config.ts` (`BRIDGE_URL` and `BRIDGE_CLIENT_KEY`, both required),
  `apps/api/src/app.ts` (`AppDeps.bridge: BridgeApi`), `apps/api/src/server.ts` (call
  `moveTargetsToBridge` once at start, after `targets.seedDefault`), and `apps/api/test/helpers.ts`
  (`FakeBridgeApi`)
- Test: `apps/api/test/bridge-mirror.test.ts`

**Interfaces:**

```ts
export interface BridgeApi {
  putTarget(id: string, t: { label: string; sinkId: 's3'; instanceId: null; connectionId: string; destination: Record<string, string> }): Promise<void>;
  deleteTarget(id: string): Promise<'deleted' | 'in_use'>;
  putSharedConnection(c: { id: string; name: string; fields: Record<string, string>; secret: string | null; secretEnv: string | null }): Promise<void>; // used only by the move
  listConnections(kind: 'shared'): Promise<ConnectionSummary[]>;
  testTarget(id: string): Promise<TargetTestResult>;
  testSettings(s: { connectionId: string; destination: Record<string, string> }): Promise<TargetTestResult>;
  readObject(targetId: string, bucket: string, key: string): Promise<Buffer | null>;
  getDelivery(id: string): Promise<DeliveryView | null>;
}
export function destinationOf(t: TargetRecord): Record<string, string>; // bucket, prefix, sse, kmsKeyId ('' when null), storageClass ('' when null)
export function connectionIdOf(t: TargetRecord): string;               // 'internal' for internal targets, else `target-${t.id}`
/** Pushes every target row to the bridge (idempotent). */
export async function mirrorTargets(deps: { targets: PublishTargetRepo; bridge: BridgeApi }): Promise<number>;
/** One-off per row: an external target's credentials become a shared connection, then the row's secret_key_enc is nulled and moved_to_bridge_at set. */
export async function moveTargetsToBridge(deps: { targets: PublishTargetRepo; bridge: BridgeApi; secrets: SecretsKeys | null; log: FastifyBaseLogger }): Promise<{ moved: string[]; skipped: string[] }>;
```

- **The move.** For each external row that isn't yet moved, it creates or updates the shared
  connection `target-<id>`:
  - name: the target's label;
  - fields: `{ endpoint, region, accessKeyId, forcePathStyle }`;
  - secret: `decryptSecret(secret_key_enc)`, **or** `secretEnv = secret_key_env` when the row's
    keys come from env, with `fields.accessKeyIdEnv = access_key_env`.

  It then puts the target with `connectionId`. When neither a secret nor an env name exists, the
  row is skipped and a warning logged; the target then fails delivery with `credential_missing`,
  which is visible.
- **Internal rows** are only mirrored, with `connectionId: 'internal'`.
- **The bridge seeds `internal`.** It upserts the `internal` connection row (`fields: {}`, no
  secret) at start, in `apps/bridge/src/server.ts`.
- **Repo additions.** `PublishTargetRepo` gains `markMoved(id, connectionId)` and
  `connectionOf(id)`, in the memory implementation, the Pg implementation and the contract.

- [ ] **Step 1: Write the failing tests.**
  - "mirrors internal targets with the internal connection".
  - "moves an external target's decrypted secret into a shared connection and nulls the row's
    ciphertext".
  - "env-keyed default target becomes an env connection" (Review focus 1). This is
    `TARGET_S3_*` external with `accessKeyEnv` and `secretKeyEnv` set; the fake bridge receives
    `secretEnv: 'TARGET_S3_SECRET_KEY'` and `fields.accessKeyIdEnv`.
  - "is idempotent: a second run moves nothing".
  - "skips and logs a row it cannot decrypt, leaving it unmoved".
  - Contract additions for `markMoved` and `connectionOf`.
- [ ] **Step 2: Run them and see them fail.** Run
  `npx vitest run --project api test/bridge-mirror.test.ts test/publish-targets-repo.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement** the changes. The bridge's `S3Sink` reads `fields.accessKeyIdEnv` and
  `secretEnv` from its process env, restricted to `CREDENTIAL_ENV_NAMES`. Add that case to
  Task 2's sink tests in this commit.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "api: mirror targets to the bridge and move their secrets"`

### Task 9: Published outputs admin without secrets

**Files:**
- Modify: `packages/shared/src/publish-targets.ts`:
  - `TargetCreateBodySchema` and `TargetPatchBodySchema`: drop `accessKeyId`,
    `secretAccessKey`, `endpoint`, `region` and `forcePathStyle`, and add `connectionId`
    (required for external);
  - `PublishTargetViewSchema`: replace `accessKeyId`, `secretSet` and `keysFromEnv` with
    `connection: { id, name, status } | null`;
  - `TargetTestBodySchema` becomes `{ id } | { connectionId, bucket, prefix, sse, kmsKeyId, storageClass }`.

  Update `packages/shared/test/publish-targets.test.ts` and the fixture.
- Modify: `apps/api/src/routes/publish-targets.ts`:
  - the create and patch routes write the row and then `bridge.putTarget` (as one unit: if the
    bridge refuses, the row write is rolled back, through `repo.remove` or the previous value);
  - delete calls `bridge.deleteTarget`;
  - test calls `bridge.testTarget` or `bridge.testSettings`;
  - `encryptSecret`, `PAIR`, `PRESENT` and `NO_SECRETS` are deleted;
  - `ownBucketProblem` and `ensureBucket` stay for internal targets.
- Create: `GET /api/publish-targets/connections` (admin), which proxies
  `bridge.listConnections('shared')`.
- Modify: `apps/api/src/publish-targets/stores.ts`. `TargetStores` is reduced to
  `ensureBucket(target)` for internal targets. The read side moves in Task 12.
- Modify: `apps/web/src/access/AddTargetDialog.tsx` and `TargetRow.tsx`:
  - the external fields become a **Connection** select, from the new route, with its status;
  - the encryption and storage class fields stay;
  - the credential fields are deleted.

  The "Manage connections" button comes in Task 10, with the handoff it needs.
- Modify: `apps/web/src/api/client.ts` (`listSharedConnections`) and `apps/web/test/fake-api.ts`.
- Modify: `apps/web/src/help/PublishedOutputsHelp.tsx`, to say where credentials now live.
- Test: update `apps/api/test/publish-targets-routes.test.ts`,
  `apps/web/test/PublishedOutputsPage.test.tsx` and `apps/web/test/client.test.ts`, then run
  `npm run openapi` and commit `docs/openapi.json`.

**Interfaces:**
- `ConnectionSummarySchema` in `@ih/bridge-contract` is `{ id, name, sinkId, status, statusReason }`.
  It is a new export, with a fixture.

- [ ] **Step 1: Write the failing tests.**
  - "create external with a connectionId mirrors to the bridge and stores no secret column".
  - "a body carrying secretAccessKey is 400" (strict schema).
  - "bridge refusal leaves no row behind".
  - "test proxies to the bridge and returns its step and message".
  - Web: "the external form shows a connection picker and no secret field".
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the changes.
- [ ] **Step 4: Run them again.** `npm test` passes, and the openapi snapshot is updated.
- [ ] **Step 5: Commit.** `git commit -m "Published outputs: credentials live on the bridge"`

### Task 10: Handoff codes and the `/api/bridge` inbound guard

**Files:**
- Create: `apps/api/src/bridge/guard.ts`. This verifies bridge-signed requests to `/api/bridge/*`
  with `verifyRequest` from `@ih/bridge-contract` and a `MemoryNonceStore`, and marks those
  routes `config.public = true` so the session hook skips them.
- Create: `apps/api/src/bridge/handoff.ts`. These are `HandoffCodes`: in-memory one-time codes,
  32 random bytes base64url, valid for 60 seconds and bound to the user. This is enough for the
  single API instance; ADR 0006 notes the API is single-instance.
- Create: `apps/api/src/routes/bridge.ts`
- Modify: `apps/api/src/config.ts` (`BRIDGE_PUBLIC_URL`, required) and
  `apps/api/src/openapi/document.ts` (a new tag `Bridge`, in a group)
- Modify: `apps/web/src/access/PublishedOutputsPage.tsx`. Add a "Manage connections" button in the
  header that calls `api.openConnections()`. That method, in `apps/web/src/api/client.ts` and
  `fake-api.ts`, calls `POST /api/bridge/connections-link`, then
  `window.open(url, '_blank', 'noopener')`. The Profile "Connections" summary comes in phase 5.
- Test: `apps/api/test/bridge-routes.test.ts`

**Interfaces:**
- `POST /api/bridge/connections-link` (session, admin in phase 2) returns
  `{ url: '<BRIDGE_PUBLIC_URL>/connections/start?code=<code>' }`. The web client opens it with
  `window.open(url, '_blank', 'noopener')`.
- `POST /api/bridge/handoff/redeem` (bridge-signed) takes `{ code }` and returns
  `{ id, name, email, role }`. An unknown, used or expired code gives 404.
- `POST /api/bridge/events` (bridge-signed) takes a `BridgeEvent` and returns 204. Task 11
  implements its effect.
- In the OpenAPI document, the bridge-signed routes carry `security: []` and the description
  "Signed by the bridge (x-bridge-signature)". The x-admin sweep treats them as not-session
  routes.

- [ ] **Step 1: Write the failing tests.**
  - "connections-link is admin-only and returns a URL under BRIDGE_PUBLIC_URL".
  - "redeem returns the user once; a second redeem is 404; after 61 s it is 404".
  - "an unsigned redeem is 401".
  - "operators get 403 on connections-link".
  - Web: "Manage connections opens the link in a new tab". This stubs `window.open` and asserts
    `'_blank'` and `'noopener'`.
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the changes.
- [ ] **Step 4: Run them again.** `npx vitest run --project api` passes, including
  `openapi.test.ts`.
- [ ] **Step 5: Commit.** `git commit -m "api: bridge handoff and signed inbound routes"`

### Task 11: Events finalise jobs; reconcile stragglers

**Files:**
- Create: `apps/api/src/bridge/events.ts`, `apps/api/src/bridge/reconcile.ts`
- Modify: `apps/api/src/repositories/types.ts` and the `pg.ts` and `memory.ts` implementations of
  `IngestionRepo`. Add the four `job_deliveries` methods described under Interfaces.
- Modify: `apps/api/src/server.ts` (start the reconcile loop every 60 s), and the web job views
  (`jobs/JobDetailPanel.tsx`: a "Delivering to <label>" line with each delivery's status, and the
  status chip for `delivering`)
- Test: `apps/api/test/bridge-events.test.ts`, `apps/api/test/integration/job-deliveries-pg.test.ts`

**Interfaces:**
- `applyEvent(deps: { repo: IngestionRepo; targets: PublishTargetRepo }, e: BridgeEvent): Promise<'applied' | 'stale' | 'unknown'>`:
  1. Update the `job_deliveries` row only when `e.sequence > last_sequence`. Otherwise the event
     is `stale`.
  2. If every delivery of the job is now terminal and the job is still `delivering`, finalise it:
     - all `succeeded` or `skipped` → job `succeeded`, with an event `delivered` listing the
       targets;
     - any `needs_user` → job `awaiting_review`, with `review_reasons` holding
       `<target label>: <message>` for each such delivery;
     - otherwise (any `failed`) → job `failed`, with `error = <target label>: <message>`.
  3. Every status update is guarded by `AND status = 'delivering'`, so finalising happens once.
- `IngestionRepo` additions:
  - `recordDeliveries(jobId, rows: { targetId; deliveryId }[])`. The worker writes these rows
    through `queue.delivering`; the API's version exists for tests and the reconcile.
  - `updateDelivery(deliveryId, { status, error, receipt, sequence }): Promise<boolean>`
  - `deliveriesOf(jobId)`
  - `stragglers(olderThanMinutes: number): Promise<string[]>`
- `reconcileOnce(deps: { repo; bridge: BridgeApi; targets }, now: Date): Promise<number>`. For
  every non-terminal delivery not updated in the last 10 minutes, it fetches
  `bridge.getDelivery(id)` and applies it as a synthetic event with `sequence = last_sequence + 1`
  when the status differs.

- [ ] **Step 1: Write the failing tests.**
  - "one target succeeded finalises the job as succeeded".
  - "two targets: the job stays delivering until both are terminal".
  - "needs_user returns the job to awaiting_review with the target's label in the reason".
  - "a duplicate or older event is stale and changes nothing" (Review focus 2).
  - "an event after the job was finalised changes the delivery row only".
  - "reconcile applies a delivery the bridge finished but whose event was lost".
  - The Pg integration test: two concurrent `applyEvent` calls for the last two deliveries
    finalise the job exactly once.
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the changes.
- [ ] **Step 4: Run them again.** `npm test` passes, and the integration test passes with
  `IH_TEST_DATABASE_URL`.
- [ ] **Step 5: Commit.** `git commit -m "api: finalise delivering jobs from bridge events"`

### Task 12: Read-back, withdraw, republish and rebuild through the bridge

**Files:**
- Modify: `apps/api/src/storage/stage.ts`. `outputStore` and `readOutput` read published outputs
  with `deps.bridge.readObject(output.targetId ?? DEFAULT_TARGET_ID, output.bucket, output.key)`.
  A bridge error becomes `OutputUnavailableError('publishing target <label> unavailable')` as
  before, so `routes/results.ts` and `routes/jobs.ts` L474 are unchanged.
- Modify: `worker/src/ingest_worker/withdrawal.py`:
  - `run_withdraw` groups objects by target and calls
    `deps.bridge.delete_objects(target, [(bucket, key), …])`;
  - `_withdraw_graph` deletes the copy with `delete_objects` as well, and Fuseki stays direct;
  - `run_republish` builds a package and calls `deliver_outputs` and `put_object`, as Task 7
    does;
  - republish jobs then end in `delivering`.
- Modify: `worker/src/ingest_worker/rdf_rebuild.py` L231-256. Copies are read with
  `deps.bridge.read_object`.
- Test: update `worker/tests/test_withdrawal.py` (its 16 cases) and `test_rdf_rebuild.py` to use
  `FakeBridge`; update `apps/api/test/results.test.ts`, `jobs.test.ts` and `test/helpers.ts`
  (`FakeBridgeApi` with an object map).

- [ ] **Step 1: Write the failing tests.**
  - Existing cases, re-pointed at the fakes, assert the same keys.
  - New: "withdraw of an output delivered before the bridge (no delivery_id) deletes it through
    the target" (Review focus 3).
  - New: "the archive still fails rather than sending a partial zip when the bridge read fails".
    This is `results.test.ts` L429, re-pointed.
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the changes. Delete what's now unused:
  - the worker's `S3ObjectStore` use for targets;
  - the API's `TargetStores.storeFor` and `storeOf`;
  - `CREDENTIAL_ENV_NAMES` in the API, if nothing uses it any more.
- [ ] **Step 4: Run them again.** `npm run check` passes.
- [ ] **Step 5: Commit.** `git commit -m "Read-back, withdraw, republish and rebuild through the bridge"`

### Task 13: Recipe validation and S3 read keys keep working

**Files:**
- Modify: `apps/api/src/templates/definitions.ts` L122-132. The check is unchanged: it uses
  `deps.targets`, which is still the registry. Add one test that it still blocks an unknown target
  and passes a mirrored one.
- Modify: `apps/api/src/s3keys/service.ts`. No change; its internal-target listing still comes
  from `PublishTargetRepo.choices()`. Add one test that grants still resolve after a target is
  mirrored.
- Test: `apps/api/test/template-publish-target.test.ts` (new, small) and
  `apps/api/test/s3-keys.test.ts` (one added case)

- [ ] **Step 1: Write the two tests.**
- [ ] **Step 2: Run them.** Expected: PASS. These are guard tests that pin behaviour; if either
  fails, fix the regression in the task that caused it.
- [ ] **Step 3: Commit.** `git commit -m "Pin recipe target validation and S3 key grants across the move"`

### Task 14: Deploy, the bridge in compose

**Files:**
- Modify: `deploy/docker-compose.yml`:
  - **`migrate-bridge`**: the bridge image, running
    `node apps/bridge/dist/db/migrate-cli.js`, after postgres.
  - **`bridge`**:
    - image `${IMAGE_PREFIX}/bridge:${IMAGE_TAG}`;
    - env: `DATABASE_URL`, `*s3-env` (the internal S3 plus `TARGET_S3_*` for env-keyed
      connections), `BRIDGE_CLIENT_KEY`, `BRIDGE_SECRETS_KEY`, `BRIDGE_SECRETS_KEY_PREVIOUS`,
      `BRIDGE_EVENTS_URL=http://api:3000/api/bridge/events`,
      `BRIDGE_PRODUCER_URL=http://api:3000/api`, `BRIDGE_PUBLIC_URL`, `BRIDGE_STAGING_BUCKET`;
    - healthcheck on `/readyz`;
    - `restart: unless-stopped`;
    - no `ports:`;
    - depends on `migrate-bridge` and `init-buckets`.
  - **`api`** gets `BRIDGE_URL=http://bridge:3100`, `BRIDGE_CLIENT_KEY` and `BRIDGE_PUBLIC_URL`.
  - **`worker`** gets `BRIDGE_URL` and `BRIDGE_CLIENT_KEY`. It no longer needs `TARGET_S3_*`.
- Modify: `worker/src/ingest_worker/admin.py`. `init-buckets` creates `BRIDGE_STAGING_BUCKET`
  (default `ingest-bridge`).
- Modify: `deploy/docker/nginx.conf`. Add `location /bridge/ { proxy_pass http://bridge:3100/; }`,
  which is the path fallback, with the security headers. Document the subdomain alternative in
  `deploy/README.md`.
- Modify: `deploy/.env.example`. Add `BRIDGE_CLIENT_KEY`, `BRIDGE_SECRETS_KEY` and
  `BRIDGE_PUBLIC_URL`, each with a one-line generation hint (`openssl rand -base64 32`).
- Modify: `deploy/scripts/deploy.sh` and `.ps1`. Build the bridge image, and refuse to deploy
  without `BRIDGE_CLIENT_KEY` and `BRIDGE_SECRETS_KEY`, the same way `POSTGRES_PASSWORD` is
  checked.
- Modify: `.github/workflows/ci.yml` `stack` job (build the bridge image) and
  `deploy/scripts/smoke-test.sh`:
  1. Approve a job, and wait for the job status to become `succeeded`, not just "published".
  2. Check the published object exists at the same key as before.
  3. `curl -fsS <app>/bridge/connections/start?code=bad` gives 401.

- [ ] **Step 1: Extend the smoke test.** Running it against the current images fails because there
  is no bridge.
- [ ] **Step 2: Implement** the compose, nginx, env and script changes.
- [ ] **Step 3: Verify.** Run `deploy/scripts/deploy.sh` locally with a fresh `.env` from the
  example, then `deploy/scripts/smoke-test.sh`. Expected: PASS. A second deploy on the same
  volumes, the upgrade path, also passes the smoke test.
- [ ] **Step 4: Commit.** `git commit -m "deploy: run the bridge"`

### Task 15: Backup and restore cover the bridge

**Files:**
- Modify: `apps/api/src/backup/copy-rules.ts`:
  - `KEPT_TABLES` gains `bridge.connections`. This keeps the live deployment's connections, whose
    ciphertexts are under the live key.
  - After `replaceTargets`, `restoredTargetsNeedMirror` sets a flag so that the API runs
    `mirrorTargets` after the swap (`server.ts` L218, `onSwapped`).
  - `bridge.targets.connection_id` values naming connections absent from the live deployment are
    set to null; those targets then fail with `credential_missing`, visibly.
- Modify: `apps/api/src/backup/create.ts`. `internalTargetBuckets` also includes
  `BRIDGE_STAGING_BUCKET`.
- Modify: `docs/adr/0015-backup-and-restore.md`. Add an addendum saying that the bridge schema is
  in the dump, connections are kept from the live deployment, and `BRIDGE_SECRETS_KEY` must be
  kept with `LLM_SECRETS_KEY`.
- Test: `apps/api/test/backup-restore.test.ts` (cases added) and
  `apps/api/test/integration/backup-copy-rules.test.ts` (with the bridge schema migrated)

- [ ] **Step 1: Write the failing tests.**
  - "a restore keeps the live bridge connections, not the backup's" (Review focus 4).
  - "after a restore the restored targets are re-mirrored to the bridge" (`FakeBridgeApi` records
    `putTarget` for each).
  - "a restored target naming a connection the live deployment lacks loses its connection".
  - "the staging bucket is in the backup's bucket list".
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the changes.
- [ ] **Step 4: Run them again.** Expected: PASS, and the integration tests pass with
  `IH_TEST_DATABASE_URL`.
- [ ] **Step 5: Commit.** `git commit -m "backup: keep bridge connections and re-mirror restored targets"`

### Task 16: Docs, ADR and contracts table

**Files:**
- Create: `docs/adr/0016-delivery-bridge.md`. It covers the context, the decision (the bridge,
  the sink contract, shared connections on the bridge's page), and these consequences:
  - CT Studio holds no target secrets;
  - a new service and two keys;
  - the `publish_targets` mirror until phase 4.
- Modify: the CLAUDE.md contracts table. Fill in the Python cells for the package, the delivery
  request and result, the event and signing (`ingest_worker.bridge.models`, `signing`,
  `client`), and rewrite the publishing-targets row's Python cell (no stores; `Target(id, bucket, prefix)`;
  `deliver_outputs`; `queue.delivering`). Add a row for "Bridge signing" with
  `signing.json` as the fixture.
- Modify: `docs/architecture.md`. Update the services diagram and job lifecycle, which gains
  `delivering`.
- Modify: `docs/superpowers/specs/2026-10-19-delivery-bridge-design.md`. Record this plan's
  decisions:
  - the `publish_targets` mirror;
  - target object routes;
  - the synchronous graph copy in phase 2;
  - hand-written Pydantic;
  - `delivering`;
  - `needs_user` → `awaiting_review`.
- Modify: `deploy/README.md`. Cover the bridge service, the two keys, the connections page origin
  options, and that after upgrading, external S3 credentials are found under Connections.
- Create: release notes for this change, in `docs/release-notes/`, following the newest file's
  format.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Check them.** Run `npm run format:check`, and
  `rg -i "3dexperience|dassault|alloy" docs CLAUDE.md apps packages worker deploy`. Expected: no
  matches.
- [ ] **Step 3: Commit.** `git commit -m "docs: delivery bridge ADR, contracts and deploy notes"`

---

## Done when (spec phase 2 row)

- Every existing publishing test passes, as do the new tests, with S3 delivered through the
  bridge.
- The compose smoke test passes on a fresh deploy and on an upgrade.
- Object keys are unchanged.
- No target secret reaches CT Studio: its `publish_targets.secret_key_enc` is null for every
  moved row, and its API refuses secret fields.
