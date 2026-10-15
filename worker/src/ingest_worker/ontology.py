"""Ontology library (ADR 0011): parse an imported OWL/RDFS, SKOS or SHACL file, index its terms.

`parse_ontology` is pure: bytes in, terms out. The API creates the version row, the source
object and the `ontology` job; the job parses the file and writes what this module returns.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import deque
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from rdflib import BNode, Graph, URIRef
from rdflib import Literal as RdfLiteral
from rdflib.collection import Collection
from rdflib.namespace import DC, DCTERMS, OWL, RDF, RDFS, SH, SKOS, XSD

from .embeddings import EmbeddingTerm, embed_after_import
from .ontology_fetch import OntologySourceUnavailable
from .pipeline import DocumentError, JobCancelled, check_cancelled
from .storage import ontology_normalized_key, ontology_source_key

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


@dataclass(frozen=True)
class TermHit:
    """A version's best term for a query, with an absolute similarity (0-1)."""

    ontology_id: str
    version: int
    term: Term
    similarity: float


def _trigrams(text: str) -> set[str]:
    out: set[str] = set()
    for word in re.findall(r"[a-z0-9]+", text.lower()):
        padded = f"  {word} "
        out.update(padded[i : i + 3] for i in range(len(padded) - 2))
    return out


def trigram_similarity(a: str, b: str) -> float:
    """pg_trgm's `similarity`: shared trigrams over all trigrams of the two strings' words
    (each word padded with two spaces before and one after)."""
    x, y = _trigrams(a), _trigrams(b)
    union = x | y
    return len(x & y) / len(union) if union else 0.0


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
    #: Every owl:Ontology IRI the version declares (a folder merged into one has several).
    ontology_iris: list[str] = field(default_factory=list)

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
        ontology_iris=[str(h) for h in headers],
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


#: owl:imports are followed this many levels down from the imported version.
MAX_IMPORT_DEPTH = 3

#: A stored file's extension from its content type, when its name has no known one.
MEDIA_EXTENSIONS = {
    "text/turtle": "ttl",
    "application/rdf+xml": "rdf",
    "application/ld+json": "jsonld",
    "application/n-triples": "nt",
    "text/n3": "n3",
}


class DuplicateSource(Exception):
    """Another version of the ontology already has these bytes."""

    def __init__(self, version: int) -> None:
        super().__init__(f"same bytes as version {version}")
        self.version = version


class OntologyStore(Protocol):
    """The ontology tables the job writes (the API reads them)."""

    def start(self, ontology_id: str, version: int) -> bool:
        """Mark it parsing; False when it is already ready or failed (a retry skips it)."""
        ...

    def ready(self, ontology_id: str, version: int) -> bool:
        """Whether its terms are saved: a retry then only finishes embedding them."""
        ...

    def save(self, ontology_id: str, version: int, parsed: ParsedOntology) -> None: ...
    def fail(self, ontology_id: str, version: int, error: str) -> None: ...

    def set_source(
        self,
        ontology_id: str,
        version: int,
        *,
        file_name: str,
        media_type: str,
        sha256: str,
        size: int,
    ) -> None:
        """Record a fetched file's name, type and bytes; DuplicateSource if another version of
        the ontology has the same bytes."""
        ...

    def find_ready(self, iri: str) -> tuple[str, int] | None:
        """The newest ready version whose ontology, version or import IRI is `iri`."""
        ...

    def version_imports(self, ontology_id: str, version: int) -> list[dict[str, Any]]: ...

    def concept_by_label(
        self, versions: list[tuple[str, int]], scheme: str, label: str
    ) -> str | None:
        """The concept of `scheme` in one of `versions` whose label or alt label is `label`
        (trimmed, any case); None if there is none."""
        ...

    def local_only(self, ontology_id: str) -> bool:
        """The ontology may only be sent to local models."""
        ...

    def local_only_sources(self, versions: list[tuple[str, int]]) -> list[str]:
        """The local-only ontologies among `versions` and the ontologies their terms were
        imported from (`defined_in`), sorted: their text may only reach local models."""
        ...

    def embedding_terms(self, ontology_id: str, version: int) -> list[EmbeddingTerm]:
        """Every term but shapes, its parents as labels."""
        ...

    def existing_embeddings(
        self, ontology_id: str, version: int, model_ref: str
    ) -> dict[tuple[str, str], str]:
        """(kind, iri) -> text_sha256 of the vectors stored for the model."""
        ...

    def store_embeddings(
        self,
        ontology_id: str,
        version: int,
        model_ref: str,
        rows: list[tuple[str, str, str, list[float]]],
    ) -> None:
        """Upsert (kind, iri, text_sha256, vector) rows."""
        ...

    def lexical(
        self, versions: list[tuple[str, int]], query: str, kinds: list[str], limit: int
    ) -> list[Term]:
        """Terms of `kinds` matching `query` by label and synonyms (trigram) or definition (full
        text), best first."""
        ...

    def semantic(
        self,
        versions: list[tuple[str, int]],
        model_ref: str,
        vector: list[float],
        kinds: list[str],
        limit: int,
    ) -> list[Term]:
        """Terms of `kinds` nearest `vector` (cosine) under `model_ref`, nearest first."""
        ...

    def has_embeddings(self, versions: list[tuple[str, int]], model_ref: str) -> bool:
        """Any of `versions` has vectors for the model."""
        ...

    def lexical_best(
        self, versions: list[tuple[str, int]], text: str, kinds: list[str], min_similarity: float
    ) -> list[TermHit]:
        """Each version's term of `kinds` whose label or a synonym is most similar to `text`
        (pg_trgm similarity, whole strings), when at least `min_similarity`; best first."""
        ...

    def semantic_best(
        self,
        versions: list[tuple[str, int]],
        model_ref: str,
        vectors: list[list[float]],
        kinds: list[list[str]],
        min_similarity: float,
    ) -> list[list[TermHit]]:
        """For each query vector (with its own `kinds`), each version's term nearest it
        (1 - cosine distance), when at least `min_similarity`; best first. One list per
        vector, in order: the embeddings are read once for them all."""
        ...

    def create_imported(
        self,
        *,
        iri: str,
        title: str | None,
        file_name: str,
        media_type: str,
        sha256: str,
        size: int,
        source_url: str,
        parsed: ParsedOntology,
        root_id: str,
        before_commit: Callable[[str, int], None],
    ) -> tuple[str, int]:
        """A new library ontology (tagged imported-by:<root_id>) whose ready version 1 holds
        `parsed`; returns its id and version. `before_commit(id, version)` stores its files
        before the row is committed, so a ready version always has them."""
        ...


