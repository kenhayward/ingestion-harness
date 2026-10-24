# Decomposition phase 2: contract version 2, the bridge, the register and the version check

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A decomposed document travels from the worker through the bridge to a sink as a contract
version 2 package. CT Studio's register decides whether each delivery creates a document, updates
one behind a version check, or is skipped or refused. This is proven end to end against a stateful
fake sink and the conformance suite.

**Architecture:**

- **The contract package (`@ih/bridge-contract` 0.8.0)** gains:
  - the decomposed document's zod schema, and its TypeScript comparison forms, which must reproduce
    phase 1's vectors;
  - a `document` package part;
  - a `decomposedDocuments` capability;
  - a conditional `update` on the deliver request;
  - a document receipt;
  - the error code `changed_in_target`.
- **The bridge** refuses a `document` package for any sink without that capability, carries
  `update` through to the sink, and upgrades version 1 packages for version 2 sinks.
- **The register** is a CT Studio table:
  - the worker reads it before delivering, using the two checks in spec §8;
  - the API updates it from the bridge's events;
  - its row lock keeps two deliveries for one document from running at once.

**Tech Stack:** TypeScript (zod, Fastify, vitest) in `packages/bridge-contract`, `apps/bridge` and
`apps/api`; Python 3.13 (Pydantic, psycopg, pytest) in `worker/`; Postgres migrations.

**Spec:** `docs/superpowers/specs/2026-10-23-document-decomposition-design.md`, §3 (outcomes), §8
(identity and re-runs) and §9 (contract changes). Phase 1's plan, for the model:
`docs/superpowers/plans/2026-10-23-decomposition-phase-1-word.md`.

## Global Constraints

- No vendor name of the first target system anywhere in this repository.
- Never `git add -A`; stage files by name. Before calling anything done, these must be green:
  `npm run check`, `npm run format:check`, `npm run worker:test` and `npm run worker:lint`. Ask the
  owner before pushing or opening a PR.
- **Version 1 sinks keep working unchanged** (spec §9). The bridge never sends a `document` part to
  one, and every existing fixture and test of version 1 still passes.
- A version 2 package is version 1 plus additions. A package with a `document` part carries only
  `document` and `images`, never `files`, `data`, `rdf` or `narrative`, and has decomposition
  provenance (spec §9).
- **Nothing a person changed in the target is overwritten.** A conditional update with any changed or
  missing component is refused with `changed_in_target` (class `needs_user`), and changes nothing
  (spec §8).
- `changed_in_target` details must fit the bridge's 4 KB details cap (`apps/bridge/src/sinks/http.ts`
  `bounded`). List at most 40 components and add `more: <count>`.
- Contract JSON is camelCase, everywhere, including the decomposed document (ruling R1).
- `@ih/bridge-contract` goes from 0.7.0 to **0.8.0**. The published fixtures in `test/fixtures` gain
  version 2 examples.
- Credentials never appear in fixtures, logs, URLs or errors.

## Rulings made while planning

- **R1, camelCase.** The decomposed document travels in camelCase like the rest of the contract
  (`rowSpan`, `captionPosition`). The phase 1 Pydantic models gain a camelCase alias generator, and
  the vectors are regenerated in camelCase. One case convention for sink authors beats a snake_case
  island. Cost: one regeneration.
- **R2, provenance.** Provenance is a union: the existing extraction shape, unchanged, or
  `{kind: "decomposition", ...}`. Version 1 packages are byte-identical to today's.
- **R3, `narrative`.** `narrative` stays in the schema, nullable, and must be null in version 2. That
  keeps one schema and leaves version 1 untouched. Spec §9 says "withdrawn", and this is its
  wire-compatible form.
- **R4, where `update` goes.** `update` rides on the producer's `CreateDeliveriesRequest`, allowed
  only with exactly one target, and is stored on the bridge's `deliveries` row (new column). The
  runner then passes it to `sink.deliver`.
- **R5, the register's key.** The register is keyed by the target's **sink id and instance id**, which
  is one tenant (spec §8). Two CT Studio targets pointing at the same tenant share entries.
