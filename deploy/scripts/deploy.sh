#!/usr/bin/env bash
# Build images and (re)deploy the stack on this host.
#
#   deploy/scripts/deploy.sh                    # build current commit, deploy, smoke test
#   IMAGE_TAG=abc1234 deploy/scripts/deploy.sh --no-build   # roll back to an earlier build
#   ENV_FILE=/etc/ingestion-harness/staging.env deploy/scripts/deploy.sh
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

[[ -f "$ENV_FILE" ]] || { echo "env file not found: $ENV_FILE (copy deploy/.env.example)" >&2; exit 1; }
export IMAGE_TAG="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"

compose() { docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" "$@"; }

echo "==> deploying IMAGE_TAG=$IMAGE_TAG using $ENV_FILE"
if [[ $BUILD -eq 1 ]]; then
  compose build --pull
fi

compose up -d postgres seaweedfs
compose run --rm init-buckets
compose run --rm migrate
compose up -d --remove-orphans api worker app

ADMIN_TOKEN="$("$DEPLOY_DIR/scripts/admin-token.sh" --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml")"
export ADMIN_TOKEN
# Under GitHub Actions (deploy.yml) the token must never reach the job log.
[[ "${GITHUB_ACTIONS:-}" == true ]] && echo "::add-mask::$ADMIN_TOKEN"
APP_PORT="$(grep -E '^APP_PORT=' "$ENV_FILE" | cut -d= -f2 || true)" \
  "$DEPLOY_DIR/scripts/smoke-test.sh"

echo "==> deployed $IMAGE_TAG"
compose ps
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  echo "==> admin token rotated; on the host run: deploy/scripts/admin-token.sh --env-file $ENV_FILE -f deploy/docker-compose.yml"
else
  echo "==> ADMIN TOKEN (valid until the API restarts): $ADMIN_TOKEN"
  echo "    Sign in with it, then issue user tokens under Access (ADR 0006)."
fi
