"""The SPARQL 1.1 Graph Store Protocol client (ADR 0011 step 6), against httpx's MockTransport."""

from __future__ import annotations

import base64

import httpx
import pytest

from ingest_worker.graph_store import (
    GraphStoreRejected,
    GraphStoreUnavailable,
    HttpGraphStore,
    graph_store_from_env,
)
from ingest_worker.pipeline import DocumentError

GRAPH = "https://data.acme.example/graph/source/ab12/letter"


def store(handler: httpx.MockTransport) -> HttpGraphStore:
    return HttpGraphStore("http://fuseki:3030/", "ct", "ct-writer", "secret", transport=handler)


def answering(
    status: int, body: str = "", seen: list[httpx.Request] | None = None
) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, text=body)

    return httpx.MockTransport(handle)


def test_put_sends_the_graph_with_basic_auth() -> None:
    seen: list[httpx.Request] = []
    store(answering(201, seen=seen)).put(GRAPH, b"<a> <b> <c> .", "text/turtle")
    [request] = seen
    assert request.method == "PUT"
    assert request.url.path == "/ct/data"
    assert request.url.params["graph"] == GRAPH
    assert request.headers["content-type"] == "text/turtle; charset=utf-8"
    token = base64.b64encode(b"ct-writer:secret").decode()
    assert request.headers["authorization"] == f"Basic {token}"
    assert request.content == b"<a> <b> <c> ."


@pytest.mark.parametrize("status", [200, 201, 204])
def test_success_statuses(status: int) -> None:
    store(answering(status)).put(GRAPH, b"", "text/turtle")


def test_delete_drops_the_graph_and_says_whether_it_existed() -> None:
    seen: list[httpx.Request] = []
    assert store(answering(204, seen=seen)).delete(GRAPH) is True
    assert seen[0].method == "DELETE" and seen[0].url.params["graph"] == GRAPH
    assert store(answering(404)).delete(GRAPH) is False


@pytest.mark.parametrize("status", [500, 502, 503])
def test_server_errors_are_transient(status: int) -> None:
    with pytest.raises(GraphStoreUnavailable, match=str(status)):
        store(answering(status, "busy")).put(GRAPH, b"", "text/turtle")


def test_a_transport_error_is_transient() -> None:
    def refuse(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with pytest.raises(GraphStoreUnavailable, match="connection refused"):
        store(httpx.MockTransport(refuse)).put(GRAPH, b"", "text/turtle")


@pytest.mark.parametrize("status", [400, 401, 403, 413])
def test_client_errors_are_permanent_and_carry_the_response(status: int) -> None:
    with pytest.raises(GraphStoreRejected) as caught:
        store(answering(status, "Parse error: line 1" + "x" * 1000)).put(GRAPH, b"", "text/turtle")
    assert isinstance(caught.value, DocumentError)  # a processing problem: needs_review
    message = str(caught.value)
    assert f"{status}" in message and "Parse error: line 1" in message
    assert len(message) < 700


def test_from_env() -> None:
    assert graph_store_from_env({}) is None
    configured = graph_store_from_env(
        {"RDF_ENDPOINT": "http://fuseki:3030", "RDF_USER": "ct-writer", "RDF_PASSWORD": "pw"}
    )
    assert configured is not None
    assert configured.data_url == "http://fuseki:3030/ct/data"
    named = graph_store_from_env({"RDF_ENDPOINT": "http://f:3030/", "RDF_DATASET": "other"})
    assert named is not None and named.data_url == "http://f:3030/other/data"
