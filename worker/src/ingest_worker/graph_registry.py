"""The graphs published to the triple store (ADR 0011 step 6, migration 0036): one per original
document (its sha256) and document type, with a version per publish, the entities each graph
minted, and the ontology versions loaded as TBox graphs."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

import psycopg


@dataclass(frozen=True)
class EntityRecord:
    """A minted entity IRI, its class and the key values it was built from (safeguard 2)."""

    iri: str
    kind: str
    scoped_key: list[str]


@dataclass(frozen=True)
class GraphPublish:
    """What one publish of a (sha256, type) graph records."""

    sha256: str
    template_id: str
    graph_iri: str
    job_id: str
    document_id: str
    template_version: int
    base_iri: str
    triples: int
    entities: list[EntityRecord] = field(default_factory=list)


@dataclass(frozen=True)
class PublishedGraph:
    """The current version of a (sha256, type) graph."""

    sha256: str
    template_id: str
    graph_iri: str
    version: int
    job_id: str
    document_id: str
    template_version: int
    base_iri: str
    triples: int
    published_at: str


class GraphRegistry(Protocol):
    def publish(self, record: GraphPublish, write: Callable[[int], None]) -> int:
        """Under the graph's lock: the next version, `write(version)` (the copy and the store's
        PUT), then the rows. A `write` that raises records nothing."""
        ...

    def current(self, sha256: str, template_id: str) -> PublishedGraph | None: ...

    def all_current(self) -> list[PublishedGraph]: ...

    def entity(self, iri: str) -> tuple[str, list[str]] | None: ...

    def entity_sources(self, iri: str) -> list[tuple[str, str]]: ...

    def ontology_loaded(self, ontology_id: str, version: int, base_iri: str) -> bool: ...

    def record_ontology(
        self, ontology_id: str, version: int, base_iri: str, graph_iri: str
    ) -> None: ...

    def all_ontologies(self) -> list[tuple[str, int, str, str]]: ...


def _now() -> str:
    return datetime.now(UTC).isoformat()


class MemoryGraphRegistry:
    """GraphRegistry in memory (tests); one lock stands in for the per-graph advisory lock."""

    def __init__(self) -> None:
        self.graphs: dict[tuple[str, str], PublishedGraph] = {}
        self.versions: list[PublishedGraph] = []
        self.entities: dict[str, tuple[str, list[str]]] = {}
        self.sources: dict[str, set[tuple[str, str]]] = {}
        self.ontologies: dict[tuple[str, int, str], str] = {}
        self._lock = threading.Lock()

    def publish(self, record: GraphPublish, write: Callable[[int], None]) -> int:
        with self._lock:
            key = (record.sha256, record.template_id)
            # Version rows outlive a retirement's forgotten current row: numbers never repeat.
            version = 1 + max(
                (v.version for v in self.versions if (v.sha256, v.template_id) == key), default=0
            )
            write(version)
            graph = PublishedGraph(
                record.sha256,
                record.template_id,
                record.graph_iri,
                version,
                record.job_id,
                record.document_id,
                record.template_version,
                record.base_iri,
                record.triples,
                _now(),
            )
            self.graphs[key] = graph
            self.versions.append(graph)
            for sources in self.sources.values():
                sources.discard(key)
            for e in record.entities:
                self.entities.setdefault(e.iri, (e.kind, list(e.scoped_key)))
                self.sources.setdefault(e.iri, set()).add(key)
            return version

    def current(self, sha256: str, template_id: str) -> PublishedGraph | None:
        return self.graphs.get((sha256, template_id))

    def all_current(self) -> list[PublishedGraph]:
        return sorted(self.graphs.values(), key=lambda g: (g.sha256, g.template_id))

    def entity(self, iri: str) -> tuple[str, list[str]] | None:
        return self.entities.get(iri)

    def entity_sources(self, iri: str) -> list[tuple[str, str]]:
        return sorted(self.sources.get(iri, set()))

    def ontology_loaded(self, ontology_id: str, version: int, base_iri: str) -> bool:
        return (ontology_id, version, base_iri) in self.ontologies

    def record_ontology(
        self, ontology_id: str, version: int, base_iri: str, graph_iri: str
    ) -> None:
        self.ontologies[(ontology_id, version, base_iri)] = graph_iri

    def all_ontologies(self) -> list[tuple[str, int, str, str]]:
        return sorted((i, v, b, g) for (i, v, b), g in self.ontologies.items())


_GRAPH_COLUMNS = """sha256, template_id, graph_iri, version, job_id::text, document_id::text,
                    template_version, base_iri, triples, published_at"""


def _graph(row: tuple[Any, ...]) -> PublishedGraph:
    return PublishedGraph(
        sha256=row[0],
        template_id=row[1],
        graph_iri=row[2],
        version=row[3],
        job_id=row[4],
        document_id=row[5],
        template_version=row[6],
        base_iri=row[7],
        triples=row[8],
        published_at=row[9].isoformat(),
    )


class PgGraphRegistry:
    """GraphRegistry on Postgres (migration 0036). Its connection is autocommit: `publish`
    opens its own transaction, holding `pg_advisory_xact_lock` on the graph while it writes."""

    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self._conn = conn

    def publish(self, record: GraphPublish, write: Callable[[int], None]) -> int:
        from psycopg.types.json import Jsonb

        key = (record.sha256, record.template_id)
        with self._conn.transaction():
            self._conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext('graph:' || %s || ':' || %s))", key
            )
            # Version rows outlive a retirement's forgotten current row: numbers never repeat.
            row = self._conn.execute(
                """SELECT coalesce(max(version), 0) FROM published_graph_versions
                    WHERE sha256 = %s AND template_id = %s""",
                key,
            ).fetchone()
            version = (row[0] if row else 0) + 1
            write(version)
            values = (
                record.sha256,
                record.template_id,
                record.graph_iri,
                version,
                record.job_id,
                record.document_id,
                record.template_version,
                record.base_iri,
                record.triples,
            )
            self._conn.execute(
                """INSERT INTO published_graphs (sha256, template_id, graph_iri, version, job_id,
                       document_id, template_version, base_iri, triples)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (sha256, template_id) DO UPDATE SET
                     graph_iri = EXCLUDED.graph_iri, version = EXCLUDED.version,
                     job_id = EXCLUDED.job_id, document_id = EXCLUDED.document_id,
                     template_version = EXCLUDED.template_version,
                     base_iri = EXCLUDED.base_iri, triples = EXCLUDED.triples,
                     published_at = now()""",
                values,
            )
            self._conn.execute(
                """INSERT INTO published_graph_versions (sha256, template_id, graph_iri, version,
                       job_id, document_id, template_version, base_iri, triples)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                values,
            )
            self._conn.execute(
                "DELETE FROM published_entity_sources WHERE sha256 = %s AND template_id = %s",
                key,
            )
            for e in record.entities:
                self._conn.execute(
                    """INSERT INTO published_entities (iri, kind, scoped_key) VALUES (%s, %s, %s)
                       ON CONFLICT (iri) DO NOTHING""",
                    (e.iri, e.kind, Jsonb(e.scoped_key)),
                )
                self._conn.execute(
                    """INSERT INTO published_entity_sources (iri, sha256, template_id, job_id)
                       VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                    (e.iri, *key, record.job_id),
                )
        return version

    def current(self, sha256: str, template_id: str) -> PublishedGraph | None:
        row = self._conn.execute(
            f"SELECT {_GRAPH_COLUMNS} FROM published_graphs WHERE sha256 = %s AND template_id = %s",
            (sha256, template_id),
        ).fetchone()
        return _graph(row) if row else None

    def all_current(self) -> list[PublishedGraph]:
        rows = self._conn.execute(
            f"SELECT {_GRAPH_COLUMNS} FROM published_graphs ORDER BY sha256, template_id"
        ).fetchall()
        return [_graph(r) for r in rows]

    def entity(self, iri: str) -> tuple[str, list[str]] | None:
        row = self._conn.execute(
            "SELECT kind, scoped_key FROM published_entities WHERE iri = %s", (iri,)
        ).fetchone()
        return (row[0], list(row[1])) if row else None

    def entity_sources(self, iri: str) -> list[tuple[str, str]]:
        rows = self._conn.execute(
            """SELECT sha256, template_id FROM published_entity_sources WHERE iri = %s
                ORDER BY sha256, template_id""",
            (iri,),
        ).fetchall()
        return [(r[0], r[1]) for r in rows]

    def ontology_loaded(self, ontology_id: str, version: int, base_iri: str) -> bool:
        row = self._conn.execute(
            """SELECT 1 FROM published_ontology_graphs
                WHERE ontology_id = %s AND version = %s AND base_iri = %s""",
            (ontology_id, version, base_iri),
        ).fetchone()
        return row is not None

    def record_ontology(
        self, ontology_id: str, version: int, base_iri: str, graph_iri: str
    ) -> None:
        self._conn.execute(
            """INSERT INTO published_ontology_graphs (ontology_id, version, base_iri, graph_iri)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (ontology_id, version, base_iri) DO UPDATE SET loaded_at = now()""",
            (ontology_id, version, base_iri, graph_iri),
        )

    def all_ontologies(self) -> list[tuple[str, int, str, str]]:
        rows = self._conn.execute(
            """SELECT ontology_id, version, base_iri, graph_iri FROM published_ontology_graphs
                ORDER BY ontology_id, version, base_iri"""
        ).fetchall()
        return [(r[0], r[1], r[2], r[3]) for r in rows]
