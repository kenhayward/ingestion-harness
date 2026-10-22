# Delivery bridge, phase 5: personal connections — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any CT Studio user can add, test, update, rename and delete their own connections to
a personal-connection sink on the bridge's connections page. Profile shows a secret-free
summary of them, a credential failure flags the connection, and a disabled user's connections
are deleted.

**Architecture:**

- **The bridge's page gains a personal slice for every role.** It is next to the admins' shared
  slice. A user picks a sink whose `describe` says `connectionKind: personal`, then one of its
  instances, names the connection and enters the credential fields. The test runs against that
  instance and shows who the sink thinks the user is. Each user holds at most one connection per
  sink and instance.
- **Deliveries to a personal sink use the acting user's connection.** The bridge refuses at
  accept time when there is none (`connection_missing`). The runner looks the connection up for
  each attempt, so the existing health marking (`ok` with last used, or `needs_attention`) now
  covers personal connections too.
- **CT Studio sees summaries only.** Signed routes list one owner's summaries, delete one owner's
  connections, and reconcile against the list of live users. The API serves `GET /api/me/connections`
  to Profile. Disabling a user deletes their connections, and an hourly reconcile catches any
  miss.
- **Nothing in CT Studio can deliver to a personal sink yet.** `sink` targets stay refused until
  phase 6, and no built-in sink is personal. Phase 5 is proved with the fake sink made personal,
  in the bridge's own tests.

**Tech stack:** as in phase 4. No new dependency.

**Spec:** [docs/superpowers/specs/2026-10-19-delivery-bridge-design.md](../specs/2026-10-19-delivery-bridge-design.md):
the phase 5 row, Goals 3–5, "Connections and the connections page", "Talking to the bridge"
(browser handoff) and "Delivering" (the accept-time checks).

**Builds on:** the [phase 4 plan](2026-10-21-delivery-bridge-4-several-targets.md), the spec's
"Phase 2 as built" to "Target registry as built", and [ADR 0017](../../adr/0017-delivery-bridge.md).

## Global constraints

- Everything in the earlier phases' global constraints still applies:
  - TDD, red first;
  - tests stay offline;
  - the same contract on both sides, with shared fixtures;
  - no vendor names of private external sinks anywhere.
- The gate before saying anything is done: `npm run check`, `npm run format:check`,
  `npm run worker:test` and `npm run worker:lint`.
- Stage files by name; never `git add -A`.
- **Nothing secret reaches CT Studio.** No route the producer calls answers a secret, a credential
  field, or a personal connection's `fields`. CT Studio's API and web never see a personal
  credential, and its logs never name one.
- **One user never sees or changes another's personal connection.** That covers the page, the
  signed routes, and the summaries. An admin is no exception: admins manage shared connections,
  and only their own personal ones.
- **Shared connections behave as today.** The admin slice of the page, `PUT /v1/connections/:id`,
  the key move and Published outputs don't change.

## Decisions this plan makes (within "left to the builder"; recorded in the spec by Task 8)

- **One personal connection per (owner, sink, instance).** The spec says "one per named
  instance", and the runner needs exactly one to pick. This is a partial unique index
  `NULLS NOT DISTINCT`, because a personal sink with no instances has a null instance. Adding
  a second connection for the same instance is refused with "You already have a connection for
  <instance>: update that one".
- **Users never type an id.** A personal connection's id is `u-` plus 16 random hex characters.
  Names are free text, 1 to 80 characters, and don't have to be unique.