- **R6, register writes.**
  - The worker writes the entry as `pending` before delivering, holding a row lock (`SELECT … FOR
    UPDATE`) over the decision.
  - The API's event handler moves it to `delivered`, `incomplete`, `changed` or `failed`.
  - An entry in `pending` refuses a second delivery: one at a time (spec §8).
- **R7, scope.** Detach and accept-target-state (spec §8 "Resolving a refused document") are phase
  3, with the Conversion tab. Phase 2 leaves an entry in state `changed`, which refuses until those
  actions exist.
- **R8, how a run is started.** Phase 2 adds no job type and no UI.
  `ingest_worker.decompose.deliver.deliver_decomposition(...)` is the entry point. Phase 3 calls it
  from batch jobs. A CLI wrapper lets the owner try it against the fake sink.

## Review Focus

1. **A retried create after a lost response.** The second request carries the same idempotency key.
   The fake sink returns the first document's receipt, and the register ends with one entry and one
   persistent id. Pinned in Task 4 (`same key returns the first document`) and Task 8
   (`test_retry_after_lost_response_keeps_one_document`).
2. **Two runs of the same source key at once.** The second is refused as "in flight". It never
   creates a second document. Pinned in Task 8 (`test_concurrent_delivery_is_refused`, which runs
   two transactions on the Pg store; integration-marked).
3. **A version 1 extraction package going to a version 2 sink.** It is delivered as version 2, with
   identical content and no `document` part. Pinned in Task 5 (`upgrades v1 packages for v2 sinks`).
4. **A `changed_in_target` refusal listing 500 changed components.** Its details stay under 4 KB and
   say how many more there are. Pinned in Task 4 (`changed details are capped`).
5. **A sink whose receipt has no `document` entry for a document delivery.** The API marks the entry
   `incomplete` and never guesses a persistent id. Pinned in Task 7
   (`receipt without document marks incomplete`).

## File structure

| Area | Files |
|---|---|
| Contract: decomposed document | `packages/bridge-contract/src/decomposed/model.ts` (zod), `src/decomposed/forms.ts` (comparison forms), `test/decomposed-forms.test.ts` |
| Contract: version 2 | `src/package.ts`, `src/sink-api.ts`, `src/producer-api.ts`, `src/errors.ts`, `src/idempotency.ts`, `test/fixtures/package-decomposed.json`, `test/fixtures/describe-v2.json`, `package.json` (0.8.0) |
| Conformance | `src/conformance/suite.ts`, `apps/bridge/test/conformance-fake.test.ts` |
| Fake document sink | `apps/bridge/src/sinks/fake-documents.ts`, `src/sinks/fake-server.ts` (a `documents` mode), `test/fake-documents.test.ts` |
| Bridge | `src/deliveries/accept.ts`, `src/deliveries/runner.ts`, `src/deliveries/repo.ts`, `src/deliveries/pg.ts`, `src/sinks/http.ts`, `db/bridge-migrations/202610231200_delivery_update.sql` |
| CT Studio DB and API | `db/migrations/202610231300_decomposition_register.sql`, `apps/api/src/bridge/register.ts`, `apps/api/src/bridge/events.ts`, `apps/api/src/repositories/pg.ts` |
| Worker | `worker/src/ingest_worker/decompose/model.py` (aliases), `worker/src/ingest_worker/bridge/models.py`, `worker/src/ingest_worker/decompose/register.py`, `worker/src/ingest_worker/decompose/deliver.py`, `worker/scripts/deliver_decomposition.py` |

---

### Task 1: camelCase decomposed document, and its zod schema and forms

**Files:**
- Modify: `worker/src/ingest_worker/decompose/model.py`, `worker/src/ingest_worker/decompose/forms.py` (only if it reads field names from dumps), `worker/scripts/decompose.py` (dump `by_alias=True`)
- Modify: `packages/bridge-contract/vectors/comparison-forms.json`, `vectors/README.md`
- Create: `packages/bridge-contract/src/decomposed/model.ts`, `src/decomposed/forms.ts`, `test/decomposed-forms.test.ts`
- Modify: `packages/bridge-contract/src/index.ts`, and `scripts/prepare-publish.mjs`: add `vectors` to `files`, so sinks can run the vectors

