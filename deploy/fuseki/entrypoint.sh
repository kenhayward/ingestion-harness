#!/bin/sh
# Writes the users' password file from the environment, then starts Fuseki (ADR 0011 step 6).
set -eu
: "${RDF_WRITER_PASSWORD:?set RDF_WRITER_PASSWORD (the worker's ct-writer user)}"
: "${RDF_READER_PASSWORD:?set RDF_READER_PASSWORD (the read-only ct-reader user)}"
run=/fuseki/run
mkdir -p "$run" /fuseki/databases
umask 077
printf 'ct-writer: %s\nct-reader: %s\n' "$RDF_WRITER_PASSWORD" "$RDF_READER_PASSWORD" > "$run/passwd"
# The admin user (localhost only: backups and compaction through admin.sh) gets a new random
# password on every start, kept where admin.sh reads it.
head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$run/admin-password"
# FUSEKI_BASE: where the admin area keeps its files (backups go to $run/backups).
export FUSEKI_BASE="$run"
exec java ${JAVA_OPTIONS:-} -jar /opt/fuseki/fuseki-server.jar \
  --config=/opt/fuseki/config.ttl --passwd="$run/passwd" --auth=basic \
  --ping --compact --admin="ct-admin:$(cat "$run/admin-password")"
