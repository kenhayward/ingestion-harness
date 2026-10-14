from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.main import run_once
from ingest_worker.ontology import (
    ONTOLOGY_INDEXED,
    ParsedOntology,
    PgOntologyStore,
    parse_ontology,
)
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, ontology_normalized_key

from .fakes import FakeQueue, MemoryOntologyStore

TTL = b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
<https://example.org/pv#Batch> a owl:Class .
"""
SOURCE = "ontologies/pv/sources/abc.ttl"


def ontology_job(attempts: int = 1, **params: Any) -> ClaimedJob:
    base = {
        "ontologyId": "pv",
        "version": 1,
        "sourceKey": SOURCE,
        "fileName": "pv.ttl",
        "mediaType": "text/turtle",
    }
    return ClaimedJob(
        id="job-o",
        document_id="",
        spec_id="",
        spec_version=0,
        bucket="",
        object_key="",
        model_override=None,
        attempts=attempts,
        max_attempts=3,
        task="ontology",
        params={**base, **params},
    )


def make(
    fixture_specs_dir: Path, source: bytes | None = TTL
) -> tuple[PipelineDeps, MemoryObjectStore, MemoryOntologyStore]:
    store = MemoryObjectStore()
    if source is not None:
        store.put("runs", SOURCE, source, "text/turtle")
    ontologies = MemoryOntologyStore()
    deps = PipelineDeps(
        store=store,
        specs=load_specs(fixture_specs_dir),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        ontologies=ontologies,
    )
    return deps, store, ontologies


def test_indexes_a_version_and_writes_its_normalized_triples(fixture_specs_dir: Path) -> None:
    deps, store, ontologies = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[ontology_job()])
    assert run_once(queue, deps, "w1")
    assert [job_id for job_id, _ in queue.completed] == ["job-o"]
    assert ontologies.status[("pv", 1)] == "ready"
    assert [t.iri for t in ontologies.saved[("pv", 1)].terms] == ["https://example.org/pv#Batch"]
    body, ctype = store.objects[("runs", ontology_normalized_key("pv", 1))]
    assert ctype == "application/n-triples" and b"owl#Class" in body
    assert ("job-o", "info", ONTOLOGY_INDEXED) in queue.events


def test_an_unreadable_file_fails_the_version_and_goes_to_review(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir, source=b"not { turtle")
    queue = FakeQueue(jobs=[ontology_job()])
    run_once(queue, deps, "w1")
    [(job_id, reason)] = queue.reviewed
    assert job_id == "job-o" and "cannot read pv.ttl as Turtle" in reason
    assert ontologies.status[("pv", 1)] == "failed"
    assert "cannot read" in ontologies.errors[("pv", 1)]


def test_a_missing_source_is_a_review_not_a_retry(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir, source=None)
    queue = FakeQueue(jobs=[ontology_job()])
    run_once(queue, deps, "w1")
    assert "uploaded file is missing" in queue.reviewed[0][1]
    assert not queue.failed
    assert ontologies.status[("pv", 1)] == "failed"


def test_bad_params_and_no_store_go_to_review(fixture_specs_dir: Path) -> None:
    deps, _, _ = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[ontology_job(version="one")])
    run_once(queue, deps, "w1")
    assert "invalid ontology import parameters" in queue.reviewed[0][1]
    deps.ontologies = None
    queue = FakeQueue(jobs=[ontology_job()])
    run_once(queue, deps, "w1")
    assert "no ontology store" in queue.reviewed[0][1]


class Broken(MemoryOntologyStore):
    def save(self, ontology_id: str, version: int, parsed: ParsedOntology) -> None:
        raise ConnectionError("database went away")


@pytest.mark.parametrize(("attempts", "status"), [(1, "parsing"), (3, "failed")])
def test_transient_errors_retry_and_fail_the_version_on_the_last_attempt(
    fixture_specs_dir: Path, attempts: int, status: str
) -> None:
    deps, _, _ = make(fixture_specs_dir)
    broken = Broken()
    deps.ontologies = broken
    queue = FakeQueue(jobs=[ontology_job(attempts=attempts)])
    run_once(queue, deps, "w1")
    assert queue.failed and not queue.reviewed
    assert broken.status[("pv", 1)] == status


@pytest.mark.integration
def test_pg_store_saves_terms_and_ready_is_immutable() -> None:
    """Needs IH_TEST_DATABASE_URL on a throwaway database that already has db/migrations applied
    (run the API's ontology-pg integration test first: it applies them)."""
    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set")
    import psycopg

    conn = psycopg.connect(url, autocommit=True)
    conn.execute("DELETE FROM ontologies WHERE id = 'pv-worker-test'")
    conn.execute("INSERT INTO ontologies (id, label) VALUES ('pv-worker-test', 'PV')")
    conn.execute(
        """INSERT INTO ontology_versions (ontology_id, version, file_name, media_type, sha256, bytes)
           VALUES ('pv-worker-test', 1, 'pv.ttl', 'text/turtle', 'abc', 10)"""
    )
    store = PgOntologyStore(conn)
    store.start("pv-worker-test", 1)
    store.save("pv-worker-test", 1, parse_ontology(TTL, "text/turtle", "pv.ttl"))
    row = conn.execute(
        """SELECT status, kinds, stats->>'classes' FROM ontology_versions
            WHERE ontology_id = 'pv-worker-test'"""
    ).fetchone()
    assert row == ("ready", ["owl"], "1")
    terms = conn.execute(
        "SELECT iri, kind, root FROM ontology_terms WHERE ontology_id = 'pv-worker-test'"
    ).fetchall()
    assert terms == [("https://example.org/pv#Batch", "class", True)]
    with pytest.raises(psycopg.errors.RaiseException, match="ready and cannot change"):
        conn.execute(
            "UPDATE ontology_versions SET error = 'x' WHERE ontology_id = 'pv-worker-test'"
        )
    conn.execute("DELETE FROM ontologies WHERE id = 'pv-worker-test'")
    conn.close()
