"""The worker's signed bridge client, against httpx.MockTransport (no network)."""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from ingest_worker.bridge.client import BridgeRefused, BridgeUnavailable, HttpBridgeClient
from ingest_worker.bridge.models import CreateDeliveriesRequest
from ingest_worker.errors import DocumentError

KEY = "k" * 32
FIXTURES = (
    Path(__file__).resolve().parents[2] / "packages" / "bridge-contract" / "test" / "fixtures"
)
REQUEST = CreateDeliveriesRequest.model_validate(
    json.loads((FIXTURES / "delivery-request.json").read_text(encoding="utf-8"))
)
RESULT = {
    "packageId": "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
    "deliveries": [
        {"targetId": "specs-archive", "deliveryId": "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"},
        {"targetId": "finance-lake", "deliveryId": "3c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"},
    ],
}


def client(handler: Callable[[httpx.Request], httpx.Response]) -> HttpBridgeClient:
    return HttpBridgeClient("http://bridge:3100", KEY, transport=httpx.MockTransport(handler))


def verify(request: httpx.Request) -> None:
    """The request carries a valid signature over its exact body (as the bridge checks it)."""
    from ingest_worker.bridge.signing import sign_request

    expected = sign_request(
        KEY,
        request.method,
        request.url.raw_path.decode(),
        request.content,
        now=lambda: int(request.headers["x-bridge-timestamp"]),
        nonce=lambda: request.headers["x-bridge-nonce"],
    )
    assert request.headers["x-bridge-signature"] == expected["x-bridge-signature"]


def test_deliver_signs_the_request_and_parses_the_202() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        verify(request)
        return httpx.Response(202, json=RESULT)

    result = client(handler).deliver(REQUEST)
    assert [d.delivery_id for d in result.deliveries] == [
        "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
        "3c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    ]
    assert seen[0].url.path == "/v1/deliveries"
    assert seen[0].headers["content-type"] == "application/json"
    assert json.loads(seen[0].content) == REQUEST.model_dump(by_alias=True, mode="json")


def error(cls: str, code: str, message: str) -> dict[str, Any]:
    return {"class": cls, "code": code, "message": message}


def test_a_needs_user_422_raises_bridge_refused_carrying_the_error() -> None:
    body = error("needs_user", "connection_missing", "Finance has no connection")
    with pytest.raises(BridgeRefused) as raised:
        client(lambda _r: httpx.Response(422, json=body)).deliver(REQUEST)
    assert isinstance(raised.value, DocumentError)
    assert str(raised.value) == "Finance has no connection"
    assert raised.value.error.code == "connection_missing"


def test_a_target_the_bridge_lacks_is_retried_not_sent_to_review() -> None:
    # The worker resolved the target from CT Studio's registry, so the bridge is behind (the
    # API mirrors targets after an upgrade or a restore): retry until it has caught up.
    missing = error("needs_user", "target_missing", "no target finance-lake")
    for status in (404, 422):
        c = client(lambda _r, s=status: httpx.Response(s, json=missing))
        with pytest.raises(BridgeUnavailable):
            c.deliver(REQUEST)
        with pytest.raises(BridgeUnavailable):
            c.read_object("finance-lake", "pub", "out/a.csv")
        with pytest.raises(BridgeUnavailable):
            c.delete_objects("finance-lake", [("pub", "out/a.csv")])


def refuse_connection(_request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused")


def time_out(_request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("timed out")


@pytest.mark.parametrize(
    "handler",
    [
        refuse_connection,
        time_out,
        lambda _r: httpx.Response(503, json=error("retryable", "sink_unavailable", "down")),
        lambda _r: httpx.Response(500, text="boom"),
        lambda _r: httpx.Response(401, json=error("needs_user", "credential_rejected", "sig")),
    ],
    ids=["connection refused", "timeout", "503", "500", "401 bad key"],
)
def test_an_unreachable_or_failing_bridge_raises_bridge_unavailable(
    handler: Callable[[httpx.Request], httpx.Response],
) -> None:
    with pytest.raises(BridgeUnavailable) as raised:
        client(handler).deliver(REQUEST)
    assert not isinstance(raised.value, DocumentError)


def test_read_object_returns_the_bytes_or_none_on_404() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        verify(request)
        body = json.loads(request.content)
        assert request.url.path == "/v1/targets/finance-lake/objects:read"
        if body["key"] == "out/a.csv":
            return httpx.Response(200, json={"content": base64.b64encode(b"a,b\n").decode()})
        return httpx.Response(404, json=error("needs_user", "not_found", "no such object"))

    c = client(handler)
    assert c.read_object("finance-lake", "pub", "out/a.csv") == b"a,b\n"
    assert c.read_object("finance-lake", "pub", "out/none.csv") is None


def test_put_object_sends_the_bytes_base64() -> None:
    seen: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        verify(request)
        assert request.url.path == "/v1/targets/finance-lake/objects:put"
        seen.append(json.loads(request.content))
        return httpx.Response(204)

    client(handler).put_object("finance-lake", "pub", "out/g/v1.ttl", b"@prefix", "text/turtle")
    assert seen == [
        {
            "bucket": "pub",
            "key": "out/g/v1.ttl",
            "contentType": "text/turtle",
            "content": base64.b64encode(b"@prefix").decode(),
        }
    ]


def test_delete_objects_returns_the_count() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        verify(request)
        assert request.url.path == "/v1/targets/finance-lake/objects:delete"
        objects = json.loads(request.content)["objects"]
        assert objects == [{"bucket": "pub", "key": "out/a"}, {"bucket": "pub", "key": "out/b"}]
        return httpx.Response(200, json={"deleted": 2})

    c = client(handler)
    assert c.delete_objects("finance-lake", [("pub", "out/a"), ("pub", "out/b")]) == 2
    assert client(lambda _r: pytest.fail("no call for nothing")).delete_objects("x", []) == 0


def test_an_object_outside_the_target_is_refused() -> None:
    body = error("needs_user", "content_rejected", "the object is outside the target")
    with pytest.raises(BridgeRefused, match="outside the target"):
        client(lambda _r: httpx.Response(422, json=body)).delete_objects("t", [("b", "k")])


def test_the_fake_bridge_is_a_bridge_client() -> None:
    from ingest_worker.bridge.client import BridgeClient

    from .fakes import FakeBridge

    bridge: BridgeClient = FakeBridge({"finance-lake": ("pub", "out/")})
    result = bridge.deliver(REQUEST.model_copy(update={"targets": ["finance-lake"]}))
    assert [d.target_id for d in result.deliveries] == ["finance-lake"]
    name = REQUEST.package.files[0].name
    assert bridge.read_object("finance-lake", "pub", f"out/{name}") is not None
