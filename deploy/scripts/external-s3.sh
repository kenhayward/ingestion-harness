#!/usr/bin/env bash
# A throwaway SeaweedFS outside the compose stack, standing in for "someone else's S3" so the
# external publishing-target path runs against a real S3 server (own endpoint, own keys).
#   deploy/scripts/external-s3.sh up     # start it on localhost:8433 with bucket ext-published
#   deploy/scripts/external-s3.sh env    # the IH_TEST_EXTERNAL_S3_* variables the tests read
#   deploy/scripts/external-s3.sh down   # stop it (no volume: its data is gone)
#   export $(deploy/scripts/external-s3.sh env)
# From containers of the dev stack the endpoint is http://host.docker.internal:8433.
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NAME=ih-external-s3
PORT="${IH_EXTERNAL_S3_PORT:-8433}"
BUCKET=ext-published
ACCESS_KEY="${IH_EXTERNAL_S3_ACCESS_KEY:-ext-test-access}"
SECRET_KEY="${IH_EXTERNAL_S3_SECRET_KEY:-ext-test-secret}"

# The same pinned image as compose (one copy of the tag: deploy/docker-compose.yml).
image() {
  local img
  img="$(grep -Eo 'image: *chrislusf/seaweedfs:[^[:space:]]+' "$DEPLOY_DIR/docker-compose.yml" | head -n1 | sed 's/image: *//')"
  [[ -n "$img" ]] || { echo "no seaweedfs image in docker-compose.yml" >&2; exit 1; }
  echo "$img"
}

print_env() {
  cat <<EOF
IH_TEST_EXTERNAL_S3_ENDPOINT=http://localhost:$PORT
IH_TEST_EXTERNAL_S3_REGION=us-east-1
IH_TEST_EXTERNAL_S3_ACCESS_KEY=$ACCESS_KEY
IH_TEST_EXTERNAL_S3_SECRET_KEY=$SECRET_KEY
IH_TEST_EXTERNAL_S3_BUCKET=$BUCKET
EOF
}

up() {
  if docker ps -q --filter "name=^${NAME}$" | grep -q .; then
    echo "$NAME is already running" >&2
  else
    # The identity file is rendered here and handed over base64 in an environment variable, so
    # nothing is mounted (no Windows paths); MSYS_NO_PATHCONV keeps Git Bash from rewriting
    # /bin/sh and the container paths into Windows ones.
    local config
    config="$(sed -e "s|__ACCESS_KEY__|$ACCESS_KEY|" -e "s|__SECRET_KEY__|$SECRET_KEY|" \
      "$DEPLOY_DIR/seaweedfs/s3.json.template" | base64 | tr -d '\r\n')"
    MSYS_NO_PATHCONV=1 docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:8333" \
      -e "S3_JSON_B64=$config" --entrypoint /bin/sh "$(image)" -c \
      'echo $S3_JSON_B64 | base64 -d > /tmp/s3.json && exec weed server -dir=/data -volume.max=0 -master.volumeSizeLimitMB=1024 -s3 -s3.port=8333 -s3.config=/tmp/s3.json -s3.iam.readOnly=false' \
      >/dev/null
  fi
  local i
  for i in $(seq 1 60); do
    # Any HTTP answer (an anonymous request gets 403) means the S3 port is up.
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" || true)" != "000" ]]; then
      break
    fi
    [[ $i -eq 60 ]] && { echo "$NAME did not answer on port $PORT" >&2; docker logs "$NAME" >&2 || true; exit 1; }
    sleep 1
  done
  # The bucket through weed shell (no S3 client needed on the host); it may exist already.
  for i in $(seq 1 30); do
    if echo "s3.bucket.create -name $BUCKET" | docker exec -i "$NAME" weed shell >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  for i in $(seq 1 30); do
    echo "s3.bucket.list" | docker exec -i "$NAME" weed shell 2>/dev/null | grep -q "$BUCKET" && break
    [[ $i -eq 30 ]] && { echo "could not create bucket $BUCKET" >&2; exit 1; }
    sleep 1
  done
  echo "External S3 ready on http://localhost:$PORT (bucket $BUCKET). Export:" >&2
  print_env
}

case "${1:-up}" in
  up) up ;;
  env) print_env ;;
  down) docker stop "$NAME" >/dev/null 2>&1 || true ;;
  *) echo "usage: $0 up|env|down" >&2; exit 2 ;;
esac
