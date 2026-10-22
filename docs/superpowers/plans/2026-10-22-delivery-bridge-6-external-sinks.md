# Delivery bridge, phase 6: external sinks — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private external sink registers with the bridge, passes the conformance suite, and
receives CT Studio's publications end to end. The deliveries carry per-document names a
reviewer can change, and are made as the right person.

**Architecture:** three parts, each its own branch and PR, in order. Each one ships working
software.

- **Part A: external sinks end to end** (Tasks 1–6).
  - The bridge reads `BRIDGE_SINKS`, and calls each registered sink through a signed HTTP
    adapter, `HttpSink`, which implements `SinkPort` exactly as `serveSink` serves it.
  - The bridge caches each sink's `describe`.
  - CT Studio can create, edit and lock targets of any registered sink. It renders the form
    from the sink's declared fields, and recipes may name those targets.
  - A fake external sink runs in the compose smoke and in CI's conformance run.
- **Part B: names** (Tasks 7–12).
  - A pattern syntax, and one resolver in the contract package.
  - The worker fills `package.naming`. The bridge resolves pattern fields at accept time and
    refuses a pattern that does not resolve (`pattern_unresolved`).
  - Recipes set per-target patterns.
  - Admins browse a sink's tree for fixed fields.
  - Reviewers see the resolved names and can override them. A sink's `name_conflict` sends the
    job back to review with the field marked.
- **Part C: the right person** (Tasks 13–16).
  - A reviewer is recorded by user id.
  - The worker records the last user it delivered as, which system re-deliveries use.
  - An upload preflight warns an uploader who lacks a connection.
  - A review held up by a connection offers *Manage connections*.
  - Job panels show each sink's receipt links.

**Tech stack:** as in phase 5. No new dependency.

**Spec:** [docs/superpowers/specs/2026-10-19-delivery-bridge-design.md](../specs/2026-10-19-delivery-bridge-design.md):
the phase 6 row, and these sections:
- Goals 5, 6 and 9;
- "Sink registry";
- "Targets" (browsing and locking);
- "Recipes" (per-target settings and validation);
- "Review and naming overrides";
- "The package" (naming inputs);
- "Delivering" (steps 1, 2 and 4);
- "Idempotency, replace and skip";
- "Deleting jobs and retiring types";
- "Withdraw, republish and read-back";
- "Sink contract (bridge ↔ sink), v1";
- "Phase 5 as built" (*Left for phase 6*).

**Builds on:** the [phase 5 plan](2026-10-22-delivery-bridge-5-personal-connections.md) (PR #297,
which must merge first), [ADR 0017](../../adr/0017-delivery-bridge.md), and the conformance image
and contract package that CI publishes on each tag.

## Global constraints

- Everything in the earlier phases' global constraints still applies:
  - TDD, red first;
  - tests stay offline;
  - the same contract on both sides, with shared fixtures;
  - **no vendor names of private external sinks anywhere** (the fake sink is `fake`, its
    instances `sandbox` and `prod`).
- Gate before saying anything is done:
  - `npm run check`, `npm run format:check`, `npm run worker:test` and `npm run worker:lint`;
  - plus the opt-in Pg tests of the files a task touches, on a throwaway Postgres;
  - never the live stack or `deploy/.env`.
- Stage files by name. Ask before pushing or opening a PR.
- **Nothing moves for a deployment with no external sink:**
  - `BRIDGE_SINKS` unset means the registry is `s3` and `rdf`, as today;
  - every existing recipe keeps its `definitionSha256`, object keys and behaviour;
  - the equivalence goldens are not rewritten.
- **Nothing secret reaches CT Studio** (phase 5): CT Studio gets no credential, and no personal
  connection's fields, from any new route.
- **No CT Studio code knows a sink by name** beyond the built-in `s3` and `rdf`.
- Contract versions:
  - Part A publishes `@ih/bridge-contract` 0.5.0, Part B 0.6.0, and Part C 0.7.0;
  - all are additive;
  - the sink contract stays `contractVersion: 1`.

## Decisions this plan makes (within "left to the builder"; recorded in the spec by Tasks 6, 12 and 16)

### Part A
- **`BRIDGE_SINKS`** is a JSON list. Alternatively, `BRIDGE_SINKS_FILE` names a file holding
  that list, for a Docker secret; when both are set, the bridge does not start. Each entry looks
  like this:

  ```json
  [{ "id": "fake", "url": "http://fake-sink:8080", "key": "<at least 32 characters>" }]
  ```

  - `id` matches `RESOURCE_ID`, and is not `s3` or `rdf`.
  - `url` is `http:` or `https:`, with no credentials and no query.
  - Ids are unique.
  - Any violation stops the bridge at start, with a message naming the entry, and never the
    key.
- **`HttpSink`** (`apps/bridge/src/sinks/http.ts`) signs every call with the entry's key.
  - Its timeouts are 15 s for describe, test and browse, and 120 s for deliver and status.
  - It answers through the contract's schemas, so a malformed answer is `SinkError internal`.
  - A 4xx `BridgeError` of class `needs_user` becomes `SinkError(needs_user)`.
  - A 5xx, a timeout or a network failure becomes `sink_unavailable` or `timeout`, and those
    are retryable.
  - A 401 becomes `internal`, with the message "the sink refused the bridge's signature: check
    its key".
