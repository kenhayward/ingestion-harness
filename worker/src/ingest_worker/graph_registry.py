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
    #: The publishing target the version's copy was written to.
    target_id: str
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
    #: The publishing target holding this version's copy.
    target_id: str


class GraphRegistry(Protocol):
    def publish(self, record: GraphPublish, write: Callable[[int], None]) -> int:
        """Under the graph's lock: the next version, `write(version)` (the copy and the store's
        PUT), then the rows. A `write` that raises records nothing."""
        ...

    def current(self, sha256: str, template_id: str) -> PublishedGraph | None: ...

    def locked(
        self,
        sha256: str,
        template_id: str,
        work: Callable[[PublishedGraph | None, set[int]], None],
    ) -> None:
        """`work(current, versions)` under the graph's lock, as a publish takes it: what a
        withdrawal must spare (a version published since it was queued)."""
        ...

    def all_current(self) -> list[PublishedGraph]: ...

    def entity(self, iri: str) -> tuple[str, list[str]] | None: ...

    def entity_sources(self, iri: str) -> list[tuple[str, str]]: ...

    def ontology_loaded(self, ontology_id: str, version: int, base_iri: str) -> bool:
        """Loaded under this base, by a delivery that has not failed (or before the bridge)."""
        ...

    def record_ontology(
        self,
        ontology_id: str,
        version: int,
        base_iri: str,
        graph_iri: str,
        delivery_id: str | None = None,
    ) -> None: ...

    def all_ontologies(self) -> list[tuple[str, int, str, str]]: ...


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _reusable(
    current: PublishedGraph, record: GraphPublish, handed_over: Callable[[str], bool]
) -> bool:
    """The current version was committed by this same job, for the same graph, and the job
    handed nothing to the bridge since (its hand-off failed): a retry reuses that version
    rather than spend another number on a version that was never delivered."""
    return (
        current.job_id == record.job_id
        and current.graph_iri == record.graph_iri
        and not handed_over(record.job_id)
    )


