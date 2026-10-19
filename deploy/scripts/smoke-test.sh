#!/usr/bin/env bash
# Post-deploy checks through the nginx front door, including email and password access (ADR
# 0013), publishing through the delivery bridge (ADR 0017), Word documents through the converter
# (ADR 0009) and the data lake's read-only S3 keys (ADR 0008).
#   ADMIN_TOKEN  required: the admin token the API logged at startup ("ADMIN TOKEN ..."), the
#                password of the user "admin".
#   S3_URL       the SeaweedFS S3 port as the lake sees it (default: localhost:S3_PUBLIC_PORT).
#   FRAME_ANCESTORS  as in the env file: which framing headers the app must send (blank: none).
#   SMOKE_COMPOSE    the docker compose command of the stack (deploy.sh sets it): lets the test
#                seed a reviewed job and look at the delivered object; unset, that part is skipped.
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
# Framing follows FRAME_ANCESTORS (ADR 0012, frame-ancestors.conf.template): blank = nobody (DENY
# and 'none'), set = those sites and 'self', with no X-Frame-Options at all.
frame_headers() {
  if [[ -z "${FRAME_ANCESTORS:-}" ]]; then
    printf '%s\n' 'X-Frame-Options: DENY' "Content-Security-Policy: frame-ancestors 'none'"
  else
    printf '%s\n' "Content-Security-Policy: frame-ancestors 'self' $FRAME_ANCESTORS"
  fi
}
security_headers() { # path label
  local h want
  h="$(headers "$1")"
  while IFS= read -r want; do
    grep -qiF "$want" <<<"$h" || fail "$2 is missing '$want'"
  done <<<"$(printf '%s\n' 'X-Content-Type-Options: nosniff' 'Referrer-Policy: no-referrer'; frame_headers)"
  if [[ -n "${FRAME_ANCESTORS:-}" ]] && grep -qi '^X-Frame-Options:' <<<"$h"; then
    fail "$2 sends X-Frame-Options although FRAME_ANCESTORS allows framing"
  fi
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

# Backup uploads (ADR 0015) have their own nginx location for the 64 MiB parts. It must reach the
# API for the upload start too: a location ending in '/' answers the bare path with a 301, which
# a browser's fetch cannot follow ("Failed to fetch"). Signed out, so no upload is started.
for path in /api/backup/uploads /api/backup/uploads/smoke/parts/0; do
  method=POST
  [[ "$path" == */parts/* ]] && method=PUT
  got="$(status -X "$method" -H 'content-type: application/json' -d '{}' "$BASE_URL$path")"
  [[ "$got" == 401 ]] || fail "$method $path without a session must reach the API (401), got $got"
done
echo "ok   backup upload routes reach the API"

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

# --- Delivery bridge (ADR 0017): its connections page, and a reviewed job published through it --
got="$(status "$BASE_URL/bridge/connections/start?code=bad")"
[[ "$got" == 401 ]] || fail "a bad connections link must be refused (401), got $got"
echo "ok   connections page refuses a bad link"

# Publishing: a reviewed job of a one-field recipe, seeded in the database (the stack has no
# model to extract with), is approved; the worker hands it to the bridge, the bridge writes it to
# the `default` target and its event finishes the job. The object must be at today's key
# (target prefix + recipe/v1/document/<document>.json). Deleting the job withdraws it again.
if [[ -z "${SMOKE_COMPOSE:-}" ]]; then
  echo "skip publishing through the bridge: SMOKE_COMPOSE is not set"
else
  sc() { $SMOKE_COMPOSE "$@"; }
  seeded="$(sc exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
INSERT INTO templates (id, version, status, definition, published_at)
VALUES ('smoke-bridge', 1, 'published', '{"id": "smoke-bridge", "version": 1,
  "name": "Smoke test (bridge)", "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
  "outputs": {"fields": [{"id": "sender", "type": "text"}]},
  "pipeline": [{"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}],
  "review": {"required": "always"}}', now())
ON CONFLICT DO NOTHING;
WITH doc AS (
  INSERT INTO documents (filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
  VALUES ('smoke-bridge.pdf', encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 4,
          'smoke-bridge', 1, 'ingest-inbox', 'smoke-bridge/v1/smoke.pdf')
  RETURNING id, sha256
), job AS (
  INSERT INTO jobs (document_id, status, task, review_reasons)
  SELECT id, 'awaiting_review', 'process', '["smoke test"]' FROM doc RETURNING id, document_id
)
SELECT job.id || ' ' || doc.id || ' ' || doc.sha256 FROM job JOIN doc ON doc.id = job.document_id;
SQL
)" || fail "seed a reviewed job: $seeded"
  read -r pub_job pub_doc pub_sha <<<"$seeded"
  [[ -n "$pub_job" && -n "$pub_doc" && -n "$pub_sha" ]] || fail "seed a reviewed job: $seeded"
  # The draft the publish applies the (no) edits to, where the worker wrote it after extraction.
  sc exec -T worker python - "$pub_doc" "$pub_job" "$pub_sha" <<'PY' || fail "write the draft"
import json, os, sys
from ingest_worker.storage import S3ObjectStore
doc, job, sha = sys.argv[1:4]
store = S3ObjectStore(os.environ["S3_ENDPOINT"], os.environ.get("S3_REGION") or "us-east-1",
                      os.environ["S3_ACCESS_KEY"], os.environ["S3_SECRET_KEY"])
draft = {"document_id": doc, "job_id": job, "source_sha256": sha,
         "template": {"id": "smoke-bridge", "version": 1, "name": "Smoke test (bridge)"},
         "extracted_at": "2026-10-20T00:00:00+00:00", "page_count": 1, "models": {},
         "fields": {"sender": {"value": "Smoke", "evidence": None, "page": 1}},
         "tables": {}, "checks": {}, "issues": [], "review_required": True,
         "review_reasons": ["smoke test"]}
bucket = os.environ.get("S3_BUCKET_OUTPUTS") or "ingest-outputs"
store.put(bucket, f"smoke-bridge/v1/document/{doc}.json", json.dumps(draft).encode(), "application/json")
PY
  [[ "$(status -b "$ADMIN_JAR" -H 'content-type: application/json' -d '{}' \
    "$BASE_URL/api/jobs/$pub_job/approve")" == 200 ]] || fail "approve the seeded job"
  job_status=""
  for ((i = 1; i <= 90; i++)); do
    job_status="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$pub_job" | json_field status | head -1)"
    [[ "$job_status" == succeeded || "$job_status" == failed || "$job_status" == needs_review ]] && break
    sleep 2
  done
  [[ "$job_status" == succeeded ]] ||
    fail "the approved job must be delivered and succeed, got '$job_status': $(curl -sS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$pub_job")"
  echo "ok   approved job delivered through the bridge and succeeded"
  # Today's key on the default target's bucket and prefix, read with the deployment's own keys.
  object_at() {
    sc exec -T worker python - "$pub_doc" <<'PY'
import os, sys
from ingest_worker.storage import S3ObjectStore
doc = sys.argv[1]
store = S3ObjectStore(os.environ["S3_ENDPOINT"], os.environ.get("S3_REGION") or "us-east-1",
                      os.environ["S3_ACCESS_KEY"], os.environ["S3_SECRET_KEY"])
bucket = os.environ.get("TARGET_S3_BUCKET") or "ingest-published"
key = os.environ.get("TARGET_S3_PREFIX", "") + f"smoke-bridge/v1/document/{doc}.json"
print("present" if store.get_optional(bucket, key) is not None else "absent")
PY
  }
  [[ "$(object_at)" == present ]] || fail "the published object is not at today's key"
  read_back="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$pub_job/outputs/document")" ||
    fail "read the published document back through the bridge"
  grep -qF "\"document_id\": \"$pub_doc\"" <<<"$read_back" || fail "read back: $read_back"
  echo "ok   published at today's key, and read back through the bridge"
  [[ "$(status -b "$ADMIN_JAR" -X DELETE "$BASE_URL/api/jobs/$pub_job")" == 204 ]] ||
    fail "delete the published job"
  for ((i = 1; i <= 60; i++)); do
    [[ "$(object_at)" == absent ]] && break
    sleep 2
  done
  [[ "$(object_at)" == absent ]] || fail "deleting the job must withdraw its published object"
  echo "ok   deleting the job withdrew the object through the bridge"
fi

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