**Interfaces:**
- Produces, in Python: `_Model.model_config` gains `alias_generator=to_camel, populate_by_name=True`. Every dump for the contract uses `model_dump(mode="json", by_alias=True)`.
- Produces, in TypeScript:
  - `DecomposedDocumentSchema` (zod, strict), mirroring `model.py` field for field, in camelCase. Discriminated unions on `kind` for blocks and inlines.
  - `type DecomposedDocument`.
  - `normalise(s: string): string`.
  - `textForm(doc: DecomposedDocument): string[]`.
  - `gridForms(doc: DecomposedDocument): Record<string, string[][]>`.
  - The forms follow `forms.py` exactly, including the tokens `⟦xref:…⟧`, `⟦eq:…⟧`, `⟦img⟧` and `⟦note:…⟧`.

- [ ] **Step 1: Write the failing tests.**
  - `worker/tests/decompose/test_model.py::test_dumps_camel_case`: `model_dump(by_alias=True)` of a table has `rowSpan`, `captionPosition` and `columnWidths`, and `model_validate` accepts both cases.
  - `test/decomposed-forms.test.ts`: `it('reproduces every vector')`. For each vector, `DecomposedDocumentSchema.parse(v.document)` succeeds, `textForm` equals `v.text_form`, and `gridForms` equals `v.grid_forms`. Keep the vector file's own top-level keys as they are; only the documents are camelCase.
  - Also `it('rejects unknown fields')`.
- [ ] **Step 2: Run** `npm test -w @ih/bridge-contract -- decomposed-forms` and `uv run --directory worker pytest tests/decompose/test_model.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate the vectors from the Python forms with `by_alias=True`, then hand-check that only the documents' keys changed (`git diff --stat`, and a jq comparison of `text_form` and `grid_forms`: they must be identical).
- [ ] **Step 4: Run** both test commands and `uv run --directory worker pytest tests/decompose -q`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(contract): the decomposed document's schema and comparison forms, in camelCase`.

### Task 2: Contract version 2 schemas

**Files:**
- Modify: `packages/bridge-contract/src/package.ts`, `src/sink-api.ts`, `src/producer-api.ts`, `src/errors.ts`, `src/idempotency.ts`, `test/builders.ts`, `package.json` (`"version": "0.8.0"`)
- Create: `test/fixtures/package-decomposed.json`, `test/fixtures/describe-v2.json`, `test/package-v2.test.ts`
- Modify: `packages/shared/src/publish-targets.ts` (`SinkInfoSchema` capability echo), `apps/bridge/openapi.json` and `docs/openapi.json` (`npm run openapi`)

**Interfaces:**
- **`package.ts`:**
  - `ContractVersion = z.union([z.literal(1), z.literal(2)])`, used by `PackageSchema` and `ArchivedPackageSchema`.
  - `DecompositionProvenanceSchema = z.strictObject({ kind: z.literal('decomposition'), sourceSha256, sourceFilename, sourceKey: z.string().min(1), batchId: z.string().nullable(), decomposerVersion: z.number().int().positive(), startedBy: ActingUserSchema, decomposedAt: z.string().datetime(), publishedAt: z.string().datetime() })`.
  - `provenance` becomes `z.union([ProvenanceSchema, DecompositionProvenanceSchema]).nullable()`.
  - `document: DecomposedDocumentSchema.nullable().optional()`.
  - `PACKAGE_PARTS` gains `'document'`, and `partsOf` adds it when present.
  - The archive writes `document.json`, and `ArchivedPackageSchema.document` is `{path}`.
  - `superRefine` adds these rules, each with an issue path:
    - `document` requires `contractVersion: 2`;
    - with `document` present: `files` is empty, `data`, `rdf` and `narrative` are null, and provenance is the decomposition variant;
    - decomposition provenance requires `document`;
    - every image referenced from `document.images` is in `images`, and the reverse.
