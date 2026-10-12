#!/usr/bin/env bash
# Print the current admin token from the API log (it rotates on every API start; ADR 0006).
#   usage: admin-token.sh <docker compose args...>   e.g. --env-file deploy/.env -f deploy/docker-compose.yml
set -euo pipefail
for _ in $(seq 1 30); do
  token="$(docker compose "$@" logs api 2>/dev/null | grep -o 'ih_[A-Za-z0-9_-]\{43\}' | tail -1 || true)"
  if [[ -n "$token" ]]; then
    echo "$token"
    exit 0
  fi
  sleep 2
done
echo "admin token not found in the api log" >&2
exit 1
