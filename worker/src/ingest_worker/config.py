from __future__ import annotations

import os
import socket
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Settings:
    database_url: str
    s3_endpoint: str
    s3_region: str
    s3_access_key: str
    s3_secret_key: str
    bucket_inbox: str
    bucket_outputs: str
    bucket_runs: str
    specs_dir: Path
    llm_config: Path
    worker_id: str
    poll_interval_s: float
    discovery_interval_s: float
    stale_lock_s: float

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> Settings:
        missing = [
            k
            for k in ("DATABASE_URL", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY")
            if not env.get(k)
        ]
        if missing:
            raise ValueError(f"missing required environment variables: {', '.join(missing)}")
        return cls(
            database_url=env["DATABASE_URL"],
            s3_endpoint=env["S3_ENDPOINT"],
            s3_region=env.get("S3_REGION", "us-east-1"),
            s3_access_key=env["S3_ACCESS_KEY"],
            s3_secret_key=env["S3_SECRET_KEY"],
            bucket_inbox=env.get("S3_BUCKET_INBOX", "ingest-inbox"),
            bucket_outputs=env.get("S3_BUCKET_OUTPUTS", "ingest-outputs"),
            bucket_runs=env.get("S3_BUCKET_RUNS", "ingest-runs"),
            specs_dir=Path(env.get("SPECS_DIR", REPO_ROOT / "specs")),
            llm_config=Path(env.get("LLM_CONFIG", REPO_ROOT / "config" / "llm-providers.yaml")),
            worker_id=env.get("WORKER_ID", f"{socket.gethostname()}-{os.getpid()}"),
            poll_interval_s=float(env.get("POLL_INTERVAL_S", "2")),
            discovery_interval_s=float(env.get("DISCOVERY_INTERVAL_S", "3600")),
            stale_lock_s=float(env.get("STALE_LOCK_S", "900")),
        )
