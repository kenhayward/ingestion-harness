#!/usr/bin/env bash
# Post-deploy checks through the nginx front door.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:${APP_PORT:-8081}}"
TRIES="${TRIES:-30}"

check() {
  local path="$1"
  for ((i = 1; i <= TRIES; i++)); do
    if curl -fsS "$BASE_URL$path" >/dev/null; then
      echo "ok   $path"
      return 0
    fi
    sleep 2
  done
  echo "FAIL $path" >&2
  curl -sS "$BASE_URL$path" >&2 || true
  return 1
}

check /healthz
check /readyz
check /api/specs
check /api/models
