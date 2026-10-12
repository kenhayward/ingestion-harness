#!/usr/bin/env bash
# Print the current admin token from the API log (it rotates on every API start; ADR 0006).
#   usage: admin-token.sh <docker compose args...>   e.g. --env-file deploy/.env -f deploy/docker-compose.yml
# Only the API's own "ADMIN TOKEN (...): ih_..." line counts: request URLs in the log can't
# contain that text (no literal spaces), so a stranger can't plant a fake token.
set -euo pipefail
LINE='ADMIN TOKEN (valid until the next restart): ih_[A-Za-z0-9_-]\{43\}'
for _ in $(seq 1 30); do
  token="$(docker compose "$@" logs --no-log-prefix api 2>/dev/null \
    | grep -o "^$LINE" | tail -1 | grep -o 'ih_[A-Za-z0-9_-]*' || true)"
  if [[ -n "$token" ]]; then
    echo "$token"
    exit 0
  fi
  sleep 2
done
echo "admin token not found in the api log" >&2
exit 1