- **`sink-api.ts`:**
  - `SinkDescribeSchema.contractVersion` is `ContractVersion`.
  - `CapabilitiesSchema` gains `decomposedDocuments: z.strictObject({ equations: z.array(z.enum(['mathml','latex','image'])).min(1) }).optional()`.
  - A refinement on describe: `decomposedDocuments` requires `contractVersion: 2`, `readBack: true` and `accepts` to include `'document'` and `'images'`.
  - `SinkDeliverRequestSchema.update: z.strictObject({ persistentId: z.string().min(1), expected: z.array(ComponentVersionSchema).min(1) }).optional()`.
  - `ComponentVersionSchema = z.strictObject({ kind: z.string(), id: z.string(), version: z.string(), element: z.string().nullable() })`.
  - `ReceiptSchema.document: z.strictObject({ persistentId: z.string().min(1), components: z.array(ComponentVersionSchema), readBack: z.strictObject({ ok: z.boolean(), at: z.string().nullable(), detail: z.string().nullable() }) }).optional()`.
- **`producer-api.ts`:** `CreateDeliveriesRequestSchema.update` takes the same shape as above, optional, and a refinement allows it only with exactly one target.
- **`errors.ts`:** `changed_in_target: 'needs_user'`, plus `changedInTargetDetails(changed: Array<{id: string; expected: string; actual: string | null}>): Record<string, unknown>`, capped at 40 entries with `more`.
- **`idempotency.ts`:** `decompositionIdempotencyKey(sourceSha256: string, persistentId: string | null, decomposerVersion: number, forceBatchId: string | null): string` is sha256 over `['decomposition', sha, persistentId ?? '', String(version), forceBatchId ?? ''].join('\n')`.

- [ ] **Step 1: Write the failing tests** (`test/package-v2.test.ts`):
  - `the decomposed fixture parses as v2`;
  - `a v1 fixture still parses unchanged`;
  - `document needs contractVersion 2`;
  - `document excludes files, data, rdf and narrative`;
  - `decomposition provenance needs a document`;
  - `images must match the document's images both ways`;
  - `describe-v2 parses and decomposedDocuments needs readBack and accepts document`;
  - `update needs exactly one target`;
  - `changed details are capped at 40 with more` (from 500 entries: `JSON.stringify(details).length < 4096`);
  - `decomposition idempotency keys differ by persistent id, version and force batch`.
- [ ] **Step 2: Run** `npm test -w @ih/bridge-contract`. Expected: the new tests FAIL, and the existing ones pass.
- [ ] **Step 3: Implement.** Build `package-decomposed.json` from a vector document plus one image, and `describe-v2.json`. Run `npm run openapi` to regenerate the OpenAPI files.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS, with every existing version 1 test unchanged.
- [ ] **Step 5: Commit**: `feat(contract): version 2 — document part, decomposedDocuments, conditional update, changed_in_target`.

### Task 3: Python mirror of version 2

**Files:**
- Modify: `worker/src/ingest_worker/bridge/models.py`, `worker/tests/test_bridge_models.py`

**Interfaces:**
- **`BridgePackage`:**
  - `contract_version: Literal[1, 2]`;
  - `document: DecomposedDocument | None = None`, the phase 1 model, dumped by alias;
  - `provenance: Provenance | DecompositionProvenance | None`;
  - the same refinements as Task 2, as a `model_validator`.
- **New models:** `DecompositionProvenance`, `ComponentVersion`, `DocumentReceipt`, and `Update` (`persistent_id`, `expected`).
- **Optional fields:** `Receipt.document: DocumentReceipt | None = None`, and `CreateDeliveriesRequest.update: Update | None = None`.
- **`decomposition_idempotency_key(source_sha256, persistent_id, decomposer_version, force_batch_id) -> str`**, identical to the TypeScript.

- [ ] **Step 1: Write the failing tests:**
  - `test_decomposed_fixture_round_trips`: parse `packages/bridge-contract/test/fixtures/package-decomposed.json`; dumping it by alias gives equal JSON.
  - `test_v1_fixtures_unchanged`.
  - `test_document_refinements` (the same four rules as Task 2).
  - `test_decomposition_key_matches_typescript`: a fixed input gives a hex value that Task 2's test also asserts. Put the expected value in both tests.
