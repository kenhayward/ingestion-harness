"""The triple store (ADR 0011 step 6): the SPARQL 1.1 Graph Store Protocol against Apache Jena
Fuseki's `/{dataset}/data` service, with the worker's own user (`ct-writer`)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol

import httpx

from .pipeline import DocumentError

#: Seconds for one Graph Store request; a large graph is one PUT.
GRAPH_STORE_TIMEOUT_S = 120.0


class GraphStoreUnavailable(Exception):
    """The store did not answer, or answered with a 5xx: retried with backoff."""


class GraphStoreRejected(DocumentError):
    """The store refused the request (a 4xx): a processing problem for an operator."""


class GraphStore(Protocol):
    def put(self, graph_iri: str, body: bytes, content_type: str) -> None:
        """Replace the named graph with `body`."""
        ...

    def delete(self, graph_iri: str) -> bool:
        """Drop the named graph; False when there was none."""
        ...


class HttpGraphStore:
    def __init__(
        self,
        endpoint: str,
        dataset: str,
        user: str | None,
        password: str | None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.data_url = f"{endpoint.rstrip('/')}/{dataset}/data"
        auth = httpx.BasicAuth(user, password or "") if user else None
        self._client = httpx.Client(auth=auth, timeout=GRAPH_STORE_TIMEOUT_S, transport=transport)

    def _send(self, method: str, graph_iri: str, **kwargs: object) -> httpx.Response:
        try:
            response = self._client.request(
                method,
                self.data_url,
                params={"graph": graph_iri},
                **kwargs,  # type: ignore[arg-type]
            )
        except httpx.HTTPError as exc:
            raise GraphStoreUnavailable(f"graph store unreachable: {exc}") from exc
        if response.status_code >= 500:
            raise GraphStoreUnavailable(
                f"graph store answered {response.status_code}: {response.text[:200]}"
            )
        return response

    @staticmethod
    def _rejected(method: str, response: httpx.Response) -> GraphStoreRejected:
        return GraphStoreRejected(
            f"graph store refused the {method} ({response.status_code}): {response.text[:500]}"
        )

    def put(self, graph_iri: str, body: bytes, content_type: str) -> None:
        headers = {"Content-Type": f"{content_type}; charset=utf-8"}
        response = self._send("PUT", graph_iri, content=body, headers=headers)
        if response.status_code >= 300:
            raise self._rejected("PUT", response)

    def delete(self, graph_iri: str) -> bool:
        response = self._send("DELETE", graph_iri)
        if response.status_code == 404:
            return False
        if response.status_code >= 300:
            raise self._rejected("DELETE", response)
        return True


def graph_store_from_env(env: Mapping[str, str]) -> HttpGraphStore | None:
    """`RDF_ENDPOINT` (unset: no store; graphs still go to S3), `RDF_DATASET` (default `ct`),
    `RDF_USER`, `RDF_PASSWORD`."""
    endpoint = env.get("RDF_ENDPOINT", "").strip()
    if not endpoint:
        return None
    return HttpGraphStore(
        endpoint,
        env.get("RDF_DATASET", "").strip() or "ct",
        env.get("RDF_USER") or None,
        env.get("RDF_PASSWORD") or None,
    )
