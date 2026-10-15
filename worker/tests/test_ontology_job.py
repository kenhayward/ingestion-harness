from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.main import run_once
from ingest_worker.ontology import (
    ONTOLOGY_INDEXED,
    ParsedOntology,
    PgOntologyStore,
    parse_ontology,
)
from ingest_worker.ontology_fetch import Fetched, OntologySourceUnavailable
from ingest_worker.pipeline import Buckets, DocumentError, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import (
    MemoryObjectStore,
    ontology_normalized_key,
    ontology_source_key,
)

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


ROOT = b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://w3id.org/pv> a owl:Ontology ;
    owl:imports <https://w3id.org/base> , <https://w3id.org/lib> , <https://nope.org/x> .
<https://w3id.org/pv#Batch> a owl:Class ; rdfs:subClassOf <https://w3id.org/base#Thing> .
"""
BASE = b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://w3id.org/base> a owl:Ontology ; rdfs:label "Base" ; owl:imports <https://w3id.org/pv> .
<https://w3id.org/base#Thing> a owl:Class .
"""
LIB = (
    b"<https://w3id.org/lib#Unit> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> "
    b"<http://www.w3.org/2002/07/owl#Class> .\n"
)


def web(pages: dict[str, bytes]) -> Callable[[str], Fetched]:
    def fetch(url: str) -> Fetched:
        if url not in pages:
            raise DocumentError(f"{httpx.URL(url).host} is not on ONTOLOGY_FETCH_ALLOW")
        return Fetched(pages[url], "text/turtle", url, url.rsplit("/", 1)[-1])

    return fetch


def url_job() -> ClaimedJob:
    return ontology_job(
        sourceKey=None, sourceUrl="https://w3id.org/pv", fileName="pv", mediaType=""
    )


def test_imports_by_url_resolving_imports_from_the_library_and_the_web(
    fixture_specs_dir: Path,
) -> None:
    deps, store, ontologies = make(fixture_specs_dir, source=None)
    ontologies.library["https://w3id.org/lib"] = ("lib", 4)
    store.put("runs", ontology_normalized_key("lib", 4), LIB, "application/n-triples")
    deps.ontology_fetch = web({"https://w3id.org/pv": ROOT, "https://w3id.org/base": BASE})
    run_once(FakeQueue(jobs=[url_job()]), deps, "w1")

    assert ontologies.status[("pv", 1)] == "ready"
    sha = ontologies.sources[("pv", 1)]["sha256"]
    assert ("runs", ontology_source_key("pv", sha, "ttl")) in store.objects
    imports = {e["iri"]: e for e in ontologies.saved[("pv", 1)].import_entries}
    assert imports["https://w3id.org/lib"] == {
        "iri": "https://w3id.org/lib",
        "resolution": "library",
        "ontologyId": "lib",
        "version": 4,
        "reason": None,
    }
    assert imports["https://w3id.org/base"]["resolution"] == "fetched"
    assert imports["https://nope.org/x"]["resolution"] == "unresolved"
    assert "not on ONTOLOGY_FETCH_ALLOW" in imports["https://nope.org/x"]["reason"]
    # Base was created once, as a library ontology tagged with its importer; its import of pv
    # (a cycle back to the root) did not recurse.
    [(created_id, created)] = ontologies.created.items()
    assert created["title"] == "Base" and created["root_id"] == "pv"
    assert ("runs", ontology_normalized_key(created_id, 1)) in store.objects
    terms = {t.iri: t for t in ontologies.saved[("pv", 1)].terms}
    assert terms["https://w3id.org/base#Thing"].defined_in == f"{created_id}@1"
    assert terms["https://w3id.org/lib#Unit"].defined_in == "lib@4"
    assert not terms["https://w3id.org/pv#Batch"].root