- [ ] **Step 2: Run** `uv run --directory worker pytest tests/test_bridge_models.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run worker:test` and `npm run worker:lint`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(worker): bridge models for contract version 2`.

### Task 4: Stateful fake document sink

**Files:**
- Create: `apps/bridge/src/sinks/fake-documents.ts`, `apps/bridge/test/fake-documents.test.ts`
- Modify: `apps/bridge/src/sinks/fake-server.ts` (env `FAKE_SINK_MODE=documents` serves it; unsigned `POST /_edit` bumps a component, for tests and the owner's trial), `apps/bridge/test/fake-server.test.ts`

**Interfaces:**
- Produces `class FakeDocumentSink implements SinkPort`, constructed as `new FakeDocumentSink({ equations?: ('mathml'|'latex'|'image')[] })`.
  - **Describe:** `contractVersion: 2`, `accepts: ['document','images']`, `readBack: true`, `replace: true` and `decomposedDocuments: { equations }`.
  - **State:** `documents: Map<persistentId, { idempotencyKeys: Set<string>; components: Map<id, {kind, element, version: number}> }>`.
  - **Create**, with no `update`. If the idempotency key was seen, it returns that document's receipt. Otherwise it assigns `doc-<n>` (deterministic counter). Components are:
    - one `map` for the document;
    - one `section` per section id (depth first, with the leading blocks as `s~lead` when present);
    - one `image` per image.

    All are at version 1.
  - **Update:**
    - An unknown persistent id gives `changed_in_target`, listing the document as gone.
    - Any expected component whose version differs or is missing, or any current component not in `expected`, gives `changed_in_target` with `changedInTargetDetails`.
    - Otherwise sections still present get version + 1. New sections are added at 1; removed ones are dropped from the map, and the map gets version + 1. Images are bumped only if their bytes changed.
  - **Read-back:** the sink stores the delivered document, then compares `textForm` and `gridForms` of the stored copy with the delivered one. `readBack.ok` is true, unless the test hook `corruptNextReadBack()` was called.
  - **Test hook:** `edit(persistentId, componentId)` bumps one component's version, standing for an edit in the target.
- `ComponentVersion.version` is the number as a string. `element` is the section id, image id or `null` for the map.

- [ ] **Step 1: Write the failing tests** (`fake-documents.test.ts`):
  - `create returns persistent id and component versions`;
  - `same key returns the first document`;
  - `update with matching versions bumps sections`;
  - `update after edit is refused as changed_in_target with the component`;
  - `update with an extra current component is refused`;
  - `unknown persistent id is refused as gone`;
  - `changed details are capped` (500 sections edited);
  - `read back compares the forms` (`corruptNextReadBack` gives `ok: false`);
  - and in `fake-server.test.ts`, `documents mode serves describe v2 and /_edit`.
- [ ] **Step 2: Run** `npm test -w @ih/bridge -- fake-documents fake-server`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(bridge): a stateful fake sink for decomposed documents`.

### Task 5: Bridge: accept, store and pass `update`; version negotiation

**Files:**
- Create: `db/bridge-migrations/202610231200_delivery_update.sql` (`alter table bridge.deliveries add column update jsonb`)
- Modify: `apps/bridge/src/deliveries/accept.ts`, `runner.ts`, `repo.ts`, `pg.ts`, `apps/bridge/src/sinks/http.ts`
- Test: `apps/bridge/test/runner.test.ts`, `test/deliveries-route.test.ts`, `test/http-sink.test.ts`, `test/integration/deliveries-pg.test.ts` (integration-marked, as the existing ones are)

**Interfaces:**
- **`accept.ts`:**
  - A `document` package to a sink whose describe has no `decomposedDocuments` gives `unsupported_part` with `{targetId, part: 'document'}`. The existing `accepts` check already covers version 1 sinks; add the capability check explicitly.
  - `update` with more than one target is already refused by the schema.
  - `update` is stored on the delivery row.