class SourceFile(BaseModel):
    """One uploaded file of a folder or zip import (runs bucket)."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    source_key: str = Field(alias="sourceKey", min_length=1)
    file_name: str = Field(alias="fileName", min_length=1)
    media_type: str = Field(default="", alias="mediaType")


class BatchMember(SourceFile):
    """One version of a folder imported as one ontology per file."""

    ontology_id: str = Field(alias="ontologyId", min_length=2)
    version: int = Field(gt=0)


class OntologyJobParams(BaseModel):
    """What the API's OntologyRepo puts in the job's params: one version from an uploaded file
    (`sourceKey`), a URL (`sourceUrl`) or a merged folder (`sources`); or, with `members` alone,
    one version per file of a folder."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    ontology_id: str | None = Field(default=None, alias="ontologyId", min_length=2)
    version: int | None = Field(default=None, gt=0)
    source_key: str | None = Field(default=None, alias="sourceKey", min_length=1)
    source_url: str | None = Field(default=None, alias="sourceUrl", min_length=1)
    sources: list[SourceFile] | None = Field(default=None, min_length=1)
    members: list[BatchMember] | None = Field(default=None, min_length=1)
    file_name: str | None = Field(default=None, alias="fileName", min_length=1)
    media_type: str = Field(default="", alias="mediaType")

    @model_validator(mode="after")
    def _one_source(self) -> OntologyJobParams:
        given = [x for x in (self.source_key, self.source_url, self.sources, self.members) if x]
        if len(given) != 1:
            raise ValueError("exactly one of sourceKey, sourceUrl, sources and members is required")
        single = (self.ontology_id, self.version, self.file_name)
        if self.members is not None:
            if any(x is not None for x in single):
                raise ValueError("members name their own ontologyId, version and fileName")
        elif any(x is None for x in single):
            raise ValueError("ontologyId, version and fileName are required")
        return self


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

    def start(self, ontology_id: str, version: int) -> bool:
        cur = self._conn.execute(
            """UPDATE ontology_versions SET status = 'parsing', error = NULL
                WHERE ontology_id = %s AND version = %s AND status IN ('queued', 'parsing')""",
            (ontology_id, version),
        )
        return cur.rowcount > 0

    def ready(self, ontology_id: str, version: int) -> bool:
        row = self._conn.execute(
            """SELECT status = 'ready' FROM ontology_versions
                WHERE ontology_id = %s AND version = %s""",
            (ontology_id, version),
        ).fetchone()
        return bool(row and row[0])

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
                          license = %s, kinds = %s, stats = %s, imports = %s, ontology_iris = %s
                    WHERE ontology_id = %s AND version = %s AND status <> 'ready'""",
                (
                    parsed.ontology_iri,
                    parsed.version_iri,
                    parsed.license,
                    parsed.kinds,
                    Jsonb(parsed.stats()),
                    Jsonb(parsed.import_entries or [_unresolved(i, None) for i in parsed.imports]),
                    parsed.ontology_iris,
                    ontology_id,
                    version,
                ),
            )

    def set_source(
        self,
        ontology_id: str,
        version: int,
        *,
        file_name: str,
        media_type: str,
        sha256: str,
        size: int,
    ) -> None:
        import psycopg

        try:
            self._conn.execute(
                """UPDATE ontology_versions
                      SET file_name = %s, media_type = %s, sha256 = %s, bytes = %s
                    WHERE ontology_id = %s AND version = %s AND status <> 'ready'""",
                (file_name, media_type, sha256, size, ontology_id, version),
            )
        except psycopg.errors.UniqueViolation:
            row = self._conn.execute(
                "SELECT version FROM ontology_versions WHERE ontology_id = %s AND sha256 = %s",
                (ontology_id, sha256),
            ).fetchone()
            raise DuplicateSource(int(row[0]) if row else 0) from None

    def find_ready(self, iri: str) -> tuple[str, int] | None:
        row = self._conn.execute(
            """SELECT ontology_id, version FROM ontology_versions
                WHERE status = 'ready'
                  AND (ontology_iri = %s OR version_iri = %s OR import_iri = %s
                       OR %s = ANY(ontology_iris))
                ORDER BY imported_at DESC, version DESC LIMIT 1""",
            (iri, iri, iri, iri),
        ).fetchone()
        return (str(row[0]), int(row[1])) if row else None

    def version_imports(self, ontology_id: str, version: int) -> list[dict[str, Any]]:
        row = self._conn.execute(
            "SELECT imports FROM ontology_versions WHERE ontology_id = %s AND version = %s",
            (ontology_id, version),
        ).fetchone()
        return list(row[0]) if row and row[0] else []

    def create_imported(
        self,
        *,
        iri: str,
        title: str | None,
        file_name: str,
        media_type: str,
        sha256: str,
        size: int,
        source_url: str,
        parsed: ParsedOntology,
        root_id: str,
        before_commit: Callable[[str, int], None],
    ) -> tuple[str, int]:
        base = import_id(iri)
        with self._conn.transaction():
            oid, n = base, 1
            while self._conn.execute("SELECT 1 FROM ontologies WHERE id = %s", (oid,)).fetchone():
                n += 1
                oid = f"{base}-{n}"
            self._conn.execute(
                """INSERT INTO ontologies (id, label, tags, created_by)
                   VALUES (%s, %s, %s, %s)""",
                (oid, title or iri, [f"imported-by:{root_id}"], f"import of {root_id}"),
            )
            self._conn.execute(
                """INSERT INTO ontology_versions
                     (ontology_id, version, file_name, media_type, sha256, bytes, source_kind,
                      source_url, import_iri, imported_by)
                   VALUES (%s, 1, %s, %s, %s, %s, 'import', %s, %s, %s)""",
                (oid, file_name, media_type, sha256, size, source_url, iri, f"import of {root_id}"),
            )
            self.save(oid, 1, parsed)
            before_commit(oid, 1)
        return oid, 1

    def concept_by_label(
        self, versions: list[tuple[str, int]], scheme: str, label: str
    ) -> str | None:
        if not versions:
            return None
        row = self._conn.execute(
            """SELECT t.iri FROM ontology_terms t
                 JOIN unnest(%s::text[], %s::int[]) AS p(id, v)
                   ON t.ontology_id = p.id AND t.version = p.v
                WHERE t.kind = 'concept' AND t.scheme = %s
                  AND (lower(t.label) = %s
                       OR EXISTS (SELECT 1 FROM unnest(t.alt_labels) a WHERE lower(a) = %s))
                ORDER BY lower(t.label) = %s DESC, t.ontology_id, t.version DESC, t.iri
                LIMIT 1""",
            (
                [v[0] for v in versions],
                [v[1] for v in versions],
                scheme,
                wanted := label.strip().lower(),
                wanted,
                wanted,
            ),
        ).fetchone()
        return str(row[0]) if row else None

    def local_only_sources(self, versions: list[tuple[str, int]]) -> list[str]:
        if not versions:
            return []
        rows = self._conn.execute(
            """SELECT o.id FROM ontologies o
                WHERE o.local_only
                  AND (o.id = ANY(%(ids)s::text[])
                       OR o.id IN (SELECT DISTINCT split_part(t.defined_in, '@', 1)
                                     FROM ontology_terms t
                                     JOIN unnest(%(ids)s::text[], %(vs)s::int[]) AS p(id, v)
                                       ON t.ontology_id = p.id AND t.version = p.v
                                    WHERE t.defined_in IS NOT NULL))
                ORDER BY o.id""",
            {"ids": [v[0] for v in versions], "vs": [v[1] for v in versions]},
        ).fetchall()
        return [str(r[0]) for r in rows]

    def local_only(self, ontology_id: str) -> bool:
        row = self._conn.execute(
            "SELECT local_only FROM ontologies WHERE id = %s", (ontology_id,)
        ).fetchone()
        return bool(row[0]) if row else False

    def embedding_terms(self, ontology_id: str, version: int) -> list[EmbeddingTerm]:
        rows = self._conn.execute(
            """SELECT kind, iri, label, alt_labels, definition, parents FROM ontology_terms
                WHERE ontology_id = %s AND version = %s AND kind <> 'shape'
                ORDER BY kind, iri""",
            (ontology_id, version),
        ).fetchall()
        labels: dict[str, str] = {}
        for _, iri, label, *_rest in rows:
            labels.setdefault(str(iri), str(label))
        return [
            EmbeddingTerm(
                str(kind),
                str(iri),
                str(label),
                list(alt_labels),
                str(definition),
                [labels.get(p, local_name(p)) for p in parents],
            )
            for kind, iri, label, alt_labels, definition, parents in rows
        ]

    def existing_embeddings(
        self, ontology_id: str, version: int, model_ref: str
    ) -> dict[tuple[str, str], str]:
        rows = self._conn.execute(
            """SELECT kind, iri, text_sha256 FROM ontology_term_embeddings
                WHERE ontology_id = %s AND version = %s AND model_ref = %s""",
            (ontology_id, version, model_ref),
        ).fetchall()
        return {(str(k), str(i)): str(s) for k, i, s in rows}

    def store_embeddings(
        self,
        ontology_id: str,
        version: int,
        model_ref: str,
        rows: list[tuple[str, str, str, list[float]]],
    ) -> None:
        if not rows:
            return
        with self._conn.transaction(), self._conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO ontology_term_embeddings
                     (ontology_id, version, kind, iri, model_ref, dims, text_sha256, embedding)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector)
                   ON CONFLICT (ontology_id, version, kind, iri, model_ref) DO UPDATE
                     SET dims = excluded.dims, text_sha256 = excluded.text_sha256,
                         embedding = excluded.embedding, created_at = now()""",
                [
                    (ontology_id, version, kind, iri, model_ref, len(vec), sha, vector_literal(vec))
                    for kind, iri, sha, vec in rows
                ],
            )

    def lexical(
        self, versions: list[tuple[str, int]], query: str, kinds: list[str], limit: int
    ) -> list[Term]:
        if not versions or not query.strip():
            return []
        rows = self._conn.execute(
            # Any word of the query may meet a definition (OR): an output's description is
            # never all in one term's text.
            f"""WITH q AS (SELECT lower(%(q)s) AS text,
                       to_tsquery('simple', replace(plainto_tsquery('simple', %(q)s)::text,
                                                    ' & ', ' | ')) AS ts),
                scored AS (
                  SELECT {_READ_COLUMNS},
                         greatest(word_similarity(lower(t.label), q.text),
                                  coalesce((SELECT max(word_similarity(lower(a), q.text))
                                              FROM unnest(t.alt_labels) a), 0)) AS lex,
                         ts_rank(d.doc, q.ts) AS fts,
                         d.doc @@ q.ts AS matched
                    FROM ontology_terms t
                    JOIN unnest(%(ids)s::text[], %(vs)s::int[]) AS p(id, v)
                      ON t.ontology_id = p.id AND t.version = p.v
                   CROSS JOIN q
                   CROSS JOIN LATERAL (SELECT to_tsvector('simple', t.label || ' '
                         || array_to_string(t.alt_labels, ' ') || ' ' || t.definition) AS doc) d
                   WHERE t.kind = ANY(%(kinds)s::text[]))
                SELECT * FROM scored
                 WHERE lex >= 0.3 OR matched
                 ORDER BY lex + fts DESC, label, iri
                 LIMIT %(limit)s""",
            {
                "q": query,
                "ids": [v[0] for v in versions],
                "vs": [v[1] for v in versions],
                "kinds": kinds,
                "limit": limit,
            },
        ).fetchall()
        return _unique([_read_term(r) for r in rows])

    def semantic(
        self,
        versions: list[tuple[str, int]],
        model_ref: str,
        vector: list[float],
        kinds: list[str],
        limit: int,
    ) -> list[Term]:
        from psycopg import sql

        if not versions or not vector:
            return []
        dims = len(vector)
        # An exact search over the asked versions only: an approximate index scan filtered
        # afterwards lets other ontologies' closer terms crowd these out, and HNSW cannot index
        # more than 2000 dimensions.
        query = sql.SQL(
            """WITH c AS MATERIALIZED (
                 SELECT {cols}, e.embedding FROM ontology_term_embeddings e
                   JOIN ontology_terms t USING (ontology_id, version, kind, iri)
                   JOIN unnest(%(ids)s::text[], %(vs)s::int[]) AS p(id, v)
                     ON e.ontology_id = p.id AND e.version = p.v
                  WHERE e.model_ref = {ref} AND e.dims = {dims}
                    AND e.kind = ANY(%(kinds)s::text[]))
               SELECT * FROM c ORDER BY embedding <=> %(vec)s::vector LIMIT %(limit)s"""
        ).format(cols=sql.SQL(_READ_COLUMNS), ref=sql.Literal(model_ref), dims=sql.Literal(dims))
        rows = self._conn.execute(
            query,
            {
                "ids": [v[0] for v in versions],
                "vs": [v[1] for v in versions],
                "kinds": kinds,
                "vec": vector_literal(vector),
                "limit": limit,
            },
        ).fetchall()
        return _unique([_read_term(r) for r in rows])

    def lexical_best(
        self, versions: list[tuple[str, int]], text: str, kinds: list[str], min_similarity: float
    ) -> list[TermHit]:
        if not versions or not text.strip():
            return []
        # The trigram indexes on labels (0032) and synonyms (0039) prefilter the candidates: a
        # label at least `min_similarity` similar (`%`), or a synonym list holding a stretch at
        # least that word-similar (`<%`, never below a synonym's own similarity), so the whole
        # library is never scanned per candidate. Thresholds are set for this transaction only.
        with self._conn.transaction():
            self._conn.execute(
                "SELECT set_config('pg_trgm.similarity_threshold', %(m)s, true),"
                " set_config('pg_trgm.word_similarity_threshold', %(m)s, true)",
                {"m": str(min_similarity)},
            )
            rows = self._conn.execute(
                f"""WITH scored AS (
                      SELECT t.ontology_id, t.version, {_READ_COLUMNS},
                             greatest(similarity(lower(t.label), %(q)s),
                                      coalesce((SELECT max(similarity(lower(a), %(q)s))
                                                  FROM unnest(t.alt_labels) a), 0)) AS sim
                        FROM ontology_terms t
                        JOIN unnest(%(ids)s::text[], %(vs)s::int[]) AS p(id, v)
                          ON t.ontology_id = p.id AND t.version = p.v
                       WHERE t.kind = ANY(%(kinds)s::text[])
                         AND (lower(t.label) %% %(q)s
                              OR %(q)s <%% ih_alt_labels_text(t.alt_labels)))
                    SELECT DISTINCT ON (ontology_id, version) * FROM scored
                     WHERE sim >= %(min)s
                     ORDER BY ontology_id, version, sim DESC, label, iri""",
                {
                    "q": text.lower(),
                    "ids": [v[0] for v in versions],
                    "vs": [v[1] for v in versions],
                    "kinds": kinds,
                    "min": min_similarity,
                },
            ).fetchall()
        hits = [TermHit(r[0], r[1], _read_term(r[2:]), float(r[-1])) for r in rows]
        return sorted(hits, key=lambda h: (-h.similarity, h.ontology_id, h.version))

    def semantic_best(
        self,
        versions: list[tuple[str, int]],
        model_ref: str,
        vectors: list[list[float]],
        kinds: list[list[str]],
        min_similarity: float,
    ) -> list[list[TermHit]]:
        from psycopg import sql

        out: list[list[TermHit]] = [[] for _ in vectors]
        asked = [i for i, v in enumerate(vectors) if v]
        if not versions or not asked:
            return out
        dims = {len(vectors[i]) for i in asked}
        if len(dims) != 1:
            raise ValueError("query vectors of different dimensions")
        # One pass over the asked versions' embeddings for every query vector (a small inner
        # relation), exact like `semantic`: no approximate index to crowd versions out.
        query = sql.SQL(
            """WITH q AS (
                 SELECT x.i, x.v::vector AS vec, string_to_array(x.k, ',') AS kinds
                   FROM unnest(%(idx)s::int[], %(vecs)s::text[], %(ks)s::text[]) AS x(i, v, k)),
               s AS (
                 SELECT q.i, t.ontology_id, t.version, {cols},
                        1 - (e.embedding <=> q.vec) AS sim
                   FROM ontology_term_embeddings e
                   JOIN ontology_terms t USING (ontology_id, version, kind, iri)
                   JOIN unnest(%(ids)s::text[], %(vs)s::int[]) AS p(id, v)
                     ON e.ontology_id = p.id AND e.version = p.v
                   JOIN q ON e.kind = ANY(q.kinds)
                  WHERE e.model_ref = {ref} AND e.dims = {dims})
               SELECT DISTINCT ON (i, ontology_id, version) * FROM s
                WHERE sim >= %(min)s
                ORDER BY i, ontology_id, version, sim DESC, label, iri"""
        ).format(
            cols=sql.SQL(_READ_COLUMNS),
            ref=sql.Literal(model_ref),
            dims=sql.Literal(dims.pop()),
        )
        rows = self._conn.execute(
            query,
            {
                "idx": asked,
                "vecs": [vector_literal(vectors[i]) for i in asked],
                "ks": [",".join(kinds[i]) for i in asked],
                "ids": [v[0] for v in versions],
                "vs": [v[1] for v in versions],
                "min": min_similarity,
            },
        ).fetchall()
        for r in rows:
            out[r[0]].append(TermHit(r[1], r[2], _read_term(r[3:]), float(r[-1])))
        return [sorted(h, key=lambda x: (-x.similarity, x.ontology_id, x.version)) for h in out]

    def has_embeddings(self, versions: list[tuple[str, int]], model_ref: str) -> bool:
        if not versions:
            return False
        row = self._conn.execute(
            """SELECT EXISTS (SELECT 1 FROM ontology_term_embeddings e
                 JOIN unnest(%s::text[], %s::int[]) AS p(id, v)
                   ON e.ontology_id = p.id AND e.version = p.v
                WHERE e.model_ref = %s)""",
            ([v[0] for v in versions], [v[1] for v in versions], model_ref),
        ).fetchone()
        return bool(row and row[0])

    def fail(self, ontology_id: str, version: int, error: str) -> None:
        self._conn.execute(
            """UPDATE ontology_versions SET status = 'failed', error = %s
                WHERE ontology_id = %s AND version = %s AND status <> 'ready'""",
            (error, ontology_id, version),
        )


