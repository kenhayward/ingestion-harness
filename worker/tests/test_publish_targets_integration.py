"""Publishing targets against a real S3 server outside the stack: a throwaway SeaweedFS from
`deploy/scripts/external-s3.sh up` (or `.ps1`), with its IH_TEST_EXTERNAL_S3_* variables exported:
    export $(deploy/scripts/external-s3.sh env)
    uv run pytest -m integration tests/test_publish_targets_integration.py
"""

from __future__ import annotations

import base64
import os
import secrets
import uuid

import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ingest_worker.publish_targets import LiveTargets, S3Settings, TargetRow
from ingest_worker.storage import S3ObjectStore

from .fakes import MemoryPublishTargetStore

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("IH_TEST_EXTERNAL_S3_ENDPOINT"),
        reason="IH_TEST_EXTERNAL_S3_ENDPOINT not set (deploy/scripts/external-s3.sh up)",
    ),
]

MASTER = bytes(range(32))
ENV = {"LLM_SECRETS_KEY": base64.b64encode(MASTER).decode()}
#: Never used by an external target: it points nowhere.
INTERNAL = S3Settings("http://127.0.0.1:9", "us-east-1", "unused", "unused")


def encrypt(plaintext: str) -> str:
    """The API's encryptSecret: `v1:` + base64(nonce ‖ ciphertext ‖ tag), AES-256-GCM."""
    nonce = secrets.token_bytes(12)
    sealed = AESGCM(MASTER).encrypt(nonce, plaintext.encode(), None)
    return "v1:" + base64.b64encode(nonce + sealed).decode()


def external(secret: str, prefix: str = "") -> TargetRow:
    e = os.environ
    return TargetRow(
        id="ext-lake",
        label="External lake",
        kind="external",
        bucket=e.get("IH_TEST_EXTERNAL_S3_BUCKET", "ext-published"),
        prefix=prefix,
        endpoint=e["IH_TEST_EXTERNAL_S3_ENDPOINT"],
        region=e.get("IH_TEST_EXTERNAL_S3_REGION", "us-east-1"),
        access_key_id=e["IH_TEST_EXTERNAL_S3_ACCESS_KEY"],
        secret_key_enc=encrypt(secret),
        access_key_env=None,
        secret_key_env=None,
        path_style=True,
        sse="none",
        kms_key_id=None,
        storage_class="STANDARD",
        seeded_at=None,
    )


def live(row: TargetRow) -> LiveTargets:
    return LiveTargets(MemoryPublishTargetStore([row]), INTERNAL, env=ENV, make=S3ObjectStore)


def test_an_external_target_round_trips_under_its_prefix() -> None:
    targets = live(external(os.environ["IH_TEST_EXTERNAL_S3_SECRET_KEY"], prefix="ingest/"))
    target = targets.get("ext-lake")
    key = f"{target.prefix}it-{uuid.uuid4().hex[:8]}/out.json"
    body = b'{"ok": true}'
    target.store.put(target.bucket, key, body, "application/json")
    try:
        assert key.startswith("ingest/it-")
        assert target.store.get(target.bucket, key) == body
    finally:
        target.store.delete(target.bucket, key)
    assert target.store.get_optional(target.bucket, key) is None


def test_a_wrong_secret_raises_from_put() -> None:
    target = live(external("not-the-secret")).get("ext-lake")
    with pytest.raises(ClientError) as raised:
        target.store.put(target.bucket, f"it-{uuid.uuid4().hex[:8]}", b"x", "text/plain")
    assert raised.value.response["ResponseMetadata"]["HTTPStatusCode"] == 403