- **`runner.ts`:**
  - It passes `update` from the row to `sink.deliver`.
  - Before delivering, if the sink's `contractVersion` is 2 and the package's is 1, it sends `{...pkg, contractVersion: 2}`, and the stored package is unchanged.
  - It never downgrades: a version 2 package to a version 1 sink can't reach here, because accept refuses it.
- **`http.ts`:** it accepts version 2 describes, and receipts with `document`. A `changed_in_target` error keeps its details when under 4 KB, as now.

- [ ] **Step 1: Write the failing tests:**
  - `runner.test.ts`:
    - `passes update to the sink`;
    - `upgrades v1 packages for v2 sinks`;
    - `stores a document receipt` (a `FakeDocumentSink` create, then `row.receipt.document.persistentId`);
    - `changed_in_target ends in needs_user with details`.
  - `deliveries-route.test.ts`: `document package to a v1 sink is unsupported_part`, and `update is kept on the delivery`.
  - `http-sink.test.ts`: `describe v2 and a document receipt parse`.
- [ ] **Step 2: Run** `npm test -w @ih/bridge`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement**, including the migration and the Pg repo column. Add the column to the in-memory repo too.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(bridge): deliver decomposed documents with a conditional update`.

### Task 6: Conformance checks for decomposed documents

**Files:**
- Modify: `packages/bridge-contract/src/conformance/suite.ts`, `apps/bridge/test/conformance-fake.test.ts`

**Interfaces:**
- `deliver(pkg, update?)` returns the parsed `SinkDeliverResult`, or the problem string. Existing callers only test for a problem.
- The new checks run only when `capabilities.decomposedDocuments` is present. Otherwise they are recorded as skipped, as the existing capability checks are:
  1. `document: create` (fixture `package-decomposed.json`, a fresh key per run): receipt has `document.persistentId` and at least one component.
  2. `document: read back`: `readBack.ok` is true.
  3. `document: same key again`: the same persistent id comes back.
  4. `document: update with matching versions` (key from a different decomposer version): succeeds, with the same persistent id.
  5. `document: update with a wrong version is refused`: one `expected` version altered gives the `needs_user` error `changed_in_target` with `details.changed` naming that component. This is how a real sink is checked without editing it.

- [ ] **Step 1: Write the failing test.** In `conformance-fake.test.ts`, the suite against `serveSink(new FakeDocumentSink(), KEY)` passes every check, and the asserted name list now includes the five names above. Against the existing `FakeSink`, the five are skipped.
- [ ] **Step 2: Run** `npm test -w @ih/bridge -- conformance`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(contract): conformance checks for decomposed documents`.

### Task 7: The register table, and the API updating it from events

**Files:**
- Create: `db/migrations/202610231300_decomposition_register.sql`, `apps/api/src/bridge/register.ts`, `apps/api/test/register-events.test.ts`
- Modify: `apps/api/src/bridge/events.ts` (call `applyRegisterEvent` after `applyDeliveryUpdate`), `apps/api/src/repositories/pg.ts` (and the in-memory repo the API tests use)

**Interfaces:**
- **Table `decomposition_register`:**
  - `id uuid pk`, `sink_id text`, `instance_id text`, `source_key text`, `content_sha256 text`;
  - `persistent_id text null`;
  - `state text check (state in ('pending','delivered','incomplete','changed','failed'))`;
  - `idempotency_key text`, `delivery_id text null`, `last_receipt jsonb null`, `last_error jsonb null`;
  - `batch_id text null`, `created_at`, `updated_at`, `delivered_at null`.

  Indexes: `unique (sink_id, instance_id, source_key)`, an index on `(sink_id, instance_id, content_sha256)`, and `unique (delivery_id)`.
