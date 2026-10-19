"""The published graphs registry (ADR 0011 step 6): one contract, on memory and on Postgres.

IH_TEST_DATABASE_URL points at a THROWAWAY migrated database (it empties published_*)."""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Iterator
from typing import Any

import pytest

from ingest_worker.graph_registry import (
    EntityRecord,
    GraphPublish,
    GraphRegistry,
    MemoryGraphRegistry,
    PgGraphRegistry,
)

SHA = "ab" * 32
JOB = "11111111-1111-4111-8111-111111111111"
DOC = "22222222-2222-4222-8222-222222222222"
BASE = "https://data.acme.example/"
BATCH = f"{BASE}batch/pv-1"


def record(template_id: str = "letter", **over: Any) -> GraphPublish:
    values: dict[str, Any] = {
        "sha256": SHA,
        "template_id": template_id,
        "graph_iri": f"{BASE}graph/source/{SHA}/{template_id}",
        "job_id": JOB,
        "document_id": DOC,
        "template_version": 1,
        "base_iri": BASE,
        "triples": 10,
        "entities": [EntityRecord(BATCH, "https://a/Batch", ["pv-1"])],
        "target_id": "default",
    }
    values.update(over)
    return GraphPublish(**values)


def _pg_url() -> str:
    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set (a throwaway database: it empties published_*)")
    return url


def _reset(conn: Any) -> None:
    for table in (
        "published_entity_sources",
        "published_entities",
        "published_graph_versions",
        "published_graphs",
        "published_ontology_graphs",
    ):
        conn.execute(f"DELETE FROM {table}")


def _pg(reset: bool = True) -> PgGraphRegistry:
    import psycopg

    conn = psycopg.connect(_pg_url(), autocommit=True)
    if reset:
        _reset(conn)
        conn.execute(
            """INSERT INTO publish_targets (id, label, kind, bucket)
               VALUES ('finance-lake', 'Finance lake', 'internal', 'finance')
               ON CONFLICT (id) DO NOTHING"""
        )
    return PgGraphRegistry(conn)


@pytest.fixture(params=["memory", pytest.param("pg", marks=pytest.mark.integration)])
def registry(request: pytest.FixtureRequest) -> Iterator[GraphRegistry]:
    if request.param == "memory":
        yield MemoryGraphRegistry()
        return
    pg = _pg()
    yield pg
    _reset(pg._conn)  # nothing left recording a test target (publish_targets tests remove them)


def test_nothing_is_published_at_first(registry: GraphRegistry) -> None:
    assert registry.current(SHA, "letter") is None
    assert registry.all_current() == []


def test_each_publish_is_the_next_version(registry: GraphRegistry) -> None:
    written: list[int] = []
    assert registry.publish(record(), written.append) == 1
    assert registry.publish(record(triples=12), written.append) == 2
    assert written == [1, 2]
    current = registry.current(SHA, "letter")
    assert current is not None
    assert (current.version, current.triples, current.base_iri) == (2, 12, BASE)
    assert current.graph_iri == f"{BASE}graph/source/{SHA}/letter"
    assert current.job_id == JOB
    assert [g.version for g in registry.all_current()] == [2]


def test_each_version_records_its_publishing_target(registry: GraphRegistry) -> None:
    registry.publish(record(), lambda _v: None)
    current = registry.current(SHA, "letter")
    assert current is not None and current.target_id == "default"
    registry.publish(record(target_id="finance-lake"), lambda _v: None)
    current = registry.current(SHA, "letter")
    assert current is not None and current.target_id == "finance-lake"
    assert [g.target_id for g in registry.all_current()] == ["finance-lake"]


def test_a_failed_write_records_nothing(registry: GraphRegistry) -> None:
    def fail(_version: int) -> None:
        raise RuntimeError("store down")

    with pytest.raises(RuntimeError):
        registry.publish(record(), fail)
    assert registry.current(SHA, "letter") is None
    assert registry.entity_sources(BATCH) == []
    assert registry.publish(record(), lambda _v: None) == 1
    assert registry.entity_sources(BATCH) == [(SHA, "letter")]


