"""Render a recipe's outputs to RDF (ADR 0011, design docs/design/rdf-publishing.md).

One named graph per (source file, document type). IRIs under the deployment's base:
`doc/{sha256}` the document, `job/{id}` the extraction, `doc/{sha256}/page/{n}` pages,
`doc/{sha256}/{type}/section/{id}` sections, `doc/{sha256}/fact/{type}/{output}` the evidence
behind each fact, and `def/{type}/{id}` the default vocabulary for outputs the recipe does not
map. Entities get readable IRIs from the mapping's template (`party/{value|slug}`).
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import quote

from rdflib import RDF, RDFS, XSD, Graph, Literal, Namespace, URIRef
from rdflib.term import Node

from .template import OutputMapping, Template, ValueDef

CT = Namespace("https://id.stocks-hayward.com/ns/ct#")
PROV = Namespace("http://www.w3.org/ns/prov#")
DCTERMS = Namespace("http://purl.org/dc/terms/")

#: Prefixes every recipe may use without declaring them (CURIE_PREFIXES in TS).
CURIE_PREFIXES: dict[str, str] = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "owl": "http://www.w3.org/2002/07/owl#",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "dcterms": "http://purl.org/dc/terms/",
    "prov": "http://www.w3.org/ns/prov#",
}

_PLACEHOLDER = re.compile(r"\{(\w+)(?:\|(\w+))?\}")
_ABSOLUTE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


def expand_term(curie: str, prefixes: dict[str, str]) -> URIRef:
    """A CURIE (or an IRI) as an IRI; ValueError for an undeclared prefix."""
    prefix, sep, local = curie.partition(":")
    if sep and prefix in prefixes and not local.startswith("//"):
        return URIRef(prefixes[prefix] + local)
    if _ABSOLUTE.match(curie):
        return URIRef(curie)
    raise ValueError(f"unknown prefix in {curie!r}")


@dataclass(frozen=True)
class GraphContext:
    #: The effective base IRI (ends with `/`).
    base: str
    #: (scheme IRI, label) -> concept IRI, for `match: label`.
    concepts: Callable[[str, str], str | None]


def slug(value: str) -> str:
    """ASCII, lower case, runs of anything else as one `-`."""
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def mint_entity_iri(base: str, template_str: str, values: dict[str, Any]) -> str | None:
    """Fill an IRI template; None when a key value is empty (no IRI, so no triple)."""
    missing = False

    def fill(match: re.Match[str]) -> str:
        nonlocal missing
        raw = values.get(match.group(1))
        text = "" if raw is None else str(raw).strip()
        if match.group(2) == "slug":
            text = slug(text)
        elif match.group(2) == "upper":
            text = text.upper()
        if not text:
            missing = True
        return quote(text, safe="")

    filled = _PLACEHOLDER.sub(fill, template_str)
    if missing:
        return None
    return filled if _ABSOLUTE.match(filled) else base + filled.lstrip("/")


class _Renderer:
    def __init__(self, template: Template, document: dict[str, Any], ctx: GraphContext) -> None:
        self.t = template
        self.doc = document
        self.base = ctx.base
        self.ctx = ctx
        self.sha: str = document["source_sha256"]
        self.semantics = template.semantics
        self.prefixes = {**CURIE_PREFIXES, **(self.semantics.prefixes if self.semantics else {})}
        identifier = URIRef(f"{self.base}graph/source/{self.sha}/{template.id}")
        self.g = Graph(identifier=identifier, bind_namespaces="core")
        for prefix, ns in sorted({"ct": str(CT), **self.prefixes}.items()):
            self.g.bind(prefix, Namespace(ns), override=True, replace=True)
        self.issues: dict[tuple[str, int | None, str | None], str] = {}
        self.raw: dict[tuple[str, int | None, str | None], Any] = {}
        for issue in document.get("issues", []):
            key = (issue.get("target"), issue.get("row"), issue.get("column"))
            self.issues[key] = str(issue.get("message"))
            self.raw[key] = issue.get("raw")

    # --- names -------------------------------------------------------------------------------

    def expand(self, curie: str) -> URIRef:
        return expand_term(curie, self.prefixes)

    def own(self, path: str) -> URIRef:
        return URIRef(self.base + path)

    def default_term(self, local: str) -> URIRef:
        return self.own(f"def/{self.t.id}/{local}")

    def page(self, number: int) -> URIRef:
        node = self.own(f"doc/{self.sha}/page/{number}")
        self.g.add((node, RDF.type, CT.Page))
        self.g.add((node, CT.pageNumber, Literal(number, datatype=XSD.integer)))
        self.g.add((node, CT.of, self.doc_node))
        return node

    def section(self, section_id: str) -> URIRef:
        node = self.own(f"doc/{self.sha}/{self.t.id}/section/{section_id}")
        order = [s.id for s in self.t.document.sections].index(section_id) + 1
        self.g.add((node, RDF.type, CT.Section))
        self.g.add((node, RDFS.label, Literal(section_id)))
        self.g.add((node, CT.order, Literal(order, datatype=XSD.integer)))
        self.g.add((node, CT.of, self.doc_node))
        return node

    # --- values ------------------------------------------------------------------------------

    def literal(self, value: Any, definition: ValueDef) -> Literal:
        kind = definition.type
        if kind == "integer" and isinstance(value, int | float | str):
            return Literal(int(value), datatype=XSD.integer)
        if kind == "decimal":
            try:
                return Literal(Decimal(str(value)), datatype=XSD.decimal)
            except InvalidOperation:
                return Literal(str(value))
        if kind == "date":
            return Literal(str(value), datatype=XSD.date)
        if kind == "boolean" and isinstance(value, bool):
            return Literal(value)
        return Literal(str(value))

    def objects(
        self,
        value: Any,
        definition: ValueDef,
        mapping: OutputMapping | None,
        values: dict[str, Any],
    ) -> tuple[list[Node], list[str]]:
        """The RDF objects for a value (one per list item), and problems mapping it."""
        items = value if isinstance(value, list) else [value]
        nodes: list[Node] = []
        problems: list[str] = []
        for item in items:
            if item is None or item == "":
                continue
            if mapping and mapping.object:
                iri = mint_entity_iri(self.base, mapping.object.iri, {**values, "value": item})
                if iri is None:
                    nodes.append(Literal(str(item)))
                    problems.append(f"no IRI for {item!r}")
                    continue
                entity = URIRef(iri)
                self.g.add((entity, RDF.type, self.expand(mapping.object.class_)))
                if mapping.object.label is not False:
                    self.g.add((entity, RDFS.label, Literal(str(item))))
                nodes.append(entity)
            elif mapping and mapping.concepts:
                concept = self.concept(str(item), mapping)
                if concept is None:
                    nodes.append(Literal(str(item)))
                    problems.append(f"no concept for {item!r}")
                else:
                    nodes.append(concept)
            elif definition.type == "list":
                nodes.append(Literal(str(item)))
            else:
                nodes.append(self.literal(item, definition))
        return nodes, problems

    def concept(self, value: str, mapping: OutputMapping) -> URIRef | None:
        concepts = mapping.concepts
        assert concepts is not None
        if concepts.values and value in concepts.values:
            return self.expand(concepts.values[value])
        if concepts.match == "label" and concepts.scheme:
            found = self.ctx.concepts(str(self.expand(concepts.scheme)), value)
            return URIRef(found) if found else None
        return None

    def facts(
        self,
        key: tuple[str, int | None, str | None],
        value: Any,
        definition: ValueDef,
        mapping: OutputMapping | None,
        values: dict[str, Any],
    ) -> tuple[list[Node], list[str]]:
        """Objects for a value, falling back to the raw text when normalisation failed."""
        issue = self.issues.get(key)
        if issue is not None and (value is None or value == "" or value == []):
            raw = self.raw.get(key)
            if raw is None or raw == "":
                return [], []
            return [Literal(str(raw))], [issue]
        nodes, problems = self.objects(value, definition, mapping, values)
        return nodes, ([issue] if issue else []) + problems

    # --- the graph ---------------------------------------------------------------------------

    def render(self) -> Graph:
        sem = self.semantics
        doc_iri = mint_entity_iri(
            self.base,
            sem.document.iri if sem else "doc/{source}",
            {"source": self.sha, "type": self.t.id, "version": self.t.version},
        )
        if doc_iri is None:
            raise ValueError(
                f"the document IRI template {sem.document.iri if sem else ''!r} names no value"
            )
        self.doc_node = URIRef(doc_iri)
        doc_class = self.expand(sem.document.class_) if sem else self.default_term("Document")
        self.g.add((self.doc_node, RDF.type, doc_class))
        self.provenance()
        for definition in self.t.outputs.fields:
            self.field(definition)
        for table in self.t.outputs.tables:
            self.table(table.id)
        return self.g

    def provenance(self) -> None:
        doc = self.doc
        job = self.own(f"job/{doc['job_id']}")
        g = self.g
        g.add((self.doc_node, PROV.wasGeneratedBy, job))
        g.add((self.doc_node, DCTERMS.source, URIRef(f"urn:sha256:{self.sha}")))
        g.add((job, RDF.type, PROV.Activity))
        g.add((job, CT.recipe, Literal(self.t.id)))
        g.add((job, CT.recipeVersion, Literal(self.t.version, datatype=XSD.integer)))
        for model in sorted(set(doc.get("models", {}).values())):
            g.add((job, CT.model, Literal(model)))
        review = doc.get("review") or {}
        if review.get("reviewer"):
            g.add((job, CT.reviewedBy, Literal(review["reviewer"])))
        ended = doc.get("published_at") or doc.get("extracted_at")
        if ended:
            g.add((job, PROV.endedAtTime, Literal(ended, datatype=XSD.dateTime)))
        g.add((job, CT.baseIri, Literal(self.base)))

    def field(self, definition: ValueDef) -> None:
        entry = self.doc["fields"].get(definition.id) or {}
        mapping = self.semantics.fields.get(definition.id) if self.semantics else None
        prop = self.expand(mapping.property) if mapping else self.default_term(definition.id)
        value = entry.get("value")
        nodes, problems = self.facts(
            (definition.id, None, None), value, definition, mapping, {"value": value}
        )
        if not nodes:
            return
        for node in nodes:
            self.g.add((self.doc_node, prop, node))
        fact = self.own(f"doc/{self.sha}/fact/{self.t.id}/{definition.id}")
        step = self.t.filler_of_field(definition.id)
        self.evidence(fact, self.doc_node, step.id, step.sections, problems)
        self.g.add((fact, CT.property, prop))
        for node in nodes:
            self.g.add((fact, CT.value, node))
        page = entry.get("page")
        if isinstance(page, int) and not isinstance(page, bool) and page > 0:
            self.g.add((fact, CT.page, self.page(page)))
        quote_text = entry.get("evidence")
        if isinstance(quote_text, str) and quote_text:
            self.g.add((fact, CT.quote, Literal(quote_text)))

    def evidence(
        self, fact: URIRef, subject: Node, step: str, sections: list[str], problems: list[str]
    ) -> None:
        self.g.add((fact, RDF.type, CT.Evidence))
        self.g.add((fact, CT.subject, subject))
        self.g.add((fact, CT.step, Literal(step)))
        for section_id in sections:
            self.g.add((fact, CT.section, self.section(section_id)))
        for problem in problems:
            self.g.add((fact, CT.normalisationIssue, Literal(problem)))

    def table(self, table_id: str) -> None:
        table = self.t.table(table_id)
        mapping = self.semantics.tables.get(table_id) if self.semantics else None
        link = self.expand(mapping.link) if mapping else self.default_term(table_id)
        row_class = self.expand(mapping.class_) if mapping else self.default_term(f"{table_id}/Row")
        step = self.t.filler_of_table(table_id)
        for n, row in enumerate(self.doc["tables"].get(table_id, []), start=1):
            minted = (
                mint_entity_iri(self.base, mapping.iri, row) if mapping and mapping.iri else None
            )
            node = URIRef(minted or self.own(f"doc/{self.sha}/{self.t.id}/{table_id}/{n}"))
            self.g.add((self.doc_node, link, node))
            self.g.add((node, RDF.type, row_class))
            problems: list[str] = []
            for column in table.columns:
                col_map = mapping.columns.get(column.id) if mapping else None
                prop = (
                    self.expand(col_map.property)
                    if col_map
                    else self.default_term(f"{table_id}.{column.id}")
                )
                nodes, found = self.facts(
                    (table_id, n, column.id), row.get(column.id), column, col_map, row
                )
                problems += [f"{column.id}: {p}" for p in found]
                for value_node in nodes:
                    self.g.add((node, prop, value_node))
            fact = self.own(f"doc/{self.sha}/fact/{self.t.id}/{table_id}/{n}")
            self.evidence(fact, node, step.id, step.sections, problems)


def render_graph(template: Template, document: dict[str, Any], ctx: GraphContext) -> Graph:
    """The named graph for one document under one recipe."""
    return _Renderer(template, document, ctx).render()


def to_turtle(graph: Graph) -> bytes:
    """Turtle with the graph's bound prefixes; rdflib sorts subjects, so output is stable."""
    return graph.serialize(format="turtle", encoding="utf-8")


