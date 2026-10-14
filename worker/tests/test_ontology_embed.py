"""Term embeddings (ADR 0011): written at import and by `embed` jobs, never failing an import."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.embeddings import EMBED_BATCH, embed_version, run_embed, term_text
from ingest_worker.llm.base import LLMError
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.ontology import parse_ontology
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeProvider, FakeQueue, MemoryOntologyStore
from .test_ontology_job import SOURCE, ontology_job

TTL = b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
<https://ex.org/Thing> a owl:Class ; rdfs:label "Thing" .
<https://ex.org/Batch> a owl:Class ; rdfs:label "Batch" ; skos:altLabel "Lot" ;
    skos:definition "A quantity produced in one run." ; rdfs:subClassOf <https://ex.org/Thing> .
"""


def make(
    fixture_specs_dir: Path,
    *,
    location: str = "local",
    kind: str = "openai-chat",
    model: str | None = "emb/nomic",
) -> tuple[PipelineDeps, FakeProvider, MemoryOntologyStore]:
    provider = FakeProvider("emb", kind=kind)  # type: ignore[arg-type]
    store = MemoryObjectStore()
    store.put("runs", SOURCE, TTL, "text/turtle")
    ontologies = MemoryOntologyStore()
    deps = PipelineDeps(
        store=store,
        specs=load_specs(fixture_specs_dir),
        models=ModelRegistry(
            {"emb": provider},
            {"emb": ProviderConfig(name="emb", kind=kind, location=location)},  # type: ignore[arg-type]
            {},
        ),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        ontologies=ontologies,
        embedding_model=model,
    )
    return deps, provider, ontologies


def saved(ontologies: MemoryOntologyStore, ttl: bytes = TTL) -> None:
    ontologies.saved[("pv", 1)] = parse_ontology(ttl, "text/turtle", "pv.ttl")


def test_term_text_reads_label_synonyms_definition_and_parents() -> None:
    assert term_text("Batch", ["Lot"], "A quantity.", ["Thing"]) == (
        "Batch\nAlso: Lot\nA quantity.\nParents: Thing"
    )
    assert term_text("Batch", [], "", []) == "Batch"


def test_embeds_each_term_once_and_again_only_when_its_text_changes(
    fixture_specs_dir: Path,
) -> None:
    deps, provider, ontologies = make(fixture_specs_dir)
    saved(ontologies)
    queue = FakeQueue()
    assert embed_version(deps, queue, "j", "pv", 1) == 2
    rows = ontologies.embeddings[("pv", 1, "emb/nomic")]
    batch = rows[("class", "https://ex.org/Batch")]
    assert len(batch[1]) == 16
    [(_, texts)] = provider.embed_calls
    assert "Batch\nAlso: Lot\nA quantity produced in one run.\nParents: Thing" in texts
    assert embed_version(deps, queue, "j", "pv", 1) == 0  # nothing changed
    saved(ontologies, TTL.replace(b"one run", b"one go"))
    assert embed_version(deps, queue, "j", "pv", 1) == 1
    assert provider.embed_calls[-1][1] == [
        "Batch\nAlso: Lot\nA quantity produced in one go.\nParents: Thing"
    ]


def test_embeds_in_batches(fixture_specs_dir: Path) -> None:
    deps, provider, ontologies = make(fixture_specs_dir)
    classes = "".join(
        f"<https://ex.org/C{i}> a owl:Class .\n" for i in range(EMBED_BATCH + 5)
    ).encode()
    saved(ontologies, b"@prefix owl: <http://www.w3.org/2002/07/owl#> .\n" + classes)
    assert embed_version(deps, FakeQueue(), "j", "pv", 1) == EMBED_BATCH + 5
    assert [len(t) for _, t in provider.embed_calls] == [EMBED_BATCH, 5]


