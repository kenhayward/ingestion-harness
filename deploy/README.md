# Deploy

Docker Compose deployment of `app` / `api` / `worker` on Postgres + SeaweedFS.

```
deploy/
  docker-compose.yml        production-shaped stack (build context = repo root)
  docker-compose.dev.yml    overlay exposing infra ports for host-side dev
  .env.example              all settings; copy to .env (git-ignored)
  docker/                   api / app (nginx + React) / worker Dockerfiles, nginx.conf
  seaweedfs/                S3 identity template (rendered from env at container start)
  scripts/
    deploy.sh | deploy.ps1         build → infra up → init-buckets → migrate → services → smoke test
    compose.sh                     docker compose with the right env/files (ps, logs, scale, down)
    dev-infra.sh | dev-infra.ps1   Postgres + SeaweedFS only, migrate + buckets from host
    smoke-test.sh                  health, token access and S3 keys via nginx + the S3 port
```

## Deploy / rollback

```bash
deploy/scripts/deploy.sh                                   # current commit (IMAGE_TAG = short SHA)
IMAGE_TAG=<older-sha> deploy/scripts/deploy.sh --no-build  # roll back to images already on host
ENV_FILE=/etc/ingestion-harness/production.env deploy/scripts/deploy.sh
```

In CI/CD, `.github/workflows/deploy.yml` runs this on the deploy host's self-hosted runner.

## Operations

```bash
deploy/scripts/compose.sh ps
deploy/scripts/compose.sh logs -f worker
deploy/scripts/compose.sh up -d --scale worker=4 worker   # or WORKER_REPLICAS in .env (each job runs on one worker: heartbeats, migration 0042)
deploy/scripts/compose.sh exec postgres psql -U ingest ingest
deploy/scripts/compose.sh down        # keeps data volumes; `down -v` wipes them
```

## Ports

| Port | Service | Default bind |
| --- | --- | --- |
| `APP_PORT` (8081) | nginx → UI + `/api` | `0.0.0.0` |
| `S3_PUBLIC_PORT` (8335) | SeaweedFS S3 for downstream loaders | `127.0.0.1` (set `S3_PUBLIC_BIND`) |
| `POSTGRES_PORT` (5433) | Postgres | dev overlay only, `127.0.0.1` |
| `SEAWEEDFS_MASTER_PORT` (9334) | SeaweedFS master UI (unauthenticated) | `127.0.0.1` (set `SEAWEEDFS_MASTER_BIND`) |
| 8888 | SeaweedFS filer UI | dev overlay only, `127.0.0.1` |
| `CONVERTER_PORT` (3010) | Word converter (Gotenberg) | dev overlay only, `127.0.0.1` |

## Remote access (NGINX Proxy Manager)

The app needs a sign-in everywhere, LAN included ([ADR 0013](../docs/adr/0013-email-password-users.md)).

1. **Admin token:** after each deploy, `deploy.sh` / `deploy.ps1` print it. You can also get it
   any time with `deploy/scripts/admin-token.sh --env-file deploy/.env -f deploy/docker-compose.yml`
   or `docker compose logs api | grep "ADMIN TOKEN"`. It changes on every API restart. It is the
   password of the user `admin`.
2. **Sign in and add users:** sign in as `admin` with the admin token, open **Access**, and add
   each person with their name and email address. They get a one-time password (shown once,
   valid 7 days) and choose their own password at first sign-in. Disable a user to end their
   sessions at once. Ten wrong passwords in a row lock an account for 15 minutes (longer after
   each further failure), and twenty disable it until an admin enables it. The post-deploy smoke
   test adds a disabled `Smoke test …` user with an `@example.invalid` address on every run.
