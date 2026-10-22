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
#   SMOKE_ARCHIVE    1 on a test stack: also deliver to an archive target (`smoke-archive`, which
#                stays: a target that has delivered can never be removed).
#   SMOKE_EXTERNAL   1 on a test stack running the fake external sink (compose profile fake-sink,
#                named in BRIDGE_SINKS): also deliver to it (`smoke-fake`, which stays).
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
  # One target registry: the targets CT Studio lists are the bridge's, cached. `default` is on the
  # bridge, with the S3 sink and the destination the deployment configured.
  listed="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/publish-targets")" || fail "list the targets"
  on_bridge="$(sc exec -T worker python -c '
import json, os, sys
t = next((t for t in json.load(sys.stdin)["targets"] if t["id"] == "default"), None)
want = {"bucket": os.environ.get("TARGET_S3_BUCKET") or "ingest-published",
        "prefix": os.environ.get("TARGET_S3_PREFIX", "")}
if t is None:
    print("no default target")
elif t.get("onBridge") is not True:
    print("default is not on the bridge: onBridge=%r" % t.get("onBridge"))
elif t.get("sinkId") != "s3":
    print("default sinkId=%r, expected s3" % t.get("sinkId"))
elif any((t.get("destination") or {}).get(k) != v for k, v in want.items()):
    print("default destination %r, expected %r" % (t.get("destination"), want))
else:
    print("ok")
' <<<"$listed")" || fail "read the listed targets: $on_bridge"
  [[ "$on_bridge" == ok ]] || fail "the listed targets must be the bridge's: $on_bridge"
  echo "ok   the listed default target is the bridge's, with its destination"
fi

# --- Several targets (delivery bridge phase 4): an archive target and the default -------------
# An internal target with layout `package` and a recipe delivering to `default` and to it.
# Approving the seeded job writes today's key on `default` and the whole package under
# packages/<key>/ on the archive, `package.json` last; deleting the job withdraws both.
# Opt-in (SMOKE_ARCHIVE=1, on a test stack): the target can never be removed afterwards (its
# recipe and the bridge's deliveries name it), and every recipe's Publish to would offer it.
if [[ -z "${SMOKE_COMPOSE:-}" ]]; then
  echo "skip several targets: SMOKE_COMPOSE is not set"
elif [[ "${SMOKE_ARCHIVE:-}" != 1 ]]; then
  echo "skip several targets: set SMOKE_ARCHIVE=1 on a test stack (it adds a permanent target)"
else
  sc() { $SMOKE_COMPOSE "$@"; }
  got="$(status -b "$ADMIN_JAR" -H 'content-type: application/json' \
    -d '{"id": "smoke-archive", "label": "Smoke archive", "kind": "internal", "bucket": "smoke-archive", "layout": "package"}' \
    "$BASE_URL/api/publish-targets")"
  [[ "$got" == 201 || "$got" == 409 ]] || fail "create the archive target, got $got"
  seeded="$(sc exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
