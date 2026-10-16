"""Linked data settings (ADR 0011). Mirrors packages/shared/src/linked-data.ts."""

from __future__ import annotations

from typing import Any, Protocol

import psycopg

#: Where IRIs live when the customer has not given their own base.
FALLBACK_BASE_IRI = "https://id.stocks-hayward.com/"


def effective_base_iri(customer_slug: str | None, base_iri: str | None) -> str | None:
    """The base IRI RDF is minted under; None: RDF is skipped until a customer is set."""
    if base_iri:
        return base_iri
    return f"{FALLBACK_BASE_IRI}{customer_slug}/" if customer_slug else None


class LinkedDataSettings(Protocol):
    """The Linked data settings (Administration > Linked data, migration 0034), read for every graph."""

    def effective_base(self) -> str | None: ...


class PgLinkedDataSettings:
    """Reads the one settings row on every call: an admin's change applies to the next job."""

    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self.conn = conn

    def effective_base(self) -> str | None:
        row = self.conn.execute(
            "SELECT customer_slug, base_iri FROM linked_data_settings"
        ).fetchone()
        return effective_base_iri(row[0], row[1]) if row else None