def _unresolved(iri: str, reason: str | None) -> dict[str, Any]:
    return {
        "iri": iri,
        "resolution": "unresolved",
        "ontologyId": None,
        "version": None,
        "reason": reason,
    }


def _resolved(iri: str, how: str, ontology_id: str, version: int) -> dict[str, Any]:
    return {
        "iri": iri,
        "resolution": how,
        "ontologyId": ontology_id,
        "version": version,
        "reason": None,
    }


_READ_COLUMNS = (
    "t.iri, t.kind, t.label, t.alt_labels, t.definition, t.parents, t.domains, t.ranges,"
    " t.scheme, t.deprecated, t.root, t.child_count, t.defined_in"
)


def _read_term(row: Any) -> Term:
    iri, kind, label, alt, definition, parents, domains, ranges, scheme, dep, root, n, d = row[:13]
    return Term(
        str(iri), kind, str(label), list(alt), str(definition), list(parents), list(domains),
        list(ranges), scheme, bool(dep), bool(root), int(n), defined_in=d,
    )  # fmt: skip


def _unique(terms: list[Term]) -> list[Term]:
    """One row per IRI (a term indexed under several kinds or versions), first kept."""
    seen: set[str] = set()
    out: list[Term] = []
    for t in terms:
        if t.iri not in seen:
            seen.add(t.iri)
            out.append(t)
    return out