def test_url_imports_off_fails_the_version(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir, source=None)
    queue = FakeQueue(jobs=[url_job()])
    run_once(queue, deps, "w1")
    assert "URL imports are off" in queue.reviewed[0][1]
    assert ontologies.status[("pv", 1)] == "failed"


def test_the_same_bytes_as_another_version_fail_the_version(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir, source=None)
    ontologies.duplicate_of = 2
    deps.ontology_fetch = web({"https://w3id.org/pv": ROOT})
    queue = FakeQueue(jobs=[url_job()])
    run_once(queue, deps, "w1")
    assert "same file as version 2" in queue.reviewed[0][1]


def test_an_unreachable_host_is_retried(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir, source=None)

    def down(url: str) -> Fetched:
        raise OntologySourceUnavailable(f"{url} answered 503")

    deps.ontology_fetch = down
    queue = FakeQueue(jobs=[url_job()])
    run_once(queue, deps, "w1")
    assert queue.failed and not queue.reviewed
    assert ontologies.status[("pv", 1)] == "parsing"


def test_an_unreachable_import_is_listed_not_fatal(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir, source=None)

    def fetch(url: str) -> Fetched:
        if url == "https://w3id.org/pv":
            return Fetched(ROOT, "text/turtle", url, "pv")
        raise OntologySourceUnavailable(f"{url} answered 503")

    deps.ontology_fetch = fetch
    run_once(FakeQueue(jobs=[url_job()]), deps, "w1")
    entries = {e["iri"]: e for e in ontologies.saved[("pv", 1)].import_entries}
    assert entries["https://w3id.org/base"]["resolution"] == "unresolved"
    assert entries["https://w3id.org/base"]["reason"].startswith("unavailable:")


def test_params_need_exactly_one_source(fixture_specs_dir: Path) -> None:
    deps, _, _ = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[ontology_job(sourceUrl="https://w3id.org/pv")])  # both set
    run_once(queue, deps, "w1")
    assert "invalid ontology import parameters" in queue.reviewed[0][1]


@pytest.mark.integration
def test_pg_store_imports_and_duplicate_sources() -> None:
    """Needs IH_TEST_DATABASE_URL with db/migrations applied (see the test above)."""
    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set")
    import psycopg

    from ingest_worker.ontology import DuplicateSource, index_graph, read_graph

    conn = psycopg.connect(url, autocommit=True)
    conn.execute("DELETE FROM ontologies WHERE id IN ('pv-url', 'w3id-org-base-alias')")
    conn.execute("INSERT INTO ontologies (id, label) VALUES ('pv-url', 'PV')")
    conn.execute(
        """INSERT INTO ontology_versions
             (ontology_id, version, file_name, media_type, source_kind, source_url)
           VALUES ('pv-url', 1, 'pv', '', 'url', 'https://w3id.org/pv'),
                  ('pv-url', 2, 'pv', '', 'url', 'https://w3id.org/pv')"""
    )
    store = PgOntologyStore(conn)
    store.set_source("pv-url", 1, file_name="pv.ttl", media_type="text/turtle", sha256="s1", size=3)
    with pytest.raises(DuplicateSource) as dup:
        store.set_source(
            "pv-url", 2, file_name="pv.ttl", media_type="text/turtle", sha256="s1", size=3
        )
    assert dup.value.version == 1

    base = read_graph(BASE, "text/turtle", "base.ttl", max_triples=1000)
    parsed = index_graph(base)
    parsed.import_entries = [
        {
            "iri": "https://w3id.org/pv",
            "resolution": "unresolved",
            "ontologyId": None,
            "version": None,
            "reason": "a cycle back to an ontology being imported",
        }
    ]
    committed: list[tuple[str, int]] = []
    oid, version = store.create_imported(
        iri="http://w3id.org/base-alias",
        title=parsed.title,
        file_name="base.ttl",
        media_type="text/turtle",
        sha256="b1",
        size=len(BASE),
        source_url="https://w3id.org/base",
        parsed=parsed,
        root_id="pv-url",
        before_commit=lambda oid, v: committed.append((oid, v)),
    )
    assert (oid, version) == ("w3id-org-base-alias", 1) and committed == [(oid, 1)]
    # Found by its declared IRI and by the IRI it was imported by.
    assert store.find_ready("https://w3id.org/base") == (oid, 1)
    assert store.find_ready("http://w3id.org/base-alias") == (oid, 1)
    assert store.version_imports(oid, 1)[0]["reason"].startswith("a cycle")
    row = conn.execute(
        "SELECT o.label, o.tags, v.status, v.source_kind FROM ontologies o "
        "JOIN ontology_versions v ON v.ontology_id = o.id WHERE o.id = %s",
        (oid,),
    ).fetchone()
    assert row == ("Base", ["imported-by:pv-url"], "ready", "import")

    own = read_graph(ROOT, "text/turtle", "pv.ttl", max_triples=1000)
    store.save("pv-url", 1, index_graph(own, imports=[(base, f"{oid}@1")]))
    defined = conn.execute(
        "SELECT defined_in FROM ontology_terms WHERE ontology_id = 'pv-url' AND iri = %s",
        ("https://w3id.org/base#Thing",),
    ).fetchone()
    assert defined == (f"{oid}@1",)
    conn.execute("DELETE FROM ontologies WHERE id IN ('pv-url', 'w3id-org-base-alias')")
    conn.close()


