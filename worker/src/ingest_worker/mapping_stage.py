"""The Workbench `mapping` drafting stage (ADR 0011): propose the recipe's ontology mapping.

The API sends the brief's vocabulary versions, its guidance and the values the dev samples'
latest runs produced. For every output (the document, each field, table and column) the worker
shortlists terms from those versions (`retrieval.shortlist`: lexical, plus embeddings when the
versions have them and the data policy allows the embedding model), and the drafting model
chooses among them. Its answer is a flat schema (no union types, like revise); `convert_mapping`
turns it into the typed mapping changes of packages/shared/src/drafting.ts and refuses, for the
model to fix, any IRI that is neither shortlisted nor a local term the answer declares, and any
IRI template naming a value out of scope.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .draft_stages import Stage
from .llm.base import ToolSpec
from .llm.registry import ModelResolutionError
from .pipeline import DocumentError, PipelineDeps, check_cancelled
from .queue import ClaimedJob, JobQueue
from .retrieval import Candidate, shortlist
from .storage import drafting_key
from .tool_loop import Tool, ToolError

if TYPE_CHECKING:
    from .drafting import DraftParams
    from .llm.base import LLMProvider

#: Terms in one mapping prompt; the worst-ranked candidates are dropped first.
MAX_MAPPING_TERMS = 300
#: Candidates per output for its property (or link) and for its classes and concepts.
PROPERTY_CANDIDATES = 15
CLASS_CANDIDATES = 8
#: Observed values that go into an output's retrieval query.
VALUES_IN_QUERY = 5
#: Alternatives shown on a proposed change.
ALTERNATIVES = 5

PROPERTY_KINDS = ["object_property", "datatype_property", "annotation_property"]
CLASS_KINDS = ["class", "concept", "scheme"]
FILTERS = {"slug", "upper"}
_PLACEHOLDER = re.compile(r"\{(\w+)(?:\|(\w+))?\}")
_IRI_UNSAFE = re.compile(r"[\s<>\"{}|\\^`]")


class ObservedValue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str
    count: int = Field(ge=1)
    snippet: str | None = None
    sample: str


class MappingVersion(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1)
    version: int = Field(gt=0)
    local_only: bool = Field(alias="localOnly")
    label: str


class MappingInputs(BaseModel):
    """`params.mapping` of a mapping job (TS `MappingParams`, apps/api/src/workbench/mapping.ts)."""

    model_config = ConfigDict(extra="forbid")

    versions: list[MappingVersion] = Field(min_length=1)
    guidance: str = ""
    observed: dict[str, list[ObservedValue]] = Field(default_factory=dict)


@dataclass(frozen=True)
class OutputSpec:
    """One thing to map: `""` the document, a field id, a table id or `table.column`."""

    path: str
    kind: str  # document | field | table | column
    name: str
    description: str
    type: str
    enum: list[str] = field(default_factory=list)
    columns: list[str] = field(default_factory=list)


def outputs_of(draft: dict[str, Any]) -> list[OutputSpec]:
    outputs = draft.get("outputs") or {}
    out = [OutputSpec("", "document", str(draft.get("name") or "document"), "", "document")]
    for f in outputs.get("fields") or []:
        out.append(
            OutputSpec(
                f["id"], "field", f.get("name") or f["id"], f.get("description") or "",
                f.get("type") or "text", list(f.get("enum") or []),
            )
        )  # fmt: skip
    for t in outputs.get("tables") or []:
        columns = [c["id"] for c in t.get("columns") or []]
        out.append(
            OutputSpec(
                t["id"], "table", t.get("name") or t["id"], t.get("description") or "", "table",
                columns=columns,
            )
        )  # fmt: skip
        for c in t.get("columns") or []:
            out.append(
                OutputSpec(
                    f"{t['id']}.{c['id']}", "column", c.get("name") or c["id"],
                    c.get("description") or "", c.get("type") or "text", list(c.get("enum") or []),
                )
            )  # fmt: skip
    return out


def query_text(o: OutputSpec, observed: list[ObservedValue]) -> str:
    words = " ".join(re.split(r"[_.\-]+", o.path)) if o.path else o.name
    parts = [o.name if o.name != o.path else words, o.description, o.type]
    values = [v.value for v in observed[:VALUES_IN_QUERY]]
    if o.enum:
        values = [*o.enum, *values]
    if values:
        parts.append("values: " + ", ".join(values))
    return ". ".join(p for p in parts if p)


# --- the model's answer -----------------------------------------------------------------------


def _object(props: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(props),
        "properties": props,
    }


_S: dict[str, Any] = {"type": "string"}
MAPPING_OPS = [
    "setDocumentMapping",
    "putFieldMapping",
    "putTableMapping",
    "removeMapping",
    "putLocalTerm",
]
MAPPING_SCHEMA = _object(
    {
        "notes": _S,
        "changes": {
            "type": "array",
            "items": _object(
                {
                    "op": {"type": "string", "enum": MAPPING_OPS},
                    "target": _S,
                    "property": _S,
                    "valueAs": {"type": "string", "enum": ["literal", "entity", "concept"]},
                    "entityClass": _S,
                    "entityIri": _S,
                    "conceptScheme": _S,
                    "conceptValues": {
                        "type": "array",
                        "items": _object({"value": _S, "concept": _S}),
                    },
                    "matchByLabel": {"type": "boolean"},
                    "tableLink": _S,
                    "rowClass": _S,
                    "rowIri": _S,
                    "documentClass": _S,
                    "documentIri": _S,
                    "localIri": _S,
                    "localKind": {
                        "type": "string",
                        "enum": [
                            "",
                            "class",
                            "object_property",
                            "datatype_property",
                            "annotation_property",
                            "concept",
                        ],
                    },
                    "localLabel": _S,
                    "localDefinition": _S,
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    "reason": _S,
                    "evidence": {"type": "array", "items": _S},
                }
            ),
        },
    }
)

MAPPING_TOOLS_NOTE = """