def vector_literal(vector: list[float]) -> str:
    """pgvector's text form: `[0.1,0.2]`."""
    return "[" + ",".join(repr(float(v)) for v in vector) + "]"


def import_id(iri: str) -> str:
    """A library id for an ontology pulled in by owl:imports (ONTOLOGY_ID_RE), from its IRI."""
    slug = re.sub(r"[^a-z0-9]+", "-", re.sub(r"^[a-z]+://", "", iri.lower())).strip("-")
    slug = slug[:58].strip("-")
    return slug if len(slug) >= 2 else "imported"


def source_extension(file_name: str, media_type: str) -> str:
    """The extension a file is stored under (ontologySourceExtension in TS)."""
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    return ext if ext in EXTENSIONS else MEDIA_EXTENSIONS.get(media_type, "ttl")


def _imports_of(graph: Graph) -> list[str]:
    headers, _, _ = _header(graph)
    return sorted({str(o) for h in headers for o in graph.objects(h, OWL.imports)})


Closure = list[tuple[Graph, str]]


@dataclass
class _ImportResolver:
    """Resolves owl:imports for one job: the library first, then the allowlisted web (new
    library ontologies tagged imported-by:<root>), at most MAX_IMPORT_DEPTH levels down, each
    IRI once, never back up the import path."""

    deps: PipelineDeps
    store: OntologyStore
    root_id: str
    #: Triples the root's closure may still add (None: not accounted at this level).
    budget: int | None = None
    memo: dict[str, tuple[dict[str, Any], Closure]] = field(default_factory=dict)
    #: A folder imported as one ontology per file: each header IRI -> (id, version, graph),
    #: resolved before the library (its members are not saved yet).
    batch: dict[str, tuple[str, int, Graph]] = field(default_factory=dict)

    def resolve_all(
        self, iris: Sequence[str], depth: int, path: frozenset[str]
    ) -> tuple[list[dict[str, Any]], Closure]:
        entries: list[dict[str, Any]] = []
        closure: Closure = []
        labels: set[str] = set()
        for iri in iris:
            if iri in path:
                entries.append(_unresolved(iri, "a cycle back to an ontology being imported"))
                continue
            entry, graphs = self.resolve(iri, depth, path)
            fresh = [(g, label) for g, label in graphs if label not in labels]
            if depth == 1 and self.budget is not None:
                size = sum(len(g) for g, _ in fresh)
                if size > self.budget:
                    entries.append(
                        _unresolved(iri, f"over the triple limit with its imports ({size} triples)")
                    )
                    continue
                self.budget -= size
            entries.append(entry)
            for graph, label in fresh:
                labels.add(label)
                closure.append((graph, label))
        return entries, closure

    def resolve(self, iri: str, depth: int, path: frozenset[str]) -> tuple[dict[str, Any], Closure]:
        if iri not in self.memo:
            if depth > MAX_IMPORT_DEPTH:
                self.memo[iri] = (_unresolved(iri, f"deeper than {MAX_IMPORT_DEPTH} imports"), [])
            else:
                self.memo[iri] = self._resolve(iri, depth, path | {iri})
        return self.memo[iri]

    def _resolve(
        self, iri: str, depth: int, path: frozenset[str]
    ) -> tuple[dict[str, Any], Closure]:
        runs = self.deps.buckets.runs
        if iri in self.batch:
            oid, version, graph = self.batch[iri]
            _, children = self.resolve_all(_imports_of(graph), depth + 1, path)
            return _resolved(iri, "library", oid, version), [(graph, f"{oid}@{version}"), *children]
        found = self.store.find_ready(iri)
        if found is not None:
            oid, version = found
            data = self.deps.store.get_optional(runs, ontology_normalized_key(oid, version))
            if data is None:
                return _unresolved(iri, f"{oid} v{version} has no stored triples"), []
            graph = Graph()
            graph.parse(data=data, format="nt")
            followed = [
                str(e["iri"])
                for e in self.store.version_imports(oid, version)
                if e.get("resolution") in ("library", "fetched")
            ]
            _, children = self.resolve_all(followed, depth + 1, path)
            return _resolved(iri, "library", oid, version), [(graph, f"{oid}@{version}"), *children]
        fetch = self.deps.ontology_fetch
        if fetch is None:
            return _unresolved(iri, "not in the library, and URL imports are off"), []
        max_triples = self.deps.ontology_max_triples
        # Imports name ontologies by IRI, mostly http://; only https is ever fetched.
        target = "https://" + iri[len("http://") :] if iri.startswith("http://") else iri
        try:
            fetched = fetch(target)
            graph = read_graph(
                fetched.data, fetched.media_type, fetched.file_name, max_triples=max_triples
            )
        except DocumentError as exc:
            return _unresolved(iri, str(exc)), []
        except OntologySourceUnavailable as exc:
            return _unresolved(iri, f"unavailable: {exc}"), []
        child_entries, children = self.resolve_all(_imports_of(graph), depth + 1, path)
        try:
            parsed = index_graph(graph, imports=children, max_triples=max_triples)
        except DocumentError as exc:
            return _unresolved(iri, str(exc)), []
        parsed.import_entries = child_entries
        sha = hashlib.sha256(fetched.data).hexdigest()
        ext = source_extension(fetched.file_name, fetched.media_type)

        def store_files(oid: str, version: int) -> None:
            self.deps.store.put(
                runs,
                ontology_source_key(oid, sha, ext),
                fetched.data,
                fetched.media_type or "text/plain",
            )
            self.deps.store.put(
                runs,
                ontology_normalized_key(oid, version),
                parsed.normalized,
                "application/n-triples",
            )

        oid, version = self.store.create_imported(
            iri=iri,
            title=parsed.title,
            file_name=fetched.file_name,
            media_type=fetched.media_type,
            sha256=sha,
            size=len(fetched.data),
            source_url=fetched.url,
            parsed=parsed,
            root_id=self.root_id,
            before_commit=store_files,
        )
        return _resolved(iri, "fetched", oid, version), [(graph, f"{oid}@{version}"), *children]