- **`applyRegisterEvent(repo, event)`**, for the delivery whose id is in the register:
  - **Succeeded** with `receipt.document`:
    - `persistent_id` and `last_receipt` are set;
    - the state is `delivered`, or `incomplete` if `readBack.ok` is false;
    - `delivered_at` is now.
  - **Succeeded without `receipt.document`:** `incomplete`, and the persistent id is left as it was.
  - **`needs_user` with `changed_in_target`:** `changed`, with `last_error`.
  - **Any other final failure:** `failed`, with `last_error`. If a receipt reported a persistent id, keep it.
  - **Non-final events** (queued, waiting) change nothing.
  - A delivery not in the register is ignored.

- [ ] **Step 1: Write the failing tests** (`register-events.test.ts`, with the in-memory repo):
  - `success with document receipt delivers`;
  - `read-back failure marks incomplete`;
  - `receipt without document marks incomplete`;
  - `changed_in_target marks changed`;
  - `other failure marks failed and keeps a known persistent id`;
  - `events for other deliveries are ignored`.

  Add an integration test of the migration and the Pg repo methods, marked integration as the other Pg tests are.
- [ ] **Step 2: Run** `npm test -w @ih/api -- register-events`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(api): the decomposition register, kept from bridge events`.

### Task 8: Worker: the register checks and `deliver_decomposition`

**Files:**
- Create: `worker/src/ingest_worker/decompose/register.py`, `worker/src/ingest_worker/decompose/deliver.py`, `worker/scripts/deliver_decomposition.py`
- Test: `worker/tests/decompose/test_register.py`, `worker/tests/decompose/test_deliver.py`, `worker/tests/decompose/test_register_pg.py` (integration-marked)

**Interfaces:**
- **`register.py`:**
  - `RegisterEntry` (frozen dataclass mirroring the table).
  - `class RegisterStore(Protocol)`, with:
    - `transaction() -> ContextManager[RegisterTx]`;
    - `RegisterTx.by_key(sink_id, instance_id, source_key) -> RegisterEntry | None`, which locks the row;
    - `RegisterTx.by_hash(sink_id, instance_id, sha) -> list[RegisterEntry]`;
    - `RegisterTx.put_pending(...) -> RegisterEntry`;
    - `RegisterTx.set_delivery(entry_id, delivery_id)`.
  - `MemoryRegisterStore` and `PgRegisterStore(conn_factory)`, the latter with `SELECT … FOR UPDATE`.
- **`deliver.py`:**
  - `Outcome = Literal["created", "updated", "already_loaded", "duplicate", "in_flight", "changed_in_target", "failed"]`.
  - `@dataclass(frozen=True) class Decision`, with `outcome: Outcome | None` (None means deliver), `create: bool`, `entry: RegisterEntry | None` and `reason: str`.
  - `decide(by_key: RegisterEntry | None, by_hash: list[RegisterEntry], sha: str, force: bool) -> Decision`, a pure function holding spec §8's table:

    | Case | Result |
    |---|---|
    | `by_key` in state `pending` | `in_flight` |
    | `by_key` in state `changed` | `changed_in_target` |
    | Same hash and same key, delivered or incomplete | `already_loaded` (force: update) |
    | Same hash under another key | `duplicate` (force: create) |
    | `by_key` with a persistent id, new hash | update |
    | `by_key` without a persistent id (failed before create) | create again, keeping the same entry |
    | Neither | create |

  - `deliver_decomposition(deps: DeliverDeps, *, data: bytes, source_key: str, target_id: str, started_by: ActingUser, batch_id: str | None = None, force: bool = False) -> DeliveryOutcome`, where `DeliveryOutcome(outcome: Outcome, delivery_id: str | None, entry_id: str | None, detail: str)`. Its steps:
    1. `decompose_docx(data, renderer=deps.renderer)`. A failure or rejection gives `failed`, and touches nothing.
    2. sha256.
    3. In one register transaction: look up and `decide`. If it decides to deliver, `put_pending` with the idempotency key from `decomposition_idempotency_key(sha, entry.persistent_id if update else None, DECOMPOSER_VERSION, batch_id if force else None)`.
    4. Build the version 2 package: document by alias, images base64 from `image_bytes`, decomposition provenance, and naming. On update, include `update=Update(persistent_id, expected=last_receipt.document.components)`.
    5. `deps.bridge.deliver(...)`, then `set_delivery`.
    6. Return `created` or `updated`, with `delivery_id`. The final state arrives later, through the API's events (Task 7).
  - `DeliverDeps` holds `renderer`, `register`, `bridge` (the `BridgeClient` Protocol), `target_lookup(target_id) -> (sink_id, instance_id)` and `clock`.
- **CLI:** `uv run --directory worker python scripts/deliver_decomposition.py <file.docx> --target <id> [--source-key K] [--force]`. It uses the worker's configured bridge, database and converter, and prints the outcome.

- [ ] **Step 1: Write the failing tests:**
  - `test_register.py`: one test per row of `decide`'s table:
    - `test_new_file_creates`;
    - `test_same_file_same_key_is_already_loaded`;
    - `test_force_turns_already_loaded_into_update`;
    - `test_same_file_other_key_is_duplicate`;
    - `test_force_turns_duplicate_into_create`;
    - `test_changed_file_same_key_updates`;
    - `test_pending_is_in_flight`;
    - `test_changed_entry_refuses`;
    - `test_entry_without_persistent_id_creates_again`.
  - `test_deliver.py`, with a fake `BridgeClient` that records requests and `FakeRenderer`:
    - `test_create_sends_v2_package_without_update`;
    - `test_update_sends_expected_versions_from_last_receipt`;
    - `test_already_loaded_sends_nothing`;
    - `test_decomposition_failure_touches_nothing`;
    - `test_retry_after_lost_response_keeps_one_document`: the bridge raises after accepting, and a second call with the same input finds `pending`, so it is `in_flight`, not a second create.
  - `test_register_pg.py` (integration): `test_concurrent_delivery_is_refused`, with two connections and the second `by_key` waiting on the lock, then seeing `pending`.
- [ ] **Step 2: Run** `uv run --directory worker pytest tests/decompose/test_register.py tests/decompose/test_deliver.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run worker:test` and `npm run worker:lint`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(worker): register checks and deliver_decomposition`.