def test_types_of_one_file_have_their_own_graphs_and_share_entities(
    registry: GraphRegistry,
) -> None:
    registry.publish(record("letter"), lambda _v: None)
    registry.publish(record("memo"), lambda _v: None)
    letter = registry.current(SHA, "letter")
    assert letter is not None and letter.version == 1
    assert registry.current(SHA, "memo") is not None
    assert sorted(registry.entity_sources(BATCH)) == [(SHA, "letter"), (SHA, "memo")]
    assert registry.entity(BATCH) == ("https://a/Batch", ["pv-1"])


def test_a_republish_replaces_the_entities_it_mentions(registry: GraphRegistry) -> None:
    registry.publish(record(), lambda _v: None)
    other = EntityRecord(f"{BASE}batch/pv-2", "https://a/Batch", ["pv-2"])
    registry.publish(record(entities=[other]), lambda _v: None)
    assert registry.entity_sources(BATCH) == []
    assert registry.entity_sources(f"{BASE}batch/pv-2") == [(SHA, "letter")]


def test_ontology_graphs_are_loaded_once_per_base(registry: GraphRegistry) -> None:
    assert not registry.ontology_loaded("acme", 1, BASE)
    registry.record_ontology("acme", 1, BASE, f"{BASE}graph/ontology/acme/1")
    registry.record_ontology("acme", 1, BASE, f"{BASE}graph/ontology/acme/1")  # idempotent
    assert registry.ontology_loaded("acme", 1, BASE)
    assert not registry.ontology_loaded("acme", 1, "https://other.example/")
    assert registry.all_ontologies() == [("acme", 1, BASE, f"{BASE}graph/ontology/acme/1")]


@pytest.mark.integration
def test_concurrent_publishes_of_one_graph_serialise() -> None:
    _pg()
    order: list[int] = []

    def one() -> None:
        def write(version: int) -> None:
            time.sleep(0.2)  # inside the lock: the other publish must wait
            order.append(version)

        _pg(reset=False).publish(record(), write)

    threads = [threading.Thread(target=one) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert order == [1, 2]


def test_locked_reads_the_current_graph_and_its_versions(registry: GraphRegistry) -> None:
    seen: list[tuple[int | None, set[int]]] = []
    registry.locked(SHA, "letter", lambda cur, vs: seen.append((cur and cur.version, vs)))
    registry.publish(record(), lambda _v: None)
    registry.publish(record(), lambda _v: None)
    registry.locked(SHA, "letter", lambda cur, vs: seen.append((cur and cur.version, vs)))
    assert seen == [(None, set()), (2, {1, 2})]


def _fail_delivery(registry: GraphRegistry, delivery_id: str) -> None:
    """The delivery ended failed: job_deliveries in Postgres, a set in memory."""
    if isinstance(registry, MemoryGraphRegistry):
        registry.failed_deliveries.add(delivery_id)
        return
    assert isinstance(registry, PgGraphRegistry)
    job = registry._conn.execute(
        "INSERT INTO jobs (task, status, params) VALUES ('rebuild', 'failed', '{}') RETURNING id"
    ).fetchone()
    assert job is not None
    registry._conn.execute(
        """INSERT INTO job_deliveries (delivery_id, job_id, target_id, status)
           VALUES (%s, %s, 'finance-lake', 'failed')""",
        (delivery_id, job[0]),
    )


def test_an_ontology_whose_delivery_failed_is_not_loaded(registry: GraphRegistry) -> None:
    import uuid

    ok, failed = str(uuid.uuid4()), str(uuid.uuid4())
    registry.record_ontology("acme", 1, BASE, f"{BASE}graph/ontology/acme/1", ok)
    registry.record_ontology("acme", 2, BASE, f"{BASE}graph/ontology/acme/2", failed)
    _fail_delivery(registry, failed)
    assert registry.ontology_loaded("acme", 1, BASE)  # on its way, or done
    assert not registry.ontology_loaded("acme", 2, BASE)  # loaded again by the next publish
    registry.record_ontology("acme", 2, BASE, f"{BASE}graph/ontology/acme/2", str(uuid.uuid4()))
    assert registry.ontology_loaded("acme", 2, BASE)