# --- SHACL (step 5) --------------------------------------------------------------------------

SH = Namespace("http://www.w3.org/ns/shacl#")


def _local(node: Node | None) -> str:
    text = str(node) if node is not None else ""
    return re.split(r"[#/]", text)[-1] if text else ""


@dataclass(frozen=True)
class ShaclResult:
    #: `Violation`, `Warning` or `Info`.
    severity: str
    #: The node shape (its IRI) whose constraint failed.
    shape: str
    focus: str
    path: str
    #: The output the path publishes (`field`, `table` or `table.column`), else the path IRI.
    output: str
    message: str
    value: str

    def reason(self) -> str:
        return f"SHACL: {_local(URIRef(self.shape)) or self.shape} on {self.output}: {self.message}"

    def to_json(self) -> dict[str, str]:
        return {
            "severity": self.severity,
            "shape": self.shape,
            "focus": self.focus,
            "path": self.path,
            "output": self.output,
            "message": self.message,
            "value": self.value,
        }


@dataclass(frozen=True)
class ShaclReport:
    results: list[ShaclResult]

    @property
    def conforms(self) -> bool:
        """No violation (warnings and infos never block)."""
        return not self.violations()

    def violations(self) -> list[ShaclResult]:
        return [r for r in self.results if r.severity == "Violation"]

    def to_json(self) -> dict[str, Any]:
        return {"conforms": self.conforms, "results": [r.to_json() for r in self.results]}


