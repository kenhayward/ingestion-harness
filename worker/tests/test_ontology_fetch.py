from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from ingest_worker.ontology_fetch import (
    FetchPolicy,
    OntologySourceUnavailable,
    fetch_rdf,
    host_allowed,
)
from ingest_worker.pipeline import DocumentError

FIXTURE = Path(__file__).resolve().parents[2] / "packages/shared/test/fixtures/ontology-url.json"
TTL = b"@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<https://w3id.org/a#A> a owl:Class .\n"
POLICY = FetchPolicy(hosts=("w3id.org", ".example.org"), max_bytes=1000)


@pytest.mark.parametrize("case", json.loads(FIXTURE.read_text(encoding="utf-8"))["hosts"])
def test_host_rule_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    assert host_allowed(case["host"], case["allow"]) is case["allowed"]


def public(_host: str) -> list[str]:
    return ["93.184.216.34"]


def client(transport: httpx.MockTransport) -> httpx.Client:
    return httpx.Client(transport=transport)


def never() -> httpx.MockTransport:
    def refuse(_request: httpx.Request) -> httpx.Response:
        pytest.fail("no request expected")

    return httpx.MockTransport(refuse)


def test_fetches_an_allowed_https_url() -> None:
    seen: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["accept"])
        return httpx.Response(
            200, content=TTL, headers={"content-type": "text/turtle; charset=utf-8"}
        )

    got = fetch_rdf(
        "https://w3id.org/a/core.ttl",
        POLICY,
        client=client(httpx.MockTransport(handle)),
        resolve=public,
    )
    assert (got.data, got.media_type, got.file_name) == (TTL, "text/turtle", "core.ttl")
    assert "text/turtle" in seen[0] and "application/rdf+xml" in seen[0]


@pytest.mark.parametrize(
    ("url", "message"),
    [
        ("http://w3id.org/a", "only https"),
        ("https://evil.org/a", "evil.org is not on ONTOLOGY_FETCH_ALLOW"),
        ("ftp://w3id.org/a", "only https"),
    ],
)
def test_refuses_urls_outside_the_policy(url: str, message: str) -> None:
    with pytest.raises(DocumentError, match=message):
        fetch_rdf(url, POLICY, client=client(never()), resolve=public)


def test_url_imports_are_off_without_hosts() -> None:
    with pytest.raises(DocumentError, match="URL imports are off"):
        fetch_rdf(
            "https://w3id.org/a", FetchPolicy(hosts=()), client=client(never()), resolve=public
        )


@pytest.mark.parametrize(
    "address", ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::1", "192.168.0.9"]
)
def test_refuses_hosts_resolving_to_private_addresses(address: str) -> None:
    with pytest.raises(DocumentError, match="private or local address"):
        fetch_rdf(
            "https://w3id.org/a",
            POLICY,
            client=client(never()),
            resolve=lambda _h: ["93.184.216.34", address],
        )


def test_each_redirect_is_checked_again() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.host == "w3id.org":
            return httpx.Response(302, headers={"location": "https://evil.org/x"})
        pytest.fail("the disallowed host was requested")

    with pytest.raises(DocumentError, match=r"evil.org is not on ONTOLOGY_FETCH_ALLOW"):
        fetch_rdf(
            "https://w3id.org/a", POLICY, client=client(httpx.MockTransport(handle)), resolve=public
        )


def test_follows_a_redirect_to_an_allowed_host() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.host == "w3id.org":
            return httpx.Response(303, headers={"location": "https://docs.example.org/onto.owl"})
        return httpx.Response(200, content=TTL, headers={"content-type": "text/turtle"})

    got = fetch_rdf(
        "https://w3id.org/a", POLICY, client=client(httpx.MockTransport(handle)), resolve=public
    )
    assert got.url == "https://docs.example.org/onto.owl" and got.file_name == "onto.owl"


def test_too_many_redirects() -> None:
    loop = httpx.MockTransport(
        lambda r: httpx.Response(302, headers={"location": "https://w3id.org/again"})
    )
    with pytest.raises(DocumentError, match="too many redirects"):
        fetch_rdf("https://w3id.org/a", POLICY, client=client(loop), resolve=public)


@pytest.mark.parametrize("headers", [{"content-length": "5000"}, {}])
def test_bodies_over_the_cap_are_refused(headers: dict[str, str]) -> None:
    def big(_request: httpx.Request) -> httpx.Response:
        if headers:
            return httpx.Response(200, content=b"x" * 5000, headers=headers)
        # No length: a streamed body the cap must stop while reading.
        return httpx.Response(200, stream=httpx.ByteStream(b"x" * 5000))

    with pytest.raises(DocumentError, match="over the 1000-byte limit"):
        fetch_rdf(
            "https://w3id.org/a", POLICY, client=client(httpx.MockTransport(big)), resolve=public
        )


def test_client_errors_are_final_and_server_errors_retried() -> None:
    with pytest.raises(DocumentError, match="answered 404"):
        fetch_rdf(
            "https://w3id.org/a",
            POLICY,
            client=client(httpx.MockTransport(lambda r: httpx.Response(404))),
            resolve=public,
        )
    with pytest.raises(OntologySourceUnavailable, match="503"):
        fetch_rdf(
            "https://w3id.org/a",
            POLICY,
            client=client(httpx.MockTransport(lambda r: httpx.Response(503))),
            resolve=public,
        )


def test_transport_errors_are_retried() -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(OntologySourceUnavailable, match="connection refused"):
        fetch_rdf(
            "https://w3id.org/a", POLICY, client=client(httpx.MockTransport(broken)), resolve=public
        )


def test_unresolvable_hosts_are_final() -> None:
    def nowhere(_host: str) -> list[str]:
        raise OSError("Name or service not known")

    with pytest.raises(DocumentError, match=r"cannot resolve w3id.org"):
        fetch_rdf("https://w3id.org/a", POLICY, client=client(never()), resolve=nowhere)
