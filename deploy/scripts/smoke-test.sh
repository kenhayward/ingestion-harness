#!/usr/bin/env bash
# Post-deploy checks through the nginx front door, including token access (ADR 0006).
#   ADMIN_TOKEN  required: the admin token the API logged at startup ("ADMIN TOKEN ...").
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:${APP_PORT:-8081}}"
TRIES="${TRIES:-30}"
: "${ADMIN_TOKEN:?set ADMIN_TOKEN (docker compose logs api | grep 'ADMIN TOKEN')}"

ADMIN_JAR="$(mktemp)"
USER_JAR="$(mktemp)"
trap 'rm -f "$ADMIN_JAR" "$USER_JAR"' EXIT

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
fail() { echo "FAIL $*" >&2; exit 1; }
json_field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

check() {
  local path="$1"
  for ((i = 1; i <= TRIES; i++)); do
    if curl -fsS -b "$ADMIN_JAR" "$BASE_URL$path" >/dev/null; then
      echo "ok   $path"
      return 0
    fi
    sleep 2
  done
  echo "FAIL $path" >&2
  curl -sS -b "$ADMIN_JAR" "$BASE_URL$path" >&2 || true
  return 1
}

login() { # token jar
  curl -fsS -c "$2" -H 'content-type: application/json' \
    -d "{\"token\":\"$1\"}" "$BASE_URL/api/auth/login" >/dev/null
}

check /healthz
check /readyz

[[ "$(status "$BASE_URL/api/specs")" == 401 ]] || fail "/api/specs must need a session"
echo "ok   /api/specs without a session -> 401"

login "$ADMIN_TOKEN" "$ADMIN_JAR" || fail "admin sign-in"
echo "ok   admin sign-in"
check /api/specs
check /api/models
check /api/results
check /api/auth/tokens

created="$(curl -fsS -b "$ADMIN_JAR" -H 'content-type: application/json' \
  -d '{"label":"smoke test","expiresInDays":1}' "$BASE_URL/api/auth/tokens")"
user_token="$(json_field token <<<"$created")"
token_id="$(grep -o '"id":"[^"]*"' <<<"$created" | head -1 | cut -d'"' -f4)"
[[ -n "$user_token" && -n "$token_id" ]] || fail "create user token: $created"

login "$user_token" "$USER_JAR" || fail "user sign-in"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/auth/me")" == 200 ]] || fail "user session"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/auth/tokens")" == 403 ]] || fail "users can't list tokens"
[[ "$(status -b "$ADMIN_JAR" -X POST "$BASE_URL/api/auth/tokens/$token_id/revoke")" == 204 ]] \
  || fail "revoke"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/auth/me")" == 401 ]] || fail "revoked session must end"
[[ "$(status -b "$ADMIN_JAR" -X DELETE "$BASE_URL/api/auth/tokens/$token_id")" == 204 ]] \
  || fail "delete"
echo "ok   user token: sign-in, revoke, delete"
