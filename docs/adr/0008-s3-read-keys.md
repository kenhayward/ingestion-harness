# 0008: Read-only S3 keys for the publish bucket

**Status:** accepted · 2026-10-12

**Update (migration 0050):** the publish bucket is now an admin-managed *publishing target*. A key
consumer is granted one or more *internal* targets (`s3_consumer_targets`; existing consumers keep
`default`) and its read-only policy covers each target's bucket and prefix; external targets are not
grantable. `TARGET_S3_*` only seeds the `default` target on first start.

## Context
An external data lake will ingest approved outputs into a semantic index. It reads S3, and it can
be configured with only an endpoint URL, a bucket name and an access key pair. The publish target
is the local SeaweedFS bucket `ingest-published` (`TARGET_S3_ENDPOINT` empty). NGINX Proxy Manager
(NPM) will route the lake's requests to the S3 gateway.

Today SeaweedFS has one S3 identity, `ingest-admin`, rendered from env into a static `-s3.config`
file with full rights. The lake needs its own credentials that:
- can only read `ingest-published`;
- can be rotated without downtime and revoked at once;
- are issued from the **Access** page.

The image is `chrislusf/seaweedfs:${SEAWEEDFS_TAG:-latest}`, so the version isn't pinned.

Unlike app tokens ([ADR 0006](0006-token-access.md)), S3 secrets can't be stored only as hashes.
SigV4 is an HMAC, so the server checking a signature needs the plaintext secret.

Facts below were checked against the SeaweedFS **4.48** source (tag `4.48`, 2026-09-28):
- **Built-in IAM API.** The S3 gateway serves an AWS-compatible IAM API on its own port (8333):
  CreateUser, CreateAccessKey, DeleteAccessKey, UpdateAccessKey, ListAccessKeys, PutUserPolicy
  and DeleteUser.
  - Requests are SigV4-signed `POST /` with an `Action=` form field.
  - An identity with `Admin` may call all of them.
  - It is **read-only by default** (`-s3.iam.readOnly=true`).
- **Static and dynamic identities coexist.** Identities from `-s3.config` are merged with the
  credential store (`filer_etc` by default, under `/etc/iam/`). The static identities are marked
  static, and the IAM API cannot change or delete them.
- **Changes apply immediately.** The gateway that handles an IAM write reloads straight away.
- **Bucket-scoped policies work.** A PutUserPolicy statement on `arn:aws:s3:::ingest-published` and
  `arn:aws:s3:::ingest-published/*` becomes `Read:ingest-published` and `List:ingest-published`.
  - The actions mapped are `s3:GetObject`, `s3:ListBucket` and `s3:GetBucketLocation`.
  - HeadBucket and GetBucketLocation need only `Read` on the bucket.
  - ListBuckets is filtered to buckets the caller may list.
- **Addressing and region.** Path-style addressing always works. The SigV4 region isn't checked
  against a server region, so a client's default (`us-east-1`) works.
- **Key states.** An access key can be set `Inactive` or deleted. Ordinary access keys have
  **no expiry**; only SeaweedFS service accounts do.
- **Audit log.** The S3 audit log (`-s3.auditLogConfig`, Fluentd) records the identity name, not
  the access key id.
- **Versioning.** Releases are numbered `4.NN`, with no patch releases. Docker Hub publishes exact
  tags (`4.48`) and no floating `4` tag.

## Decision
- **Pin SeaweedFS to an exact 4.x tag and take updates through Dependabot.**
  - Compose uses `chrislusf/seaweedfs:4.48` literally. `SEAWEEDFS_TAG` is removed, so the version
    is reviewed in git and not set per host.
  - A Dependabot `docker-compose` entry for `/deploy` proposes new `4.NN` tags and ignores major
    updates, so a 5.x upgrade is a deliberate change.
  - CI's compose smoke test gates every bump.
  - Without a floating `4` tag, this is how we stay on the current major while taking its fixes.
- **Use the built-in IAM API for dynamic identities.**
  - The gateway runs with `-s3.iam.readOnly=false`.
  - `ingest-admin` stays in the static file. The IAM API can't touch it, so the API can't lock
    itself out.
  - The API calls the IAM API on the internal endpoint (`http://seaweedfs:8333`) with the admin
    credentials it already has.
  - The default `filer_etc` credential store is kept.
- **One SeaweedFS user per consumer, each with read-only access to the bucket.**
  - A consumer (e.g. "Semantic index") is an IAM user named `lake-<id>`.
  - It has one inline policy: `s3:GetObject`, `s3:ListBucket` and `s3:GetBucketLocation` on
    `arn:aws:s3:::ingest-published` and `arn:aws:s3:::ingest-published/*`. There are no write,
    tagging, admin or IAM grants, and no other buckets.
  - The `lake-` prefix marks identities this feature owns. Nothing else is ever modified.
- **Each consumer has at most two active keys.** That's what allows rotation with overlap.
- **SeaweedFS holds the secret; Postgres holds the metadata.**
  - Migration `0010` adds two tables:
    - `s3_consumers`: id, label, IAM user name, created and deleted.
    - `s3_access_keys`: id, consumer, access key id, created, expires, revoked, and
      rotated-from.
  - There is no secret column.
  - The secret comes from `CreateAccessKey` and is shown once, with the lake's settings ready to
    copy: endpoint URL, bucket, access key id and secret. It is never logged.
