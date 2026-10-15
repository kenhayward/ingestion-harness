"""A real Fuseki (deploy/docker-compose.dev.yml `fuseki`): Graph Store PUT, DELETE and the union
default graph the readers query.

Needs RDF_ENDPOINT (and RDF_USER/RDF_PASSWORD), e.g. after `deploy/scripts/dev-infra.sh up`:
    RDF_ENDPOINT=http://localhost:3030 RDF_USER=ct-writer RDF_PASSWORD=dev-writer \
      uv run pytest -m integration tests/test_graph_store_integration.py
"""

from __future__ import annotations

import os
import uuid

import httpx
import pytest

from ingest_worker.graph_store import GraphStoreRejected, graph_store_from_env

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not os.environ.get("RDF_ENDPOINT"), reason="RDF_ENDPOINT not set"),
]


def count(subject: str) -> int:
    endpoint = os.environ["RDF_ENDPOINT"].rstrip("/")
    dataset = os.environ.get("RDF_DATASET") or "ct"
    response = httpx.post(
        f"{endpoint}/{dataset}/sparql",
        data={"query": f"SELECT (count(*) AS ?n) WHERE {{ <{subject}> ?p ?o }}"},
        headers={"Accept": "application/sparql-results+json"},
        auth=(os.environ.get("RDF_USER", ""), os.environ.get("RDF_PASSWORD", "")),
    )
    response.raise_for_status()
    return int(response.json()["results"]["bindings"][0]["n"]["value"])


def test_put_replace_and_delete_a_named_graph() -> None:
    store = graph_store_from_env(os.environ)
    assert store is not None
    graph = f"https://test.example/graph/{uuid.uuid4()}"
    subject = f"{graph}/s"
    store.put(graph, f"<{subject}> <https://test.example/p> 1, 2 .".encode(), "text/turtle")
    assert count(subject) == 2  # the union default graph sees the named graph
    store.put(graph, f"<{subject}> <https://test.example/p> 3 .".encode(), "text/turtle")
    assert count(subject) == 1  # replaced, not merged
    assert store.delete(graph) is True
    assert count(subject) == 0
    assert store.delete(graph) is False


def test_a_body_the_store_cannot_parse_is_rejected() -> None:
    store = graph_store_from_env(os.environ)
    assert store is not None
    with pytest.raises(GraphStoreRejected, match="400"):
        store.put("https://test.example/graph/bad", b"<not turtle", "text/turtle")