- **"When a CT Studio user is removed" means disabled.** CT Studio never deletes users, only
  disables them.
  - Disabling a user deletes their personal connections on the bridge, after the disable is
    stored.
  - A bridge failure there is logged and doesn't undo the disable. The reconcile finishes the job.
  - Enabling the user again restores nothing; they add their connections again.
  - Why: a disabled person's API tokens should not stay usable, and the spec's rule ("if the
    chosen person, or their connection, no longer exists, the job goes to review") already
    covers what happens to their jobs.
- **The reconcile sends enabled users' ids**, hourly and once at start, to `POST /v1/users:reconcile`.
  - The bridge deletes every personal connection whose owner is not in the list.
  - An empty list is refused (422 `content_rejected`), so a broken query can never wipe everyone.
  - A deployment with no users skips the call.
- **`GET /v1/connections` no longer lists every owner.**
  - `kind=shared` and no `kind` answer the shared connections only.
  - `kind=personal` needs `owner`, and lists that owner's connections. Without it the answer is
    400.
  - Why: today a list with no `kind` would hand the producer every user's connection names.
- **Summaries gain `kind`, `instanceId` and `lastUsedAt`.** Contract 0.4.0, additive.
  - A personal summary's `fields` is always `{}`. A username is the user's own, but it isn't
    CT Studio's to show.
  - `SinkViewSchema` gains `instances` (id, label), so Profile can show an instance's label.
- **Targets of a personal sink name no connection.** `checkTarget` refuses a `connectionId` on a
  personal sink's target. It requires `instanceId` to be one of the sink's instances when the sink
  declares any, and null when it declares none.
- **Accept-time checks**, for each target whose sink is personal:
  - no `actingUser`: `connection_missing`, "delivering to <label> needs a person to deliver as";
  - no connection for (actingUser.id, sink, instance): `connection_missing`, "<name> has no
    connection for <label>: add one on the connections page", with details `{targetId, userId}`.
- **The runner looks the connection up on every attempt**, not once at accept. A connection
  deleted meanwhile ends the delivery `needs_user` with `connection_missing`, and a replaced
  credential is used at once. `deliveries` gets no `connection_id` column: the health marking
  needs only the id the attempt used.
- **The page's personal slice:**
  - `GET /connections` shows "Your connections" to everyone, with the shared table below it for
    admins.
  - Add, edit, re-test, rename and delete work as in the shared slice, scoped to the owner. A
    connection that isn't the session user's own answers 404.
  - "Save even if the test fails" stays.
  - The test's identity is shown after a passing test: "Connected as <identity>".
  - There is no "Add" button when no sink is personal. The text then says that no system here
    uses personal connections yet.
- **The Profile tab** is "Connections". It lists name, system (the sink's name), instance label,
  status (with the reason when it needs attention) and last used. Its button is "Manage
  connections", and it is open to every role. With no personal sink it says so, and still offers
  the button.
- **Left for phase 6:**
  - the upload preflight;
  - review reasons that link to the connection;
  - the worker's acting-user fallbacks (no uploader, or a missing person, sends the job to
    review with the approver acting);
  - tracking the last deliverer for system re-deliveries.

  All of these matter only once a recipe can name a personal sink's target.

## Review Focus

- **A user reaching another user's connection by id.** That covers the page's `GET/POST
  /connections/:id`, `/test` and `/delete` with someone else's `u-…` id, an admin included. The
  answer is 404, and nothing changes. (Task 5 tests each route.)
- **A personal secret leaving the bridge.** Check every producer-facing answer and the page's
  HTML after a save: no secret value, and no personal `fields`. (Tasks 3 and 5 assert on the
  serialised body.)
- **The reconcile with a short or empty list.** An empty list is refused. A list that names only
  some users deletes exactly the others' personal connections, and never a shared one. (Task 3.)
- **A delivery whose connection is deleted between accept and run.** It ends `needs_user`
  `connection_missing`, it isn't retried as retryable, and no other user's connection is used.
  (Task 4.)
- **Disable while the bridge is down.** The disable still succeeds and answers 200, the failure is
  logged with the user id, and the next reconcile deletes the connections. (Task 6.)

---

### Task 1: Contract 0.4.0

**Files:**
- Modify: `packages/bridge-contract/src/producer-api.ts`, `packages/bridge-contract/package.json`
  (0.4.0), `packages/bridge-contract/src/conformance/suite.ts`
- Create: `packages/bridge-contract/test/fixtures/connection-summary.json`
- Test: `packages/bridge-contract/test/fixtures.test.ts`, the conformance tests
- Regenerate the bridge's OpenAPI snapshot the way earlier phases did (`openapi.test.ts`).

**Interfaces:**
- Produces:
  - `ConnectionSummarySchema` gains `kind: 'shared'|'personal'`, `instanceId: string|null` and
    `lastUsedAt: string(datetime)|null`;
  - `SinkViewSchema` gains `instances: {id,label}[]`;
  - `ConnectionListQuerySchema = {kind?: 'shared'|'personal', owner?: string(min 1)}`;
  - `UsersReconcileRequestSchema = {liveUserIds: string(min 1)[] (min 1)}`;
  - `ConnectionsDeletedSchema = {deleted: int ≥ 0}`.

- [ ] Write the failing tests:
  - the fixture `connection-summary.json` holds one shared summary (with `fields`) and one
    personal summary (`fields: {}`, `instanceId: "sandbox"`, `lastUsedAt` set), and both parse
    and re-serialise unchanged;
  - `UsersReconcileRequestSchema` refuses `{liveUserIds: []}`;
  - the conformance suite's new check "a personal sink declares credential fields" fails for a
    personal describe with no `credentialFields`, and passes for `describe.json`.
- [ ] Run them and watch them fail.
- [ ] Implement the schemas and the check, bump the version, and regenerate the OpenAPI snapshot.
- [ ] Make it green. Run `npm run check -w @ih/bridge-contract` (or the repo's equivalent) and
  `npm run typecheck`. Every consumer of the strict summary now fails to compile where it builds
  one; fix the builders in `apps/bridge/src/routes/connections.ts` and the API's fake bridge
  with the minimal values (`kind`, `instanceId: null`, `lastUsedAt`). `catalog.ts` adds
  `instances`.
- [ ] Commit: `feat(contract): personal connection summaries, reconcile, sink instances (0.4.0)`.

### Task 2: Bridge store: one connection per owner and instance

**Files:**
- Create: `db/bridge-migrations/202610221200_personal_connections.sql`
- Modify: `apps/bridge/src/connections/{repo,pg}.ts`
- Test: `apps/bridge/test/connections-contract.ts` (runs on memory and Pg)

**Interfaces:**
- Produces, on `ConnectionRepo`:
  - `findPersonal(owner: string, sinkId: string, instanceId: string|null): Promise<Connection|null>`
  - `removeOwner(owner: string): Promise<number>` (personal only)
  - `removeOwnersNotIn(owners: string[]): Promise<number>` (personal only)
  - `put` refuses a second personal connection for the same (owner, sink, instance) with a
    different id, throwing `ConnectionConflict`.
  - `Connection` gains `createdAt: Date`.

The migration:

```sql
CREATE UNIQUE INDEX connections_personal_instance
  ON connections (owner, sink_id, instance_id) NULLS NOT DISTINCT WHERE kind = 'personal';
CREATE INDEX connections_owner ON connections (owner) WHERE owner IS NOT NULL;
```

- [ ] Write the failing contract tests:
  - `findPersonal` finds by owner, sink and instance, including a null instance, and never returns
    another owner's or a shared connection;
  - a second personal connection for the same triple throws `ConnectionConflict`, and the same id
    updates;
  - `removeOwner('u1')` deletes u1's two personal connections, returns 2, and keeps u2's and the
    shared ones;
  - `removeOwnersNotIn(['u1'])` deletes u2's and keeps u1's and the shared ones.
- [ ] Run them on memory and Pg, and watch them fail.
- [ ] Implement. On Pg, map the unique violation (23505 on `connections_personal_instance`) to
  `ConnectionConflict`.
- [ ] Make it green: `npx vitest run apps/bridge/test/connections-repo.test.ts` and the opt-in Pg
  file.
- [ ] Commit: `feat(bridge): one personal connection per owner and instance`.

### Task 3: Bridge producer routes: owner summaries, delete by user, reconcile

**Files:**
- Modify: `apps/bridge/src/routes/connections.ts`, `apps/bridge/src/routes/targets.ts` (`checkTarget`)
- Test: `apps/bridge/test/connections-routes.test.ts`, `apps/bridge/test/targets-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's schemas and Task 2's repo methods.
- Produces (all signed):
  - `GET /v1/connections?kind=personal&owner=<id>` lists that owner's personal summaries;
    `kind=personal` without `owner` is 400; no `kind` lists shared only;
  - `DELETE /v1/users/:userId/connections` → 200 `{deleted}`;
  - `POST /v1/users:reconcile` → 200 `{deleted}`, or 422 for an empty list.

- [ ] Write the failing tests:
  - the owner list holds the owner's connections only, each with `fields: {}`, and the serialised
    body contains neither the stored secret nor the stored username;
  - no `kind` no longer lists personal rows;
  - the delete and reconcile counts match, and shared rows survive both;
  - the reconcile refuses `[]` with 422;
  - `checkTarget` on a personal fake sink with instances `[sandbox]`: a `connectionId` is 422
    "a personal sink's target names no connection", `instanceId: "other"` is 422, and
    `instanceId: "sandbox"` with no connection is accepted.
- [ ] Run them and watch them fail.
- [ ] Implement.
- [ ] Make it green, and run the bridge suite.
- [ ] Commit: `feat(bridge): a user's connection summaries, deletion and reconcile`.

### Task 4: Deliveries use the acting user's connection

**Files:**
- Modify: `apps/bridge/src/deliveries/{accept,runner}.ts`, `apps/bridge/src/sinks/fake.ts`,
  `apps/bridge/src/wiring.ts` (pass `connections` into `AcceptDeps`)
- Test: `apps/bridge/test/deliveries-route.test.ts`, `apps/bridge/test/runner.test.ts`,
  `apps/bridge/test/fake-sink.test.ts`

**Interfaces:**
- Consumes: `ConnectionRepo.findPersonal`.
- Produces:
  - `AcceptDeps.connections: ConnectionRepo`;
  - `FakeSink.scriptTest(...errors: ErrorCode[])` makes the next `testConnection` calls throw
    these codes, in order, and then pass; the identity is `fake:<credential.username ?? 'user'>`.

- [ ] Write the failing tests:
  - accept refuses a personal target with a null `actingUser`, and when the acting user has no
    connection (`connection_missing`, details `{targetId, userId}`). Nothing is written;
  - accept passes with the user's connection, and a shared target is unchanged;
  - the runner sends the acting user's credential (not another user's) and marks *that*
    connection `ok` with `last_used_at`. `credential_rejected` marks it `needs_attention`;
  - a connection deleted between accept and run ends the delivery `needs_user`
    `connection_missing`, after one attempt;
  - `scriptTest` throws then passes, and reports the identity.
- [ ] Run them and watch them fail.
- [ ] Implement. For a personal sink, `step()` sets `used.connectionId` from `findPersonal` and
  resolves that id.
- [ ] Make it green, and run the bridge suite.
- [ ] Commit: `feat(bridge): deliveries to a personal sink use the acting user's connection`.

### Task 5: The connections page's personal slice

**Files:**
- Modify: `apps/bridge/src/page/{routes,html}.ts`
- Test: `apps/bridge/test/page.test.ts`

**Interfaces:**
- Consumes: Task 2 (`findPersonal`, `ConnectionConflict`, `list({kind:'personal', owner})`) and
  Task 4's `scriptTest`.
- Produces the page routes, unchanged in path: `GET /connections`, `GET /connections/:id`,
  `POST /connections`, `POST /connections/:id`, `/test` and `/delete`. Each one decides by the
  connection's kind:
  - **shared** needs an admin;
  - **personal** needs `owner === session.user.id`, and otherwise answers 404.
- The add form posts `kind=personal`, `sinkId`, `instanceId`, `name` and the credential fields.

- [ ] Write the failing tests. The fake sink is personal, with instances `sandbox` and `prod`,
  and credential fields `username` and `password` (secret):
  - an operator's list shows "Your connections", with no shared table and no "Personal
    connections arrive later";
  - an operator adds one:
    - the test is called with `instanceId: "sandbox"`;
    - the row is personal, owned by the operator, with an id matching `^u-[0-9a-f]{16}$`;
    - the page shows "Connected as fake:alice", and the HTML never contains the password;
  - a failing test does not save, unless "Save even if the test fails" is ticked (it is then
    saved `untested` with the reason);
  - a second connection for `sandbox` is refused with "You already have a connection for
    Sandbox: update that one";
  - update with a blank password keeps the stored secret; rename works; delete removes it;
  - another operator, and an admin, get 404 on GET, update, test and delete of it, and the row is
    unchanged;
  - an admin sees their own personal connections and the shared table;
  - with no personal sink, the list says "No system here uses personal connections yet" and has
    no Add form;
  - CSRF is still required on every personal POST.
- [ ] Run them and watch them fail.
- [ ] Implement.
  - `adminPost` becomes `formPost`, which checks the session and CSRF. The kind rule above
    decides the rest.
  - `personalSinks()` sits beside `sharedSinks()`.
  - The instance select is filled from `describe.instances`.
  - `tryCredential` takes `instanceId`, and returns the identity or the failure message.
- [ ] Make it green, and run the bridge suite.
- [ ] Commit: `feat(bridge): personal connections on the connections page`.

### Task 6: CT Studio API: summaries, link for everyone, disable and reconcile

**Files:**
- Modify:
  - `apps/api/src/bridge/client.ts`
  - `apps/api/src/routes/bridge.ts`
  - `apps/api/src/access/users-routes.ts` (the disable paths: `toggle(false)`, and the `PATCH`
    that disables)
  - `apps/api/src/server.ts`
  - `apps/api/test/fake-bridge.ts`
- Create: `apps/api/src/bridge/users-reconcile.ts`
- Test: `apps/api/test/bridge-client.test.ts`, `apps/api/test/bridge-routes.test.ts`, the users
  routes test, `apps/api/test/users-reconcile.test.ts`

**Interfaces:**
- Consumes: the Task 1 schemas and Task 3's routes.
- Produces:
  - `BridgeApi.listPersonalConnections(owner: string): Promise<ConnectionSummary[]>`;
  - `BridgeApi.deleteUserConnections(userId: string): Promise<number>`;
  - `BridgeApi.reconcileUsers(liveUserIds: string[]): Promise<number>`;
  - `BridgeApi.listSinks(): Promise<SinkView[]>` (unless it exists already);
  - `GET /api/me/connections` → `{ personalSinks: boolean, connections: { id, name, sinkName,
    instanceLabel, status, statusReason, lastUsedAt }[] }`. Every signed-in role can call it. It
    answers 502 `connections are unavailable right now` when the bridge is down. There is no
    `fields` and no `sinkId` beyond the name;
  - `POST /api/bridge/connections-link` is open to every signed-in role. The handoff still carries
    the role;
  - `reconcileUsersOnce(deps: { users: { enabledIds(): Promise<string[]> }; bridge: BridgeApi;
    log }): Promise<void>`. It skips the call when the list is empty, and logs failures without
    throwing.

- [ ] Write the failing tests:
  - an operator gets their own summaries only: the fake bridge is asked with `owner =
    req.auth.userId`;
  - the instance label comes from the sink's instances, and falls back to the id;
  - the bridge down gives 502;
  - an operator's `connections-link` is 200 (it was 403), and the handoff user has role
    `operator`;
  - disabling a user calls `deleteUserConnections(id)` once, after the disable is stored. With the
    bridge throwing, it still answers 200 and logs `{userId}`. Enabling never calls it;
  - `reconcileUsersOnce` sends the enabled ids, skips an empty list, and swallows a bridge failure;
  - `server.ts` runs it once at start and hourly, the same way `reconcileOnce` is wired.
- [ ] Run them and watch them fail.
- [ ] Implement. Use the access repo's existing user listing for enabled ids. If none fits, add
  `enabledUserIds(): Promise<string[]>` to the repo, on memory and Pg, with its test. Regenerate
  `docs/openapi.json`, and update the route descriptions ("personal ones come later" goes).
- [ ] Make it green: run the API suite.
- [ ] Commit: `feat(api): personal connection summaries, the link for every role, cleanup on disable`.

### Task 7: Profile's Connections tab and help

**Files:**
- Modify:
  - `apps/web/src/access/ProfileDialog.tsx`
  - `apps/web/src/api/client.ts` (`listMyConnections()`; `openConnections()` exists)
  - `apps/web/src/help/{index.ts,topics.tsx}`
- Create: `apps/web/src/help/ConnectionsHelp.tsx`
- Test: `apps/web/test/ProfileDialog.test.tsx`, `apps/web/test/client.test.ts`

**Interfaces:**
- Consumes: `GET /api/me/connections` from Task 6.
- Produces: `ProfileTab` gains `'connections'`, and the help topic `connections` is in
  `HELP_INDEX`.

- [ ] Write the failing tests:
  - the Connections tab lists each connection's name, system, instance, status and last used;
  - a `needs_attention` row shows its reason;
  - "Manage connections" calls `openConnections()` for an operator;
  - an empty list says "You have no connections yet";
  - `personalSinks: false` says "No system here uses personal connections yet";
  - a 502 shows "Connections are unavailable right now" and keeps the button;
  - the help index test still passes with the new topic.
- [ ] Run them and watch them fail.
- [ ] Implement. Follow the dialog's existing tab and table patterns. The help topic explains
  what a personal connection is, that CT Studio never sees the password, why one per instance,
  "needs attention", and that disabling a user deletes their connections.
- [ ] Make it green: run the web suite.
- [ ] Commit: `feat(web): Connections in Profile`.

### Task 8: Docs and the full gate

**Files:**
- Modify:
  - the spec: its status line, and a new "Phase 5 as built" section with the decisions above;
  - `docs/adr/0017-delivery-bridge.md` (personal connections and their lifecycle);
  - `CLAUDE.md` (the contracts table: connection summaries and reconcile, bridge contract 0.4.0);
  - `apps/bridge/src/page/routes.ts` header comment;
  - `docs/release-notes/Release-Notes-20261022.html` (a phase 5 entry, in its existing style).

- [ ] Write the docs.
- [ ] Run the gate: `npm run check`, `npm run format:check`, `npm run worker:test` and
  `npm run worker:lint`. Run the opt-in Pg files for connections and deliveries on a throwaway
  Postgres. Expected: all green.
- [ ] Commit: `docs: phase 5 as built (personal connections)`.
