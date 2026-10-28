# Sink administration (delivery contract version 3)

Contract version 3 (`@ih/bridge-contract` 0.9.0, the relay 0.10.0, published as `@<owner>/bridge-contract`) adds
one optional capability: a CT Studio administrator manages a sink's **instances** (the places it
delivers to, tenants for example) and **clients** (the tokens its own callers use) through the
bridge. It is sink-neutral: no sink's vocabulary appears in the contract. CT Studio's page is
described under [CT Studio's page](#ct-studios-page).

## Negotiation

- A sink declares `contractVersion: 3` and `capabilities.administration`:
  `{ instances: boolean, clients: boolean, instanceFields: InstanceField[] }` (at least one of the
  two; `instanceFields` = `{id, label, required, hint}`, never secrets, so a producer renders the
  add form). `SinkDescribeSchema` refuses `administration` below version 3.
- `administrationOf(describe)` is the capability, or `null`: a producer offers administration only
  when it is not null. Version 1 and 2 sinks are unchanged.
- Version 3 changes no package: `packageVersionFor(3)` is 2, and the bridge sends a version 3 sink
  version 2 packages. `ContractVersion` (packages) stays 1 | 2; `DescribeContractVersion` is 1 | 2 | 3.

## Calls

Every call is a signed `POST` (`signRequest`, like every sink call) whose JSON body carries
`actingAdmin` `{id, name}`, recorded by the sink's audit log. The sink trusts that the person is an
administrator. `ADMIN_ROUTES` lists them with their schemas and success status; `adminPath` builds
the paths.

| Call | Path | Request | Answer |
| --- | --- | --- | --- |
| list instances | `/admin/instances:list` | `AdminRequest` | 200 `AdminInstanceList` |
| add instance | `/admin/instances` | `AdminAddInstanceRequest` `{id, label, fields}` | 201 `AdminInstance` |
| rename instance | `/admin/instances/{id}:rename` | `AdminRenameInstanceRequest` `{label}` | 200 `AdminInstance` |
| remove instance | `/admin/instances/{id}:remove` | `AdminRequest` | 200 `AdminRemoved` `{id, removed: true}` |
| list clients | `/admin/clients:list` | `AdminRequest` | 200 `AdminClientList` |
| issue client | `/admin/clients` | `AdminIssueClientRequest` `{name, instances, access, expiresInDays}` | 201 `AdminIssuedClient` `{client, token}` |
| revoke client | `/admin/clients/{id}:revoke` | `AdminRequest` | 200 `AdminClient` (idempotent) |
| audit log | `/admin/audit:list` | `AdminAuditRequest` `{cursor, limit}` | 200 `AdminAuditPage` (newest first) |

- Renaming changes the label only. Removing an instance in use is allowed; its next call fails.
- `instances` is a list of instance ids (at least one) or `'all'`; `access` is `read` or
  `read_write`; `expiresInDays` is 7, 30, 90, 365 or `null` (no expiry).
- The secret (`token`) is answered once, at issue; a listed client has a `prefix` instead (null for
  a locked one). `clientState(client, now)` reads `active`, `expired` or `revoked`.
- Entries from the sink's own configuration are listed with `locked: true`.

## Errors

Contract errors (`BridgeErrorSchema`): `not_configured` (409, the sink cannot keep administration
state), `content_rejected` (422, a body or field refused), `name_conflict` (409, id taken),
`not_found` (404), `locked` (409, a configuration entry renamed, removed or revoked), and, for the
sink's own callers, `forbidden` (a write with a read-only token). All three new codes are
`needs_user`.

## Conformance

`administrationSuite({url, key, instanceFields})` (also run by `conformanceSuite` when the sink
declares administration and `administration.instanceFields` is given; the CLI reads
`SINK_ADMIN_FIELDS`) checks, by `ADMIN_CHECKS`: unsigned refused, a call without `actingAdmin`
refused, list/add/duplicate/rename/locked for instances, list/issue/secret never listed/revoke/locked
for clients, remove and remove again (`not_found`), the audit log naming the acting administrator
for each change and never a secret, and every error a contract error. Each run uses its own ids and
cleans up after itself.

## The bridge's relay

A producer never reaches a sink itself: the bridge holds each sink's URL and key. `POST
/v1/sinks/{sinkId}/admin` (producer API, signed with `BRIDGE_CLIENT_KEY`) takes a
`SinkAdminCall` `{call, id, request}`: `call` names an `ADMIN_ROUTES` entry, `id` is the instance
or client id of rename, remove and revoke (null otherwise; `adminCallPath` builds the sink path),
and `request` is the sink's request for that call. The bridge checks the request against the
call's schema (400 `content_rejected`), refuses an unknown sink (404 `not_found`) and one whose
describe does not declare administration, or not of the instances or clients the call is for (422
`content_rejected`), signs the call with the sink's key (`HttpSink.admin`) and checks the answer
against the call's schema (a broken answer is `internal`, never echoed). The answer goes back with
the call's status (200, or 201 for an add or an issue); a sink's refusal keeps its code and the
status `adminErrorStatus` gives it (404 `not_found`; 409 `locked`, `name_conflict`,
`not_configured`; 422 for any other a person acts on; 503 for a retryable one). The bridge keeps
nothing.

## CT Studio's page

- **Where.** Administration > Published outputs: each sink that declares administration has an
  *Administer <system>* button in the header beside Manage connections (`PublishedOutputsPage`),
  which opens `SinkAdminDialog` for that sink. It is the whole system's, not one target's, so no
  target row carries it. Sinks that do not declare it show nothing new. The dialog's sections, chosen with a
  segmented control, are those the sink offers: **Instances** (`instances: true`), **Clients** and
  **Audit log** (`clients: true`).
- **Instances** (`SinkInstances`): id, label, the declared fields' values, who added each and
  when. A locked instance (from the sink's configuration) is tagged *Locked* and has no actions.
  *Add instance* renders its form from `instanceFields`: one plain text input per field (label,
  required, hint; never treated as a secret) after the id and label. *Rename* edits the label in
  place; *Remove* asks first (targets using it fail their next delivery).
- **Clients** (`SinkClients`): name, the token's prefix, instances, access, expiry and state
  (`clientState`: active, expired, revoked); a locked client is tagged and never revoked, a revoked
  one has no actions. *Issue client* takes a name, all instances or chosen ones (the administered
  instances, else those the sink describes), access *Read* or *Read and write*, and an expiry of
  7, 30, 90 or 365 days or none. The answer's token is shown once (`SinkIssuedToken`: Copy, and a
  warning that it will not be shown again) and dropped on Done, on leaving the section or on
  closing the dialog; nothing keeps it. *Revoke* asks first.
- **Audit log** (`SinkAudit`): newest first, a page at a time, *Load more* while `nextCursor` is
  set.
- **Role check.** The routes are `/api/publish-targets/sinks/{sinkId}/admin/instances` (GET list,
  POST add), `…/instances/{id}/rename`, `…/instances/{id}/remove`, `…/clients` (GET list, POST
  issue), `…/clients/{id}/revoke` and `…/audit` (GET, `cursor`, `limit`), in
  `apps/api/src/routes/sink-admin.ts`. They are registered inside the publishing targets' admin
  routes, so the same role check applies: anyone but an admin gets 403 `admins only` (and the
  access hook refuses operators first). `actingAdmin` is always the session's user, never the
  body's (`{id: user id, name: user name}`; the admin from the log is a user row named `Admin`,
  so it has a stable id too): bodies are strict and refuse an `actingAdmin`.
- **Errors.** The API checks the body (400 with Zod issues), refuses an unknown sink (404) and one
  that does not declare administration (409 `not_offered`) before calling the bridge, and answers a
  sink's refusal with its status and `{error, code}` so the page can show *locked*,
  *name_conflict* and the rest; an unreachable bridge or sink is 502.
- **Secrets.** The issue answer is the only time a token crosses CT Studio: the API passes the
  bridge's answer through and neither stores nor logs it (a test watches the log while one is
  issued).