def _source(
    params: OntologyJobParams, deps: PipelineDeps, store: OntologyStore
) -> tuple[bytes, str, str]:
    """The version's bytes, media type and file name; a URL is fetched and recorded."""
    oid, version = params.ontology_id, params.version
    assert oid is not None and version is not None and params.file_name is not None
    if params.source_url is None:
        assert params.source_key is not None  # the params validator guarantees one source
        data = deps.store.get_optional(deps.buckets.runs, params.source_key)
        if data is None:
            raise DocumentError(f"the uploaded file is missing ({params.source_key})")
        return data, params.media_type, params.file_name
    if deps.ontology_fetch is None:
        raise DocumentError("URL imports are off: set ONTOLOGY_FETCH_ALLOW")
    fetched = deps.ontology_fetch(params.source_url)
    sha = hashlib.sha256(fetched.data).hexdigest()
    deps.store.put(
        deps.buckets.runs,
        ontology_source_key(oid, sha, source_extension(fetched.file_name, fetched.media_type)),
        fetched.data,
        fetched.media_type or "text/plain",
    )
    try:
        store.set_source(
            oid,
            version,
            file_name=fetched.file_name,
            media_type=fetched.media_type,
            sha256=sha,
            size=len(fetched.data),
        )
    except DuplicateSource as dup:
        raise DocumentError(f"same file as version {dup.version} of {oid}") from dup
    return fetched.data, fetched.media_type, fetched.file_name


