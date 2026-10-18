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
from .mapping_memory import (
    VALUE_NODE_DEFAULTS_PATH,
    Hit,
    MemoryEntry,
    OutputLook,
    Recall,
    RememberedAnswer,
    answer_dict,
    answer_terms,
    defaults_key,
    hint_line,
    parse_answer,
    preselect,
    recall,
    signature_text,
)
from .pipeline import DocumentError, PipelineDeps, check_cancelled
from .queue import ClaimedJob, JobQueue
from .retrieval import Candidate, shortlist
from .storage import drafting_key
from .tool_loop import Tool, ToolError

if TYPE_CHECKING:
    from .drafting import DraftParams
    from .llm.base import LLMProvider
    from .ontology import OntologyStore, Term

#: Terms in one mapping prompt; the worst-ranked candidates are dropped first.
MAX_MAPPING_TERMS = 300
#: Candidates per output for its property (or link) and for its classes and concepts.
PROPERTY_CANDIDATES = 15
CLASS_CANDIDATES = 8
#: Observed values that go into an output's retrieval query.
VALUES_IN_QUERY = 5
#: Alternatives shown on a proposed change.
ALTERNATIVES = 5

#: Numeric and date outputs: a value node is the likely form, so fewer properties, more classes.
NODE_TYPES = frozenset({"integer", "decimal", "date"})
NODE_PROPERTY_CANDIDATES = 5
NODE_CLASS_CANDIDATES = 10
#: The value-node defaults' candidates: (path, query, kinds), searched like an output's.
VALUE_NODES = "#valueNodes"
VALUE_NODE_QUERIES: list[tuple[str, str, list[str]]] = [
    (f"{VALUE_NODES}.link", "has output. has specified output. has data output. has result",
     ["object_property"]),
    (f"{VALUE_NODES}.value", "has value. numeric value. value", ["datatype_property"]),
    (f"{VALUE_NODES}.unitProperty", "has unit. unit", ["object_property"]),
]  # fmt: skip
#: Units are not in the ontology library (QUDT units are individuals): only QUDT's are taken.
QUDT_UNITS = "http://qudt.org/vocab/unit/"

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
                    "valueAs": {"type": "string", "enum": ["literal", "entity", "concept", "node"]},
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
                    "nodeClass": _S,
                    "nodeValue": _S,
                    "nodeUnit": _S,
                    "nodeUnitProperty": _S,
                    "valueLink": _S,
                    "valueProperty": _S,
                    "unitProperty": _S,
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    "reason": _S,
                    "evidence": {"type": "array", "items": _S},
                }
            ),
        },
    }
)


def blank_change(op: str, target: str = "") -> dict[str, Any]:
    """A flat change with every key of `MAPPING_SCHEMA` present, empty where unused."""
    props = MAPPING_SCHEMA["properties"]["changes"]["items"]["properties"]
    out: dict[str, Any] = {}
    for key, spec in props.items():
        kind = spec.get("type")
        out[key] = [] if kind == "array" else False if kind == "boolean" else ""
    out.update(op=op, target=target, valueAs="literal", confidence="medium")
    return out


def remembered_change(answer: RememberedAnswer, path: str) -> dict[str, Any] | None:
    """A remembered answer as the flat change the model would have given for `path` (None for
    an output left unmapped). Value-node defaults (path `#valueNodes`) give only the document
    change's default keys, to merge into it."""
    a = answer_dict(answer)
    form = a["form"]
    if form == "unmapped":
        return None
    if form == "valueNodes":
        return {
            "valueLink": a.get("link", ""),
            "valueProperty": a.get("value", ""),
            "unitProperty": a.get("unitProperty", ""),
        }
    if form == "document":
        c = blank_change("setDocumentMapping")
        c.update(documentClass=a["class"], documentIri=a["iri"])
        return c
    if form == "table":
        c = blank_change("putTableMapping", path)
        c.update(tableLink=a["link"], rowClass=a["class"], rowIri=a.get("iri", ""))
        return c
    c = blank_change("putFieldMapping", path)
    c["valueAs"] = form
    if form == "node":
        c.update(
            property=a.get("link", ""),
            nodeClass=a["class"],
            nodeValue=a.get("value", ""),
            nodeUnit=a.get("unit", ""),
            nodeUnitProperty=a.get("unitProperty", ""),
        )
    elif form == "entity":
        c.update(property=a["property"], entityClass=a["class"], entityIri=a["iri"])
    elif form == "concept":
        c.update(
            property=a["property"],
            conceptScheme=a.get("scheme", ""),
            conceptValues=[{"value": k, "concept": v} for k, v in (a.get("values") or {}).items()],
            matchByLabel=a.get("match") == "label",
        )
    else:
        c["property"] = a["property"]
    return c


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
  {version} only). Also the value-node defaults, from the value nodes' <candidates>: valueLink
  (the object property from the document or row to a value node), valueProperty (the datatype
  property holding the value) and unitProperty (the property to its unit).
