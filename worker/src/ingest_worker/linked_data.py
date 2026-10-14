"""Linked data settings (ADR 0011). Mirrors packages/shared/src/linked-data.ts."""

from __future__ import annotations

#: Where IRIs live when the customer has not given their own base.
FALLBACK_BASE_IRI = "https://id.stocks-hayward.com/"


def effective_base_iri(customer_slug: str | None, base_iri: str | None) -> str | None:
    """The base IRI RDF is minted under; None: RDF is skipped until a customer is set."""
    if base_iri:
        return base_iri
    return f"{FALLBACK_BASE_IRI}{customer_slug}/" if customer_slug else None