def _uploaded(deps: PipelineDeps, f: SourceFile) -> bytes:
    data = deps.store.get_optional(deps.buckets.runs, f.source_key)
    if data is None:
        raise DocumentError(f"the uploaded file {f.file_name} is missing ({f.source_key})")
    return data


def read_files(deps: PipelineDeps, files: Sequence[SourceFile], *, max_triples: int) -> Graph:
    """A folder's files merged into one graph; any file that cannot be read refuses all."""
    merged = Graph()
    for f in files:
        graph = read_graph(_uploaded(deps, f), f.media_type, f.file_name, max_triples=max_triples)
        for triple in graph:
            merged.add(triple)
        if len(merged) > max_triples:
            raise DocumentError(f"ontology too large ({len(merged)} triples, limit {max_triples})")
    return merged


def _included(iri: str) -> dict[str, Any]:
    return {"iri": iri, "resolution": "included", "ontologyId": None, "version": None,
            "reason": None}  # fmt: skip


def _index_version(
    deps: PipelineDeps,
    store: OntologyStore,
    oid: str,
    own: Graph,
    batch: dict[str, tuple[str, int, Graph]] | None = None,
) -> ParsedOntology:
    """Resolve a version's imports (an IRI it declares itself is `included`) and index it."""
    max_triples = deps.ontology_max_triples
    headers = {str(h) for h in _header(own)[0]}
    imports = _imports_of(own)
    resolver = _ImportResolver(
        deps, store, oid, budget=max_triples - len(own), batch=dict(batch or {})
    )
    outer, graphs = resolver.resolve_all(
        [i for i in imports if i not in headers], 1, frozenset(headers)
    )
    by_iri = {e["iri"]: e for e in outer}
    parsed = index_graph(own, imports=graphs, max_triples=max_triples)
    parsed.import_entries = [by_iri.get(i) or _included(i) for i in imports]
    return parsed


