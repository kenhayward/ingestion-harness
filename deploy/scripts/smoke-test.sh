#!/usr/bin/env bash
# Post-deploy checks through the nginx front door, including email and password access (ADR
# 0013), Word documents through the converter (ADR 0009) and the data lake's read-only S3 keys
# (ADR 0008).
#   ADMIN_TOKEN  required: the admin token the API logged at startup ("ADMIN TOKEN ..."), the
#                password of the user "admin".
#   S3_URL       the SeaweedFS S3 port as the lake sees it (default: localhost:S3_PUBLIC_PORT).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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

login() { # login password jar
  curl -fsS -c "$3" -H 'content-type: application/json' \
    -d "{\"login\":\"$1\",\"password\":\"$2\"}" "$BASE_URL/api/auth/login" >/dev/null
}

check /healthz
check /readyz

# Caching and security headers from the app's nginx: the page must be revalidated (or a deploy
# keeps showing the old build), assets are immutable, and both carry the security headers.
# Strip the CR of each CRLF header line. Written as the escape '\r', never a raw CR byte: line-ending
# normalisation (eol=lf) turned a raw one into a newline once, which joined every header into one
# line so no '^Header:' check could match.
headers() { curl -fsSI "$BASE_URL$1" | tr -d '\r'; }
security_headers() { # path label
  local h
  h="$(headers "$1")"
  for want in 'X-Content-Type-Options: nosniff' 'X-Frame-Options: DENY'     'Referrer-Policy: no-referrer' "Content-Security-Policy: frame-ancestors 'none'"; do
    grep -qiF "$want" <<<"$h" || fail "$2 is missing '$want'"
  done
}
grep -qi '^Cache-Control: no-cache' <<<"$(headers /)" || fail "index.html must be no-cache"
security_headers / "index.html"
asset="$(curl -fsS "$BASE_URL/" | grep -o 'assets/[^"]*\.js' | head -1)"
[[ -n "$asset" ]] || fail "index.html references no script asset"
grep -qi 'immutable' <<<"$(headers "/$asset")" || fail "assets must be cached as immutable"
security_headers "/$asset" "/$asset"
echo "ok   caching and security headers on the page and its assets"

# Installed app (docs/design/pwa.md): browsers want the manifest's own type, and the manifest
# and the service worker must be revalidated so changes reach installed copies.
manifest_headers="$(headers /site.webmanifest)"
grep -qi '^Content-Type: application/manifest+json' <<<"$manifest_headers" ||
  fail "site.webmanifest must be served as application/manifest+json"
grep -qi '^Cache-Control: no-cache' <<<"$manifest_headers" || fail "site.webmanifest must be no-cache"
security_headers /site.webmanifest "site.webmanifest"
sw_headers="$(headers /sw.js)"
grep -qiE '^Content-Type: (application|text)/javascript' <<<"$sw_headers" || fail "sw.js must be JavaScript"
grep -qi '^Cache-Control: no-cache' <<<"$sw_headers" || fail "sw.js must be no-cache"
security_headers /sw.js "sw.js"
grep -qi '^Content-Type: text/html' <<<"$(headers /offline.html)" || fail "offline.html must be served"
echo "ok   manifest, service worker and offline page"

# Dashboard widget page (ADR 0012): frames the app by the absolute origin it was asked under.
grep -qi '^Cache-Control: no-cache' <<<"$(headers /widget.html)" || fail "widget.html must be no-cache"
security_headers /widget.html "widget.html"
widget="$(curl -fsS -H 'Host: ct.example' -H 'X-Forwarded-Proto: https' "$BASE_URL/widget.html")"
grep -qF 'src="https://ct.example/"' <<<"$widget" || fail "widget.html must frame the absolute origin"
echo "ok   widget page"

[[ "$(status "$BASE_URL/api/specs")" == 401 ]] || fail "/api/specs must need a session"
echo "ok   /api/specs without a session -> 401"

login admin "$ADMIN_TOKEN" "$ADMIN_JAR" || fail "admin sign-in"
echo "ok   admin sign-in"
check /api/specs
check /api/models
check /api/results
check /api/users

