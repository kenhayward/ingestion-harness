"""Ontology library (ADR 0011): parse an imported OWL/RDFS, SKOS or SHACL file, index its terms.

`parse_ontology` is pure: bytes in, terms out. The API creates the version row, the source
object and the `ontology` job; the job parses the file and writes what this module returns.
"""

from __future__ import annotations

import json
import re
from collections import deque
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rdflib import BNode, Graph, URIRef
from rdflib import Literal as RdfLiteral
from rdflib.collection import Collection
from rdflib.namespace import DC, DCTERMS, OWL, RDF, RDFS, SH, SKOS, XSD

from .pipeline import DocumentError, JobCancelled, check_cancelled
from .storage import ontology_normalized_key

if TYPE_CHECKING:
    import psycopg

    from .pipeline import PipelineDeps
    from .queue import ClaimedJob, JobQueue

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
    #: "<ontologyId>@<version>" for a term indexed from an import; None for the own terms.
    defined_in: str | None = None


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
    #: The ontology's own name (rdfs:label, dcterms:title or dc:title of its header).
    title: str | None = None
    #: How each of `imports` was resolved (OntologyImport in packages/shared); set by the job.
    import_entries: list[dict[str, Any]] = field(default_factory=list)

    def stats(self) -> dict[str, int]:
        own = [t for t in self.terms if t.defined_in is None]

        def count(*kinds: str) -> int:
            return sum(1 for t in own if t.kind in kinds)

        return {
            "triples": self.triples,
            "classes": count("class"),
            "properties": count(*PROPERTY_KINDS),
            "concepts": count("concept"),
            "schemes": count("scheme"),
            "shapes": count("shape"),
            "imported": len(self.terms) - len(own),
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


def _iris(graph: Graph, values: Iterable[Any], *, unions: bool = False) -> list[str]:
    """IRIs among the values; blank nodes are dropped, except that `unions` expands an
    `owl:unionOf` list (right for a domain or range, wrong for a superclass)."""
    out: set[str] = set()
    for value in values:
        if isinstance(value, URIRef):
            out.add(str(value))
        elif unions and isinstance(value, BNode):
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
        domain = _iris(graph, graph.objects(iri, RDFS.domain), unions=True)
        range_ = _iris(graph, graph.objects(iri, RDFS.range), unions=True)
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


def read_graph(data: bytes, media_type: str, file_name: str, *, max_triples: int) -> Graph:
    """Parse one ontology file into a graph. Every refusal is a DocumentError."""
    fmt = rdf_format(media_type, file_name, data)
    _refuse_unsafe(fmt, data)
    graph = Graph()
    try:
        graph.parse(data=data, format=fmt)
    except Exception as exc:  # rdflib raises a different type per parser
        raise DocumentError(f"cannot read {file_name} as {FORMAT_NAMES[fmt]}: {exc}") from exc
    if len(graph) > max_triples:
        raise DocumentError(f"ontology too large ({len(graph)} triples, limit {max_triples})")
    return graph


def _title(graph: Graph, ontology: URIRef | None) -> str | None:
    if ontology is None:
        return None
    for predicate in (RDFS.label, DCTERMS.title, DC.title):
        found = _pick(_literals(graph, ontology, predicate))
        if found is not None:
            return str(found)
    return None


def index_graph(
    own: Graph,
    *,
    imports: Sequence[tuple[Graph, str]] = (),
    max_triples: int = DEFAULT_MAX_TRIPLES,
) -> ParsedOntology:
    """Index a version's terms together with its imports' (each graph with its
    "<ontologyId>@<version>"), so trees and search cross into imported ontologies. The header,
    imports list and normalized form are the version's own."""
    combined = Graph()
    for graph in (own, *(g for g, _ in imports)):
        for triple in graph:
            combined.add(triple)
    if len(combined) > max_triples:
        raise DocumentError(f"ontology too large ({len(combined)} triples, limit {max_triples})")

    headers, version_iri, license_ = _header(own)
    imported = sorted({str(o) for h in headers for o in own.objects(h, OWL.imports)})
    terms: list[Term] = []
    for iri, kind in _kinds_of(combined).items():
        t = _term(combined, iri, kind)
        if (iri, RDF.type, None) not in own:
            t.defined_in = next((label for g, label in imports if (iri, RDF.type, None) in g), None)
        terms.append(t)
    terms.sort(key=lambda t: (t.kind, t.iri))
    _mark_roots(terms)
    present = {t.kind for t in terms if t.defined_in is None}
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
    lines = sorted(line for line in own.serialize(format="nt").splitlines() if line.strip())
    return ParsedOntology(
        triples=len(own),
        ontology_iri=str(headers[0]) if headers else None,
        version_iri=version_iri,
        license=license_,
        kinds=kinds,
        imports=imported,
        terms=terms,
        normalized=("\n".join(lines) + "\n").encode("utf-8"),
        title=_title(own, headers[0] if headers else None),
    )


def parse_ontology(
    data: bytes,
    media_type: str,
    file_name: str,
    *,
    max_triples: int = DEFAULT_MAX_TRIPLES,
    imports: Sequence[tuple[Graph, str]] = (),
) -> ParsedOntology:
    """Parse one ontology file and index its terms (with its imports' graphs, if given)."""
    graph = read_graph(data, media_type, file_name, max_triples=max_triples)
    return index_graph(graph, imports=imports, max_triples=max_triples)


# --- The `ontology` job ----------------------------------------------------------------------

#: Job event when a version is indexed; mirrors ONTOLOGY_INDEXED_EVENT in packages/shared.
ONTOLOGY_INDEXED = "ontology indexed"


class OntologyStore(Protocol):
    """The ontology tables the job writes (the API reads them)."""

    def start(self, ontology_id: str, version: int) -> None: ...
    def save(self, ontology_id: str, version: int, parsed: ParsedOntology) -> None: ...
    def fail(self, ontology_id: str, version: int, error: str) -> None: ...


class OntologyJobParams(BaseModel):
    """What the API's OntologyRepo.createVersion puts in the job's params."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    ontology_id: str = Field(alias="ontologyId", min_length=2)
    version: int = Field(gt=0)
    source_key: str = Field(alias="sourceKey", min_length=1)
    file_name: str = Field(alias="fileName", min_length=1)
    media_type: str = Field(alias="mediaType", min_length=1)


_TERM_COLUMNS = (
    "ontology_id, version, iri, kind, label, alt_labels, definition, parents, domains, ranges,"
    " scheme, deprecated, root, child_count, defined_in"
)
_TERM_TYPES = [
    "text",
    "int4",
    "text",
    "text",
    "text",
    "text[]",
    "text",
    "text[]",
    "text[]",
    "text[]",
    "text",
    "bool",
    "bool",
    "int4",
    "text",
]


class PgOntologyStore:
    """OntologyStore on Postgres (migration 0032). A ready version is immutable (trigger)."""

    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self._conn = conn

    def start(self, ontology_id: str, version: int) -> None:
        self._conn.execute(
            """UPDATE ontology_versions SET status = 'parsing', error = NULL
                WHERE ontology_id = %s AND version = %s AND status IN ('queued', 'parsing')""",
            (ontology_id, version),
        )

    def save(self, ontology_id: str, version: int, parsed: ParsedOntology) -> None:
        from psycopg.types.json import Jsonb

        with self._conn.transaction():
            self._conn.execute(
                "DELETE FROM ontology_terms WHERE ontology_id = %s AND version = %s",
                (ontology_id, version),
            )
            with (
                self._conn.cursor() as cur,
                cur.copy(f"COPY ontology_terms ({_TERM_COLUMNS}) FROM STDIN") as copy,
            ):
                copy.set_types(_TERM_TYPES)
                for t in parsed.terms:
                    copy.write_row(
                        (
                            ontology_id,
                            version,
                            t.iri,
                            t.kind,
                            t.label,
                            t.alt_labels,
                            t.definition,
                            t.parents,
                            t.domain,
                            t.range,
                            t.scheme,
                            t.deprecated,
                            t.root,
                            t.child_count,
                            t.defined_in,
                        )
                    )
            self._conn.execute(
                """UPDATE ontology_versions
                      SET status = 'ready', error = NULL, ontology_iri = %s, version_iri = %s,
                          license = %s, kinds = %s, stats = %s, imports = %s
                    WHERE ontology_id = %s AND version = %s AND status <> 'ready'""",
                (
                    parsed.ontology_iri,
                    parsed.version_iri,
                    parsed.license,
                    parsed.kinds,
                    Jsonb(parsed.stats()),
                    Jsonb([{"iri": i, "resolution": "unresolved"} for i in parsed.imports]),
                    ontology_id,
                    version,
                ),
            )

    def fail(self, ontology_id: str, version: int, error: str) -> None:
        self._conn.execute(
            """UPDATE ontology_versions SET status = 'failed', error = %s
                WHERE ontology_id = %s AND version = %s AND status <> 'ready'""",
            (error, ontology_id, version),
        )


def run_ontology_import(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> ParsedOntology:
    """Parse the uploaded file, keep its canonical N-Triples, index its terms. A file that
    cannot be read fails the version (and the job goes to review); other errors retry, failing
    the version on the last attempt so it never stays 'parsing'."""
    try:
        params = OntologyJobParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid ontology import parameters: {exc}") from exc
    store = deps.ontologies
    if store is None:
        raise DocumentError("this worker has no ontology store")
    oid, version = params.ontology_id, params.version
    store.start(oid, version)
    try:
        data = deps.store.get_optional(deps.buckets.runs, params.source_key)
        if data is None:
            raise DocumentError(f"the uploaded file is missing ({params.source_key})")
        parsed = parse_ontology(
            data, params.media_type, params.file_name, max_triples=deps.ontology_max_triples
        )
        check_cancelled(job, queue)
        deps.store.put(
            deps.buckets.runs,
            ontology_normalized_key(oid, version),
            parsed.normalized,
            "application/n-triples",
        )
        store.save(oid, version, parsed)
    except DocumentError as exc:
        store.fail(oid, version, str(exc))
        raise
    except JobCancelled:
        store.fail(oid, version, "the import was cancelled")
        raise
    except Exception as exc:
        if job.attempts >= job.max_attempts:
            store.fail(oid, version, f"{type(exc).__name__}: {exc}")
        raise
    queue.event(
        job.id, "info", ONTOLOGY_INDEXED, {"terms": len(parsed.terms), "triples": parsed.triples}
    )
    return parsed