- **Lifecycle.** The database records what should exist; SeaweedFS is brought into line with it.
  - **Issue:** create the IAM user and policy, then the key, then the rows. Expiry is 1 to 365
    days, or never, as for app tokens.
  - **Rotate:** issue a second key for the same consumer. The old key's expiry is cut to a grace
    period the admin chooses (default 7 days), and it can be revoked early. The lake switches
    keys with no gap.
  - **Revoke:** stamp `revoked_at`, then call `DeleteAccessKey` straight away. Rejection is
    effective within seconds.
  - **Delete consumer:** revoke its keys, then delete the IAM user.
- **A reconciler in the API runs on start and every minute.** It:
  - deletes keys that have expired;
  - retries deletes that failed for revoked keys;
  - deletes any `lake-*` key or user in SeaweedFS with no active row, such as one left behind
    when an issue failed halfway.

  It never touches identities without the prefix. It assumes a single API instance, as the admin
  token does (ADR 0006).
- **Admin-only routes.** The routes sit under `/api/access/s3-keys`, behind the existing session
  hook. The **Access** page gets an "S3 keys" section that reuses the expiry presets,
  the new-token panel and the status chips.
- **The API stays testable offline.** An `S3KeyIssuer` port has two adapters: the SeaweedFS IAM
  adapter (with integration tests against `dev-infra`) and a `MemoryS3KeyIssuer` for unit tests.
- **The public route is read-only at the proxy.** The NPM proxy host for the lake:
  - forwards to the S3 gateway with `Host` and the path unchanged, because SigV4 signs both;
  - allows only `GET` and `HEAD`, on `/`, `/ingest-published` and `/ingest-published/*`. This
    blocks writes and the IAM API (`POST /`) from outside, even with a valid admin key;
  - terminates TLS;
  - restricts by IP to the lake's egress addresses if it has fixed ones.

  Port 8333 and the filer are never published directly.

## Threat model
- **Covered:**
  - A leaked lake key exposes only published outputs, read-only, and can be revoked within seconds.
  - Writes, deletes and IAM calls aren't reachable through the public route, whatever key is used.
  - Key guessing: secrets are 40 random characters checked by HMAC.
  - Admins can see who holds which keys, and when each key expires.
- **Not covered:**
  - **Data scope:** a valid key can read **every** published output; the lake needs that. Narrower
    scopes (a prefix per document type) would need a new policy shape.
  - **Secrets at rest:** SeaweedFS stores secrets in plaintext under `/etc/iam/` on the
    `seaweedfs-data` volume. Anyone with access to the Docker host or the filer can read them,
    which is the same exposure the objects already have.
  - **Admin S3 credentials** in `deploy/.env` grant everything on the internal network.
  - **Expiry timing:** expiry is enforced by the reconciler, not by SeaweedFS. If the API is down,
    an expired key keeps working until it restarts. Revocation is synchronous and doesn't
    depend on it.
  - **Usage tracking:** "last used" is per consumer at best, since the audit log has no key id.
    It is out of scope for now.
  - **TLS and rate limits** are the proxy's job.

## Alternatives considered
- **Hand-written identity file with a restart.** Rotation and revocation would need a deploy, and
  issuing keys from the app would mean writing files on the host.
- **Rewriting the filer's `/etc/iam/identity.json` from the API.** That's a read-modify-write on a
  shared file. It races, and it can drop identities. The IAM API does the same job atomically.
- **SeaweedFS service accounts with native `Expiration`.** Expiry would be enforced even with the
  API down. But it's a SeaweedFS-specific extension that standard IAM clients don't cover, and
  a reconciler is still needed for drift. Worth revisiting if that gap matters.
- **Presigned URLs.** Each one covers a single object and expires. They can't list, so they don't
  fit a crawler.
- **A SigV4-checking proxy of our own.** It would reimplement S3 auth for no gain over the
  built-in IAM.

## Consequences
- Compose (production and dev) pins `4.48`, adds `-s3.iam.readOnly=false`, and drops
  `SEAWEEDFS_TAG` from `.env.example` and `deploy/README.md`.
- `.github/dependabot.yml` gains a `docker-compose` entry that ignores major updates.
- New migration `0010`, the `S3KeyIssuer` port and adapters, admin routes (covered by the sweep in
  `access.test.ts`), and the Access page section.
- The smoke test issues a key and checks four things: list and get work; put is denied; IAM
  `POST /` is denied for the lake key; after revocation, requests are denied.
- `deploy/README.md` documents the NPM proxy host: method and path allowlist, TLS, and leaving
  `Host` unchanged.
- The lake is configured with the proxy URL and `ingest-published` and uses path-style
  addressing. If it ever needs virtual-hosted addressing (`ingest-published.<host>`), add
  `-s3.domainName` and a wildcard proxy host.
- `docs/architecture.md` (Access) and the Access line in `CLAUDE.md` point here.
