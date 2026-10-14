from __future__ import annotations

import json

import pytest

from ingest_worker.ontology import (
    ParsedOntology,
    Term,
    local_name,
    parse_ontology,
    rdf_format,
)
from ingest_worker.pipeline import DocumentError
from ingest_worker.storage import ontology_normalized_key

PREFIXES = """
@prefix ex: <https://example.org/pv#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
"""

OWL_TTL = (
    PREFIXES
    + """
<https://example.org/pv> a owl:Ontology ;
    owl:versionIRI <https://example.org/pv/2.0> ;
    dcterms:license <https://creativecommons.org/licenses/by/4.0/> ;
    owl:imports <https://example.org/base> .
ex:Document a owl:Class ; rdfs:label "Document"@en , "Dokument"@de ;
    skos:definition "Anything written down."@en .
ex:Protocol a owl:Class ; rdfs:subClassOf ex:Document ;
    rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:hasBatch ; owl:minCardinality 1 ] ;
    rdfs:label "Protocol"@en ; skos:altLabel "Validation protocol"@en .
ex:Batch a owl:Class ; rdfs:subClassOf <https://example.org/base#Thing> .
ex:Legacy a owl:Class ; owl:deprecated true .
ex:hasBatch a owl:ObjectProperty ; rdfs:domain ex:Protocol ;
    rdfs:range [ owl:unionOf ( ex:Batch ex:Document ) ] .
ex:batchNumber a owl:DatatypeProperty ; rdfs:domain ex:Batch ; rdfs:range xsd:string ;
    rdfs:subPropertyOf ex:identifier .
ex:identifier a rdf:Property ; rdfs:range rdfs:Literal .
ex:related a rdf:Property ; rdfs:range ex:Document .
"""
)


def term(parsed: ParsedOntology, iri: str) -> Term:
    [found] = [t for t in parsed.terms if t.iri == iri]
    return found


def owl() -> ParsedOntology:
    return parse_ontology(OWL_TTL.encode(), "text/turtle", "pv.ttl")


def test_reads_the_ontology_header() -> None:
    parsed = owl()
    assert parsed.ontology_iri == "https://example.org/pv"
    assert parsed.version_iri == "https://example.org/pv/2.0"
    assert parsed.license == "https://creativecommons.org/licenses/by/4.0/"
    assert parsed.imports == ["https://example.org/base"]
    assert parsed.kinds == ["owl"]


def test_indexes_classes_with_english_labels_definitions_and_parents() -> None:
    parsed = owl()
    doc = term(parsed, "https://example.org/pv#Document")
    assert (doc.kind, doc.label, doc.alt_labels) == ("class", "Document", ["Dokument"])
    assert doc.definition == "Anything written down."
    protocol = term(parsed, "https://example.org/pv#Protocol")
    # The restriction is a blank node: neither a term nor a parent.
    assert protocol.parents == ["https://example.org/pv#Document"]
    assert protocol.alt_labels == ["Validation protocol"]
    assert all("://" in t.iri for t in parsed.terms)


def test_roots_and_child_counts() -> None:
    parsed = owl()
    assert term(parsed, "https://example.org/pv#Document").root
    assert term(parsed, "https://example.org/pv#Document").child_count == 1
    # Its parent is outside the file, so it is a root rather than hidden.
    assert term(parsed, "https://example.org/pv#Batch").root
    assert not term(parsed, "https://example.org/pv#Protocol").root


def test_properties_domains_ranges_and_rdf_property_kinds() -> None:
    parsed = owl()
    has_batch = term(parsed, "https://example.org/pv#hasBatch")
    assert has_batch.kind == "object_property"
    assert has_batch.domain == ["https://example.org/pv#Protocol"]
    assert has_batch.range == ["https://example.org/pv#Batch", "https://example.org/pv#Document"]
    number = term(parsed, "https://example.org/pv#batchNumber")
    assert (number.kind, number.parents) == (
        "datatype_property",
        ["https://example.org/pv#identifier"],
    )
    assert term(parsed, "https://example.org/pv#identifier").kind == "datatype_property"
    assert term(parsed, "https://example.org/pv#related").kind == "object_property"


