# Delivery bridge

CT Studio publishes through this service to pluggable **sinks**: built-in ones (S3, RDF) and
external ones that implement the public sink contract in `packages/bridge-contract`. Design:
[docs/superpowers/specs/2026-10-19-delivery-bridge-design.md](../../docs/superpowers/specs/2026-10-19-delivery-bridge-design.md).

The bridge imports nothing from `apps/api`, `apps/web` or `worker`; CT Studio reaches it only
through the contract. It keeps its own tables in Postgres schema `bridge`
(`db/bridge-migrations/`, applied on start).

## What it does (phase 1)

- `POST /v1/deliveries`: accepts one package for one or more targets, all or nothing, and queues
  one delivery per target.
- A runner delivers each one through its target's sink: polls pending sink jobs, retries
  retryable failures with backoff (30 s doubling, at most an hour, `BRIDGE_MAX_ATTEMPTS`), stops
  for a person on `needs_user` errors, and skips a repeat that a sink can neither replace nor
  withdraw.
- Every status change goes to an outbox, sent signed to `BRIDGE_EVENTS_URL`.
- `GET /v1/deliveries/:id`, `GET /v1/sinks`, `GET /v1/targets`; `GET /healthz`, `GET /readyz`.
- The OpenAPI document is served at `/docs/openapi.json` and committed as `openapi.json`
  (`npm run openapi -w @ih/bridge` after changing a route).

Every `/v1` request is signed with `BRIDGE_CLIENT_KEY`: HMAC-SHA256 of
`METHOD\nPATH_WITH_QUERY\nTIMESTAMP\nNONCE\nSHA256(BODY)` in `x-bridge-signature`, with
`x-bridge-timestamp` (within 300 s) and a single-use `x-bridge-nonce`.

## Running it

```bash
DATABASE_URL=postgres://... BRIDGE_CLIENT_KEY=$(openssl rand -hex 32) npm run dev:bridge
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | (required) | Postgres; the bridge uses schema `bridge` only |
| `BRIDGE_CLIENT_KEY` | (required, 32+ chars) | Shared with CT Studio; signs requests both ways |
| `BRIDGE_EVENTS_URL` | unset | Where delivery events are posted; unset keeps them in the outbox |
| `PORT` / `HOST` | `3100` / `0.0.0.0` | Listen address |
| `BRIDGE_MAX_PACKAGE_MB` | `50` | Largest request body (larger: 413 `content_rejected`, the job goes to review) |
| `BRIDGE_PACKAGE_RETENTION_DAYS` | `30` | How long staged packages are kept |
| `BRIDGE_MAX_ATTEMPTS` | `8` | Retries before a delivery fails |
| `BRIDGE_LEASE_SECONDS` | `300` | How long a claimed delivery is held before another runner may take it |
| `S3_ENDPOINT` | (required) | The deployment's own S3 (the `internal` connection) |
| `S3_PUBLIC_URL` | unset | Another URL that S3 answers on; treated as `S3_ENDPOINT` below |
| `S3_BUCKET_INBOX` / `_OUTPUTS` / `_RUNS` / `_BACKUPS` | `ingest-…` | CT Studio's own buckets: on the deployment's S3 (any connection to `S3_ENDPOINT` or `S3_PUBLIC_URL`), no target may use them, nor `BRIDGE_STAGING_BUCKET` |
| `LOG_LEVEL` | `info` | |

Tests: `npx vitest run --project bridge`; Postgres tests run with `IH_TEST_DATABASE_URL` set to a
throwaway database (`npm run test:integration`).

## The contract package (for external sinks)

Each tagged build publishes `packages/bridge-contract` to GitHub Packages as
`@<owner>/bridge-contract`, once per version. The package's `version` is bumped whenever the
contract changes. An external sink pins it and imports the schemas, the request signing and the
conformance suite from it, rather than copying them:

```bash
# .npmrc in the sink's repo; the token needs read:packages
@<owner>:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```bash
npm install @<owner>/bridge-contract@<version> --save-exact
```

`conformanceSuite(options)` takes a `fetchImpl`, so a sink can also run the suite in its own tests
against an in-process server.

## The conformance suite (for external sinks)

Each tagged build publishes `ghcr.io/<owner>/ct-bridge-conformance:<version>` and attaches this
`openapi.json` to the tag's release. An external sink runs the suite against itself in CI:

```bash
docker run --rm -e SINK_URL=http://sink:8080 -e SINK_KEY=... -e SINK_INSTANCE=sandbox \
  -e SINK_CREDENTIAL='{"username":"...","password":"..."}' \
  -e SINK_DESTINATION='{"repository":"..."}' \
  ghcr.io/<owner>/ct-bridge-conformance:<version>
```

It checks describe, that unsigned, replayed and tampered requests are refused, the connection test, browse (when offered), delivery of the
contract's document fixture (waiting out a pending answer), a repeat delivery (when the sink can
replace), and that every error body is a contract error.
