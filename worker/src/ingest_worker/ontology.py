"""Ontology library (ADR 0011): parse an imported OWL/RDFS, SKOS or SHACL file, index its terms.

`parse_ontology` is pure: bytes in, terms out. The API creates the version row, the source
object and the `ontology` job; the job parses the file and writes what this module returns.
"""

from __future__ import annotations

import json
import re
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal

from rdflib import BNode, Graph, URIRef
from rdflib import Literal as RdfLiteral
from rdflib.collection import Collection
from rdflib.namespace import DC, DCTERMS, OWL, RDF, RDFS, SH, SKOS, XSD

from .pipeline import DocumentError

TermKind = Literal[
    "class",
    "object_property",
    "datatype_property",
    "annotation_property",
    "concept",
    "scheme",
    "shape",
]

DEFAULT_MAX_TRIPLES = 2_000_000
MAX_ALT_LABELS = 20

#: rdflib format names by the content type the API recorded (from the file's extension).
FORMATS = {
    "text/turtle": "turtle",
    "application/rdf+xml": "xml",
    "application/ld+json": "json-ld",
    "application/n-triples": "nt",
    "text/n3": "n3",
}
EXTENSIONS = {
    "ttl": "turtle",
    "owl": "xml",
    "rdf": "xml",
    "jsonld": "json-ld",
    "nt": "nt",
    "n3": "n3",
}
FORMAT_NAMES = {
    "turtle": "Turtle",
    "xml": "RDF/XML",
    "json-ld": "JSON-LD",
    "nt": "N-Triples",
    "n3": "N3",
}

IAO_DEFINITION = URIRef("http://purl.obolibrary.org/obo/IAO_0000115")
CC_LICENSE = URIRef("http://creativecommons.org/ns#license")

#: Each kind's group (one browser tab): roots and child counts are computed within a group.
GROUP: dict[str, str] = {
    "class": "classes",
    "object_property": "properties",
    "datatype_property": "properties",
    "annotation_property": "properties",
    "scheme": "concepts",
    "concept": "concepts",
    "shape": "shapes",
}
PROPERTY_KINDS = ("object_property", "datatype_property", "annotation_property")

_TYPED: list[tuple[URIRef, TermKind]] = [
    (OWL.Class, "class"),
    (RDFS.Class, "class"),
    (OWL.ObjectProperty, "object_property"),
    (OWL.DatatypeProperty, "datatype_property"),
    (OWL.AnnotationProperty, "annotation_property"),
    (SKOS.ConceptScheme, "scheme"),
    (SKOS.Concept, "concept"),
    (SH.NodeShape, "shape"),
    (SH.PropertyShape, "shape"),
]

#: RDF/XML declaring an external entity is refused before parsing; internal entities (the
#: namespace abbreviations Protégé writes) are fine.
_EXTERNAL_ENTITY = re.compile(rb"<!ENTITY\s+(?:%\s*)?[^\s>]+\s+(?:SYSTEM|PUBLIC)\b", re.IGNORECASE)


@dataclass
class Term:
    iri: str
    kind: TermKind
    label: str
    alt_labels: list[str]
    definition: str
    parents: list[str]
    domain: list[str]
    range: list[str]
    scheme: str | None
    deprecated: bool
    root: bool = False
    child_count: int = 0


@dataclass
class ParsedOntology:
    triples: int
    ontology_iri: str | None
    version_iri: str | None
    license: str | None
    kinds: list[str]
    imports: list[str]
    terms: list[Term] = field(default_factory=list)
    normalized: bytes = b""

    def stats(self) -> dict[str, int]:
        def count(*kinds: str) -> int:
            return sum(1 for t in self.terms if t.kind in kinds)

        return {
            "triples": self.triples,
            "classes": count("class"),
            "properties": count(*PROPERTY_KINDS),
            "concepts": count("concept"),
            "schemes": count("scheme"),
            "shapes": count("shape"),
        }


def rdf_format(media_type: str, file_name: str, data: bytes) -> str:
    """rdflib's format name: the content type the API recorded, the extension, then a sniff."""
    if media_type in FORMATS:
        return FORMATS[media_type]
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    if ext in EXTENSIONS:
        return EXTENSIONS[ext]
    head = data[:512].lstrip()
    if head.startswith(b"<"):
        return "xml"
    if head[:1] in (b"{", b"["):
        return "json-ld"
    return "turtle"