BIG = (
    b"\n".join(
        f"<https://w3id.org/big#C{i}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> "
        f"<http://www.w3.org/2002/07/owl#Class> .".encode()
        for i in range(18)
    )
    + b"\n"
)
ROOT_BIG = b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
<https://w3id.org/pv> a owl:Ontology ; owl:imports <https://w3id.org/big> .
<https://w3id.org/pv#Batch> a owl:Class .
"""


def test_an_import_over_the_triple_limit_is_listed_not_fatal(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir, source=None)
    deps.ontology_max_triples = 20
    deps.ontology_fetch = web({"https://w3id.org/pv": ROOT_BIG, "https://w3id.org/big": BIG})
    run_once(FakeQueue(jobs=[url_job()]), deps, "w1")
    assert ontologies.status[("pv", 1)] == "ready"
    [entry] = ontologies.saved[("pv", 1)].import_entries
    assert entry["resolution"] == "unresolved" and "triple limit" in entry["reason"]


def test_http_import_iris_are_fetched_over_https(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir, source=None)
    root = ROOT.replace(b"<https://w3id.org/base>", b"<http://w3id.org/base>")
    deps.ontology_fetch = web({"https://w3id.org/pv": root, "https://w3id.org/base": BASE})
    run_once(FakeQueue(jobs=[url_job()]), deps, "w1")
    entries = {e["iri"]: e for e in ontologies.saved[("pv", 1)].import_entries}
    assert entries["http://w3id.org/base"]["resolution"] == "fetched"
    # Found again later under the IRI it was imported by.
    assert ontologies.find_ready("http://w3id.org/base") is not None


def test_import_files_are_stored_before_the_version_is_committed(
    fixture_specs_dir: Path,
) -> None:
    deps, store, ontologies = make(fixture_specs_dir, source=None)
    deps.ontology_fetch = web({"https://w3id.org/pv": ROOT, "https://w3id.org/base": BASE})
    seen: list[bool] = []

    original = ontologies.create_imported

    def checking(**kwargs: Any) -> tuple[str, int]:
        def before_commit(oid: str, version: int) -> None:
            kwargs["before_commit"](oid, version)
            seen.append(("runs", ontology_normalized_key(oid, version)) in store.objects)

        return original(**{**kwargs, "before_commit": before_commit})

    ontologies.create_imported = checking  # type: ignore[method-assign]
    run_once(FakeQueue(jobs=[url_job()]), deps, "w1")
    assert seen == [True]