class MemoryGraphRegistry:
    """GraphRegistry in memory (tests); one lock stands in for the per-graph advisory lock."""

    def __init__(self) -> None:
        self.graphs: dict[tuple[str, str], PublishedGraph] = {}
        self.versions: list[PublishedGraph] = []
        self.entities: dict[str, tuple[str, list[str]]] = {}
        self.sources: dict[str, set[tuple[str, str]]] = {}
        self.ontologies: dict[tuple[str, int, str], str] = {}
        #: The delivery that loaded each ontology graph (None: loaded before the bridge).
        self.ontology_deliveries: dict[tuple[str, int, str], str | None] = {}
        #: A delivery's status as job_deliveries records it (None: no job recorded it). Tests
        #: point it at their queue; by default every delivery is on its way.
        self.delivery_status: Callable[[str], str | None] = lambda _id: "queued"
        #: Whether a job handed anything to the bridge (job_deliveries has a row of it) or has
        #: live published outputs. By default yes, so every publish is a new version.
        self.job_handed_over: Callable[[str], bool] = lambda _job: True
        self._lock = threading.Lock()

    def publish(self, record: GraphPublish, write: Callable[[int], None]) -> int:
        with self._lock:
            key = (record.sha256, record.template_id)
            current = self.graphs.get(key)
            if current is not None and _reusable(current, record, self.job_handed_over):
                version = current.version
                self.versions = [
                    v
                    for v in self.versions
                    if (v.sha256, v.template_id, v.version) != (*key, version)
                ]
            else:
                # Version rows outlive a retirement's forgotten current row: numbers never repeat.
                version = 1 + max(
                    (v.version for v in self.versions if (v.sha256, v.template_id) == key),
                    default=0,
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
                record.target_id,
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

    def locked(
        self,
        sha256: str,
        template_id: str,
        work: Callable[[PublishedGraph | None, set[int]], None],
    ) -> None:
        with self._lock:
            key = (sha256, template_id)
            versions = {v.version for v in self.versions if (v.sha256, v.template_id) == key}
            work(self.graphs.get(key), versions)

    def all_current(self) -> list[PublishedGraph]:
        return sorted(self.graphs.values(), key=lambda g: (g.sha256, g.template_id))

    def entity(self, iri: str) -> tuple[str, list[str]] | None:
        return self.entities.get(iri)

    def entity_sources(self, iri: str) -> list[tuple[str, str]]:
        return sorted(self.sources.get(iri, set()))

    def ontology_loaded(self, ontology_id: str, version: int, base_iri: str) -> bool:
        key = (ontology_id, version, base_iri)
        if key not in self.ontologies:
            return False
        delivery = self.ontology_deliveries.get(key)
        if delivery is None:
            return True
        status = self.delivery_status(delivery)
        return status is not None and status not in ("failed", "needs_user")

    def record_ontology(
        self,
        ontology_id: str,
        version: int,
        base_iri: str,
        graph_iri: str,
        delivery_id: str | None = None,
    ) -> None:
        self.ontologies[(ontology_id, version, base_iri)] = graph_iri
        self.ontology_deliveries[(ontology_id, version, base_iri)] = delivery_id

    def all_ontologies(self) -> list[tuple[str, int, str, str]]:
        return sorted((i, v, b, g) for (i, v, b), g in self.ontologies.items())


_GRAPH_COLUMNS = """sha256, template_id, graph_iri, version, job_id::text, document_id::text,
                    template_version, base_iri, triples, published_at, target_id"""


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
        target_id=row[10],
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
            # A retry of a job whose hand-off never happened reuses the version it committed:
            # same job, same graph, and the job neither handed anything to the bridge
            # (job_deliveries) nor has live published outputs (a publish from before the bridge).
            reused = self._conn.execute(
                """SELECT version FROM published_graphs
                    WHERE sha256 = %s AND template_id = %s AND job_id = %s AND graph_iri = %s
                      AND NOT EXISTS (SELECT 1 FROM job_deliveries WHERE job_id = %s)
                      AND NOT EXISTS (SELECT 1 FROM job_outputs
                                       WHERE job_id = %s AND stage = 'published'
                                         AND withdrawn_at IS NULL)""",
                (*key, record.job_id, record.graph_iri, record.job_id, record.job_id),
            ).fetchone()
            if reused is not None:
                version = int(reused[0])
            else:
                # Version rows outlive a retirement's forgotten current row: numbers never
                # repeat.
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
                record.target_id,
            )
            self._conn.execute(
                """INSERT INTO published_graphs (sha256, template_id, graph_iri, version, job_id,
                       document_id, template_version, base_iri, triples, target_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (sha256, template_id) DO UPDATE SET
                     graph_iri = EXCLUDED.graph_iri, version = EXCLUDED.version,
                     job_id = EXCLUDED.job_id, document_id = EXCLUDED.document_id,
                     template_version = EXCLUDED.template_version,
                     base_iri = EXCLUDED.base_iri, triples = EXCLUDED.triples,
                     target_id = EXCLUDED.target_id, published_at = now()""",
                values,
            )
            self._conn.execute(
                """INSERT INTO published_graph_versions (sha256, template_id, graph_iri, version,
                       job_id, document_id, template_version, base_iri, triples, target_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (sha256, template_id, version) DO UPDATE SET
                     graph_iri = EXCLUDED.graph_iri, job_id = EXCLUDED.job_id,
                     document_id = EXCLUDED.document_id,
                     template_version = EXCLUDED.template_version,
                     base_iri = EXCLUDED.base_iri, triples = EXCLUDED.triples,
                     target_id = EXCLUDED.target_id, published_at = now()""",
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

    def locked(
        self,
        sha256: str,
        template_id: str,
        work: Callable[[PublishedGraph | None, set[int]], None],
    ) -> None:
        key = (sha256, template_id)
        with self._conn.transaction():
            self._conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext('graph:' || %s || ':' || %s))", key
            )
            rows = self._conn.execute(
                "SELECT version FROM published_graph_versions WHERE sha256 = %s AND template_id = %s",
                key,
            ).fetchall()
            work(self.current(sha256, template_id), {r[0] for r in rows})

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
        # A row from before the bridge has no delivery; otherwise a job must have recorded the
        # delivery, and it must not have failed (or need a person). A load no job recorded (the
        # job failed after the bridge took it, or was deleted) is loaded again by the next
        # publish.
        row = self._conn.execute(
            """SELECT 1 FROM published_ontology_graphs o
                WHERE o.ontology_id = %s AND o.version = %s AND o.base_iri = %s
                  AND (o.delivery_id IS NULL
                       OR EXISTS (SELECT 1 FROM job_deliveries d
                                   WHERE d.delivery_id = o.delivery_id
                                     AND d.status NOT IN ('failed', 'needs_user')))""",
            (ontology_id, version, base_iri),
        ).fetchone()
        return row is not None

    def record_ontology(
        self,
        ontology_id: str,
        version: int,
        base_iri: str,
        graph_iri: str,
        delivery_id: str | None = None,
    ) -> None:
        self._conn.execute(
            """INSERT INTO published_ontology_graphs
                   (ontology_id, version, base_iri, graph_iri, delivery_id)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (ontology_id, version, base_iri)
               DO UPDATE SET loaded_at = now(), delivery_id = EXCLUDED.delivery_id""",
            (ontology_id, version, base_iri, graph_iri, delivery_id),
        )

    def all_ontologies(self) -> list[tuple[str, int, str, str]]:
        rows = self._conn.execute(
            """SELECT ontology_id, version, base_iri, graph_iri FROM published_ontology_graphs
                ORDER BY ontology_id, version, base_iri"""
        ).fetchall()
        return [(r[0], r[1], r[2], r[3]) for r in rows]