@pytest.mark.parametrize(
    ("setup", "reason"),
    [
        ({"model": None}, None),
        ({"kind": "anthropic"}, "cannot embed"),
        ({"location": "external", "local_only": True}, "local only"),
    ],
)
def test_embedding_is_skipped_with_a_reason(
    fixture_specs_dir: Path, setup: dict[str, Any], reason: str | None
) -> None:
    local_only = setup.pop("local_only", False)
    deps, provider, ontologies = make(fixture_specs_dir, **setup)
    saved(ontologies)
    if local_only:
        ontologies.local_only_ids.add("pv")
    queue = FakeQueue()
    assert embed_version(deps, queue, "j", "pv", 1) == 0
    assert not provider.embed_calls
    skipped = [e for e in queue.event_details if e[2] == "embedding skipped"]
    if reason is None:
        assert skipped == []
    else:
        assert reason in str(skipped[0][3])


def test_an_import_whose_embedding_fails_is_still_ready(fixture_specs_dir: Path) -> None:
    deps, provider, ontologies = make(fixture_specs_dir)
    provider.embed = lambda model, texts: (_ for _ in ()).throw(LLMError("down"))  # type: ignore[method-assign]
    queue = FakeQueue(jobs=[ontology_job()])
    run_once(queue, deps, "w1")
    assert ontologies.status[("pv", 1)] == "ready"
    assert any(e[2] == "embedding skipped" for e in queue.event_details)


def test_an_import_embeds_its_terms(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[ontology_job()])
    run_once(queue, deps, "w1")
    assert ("pv", 1, "emb/nomic") in ontologies.embeddings


def embed_job(**params: Any) -> ClaimedJob:
    return ClaimedJob(
        "job-e", "", "", 0, "", "", None, 1, 3, task="embed",
        params={"ontologyId": "pv", "version": 1, **params},
    )  # fmt: skip


def test_the_embed_task_embeds_a_ready_version(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir)
    saved(ontologies)
    queue = FakeQueue(jobs=[embed_job()])
    run_once(queue, deps, "w1")
    assert queue.completed
    assert ("pv", 1, "emb/nomic") in ontologies.embeddings


def test_the_embed_task_refuses_bad_params(fixture_specs_dir: Path) -> None:
    deps, _, _ = make(fixture_specs_dir)
    with pytest.raises(Exception, match="invalid embed parameters"):
        run_embed(embed_job(extra=1), deps, FakeQueue())


@pytest.mark.integration
def test_pg_store_embeddings_round_trip() -> None:
    """Needs IH_TEST_DATABASE_URL on a throwaway pgvector database with db/migrations applied."""
    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set")
    import psycopg

    from ingest_worker.ontology import PgOntologyStore

    conn = psycopg.connect(url, autocommit=True)
    conn.execute("DELETE FROM ontologies WHERE id = 'emb-worker-test'")
    conn.execute(
        "INSERT INTO ontologies (id, label, local_only) VALUES ('emb-worker-test', 'E', true)"
    )
    conn.execute(
        """INSERT INTO ontology_versions (ontology_id, version, file_name, media_type, sha256, bytes)
           VALUES ('emb-worker-test', 1, 'e.ttl', 'text/turtle', 'abc', 10)"""
    )
    store = PgOntologyStore(conn)
    store.save("emb-worker-test", 1, parse_ontology(TTL, "text/turtle", "e.ttl"))
    assert store.local_only("emb-worker-test") is True
    terms = {t.iri: t for t in store.embedding_terms("emb-worker-test", 1)}
    assert terms["https://ex.org/Batch"].parents == ["Thing"]
    store.store_embeddings(
        "emb-worker-test", 1, "emb/nomic", [("class", "https://ex.org/Batch", "sha", [1.0, 0.0])]
    )
    assert store.existing_embeddings("emb-worker-test", 1, "emb/nomic") == {
        ("class", "https://ex.org/Batch"): "sha"
    }
    # A second store of the same model reuses its index; another dimension gets its own.
    store.store_embeddings(
        "emb-worker-test",
        1,
        "emb/other",
        [("class", "https://ex.org/Batch", "s2", [1.0, 0.0, 0.0])],
    )
    conn.execute("DELETE FROM ontologies WHERE id = 'emb-worker-test'")
    conn.close()
