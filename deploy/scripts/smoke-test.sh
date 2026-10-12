#!/usr/bin/env bash
# Post-deploy checks through the nginx front door, including token access (ADR 0006) and the
# data lake's read-only S3 keys (ADR 0008).
#   ADMIN_TOKEN  required: the admin token the API logged at startup ("ADMIN TOKEN ...").
#   S3_URL       the SeaweedFS S3 port as the lake sees it (default: localhost:S3_PUBLIC_PORT).
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:${APP_PORT:-8081}}"
S3_URL="${S3_URL:-http://localhost:${S3_PUBLIC_PORT:-8335}}"
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

# --- S3 keys (ADR 0008): a lake key can read the publish bucket and nothing more ------------
s3_status() { # access-key secret service curl-args...
  local key="$1" secret="$2" service="$3"
  shift 3
  curl -s -o /dev/null -w '%{http_code}' --aws-sigv4 "aws:amz:us-east-1:$service"     --user "$key:$secret" "$@"
}
eventually() { # expected-status command...
  local want="$1" got=""
  shift
  for ((i = 1; i <= 20; i++)); do
    got="$("$@")"
    [[ "$got" == "$want" ]] && return 0
    sleep 0.5
  done
  echo "got $got, wanted $want" >&2
  return 1
}

overview="$(curl -sS -b "$ADMIN_JAR" -w '
%{http_code}' "$BASE_URL/api/access/s3-keys")"
if [[ "${overview##*$'
'}" == 404 ]]; then
  echo "skip S3 keys: not available (publish target is not the local SeaweedFS)"
  exit 0
fi
[[ "${overview##*$'
'}" == 200 ]] || fail "list S3 keys: $overview"
bucket="$(json_field bucket <<<"${overview%$'
'*}")"

issued="$(curl -fsS -b "$ADMIN_JAR" -H 'content-type: application/json'   -d '{"label":"smoke test","expiresInDays":1}' "$BASE_URL/api/access/s3-keys")"   || fail "issue S3 key"
access_key="$(json_field accessKeyId <<<"$issued")"
secret_key="$(json_field secretAccessKey <<<"$issued")"
consumer_id="$(grep -o '"consumer":{"id":"[^"]*"' <<<"$issued" | cut -d'"' -f6)"
key_id="$(grep -o '"key":{"id":"[^"]*"' <<<"$issued" | cut -d'"' -f6)"
[[ -n "$access_key" && -n "$secret_key" && -n "$consumer_id" && -n "$key_id" ]]   || fail "issue S3 key: $issued"
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::add-mask::$secret_key"; fi

lake() { s3_status "$access_key" "$secret_key" "$@"; }
eventually 200 lake s3 "$S3_URL/$bucket?list-type=2" || fail "lake key must list $bucket"
[[ "$(lake s3 -X PUT --data-binary x "$S3_URL/$bucket/smoke-test.txt")" == 403 ]]   || fail "lake key must not write"
[[ "$(lake iam -H 'content-type: application/x-www-form-urlencoded'   -d 'Action=CreateUser&UserName=lake-smoke-escalate&Version=2010-05-08' "$S3_URL/")" == 403 ]]   || fail "lake key must not call IAM"
[[ "$(status -b "$ADMIN_JAR" -X POST "$BASE_URL/api/access/s3-keys/keys/$key_id/revoke")" == 204 ]]   || fail "revoke S3 key"
eventually 403 lake s3 "$S3_URL/$bucket?list-type=2" || fail "revoked lake key must stop working"
[[ "$(status -b "$ADMIN_JAR" -X DELETE "$BASE_URL/api/access/s3-keys/$consumer_id")" == 204 ]]   || fail "delete S3 consumer"
echo "ok   S3 key: lists $bucket, can't write or call IAM, revoked, deleted"
