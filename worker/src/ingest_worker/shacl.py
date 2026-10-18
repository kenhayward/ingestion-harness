"""SHACL shapes for a recipe's graph (ADR 0011 step 5): the pinned versions' graphs, and which
output a violated property belongs to."""

from __future__ import annotations

import contextlib
import multiprocessing
from multiprocessing.connection import Connection
from typing import Any

from rdflib import Graph

from .pipeline import DocumentError, PipelineDeps
from .rdf import CURIE_PREFIXES, ShaclReport, ShaclResult, expand_term, validate
from .storage import ontology_normalized_key
from .template import Template

#: Graph previews validate in a child process killed after this long (SHACL over a large
#: ontology can be slow; production jobs validate in-process, once per job).
GRAPH_TIMEOUT_S = 30.0


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

    def add(term: str | None, output: str) -> None:
        if term is None:
            return
        # An unknown prefix is a validation issue; the graph never has that property.
        with contextlib.suppress(ValueError):
            out.setdefault(str(expand_term(term, prefixes)), output)

    for field_id, mapping in semantics.fields.items():
        add(semantics.link_of(mapping), field_id)
    for table_id, table in semantics.tables.items():
        add(table.link, table_id)
        for column_id, mapping in table.columns.items():
            add(semantics.link_of(mapping), f"{table_id}.{column_id}")
    return out


def _validate_child(
    conn: Connection, graphs: tuple[bytes, bytes, bytes], by: dict[str, str]
) -> None:
    data, shapes, ontologies = (Graph().parse(data=g, format="nt") for g in graphs)
    conn.send(validate(data, shapes, ontologies, by).to_json())
    conn.close()


def validate_with_timeout(
    graph: Graph,
    shapes: Graph,
    ontologies: Graph,
    by_property: dict[str, str],
    timeout_s: float = GRAPH_TIMEOUT_S,
) -> ShaclReport:
    """`rdf.validate` in a child process; an overrun is a DocumentError (the preview's review)."""
    graphs = tuple(g.serialize(format="nt", encoding="utf-8") for g in (graph, shapes, ontologies))
    method = "fork" if "fork" in multiprocessing.get_all_start_methods() else "spawn"
    ctx: Any = multiprocessing.get_context(method)  # typeshed: BaseContext has no Process
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_validate_child, args=(child, graphs, by_property), daemon=True)
    try:
        proc.start()
        child.close()
        if not parent.poll(timeout_s):
            raise DocumentError(
                f"SHACL validation took longer than {timeout_s:g}s: the shapes or ontologies "
                "may be too large to preview"
            )
        try:
            data: dict[str, Any] = parent.recv()
        except EOFError as exc:
            raise DocumentError("SHACL validation process failed") from exc
        return ShaclReport([ShaclResult(**r) for r in data["results"]])
    finally:
        if proc.is_alive():
            proc.terminate()
            proc.join(5)
            if proc.is_alive():
                proc.kill()
        if proc.pid is not None:
            proc.join()
        child.close()
        parent.close()