def local_name(iri: str) -> str:
    """The last segment of an IRI: the label of a term that has none."""
    tail = re.split(r"[#/:]", iri.rstrip("/#"))[-1]
    return tail or iri


def _remote_contexts(node: Any) -> list[str]:
    """Every `@context`/`@import` given as a string (a URL rdflib would fetch)."""
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("@context", "@import"):
                for item in value if isinstance(value, list) else [value]:
                    found += [item] if isinstance(item, str) else _remote_contexts(item)
            else:
                found += _remote_contexts(value)
    elif isinstance(node, list):
        for item in node:
            found += _remote_contexts(item)
    return found


def _refuse_unsafe(fmt: str, data: bytes) -> None:
    if fmt == "xml" and _EXTERNAL_ENTITY.search(data):
        raise DocumentError(
            "RDF/XML declaring external entities (<!ENTITY … SYSTEM>) is not accepted"
        )
    if fmt == "json-ld":
        try:
            doc = json.loads(data)
        except ValueError as exc:
            raise DocumentError(f"cannot read the file as JSON-LD: {exc}") from exc
        remote = _remote_contexts(doc)
        if remote:
            raise DocumentError(
                f"remote JSON-LD contexts are not fetched ({remote[0]}): inline the context"
            )


def _literals(graph: Graph, subject: URIRef, predicate: URIRef) -> list[RdfLiteral]:
    return [o for o in graph.objects(subject, predicate) if isinstance(o, RdfLiteral)]


def _pick(values: list[RdfLiteral]) -> RdfLiteral | None:
    """English first, then untagged, then any (sorted, so the choice is stable)."""
    keeps: list[Callable[[RdfLiteral], bool]] = [
        lambda v: (v.language or "").lower().startswith("en"),
        lambda v: v.language is None,
        lambda v: True,
    ]
    for keep in keeps:
        chosen = sorted((v for v in values if keep(v)), key=str)
        if chosen:
            return chosen[0]
    return None


def _iris(graph: Graph, values: Iterable[Any]) -> list[str]:
    """IRIs among the values, expanding `owl:unionOf` lists; other blank nodes are dropped."""
    out: set[str] = set()
    for value in values:
        if isinstance(value, URIRef):
            out.add(str(value))
        elif isinstance(value, BNode):
            for members in graph.objects(value, OWL.unionOf):
                out.update(str(m) for m in Collection(graph, members) if isinstance(m, URIRef))
    return sorted(out)


def _kinds_of(graph: Graph) -> dict[URIRef, TermKind]:
    kinds: dict[URIRef, TermKind] = {}
    for rdf_type, kind in _TYPED:
        for subject in graph.subjects(RDF.type, rdf_type):
            if isinstance(subject, URIRef):
                kinds.setdefault(subject, kind)
    for subject in graph.subjects(RDF.type, RDF.Property):
        if isinstance(subject, URIRef) and subject not in kinds:
            ranges = list(graph.objects(subject, RDFS.range))
            literal = any(r == RDFS.Literal or str(r).startswith(str(XSD)) for r in ranges)
            kinds[subject] = "datatype_property" if literal else "object_property"
    return kinds


def _term(graph: Graph, iri: URIRef, kind: TermKind) -> Term:
    chosen = _pick(_literals(graph, iri, SKOS.prefLabel) or _literals(graph, iri, RDFS.label))
    label = str(chosen) if chosen is not None else local_name(str(iri))
    names = {
        str(v)
        for p in (SKOS.prefLabel, RDFS.label, SKOS.altLabel)
        for v in _literals(graph, iri, p)
    }
    alt = sorted(names - {label})[:MAX_ALT_LABELS]
    definition = ""
    for predicate in (SKOS.definition, IAO_DEFINITION, RDFS.comment):
        found = _pick(_literals(graph, iri, predicate))
        if found is not None:
            definition = str(found)
            break
    parents: list[str] = []
    domain: list[str] = []
    range_: list[str] = []
    scheme: str | None = None
    if kind == "class":
        parents = _iris(graph, graph.objects(iri, RDFS.subClassOf))
    elif kind in PROPERTY_KINDS:
        parents = _iris(graph, graph.objects(iri, RDFS.subPropertyOf))
        domain = _iris(graph, graph.objects(iri, RDFS.domain))
        range_ = _iris(graph, graph.objects(iri, RDFS.range))
    elif kind == "concept":
        schemes = _iris(graph, graph.objects(iri, SKOS.inScheme)) or _iris(
            graph, graph.objects(iri, SKOS.topConceptOf)
        )
        scheme = schemes[0] if schemes else None
        broader = set(_iris(graph, graph.objects(iri, SKOS.broader)))
        broader.update(_iris(graph, graph.subjects(SKOS.narrower, iri)))
        # A top concept hangs under its scheme, so concepts share the scheme's tree.
        parents = sorted(broader) or ([scheme] if scheme else [])
    elif kind == "shape":
        domain = _iris(graph, graph.objects(iri, SH.targetClass))
    deprecated = any(
        isinstance(o, RdfLiteral) and o.toPython() is True
        for o in graph.objects(iri, OWL.deprecated)
    )
    return Term(str(iri), kind, label, alt, definition, parents, domain, range_, scheme, deprecated)


