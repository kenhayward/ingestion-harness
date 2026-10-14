"""SHACL shapes for a recipe's graph (ADR 0011 step 5): the pinned versions' graphs, and which
output a violated property belongs to."""

from __future__ import annotations

import contextlib

from rdflib import Graph

from .pipeline import DocumentError, PipelineDeps
from .rdf import CURIE_PREFIXES, expand_term
from .storage import ontology_normalized_key
from .template import Template


def load_graphs(deps: PipelineDeps, pins: list[tuple[str, int]]) -> Graph:
    """The pinned versions' triples in one graph (their normalised N-Triples, written by the
    ontology import). A version whose file is missing is a DocumentError: validation never
    silently runs without its shapes."""
    graph = Graph()
    for ontology_id, version in pins:
        data = deps.store.get_optional(
            deps.buckets.runs, ontology_normalized_key(ontology_id, version)
        )
        if data is None:
            raise DocumentError(
                f"{ontology_id} v{version} is not available: import it again in the library"
            )
        graph.parse(data=data, format="nt")
    return graph


def outputs_by_property(template: Template) -> dict[str, str]:
    """Expanded property IRI -> the output it publishes: a field, a table (its link) or a
    `table.column`. The first mapping wins when two outputs share a property."""
    semantics = template.semantics
    if semantics is None:
        return {}
    prefixes = {**CURIE_PREFIXES, **semantics.prefixes}
    out: dict[str, str] = {}

    def add(term: str, output: str) -> None:
        # An unknown prefix is a validation issue; the graph never has that property.
        with contextlib.suppress(ValueError):
            out.setdefault(str(expand_term(term, prefixes)), output)

    for field_id, mapping in semantics.fields.items():
        add(mapping.property, field_id)
    for table_id, table in semantics.tables.items():
        add(table.link, table_id)
        for column_id, mapping in table.columns.items():
            add(mapping.property, f"{table_id}.{column_id}")
    return out
