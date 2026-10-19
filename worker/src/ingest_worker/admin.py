"""Operational commands run from the worker image, e.g. by the compose `init-buckets` service.

python -m ingest_worker.admin init-buckets
"""

from __future__ import annotations

import logging
import os
import sys
import time
from collections.abc import Callable, Mapping
from typing import Any

from .config import Settings
from .publish_targets import TargetRow

log = logging.getLogger("ingest_worker.admin")


def ensure_buckets(
    client: Any, names: list[str], attempts: int = 30, delay_s: float = 2.0
) -> list[str]:
    """Create any missing buckets, waiting for the S3 endpoint to come up. Returns created names."""
    for attempt in range(1, attempts + 1):
        try:
            existing = {b["Name"] for b in client.list_buckets().get("Buckets", [])}
            break
        except Exception as exc:
            if attempt == attempts:
                raise
            log.info("waiting for S3 endpoint (%s)", exc)
            time.sleep(delay_s)
    created = [n for n in names if n not in existing]
    for name in created:
        client.create_bucket(Bucket=name)
    return created


def target_buckets(load: Callable[[], list[TargetRow]], fallback: list[str]) -> list[str]:
    """The buckets of the internal publishing targets (an external target's bucket is managed
    elsewhere); `fallback` when the targets cannot be read (today's single target bucket)."""
    try:
        rows = load()
    except Exception as exc:
        log.info("publishing targets unavailable (%s); using the .env target bucket", exc)
        return fallback
    return list(dict.fromkeys(r.bucket for r in rows if r.kind == "internal"))


def env_target_bucket(env: Mapping[str, str], s3_endpoint: str) -> list[str]:
    """The .env default target's bucket when it is on this deployment's S3 (`TARGET_S3_*` unset
    or naming the same endpoint): the fallback when the stored targets cannot be read."""
    endpoint = env.get("TARGET_S3_ENDPOINT") or s3_endpoint
    return [env.get("TARGET_S3_BUCKET") or "ingest-published"] if endpoint == s3_endpoint else []


def backups_bucket(env: Mapping[str, str]) -> str:
    """The bucket the API keeps backups and restore uploads in (`S3_BUCKET_BACKUPS`, as the API
    reads it: blank means the default)."""
    return env.get("S3_BUCKET_BACKUPS") or "ingest-backups"


def _stored_targets(s: Settings) -> list[TargetRow]:
    """Seed the default target from .env (first start), then read every target."""
    import psycopg

    from .publish_targets import PgPublishTargetStore, default_seed

    with psycopg.connect(s.database_url, autocommit=True, connect_timeout=5) as conn:
        store = PgPublishTargetStore(conn)
        store.seed_default(default_seed(os.environ))
        return store.load()


def main(argv: list[str] = sys.argv[1:]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if argv[:1] != ["init-buckets"]:
        print(__doc__)
        return 2
    import boto3
    from botocore.config import Config

    s = Settings.from_env()
    client = boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint,
        region_name=s.s3_region,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
        config=Config(s3={"addressing_style": "path"}),
    )
    buckets = [s.bucket_inbox, s.bucket_outputs, s.bucket_runs, backups_bucket(os.environ)]
    fallback = env_target_bucket(os.environ, s.s3_endpoint)
    buckets += target_buckets(lambda: _stored_targets(s), fallback)
    created = ensure_buckets(client, list(dict.fromkeys(buckets)))
    log.info("buckets ready (created: %s)", ", ".join(created) or "none")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
