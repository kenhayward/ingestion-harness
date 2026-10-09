"""Operational commands run from the worker image, e.g. by the compose `init-buckets` service.

python -m ingest_worker.admin init-buckets
"""

from __future__ import annotations

import logging
import sys
import time
from typing import Any

from .config import Settings

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
    buckets = [s.bucket_inbox, s.bucket_outputs, s.bucket_runs]
    if s.target_endpoint == s.s3_endpoint:
        buckets.append(s.target_bucket)  # an external target's bucket is managed elsewhere
    created = ensure_buckets(client, buckets)
    log.info("buckets ready (created: %s)", ", ".join(created) or "none")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
