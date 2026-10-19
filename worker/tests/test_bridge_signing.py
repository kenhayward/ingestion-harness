"""Signed requests to the bridge: the worker signs exactly as TypeScript's signRequest, held in
step by packages/bridge-contract/test/fixtures/signing.json."""

from __future__ import annotations

import json
from pathlib import Path

from ingest_worker.bridge.signing import sign_request

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "bridge-contract"
        / "test"
        / "fixtures"
        / "signing.json"
    ).read_text(encoding="utf-8")
)


def test_signs_the_fixture_with_its_clock_and_nonce() -> None:
    headers = sign_request(
        FIXTURE["key"],
        FIXTURE["method"],
        FIXTURE["path"],
        FIXTURE["body"].encode("utf-8"),
        now=lambda: FIXTURE["timestamp"],
        nonce=lambda: FIXTURE["nonce"],
    )
    assert headers == {
        "x-bridge-timestamp": str(FIXTURE["timestamp"]),
        "x-bridge-nonce": FIXTURE["nonce"],
        "x-bridge-signature": FIXTURE["signature"],
    }


def test_the_method_is_signed_upper_case() -> None:
    lower = sign_request("k" * 32, "post", "/v1/x", b"{}", now=lambda: 1, nonce=lambda: "n")
    upper = sign_request("k" * 32, "POST", "/v1/x", b"{}", now=lambda: 1, nonce=lambda: "n")
    assert lower == upper


def test_a_fresh_nonce_each_time_by_default() -> None:
    a = sign_request("k" * 32, "POST", "/v1/x", b"{}")
    b = sign_request("k" * 32, "POST", "/v1/x", b"{}")
    assert a["x-bridge-nonce"] != b["x-bridge-nonce"]