- **Describes are cached.** `CachingSinkRegistry` wraps the registry, describes every sink at
  start, and describes it again every `BRIDGE_SINK_REFRESH_SECONDS` (300).
  - A sink whose describe fails keeps its last good answer, but is marked `unavailable`.
  - A sink never described is `unavailable` with no describe.
  - `get(id)` returns a port whose `describe()` answers from the cache. The built-ins are cached
    too, which costs nothing.
  - An unavailable sink refuses new deliveries at accept with `sink_unavailable`, which is
    retryable, so the worker retries the job. Deliveries already running retry as now.
- **External sinks' `withdraw` and `readBack` are not used in phase 6.** Contract v1 lists
  routes for them, but their bodies are unspecified. The bridge treats an external sink's
  `withdraw` and `readBack` as false, and Published outputs says so.
  - A recipe's primary target must still be an S3 files target, as today. Results, the zip and
    read keys are unchanged.
  - Deleting a job or retiring a type names the deliver-only targets in its confirmation: "This
    content stays in <label>".
  - Withdraw skips those targets, and the job shows "Delivered to <label>" with the receipt's
    links.
- **`SinkView` gains `destinationFields` and `credentialFields`** (ids, labels and flags; never
  values), so CT Studio can render a target form. The contract becomes 0.5.0.
- **CT Studio targets of any sink.**
  - `TargetCreateBodySchema` gains a third variant: `{ kind: 'sink', sinkId, instanceId,
    connectionId, destination }`. Its `destination` holds the fixed fields' values and the pattern
    fields' default patterns.
  - `TargetPatchBodySchema` takes `{ label?, connectionId?, destination? }` for a sink target.
  - The bridge's `checkTarget` decides validity (Part B adds pattern parsing). CT Studio
    checks usage and locks:
    - the sink, the instance and the fixed fields lock while a published recipe version or a
      delivery names the target;
    - the label, the connection and the pattern defaults never lock.
  - Choices list sink targets with their sink's name.
- **Recipes may name sink targets.**
  - The refusal "recipes can't deliver to it yet" goes, from the API and the worker.
  - `templateIssues` adds "`<id>` (<sink>) does not take the graph (rdf)" when the recipe's
    formats include `rdf` and the sink's cached `accepts` lacks `rdf`.
  - The API keeps an in-memory catalog of `GET /v1/sinks`, refreshed by every `pullTargets`
    and every Published outputs list. An unknown sink raises no issue: the bridge's accept still
    refuses.