def validate(
    graph: Graph, shapes: Graph, ontologies: Graph, outputs_by_property: dict[str, str]
) -> ShaclReport:
    """pySHACL over one document's graph, no inference; the ontologies are merged in so that
    `sh:class` sees the concepts' types and `rdfs:subClassOf`. Only results whose focus node the
    document's graph describes are kept."""
    from pyshacl import validate as run_shacl

    # pySHACL's `ont_graph` does not carry instance typing (a concept's rdf:type), so the
    # ontologies are merged into a copy of the document's graph instead.
    data = Graph()
    data += graph
    data += ontologies
    _, results_graph, _ = run_shacl(
        data_graph=data,
        shacl_graph=shapes,
        inference="none",
        abort_on_first=False,
        allow_warnings=True,
    )
    assert isinstance(results_graph, Graph)
    # A property shape is usually a blank node: report the node shape that holds it.
    holder = {str(prop): node for node, prop in shapes.subject_objects(SH.property)}
    results: list[ShaclResult] = []
    for r in results_graph.subjects(RDF.type, SH.ValidationResult):
        focus = results_graph.value(r, SH.focusNode)
        if focus is None or (focus, None, None) not in graph:
            # A node only the ontologies describe: no review edit can fix it, so it never
            # holds back the document.
            continue
        source = results_graph.value(r, SH.sourceShape)
        shape = holder.get(str(source), source)
        path = results_graph.value(r, SH.resultPath)
        path_text = str(path) if isinstance(path, URIRef) else ""
        message = results_graph.value(r, SH.resultMessage)
        value = results_graph.value(r, SH.value)
        results.append(
            ShaclResult(
                severity=_local(results_graph.value(r, SH.resultSeverity)) or "Violation",
                shape=str(shape) if shape is not None else "",
                focus=str(focus),
                path=path_text,
                output=outputs_by_property.get(path_text) or path_text or "document",
                message=str(message) if message is not None else "does not conform",
                value=str(value) if value is not None else "",
            )
        )
    results.sort(key=lambda r: (r.severity != "Violation", r.output, r.message, r.focus))
    return ShaclReport(results)