INSERT INTO templates (id, version, status, definition, published_at)
VALUES ('smoke-several', 1, 'published', '{"id": "smoke-several", "version": 1,
  "name": "Smoke test (several targets)", "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
  "outputs": {"fields": [{"id": "sender", "type": "text"}]},
  "pipeline": [{"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}],
  "review": {"required": "always"}, "delivery": {"publishTo": ["default", "smoke-archive"]}}', now())
ON CONFLICT DO NOTHING;
WITH doc AS (
  INSERT INTO documents (filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
  VALUES ('smoke-several.pdf', encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 4,
          'smoke-several', 1, 'ingest-inbox', 'smoke-several/v1/smoke.pdf')
  RETURNING id, sha256
), job AS (
  INSERT INTO jobs (document_id, status, task, review_reasons)
  SELECT id, 'awaiting_review', 'process', '["smoke test"]' FROM doc RETURNING id, document_id
)
SELECT job.id || ' ' || doc.id || ' ' || doc.sha256 FROM job JOIN doc ON doc.id = job.document_id;
SQL
)" || fail "seed a reviewed job for several targets: $seeded"
  read -r sev_job sev_doc sev_sha <<<"$seeded"
  [[ -n "$sev_job" && -n "$sev_doc" && -n "$sev_sha" ]] || fail "seed a reviewed job: $seeded"
  # Writes the draft (with `draft`), else says where each target's object is: present or absent.
  several() {
    sc exec -T worker python - "$1" "$sev_doc" "$sev_job" "$sev_sha" <<'PY'
import hashlib, json, os, sys
from ingest_worker.storage import S3ObjectStore
what, doc, job, sha = sys.argv[1:5]
store = S3ObjectStore(os.environ["S3_ENDPOINT"], os.environ.get("S3_REGION") or "us-east-1",
                      os.environ["S3_ACCESS_KEY"], os.environ["S3_SECRET_KEY"])
if what == "draft":
    draft = {"document_id": doc, "job_id": job, "source_sha256": sha,
             "template": {"id": "smoke-several", "version": 1, "name": "Smoke test (several targets)"},
             "extracted_at": "2026-10-21T00:00:00+00:00", "page_count": 1, "models": {},
             "fields": {"sender": {"value": "Smoke", "evidence": None, "page": 1}},
             "tables": {}, "checks": {}, "issues": [], "review_required": True,
             "review_reasons": ["smoke test"]}
    bucket = os.environ.get("S3_BUCKET_OUTPUTS") or "ingest-outputs"
    key = f"smoke-several/v1/document/{doc}.json"
    store.put(bucket, key, json.dumps(draft).encode(), "application/json")
    sys.exit()
key = hashlib.sha256(f"{sha}\nsmoke-several\n1".encode()).hexdigest()
at = {
    "default": (os.environ.get("TARGET_S3_BUCKET") or "ingest-published",
                os.environ.get("TARGET_S3_PREFIX", "") + f"smoke-several/v1/document/{doc}.json"),
    "archive": ("smoke-archive", f"packages/{key}/package.json"),
}
print(" ".join("present" if store.get_optional(*at[t]) is not None else "absent"
               for t in ("default", "archive")))
PY
  }
  several draft || fail "write the draft for several targets"
  [[ "$(status -b "$ADMIN_JAR" -H 'content-type: application/json' -d '{}' \
    "$BASE_URL/api/jobs/$sev_job/approve")" == 200 ]] || fail "approve the several-targets job"
  job_status=""
  for ((i = 1; i <= 90; i++)); do
    job_status="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$sev_job" | json_field status | head -1)"
    [[ "$job_status" == succeeded || "$job_status" == failed || "$job_status" == needs_review ]] && break
    sleep 2
  done
  [[ "$job_status" == succeeded ]] ||
    fail "the several-targets job must succeed, got '$job_status': $(curl -sS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$sev_job")"
  [[ "$(several where)" == "present present" ]] ||
    fail "expected today's key on default and package.json on the archive, got: $(several where)"
  echo "ok   one job delivered to the default target and to an archive"
  [[ "$(status -b "$ADMIN_JAR" -X DELETE "$BASE_URL/api/jobs/$sev_job")" == 204 ]] ||
    fail "delete the several-targets job"
  for ((i = 1; i <= 60; i++)); do
    [[ "$(several where)" == "absent absent" ]] && break
    sleep 2
  done
  [[ "$(several where)" == "absent absent" ]] ||
    fail "deleting the job must withdraw it at both targets, got: $(several where)"
  echo "ok   deleting the job withdrew it at both targets, the archive included"
fi

# --- External sinks (delivery bridge phase 6): the fake sink, beside the default ------------
# A target of the fake external sink (compose profile fake-sink, registered in BRIDGE_SINKS)
# and a recipe delivering to `default` and to it. Approving two jobs of the same file delivers
# both to the fake sink, which replaces what the first one wrote: one key, two deliveries.
# Opt-in (SMOKE_EXTERNAL=1, on a test stack running the fake sink): its target stays.
if [[ -z "${SMOKE_COMPOSE:-}" ]]; then
  echo "skip external sinks: SMOKE_COMPOSE is not set"
elif [[ "${SMOKE_EXTERNAL:-}" != 1 ]]; then
  echo "skip external sinks: set SMOKE_EXTERNAL=1 on a test stack running the fake sink"