3. **NGINX Proxy Manager:**
   - add a proxy host for your domain, forwarding to `http://<docker-host>:8081` (the `app`
     container, `APP_PORT`);
   - SSL: request a Let's Encrypt certificate, and turn on Force SSL and HSTS;
   - turn on **Block common exploits**;
   - Advanced: `client_max_body_size 210m; proxy_read_timeout 300s;` (uploads up to
     `MAX_UPLOAD_MB`, at most 200 MB with the app's nginx, e.g. ChEBI lite; and long requests).
     Workbench bundle imports (`POST /api/workbench/projects/import`) are larger: up to
     `MAX_UPLOAD_MB` × 12 samples + 8 MB (608 MB at the default 50). The app's nginx allows
     650 MB on that path only; give the proxy host the same allowance, e.g. a custom location
     `= /api/workbench/projects/import` with `client_max_body_size 650m; proxy_request_buffering
     off;`, or raise the host-wide limit. Otherwise the import fails with "bundle too large for
     the proxy".
   - Live job progress (Home) is a Server-Sent Events stream, `GET /api/jobs/{id}/events`. The
     app's nginx passes the API's `X-Accel-Buffering: no` on, which NPM honours, so nothing is
     needed here; a proxy that ignores that header must not buffer that path (in nginx,
     `proxy_buffering off;`), or Home shows each running job stuck on its first step until it
     finishes.
   - Embedding in another site's iframe (e.g. a 3DEXPERIENCE dashboard,
     [ADR 0012](../docs/adr/0012-embedding-in-a-frame.md)): set `FRAME_ANCESTORS` in
     `deploy/.env`, e.g. `FRAME_ANCESTORS=https://*.3dexperience.3ds.com`, and redeploy. Leave
     NPM's headers alone: a proxy host that adds `X-Frame-Options` or its own
     `Content-Security-Policy: frame-ancestors` blocks the frame again. Sign-in inside the frame
     needs HTTPS (the session cookie becomes `SameSite=None; Secure; Partitioned`). If the frame
     still stays blank, the browser console names the refused ancestor: every site in the frame
     chain must be listed. Register `https://<host>/widget.html` as the widget, not the app's root:
     a 3DEXPERIENCE "Run your app" widget copies the page it is given onto its own site, where the
     app's own page would call `/api` on 3DEXPERIENCE and name assets the next deploy removes
     (blank widget, 404s for `/assets/index-….js` in the app's log). `widget.html` only frames
     the app, so it runs on its own origin and survives deploys.
4. **Forward only that host.** Keep `SEAWEEDFS_MASTER_BIND`, `S3_PUBLIC_BIND` and the other binds
   on `127.0.0.1` (the defaults). Postgres and the API container are never published.
5. **Trusted proxies:** the API trusts `X-Forwarded-*` only from private networks, which is where
   NGINX Proxy Manager and the app's nginx live. If your proxy reaches the host from a public
   address, set `TRUST_PROXY` to that address. It *adds* to the private networks, so the app's
   own nginx stays trusted. Note that LAN clients are trusted proxies too, so they can choose the
   IP the sign-in limiter sees.

The browser session lasts until the token expires or is revoked (it survives browser restarts),
and ends after 7 idle days. The admin token line is printed whatever `LOG_LEVEL` is.
Session cookies are `Secure` over HTTPS and still work over plain HTTP on the LAN.

## Data lake access to published outputs (S3 keys)

An external system (e.g. a data lake feeding a semantic index) can read the publish bucket
(the `default` publishing target, seeded from `TARGET_S3_BUCKET`, default `ingest-published`; or any internal target under Administration > Published outputs) with its own **read-only** S3 key
([ADR 0008](../docs/adr/0008-s3-read-keys.md)). This works for *internal* publishing targets (the
local SeaweedFS; the seeded `default` is one while `TARGET_S3_ENDPOINT` is empty); pick the targets per key.

1. **Proxy host** in NGINX Proxy Manager, e.g. `lake-s3.example.com`:
   - forward to `http://<docker-host>:8335` (`S3_PUBLIC_PORT`; set `S3_PUBLIC_BIND` so NPM can reach
     it, or put NPM on the stack's Docker network and forward to `http://seaweedfs:8333`);
   - SSL: Let's Encrypt, Force SSL;
   - don't add custom locations that rewrite the path: SigV4 signs the `Host` header and the
     path, and NPM's default `proxy_set_header Host $host` keeps both intact. **Block common
     exploits** filters query strings and user agents; if you turn it on, check the lake's first
     sync gets through;
   - **Advanced** (read-only at the proxy, whatever key is used — this also hides SeaweedFS's
     IAM API, which listens on the same port as `POST /`):

     ```nginx
     if ($request_method !~ ^(GET|HEAD)$) { return 403; }
     if ($uri !~ ^/(ingest-published(/.*)?)?$) { return 403; }
     # Optional: only the lake's egress addresses.
     # allow 203.0.113.0/24; deny all;
     ```

     Use your bucket name if the target's bucket differs.
2. **Show the URL in the app:** set `S3_PUBLIC_URL=https://lake-s3.example.com` in the env file
   (optional; it's displayed with each new key).
3. **Issue a key:** sign in as admin → **Access** → **Data lake S3 keys** → name the consumer,
   choose an expiry, **Create key**. Copy the endpoint URL, bucket, access key ID and secret into
   the lake now: the secret is shown once. The lake uses path-style addressing and any region
   (`us-east-1` is fine).
4. **Rotate:** **Rotate** issues a second key and makes the old one stop after a grace period
   (1, 7 or 30 days). Update the lake, then revoke the old key early if you like.
   **Revoke** stops a key within seconds; deleting the consumer removes its SeaweedFS user.
   The API deletes expired keys every minute.

## Triple store (Fuseki)

Delivered graphs (recipes that deliver `rdf`, ADR 0011) go to Apache Jena Fuseki when the `rdf`
profile is on: `COMPOSE_PROFILES=rdf`, `RDF_ENDPOINT=http://fuseki:3030`, and the two users'
passwords `RDF_WRITER_PASSWORD` (the worker) and `RDF_READER_PASSWORD` (consumers) in the env
file. Without them nothing changes: graphs still go to S3, and the Linked data page says so.
Changing a password needs `deploy/scripts/compose.sh up -d fuseki worker`.

- **Dataset:** `ct`, TDB2 on the `fuseki-data` volume, every named graph in the default graph.
  The worker writes over the internal network `rdf`.
- **Consumers** query as the shared read-only user `ct-reader` through NGINX Proxy Manager
  ([consumer guide](../docs/consumers/sparql.md)). Fuseki is published on
  `FUSEKI_BIND:FUSEKI_PUBLIC_PORT` (`127.0.0.1:3030` by default) for the proxy only:
  - add a proxy host (e.g. `sparql.acme.example`, Let's Encrypt, Force SSL) forwarding to
    `http://<docker-host>:3030`;
  - forward **only** the read services. In the host's Advanced box:

    ```nginx
    location = /ct/sparql { proxy_pass http://<docker-host>:3030; }
    location = /ct/get    { proxy_pass http://<docker-host>:3030; }
    location / { return 404; }
    ```

    so `/ct/data` (writes) and `/$/` (admin) are never reachable from outside;
  - set `RDF_PUBLIC_URL=https://sparql.acme.example/` so the Linked data page shows consumers'
    endpoint. Give consumers the `RDF_READER_PASSWORD` out of band; changing it needs
    `deploy/scripts/compose.sh up -d fuseki`.
- **Withdrawals:** deleting a delivered job, or retiring its document type, queues a `withdraw`
  job that removes the published S3 objects and the graphs; unretiring queues a `republish`.
  The Linked data page counts those waiting and failed (failures retry up to 100 times; see the
  worker logs).
- **Backups:** nightly, from the deploy host's cron. Each one is an N-Quads dump in the volume
  (`/fuseki/run/backups/ct_<date>.nq.gz`); copy it off the host with the other backups.

  ```bash
  15 2 * * * cd /opt/ingestion-harness && deploy/scripts/compose.sh exec -T fuseki /opt/fuseki/admin.sh backup
  ```
- **Compaction:** weekly, because replacing graphs leaves garbage in TDB2.

  ```bash
  45 2 * * 0 cd /opt/ingestion-harness && deploy/scripts/compose.sh exec -T fuseki /opt/fuseki/admin.sh compact
  ```
- **Rebuild** an empty or lost dataset from what was delivered: every ontology graph from its
  normalised file and every current document graph from its versioned copy in the target
  (`graphs/<sha256>/<type>/v<n>.ttl`). Nothing is re-rendered.

  ```bash
  deploy/scripts/compose.sh exec worker python -m ingest_worker.rdf_rebuild
  ```
- **Backfill** a document type whose mapping was added after documents were delivered: their
  reviewed documents are rendered with the type's newest published recipe that maps to
  ontologies.

  ```bash
  deploy/scripts/compose.sh exec worker python -m ingest_worker.rdf_rebuild --backfill <type>
  ```
- **Re-mint** after changing the base IRI on the Linked data page: every graph is re-rendered
  under the new base as its next version, and the graph under the old base is dropped.

  ```bash
  deploy/scripts/compose.sh exec worker python -m ingest_worker.rdf_rebuild --remint
  ```

## Troubleshooting: builds fail with `connecting to 127.0.0.1:8888 … actively refused`

Zscaler's PAC file returns `PROXY 127.0.0.1:8888; PROXY 127.0.0.1:9001`. Docker Desktop tries
only the first entry, and nothing listens on 8888. Fix it in Docker Desktop → Settings →
Resources → Proxies → **Manual proxy configuration**:

- Web server (HTTP) and secure web server (HTTPS): `http://127.0.0.1:9001`
- Bypass: `localhost,127.0.0.1,host.docker.internal,*.local`

Apply & restart, then rebuild. Zscaler does not TLS-inspect Docker Hub, ghcr.io, npm, PyPI or
the Debian/Alpine mirrors (checked 2026-10-09). If that changes, builds will fail with x509
errors, and the Zscaler root CA will need adding to the images.

## Notes

- **SeaweedFS** is pinned to an exact 4.x tag in `docker-compose.yml`; Dependabot proposes
  newer 4.x releases (CI's compose smoke test gates them). A 5.x upgrade is a deliberate change.
- **Word converter** (`converter`, ADR 0009): Gotenberg's LibreOffice-only image, pinned to an
  exact 8.x tag, on the internal `converter` network that only the worker shares (no route
  out, no published ports). The worker reaches it at `CONVERTER_URL` (default
  `http://converter:3000`; set it empty to disable Word documents, which then need review).
  Converted PDFs are cached in the runs bucket under `converted/`.
- **Publishing targets:** the worker writes published outputs to the recipe's target and the API
  reads them back for the Results page. `TARGET_S3_*` only seed the `default` target on the first
  start (empty values fall back to the internal SeaweedFS, `S3_*`); afterwards add and edit targets
  under Administration > Published outputs (keys entered there are encrypted under
  `LLM_SECRETS_KEY`). For an external target, give the credentials write access for the worker and
  at least read access for the API.
- Back up both volumes: `postgres-data` (`pg_dump`) and `seaweedfs-data` (or replicate buckets
  with `weed filer.sync` / an S3 sync to the final target).
- The worker reaches a host-local LLM server at `host.docker.internal` (mapped via
  `host-gateway`). Set `LOCAL_LLM_ENABLED=true` and `LOCAL_LLM_BASE_URL`. To run OCR on a different server, set
  `OCR_BASE_URL` (same provider and options; empty = `LOCAL_LLM_BASE_URL`) and, if it needs its
  own key, `OCR_API_KEY` (empty = `LOCAL_LLM_API_KEY`).