def _finish(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, store: OntologyStore,
    oid: str, version: int, parsed: ParsedOntology,
) -> None:  # fmt: skip
    check_cancelled(job, queue)
    deps.store.put(
        deps.buckets.runs,
        ontology_normalized_key(oid, version),
        parsed.normalized,
        "application/n-triples",
    )
    store.save(oid, version, parsed)
    embed_after_import(deps, queue, job, oid, version)
    queue.event(
        job.id,
        "info",
        ONTOLOGY_INDEXED,
        {"ontologyId": oid, "version": version, "terms": len(parsed.terms),
         "triples": parsed.triples},
    )  # fmt: skip


def run_ontology_batch(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, members: Sequence[BatchMember]
) -> int:
    """A folder imported as one ontology per file: every member is read first, so imports
    between members resolve to each other whatever their order; a member that cannot be read or
    indexed fails alone. A retry skips members already finished, only finishing the embedding of
    those that are ready."""
    store = deps.ontologies
    assert store is not None
    max_triples = deps.ontology_max_triples
    graphs: dict[tuple[str, int], Graph] = {}
    for m in members:
        if not store.start(m.ontology_id, m.version):
            if store.ready(m.ontology_id, m.version):
                embed_after_import(deps, queue, job, m.ontology_id, m.version)
            continue
        try:
            graphs[(m.ontology_id, m.version)] = read_graph(
                _uploaded(deps, m), m.media_type, m.file_name, max_triples=max_triples
            )
        except DocumentError as exc:
            store.fail(m.ontology_id, m.version, str(exc))
    batch = {
        str(h): (oid, version, graph)
        for (oid, version), graph in graphs.items()
        for h in _header(graph)[0]
    }
    done = 0
    for (oid, version), own in graphs.items():
        try:
            parsed = _index_version(deps, store, oid, own, batch)
            _finish(job, deps, queue, store, oid, version, parsed)
            done += 1
        except DocumentError as exc:
            store.fail(oid, version, str(exc))
    return done