### Task 9: End to end through the bridge, docs and release note

**Files:**
- Create: `apps/bridge/test/decomposed-e2e.test.ts`
- Modify: `docs/superpowers/specs/2026-10-23-document-decomposition-design.md` §11 (one status line for phase 2); the bridge design's contract section (`docs/superpowers/specs/2026-10-19-delivery-bridge-design.md`, the package parts list: `document` added, `narrative` noted as withdrawn); `packages/bridge-contract/README.md`, if it lists parts or versions
- Create: `docs/release-notes/Release-Notes-<date of the PR>.html`, in the same layout as the existing notes. One minor-change entry: "Decomposed documents can be delivered to a target". It is generic, with no vendor name, and names this PR and #315 for phase 1.

**Interfaces:** consumes Tasks 2 to 7.

- [ ] **Step 1: Write the failing test.** `decomposed-e2e.test.ts` drives the real accept, runner and HTTP adapter against `serveSink(new FakeDocumentSink(), KEY)`:
  1. deliver `package-decomposed.json`, which succeeds with a persistent id;
  2. deliver again as an update with the receipt's versions, which succeeds with the same id;
  3. `edit` one section in the fake;
  4. deliver an update with the old versions, which ends `needs_user` with `changed_in_target` naming that section;
  5. deliver the same package to a version 1 `FakeSink` target, which is refused as `unsupported_part`.
- [ ] **Step 2: Run** `npm test -w @ih/bridge -- decomposed-e2e`. Expected: FAIL until wired, then PASS.
- [ ] **Step 3: Write the docs and the release note.**
- [ ] **Step 4: Run** all four checks: `npm run check`, `npm run format:check`, `npm run worker:test` and `npm run worker:lint`. Expected: green.
- [ ] **Step 5: Commit**: `test(bridge): decomposed documents end to end; docs and release note`.

---

**Phase 2 is done when** (spec §11): the conformance suite's new checks pass against the fake
document sink, and re-runs produce each outcome in spec §3: created, updated, already loaded,
duplicate, and changed in target. The one outcome left is "failed" from the decomposer, which is
phase 1's.