- **The worker's `Target`** gains `sink_id`. `bucket`, `prefix` and `layout` become optional;
  they are None for a sink target.
  - Only S3 targets can be primary.
  - A package always carries `files` and `data`, and a sink accepts the parts it may ignore
    (phase 3's rule), so the conformance suite now fails a sink whose `accepts` lacks `files` or
    `data`.
- **The fake external sink** is `apps/bridge/src/sinks/fake-server.ts`, an entry point that
  serves `FakeSink` through `serveSink` with `FAKE_SINK_KEY`.
  - It is shared, with no instances, and has a fixed field `space` (browse) and a pattern field
    `name` (required, overridable).
  - It also serves an unsigned `GET /_delivered`, the last 50 delivery requests without their
    bytes, for the smoke to read.
  - It runs from the bridge image with another command, in compose profile `fake-sink` only.
    No deployment runs it unless that profile is asked for, and BRIDGE_SINKS names it.

### Part B
- **Pattern syntax**, shared by everything that resolves or checks one
  (`packages/bridge-contract/src/naming.ts`):
  - Literal text, and `{…}` placeholders. A placeholder is alternatives separated by `|`; the
    first one that resolves to a non-empty value wins.
  - An alternative is a variable or a quoted literal (`'untitled'`). `{{` and `}}` are literal
    braces.
  - The variables are:
    - `field:<id>`;
    - `source.filename`, `source.stem` and `source.sha256`;
    - `recipe.id` and `recipe.version`;
    - `job.id`;
    - `date` (UTC `YYYY-MM-DD`, from `published_at`).
  - An unknown variable or an unbalanced brace is a parse error: "`<pattern>`: <what> at
    <position>".
  - A placeholder with no non-empty alternative is unresolved.
  - Values are inserted as they are. Each sink validates its own destination values, and the
    spec leaves making them safe to the sink.
  - The API is `parsePattern(p) → Pattern | PatternError`, `patternVariables(p) → string[]`, and
    `resolvePattern(p, naming) → { value } | { unresolved: string[] }`.
- **Naming inputs.** `package.naming` is a flat map from the variable to its value.
  - A field value is its text form: numbers as written, a list joined by `, `, a null or missing
    field left out.
  - Table cells are not variables.
  - The worker builds it (`bridge.naming.naming_inputs`). The API builds the same map for the
    review screen and for previews (`namingInputsOf` in `apps/api/src/bridge/naming.ts`).
  - The resolver lives in the contract package only: `packages/shared` and the web app don't
    depend on it. The web app gets resolved values and previews from the API.
  - The shared fixture `packages/bridge-contract/test/fixtures/naming.json` pins both, and the
    resolver.
- **Where patterns come from.** For one delivery, a pattern field's value is the first of:
  1. the reviewer's override (a literal, used as it is);
  2. the recipe's per-target pattern;
  3. the target's default pattern.

  A required pattern field with none of these is a `templateIssues` issue, and an accept
  refusal.
- **Recipe settings**: `delivery.settings: { <targetId>: { <fieldId>: <pattern> } }`, in TS and
  Python, with a shared fixture.
  - When `settings` is absent, the hash is unchanged.
  - The editor writes `settings` only when a value was entered.
  - `templateIssues` checks four things:
    - each key is in `publishTo`;
    - each field is a pattern field of that target's sink;
    - each pattern parses;
    - every `field:<id>` names a field of the recipe.
- **The bridge resolves at accept.**
  - `CreateDeliveriesRequest` gains `patterns: record<targetId, record<fieldId, pattern>>`
    (default `{}`), which carries the recipe's settings. `overrides` keeps its shape, and now
    holds only the reviewer's literal values.
  - Accept refuses, before anything is written:
    - an override of a field that is not `overridable`;
    - an override of a field that is not declared;
    - an unresolved pattern, as `pattern_unresolved` with details `{targetId, field,
      variables}`.
  - Accept records the resolved destination on the delivery. The runner sends that, and no
    longer merges anything.
- **Browse.**
  - `POST /v1/targets:browse { sinkId, instanceId, connectionId, field, parentId, cursor,
    actingUser }`. For a personal sink, the bridge uses the acting admin's own connection, or
    answers `connection_missing`.
  - The API's admin route `POST /api/publish-targets/browse` passes the signed-in admin as the
    acting user.
  - The editor's Browse button opens a tree dialog, which loads one level at a time and pages by
    cursor. Picking a `selectable` node fills the field with the node's id.
- **Review overrides.**
  - `GET /api/jobs/:id/naming` lists, for each target in the job's recipe version, its
    overridable pattern fields: label, pattern, resolved value (or the unresolved variables) and
    any `name_conflict` on it.
  - `ApproveRequestSchema` gains `overrides?: record<targetId, record<fieldId, string>>`. They are
    validated against that list (400 naming the field), and stored in `jobs.delivery_overrides
    jsonb`. A re-approve replaces them.
  - The worker sends them. Auto-published jobs send none.
  - `DecisionBar` shows a *Names* section when the list is non-empty.
- **Name conflicts.**
  - `job_deliveries` gains `error jsonb`, the delivery's last `BridgeError` from its events.
  - A `name_conflict` with `details.field` marks that field in `GET /api/jobs/:id/naming`
    ("<label> already has another document named <value>: choose another name").
  - The review reason stays `<label>: <message>`.
  - The same source delivered again is the sink's replace, and never a conflict (the sink's
    rule, checked by the conformance suite's "same key again").

### Part C
- **The reviewer by id.**
  - `jobs.reviewer_user_id` is set from `req.auth.userId` on approve.
  - `queue.reviewer()` reads it first, and falls back to today's name match for jobs approved
    before this change.
- **The last deliverer.**
  - `jobs.delivered_as_user` is set when the bridge accepts a package for the job, to the
    acting user's id.
  - `rdf_rebuild` and remint act as that user, then the reviewer, then the uploader.
  - Republish keeps acting as the person who pressed it.
- **Fallbacks are the accept refusals.** Phase 5's accept already refuses a personal target with
  no acting user, or whose acting user has no connection (`connection_missing`). The worker turns
  that refusal into review. Approving then makes the approver the acting user.
  - Part C adds only tests through the worker:
    - auto-publish with no uploader;
    - an uploader without a connection;
    - a reviewer without a connection;
    - the re-approval delivering as the new approver.
  - There is never a fallback to a shared account.
- **Preflight.**
  - `POST /v1/deliveries:preflight { targets, actingUser }` returns `{ targets: [{ targetId,
    problem: BridgeError | null }] }`. It runs accept's sink and connection checks, without the
    package and without patterns.
  - The API serves `POST /api/documents/preflight { specId }` to every role, and the upload
    strip calls it when a spec is picked.
  - A problem shows a warning with *Manage connections*. The upload still goes ahead.
- **Reviews held up by a connection.**
  - `jobs.connection_needed boolean` is set when a job goes to review for one of these codes:
    `connection_missing`, `credential_missing`, `credential_rejected` or
    `credential_mfa_required`. The worker's accept refusal sets it, and so does the API's
    delivery events.
  - It is cleared on approve.
  - The review header then shows *Manage connections*. It opens the connections page, not a
    connection. The handoff link takes no connection id, because the producer may not know it.
- **Receipts.**
  - `JobDeliveryView` gains `links: { label, url }[]`, from the delivery's receipt, read from
    the bridge's `GET /v1/deliveries/:id` when the job panel opens and cached on
    `job_deliveries.receipt`.
  - URLs must be `https:` or `http:`; anything else is dropped.

## Review Focus

- **A misconfigured or hostile external sink.** Examples: a wrong key (401), garbage JSON, a
  10 MB answer, a hang, a `needs_user` error with an unknown code, a describe that changes
  between refreshes. Each one is a clear `SinkError`, and nothing crashes the bridge. (Tasks 1
  and 2 test each one.)
- **A deployment with no external sink.** With `BRIDGE_SINKS` unset, every existing test,
  golden and smoke step passes unchanged, and existing recipes keep their hash. (Tasks 3, 4 and
  9 assert it.)
- **Patterns that resolve to nothing, or to something odd.** Examples: an empty field, a field
  with `/`, a value with braces, a default chain that ends in a literal, a date at midnight UTC.
  Each one resolves, or is refused before anything is written, and the TS and Python naming
  inputs agree. (Tasks 7 and 9, with the shared fixture.)
- **A reviewer override aimed somewhere it shouldn't go.** Examples: a field that is not
  overridable, a target not in the recipe, a fixed field such as a bucket. The answer is 400 at
  approve, and a refusal at the bridge if it slips through. (Tasks 9 and 11.)
- **A receipt link or a browse label with script or a `javascript:` URL.** It is never rendered
  as a link, and it is escaped as text. (Tasks 10 and 16.)

---

## Part A: external sinks end to end

### Task 1: The HTTP sink adapter

**Files:**
- Create: `apps/bridge/src/sinks/http.ts`
- Test: `apps/bridge/test/http-sink.test.ts`

**Interfaces:**
- Consumes: `serveSink(sink, key)` (`sinks/serve.ts`), and the contract's sink schemas.
- Produces: `class HttpSink implements SinkPort`, constructed as `new HttpSink({ id, url, key,
  fetchImpl?, timeouts?: { short: number; long: number } })`.

- [ ] Write the failing tests. They run against `serveSink(new FakeSink(...))` on a real port,
  and against hand-rolled Fastify stubs:
  - describe, test, browse, deliver and status round-trip, equal to the fake's answers;
  - every request carries a signature that `verifyRequest` accepts, and a tampered key is
    refused;
  - a 422 `name_conflict` becomes `SinkError` with class `needs_user`, and its `details` are
    kept;
  - a 503, a timeout (stub that never answers, `short: 50`) and a refused connection are
    retryable (`sink_unavailable`, `timeout`);
  - a 401 is `internal`, with "the sink refused the bridge's signature: check its key";
  - a 200 whose body breaks the schema is `internal`, "the sink's answer is not valid", with no
    body echoed;
  - an answer over 8 MiB (deliver answers are receipts) is cut off as `internal`.
- [ ] Run them, and watch them fail.
- [ ] Implement it. It uses `signRequest` over the exact JSON bytes it sends, and
  `AbortSignal.timeout`.
- [ ] Make it green, and run the bridge suite.
- [ ] Commit: `feat(bridge): an HTTP adapter for external sinks`.

### Task 2: Registering sinks, and the describe cache

**Files:**
- Modify: `apps/bridge/src/config.ts`, `apps/bridge/src/wiring.ts` and `apps/bridge/src/sinks/port.ts`
- Create: `apps/bridge/src/sinks/registry.ts`
- Test: `apps/bridge/test/config.test.ts`, `apps/bridge/test/sink-registry.test.ts` and
  `apps/bridge/test/server-wiring.test.ts`

**Interfaces:**
- Produces:
  - `parseSinkEntries(env): SinkEntry[]`, where `SinkEntry = { id, url, key }`;
  - `class CachingSinkRegistry implements SinkRegistry`, constructed as `new
    CachingSinkRegistry(ports: Record<string, SinkPort>, { refreshSeconds, now? })`;
  - its `refresh(): Promise<void>` and `status(id): 'available' | 'unavailable'`.
  - `SinkRegistry` gains `status(id)`.
  - `MapSinkRegistry.status` is always `'available'`.

- [ ] Write the failing tests:
  - entries parse from `BRIDGE_SINKS` or `BRIDGE_SINKS_FILE`;
  - both set, a duplicate id, `s3`, a bad URL and a short key each refuse, naming the entry and
    never printing the key;
  - unset gives `[]`;
  - the cache describes each sink once on `refresh()`, and `get(id).describe()` doesn't call
    the sink again;
  - a failed refresh keeps the last good describe and marks the sink `unavailable`, and a later
    good one marks it `available`;
  - a sink never described has no describe;
  - with `BRIDGE_SINKS` unset, `buildFromConfig` gives exactly `s3` and `rdf`.
- [ ] Run them, and watch them fail.
- [ ] Implement it. `buildFromConfig` wraps `s3`, `rdf` and one `HttpSink` per entry, refreshes
  at start (without blocking the listen), and on an unref'd interval.
- [ ] Make it green.
- [ ] Commit: `feat(bridge): register external sinks from BRIDGE_SINKS, describes cached`.

### Task 3: The bridge treats external sinks as deliver-only; unavailable sinks refuse

**Files:**
- Modify:
  - `apps/bridge/src/deliveries/accept.ts`
  - `apps/bridge/src/routes/catalog.ts`
  - `packages/bridge-contract/src/producer-api.ts` (`SinkViewSchema` gains `destinationFields`
    and `credentialFields`)
  - `packages/bridge-contract/src/conformance/suite.ts`
  - `packages/bridge-contract/package.json` (0.5.0)
- Test:
  - `apps/bridge/test/catalog.test.ts`
  - `apps/bridge/test/deliveries-route.test.ts`
  - `apps/bridge/test/conformance-fake.test.ts`
  - `packages/bridge-contract/test/fixtures.test.ts`

**Interfaces:**
- Produces:
  - `SinkView.destinationFields: DestinationField[]`;
  - `SinkView.credentialFields: CredentialField[]`;
  - `effectiveCapabilities(sinkId, describe)`: an external sink's `withdraw` and `readBack`
    are false.

- [ ] Write the failing tests:
  - `GET /v1/sinks` lists an `HttpSink` with its fields, status from the cache, and an external
    sink's `withdraw`/`readBack` as false;
  - accept to an unavailable sink is `sink_unavailable` (retryable), and writes nothing;
  - the conformance suite's describe check fails a sink whose `accepts` lacks `files` or `data`;
  - the conformance suite passes against `serveSink(FakeSink)` reached through `HttpSink`
    (adapter and suite agree).
- [ ] Run them, and watch them fail.
- [ ] Implement it, and regenerate the bridge's OpenAPI.
- [ ] Make it green.
- [ ] Commit: `feat(bridge): external sinks are deliver-only for now; sink fields in the catalog (0.5.0)`.

### Task 4: CT Studio creates, edits and locks targets of any sink

**Files:**
- Modify:
  - `packages/shared/src/publish-targets.ts`
  - `apps/api/src/routes/publish-targets.ts`
  - `apps/api/src/publish-targets/{place,pg,repo}.ts` (choices take `sink`)
  - `apps/api/src/bridge/client.ts` and `apps/api/src/bridge/sync.ts` (the sink catalog)
  - `apps/api/test/fake-bridge.ts`
- Create: `apps/api/src/bridge/sinks.ts` (`SinkCatalog`)
- Test: `apps/api/test/publish-targets-routes.test.ts` and `apps/api/test/sink-catalog.test.ts`

**Interfaces:**
- Produces:
  - `TargetCreateBodySchema` variant `{ kind: 'sink', sinkId, instanceId, connectionId,
    destination }`;
  - `TargetPatchBodySchema` accepting `destination`;
  - `PublishTargetViewSchema` gains `sinkName` and `deliverOnly: boolean`;
  - `TargetChoiceSchema.kind` gains `'sink'`, and a choice gains `sinkName`;
  - `SinkCatalog` with `refresh(bridge)`, `get(id): SinkView | undefined` and `all()`;
  - `GET /api/publish-targets/sinks`, admin only, listing the catalog.

- [ ] Write the failing tests:
  - an admin creates a `fake` target: the bridge receives the sink, connection and destination,
    and the cache holds the bridge's answer;
  - a destination field the sink doesn't declare is the bridge's 422, passed through;
  - with a published recipe naming it, the sink, the instance and a fixed field are locked
    ("`space` is locked: …"), while the label, the connection and a pattern default can change;
  - choices include it with `sinkName: 'Fake sink'`;
  - with no external sink, the S3 create, edit and test behave as before (the existing tests,
    untouched).
- [ ] Run them, and watch them fail.
- [ ] Implement it. Regenerate `docs/openapi.json`.
- [ ] Make it green.
- [ ] Commit: `feat(api): targets of any registered sink`.

### Task 5: Recipes deliver to sink targets; the editor's target form

**Files:**
- Modify:
  - `apps/api/src/templates/definitions.ts` (drop the refusal, add the `rdf` issue)
  - `worker/src/ingest_worker/publish_targets.py` (`Target.sink_id`, optional S3 place, no
    refusal)
  - `worker/src/ingest_worker/bridge/package.py`
  - `worker/src/ingest_worker/withdrawal.py` (skips deliver-only targets)
  - the job-delete and retire confirmations (API and web)
  - `apps/web/src/access/{AddTargetDialog,TargetRow}.tsx`
- Create: `apps/web/src/access/SinkTargetFields.tsx`
- Test:
  - `apps/api/test/template-publish-target.test.ts`
  - `worker/tests/test_publish_targets.py`
  - `worker/tests/test_withdrawal.py`
  - `apps/web/test/PublishedOutputsPage.test.tsx`

**Interfaces:**
- Consumes: `SinkCatalog` (Task 4) and `SinkView.destinationFields` (Task 3).
- Produces:
  - `SinkTargetFields({ sink, value, onChange, locked })`, the form generated from the declared
    fields: fixed fields as inputs, pattern fields as pattern inputs, the instance picker for
    personal sinks, and the connection picker for shared ones;
  - a read-only *Systems* list on Published outputs, showing each sink's name, status, contract
    version and capabilities (the spec's "Sink registry").

- [ ] Write the failing tests:
  - a recipe naming `default` plus a `fake` target has no issue, while a recipe whose formats
    include `rdf` naming a sink without `rdf` has the issue;
  - the worker's `LiveTargets.get` returns a sink target with `sink_id='fake'` and no bucket,
    and `deliver_outputs` sends both targets in one request;
  - withdrawal skips the `fake` target and still withdraws from `default`;
  - deleting a job lists "This content stays in Fake target";
  - Published outputs: Add target offers the registered sinks, renders `space` and `name` from
    the sink's fields, and saves; a sink target's row is editable, and locked fields are
    disabled;
  - the *Systems* list shows `Fake sink`, available, contract 1, deliver-only;
  - the existing S3 tests are unchanged.
- [ ] Run them, and watch them fail.
- [ ] Implement it.
- [ ] Make it green: the API, worker and web suites.
- [ ] Commit: `feat: recipes deliver to external sink targets`.

### Task 6: The fake external sink in compose, the smoke, CI; docs

**Files:**
- Create: `apps/bridge/src/sinks/fake-server.ts`
- Modify:
  - `apps/bridge/package.json` (build includes it)
  - `deploy/docker-compose.yml` (service `fake-sink`, profile `fake-sink`, from the bridge image,
    no host port)
  - `deploy/scripts/smoke-test.sh` (section `SMOKE_EXTERNAL=1`)
  - `.github/workflows/ci.yml`:
    - set `BRIDGE_SINKS` and start the profile in the `stack` job;
    - run the conformance image against `fake-sink` before the smoke
  - `deploy/.env.example` (`BRIDGE_SINKS`, commented)
  - deploy README
  - the spec ("Phase 6 part A as built")
  - ADR 0017
  - CLAUDE.md (the contracts table, and the Delivery bridge paragraph)
  - release notes
- Test: `apps/bridge/test/fake-server.test.ts`, plus the smoke itself in CI.

- [ ] Write the failing test: `fake-server` serves the signed sink routes, and `GET /_delivered`
  lists deliveries without file bytes.
- [ ] Run it, and watch it fail.
- [ ] Implement it.
- [ ] Make it green.
- [ ] Write the smoke section:
  - create a `fake` target through the API;
  - upload with a recipe naming `default` and the fake target;
  - approve;
  - wait for `succeeded`;
  - assert one delivery in `/_delivered` carrying the package's idempotency key;
  - approve a second job of the same file, and assert that the fake recorded a replace, not a
    second copy.
- [ ] Run the smoke on a throwaway compose project. Expected: every section `ok`. Run the
  conformance image locally against `fake-sink`. Expected: every check passes.
- [ ] Commit: `feat(deploy): a fake external sink in the compose smoke and CI; docs`.

---

## Part B: names

### Task 7: Patterns and naming inputs (contract 0.6.0)

**Files:**
- Create:
  - `packages/bridge-contract/src/naming.ts`
  - `packages/bridge-contract/test/fixtures/naming.json`
  - `worker/src/ingest_worker/bridge/naming.py`
- Modify:
  - `worker/src/ingest_worker/bridge/package.py` (fills `naming`)
- Create: `apps/api/src/bridge/naming.ts` (`namingInputsOf(doc, job, recipe)`)
- Test:
  - `packages/bridge-contract/test/naming.test.ts`
  - `apps/api/test/naming-inputs.test.ts`
  - `worker/tests/test_bridge_naming.py`

**Interfaces:**
- Produces:
  - `parsePattern`, `patternVariables` and `resolvePattern`, as specified;
  - `NAMING_VARIABLES`;
  - `naming_inputs(document, job, template, published_at) -> dict[str, str]`, with TS
    `namingInputsOf(...)` the same.

`naming.json` holds:
- `inputs` cases: a document, job and recipe in, and a map out. It covers a number, a list, a
  null field, a field with `/`, and `date` at 23:59:59 and at 00:00:00 UTC.
- `patterns` cases: a pattern and inputs in, and `{ value }`, `{ unresolved }` or `{ error }`
  out. It covers a default chain ending in a literal, `{{`, an unknown variable and an
  unbalanced brace.

- [ ] Write the failing tests. TS and Python each read every fixture case, TS for both resolving
  and inputs, and Python for inputs.
- [ ] Run them, and watch them fail.
- [ ] Implement it. A package built for an unchanged recipe changes only in `naming`. The
  idempotency key and the files are byte-identical: assert that with `test_bridge_package.py`.
- [ ] Make it green.
- [ ] Commit: `feat(contract): patterns and naming inputs (0.6.0)`.

### Task 8: Recipe settings per target

**Files:**
- Modify:
  - `packages/shared/src/template.ts` (`DeliverySchema.settings`)
  - `worker/src/ingest_worker/template.py` (`Delivery.settings`)
  - `apps/api/src/templates/definitions.ts`
  - `apps/api/src/routes/publish-targets.ts` (`POST /api/publish-targets/preview { pattern,
    specId }`, resolved against the recipe's latest job with a document, else the variable
    list)
  - `apps/web/src/templates/TemplateEditor.tsx` (`PublishToPicker` shows each picked target's
    pattern fields, with a preview from that route)
- Create: `packages/shared/test/fixtures/delivery-settings.json`
- Test:
  - `packages/shared/test/template.test.ts`
  - `worker/tests/test_template.py`
  - `apps/api/test/template-publish-target.test.ts`
  - `apps/web/test/TemplateEditor.test.tsx`

**Interfaces:**
- Produces: `DeliverySchema.settings?: Record<TargetId, Record<string, string>>`, and Python
  `Delivery.settings: dict[str, dict[str, str]] = {}`.

- [ ] Write the failing tests:
  - the fixture parses on both sides;
  - a recipe without `settings` keeps its hash (an existing golden);
  - issues:
    - a setting for a target not in `publishTo`;
    - a fixed field;
    - an unparsable pattern, with the parse error's text;
    - `{field:nope}`;
    - a required pattern field with no setting and no target default;
  - the editor shows `name` under the picked fake target, previews it against the recipe's
    latest job ("Preview: Q3 report.docx"), and writes `settings` only when a value is entered.
- [ ] Run them, and watch them fail.
- [ ] Implement it. Update the Template format row of CLAUDE.md.
- [ ] Make it green.
- [ ] Commit: `feat: per-target name patterns in recipes`.

### Task 9: The bridge resolves at accept

**Files:**
- Modify:
  - `packages/bridge-contract/src/producer-api.ts` (`CreateDeliveriesRequest.patterns`)
  - `worker/src/ingest_worker/bridge/models.py`
  - `worker/src/ingest_worker/bridge/package.py` (sends `patterns` from the recipe and
    `overrides` from the job)
  - `apps/bridge/src/deliveries/{accept,runner,repo,pg}.ts`
  - `db/bridge-migrations/<new>_resolved_destination.sql`
  - `apps/bridge/src/routes/targets.ts` (`checkTarget` parses pattern defaults)
- Test:
  - `apps/bridge/test/deliveries-route.test.ts`
  - `apps/bridge/test/runner.test.ts`
  - `apps/bridge/test/targets-routes.test.ts`
  - `worker/tests/test_bridge_package.py`
  - the shared `delivery-request.json` fixture (it gains `patterns`)

**Interfaces:**
- Produces:
  - `deliveries.destination jsonb`, the resolved destination;
  - `resolveDestination(fields, targetDestination, patterns, overrides, naming) → {
    destination } | BridgeError`.

- [ ] Write the failing tests:
  - accept resolves `name` from the target default, from the recipe pattern, and from a
    reviewer override (in that precedence), and records it;
  - the runner sends the recorded destination;
  - accept refuses `pattern_unresolved` (details `{targetId, field, variables}`), an override of
    a fixed field, and an override of an undeclared field, before anything is written;
  - `checkTarget` refuses an unparsable default pattern;
  - an S3 target with no pattern fields is delivered exactly as before;
  - the worker sends `patterns` and the job's overrides, and an auto-published job sends none.
- [ ] Run them, and watch them fail.
- [ ] Implement it, and regenerate both OpenAPI documents.
- [ ] Make it green, including the opt-in Pg deliveries test.
- [ ] Commit: `feat(bridge): pattern fields resolved and checked at accept`.

### Task 10: Browse

**Files:**
- Modify:
  - `packages/bridge-contract/src/producer-api.ts` (`TargetBrowseRequestSchema`)
  - `apps/bridge/src/routes/targets.ts`
  - `apps/api/src/bridge/client.ts`
  - `apps/api/src/routes/publish-targets.ts`
  - `apps/web/src/access/SinkTargetFields.tsx`
- Create: `apps/web/src/access/BrowseDialog.tsx`
- Test:
  - `apps/bridge/test/targets-routes.test.ts`
  - `apps/api/test/publish-targets-routes.test.ts`
  - `apps/web/test/BrowseDialog.test.tsx`

**Interfaces:**
- Produces:
  - `POST /v1/targets:browse` → `BrowseResult`;
  - `BridgeApi.browse(req)`;
  - `POST /api/publish-targets/browse`, admin only;
  - `BrowseDialog({ api, sinkId, instanceId, connectionId, field, onPick, onClose })`.

- [ ] Write the failing tests:
  - the bridge browses a shared sink with the target's connection, and a personal sink with the
    acting admin's own connection, never another user's; with none, the answer is
    `connection_missing`, and the dialog says "Add your connection for <instance> first" with
    *Manage connections*;
  - a field that is not `browse` is refused;
  - the dialog loads one level, expands a node, pages with "More", and picks a `selectable`
    node only;
  - a node label `<img src=x onerror=…>` renders as text.
- [ ] Run them, and watch them fail.
- [ ] Implement it.
- [ ] Make it green.
- [ ] Commit: `feat: browse a sink's tree in the target editor`.

### Task 11: Review overrides

**Files:**
- Modify:
  - `packages/shared/src/jobs.ts` (`ApproveRequestSchema.overrides`, `JobNamingSchema`)
  - `apps/api/src/routes/review.ts`
  - `apps/api/src/repositories/{pg,memory,types}.ts`
  - `db/migrations/<new>_delivery_overrides.sql` (`jobs.delivery_overrides`)
  - `worker/src/ingest_worker/queue.py` (reads them)
  - `apps/web/src/review/DecisionBar.tsx`
  - `apps/web/src/review/ReviewPage.tsx`
  - `apps/web/src/api/client.ts`
- Test:
  - `apps/api/test/review.test.ts`
  - the Pg review test
  - `worker/tests/test_template_pipeline.py`
  - `apps/web/test/ReviewPage.test.tsx`

**Interfaces:**
- Produces: `GET /api/jobs/:id/naming` → `JobNaming = { targets: [{ targetId, label, fields:
  [{ id, label, pattern, value | null, unresolved: string[], conflict: string | null }] }] }`.

- [ ] Write the failing tests:
  - naming lists the fake target's `name`, resolved against the review draft;
  - approve with an override stores it, and the worker sends it;
  - an override of `space`, of a target not in the recipe, or with an empty value is 400,
    naming the field;
  - a re-approve replaces the stored overrides;
  - the review screen's *Names* section shows the resolved value, sends the edited one, and is
    absent when no target has an overridable field.
- [ ] Run them, and watch them fail.
- [ ] Implement it.
- [ ] Make it green, with the Pg review test.
- [ ] Commit: `feat: reviewers can rename what a delivery creates`.

### Task 12: Name conflicts; docs for part B

**Files:**
- Modify:
  - `apps/api/src/bridge/events.ts`
  - `apps/api/src/repositories/{pg,memory}.ts`
  - `db/migrations/<new>_delivery_error.sql` (`job_deliveries.error jsonb`)
  - `apps/api/src/routes/review.ts` (naming marks conflicts)
  - `apps/bridge/src/sinks/fake-server.ts`: `name` values starting `taken-` answer
    `name_conflict`, so the smoke can show one
  - `deploy/scripts/smoke-test.sh`
  - the spec ("Phase 6 part B as built")
  - CLAUDE.md
  - release notes
  - help: a topic for names and overrides, in `HELP_INDEX`
- Test:
  - `apps/api/test/bridge-events.test.ts`
  - `apps/api/test/review.test.ts`
  - `apps/web/test/ReviewPage.test.tsx`
  - the help index test

- [ ] Write the failing tests:
  - a `name_conflict` event with `details.field: 'name'` stores the error, sends the job to
    review, and marks the field in naming;
  - approving with a new name re-delivers, and the conflict clears once that delivery succeeds;
  - the review screen highlights the field with the conflict text.
- [ ] Run them, and watch them fail.
- [ ] Implement it.
- [ ] Make it green.
- [ ] Extend the smoke: a recipe pattern `taken-{source.stem}` goes to review; approving with
  another name succeeds.
- [ ] Commit: `feat: name conflicts go back to review, naming the field; docs`.

---

## Part C: the right person

### Task 13: The reviewer by id, and the last deliverer

**Files:**
- Modify:
  - `db/migrations/<new>_acting_users.sql` (`jobs.reviewer_user_id`, `jobs.delivered_as_user`)
  - `apps/api/src/routes/review.ts`
  - `apps/api/src/repositories/pg.ts`
  - `worker/src/ingest_worker/queue.py` (`reviewer()` by id first, `last_deliverer()`,
    `record_delivered_as()`)
  - `worker/src/ingest_worker/bridge/package.py`
  - `worker/src/ingest_worker/rdf_rebuild.py`
- Test:
  - `apps/api/test/review.test.ts` (Pg)
  - `worker/tests/test_queue.py` (Pg)
  - `worker/tests/test_rdf_rebuild.py`
  - `worker/tests/test_bridge_package.py`

- [ ] Write the failing tests:
  - approve records `reviewer_user_id`;
  - `reviewer()` returns that user even after they are renamed, and falls back to the name
    match for a job with no id;
  - an accepted package records `delivered_as_user`;
  - a rebuild acts as the last deliverer, then the reviewer, then the uploader.
- [ ] Run them, and watch them fail.
- [ ] Implement it.
- [ ] Make it green, including the opt-in Pg files.
- [ ] Commit: `feat: reviewers by id, re-deliveries as the last deliverer`.

### Task 14: Fallbacks, proved through the worker

**Files:**
- Test: `worker/tests/test_template_pipeline.py` and `worker/tests/test_outcomes.py`, against a
  fake bridge that applies accept's personal-connection rule.

- [ ] Write the tests. They should pass already, through phase 5's accept; write them first and
  watch them run:
  - auto-publish with no uploader, to a personal target, goes to review with "delivering to
    <label> needs a person to deliver as";
  - an uploader without a connection goes to review naming them;
  - the re-approval delivers as the approver;
  - a reviewer without a connection goes back to review naming the reviewer;
  - no shared connection is ever used.

  Any test that fails is a finding: fix it red→green and record the ruling.
- [ ] Commit: `test(worker): acting-user fallbacks through review`.

### Task 15: The upload preflight

**Files:**
- Modify:
  - `packages/bridge-contract/src/producer-api.ts` (`PreflightRequestSchema`,
    `PreflightResultSchema`; 0.7.0)
  - `apps/bridge/src/deliveries/accept.ts` (shares its target checks with preflight)
  - `apps/bridge/src/routes/deliveries.ts`
  - `apps/api/src/bridge/client.ts`
  - `apps/api/src/routes/documents.ts`
  - `packages/shared/src/roles.ts` (operators may call it)
  - `apps/web/src/jobs/UploadStrip.tsx`
- Test:
  - `apps/bridge/test/deliveries-route.test.ts`
  - `apps/api/test/documents.test.ts`
  - `apps/web/test/UploadStrip.test.tsx`

**Interfaces:**
- Produces:
  - `POST /v1/deliveries:preflight`;
  - `BridgeApi.preflight(targets, actingUser)`;
  - `POST /api/documents/preflight { specId }` → `{ problems: { targetLabel, message }[] }`.

- [ ] Write the failing tests:
  - preflight reports a personal target the uploader has no connection for, and nothing for
    shared targets;
  - the API answers no problems when the bridge is down (the upload never depends on it), and
    logs it;
  - the upload strip shows the warning with *Manage connections* when a spec is picked, and
    the upload still goes ahead.
- [ ] Run them, and watch them fail.
- [ ] Implement it.
- [ ] Make it green.
- [ ] Commit: `feat: warn at upload when a target needs a connection the uploader lacks`.

### Task 16: Reviews held up by a connection; receipts; docs for part C

**Files:**
- Modify:
  - `db/migrations/<new>_connection_needed.sql` (`jobs.connection_needed`,
    `job_deliveries.receipt jsonb`)
  - `worker/src/ingest_worker/queue.py`
  - `worker/src/ingest_worker/template_pipeline.py` (sets it from `BridgeRefused.error.code`)
  - `apps/api/src/bridge/events.ts`
  - `apps/api/src/routes/{review,jobs}.ts`
  - `packages/shared/src/jobs.ts` (`JobDeliveryView.links`, `ReviewView.connectionNeeded`)
  - `apps/web/src/review/ReviewHeader.tsx`
  - `apps/web/src/jobs/JobDetailPanel.tsx`
  - the spec ("Phase 6 part C as built", and phase 6 done)
  - ADR 0017
  - CLAUDE.md
  - release notes
  - help
- Test:
  - `worker/tests/test_template_pipeline.py`
  - `apps/api/test/bridge-events.test.ts`
  - `apps/api/test/review.test.ts`
  - `apps/web/test/ReviewPage.test.tsx`
  - `apps/web/test/JobDetailPanel.test.tsx`

- [ ] Write the failing tests:
  - a `connection_missing` refusal at accept, or a `credential_rejected` delivery event, sets
    `connection_needed`, and approve clears it;
  - the review header shows *Manage connections* only then;
  - the job panel shows the fake receipt's links, and drops a `javascript:` URL.
- [ ] Run them, and watch them fail.
- [ ] Implement it.
- [ ] Make it green.
- [ ] Run the full gate, and the throwaway compose smoke with `SMOKE_EXTERNAL=1`.
- [ ] Commit: `feat: reviews held up by a connection say so; receipts on the job; docs`.