else
  sc() { $SMOKE_COMPOSE "$@"; }
  delivered_to_fake() { sc exec -T bridge wget -q -O - http://fake-sink:8080/_delivered; }
  delivered_to_fake >/dev/null || fail "the fake sink is not reachable from the bridge (profile fake-sink)"
  # The bridge describes a sink that was unavailable again every 15 s: wait until it has.
  sinks=""
  for ((i = 1; i <= 30; i++)); do
    sinks="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/publish-targets/sinks")"
    grep -q '"id":"fake","name":"Fake sink","status":"available"' <<<"$sinks" && break
    sleep 2
  done
  grep -q '"id":"fake","name":"Fake sink","status":"available"' <<<"$sinks" ||
    fail "the bridge does not list the fake sink as available: $sinks"
  got="$(status -b "$ADMIN_JAR" -H 'content-type: application/json' \
    -d '{"id": "smoke-fake", "kind": "sink", "label": "Smoke fake", "sinkId": "fake", "destination": {"space": "smoke", "name": "{source.stem}"}}' \
    "$BASE_URL/api/publish-targets")"
  [[ "$got" == 201 || "$got" == 409 ]] || fail "create the fake sink's target, got $got"
  ext_sha="$(openssl rand -hex 32)"
  seeded="$(sc exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<SQL