def _mark_roots(terms: list[Term]) -> None:
    """Roots have no parent in their group; anything unreachable from a root (a cycle) is a
    root too, so every term can be found in the tree. Child counts are per group."""
    by_group: dict[str, list[Term]] = {}
    for t in terms:
        by_group.setdefault(GROUP[t.kind], []).append(t)
    for group in by_group.values():
        iris = {t.iri for t in group}
        children: dict[str, set[str]] = {}
        for t in group:
            for p in t.parents:
                if p in iris and p != t.iri:
                    children.setdefault(p, set()).add(t.iri)
        for t in group:
            t.child_count = len(children.get(t.iri, set()))
            t.root = not any(p in iris and p != t.iri for p in t.parents)
        reached: set[str] = set()
        queue = deque(t.iri for t in group if t.root)
        while queue:
            iri = queue.popleft()
            if iri not in reached:
                reached.add(iri)
                queue.extend(children.get(iri, set()))
        for t in group:
            if t.iri not in reached:
                t.root = True


def _header(graph: Graph) -> tuple[list[URIRef], str | None, str | None]:
    """The owl:Ontology subjects, the first one's version IRI and licence."""
    headers = sorted(s for s in graph.subjects(RDF.type, OWL.Ontology) if isinstance(s, URIRef))
    if not headers:
        return headers, None, None
    ontology = headers[0]
    versions = _iris(graph, graph.objects(ontology, OWL.versionIRI))
    license_ = None
    for predicate in (DCTERMS.license, CC_LICENSE, DC.rights):
        values = sorted(graph.objects(ontology, predicate), key=str)
        if values:
            license_ = str(values[0])
            break
    return headers, versions[0] if versions else None, license_


def parse_ontology(
    data: bytes, media_type: str, file_name: str, *, max_triples: int = DEFAULT_MAX_TRIPLES
) -> ParsedOntology:
    """Parse one ontology file and index its terms. Every refusal is a DocumentError."""
    fmt = rdf_format(media_type, file_name, data)
    _refuse_unsafe(fmt, data)
    graph = Graph()
    try:
        graph.parse(data=data, format=fmt)
    except Exception as exc:  # rdflib raises a different type per parser
        raise DocumentError(f"cannot read {file_name} as {FORMAT_NAMES[fmt]}: {exc}") from exc
    triples = len(graph)
    if triples > max_triples:
        raise DocumentError(f"ontology too large ({triples} triples, limit {max_triples})")

    headers, version_iri, license_ = _header(graph)
    imports = sorted({str(o) for h in headers for o in graph.objects(h, OWL.imports)})
    terms = [_term(graph, iri, kind) for iri, kind in _kinds_of(graph).items()]
    terms.sort(key=lambda t: (t.kind, t.iri))
    _mark_roots(terms)
    present = {t.kind for t in terms}
    owl = bool(headers) or bool(present & {"class", *PROPERTY_KINDS})
    kinds = [
        name
        for name, has in (
            ("owl", owl),
            ("skos", bool(present & {"concept", "scheme"})),
            ("shacl", "shape" in present),
        )
        if has
    ]
    lines = sorted(line for line in graph.serialize(format="nt").splitlines() if line.strip())
    return ParsedOntology(
        triples=triples,
        ontology_iri=str(headers[0]) if headers else None,
        version_iri=version_iri,
        license=license_,
        kinds=kinds,
        imports=imports,
        terms=terms,
        normalized=("\n".join(lines) + "\n").encode("utf-8"),
    )
