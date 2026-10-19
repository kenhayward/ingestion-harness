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
    #: Seconds between a running job's heartbeats (heartbeat.py); keep it well under stale_lock_s.
    heartbeat_s: float
    #: The delivery bridge publishing goes through (`BRIDGE_URL`), and the key that signs every
    #: request to it (`BRIDGE_CLIENT_KEY`).
    bridge_url: str
    bridge_client_key: str
    #: Worked-example template.yaml shown to drafting models.
    example_template: Path
    #: Gotenberg converting Word (.docx) sources to PDF; None: Word documents need review.
    converter_url: str | None
    #: Ontology imports over this many triples are refused (ADR 0011).
    ontology_max_triples: int = 2_000_000
    #: Hosts ontologies may be fetched from (ADR 0011); empty: URL imports are off.
    ontology_fetch_allow: tuple[str, ...] = ()
    #: Fetched ontology files over this many bytes are refused.
    ontology_max_bytes: int = 104_857_600

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> Settings:
        missing = [
            k
            for k in (
                "DATABASE_URL",
                "S3_ENDPOINT",
                "S3_ACCESS_KEY",
                "S3_SECRET_KEY",
                "BRIDGE_URL",
                "BRIDGE_CLIENT_KEY",
            )
            if not env.get(k)
        ]
        if missing:
            raise ValueError(f"missing required environment variables: {', '.join(missing)}")
        specs_dir = Path(env.get("SPECS_DIR", REPO_ROOT / "specs"))
        return cls(
            database_url=env["DATABASE_URL"],
            s3_endpoint=env["S3_ENDPOINT"],
            s3_region=env.get("S3_REGION", "us-east-1"),
            s3_access_key=env["S3_ACCESS_KEY"],
            s3_secret_key=env["S3_SECRET_KEY"],
            bucket_inbox=env.get("S3_BUCKET_INBOX", "ingest-inbox"),
            bucket_outputs=env.get("S3_BUCKET_OUTPUTS", "ingest-outputs"),
            bucket_runs=env.get("S3_BUCKET_RUNS", "ingest-runs"),
            specs_dir=specs_dir,
            llm_config=Path(env.get("LLM_CONFIG", REPO_ROOT / "config" / "llm-providers.yaml")),
            worker_id=env.get("WORKER_ID", f"{socket.gethostname()}-{os.getpid()}"),
            poll_interval_s=float(env.get("POLL_INTERVAL_S", "2")),
            discovery_interval_s=float(env.get("DISCOVERY_INTERVAL_S", "3600")),
            stale_lock_s=float(env.get("STALE_LOCK_S", "900")),
            heartbeat_s=float(env.get("HEARTBEAT_S", "60")),
            bridge_url=env["BRIDGE_URL"],
            bridge_client_key=env["BRIDGE_CLIENT_KEY"],
            example_template=Path(
                env.get(
                    "WORKBENCH_EXAMPLE_TEMPLATE",
                    specs_dir / "process-validation-protocol" / "v3" / "template.yaml",
                )
            ),
            converter_url=env.get("CONVERTER_URL") or None,
            ontology_max_triples=int(env.get("ONTOLOGY_MAX_TRIPLES", "2000000")),
            ontology_fetch_allow=tuple(
                h.strip() for h in env.get("ONTOLOGY_FETCH_ALLOW", "").split(",") if h.strip()
            ),
            ontology_max_bytes=int(env.get("ONTOLOGY_MAX_BYTES", "104857600")),
        )