def test_deprecated_and_local_name_labels() -> None:
    legacy = term(owl(), "https://example.org/pv#Legacy")
    assert legacy.deprecated
    assert legacy.label == "Legacy"


def test_subclass_cycles_stay_reachable() -> None:
    ttl = (
        PREFIXES
        + """
    ex:A a owl:Class ; rdfs:subClassOf ex:B .
    ex:B a owl:Class ; rdfs:subClassOf ex:A .
    """
    )
    parsed = parse_ontology(ttl.encode(), "text/turtle", "cycle.ttl")
    assert {t.iri: t.root for t in parsed.terms} == {
        "https://example.org/pv#A": True,
        "https://example.org/pv#B": True,
    }


SKOS_TTL = (
    PREFIXES
    + """
ex:Stages a skos:ConceptScheme ; skos:prefLabel "Process stages"@en .
ex:Granulation a skos:Concept ; skos:inScheme ex:Stages ; skos:prefLabel "Granulation"@en ;
    skos:altLabel "Wet granulation"@en ; skos:narrower ex:Drying .
ex:Drying a skos:Concept ; skos:inScheme ex:Stages ; skos:prefLabel "Séchage"@fr .
ex:Blending a skos:Concept ; skos:inScheme ex:Stages ; skos:broader ex:Granulation .
"""
)


def test_skos_top_concepts_hang_under_their_scheme() -> None:
    parsed = parse_ontology(SKOS_TTL.encode(), "text/turtle", "stages.ttl")
    assert parsed.kinds == ["skos"]
    scheme = term(parsed, "https://example.org/pv#Stages")
    assert (scheme.kind, scheme.root, scheme.child_count) == ("scheme", True, 1)
    granulation = term(parsed, "https://example.org/pv#Granulation")
    assert granulation.parents == ["https://example.org/pv#Stages"]
    assert granulation.scheme == "https://example.org/pv#Stages"
    assert granulation.child_count == 2
    # narrower on the parent counts like broader on the child.
    assert term(parsed, "https://example.org/pv#Drying").parents == [
        "https://example.org/pv#Granulation"
    ]
    # Only a French label: it is used rather than the local name.
    assert term(parsed, "https://example.org/pv#Drying").label == "Séchage"


def test_shacl_shapes_record_their_target_classes() -> None:
    ttl = (
        PREFIXES
        + """
    ex:Batch a owl:Class .
    ex:BatchShape a sh:NodeShape ; sh:targetClass ex:Batch ; rdfs:label "Batch shape" .
    """
    )
    parsed = parse_ontology(ttl.encode(), "text/turtle", "shapes.ttl")
    assert parsed.kinds == ["owl", "shacl"]
    shape = term(parsed, "https://example.org/pv#BatchShape")
    assert (shape.kind, shape.domain) == ("shape", ["https://example.org/pv#Batch"])
    assert parsed.stats() == {
        "triples": 4,
        "classes": 1,
        "properties": 0,
        "concepts": 0,
        "schemes": 0,
        "shapes": 1,
    }


RDF_XML_INTERNAL = b"""<?xml version="1.0"?>
<!DOCTYPE rdf:RDF [ <!ENTITY ex "https://example.org/pv#"> ]>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
         xmlns:owl="http://www.w3.org/2002/07/owl#">
  <owl:Class rdf:about="&ex;Batch"><rdfs:label>Batch</rdfs:label></owl:Class>
</rdf:RDF>"""

RDF_XML_EXTERNAL = b"""<?xml version="1.0"?>
<!DOCTYPE rdf:RDF [ <!ENTITY secret SYSTEM "file:///etc/passwd"> ]>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
  <rdf:Description rdf:about="https://example.org/x"><rdfs:label>&secret;</rdfs:label></rdf:Description>
</rdf:RDF>"""