INSERT INTO templates (id, version, status, definition, published_at)
VALUES ('smoke-external', 1, 'published', '{"id": "smoke-external", "version": 1,
  "name": "Smoke test (external sink)", "document": {"sections": [{"id": "all", "anchor": "\\\\A"}]},
  "outputs": {"fields": [{"id": "sender", "type": "text"}]},
  "pipeline": [{"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}],
  "review": {"required": "always"}, "delivery": {"publishTo": ["default", "smoke-fake"]}}', now())
ON CONFLICT DO NOTHING;
WITH doc AS (
  INSERT INTO documents (filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
  SELECT 'smoke-external.pdf', '$ext_sha', 4, 'smoke-external', 1, 'ingest-inbox',
         'smoke-external/v1/smoke-' || n || '.pdf'
    FROM generate_series(1, 2) AS n
  RETURNING id, sha256
), job AS (
  INSERT INTO jobs (document_id, status, task, review_reasons)
  SELECT id, 'awaiting_review', 'process', '["smoke test"]' FROM doc RETURNING id, document_id
)
SELECT job.id || ' ' || doc.id FROM job JOIN doc ON doc.id = job.document_id;
SQL
)" || fail "seed two reviewed jobs for the external sink: $seeded"
  mapfile -t ext_jobs <<<"$seeded"
  [[ "${#ext_jobs[@]}" == 2 ]] || fail "seed two reviewed jobs: $seeded"
  for pair in "${ext_jobs[@]}"; do
    read -r ext_job ext_doc <<<"$pair"
    sc exec -T worker python - "$ext_doc" "$ext_job" "$ext_sha" <<'PY' || fail "write the draft for the external sink"
import json, os, sys
from ingest_worker.storage import S3ObjectStore
doc, job, sha = sys.argv[1:4]
store = S3ObjectStore(os.environ["S3_ENDPOINT"], os.environ.get("S3_REGION") or "us-east-1",
                      os.environ["S3_ACCESS_KEY"], os.environ["S3_SECRET_KEY"])
draft = {"document_id": doc, "job_id": job, "source_sha256": sha,
         "template": {"id": "smoke-external", "version": 1, "name": "Smoke test (external sink)"},
         "extracted_at": "2026-10-22T00:00:00+00:00", "page_count": 1, "models": {},
         "fields": {"sender": {"value": "Smoke", "evidence": None, "page": 1}},
         "tables": {}, "checks": {}, "issues": [], "review_required": True,
         "review_reasons": ["smoke test"]}
bucket = os.environ.get("S3_BUCKET_OUTPUTS") or "ingest-outputs"
store.put(bucket, f"smoke-external/v1/document/{doc}.json", json.dumps(draft).encode(),
          "application/json")
PY
    [[ "$(status -b "$ADMIN_JAR" -H 'content-type: application/json' -d '{}' \
      "$BASE_URL/api/jobs/$ext_job/approve")" == 200 ]] || fail "approve the external-sink job"
    job_status=""
    for ((i = 1; i <= 90; i++)); do
      job_status="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$ext_job" | json_field status | head -1)"
      [[ "$job_status" == succeeded || "$job_status" == failed || "$job_status" == needs_review ]] && break
      sleep 2
    done
    [[ "$job_status" == succeeded ]] ||
      fail "the external-sink job must succeed, got '$job_status': $(curl -sS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$ext_job")"
  done
  fake="$(delivered_to_fake)"
  key="$(printf '%s\nsmoke-external\n1' "$ext_sha" | sha256sum | cut -d' ' -f1)"
  [[ "$(grep -o "\"idempotencyKey\":\"$key\"" <<<"$fake" | wc -l)" == 2 ]] ||
    fail "the fake sink must have both deliveries of key $key: $fake"
  echo "ok   two jobs of one file delivered to the default target and to the fake external sink"
  echo "ok   the fake sink holds one copy of that key (a replace, not a second copy)"

  # A name the sink refuses (the fake holds every `taken-…` name) sends the job back to review,
  # naming the field; approving with another name delivers it.
  conflict_sha="$(openssl rand -hex 32)"
  seeded="$(sc exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<SQL
INSERT INTO templates (id, version, status, definition, published_at)
VALUES ('smoke-names', 1, 'published', '{"id": "smoke-names", "version": 1,
  "name": "Smoke test (names)", "document": {"sections": [{"id": "all", "anchor": "\\\\A"}]},
  "outputs": {"fields": [{"id": "sender", "type": "text"}]},
  "pipeline": [{"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}],
  "review": {"required": "always"},
  "delivery": {"publishTo": ["default", "smoke-fake"],
               "settings": {"smoke-fake": {"name": "taken-{source.stem}"}}}}', now())
ON CONFLICT DO NOTHING;
WITH doc AS (
  INSERT INTO documents (filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
  VALUES ('smoke-names.pdf', '$conflict_sha', 4, 'smoke-names', 1, 'ingest-inbox',
          'smoke-names/v1/smoke.pdf')
  RETURNING id
), job AS (
  INSERT INTO jobs (document_id, status, task, review_reasons)
  SELECT id, 'awaiting_review', 'process', '["smoke test"]' FROM doc RETURNING id, document_id
), draft AS (
  -- The draft as the worker records it: the review screen (and its names) read it from here.
  INSERT INTO job_outputs (job_id, output_id, stage, format, bucket, object_key)
  SELECT id, 'document', 'draft', 'json', 'ingest-outputs',
         'smoke-names/v1/document/' || document_id || '.json' FROM job
)
SELECT job.id || ' ' || job.document_id FROM job;
SQL
)" || fail "seed a reviewed job for names: $seeded"
  read -r name_job name_doc <<<"$seeded"
  sc exec -T worker python - "$name_doc" "$name_job" "$conflict_sha" <<'PY' || fail "write the draft for names"
import json, os, sys
from ingest_worker.storage import S3ObjectStore
doc, job, sha = sys.argv[1:4]
store = S3ObjectStore(os.environ["S3_ENDPOINT"], os.environ.get("S3_REGION") or "us-east-1",
                      os.environ["S3_ACCESS_KEY"], os.environ["S3_SECRET_KEY"])
draft = {"document_id": doc, "job_id": job, "source_sha256": sha,
         "template": {"id": "smoke-names", "version": 1, "name": "Smoke test (names)"},
         "extracted_at": "2026-10-22T00:00:00+00:00", "page_count": 1, "models": {},
         "fields": {"sender": {"value": "Smoke", "evidence": None, "page": 1}},
         "tables": {}, "checks": {}, "issues": [], "review_required": True,
         "review_reasons": ["smoke test"]}
bucket = os.environ.get("S3_BUCKET_OUTPUTS") or "ingest-outputs"
store.put(bucket, f"smoke-names/v1/document/{doc}.json", json.dumps(draft).encode(),
          "application/json")
PY
  wait_for() { # job status...
    local job="$1" want="$2" got=""
    for ((i = 1; i <= 90; i++)); do
      got="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$job" | json_field status | head -1)"
      [[ "$got" == "$want" || "$got" == failed ]] && break
      sleep 2
    done
    [[ "$got" == "$want" ]] || fail "job $job must be $want, got '$got': $(curl -sS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$job")"
  }
  [[ "$(status -b "$ADMIN_JAR" -H 'content-type: application/json' -d '{}' \
    "$BASE_URL/api/jobs/$name_job/approve")" == 200 ]] || fail "approve the names job"
  wait_for "$name_job" awaiting_review
  naming="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$name_job/naming")"
  grep -q 'already has another document named taken-smoke-names' <<<"$naming" ||
    fail "the refused name must be marked on the job's names: $naming"
  echo "ok   a name the external sink refused sent the job back to review, naming the field"
  [[ "$(status -b "$ADMIN_JAR" -H 'content-type: application/json' \
    -d '{"overrides": {"smoke-fake": {"name": "smoke-renamed"}}}' \
    "$BASE_URL/api/jobs/$name_job/approve")" == 200 ]] || fail "approve the names job with another name"
  wait_for "$name_job" succeeded
  delivered_to_fake | grep -q '"name":"smoke-renamed"' ||
    fail "the fake sink must have the renamed delivery: $(delivered_to_fake)"
  echo "ok   approving with another name delivered it under that name"
