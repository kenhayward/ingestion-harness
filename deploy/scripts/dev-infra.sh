#!/usr/bin/env bash
# Start only Postgres + SeaweedFS (+ the Word converter) for host-side development, then migrate and create buckets
# from the host toolchains.
#   deploy/scripts/dev-infra.sh up | down | reset
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
[[ -f "$ENV_FILE" ]] || cp "$DEPLOY_DIR/.env.example" "$ENV_FILE"
set -a; source "$ENV_FILE"; set +a

compose() {
  docker compose --env-file "$ENV_FILE" -p "${COMPOSE_PROJECT_NAME:-ingestion}-dev" \
    -f "$DEPLOY_DIR/docker-compose.yml" -f "$DEPLOY_DIR/docker-compose.dev.yml" "$@"
}

export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT:-5433}/${POSTGRES_DB}"
export S3_ENDPOINT="http://localhost:${S3_PUBLIC_PORT:-8335}"

case "${1:-up}" in
  up)
    compose up -d --wait postgres seaweedfs converter fuseki
    (cd "$REPO_ROOT" && npm run migrate)
    (cd "$REPO_ROOT/worker" && uv run python -m ingest_worker.admin init-buckets)
    cat <<EOF
Infra ready. Export these for npm run dev:api / uv run ingest-worker:
  export DATABASE_URL=$DATABASE_URL
  export S3_ENDPOINT=$S3_ENDPOINT S3_ACCESS_KEY=$S3_ACCESS_KEY S3_SECRET_KEY=<from $ENV_FILE>
  export CONVERTER_URL=http://localhost:${CONVERTER_PORT:-3010}
  export RDF_ENDPOINT=http://localhost:${FUSEKI_PUBLIC_PORT:-3030} RDF_USER=ct-writer RDF_PASSWORD=<RDF_WRITER_PASSWORD from $ENV_FILE, else dev-writer>
EOF
    ;;
  down) compose down ;;
  reset) compose down -v ;;
  *) echo "usage: $0 up|down|reset" >&2; exit 2 ;;
esac
