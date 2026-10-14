"""Fetching ontologies by URL (ADR 0011, rollout step 2).

Only `https`, only hosts on ONTOLOGY_FETCH_ALLOW, only public addresses, each redirect checked
again, a byte cap and a timeout. The vetted address is not pinned for the request, so DNS
rebinding remains possible for an allowlisted host: the allowlist is what bounds it.
"""

from __future__ import annotations

import ipaddress
import socket
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from urllib.parse import unquote

import httpx

from .pipeline import DocumentError

#: RDF serialisations rdflib reads, preferred in this order (content negotiation).
ACCEPT = (
    "text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8, "
    "application/n-triples;q=0.8, text/n3;q=0.7, */*;q=0.1"
)

#: Host name -> every address it resolves to.
Resolver = Callable[[str], list[str]]


class OntologySourceUnavailable(Exception):
    """The host could not answer now (transport error, 5xx): the job is retried."""


@dataclass(frozen=True)
class FetchPolicy:
    hosts: tuple[str, ...]
    max_bytes: int = 100 * 1024 * 1024
    timeout_s: float = 60.0
    max_redirects: int = 5


@dataclass(frozen=True)
class Fetched:
    data: bytes
    media_type: str
    #: Where the bytes came from, after redirects.
    url: str
    file_name: str


def host_allowed(host: str, hosts: Sequence[str]) -> bool:
    """Exact hosts, or `.example.org` for the domain and its subdomains (hostAllowed in TS;
    shared fixture packages/shared/test/fixtures/ontology-url.json)."""
    h = host.lower().rstrip(".")
    for raw in hosts:
        e = raw.strip().lower()
        if not e:
            continue
        if e.startswith("."):
            if h == e[1:] or h.endswith(e):
                return True
        elif h == e:
            return True
    return False


def system_resolver(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    return sorted({str(info[4][0]) for info in infos})


def file_name_from(url: str) -> str:
    """The URL's last path segment, else its host (ontologyFileNameFromUrl in TS)."""
    parsed = httpx.URL(url)
    parts = [p for p in parsed.path.split("/") if p]
    return unquote(parts[-1]) if parts else parsed.host


def _check(url: str, policy: FetchPolicy, resolve: Resolver) -> None:
    if not any(h.strip() for h in policy.hosts):
        raise DocumentError("URL imports are off: set ONTOLOGY_FETCH_ALLOW")
    try:
        parsed = httpx.URL(url)
    except httpx.InvalidURL as exc:
        raise DocumentError(f"not a URL: {url}") from exc
    if parsed.scheme != "https":
        raise DocumentError(f"only https URLs can be imported: {url}")
    if not host_allowed(parsed.host, policy.hosts):
        raise DocumentError(f"{parsed.host} is not on ONTOLOGY_FETCH_ALLOW")
    try:
        addresses = resolve(parsed.host)
    except OSError as exc:
        raise DocumentError(f"cannot resolve {parsed.host}: {exc}") from exc
    if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
        raise DocumentError(f"{parsed.host} resolves to a private or local address")


def fetch_rdf(
    url: str,
    policy: FetchPolicy,
    *,
    client: httpx.Client,
    resolve: Resolver = system_resolver,
    clock: Callable[[], float] = time.monotonic,
) -> Fetched:
    """GET an ontology. A refused or unreadable URL is a DocumentError (final); a host that
    cannot answer now is OntologySourceUnavailable (retried)."""
    # `timeout_s` bounds the whole fetch (redirects and body), not each read.
    deadline = clock() + policy.timeout_s

    def in_time() -> None:
        if clock() > deadline:
            raise OntologySourceUnavailable(f"{url} took longer than {policy.timeout_s:g} s")

    current = url
    for _ in range(policy.max_redirects + 1):
        in_time()
        _check(current, policy, resolve)
        try:
            with client.stream(
                "GET",
                current,
                headers={"Accept": ACCEPT},
                follow_redirects=False,
                timeout=policy.timeout_s,
            ) as resp:
                if resp.is_redirect:
                    location = resp.headers.get("location")
                    if not location:
                        raise DocumentError(f"{current} redirected without a location")
                    current = str(resp.url.join(location))
                    continue
                if resp.status_code >= 500:
                    raise OntologySourceUnavailable(f"{current} answered {resp.status_code}")
                if resp.status_code >= 400:
                    raise DocumentError(f"{current} answered {resp.status_code}")
                limit = policy.max_bytes
                length = resp.headers.get("content-length")
                if length is not None and length.isdigit() and int(length) > limit:
                    raise DocumentError(f"{current} is over the {limit}-byte limit")
                body = bytearray()
                for chunk in resp.iter_bytes():
                    in_time()
                    body += chunk
                    if len(body) > limit:
                        raise DocumentError(f"{current} is over the {limit}-byte limit")
                media = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                return Fetched(bytes(body), media, current, file_name_from(current))
        except httpx.TransportError as exc:
            raise OntologySourceUnavailable(f"{current}: {exc}") from exc
    raise DocumentError(f"too many redirects from {url}")