fi

# --- RDF through the bridge (delivery bridge phase 3): a reviewed job of a mapped recipe ------
# With a triple store (rdf-default, from RDF_ENDPOINT) and a Linked data base: approving it
# delivers its outputs and its graph's versioned copy to the default target and its graph to the
# triple store, in one package; deleting it withdraws both. Never changes the deployment's base:
# without one the check is skipped.
rdf_targets="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/publish-targets")" || fail "list the targets"
rdf_base="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/linked-data/settings" | json_field effectiveBase | head -1)"
if [[ -z "${SMOKE_COMPOSE:-}" ]]; then
  echo "skip RDF through the bridge: SMOKE_COMPOSE is not set"
elif ! grep -q '"id":"rdf-default"' <<<"$rdf_targets"; then
  echo "skip RDF through the bridge: no triple store (RDF_ENDPOINT)"
elif [[ -z "$rdf_base" ]]; then
  echo "skip RDF through the bridge: no Linked data base"
else
  sc() { $SMOKE_COMPOSE "$@"; }
  rdf_seeded="$(sc exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
INSERT INTO templates (id, version, status, definition, published_at)
VALUES ('smoke-rdf', 1, 'published', '{"id": "smoke-rdf", "version": 1,
  "name": "Smoke test (RDF)", "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
  "outputs": {"fields": [{"id": "sender", "type": "text"}]},
  "pipeline": [{"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}],
  "semantics": {"prefixes": {"ex": "https://smoke.example/def/"},
                "document": {"class": "ex:Letter"},
                "fields": {"sender": {"property": "ex:sender"}}},
  "delivery": {"formats": ["json", "rdf"]},
  "review": {"required": "always"}}', now())
ON CONFLICT DO NOTHING;
WITH doc AS (
  INSERT INTO documents (filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
  VALUES ('smoke-rdf.pdf', encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 4,
          'smoke-rdf', 1, 'ingest-inbox', 'smoke-rdf/v1/smoke.pdf')
  RETURNING id, sha256
), job AS (
  INSERT INTO jobs (document_id, status, task, review_reasons)
  SELECT id, 'awaiting_review', 'process', '["smoke test"]' FROM doc RETURNING id, document_id
)
SELECT job.id || ' ' || doc.id || ' ' || doc.sha256 FROM job JOIN doc ON doc.id = job.document_id;
SQL
)" || fail "seed a reviewed RDF job: $rdf_seeded"
  read -r rdf_job rdf_doc rdf_sha <<<"$rdf_seeded"
  [[ -n "$rdf_job" && -n "$rdf_sha" ]] || fail "seed a reviewed RDF job: $rdf_seeded"
  sc exec -T worker python - "$rdf_doc" "$rdf_job" "$rdf_sha" <<'PY' || fail "write the RDF draft"
import json, os, sys
from ingest_worker.storage import S3ObjectStore
doc, job, sha = sys.argv[1:4]
store = S3ObjectStore(os.environ["S3_ENDPOINT"], os.environ.get("S3_REGION") or "us-east-1",
                      os.environ["S3_ACCESS_KEY"], os.environ["S3_SECRET_KEY"])
draft = {"document_id": doc, "job_id": job, "source_sha256": sha,
         "template": {"id": "smoke-rdf", "version": 1, "name": "Smoke test (RDF)"},
         "extracted_at": "2026-10-20T00:00:00+00:00", "page_count": 1, "models": {},
         "fields": {"sender": {"value": "Smoke", "evidence": None, "page": 1}},
         "tables": {}, "checks": {}, "issues": [], "review_required": True,
         "review_reasons": ["smoke test"]}
bucket = os.environ.get("S3_BUCKET_OUTPUTS") or "ingest-outputs"
store.put(bucket, f"smoke-rdf/v1/document/{doc}.json", json.dumps(draft).encode(), "application/json")
PY
  [[ "$(status -b "$ADMIN_JAR" -H 'content-type: application/json' -d '{}' \
    "$BASE_URL/api/jobs/$rdf_job/approve")" == 200 ]] || fail "approve the RDF job"
  rdf_status=""
  for ((i = 1; i <= 90; i++)); do
    rdf_status="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$rdf_job" | json_field status | head -1)"
    [[ "$rdf_status" == succeeded || "$rdf_status" == failed || "$rdf_status" == needs_review || "$rdf_status" == awaiting_review ]] && break
    sleep 2
  done
  [[ "$rdf_status" == succeeded ]] ||
    fail "the RDF job must be delivered to the target and the triple store, got '$rdf_status': $(curl -sS -b "$ADMIN_JAR" "$BASE_URL/api/jobs/$rdf_job")"
  echo "ok   approved RDF job delivered to its target and the triple store"
  # The graph's versioned copy at today's key on the default target.
  copy_at() {
    sc exec -T worker python - "$rdf_sha" <<'PY'
import os, sys
from ingest_worker.storage import S3ObjectStore, graph_version_key
store = S3ObjectStore(os.environ["S3_ENDPOINT"], os.environ.get("S3_REGION") or "us-east-1",
                      os.environ["S3_ACCESS_KEY"], os.environ["S3_SECRET_KEY"])
bucket = os.environ.get("TARGET_S3_BUCKET") or "ingest-published"
key = os.environ.get("TARGET_S3_PREFIX", "") + graph_version_key(sys.argv[1], "smoke-rdf", 1)
print("present" if store.get_optional(bucket, key) is not None else "absent")
PY
  }
  # Whether the triple store holds the graph (asked from the api container, on the rdf network).
  rdf_graph="${rdf_base}graph/source/$rdf_sha/smoke-rdf"
  graph_in_store() {
    sc exec -T api node -e '
      const graph = process.argv[1];
      const auth = Buffer.from(`${process.env.RDF_USER}:${process.env.RDF_PASSWORD}`).toString("base64");
      fetch(`${process.env.RDF_ENDPOINT.replace(/\/+$/, "")}/${process.env.RDF_DATASET || "ct"}/sparql`, {
        method: "POST",
        headers: { "content-type": "application/sparql-query", accept: "application/sparql-results+json", authorization: `Basic ${auth}` },
        body: `ASK { GRAPH <${graph}> { ?s ?p ?o } }`,
      }).then((r) => r.json()).then((j) => console.log(j.boolean ? "present" : "absent"), (e) => console.log(`error ${e}`));
    ' "$rdf_graph"
  }
  [[ "$(copy_at)" == present ]] || fail "the graph's versioned copy is not at today's key"
  [[ "$(graph_in_store)" == present ]] || fail "the triple store does not hold $rdf_graph"
  echo "ok   graph copy at today's key, and the graph in the triple store"
  [[ "$(status -b "$ADMIN_JAR" -X DELETE "$BASE_URL/api/jobs/$rdf_job")" == 204 ]] ||
    fail "delete the RDF job"
  for ((i = 1; i <= 60; i++)); do
    [[ "$(graph_in_store)" == absent && "$(copy_at)" == absent ]] && break
    sleep 2
  done
  [[ "$(graph_in_store)" == absent ]] || fail "deleting the job must drop its graph"
  [[ "$(copy_at)" == absent ]] || fail "deleting the job must withdraw its graph copy"
  echo "ok   deleting the RDF job dropped its graph and withdrew its copy"
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
