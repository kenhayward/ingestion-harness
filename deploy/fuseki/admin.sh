#!/bin/sh
# Fuseki maintenance from inside its container (the admin endpoints answer localhost only):
#   docker exec ingestion-fuseki-1 /opt/fuseki/admin.sh backup    -> /fuseki/run/backups/ct_*.nq.gz
#   docker exec ingestion-fuseki-1 /opt/fuseki/admin.sh compact   (graph replaces leave garbage)
set -eu
auth="ct-admin:$(cat /fuseki/run/admin-password)"
case "${1:-}" in
  backup) curl -fsS -u "$auth" -X POST 'http://localhost:3030/$/backup/ct' ;;
  compact) curl -fsS -u "$auth" -X POST 'http://localhost:3030/$/compact/ct?deleteOld=true' ;;
  *) echo "usage: admin.sh backup|compact" >&2; exit 2 ;;
esac
