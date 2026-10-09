#!/usr/bin/env bash
# Thin docker compose wrapper with the right env + compose files.
#   deploy/scripts/compose.sh ps
#   deploy/scripts/compose.sh logs -f worker
#   deploy/scripts/compose.sh up -d --scale worker=3 worker
#   deploy/scripts/compose.sh down            # keeps volumes; add -v to wipe data
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
export IMAGE_TAG="${IMAGE_TAG:-$(git -C "$DEPLOY_DIR/.." rev-parse --short HEAD)}"
exec docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" "$@"