- putFieldMapping (target a field id, or "table.column" for a column): property, and valueAs:
  - literal: the value as it is;
  - entity: the value names a thing; entityClass and entityIri, a readable template such as
    "party/{value|slug}" ({value}; a column may also use its table's other columns; filters
    slug and upper);
  - concept: the value is a code; conceptValues maps enum values to concepts, or conceptScheme
    with matchByLabel true matches values to the scheme's concepts by label;
  - node: the value is a measurement or result of a kind the ontology names as a class (water
    content, assay, elapsed time, count). nodeClass is that class (one of the output's class
    candidates); the value sits on a node of it. property is the link from the document or row
    to the node, nodeValue the property holding the value, nodeUnit a QUDT unit IRI when the
    value has one (http://qudt.org/vocab/unit/PERCENT, …/MIN). Leave property, nodeValue and
    nodeUnitProperty "" to use the value-node defaults.
  When an ontology's properties are generic relations (has output, has value) and its classes
  carry the meaning, prefer node over a literal with a generic property.
- putTableMapping (target a table id): tableLink, the property from the document to each row;
  rowClass; rowIri, optional, from the table's columns ("line/{sku|upper}"). Map a table before
  its columns. A table needs both: when no class fits its rows, declare a local term for it (if
  local terms are available) or leave the table and its columns unmapped.
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
    model's tools returned (None: it had no tools), which it may choose like the shortlist's.
    A term under `local_namespace` used without a `putLocalTerm` is declared for the model
    (`_implied_term`: its kind from where it is used), and the draft's own local terms may be
    used again."""
    outputs = {o.path: o for o in outputs_of(draft)}
    changes = list(data.get("changes") or [])
    local = {
        c["localIri"].strip()
        for c in changes
        if c.get("op") == "putLocalTerm" and str(c.get("localIri", "")).strip()
    }
    local.update(str(t.get("iri") or "") for t in (draft.get("semantics") or {}).get("local") or [])
    implied: dict[str, str] = {}  # iri -> kind, local terms used but not declared
    shortlisted = {c.iri: c for cands in shortlists.values() for c in cands}
    shortlisted.update({c.iri: c for c in searched or []})
    semantics = draft.get("semantics") or {}
    existing_prefixes: dict[str, str] = dict(semantics.get("prefixes") or {})
    errors: list[str] = []
    used_namespaces: list[str] = []

    def term(where: str, iri: Any, kind: str) -> str:
        """A term the change may use, as a CURIE when a prefix covers it."""
        value = str(iri or "").strip()
        if not value:
            errors.append(f"{where}: a term is required")
            return ""
        if (
            value not in shortlisted
            and value not in local
            and local_namespace is not None
            and value.startswith(local_namespace)
            and value != local_namespace
            and not _IRI_UNSAFE.search(value)
        ):
            implied.setdefault(value, kind)
            return value
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

    # The value-node defaults a node may leave its terms to: this answer's, else the draft's.
    answer_defaults: dict[str, Any] = next(
        (c for c in changes if c.get("op") == "setDocumentMapping"), {}
    )
    draft_defaults = semantics.get("valueNodes") or {}
    defaults = {
        key: bool(str(answer_defaults.get(flat) or "").strip() or draft_defaults.get(key))
        for key, flat in (("link", "valueLink"), ("value", "valueProperty"),
                          ("unitProperty", "unitProperty"))
    }  # fmt: skip

    def value_node(where: str, c: dict[str, Any], value_type: str) -> dict[str, Any]:
        """A value node's own terms (`node`), checked against the defaults it leaves terms to."""
        if value_type == "list":
            errors.append(
                f"{where}: a list cannot be a value node: map its items as literals, entities "
                "or concepts"
            )
        node: dict[str, Any] = {"class": term(f"{where}.nodeClass", c.get("nodeClass"), "class")}
        picked = shortlisted.get(node["class"])
        if picked is not None and picked.kind != "class":
            errors.append(f"{where}.nodeClass: {node['class']} is a {picked.kind}, not a class")
        value = str(c.get("nodeValue") or "").strip()
        if value:
            node["value"] = term(f"{where}.nodeValue", value, "datatype_property")
        elif not defaults["value"]:
            errors.append(
                f"{where}.nodeValue: a value node needs a value property: give nodeValue or set "
                "valueProperty on setDocumentMapping"
            )
        unit = str(c.get("nodeUnit") or "").strip()
        if unit:
            if (not unit.startswith(QUDT_UNITS) or unit == QUDT_UNITS) and unit not in local:
                errors.append(
                    f"{where}.nodeUnit: a unit is a QUDT unit ({QUDT_UNITS}…), not {unit}"
                )
            elif _IRI_UNSAFE.search(unit):
                errors.append(f"{where}.nodeUnit: {unit} is not a valid IRI")
            elif unit.startswith(QUDT_UNITS) and QUDT_UNITS not in used_namespaces:
                used_namespaces.append(QUDT_UNITS)
            node["unit"] = unit
        unit_property = str(c.get("nodeUnitProperty") or "").strip()
        if unit_property:
            node["unitProperty"] = term(
                f"{where}.nodeUnitProperty", unit_property, "object_property"
            )
        elif unit and not defaults["unitProperty"]:
            errors.append(
                f"{where}.nodeUnit: a unit needs a unit property: give nodeUnitProperty or set "
                "unitProperty on setDocumentMapping"
            )
        return node

    def output_mapping(
        where: str, c: dict[str, Any], scope: list[str], value_type: str
    ) -> dict[str, Any]:
        how = c.get("valueAs") or "literal"
        link_kind = "datatype_property" if how == "literal" else "object_property"
        if how == "node":
            mapping: dict[str, Any] = {}
            if str(c.get("property") or "").strip():
                mapping["property"] = term(f"{where}.property", c.get("property"), link_kind)
            elif not defaults["link"]:
                errors.append(
                    f"{where}.property: a value node needs a link: give its property or set "
                    "valueLink on setDocumentMapping"
                )
            mapping["node"] = value_node(where, c, value_type)
            return mapping
        mapping = {"property": term(f"{where}.property", c.get("property"), link_kind)}
        if how == "entity":
            template = str(c.get("entityIri") or "").strip()
            if not template:
                errors.append(f"{where}.entityIri: an entity needs an IRI template")
            errors.extend(_template_errors(f"{where}.entityIri", template, scope))
            mapping["object"] = {
                "class": term(f"{where}.entityClass", c.get("entityClass"), "class"),
                "iri": template,
            }
        elif how == "concept":
            concepts: dict[str, Any] = {}
            scheme = str(c.get("conceptScheme") or "").strip()
            if scheme:
                concepts["scheme"] = term(f"{where}.conceptScheme", scheme, "concept")
            values = {
                str(v.get("value")): term(
                    f"{where}.conceptValues.{v.get('value')}", v["concept"], "concept"
                )
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
            "confidence": _confidence(c),
        }
        if _has_unit(c):
            out["reason"] = f"{out['reason']} (unit not checked against the library)".strip()
        evidence = [str(e) for e in c.get("evidence") or [] if str(e).strip()]
        if evidence:
            out["evidence"] = evidence
        if isinstance(c.get("remembered"), dict):
            out["remembered"] = c["remembered"]
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
            doc_change: dict[str, Any] = {
                "op": op,
                "document": {
                    "class": term(f"{where}.documentClass", c.get("documentClass"), "class"),
                    "iri": template,
                },
                "ontologies": [{"id": v.id, "version": v.version} for v in inputs.versions],
                "prefixes": {},  # filled below, once every term is known
            }
            value_nodes = {
                key: term(f"{where}.{flat}", c.get(flat), kind)
                for key, flat, kind in (
                    ("link", "valueLink", "object_property"),
                    ("value", "valueProperty", "datatype_property"),
                    ("unitProperty", "unitProperty", "object_property"),
                )
                if str(c.get(flat) or "").strip()
            }
            if value_nodes:
                doc_change["valueNodes"] = value_nodes
            typed.append({**doc_change, **meta(c, None, set())})
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
            row_class = str(c.get("rowClass") or "").strip()
            if not row_class:
                local_hint = (
                    "declare a local term for it"
                    if local_namespace
                    else "(local terms are not available here: no base IRI)"
                )
                errors.append(
                    f"{where}.rowClass: a table needs a row class: choose one of the table's "
                    f"candidates (or a class search_terms found), {local_hint}, or leave the "
                    "table and its columns unmapped"
                )
            mapping: dict[str, Any] = {
                "link": term(f"{where}.tableLink", c.get("tableLink"), "object_property"),
                "class": term(f"{where}.rowClass", row_class, "class") if row_class else "",
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
                mapping = output_mapping(where, c, scope, spec.type)
                pending_columns.append((i, table, column, mapping))
                continue
            chosen = {str(c.get(k)) for k in ("property", "entityClass", "nodeClass")}
            typed.append(
                {
                    "op": op,
                    "field": target,
                    "mapping": output_mapping(where, c, ["value"], spec.type),
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
                    "confidence": _confidence(changes[i]),
                }
            )
        else:
            errors.append(
                f"changes[{i}]: map table {table} first (putTableMapping), then its columns"
            )

    typed.extend(
        {
            "op": "putLocalTerm",
            "term": _implied_term(iri, kind, local_namespace or ""),
            "reason": "Used by this mapping but not declared: check its label and kind.",
            "confidence": "low",
        }
        for iri, kind in implied.items()
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


def _has_unit(c: dict[str, Any]) -> bool:
    return c.get("valueAs") == "node" and bool(str(c.get("nodeUnit") or "").strip())


def _confidence(c: dict[str, Any]) -> str:
    """The change's stated confidence; a value node's unit, never checked against the library
    (units are not indexed), caps it at medium."""
    stated = str(c.get("confidence") or "medium")
    return "medium" if stated == "high" and _has_unit(c) else stated


def _implied_term(iri: str, kind: str, namespace: str) -> dict[str, Any]:
    """The declaration of a local term the model used without one: its label from the IRI's
    local name (`has_batch_entry` and `hasBatchEntry` read `has batch entry`)."""
    name = iri[len(namespace) :].strip("/#")
    words = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", re.sub(r"[_\-/#.]+", " ", name))
    return {"iri": iri, "kind": kind, "label": words.strip().lower() or name}


def _compact_terms(changes: list[dict[str, Any]], prefixes: dict[str, str]) -> None:
    """Every term of the changes as a CURIE where a declared prefix covers it (in place)."""

    def output(m: dict[str, Any]) -> None:
        if "property" in m:
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
        node = m.get("node") or {}
        for key in ("class", "value", "unit", "unitProperty"):
            if key in node:
                node[key] = compact_iri(node[key], prefixes)

    for c in changes:
        if c["op"] == "setDocumentMapping":
            c["document"]["class"] = compact_iri(c["document"]["class"], prefixes)
            if "valueNodes" in c:
                c["valueNodes"] = {k: compact_iri(v, prefixes) for k, v in c["valueNodes"].items()}
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
    defaults = shortlists.get(VALUE_NODES, [])
    if defaults:
        body = "\n".join(_candidate_line(c) for c in defaults)
        blocks.append(
            '<candidates output="value nodes (valueLink, valueProperty, unitProperty)">\n'
            f"{body}\n</candidates>"
        )
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


def stage_shortlists(
    store: OntologyStore,
    versions: list[tuple[str, int]],
    outputs: list[OutputSpec],
    queries: dict[str, str],
    vectors: dict[str, list[float]],
    model_ref: str | None,
) -> dict[str, list[Candidate]]:
    """Each output's candidates before the term budget (`_cap`): properties for everything but
    the document; classes, concepts and schemes for the document, tables, enums and text;
    classes for every other field and column (a value node's class: numeric and date outputs get
    more of them and fewer properties); and the value-node defaults' candidates (`VALUE_NODES`)."""
    shortlists: dict[str, list[Candidate]] = {}
    for o in outputs:
        vector = vectors.get(o.path)
        found: list[Candidate] = []
        node_like = o.kind in ("field", "column") and o.type in NODE_TYPES
        if o.kind != "document":
            k = NODE_PROPERTY_CANDIDATES if node_like else PROPERTY_CANDIDATES
            found += shortlist(
                store, versions, queries[o.path], PROPERTY_KINDS, vector=vector,
                model_ref=model_ref, k=k,
            )[0]  # fmt: skip
        if o.kind in ("document", "table") or o.enum or o.type in ("text", "enum"):
            found += shortlist(
                store, versions, queries[o.path], CLASS_KINDS, vector=vector,
                model_ref=model_ref, k=CLASS_CANDIDATES,
            )[0]  # fmt: skip
        elif o.kind in ("field", "column"):
            k = NODE_CLASS_CANDIDATES if node_like else CLASS_CANDIDATES
            found += shortlist(
                store, versions, queries[o.path], ["class"], vector=vector,
                model_ref=model_ref, k=k,
            )[0]  # fmt: skip
        if found:
            shortlists[o.path] = found
    defaults: list[Candidate] = []
    for path, query, kinds in VALUE_NODE_QUERIES:
        for c in shortlist(
            store, versions, queries.get(path, query), kinds, vector=vectors.get(path),
            model_ref=model_ref, k=NODE_PROPERTY_CANDIDATES,
        )[0]:  # fmt: skip
            if all(c.iri != d.iri for d in defaults):
                defaults.append(c)
    if defaults:
        shortlists[VALUE_NODES] = defaults
    return shortlists


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
    queries.update({path: query for path, query, _kinds in VALUE_NODE_QUERIES})
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
    remembered_ = remember(
        deps, versions, outputs, draft,
        external=deps.models.location(provider.name) == "external", embedder=embedder,
        notes=notes,
    )  # fmt: skip
    if embedder is not None and (
        remembered_.outputs_embedded_externally or remembered_.embedded_externally
    ):
        queue.event(
            job.id,
            "info",
            "external model call",
            {
                "stage": "mapping",
                "purpose": "embedding remembered mappings",
                "model": embedder.model_ref,
                "outputs": remembered_.outputs_embedded_externally,
                "entries": remembered_.embedded_externally,
            },
        )
    shortlists = _cap(
        _with_candidates(
            stage_shortlists(
                store, versions, outputs, queries, vectors,
                embedder.model_ref if embedder else None,
            ),
            remembered_,
        )
    )  # fmt: skip

    context = mapping_context(
        brief_text=drafting._brief_text(params.brief),
        inputs=inputs,
        draft=draft,
        observed=observed,
        shortlists=shortlists,
    ) + remembered_context(remembered_, outputs)
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
    context += (
        f"\n\n<local_terms>\nDeclare local terms under {local_namespace}\n</local_terms>"
        if local_namespace
        else "\n\n<local_terms>\nLocal terms are not available: this deployment has no base IRI "
        "(Administration > Linked data). When no term fits an output, leave it unmapped; when no "
        "class fits a table's rows, leave the table and its columns unmapped.\n</local_terms>"
    )

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
            with_remembered(data, remembered_), draft, inputs, shortlists,
            local_namespace=local_namespace, searched=chosen(),
        )[1]  # fmt: skip

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
        checkpoint=lambda: check_cancelled(job, queue),
    )
    body, _ = convert_mapping(
        with_remembered(result.data, remembered_),
        draft,
        inputs,
        shortlists,
        local_namespace=local_namespace,
        searched=chosen(),
    )
    if remembered_.changes:
        n = len(remembered_.changes)
        notes.append(f"{n} output{'' if n == 1 else 's'} mapped from remembered mappings.")
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


# --- mapping memory (docs/design/mapping-memory.md) ----------------------------------------------


@dataclass
class Remembered:
    """What the mapping memory gives a run: the answers pre-selected per output (as flat changes
    carrying their provenance), hints for the outputs it only recalls, the candidates it adds to
    each output's short list and the terms rejected for it."""

    changes: dict[str, dict[str, Any]] = field(default_factory=dict)
    defaults: dict[str, Any] = field(default_factory=dict)
    hints: dict[str, str] = field(default_factory=dict)
    candidates: dict[str, list[Candidate]] = field(default_factory=dict)
    rejected: dict[str, set[str]] = field(default_factory=dict)
    #: Signatures embedded with an external embedding model (logged as an external call): the
    #: run's outputs (its own recipe's wording) and remembered entries (wording that may leave).
    outputs_embedded_externally: int = 0
    embedded_externally: int = 0

    @property
    def empty(self) -> bool:
        return not (self.changes or self.defaults or self.hints or self.candidates or self.rejected)


def _looks(outputs: list[OutputSpec], draft: dict[str, Any]) -> list[OutputLook]:
    tables = {
        t["id"]: t.get("name") or t["id"] for t in (draft.get("outputs") or {}).get("tables") or []
    }
    looks = []
    for o in outputs:
        table = tables.get(o.path.split(".", 1)[0]) if o.kind == "column" else None
        looks.append(OutputLook(o.path, o.kind, o.name, o.description, o.type, table))
    return looks


def _main_terms(answer: dict[str, Any]) -> set[str]:
    """The term that makes an answer what it is (removed from the options when rejected)."""
    form = answer.get("form")
    if form in ("node", "document", "table"):
        return {answer["class"]}
    return {answer["property"]} if answer.get("property") else set()


def remember(
    deps: PipelineDeps,
    versions: list[tuple[str, int]],
    outputs: list[OutputSpec],
    draft: dict[str, Any],
    *,
    external: bool,
    embedder: _Embedder | None,
    notes: list[str],
) -> Remembered:
    """Recall the mapping memory for a run's outputs and choose what to pre-select."""
    memory, store = deps.mapping_memory, deps.ontologies
    if memory is None or store is None:
        return Remembered()
    ontology_ids = sorted({i for i, _ in versions})
    entries = memory.entries(ontology_ids)
    if not entries:
        return Remembered()
    terms: dict[str, Term | None] = {}

    def term_of(iri: str) -> Term | None:
        if iri not in terms:
            terms[iri] = store.term(versions, iri)
        return terms[iri]

    def usable(e: MemoryEntry) -> bool:
        found = [term_of(t) for t in answer_terms(e.answer)]
        return all(t is not None and not t.deprecated for t in found)

    looks = _looks(outputs, draft)
    output_vectors: dict[str, list[float]] = {}
    entry_vectors: dict[str, list[float]] = {}
    embedded = outputs_embedded = 0
    if embedder is not None:
        embedder_external = deps.models.location(embedder.provider.name) == "external"
        try:
            texts = [signature_text(o.name, o.description, o.table) for o in looks]
            output_vectors = dict(
                zip(
                    [o.path for o in looks],
                    embedder.provider.embed(embedder.model_id, texts),
                    strict=True,
                )
            )
            outputs_embedded = len(texts) if embedder_external else 0
            entry_vectors = memory.vectors(embedder.model_ref, [e.id for e in entries])
            # An external embedding model sees only wording that may leave the deployment: a
            # vote's from a project allowing external models (`MemoryEntry.wording`).
            wordings = {
                e.id: w
                for e in entries
                if e.id not in entry_vectors and (w := e.wording(embedder_external)) is not None
            }
            missing = [e for e in entries if e.id in wordings]
            if missing:
                made = embedder.provider.embed(
                    embedder.model_id, [signature_text(*wordings[e.id]) for e in missing]
                )
                fresh = {e.id: list(v) for e, v in zip(missing, made, strict=True)}
                memory.store_vectors(embedder.model_ref, fresh)
                entry_vectors.update(fresh)
                embedded = len(fresh) if embedder_external else 0
        except Exception as exc:  # an outage costs the semantic half of the recall, never the run
            notes.append(f"Remembered mappings were recalled by name only: {exc}.")
            output_vectors, entry_vectors = {}, {}
    recalled = recall(
        entries, looks, usable=usable, external=external,
        output_vectors=output_vectors, entry_vectors=entry_vectors,
    )  # fmt: skip
    out = Remembered(outputs_embedded_externally=outputs_embedded, embedded_externally=embedded)
    for path, found in recalled.items():
        if found.rejected:
            out.rejected[path] = set().union(*(_main_terms(e.answer) for e in found.rejected))
        cands: list[Candidate] = []
        for h in [*found.exact, *found.fuzzy]:
            for iri in answer_terms(h.entry.answer):
                t = term_of(iri)
                if t is not None and all(c.iri != iri for c in cands):
                    cands.append(
                        Candidate(
                            t.iri, t.kind, t.label, t.definition, t.parents, t.domain, t.range,
                            1.0, frozenset({"remembered"}),
                        )
                    )  # fmt: skip
        if cands:
            out.candidates[path] = cands
        choice = preselect(found)
        change = (
            remembered_change(parse_answer(choice.entry.answer), path)
            if choice is not None
            else None
        )
        if choice is not None and change is not None:
            recipes = len({v.template_id for v in choice.entry.votes})
            change.update(
                confidence=choice.confidence,
                reason=(
                    f"Remembered: accepted in {recipes} recipe{'' if recipes == 1 else 's'}"
                    + (" and confirmed" if choice.entry.status == "confirmed" else "")
                ),
                remembered={
                    "entryId": choice.entry.id,
                    "votes": recipes,
                    "status": "confirmed" if choice.entry.status == "confirmed" else "learned",
                },
            )
            out.changes[path] = change
        else:
            hint = hint_line(found, external=external)
            if hint:
                out.hints[path] = hint
    # The value-node defaults remembered for the same pinned ontologies.
    defaults = [
        e for e in entries
        if e.signature_key == defaults_key(ontology_ids) and e.status != "rejected" and usable(e)
        and (not external or e.shareable)
    ]  # fmt: skip
    best = preselect(Recall(exact=[Hit(e, 1.0, True) for e in defaults]))
    if best is not None:
        keys = remembered_change(parse_answer(best.entry.answer), VALUE_NODE_DEFAULTS_PATH)
        out.defaults = {k: v for k, v in (keys or {}).items() if v}
    return out


def remembered_context(remembered_: Remembered, outputs: list[OutputSpec]) -> str:
    """The prompt blocks for the memory: outputs already mapped, and what was accepted before."""
    if remembered_.empty:
        return ""
    blocks = []
    order = [o.path for o in outputs]
    decided = [p for p in order if p in remembered_.changes]
    if decided:
        lines = [
            f"- {p or 'document'}: {remembered_.changes[p]['reason'].lower()}" for p in decided
        ]
        blocks.append(
            "<already_mapped>\nThese outputs are mapped from remembered mappings designers "
            "accepted; leave them out of your answer (a table here is mapped: map its columns "
            "as usual).\n" + "\n".join(lines) + "\n</already_mapped>"
        )
    hinted = [p for p in order if p in remembered_.hints]
    if hinted:
        lines = [f"- {p or 'document'}: {remembered_.hints[p]}" for p in hinted]
        blocks.append(
            "<accepted_before>\nWhat designers accepted for outputs like these in other recipes "
            "(a hint, not a rule):\n" + "\n".join(lines) + "\n</accepted_before>"
        )
    return "\n\n" + "\n\n".join(blocks) if blocks else ""


def with_remembered(data: dict[str, Any], remembered_: Remembered) -> dict[str, Any]:
    """The model's answer with the pre-selected changes: the model's own changes for those
    outputs dropped, the remembered ones appended (so the model's change indexes stay theirs),
    the document's remembered class and the remembered value-node defaults filled in."""
    if remembered_.empty:
        return data
    changes = []
    document = remembered_.changes.get("")
    for c in data.get("changes") or []:
        target = str(c.get("target") or "")
        if c.get("op") == "setDocumentMapping":
            merged = dict(c)
            if document is not None:
                merged.update(
                    documentClass=document["documentClass"],
                    documentIri=document["documentIri"],
                    remembered=document["remembered"],
                )
            for k, v in remembered_.defaults.items():
                if not str(merged.get(k) or "").strip():
                    merged[k] = v
            changes.append(merged)
            continue
        if c.get("op") in ("putFieldMapping", "putTableMapping") and target in remembered_.changes:
            continue
        changes.append(c)
    has_document = any(c.get("op") == "setDocumentMapping" for c in changes)
    for path, c in remembered_.changes.items():
        if path == "":
            if not has_document:
                changes.append({**c, **remembered_.defaults})
            continue
        changes.append(c)
    return {**data, "changes": changes}


def _with_candidates(
    shortlists: dict[str, list[Candidate]], remembered_: Remembered
) -> dict[str, list[Candidate]]:
    """The short lists with the remembered candidates first and the rejected terms removed."""
    if remembered_.empty:
        return shortlists
    out = {}
    for path in [*shortlists, *(p for p in remembered_.candidates if p not in shortlists)]:
        rejected = remembered_.rejected.get(path, set())
        mine = remembered_.candidates.get(path, [])
        rest = [c for c in shortlists.get(path, []) if all(c.iri != m.iri for m in mine)]
        kept = [c for c in [*mine, *rest] if c.iri not in rejected]
        if kept:
            out[path] = kept
    return out