When no candidate fits an output, search_terms may find one retrieval missed, and term_detail shows
a term's parents, domain and range before you choose it. A term either returns may be chosen like
a candidate."""

MAPPING_INSTRUCTIONS = """\
Task: map the recipe's outputs to ontology terms, so each document can be published as an RDF
graph. Choose only from the <candidates> of each output (their full IRIs), or declare a local
term (putLocalTerm) when no candidate fits and use its IRI.
- setDocumentMapping (target ""): documentClass, the class of the whole document, and
  documentIri, a template under the base such as "doc/{source}" ({source}, {type} and
  {version} only).
- putFieldMapping (target a field id, or "table.column" for a column): property, and valueAs:
  - literal: the value as it is;
  - entity: the value names a thing; entityClass and entityIri, a readable template such as
    "party/{value|slug}" ({value}; a column may also use its table's other columns; filters
    slug and upper);
  - concept: the value is a code; conceptValues maps enum values to concepts, or conceptScheme
    with matchByLabel true matches values to the scheme's concepts by label.
- putTableMapping (target a table id): tableLink, the property from the document to each row;
  rowClass; rowIri, optional, from the table's columns ("line/{sku|upper}"). Map a table before
  its columns.
- removeMapping (target an output or "table.column"): drop a wrong existing mapping.
- Fill keys a change does not use with "" ([] for lists, false for matchByLabel).
- confidence: high when the term clearly means the output, low when it is a guess; reason: why
  this term; evidence: the observed values that support it. Leave an output unmapped rather
  than guess: it then uses the recipe's own vocabulary.
