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
    smoke-test.sh                  /healthz, /readyz, /api/specs, /api/models via nginx
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
deploy/scripts/compose.sh up -d --scale worker=4 worker   # or WORKER_REPLICAS in .env
deploy/scripts/compose.sh exec postgres psql -U ingest ingest
deploy/scripts/compose.sh down        # keeps data volumes; `down -v` wipes them
```

## Ports

| Port | Service | Default bind |
| --- | --- | --- |
| `APP_PORT` (8080) | nginx → UI + `/api` | `0.0.0.0` |
| `S3_PUBLIC_PORT` (8333) | SeaweedFS S3 for downstream loaders | `127.0.0.1` (set `S3_PUBLIC_BIND`) |
| 5432, 9333, 8888 | Postgres, SeaweedFS master/filer UIs | dev overlay only, localhost |

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

- Pin `SEAWEEDFS_TAG` to a specific release in production `.env` files.
- Back up both volumes: `postgres-data` (`pg_dump`) and `seaweedfs-data` (or replicate buckets
  with `weed filer.sync` / an S3 sync to the final target).
- The worker reaches a host-local LLM server at `host.docker.internal` (mapped via
  `host-gateway`). Set `LOCAL_LLM_ENABLED=true` and `LOCAL_LLM_BASE_URL`.