# A user (ADR 0013): added with a one-time password, which only allows the password change.
# Smoke users stay in the list, disabled; their .invalid addresses can never be real ones.
smoke_id="$RANDOM$RANDOM"
email="smoke-$smoke_id@example.invalid"
created="$(curl -fsS -b "$ADMIN_JAR" -H 'content-type: application/json' \
  -d "{\"name\":\"Smoke test $smoke_id\",\"email\":\"$email\"}" "$BASE_URL/api/users")"
otp="$(json_field password <<<"$created")"
user_id="$(grep -o '"id":"[^"]*"' <<<"$created" | head -1 | cut -d'"' -f4)"
[[ -n "$otp" && -n "$user_id" ]] || fail "add user: $created"

login "$email" "$otp" "$USER_JAR" || fail "first sign-in"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/specs")" == 403 ]] || fail "one-time sessions are restricted"
[[ "$(status -b "$USER_JAR" -X PUT -H 'content-type: application/json' \
  -d "{\"currentPassword\":\"$otp\",\"newPassword\":\"smoke test phrase $smoke_id\"}" \
  "$BASE_URL/api/auth/password")" == 204 ]] || fail "change password"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/specs")" == 200 ]] || fail "signed in after the change"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/users")" == 403 ]] || fail "users can't list users"
[[ "$(status -b "$ADMIN_JAR" -X POST "$BASE_URL/api/users/$user_id/disable")" == 200 ]] \
  || fail "disable"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/specs")" == 401 ]] || fail "disabling ends sessions"
events="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/sign-ins?userId=$user_id&limit=10")"
grep -q '"result":"password-changed"' <<<"$events" || fail "sign-in events: $events"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/sign-ins")" == 401 ]] || fail "sign-ins need a session"
echo "ok   users: add, first sign-in, password change, disable, sign-in events"

# --- Word documents (ADR 0009): a .docx sample is converted and prepared (no model call) ------
word_project=smoke-word
words_url="$BASE_URL/api/workbench/projects/$word_project"
status -b "$ADMIN_JAR" -X DELETE "$words_url" >/dev/null # left over from an interrupted run
[[ "$(status -b "$ADMIN_JAR" -H 'content-type: application/json' \
  -d "{\"id\":\"$word_project\",\"name\":\"Smoke test (Word)\"}" \
  "$BASE_URL/api/workbench/projects")" == 201 ]] || fail "create the Word smoke project"
uploaded="$(curl -sS -b "$ADMIN_JAR" -F role=dev -F "file=@$SCRIPT_DIR/fixtures/smoke.docx" \
  -w '\n%{http_code}' "$words_url/samples")"
[[ "${uploaded##*$'\n'}" == 201 ]] || fail "upload a .docx sample: $uploaded"
for ((i = 1; i <= 60; i++)); do
  samples="$(curl -fsS -b "$ADMIN_JAR" "$words_url/samples")"
  grep -q '"state":"preparing"' <<<"$samples" || break
  sleep 2
done
grep -q '"state":"ready"' <<<"$samples" || fail "the .docx sample was not prepared: $samples"
grep -q '"pageCount":2' <<<"$samples" || fail "the converted .docx must have 2 pages: $samples"
[[ "$(status -b "$ADMIN_JAR" -X DELETE "$words_url")" == 204 ]] || fail "delete the Word project"
echo "ok   Word document: converted and prepared (2 pages)"

# --- S3 keys (ADR 0008): a lake key can read its target's bucket and nothing more ----------
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
  echo "skip S3 keys: not available on this deployment"
  exit 0
fi
[[ "${overview##*$'
'}" == 200 ]] || fail "list S3 keys: $overview"
# The key is granted the `default` publishing target, internal here (seeded from .env.ci).
bucket="$(grep -o '"id":"default","label":"[^"]*","kind":"internal","bucket":"[^"]*"' <<<"$overview" | json_field bucket)"
[[ -n "$bucket" ]] || fail "the default publishing target must be internal: $overview"

issued="$(curl -fsS -b "$ADMIN_JAR" -H 'content-type: application/json'   -d '{"label":"smoke test","expiresInDays":1,"targets":["default"]}' "$BASE_URL/api/access/s3-keys")"   || fail "issue S3 key"
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