def run_ontology_import(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> ParsedOntology:
    """Read the version's file (uploaded, or fetched from its URL), resolve its owl:imports,
    keep its canonical N-Triples and index its terms with its imports'. A file that cannot be
    read fails the version (the job goes to review); other errors retry, failing the version on
    the last attempt so it never stays 'parsing'. An import never fails the job.

    A retry of a version that is already ready (the worker stopped while embedding its terms,
    e.g. a redeploy) only finishes the embedding: saving the terms again would delete the
    embeddings written so far, which reference them."""
    try:
        params = OntologyJobParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid ontology import parameters: {exc}") from exc
    store = deps.ontologies
    if store is None:
        raise DocumentError("this worker has no ontology store")
    if params.members is not None:
        run_ontology_batch(job, deps, queue, params.members)
        return ParsedOntology(0, None, None, None, [], [])
    oid, version = params.ontology_id, params.version
    assert oid is not None and version is not None  # the params validator guarantees them
    if not store.start(oid, version) and store.ready(oid, version):
        embed_after_import(deps, queue, job, oid, version)
        return ParsedOntology(0, None, None, None, [], [])
    try:
        max_triples = deps.ontology_max_triples
        if params.sources is not None:
            own = read_files(deps, params.sources, max_triples=max_triples)
        else:
            data, media_type, file_name = _source(params, deps, store)
            own = read_graph(data, media_type, file_name, max_triples=max_triples)
        parsed = _index_version(deps, store, oid, own)
        _finish(job, deps, queue, store, oid, version, parsed)
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
    return parsed
