# Sink administration (delivery contract version 3)

Contract version 3 (`@ih/bridge-contract` 0.9.0, published as `@<owner>/bridge-contract`) adds
one optional capability: a CT Studio administrator manages a sink's **instances** (the places it
delivers to, tenants for example) and **clients** (the tokens its own callers use) through the
bridge. It is sink-neutral: no sink's vocabulary appears in the contract. The CT Studio page that
uses it is a later phase.

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
