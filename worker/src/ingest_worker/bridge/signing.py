"""Signed requests to the bridge, as packages/bridge-contract's signRequest: HMAC-SHA256 with the
shared BRIDGE_CLIENT_KEY over the method, the path (with its query), the timestamp, a nonce and
the sha256 of the exact body bytes. The bridge refuses stale or replayed requests."""

from __future__ import annotations

import hashlib
import hmac
import time
import uuid
from collections.abc import Callable

TIMESTAMP = "x-bridge-timestamp"
NONCE = "x-bridge-nonce"
SIGNATURE = "x-bridge-signature"


def _now() -> int:
    return int(time.time())


def _nonce() -> str:
    return str(uuid.uuid4())


def sign_request(
    key: str,
    method: str,
    path: str,
    body: bytes,
    *,
    now: Callable[[], int] = _now,
    nonce: Callable[[], str] = _nonce,
) -> dict[str, str]:
    """The three headers that sign this request with `key`."""
    timestamp = str(now())
    n = nonce()
    canonical = "\n".join([method.upper(), path, timestamp, n, hashlib.sha256(body).hexdigest()])
    signature = hmac.new(key.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256)
    return {TIMESTAMP: timestamp, NONCE: n, SIGNATURE: signature.hexdigest()}