def test_rdf_xml_with_internal_entities_parses() -> None:
    parsed = parse_ontology(RDF_XML_INTERNAL, "application/rdf+xml", "pv.owl")
    assert [t.label for t in parsed.terms] == ["Batch"]


def test_rdf_xml_with_external_entities_is_refused() -> None:
    with pytest.raises(DocumentError, match="external entities"):
        parse_ontology(RDF_XML_EXTERNAL, "application/rdf+xml", "evil.owl")


def test_json_ld_with_an_inline_context_parses() -> None:
    doc = {
        "@context": {
            "owl": "http://www.w3.org/2002/07/owl#",
            "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
        },
        "@id": "https://example.org/pv#Batch",
        "@type": "owl:Class",
        "rdfs:label": "Batch",
    }
    parsed = parse_ontology(json.dumps(doc).encode(), "application/ld+json", "pv.jsonld")
    assert [t.iri for t in parsed.terms] == ["https://example.org/pv#Batch"]


@pytest.mark.parametrize(
    "context",
    ["https://schema.org/", ["https://example.org/ctx.jsonld"], {"@import": "https://x.org/c"}],
)
def test_json_ld_remote_contexts_are_refused(context: object) -> None:
    doc = {"@context": context, "@id": "https://example.org/x"}
    with pytest.raises(DocumentError, match="remote JSON-LD contexts"):
        parse_ontology(json.dumps(doc).encode(), "application/ld+json", "x.jsonld")


def test_unreadable_files_name_the_file_and_format() -> None:
    with pytest.raises(DocumentError, match=r"cannot read broken\.ttl as Turtle"):
        parse_ontology(b"this is { not turtle", "text/turtle", "broken.ttl")


def test_too_many_triples_is_refused() -> None:
    with pytest.raises(DocumentError, match=r"too large \(\d+ triples, limit 5\)"):
        parse_ontology(SKOS_TTL.encode(), "text/turtle", "stages.ttl", max_triples=5)


def test_n_triples_and_a_canonical_normalized_form() -> None:
    nt = (
        b'<https://example.org/b> <http://www.w3.org/2000/01/rdf-schema#label> "B" .\n'
        b"<https://example.org/b> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> "
        b"<http://www.w3.org/2002/07/owl#Class> .\n"
    )
    parsed = parse_ontology(nt, "application/n-triples", "b.nt")
    lines = parsed.normalized.decode().splitlines()
    assert lines == sorted(lines) and len(lines) == 2
    assert parse_ontology(nt, "application/n-triples", "b.nt").normalized == parsed.normalized


@pytest.mark.parametrize(
    ("media_type", "name", "head", "expected"),
    [
        ("text/turtle", "x.bin", b"", "turtle"),
        ("application/octet-stream", "x.owl", b"", "xml"),
        ("application/octet-stream", "x", b"  <?xml", "xml"),
        ("application/octet-stream", "x", b'{"@id": 1}', "json-ld"),
        ("application/octet-stream", "x", b"@prefix", "turtle"),
    ],
)
def test_rdf_format(media_type: str, name: str, head: bytes, expected: str) -> None:
    assert rdf_format(media_type, name, head) == expected


@pytest.mark.parametrize(
    ("iri", "name"),
    [
        ("https://example.org/pv#Batch", "Batch"),
        ("https://example.org/pv/Batch", "Batch"),
        ("https://example.org/pv/Batch/", "Batch"),
        ("urn:isbn:123", "123"),
    ],
)
def test_local_name(iri: str, name: str) -> None:
    assert local_name(iri) == name


def test_normalized_key() -> None:
    assert ontology_normalized_key("idmp-o", 3) == "ontologies/idmp-o/v3/normalized.nt"
