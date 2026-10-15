from __future__ import annotations

import os

import pytest

from ingest_worker.linked_data import PgLinkedDataSettings
from ingest_worker.ontology import PgOntologyStore, parse_ontology

from .fakes import MemoryOntologyStore

SKOS_TTL = b"""@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
<https://ex.example/stages> a skos:ConceptScheme .
<https://ex.example/stages/granulation> a skos:Concept ;
    skos:inScheme <https://ex.example/stages> ;
    skos:prefLabel "Granulation"@en ; skos:altLabel "Wet granulation"@en .
"""
SCHEME = "https://ex.example/stages"
GRANULATION = "https://ex.example/stages/granulation"


@pytest.mark.parametrize(
    ("label", "found"),
    [
        ("Granulation", GRANULATION),
        ("  granulation ", GRANULATION),
        ("WET GRANULATION", GRANULATION),
        ("Drying", None),
    ],
)
def test_memory_concepts_by_label(label: str, found: str | None) -> None:
    store = MemoryOntologyStore()
    store.saved[("stages", 1)] = parse_ontology(SKOS_TTL, "text/turtle", "stages.ttl")
    assert store.concept_by_label([("stages", 1)], SCHEME, label) == found
    assert store.concept_by_label([("stages", 2)], SCHEME, label) is None
    assert store.concept_by_label([("stages", 1)], "https://other.example/", label) is None


def database() -> str:
    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set")
    return url


@pytest.mark.integration
def test_pg_linked_data_settings() -> None:
    """Needs IH_TEST_DATABASE_URL on a throwaway database with db/migrations applied."""
    import psycopg

    conn = psycopg.connect(database(), autocommit=True)
    conn.execute("DELETE FROM linked_data_settings")
    settings = PgLinkedDataSettings(conn)
    assert settings.effective_base() is None
    conn.execute(
        "INSERT INTO linked_data_settings (id, customer_name, customer_slug) "
        "VALUES (true, 'Acme', 'acme')"
    )
    assert settings.effective_base() == "https://id.stocks-hayward.com/acme/"
    conn.execute("UPDATE linked_data_settings SET base_iri = 'https://data.acme.example/'")
    assert settings.effective_base() == "https://data.acme.example/"
    conn.execute("DELETE FROM linked_data_settings")
    conn.close()


@pytest.mark.integration
def test_pg_concepts_by_label() -> None:
    import psycopg

    conn = psycopg.connect(database(), autocommit=True)
    conn.execute("DELETE FROM ontologies WHERE id = 'stages-worker-test'")
    conn.execute("INSERT INTO ontologies (id, label) VALUES ('stages-worker-test', 'Stages')")
    conn.execute(
        """INSERT INTO ontology_versions (ontology_id, version, file_name, media_type, sha256, bytes)
           VALUES ('stages-worker-test', 1, 's.ttl', 'text/turtle', 'abc', 10)"""
    )
    store = PgOntologyStore(conn)
    store.save("stages-worker-test", 1, parse_ontology(SKOS_TTL, "text/turtle", "s.ttl"))
    pins = [("stages-worker-test", 1)]
    assert store.concept_by_label(pins, SCHEME, " wet granulation") == GRANULATION
    assert store.concept_by_label(pins, SCHEME, "Drying") is None
    assert store.concept_by_label([("stages-worker-test", 2)], SCHEME, "Granulation") is None
    assert store.concept_by_label([], SCHEME, "Granulation") is None
    conn.execute("DELETE FROM ontologies WHERE id = 'stages-worker-test'")
    conn.close()