- notes: outputs you left unmapped and why, and better ways to model them.
Return JSON only."""

MAPPING = Stage("mapping", MAPPING_INSTRUCTIONS, MAPPING_SCHEMA)


def namespace_of(iri: str) -> str:
    cut = max(iri.rfind("#"), iri.rfind("/"))
    return iri[: cut + 1] if cut >= 0 else iri


def _prefix_name(namespace: str) -> str:
    words = [w for w in re.split(r"[^A-Za-z0-9]+", namespace) if w]
    name = (words[-1] if words else "ns").lower()
    return name if re.match(r"^[a-z]", name) else f"ns{name}"


def compact_iri(iri: str, prefixes: dict[str, str]) -> str:
    """A CURIE under the longest declared namespace covering it, else the IRI itself."""
    best = max(
        ((p, ns) for p, ns in prefixes.items() if ns and iri.startswith(ns) and len(iri) > len(ns)),
        key=lambda pn: len(pn[1]),
        default=None,
    )
    return f"{best[0]}:{iri[len(best[1]) :]}" if best else iri


def _template_errors(where: str, template: str, allowed: list[str]) -> list[str]:
    errors = []
    for name, flt in _PLACEHOLDER.findall(template):
        if name not in allowed:
            errors.append(
                f"{where}: {name} is not available in this IRI template (use {', '.join(allowed)})"
            )
        if flt and flt not in FILTERS:
            errors.append(f"{where}: {flt} is not an IRI filter (use slug or upper)")
    if _IRI_UNSAFE.search(_PLACEHOLDER.sub("", template)):
        errors.append(f"{where}: {template} has characters an IRI cannot carry")
    return errors


def convert_mapping(
    data: dict[str, Any],
    draft: dict[str, Any],
    inputs: MappingInputs,
    shortlists: dict[str, list[Candidate]],
    *,
    local_namespace: str | None = None,
    searched: Sequence[Candidate] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """The model's flat changes as typed mapping changes, and every rule they break.

    Each change stands on its own, so any subset can be applied: field and table changes keep
    full IRIs unless the draft already declares their prefix; the document change declares
    prefixes for the namespaces the proposal uses. Local terms live under `local_namespace`
    (`{base}def/{type}/`); without a base none can be declared. `searched`: the terms the
    model's tools returned (None: it had no tools), which it may choose like the shortlist's."""
    outputs = {o.path: o for o in outputs_of(draft)}
    changes = list(data.get("changes") or [])
    local = {
        c["localIri"].strip()
        for c in changes
        if c.get("op") == "putLocalTerm" and str(c.get("localIri", "")).strip()
    }
    shortlisted = {c.iri: c for cands in shortlists.values() for c in cands}
    shortlisted.update({c.iri: c for c in searched or []})
    semantics = draft.get("semantics") or {}
    existing_prefixes: dict[str, str] = dict(semantics.get("prefixes") or {})
    errors: list[str] = []
    used_namespaces: list[str] = []

    def term(where: str, iri: Any) -> str:
        """A term the change may use, as a CURIE when a prefix covers it."""
        value = str(iri or "").strip()
        if not value:
            errors.append(f"{where}: a term is required")
            return ""
        if value not in shortlisted and value not in local:
            errors.append(
                f"{where}: {value} is not in the shortlist; choose a candidate or declare a "
                "local term"
                if searched is None
                else f"{where}: {value} is not in the shortlist or your searches; choose a "
                "candidate, search for a term or declare a local term"
            )
            return value
        if value in shortlisted:
            ns = namespace_of(value)
            if ns not in used_namespaces:
                used_namespaces.append(ns)
        return value

    def output_mapping(where: str, c: dict[str, Any], scope: list[str]) -> dict[str, Any]:
        mapping: dict[str, Any] = {"property": term(f"{where}.property", c.get("property"))}
        how = c.get("valueAs") or "literal"
        if how == "entity":
            template = str(c.get("entityIri") or "").strip()
            if not template:
                errors.append(f"{where}.entityIri: an entity needs an IRI template")
            errors.extend(_template_errors(f"{where}.entityIri", template, scope))
            mapping["object"] = {
                "class": term(f"{where}.entityClass", c.get("entityClass")),
                "iri": template,
            }
        elif how == "concept":
            concepts: dict[str, Any] = {}
            scheme = str(c.get("conceptScheme") or "").strip()
            if scheme:
                concepts["scheme"] = term(f"{where}.conceptScheme", scheme)
            values = {
                str(v.get("value")): term(f"{where}.conceptValues.{v.get('value')}", v["concept"])
                for v in c.get("conceptValues") or []
                if str(v.get("concept") or "").strip()
            }
            if values:
                concepts["values"] = values
            if c.get("matchByLabel"):
                if not scheme:
                    errors.append(f"{where}: matching by label needs a concept scheme")
                concepts["match"] = "label"
            mapping["concepts"] = concepts
        return mapping

    def meta(c: dict[str, Any], path: str | None, chosen: set[str]) -> dict[str, Any]:
        out: dict[str, Any] = {
            "reason": str(c.get("reason") or ""),
            "confidence": c.get("confidence") or "medium",
        }
        evidence = [str(e) for e in c.get("evidence") or [] if str(e).strip()]
        if evidence:
            out["evidence"] = evidence
        if path is not None:
            alternatives = [
                {"iri": cand.iri, "label": cand.label, "score": cand.score}
                for cand in shortlists.get(path, [])
                if cand.iri not in chosen
            ][:ALTERNATIVES]
            if alternatives:
                out["alternatives"] = alternatives
        return out

    typed: list[dict[str, Any]] = []
    tables: dict[str, dict[str, Any]] = {}
    pending_columns: list[tuple[int, str, str, dict[str, Any]]] = []
    for i, c in enumerate(changes):
        where = f"changes[{i}]"
        op = c.get("op")
        target = str(c.get("target") or "").strip()
        if op == "setDocumentMapping":
            template = str(c.get("documentIri") or "").strip() or "doc/{source}"
            errors.extend(
                _template_errors(f"{where}.documentIri", template, ["source", "type", "version"])
            )
            typed.append(
                {
                    "op": op,
                    "document": {
                        "class": term(f"{where}.documentClass", c.get("documentClass")),
                        "iri": template,
                    },
                    "ontologies": [{"id": v.id, "version": v.version} for v in inputs.versions],
                    "prefixes": {},  # filled below, once every term is known
                    **meta(c, None, set()),
                }
            )
        elif op == "putLocalTerm":
            iri = str(c.get("localIri") or "").strip()
            kind = c.get("localKind") or ""
            label = str(c.get("localLabel") or "").strip()
            if not iri or not kind or not label:
                errors.append(f"{where}: a local term needs localIri, localKind and localLabel")
                continue
            if _IRI_UNSAFE.search(iri):
                errors.append(f"{where}: {iri} is not a valid IRI")
            if local_namespace is None:
                errors.append(
                    f"{where}: local terms need a base IRI: set the customer under Administration > Linked data"
                )
            elif not iri.startswith(local_namespace) or iri == local_namespace:
                errors.append(f"{where}: local terms live under {local_namespace}, not {iri}")
            term_ = {"iri": iri, "kind": kind, "label": label}
            if str(c.get("localDefinition") or "").strip():
                term_["definition"] = str(c["localDefinition"]).strip()
            typed.append({"op": op, "term": term_, **meta(c, None, set())})
        elif op == "removeMapping":
            if target not in outputs or not target:
                errors.append(f"{where}: no output {target or '(empty)'} to unmap")
                continue
            typed.append({"op": op, "id": target, **meta(c, None, set())})
        elif op == "putTableMapping":
            spec = outputs.get(target)
            if spec is None or spec.kind != "table":
                errors.append(f"{where}: no table {target or '(empty)'}")
                continue
            mapping: dict[str, Any] = {
                "link": term(f"{where}.tableLink", c.get("tableLink")),
                "class": term(f"{where}.rowClass", c.get("rowClass")),
            }
            row_iri = str(c.get("rowIri") or "").strip()
            if row_iri:
                errors.extend(_template_errors(f"{where}.rowIri", row_iri, spec.columns))
                mapping["iri"] = row_iri
            mapping["columns"] = {}
            tables[target] = mapping
            chosen = {str(c.get("tableLink")), str(c.get("rowClass"))}
            typed.append({"op": op, "table": target, "mapping": mapping, **meta(c, target, chosen)})
        elif op == "putFieldMapping":
            spec = outputs.get(target)
            if spec is None or spec.kind not in ("field", "column"):
                errors.append(f"{where}: no output {target or '(empty)'} to map")
                continue
            if spec.kind == "column":
                table, column = target.split(".", 1)
                scope = ["value", *outputs[table].columns]
                pending_columns.append((i, table, column, output_mapping(where, c, scope)))
                continue
            chosen = {str(c.get("property")), str(c.get("entityClass"))}
            typed.append(
                {
                    "op": op,
                    "field": target,
                    "mapping": output_mapping(where, c, ["value"]),
                    **meta(c, target, chosen),
                }
            )
        else:
            errors.append(f"{where}: unknown op {op!r}")
    existing_tables = semantics.get("tables") or {}
    for i, table, column, mapping in pending_columns:
        if table in tables:
            tables[table]["columns"][column] = mapping
        elif table in existing_tables:
            merged = {
                **existing_tables[table],
                "columns": {**(existing_tables[table].get("columns") or {}), column: mapping},
            }
            tables[table] = merged
            typed.append(
                {
                    "op": "putTableMapping",
                    "table": table,
                    "mapping": merged,
                    "reason": changes[i].get("reason", ""),
                    "confidence": changes[i].get("confidence") or "medium",
                }
            )
        else:
            errors.append(
                f"changes[{i}]: map table {table} first (putTableMapping), then its columns"
            )

    # Prefixes for the ontologies' namespaces the changes use (the draft's own kept as they are).
    prefixes = dict(existing_prefixes)
    for ns in used_namespaces:
        if ns in prefixes.values():
            continue
        name, n = _prefix_name(ns), 2
        base = name
        while name in prefixes:
            name, n = f"{base}{n}", n + 1
        prefixes[name] = ns
    document_change = next((c for c in typed if c["op"] == "setDocumentMapping"), None)
    if (
        not semantics
        and document_change is None
        and any(c["op"] in ("putFieldMapping", "putTableMapping") for c in typed)
    ):
        errors.append("map the document first (setDocumentMapping): the recipe has no mapping yet")
    if document_change is not None:
        document_change["prefixes"] = {
            k: v for k, v in prefixes.items() if k not in existing_prefixes
        }
        _compact_terms([document_change], prefixes)
    _compact_terms([c for c in typed if c is not document_change], existing_prefixes)
    return {"notes": str(data.get("notes") or ""), "changes": typed}, errors


def _compact_terms(changes: list[dict[str, Any]], prefixes: dict[str, str]) -> None:
    """Every term of the changes as a CURIE where a declared prefix covers it (in place)."""

    def output(m: dict[str, Any]) -> None:
        m["property"] = compact_iri(m["property"], prefixes)
        if "object" in m:
            m["object"]["class"] = compact_iri(m["object"]["class"], prefixes)
        concepts = m.get("concepts") or {}
        if "scheme" in concepts:
            concepts["scheme"] = compact_iri(concepts["scheme"], prefixes)
        if "values" in concepts:
            concepts["values"] = {
                k: compact_iri(v, prefixes) for k, v in concepts["values"].items()
            }

    for c in changes:
        if c["op"] == "setDocumentMapping":
            c["document"]["class"] = compact_iri(c["document"]["class"], prefixes)
        elif c["op"] == "putFieldMapping":
            output(c["mapping"])
        elif c["op"] == "putTableMapping":
            m = c["mapping"]
            m["link"] = compact_iri(m["link"], prefixes)
            m["class"] = compact_iri(m["class"], prefixes)
            for col in (m.get("columns") or {}).values():
                output(col)


# --- the job ----------------------------------------------------------------------------------


def _candidate_line(c: Candidate) -> str:
    extra = []
    if c.domain:
        extra.append("domain " + ", ".join(c.domain))
    if c.range:
        extra.append("range " + ", ".join(c.range))
    if c.parents:
        extra.append("parents " + ", ".join(c.parents))
    definition = f" — {c.definition.strip()}" if c.definition.strip() else ""
    tail = f" ({'; '.join(extra)})" if extra else ""
    return f"- {c.iri} [{c.kind}] {c.label}{definition}{tail}"


def mapping_context(
    *,
    brief_text: str,
    inputs: MappingInputs,
    draft: dict[str, Any],
    observed: dict[str, list[ObservedValue]],
    shortlists: dict[str, list[Candidate]],
) -> str:
    blocks = [f"<brief>\n{brief_text}\n</brief>"]
    if inputs.guidance.strip():
        blocks.append(f"<mapping_guidance>\n{inputs.guidance.strip()}\n</mapping_guidance>")
    blocks.append(
        "<ontologies>\n"
        + "\n".join(f"- {v.label} ({v.id} v{v.version})" for v in inputs.versions)
        + "\n</ontologies>"
    )
    lines = []
    for o in outputs_of(draft):
        head = "document" if o.kind == "document" else f"{o.kind} {o.path}"
        desc = f": {o.description}" if o.description else ""
        lines.append(f"- {head} ({o.name}, {o.type}){desc}")
        if o.enum:
            lines.append(f"  enum: {', '.join(o.enum)}")
        for v in observed.get(o.path, [])[: VALUES_IN_QUERY * 2]:
            quote = f' — "{v.snippet}"' if v.snippet else ""
            lines.append(f"  seen: {v.value} ({v.count} times){quote}")
    blocks.append("<outputs>\n" + "\n".join(lines) + "\n</outputs>")
    for o in outputs_of(draft):
        cands = shortlists.get(o.path, [])
        if cands:
            body = "\n".join(_candidate_line(c) for c in cands)
            blocks.append(f'<candidates output="{o.path or "document"}">\n{body}\n</candidates>')
    if draft.get("semantics"):
        current = yaml.safe_dump(draft["semantics"], sort_keys=False).strip()
        blocks.append(f"<current_mapping>\n{current}\n</current_mapping>")
    return "\n\n".join(blocks)


def _cap(shortlists: dict[str, list[Candidate]]) -> dict[str, list[Candidate]]:
    """At most MAX_MAPPING_TERMS candidates over all outputs, the worst-ranked dropped first."""
    ranked = sorted(
        ((c.score, path, i) for path, cands in shortlists.items() for i, c in enumerate(cands)),
        key=lambda t: -t[0],
    )
    keep = {(path, i) for _, path, i in ranked[:MAX_MAPPING_TERMS]}
    return {p: [c for i, c in enumerate(cs) if (p, i) in keep] for p, cs in shortlists.items()}


@dataclass
class _Embedder:
    provider: Any
    model_id: str
    model_ref: str


#: What `search_terms` may look for, by the kinds it searches.
SEARCH_KINDS: dict[str, list[str]] = {
    "property": PROPERTY_KINDS,
    "class": ["class"],
    "concept": ["concept", "scheme"],
    "any": [*PROPERTY_KINDS, *CLASS_KINDS],
}
#: Terms one search returns at most.
MAX_SEARCH_RESULTS = 15


def mapping_tools(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    versions: list[tuple[str, int]],
    embedder: _Embedder | None,
    searched: dict[str, Candidate],
) -> list[Tool]:
    """`search_terms` and `term_detail` over the pinned ontology versions. Every term they
    return joins `searched`, which the model may then choose like a shortlisted one."""
    store = deps.ontologies
    assert store is not None

    def vector_for(query: str) -> list[float] | None:
        if embedder is None or not store.has_embeddings(versions, embedder.model_ref):
            return None
        try:
            vector: list[float] = embedder.provider.embed(embedder.model_id, [query])[0]
        except Exception:  # an outage costs the semantic half, never the search
            return None
        if deps.models.location(embedder.provider.name) == "external":
            queue.event(
                job.id,
                "info",
                "external model call",
                {
                    "stage": "mapping",
                    "purpose": "embedding",
                    "model": embedder.model_ref,
                    "samples": [],
                    "ontologies": [f"{i} v{v}" for i, v in versions],
                    "query": query,
                },
            )
        return vector

    def search(args: dict[str, Any]) -> str:
        query = str(args.get("query") or "").strip()
        if not query:
            raise ToolError("query is empty: say what the term means")
        kinds = SEARCH_KINDS.get(str(args.get("kind") or "any"))
        if kinds is None:
            raise ToolError(f"kind must be one of {', '.join(SEARCH_KINDS)}")
        limit = max(1, min(int(args.get("limit") or 10), MAX_SEARCH_RESULTS))
        found, _ = shortlist(
            store,
            versions,
            query,
            kinds,
            vector=vector_for(query),
            model_ref=embedder.model_ref if embedder else None,
            k=limit,
        )
        for c in found:
            searched.setdefault(c.iri, c)
        if not found:
            return f'No terms matched "{query}" in the pinned ontologies.'
        return "\n".join(_candidate_line(c) for c in found)

    def detail(args: dict[str, Any]) -> str:
        iri = str(args.get("iri") or "").strip()
        term = store.term(versions, iri) if iri else None
        if term is None:
            raise ToolError(f"no term {iri or '(empty)'} in the pinned ontologies")
        searched.setdefault(
            term.iri,
            Candidate(
                term.iri, term.kind, term.label, term.definition, list(term.parents),
                list(term.domain), list(term.range), 0.0, frozenset({"tool"}),
            ),
        )  # fmt: skip

        def named(iris: list[str]) -> str:
            out = []
            for other in iris[:10]:
                found = store.term(versions, other)
                out.append(f"{other} ({found.label})" if found else other)
            return ", ".join(out)

        lines = [f"{term.iri} [{term.kind}] {term.label}"]
        if term.alt_labels:
            lines.append("Also called: " + ", ".join(term.alt_labels))
        if term.definition.strip():
            lines.append("Definition: " + term.definition.strip())
        if term.parents:
            lines.append("Broader / parents: " + named(term.parents))
        if term.domain:
            lines.append("Domain: " + named(term.domain))
        if term.range:
            lines.append("Range: " + named(term.range))
        if term.scheme:
            lines.append(f"Concept scheme: {term.scheme}")
        if term.child_count:
            lines.append(f"Narrower terms: {term.child_count}")
        if term.defined_in:
            lines.append(f"Defined in the imported ontology {term.defined_in}")
        if term.deprecated:
            lines.append("Deprecated: do not use it.")
        return "\n".join(lines)

    return [
        Tool(
            ToolSpec(
                "search_terms",
                "Search the pinned ontologies for terms the candidates may have missed: by "
                "label, synonym and definition (and meaning, when embeddings exist). Any term "
                "it returns may be chosen like a candidate.",
                {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "What the term means."},
                        "kind": {"type": "string", "enum": list(SEARCH_KINDS)},
                        "limit": {"type": "integer", "minimum": 1, "maximum": MAX_SEARCH_RESULTS},
                    },
                    "required": ["query", "kind", "limit"],
                    "additionalProperties": False,
                },
            ),
            search,
            lambda args: f'Searching the ontologies for "{args.get("query", "")}"',
        ),
        Tool(
            ToolSpec(
                "term_detail",
                "Look up one term by its full IRI: its kind, labels, definition, parents, "
                "domain and range. A term looked up may be chosen like a candidate.",
                {
                    "type": "object",
                    "properties": {"iri": {"type": "string"}},
                    "required": ["iri"],
                    "additionalProperties": False,
                },
            ),
            detail,
            lambda args: f"Looking up {args.get('iri', 'a term')}",
        ),
    ]


def _embedder(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, local_only: bool, notes: list[str]
) -> _Embedder | None:
    ref = deps.embedding_model
    if ref is None:
        notes.append("Retrieval was lexical only: no embedding model is set.")
        return None
    try:
        provider, model_id = deps.models.resolve_embedding(ref)
    except ModelResolutionError as exc:
        notes.append(f"Retrieval was lexical only: {exc}.")
        return None
    if local_only and deps.models.location(provider.name) == "external":
        notes.append(
            f"Retrieval was lexical only: the embedding model {ref} is external and this "
            "mapping may only use local models."
        )
        return None
    return _Embedder(provider, model_id, ref)


def run_mapping(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    params: DraftParams,
    provider: LLMProvider,
    model_id: str,
    model_ref: str,
) -> dict[str, Any]:
    """The mapping stage's job: shortlist, ask, convert; writes and returns the DraftResult."""
    from . import drafting  # the drafting module imports this one

    store = deps.ontologies
    if store is None:
        raise DocumentError("the mapping stage needs the ontology library")
    if params.draft is None:
        raise DocumentError("drafting stage mapping needs the current draft")
    if params.mapping is None:
        raise DocumentError("a mapping job needs its mapping parameters")
    try:
        inputs = MappingInputs.model_validate(params.mapping)
    except Exception as exc:
        raise DocumentError(f"invalid mapping parameters: {exc}") from exc
    versions = [(v.id, v.version) for v in inputs.versions]
    restricted = sorted(
        {f"{v.id} v{v.version}" for v in inputs.versions if v.local_only}
        | set(store.local_only_sources(versions))
    )
    local_only = params.data_policy == "local" or bool(restricted)
    if restricted and deps.models.location(provider.name) == "external":
        raise DocumentError(
            f"{', '.join(restricted)} is local only: the mapping needs a local drafting model"
        )
    draft = params.draft
    # Holdout rule, defence in depth: only values seen in the dev samples sent are used.
    dev_files = {s.filename: s.sample_id for s in params.samples if s.role == "dev"}
    observed = {
        path: [v for v in values if v.sample in dev_files]
        for path, values in inputs.observed.items()
    }
    observed = {p: v for p, v in observed.items() if v}
    report = drafting.progress_reporter(job, queue, "mapping", len(dev_files))
    report("reading")

    notes: list[str] = []
    embedder = _embedder(job, deps, queue, local_only, notes)
    outputs = outputs_of(draft)
    queries = {o.path: query_text(o, observed.get(o.path, [])) for o in outputs}
    vectors: dict[str, list[float]] = {}
    if embedder is not None:
        missing = [
            f"{i} v{v}"
            for i, v in versions
            if not store.has_embeddings([(i, v)], embedder.model_ref)
        ]
        for name in missing:
            notes.append(
                f"Retrieval was lexical only for {name}: its terms are not embedded for "
                f"{embedder.model_ref} yet."
            )
        if len(missing) < len(versions):
            paths = list(queries)
            try:
                embedded = embedder.provider.embed(embedder.model_id, [queries[p] for p in paths])
                vectors = dict(zip(paths, embedded, strict=True))
            except Exception as exc:  # an outage costs the semantic half, never the run
                notes.append(f"Retrieval was lexical only: the embedding model failed: {exc}.")
                embedder = None
            if embedder is not None and deps.models.location(embedder.provider.name) == "external":
                queue.event(
                    job.id,
                    "info",
                    "external model call",
                    {
                        "stage": "mapping",
                        "purpose": "embedding",
                        "model": embedder.model_ref,
                        "samples": sorted(
                            {dev_files[v.sample] for vs in observed.values() for v in vs}
                        ),
                        "ontologies": [f"{i} v{v}" for i, v in versions],
                    },
                )
    shortlists: dict[str, list[Candidate]] = {}
    for o in outputs:
        model_ref_for = embedder.model_ref if embedder else None
        vector = vectors.get(o.path)
        found: list[Candidate] = []
        if o.kind != "document":
            found += shortlist(
                store, versions, queries[o.path], PROPERTY_KINDS, vector=vector,
                model_ref=model_ref_for, k=PROPERTY_CANDIDATES,
            )[0]  # fmt: skip
        if o.kind in ("document", "table") or o.enum or o.type in ("text", "enum"):
            found += shortlist(
                store, versions, queries[o.path], CLASS_KINDS, vector=vector,
                model_ref=model_ref_for, k=CLASS_CANDIDATES,
            )[0]  # fmt: skip
        if found:
            shortlists[o.path] = found
    shortlists = _cap(shortlists)

    context = mapping_context(
        brief_text=drafting._brief_text(params.brief),
        inputs=inputs,
        draft=draft,
        observed=observed,
        shortlists=shortlists,
    )
    check_cancelled(job, queue)
    if deps.models.location(provider.name) == "external":
        queue.event(
            job.id,
            "info",
            "external model call",
            {
                "stage": "mapping",
                "model": model_ref,
                "samples": sorted({dev_files[v.sample] for vs in observed.values() for v in vs}),
                "ontologies": [f"{i} v{v}" for i, v in versions],
            },
        )

    base = deps.linked_data.effective_base() if deps.linked_data else None
    local_namespace = f"{base}def/{draft.get('id')}/" if base else None
    if local_namespace:
        context += f"\n\n<local_terms>\nDeclare local terms under {local_namespace}\n</local_terms>"

    # Terms the model's tools returned: it may choose them like the shortlist's.
    searched: dict[str, Candidate] = {}
    tools = (
        mapping_tools(job, deps, queue, versions, embedder, searched)
        if deps.models.supports_tools(provider.name)
        else []
    )

    def chosen() -> list[Candidate] | None:
        return list(searched.values()) if tools else None

    def check(data: dict[str, Any]) -> list[str]:
        return convert_mapping(
            data, draft, inputs, shortlists, local_namespace=local_namespace, searched=chosen()
        )[1]

    limit = drafting.output_limit(deps, model_ref)
    result = drafting.ask(
        job,
        deps,
        log_to=drafting.DraftLog(deps, job, "mapping", model_ref),
        label="draft-mapping",
        provider=provider,
        model_id=model_id,
        prompt=f"{context}\n\n{MAPPING_INSTRUCTIONS}" + (MAPPING_TOOLS_NOTE if tools else ""),
        schema=MAPPING_SCHEMA,
        limit=limit,
        check=check,
        tools=tools,
        progress=drafting.CallProgress(report, tools=bool(tools)),
    )
    body, _ = convert_mapping(
        result.data,
        draft,
        inputs,
        shortlists,
        local_namespace=local_namespace,
        searched=chosen(),
    )
    body["notes"] = "\n".join(n for n in [body["notes"].strip(), *notes] if n)
    last = result.attempts[-1]
    output = {
        "stage": "mapping",
        "model": result.model_ref,
        "body": body,
        "usage": {"inputTokens": last.input_tokens, "outputTokens": last.output_tokens},
    }
    check_cancelled(job, queue)
    assert job.project_id is not None
    deps.store.put(
        deps.buckets.runs,
        drafting_key(job.project_id, job.id),
        json.dumps(output).encode(),
        "application/json",
    )
    return output
