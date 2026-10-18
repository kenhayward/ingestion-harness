"""A per-output ontology matcher (spike, docs/design/mapping-automation.md): research code, not
used by the Workbench. Instead of one model answer mapping everything at once, it

1. retrieves candidates per output exactly as the mapping stage does (`retrieval.shortlist`);
2. re-ranks them with the structure the ontology store holds: an exact label or synonym, the
   range against the output's type, a domain that fits the class the output hangs off, generic
   properties down, deprecated terms out;
3. asks the model one narrow question per batch of outputs: pick one of a few options or none
   (an enum per output), the document class first, then each table's link and row class, then the
   fields and each table's columns;
4. derives how a value is published from the chosen property (an object property publishes an
   entity of its range class), and a confidence from agreeing signals instead of the model's word.

`mapping_eval` compares it with the mapping stage on a gold mapping."""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Literal

from .mapping_stage import (
    CLASS_KINDS,
    NODE_TYPES,
    PROPERTY_KINDS,
    VALUE_NODE_QUERIES,
    VALUE_NODES,
    MappingInputs,
    OutputSpec,
    outputs_of,
    query_text,
)
from .ontology import OntologyStore, Term
from .retrieval import fuse, shortlist

Confidence = Literal["high", "medium", "low"]

#: Candidates retrieved per output before re-ranking, and options the model chooses among.
RETRIEVE = 20
OPTIONS = 6
#: Outputs per model question.
BATCH = 8
#: A top option this far ahead of the next is a confident pick (re-rank score units).
MARGIN = 0.3
#: With value-node defaults, an output's options: this many classes and properties.
NODE_CLASSES = 4
NODE_PROPERTIES = 3
#: What each value-node default is, for the model (the pseudo-outputs' names).
VALUE_NODE_ROLES = {
    f"{VALUE_NODES}.link": "value node link: the object property from a document or row to a "
    "node that holds one value",
    f"{VALUE_NODES}.value": "value node value: the datatype property holding the value on the node",
    f"{VALUE_NODES}.unitProperty": "value node unit: the property from the node to its unit",
}
VALUE_NODES_NOTE = (
    "\n\nThese are the defaults every value node uses: a value node is a node of a class (a water "
    "content, an assay result, a count) that holds one value. Choose the ontology's generic "
    "relations here, or none when it has no such pattern."
)
NODE_OPTIONS_NOTE = (
    "\n\nA [class] option publishes the value on a node of that class (through the value-node "
    "link and value properties); a property option publishes it with that property. When the "
    "ontology's properties are generic relations and its classes carry the meaning, prefer a class."
)

#: Properties that fit almost anything: down-ranked unless the output is a label or note.
GENERIC = frozenset(
    {
        "http://www.w3.org/2000/01/rdf-schema#label",
        "http://www.w3.org/2000/01/rdf-schema#comment",
        "http://www.w3.org/2004/02/skos/core#prefLabel",
        "http://www.w3.org/2004/02/skos/core#altLabel",
        "http://www.w3.org/2004/02/skos/core#note",
        "http://www.w3.org/2004/02/skos/core#definition",
        "http://purl.org/dc/terms/title",
        "http://purl.org/dc/terms/description",
        "https://schema.org/name",
        "https://schema.org/description",
        "http://schema.org/name",
        "http://schema.org/description",
    }
)
XSD = "http://www.w3.org/2001/XMLSchema#"
#: The XSD ranges each output type fits (a missing range fits anything).
TYPE_RANGES: dict[str, frozenset[str]] = {
    "integer": frozenset(
        {"integer", "int", "long", "short", "decimal", "nonNegativeInteger", "positiveInteger"}
    ),
    "decimal": frozenset({"decimal", "double", "float"}),
    "date": frozenset({"date", "dateTime", "dateTimeStamp"}),
    "boolean": frozenset({"boolean"}),
}


@dataclass(frozen=True)
class Ranked:
    """A candidate term after re-ranking, with what moved it (shown to the model and reports)."""

    iri: str
    kind: str
    label: str
    alt_labels: tuple[str, ...]
    definition: str
    domain: tuple[str, ...]
    range: tuple[str, ...]
    score: float
    exact: bool = False
    notes: tuple[str, ...] = ()
    parents: tuple[str, ...] = ()


@dataclass(frozen=True)
class Pick:
    """One output's proposed mapping. `term`: the property (the class for the document), None
    when left unmapped. `candidates`: the ranked candidates it came from (recall@k)."""

    term: str | None
    value_as: str = "literal"
    confidence: Confidence = "low"
    candidates: tuple[str, ...] = ()
    row_class: str | None = None
    entity_class: str | None = None


@dataclass(frozen=True)
class ChoiceRequest:
    """One model question: for each output (a path; a table's row class is `table#class`), the
    option IRIs it may choose, or "none". `prompt` describes the outputs and options."""

    what: str
    items: list[tuple[str, list[str]]]
    prompt: str = ""


#: Answers a ChoiceRequest: path -> chosen IRI or "none".
Chooser = Callable[[ChoiceRequest], dict[str, str]]


@dataclass(frozen=True)
class Embedding:
    """The embedding model retrieval uses: its ref, and texts -> vectors."""

    model_ref: str
    vectors: Callable[[list[str]], list[list[float]]]


def _words(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", text.lower()))


def _names(o: OutputSpec) -> set[str]:
    leaf = o.path.split(".")[-1]
    return {n for n in {_words(o.name), _words(leaf.replace("_", " "))} if n}


@dataclass
class _Terms:
    """Term lookups, cached for one run."""

    store: OntologyStore
    versions: list[tuple[str, int]]
    cache: dict[str, Term | None] = field(default_factory=dict)

    def get(self, iri: str) -> Term | None:
        if iri not in self.cache:
            self.cache[iri] = self.store.term(self.versions, iri)
        return self.cache[iri]

    def ancestors(self, classes: Sequence[str], depth: int = 6) -> set[str]:
        seen: set[str] = set()
        todo = list(classes)
        while todo and depth >= 0:
            nxt: list[str] = []
            for c in todo:
                if c in seen:
                    continue
                seen.add(c)
                term = self.get(c)
                nxt += term.parents if term else []
            todo, depth = nxt, depth - 1
        return seen


#: Classes whose instances are data (OBO's information content entity, data item): what a value
#: node is. A value node's class options under them go up.
DATA_ROOTS = frozenset(
    {
        "http://purl.obolibrary.org/obo/IAO_0000030",
        "http://purl.obolibrary.org/obo/IAO_0000027",
    }
)
#: BFO branches that are never data: processes, qualities, roles and other realizables, material.
#: A value node's class options under them go down (an assay is the process, not its result).
NOT_DATA_ROOTS: dict[str, str] = {
    "http://purl.obolibrary.org/obo/BFO_0000003": "a process",
    "http://purl.obolibrary.org/obo/BFO_0000015": "a process",
    "http://purl.obolibrary.org/obo/BFO_0000019": "a quality",
    "http://purl.obolibrary.org/obo/BFO_0000020": "a quality",
    "http://purl.obolibrary.org/obo/BFO_0000017": "a role",
    "http://purl.obolibrary.org/obo/BFO_0000023": "a role",
    "http://purl.obolibrary.org/obo/BFO_0000040": "a material",
}
#: How far up a class's parents the data and BFO roots are looked for.
ROOT_DEPTH = 12
#: Identifier roots (IAO identifier, centrally registered identifier, symbol): an identifier
#: names a thing other documents name too, so it is published as an entity, not a value node.
#: A class under one labelled "identifier" (AFO's) counts as well.
IDENTIFIER_ROOTS = frozenset(
    {
        "http://purl.obolibrary.org/obo/IAO_0020000",
        "http://purl.obolibrary.org/obo/IAO_0000578",
        "http://purl.obolibrary.org/obo/IAO_0000028",
    }
)
#: A boolean output whose id is a sibling's stem plus one of these qualifies that sibling's
#: value (a "<0.05" below the reporting threshold): left unmapped until value nodes carry
#: qualifiers (docs/design/value-node-mapping.md, open question 2).
QUALIFIER_SUFFIXES = (
    "_below_threshold",
    "_below_reporting_threshold",
    "_below_lod",
    "_below_loq",
    "_less_than",
    "_qualifier",
    "_censored",
    "_flag",
)


def is_identifier(terms: _Terms, iri: str) -> bool:
    """Whether a class is an identifier: under an IAO identifier root or a class labelled
    "identifier"."""
    roots = terms.ancestors([iri], depth=ROOT_DEPTH)
    if roots & IDENTIFIER_ROOTS:
        return True
    return any((t := terms.get(a)) is not None and _words(t.label) == "identifier" for a in roots)


def qualifier_of(o: OutputSpec, siblings: Sequence[OutputSpec]) -> str | None:
    """The sibling output a boolean flag qualifies, or None: `<stem><suffix>` where a non-boolean
    sibling's id starts with `<stem>` (`t_amc_below_threshold` qualifies `t_amc_count`)."""
    if o.type != "boolean":
        return None
    leaf = o.path.rsplit(".", 1)[-1]
    stem = next((leaf[: -len(s)] for s in QUALIFIER_SUFFIXES if leaf.endswith(s)), None)
    if not stem:
        return None
    for s in siblings:
        other = s.path.rsplit(".", 1)[-1]
        if s.path != o.path and s.type != "boolean" and other.startswith(stem):
            return s.path
    return None


def rerank(
    store: OntologyStore | _Terms,
    versions: list[tuple[str, int]],
    output: OutputSpec,
    iris: Sequence[str],
    *,
    owner: Sequence[str],
    node: bool = False,
    names: set[str] | None = None,
) -> list[Ranked]:
    """Re-rank retrieved candidates (best first) for `output`, which hangs off `owner` (the
    document's or row's class, empty when not chosen yet). Deprecated and unknown terms go.
    `node`: the classes are options for a value node's class, so data classes go up and
    processes, qualities and roles (also classes labelled "… role") go down; an object property
    whose range is a data class goes up too (a value-node link). `names`: the phrases an exact
    label must match (default: the output's name and id)."""
    terms = store if isinstance(store, _Terms) else _Terms(store, versions)
    owners = terms.ancestors(owner) if owner else set()
    names = names if names is not None else _names(output)
    out: list[Ranked] = []
    n = max(1, len(iris))
    for i, iri in enumerate(dict.fromkeys(iris)):
        term = terms.get(iri)
        if term is None or term.deprecated:
            continue
        score = 1.0 - 0.5 * i / n  # retrieval order: 1.0 .. 0.5
        notes: list[str] = []
        labels = {_words(term.label), *(_words(a) for a in term.alt_labels)}
        exact = bool(names & labels)
        if exact:
            score += 0.6
            notes.append("label or synonym matches")
        kind = str(term.kind)
        if output.kind in ("field", "column") and output.type in TYPE_RANGES:
            fits = TYPE_RANGES[output.type]
            xsd = [r.removeprefix(XSD) for r in term.range if r.startswith(XSD)]
            if kind == "object_property":
                score -= 0.8
                notes.append(f"object property for a {output.type}")
            elif xsd and not any(r in fits for r in xsd):
                score -= 0.5
                notes.append(f"range xsd:{xsd[0]} for a {output.type}")
            elif xsd:
                score += 0.2
                notes.append("range fits")
        if owners and term.domain and owners & set(term.domain):
            score += 0.2
            notes.append("domain fits")
        if iri in GENERIC and not (
            names & {"label", "name", "title", "description", "note", "comment"}
        ):
            score -= 0.4
            notes.append("generic property")
        if node and kind == "class":
            roots = terms.ancestors([iri], depth=ROOT_DEPTH)
            not_data = next((NOT_DATA_ROOTS[r] for r in NOT_DATA_ROOTS if r in roots), None)
            if not_data or term.label.strip().lower().endswith(" role"):
                # More than an exact label is worth: "Assay" names the process, not its result.
                score -= 0.8
                notes.append(f"{not_data or 'a role'}, not data")
            elif roots & DATA_ROOTS:
                score += 0.3
                notes.append("a data class")
        if node and kind == "object_property":
            data_range = any(
                terms.ancestors([r], depth=ROOT_DEPTH) & DATA_ROOTS for r in term.range
            )
            if data_range:
                score += 0.3
                notes.append("range is data")
        out.append(
            Ranked(
                iri=iri,
                kind=kind,
                label=term.label,
                alt_labels=tuple(term.alt_labels),
                definition=term.definition,
                domain=tuple(term.domain),
                range=tuple(term.range),
                score=round(score, 4),
                exact=exact,
                notes=tuple(notes),
                parents=tuple(term.parents),
            )
        )
    return sorted(out, key=lambda r: -r.score)


#: Unit text in an output's name or description -> the quantity its value is, for class
#: retrieval ("% w/w" is a mass fraction). Matched lower case, first match wins per entry.
UNIT_QUANTITIES: list[tuple[str, str]] = [
    ("% w/w", "mass fraction"),
    ("%w/w", "mass fraction"),
    ("% v/v", "volume fraction"),
    ("%v/v", "volume fraction"),
    ("cfu", "count"),
    ("%", "fraction percentage"),
]
_PARENS = re.compile(r"\s*\([^)]*\)")


def class_queries(o: OutputSpec, observed: Sequence[Any]) -> list[str]:
    """The retrieval queries for an output's value-node class, best first: the full output query,
    its name without unit text in parentheses, that name with "result", and the quantity its unit
    names (`UNIT_QUANTITIES`). A class label rarely repeats a column's unit ("Assay (%)" is an
    assay result), so the full query alone misses it."""
    full = query_text(o, list(observed))
    bare = _PARENS.sub("", o.name).strip() or o.name
    text = f"{o.name} {o.description}".lower()
    queries = [full, bare, f"{bare} result"]
    for unit, quantity in UNIT_QUANTITIES:
        if unit in text:
            queries.append(quantity)
            break
    return list(dict.fromkeys(q for q in queries if q.strip()))


def choice_schema(request: ChoiceRequest) -> dict[str, Any]:
    """One enum per output: its options' IRIs plus "none" (structured output keeps the model
    inside the options; anything else counts as none)."""
    return {
        "type": "object",
        "properties": {
            path: {"type": "string", "enum": [*options, "none"]} for path, options in request.items
        },
        "required": [path for path, _ in request.items],
        "additionalProperties": False,
    }


def _option_line(r: Ranked) -> str:
    extra = []
    if r.parents:
        what = {"class": "subclass", "concept": "narrower than"}.get(r.kind, "subproperty")
        extra.append(f"{what} of " + ", ".join(r.parents[:3]))
    if r.alt_labels:
        extra.append("also: " + ", ".join(r.alt_labels[:4]))
    if r.domain:
        extra.append("domain " + ", ".join(r.domain[:3]))
    if r.range:
        extra.append("range " + ", ".join(r.range[:3]))
    definition = f" — {r.definition.strip()[:200]}" if r.definition.strip() else ""
    tail = f" ({'; '.join(extra)})" if extra else ""
    return f"  - {r.iri} [{r.kind}] {r.label}{definition}{tail}"


def choice_prompt(what: str, entries: Sequence[tuple[OutputSpec, list[Ranked], list[str]]]) -> str:
    """Describe each output (name, type, description, seen values) and its options."""
    lines = [
        f"Choose the ontology {what} for each output below, from its options only, or none when "
        "no option means the output. Prefer the most specific term that means exactly the output: "
        "when a class and its parent both fit, a subclass beats its parent."
    ]
    for o, options, seen in entries:
        head = "the whole document" if o.kind == "document" else o.path
        desc = f": {o.description}" if o.description else ""
        lines.append(f"\n{head} ({o.name}, {o.type}){desc}")
        if o.enum:
            lines.append(f"  enum: {', '.join(o.enum)}")
        if seen:
            lines.append(f"  seen: {', '.join(seen[:10])}")
        lines.append("  options:")
        lines += [_option_line(r) for r in options]
    return "\n".join(lines)


def _confidence(term: str | None, options: list[Ranked]) -> Confidence:
    if term is None or not options:
        return "low"
    top = options[0]
    margin = top.score - options[1].score if len(options) > 1 else MARGIN
    if term == top.iri and (top.exact or margin >= MARGIN):
        return "high"
    return "medium" if term in [o.iri for o in options[:3]] else "low"


def _specific(term: str | None, options: list[Ranked], terms: _Terms) -> tuple[str | None, bool]:
    """The "too general" error: the model picked an ancestor of the top option, an exact label
    match. Take the specific class instead; True when it was replaced."""
    if term is None or not options or not options[0].exact or term == options[0].iri:
        return term, False
    if term in terms.ancestors([options[0].iri]) - {options[0].iri}:
        return options[0].iri, True
    return term, False


#: Words of an output's name too common to tell one class from another.
_NAME_STOP = frozenset({"the", "and", "for", "with", "each", "any", "all", "value", "values"})


def _name_words(o: OutputSpec) -> set[str]:
    """The content words of an output's name, without unit text in parentheses."""
    return {
        w for w in _words(_PARENS.sub("", o.name)).split() if len(w) > 2 and w not in _NAME_STOP
    }


def name_fits(label: str, o: OutputSpec) -> bool:
    """Whether a class label shares a content word with the output's name (lexical agreement:
    *absolute water content* for "Water Content by KF", not *mass fraction*)."""
    return bool(set(_words(label).split()) & _name_words(o))


def _label(terms: _Terms, iri: str | None) -> str:
    term = terms.get(iri) if iri else None
    return term.label if term else ""


def _narrower(
    term: str | None, retrieved: list[Ranked], o: OutputSpec, terms: _Terms
) -> str | None:
    """The "too general" error for a value node's class: the model picked a class while one of
    its subclasses, retrieved but not among the options shown, adds to the picked label only
    words of the output's name (*water mass fraction* for "Water Content" over *mass
    fraction*; never *supplier lot number* for "Batch Number" over *batch identifier*, which adds
    "supplier" and "lot"). That subclass (the best ranked), else None."""
    if term is None:
        return None
    picked_words = set(_words(_label(terms, term)).split())
    name_words = _name_words(o)
    for r in retrieved:
        if r.iri == term or r.kind != "class":
            continue
        added = set(_words(r.label).split()) - picked_words
        if not added or not added <= name_words:
            continue
        if term in terms.ancestors([r.iri], depth=ROOT_DEPTH) - {r.iri}:
            return r.iri
    return None


def _answer(chosen: dict[str, str], path: str, options: list[Ranked]) -> str | None:
    value = chosen.get(path, "none")
    return value if value in {o.iri for o in options} else None


def propose(
    draft: dict[str, Any],
    inputs: MappingInputs,
    store: OntologyStore,
    versions: list[tuple[str, int]],
    *,
    choose: Chooser,
    embed: Embedding | None,
    retrieve: int = RETRIEVE,
    options: int = OPTIONS,
    confirm: bool = False,
) -> dict[str, Pick]:
    """Map every output of `draft` (path -> Pick; a table's pick holds its link and row class).
    `confirm`: ask every field and column question a second time with its options reversed; a
    pick the second answer repeats goes up a confidence tier, one it changes is low (agreement
    under a perturbation, a better signal than the model's own word; twice the model calls)."""
    terms = _Terms(store, versions)
    outputs = outputs_of(draft)
    seen = {p: [v.value for v in vs] for p, vs in inputs.observed.items()}
    queries = {o.path: query_text(o, inputs.observed.get(o.path, [])) for o in outputs}
    vectors: dict[str, list[float]] = {}
    if embed is not None and store.has_embeddings(versions, embed.model_ref):
        paths = list(queries)
        vectors = dict(zip(paths, embed.vectors([queries[p] for p in paths]), strict=True))
    model_ref = embed.model_ref if embed is not None else None

    def candidates(o: OutputSpec, kinds: Sequence[str]) -> list[str]:
        found, _ = shortlist(
            store, versions, queries[o.path], kinds, vector=vectors.get(o.path),
            model_ref=model_ref, k=retrieve,
        )  # fmt: skip
        return [c.iri for c in found]

    def node_classes(o: OutputSpec) -> list[str]:
        """A value node's class candidates: every `class_queries` query (the full one with its
        embedding, the others lexical), fused by reciprocal rank."""
        rankings = [candidates(o, ["class"])]
        for query in class_queries(o, inputs.observed.get(o.path, []))[1:]:
            found, _ = shortlist(
                store, versions, query, ["class"], vector=None, model_ref=None, k=retrieve
            )  # fmt: skip
            rankings.append([c.iri for c in found])
        return [iri for iri, _score in fuse(rankings)]

    picks: dict[str, Pick] = {}

    def ask(
        what: str,
        batch: list[tuple[str, OutputSpec, list[Ranked]]],
        note: str = "",
        limit: int | None = None,
    ) -> dict[str, str]:
        n = limit or options
        request = ChoiceRequest(
            what=what,
            items=[(path, [r.iri for r in ranked[:n]]) for path, _, ranked in batch],
            prompt=choice_prompt(
                what, [(o, ranked[:n], seen.get(o.path, [])) for _, o, ranked in batch]
            )
            + note,
        )
        return choose(request)

    # 1. The document's class.
    document = next(o for o in outputs if o.kind == "document")
    doc_ranked = rerank(terms, versions, document, candidates(document, ["class"]), owner=[])
    doc_class = _answer(ask("class", [("", document, doc_ranked)]), "", doc_ranked[:options])
    doc_class, replaced = _specific(doc_class, doc_ranked[:options], terms)
    picks[""] = Pick(
        doc_class,
        "",
        "medium" if replaced else _confidence(doc_class, doc_ranked[:options]),
        tuple(r.iri for r in doc_ranked),
    )
    doc_owner = [doc_class] if doc_class else []

    # 1b. The value-node defaults: the link to a node, the property holding its value, its unit.
    defaults: dict[str, str | None] = {}
    asked: list[tuple[str, OutputSpec, list[Ranked]]] = []
    for path, query, kinds in VALUE_NODE_QUERIES:
        spec = OutputSpec(path, "valueNodes", VALUE_NODE_ROLES[path], "", "property")
        found, _ = shortlist(
            store, versions, query, kinds, vector=None, model_ref=None, k=retrieve
        )  # fmt: skip
        # A label equal to one of the query's own phrases ("has data output") is an exact match.
        phrases = {_words(p) for p in query.split(". ") if _words(p)}
        ranked = rerank(
            terms, versions, spec, [c.iri for c in found], owner=[], node=True, names=phrases
        )
        if ranked:
            asked.append((path, spec, ranked))
    if asked:
        chosen = ask("value-node property", asked, VALUE_NODES_NOTE)
        for path, _spec, ranked in asked:
            defaults[path] = _answer(chosen, path, ranked[:options])
    # Its own name: a table's link below must never become the value nodes' link.
    node_link = defaults.get(f"{VALUE_NODES}.link")
    node_ready = node_link is not None and defaults.get(f"{VALUE_NODES}.value") is not None
    # The defaults are what a node uses: offered beside its classes they would only compete.
    default_terms = {iri for iri in defaults.values() if iri is not None}

    # 2. Each table's link from the document and its row class.
    row_class: dict[str, str | None] = {}
    for table in (o for o in outputs if o.kind == "table"):
        links = rerank(terms, versions, table, candidates(table, PROPERTY_KINDS), owner=doc_owner)
        classes = rerank(terms, versions, table, candidates(table, ["class"]), owner=[])
        chosen = ask(
            "link property and row class",
            [(table.path, table, links), (f"{table.path}#class", table, classes)],
        )
        link = _answer(chosen, table.path, links[:options])
        rows, _ = _specific(
            _answer(chosen, f"{table.path}#class", classes[:options]), classes[:options], terms
        )
        row_class[table.path] = rows
        picks[table.path] = Pick(
            link,
            "entity",
            _confidence(link, links[:options]),
            tuple(r.iri for r in links),
            row_class=rows,
        )

    # 3. Fields (they hang off the document), then each table's columns (off its rows). With
    # value-node defaults, an output's options are classes (a node of that class holds the value)
    # and properties together; numeric and date outputs list the classes first.
    # Every class retrieved for an output, re-ranked: only the first few are options, the rest
    # may hold a subclass more specific than the pick (`_narrower`).
    retrieved_classes: dict[str, list[Ranked]] = {}

    def options_of(o: OutputSpec, owner: list[str]) -> list[Ranked]:
        props = rerank(terms, versions, o, candidates(o, PROPERTY_KINDS), owner=owner)
        if not node_ready or o.enum or o.type == "list":
            return props
        props = [p for p in props if p.iri not in default_terms]
        # The class queries' phrases ("Assay result") are names an exact label may match too.
        names = _names(o) | {_words(q) for q in class_queries(o, [])[1:]}
        found = node_classes(o)
        classes = rerank(terms, versions, o, found[:retrieve], owner=[], node=True, names=names)
        # Every class any query found, for `_narrower`: a subclass may rank low in all but one.
        retrieved_classes[o.path] = rerank(terms, versions, o, found, owner=[], node=True)
        mixed = (classes[:NODE_CLASSES], props[:NODE_PROPERTIES])
        return [*mixed[0], *mixed[1]] if o.type in NODE_TYPES else [*mixed[1], *mixed[0]]

    def map_outputs(group: list[OutputSpec], owner: list[str]) -> None:
        # A flag qualifying a sibling value is left unmapped by rule, without asking.
        qualifiers = {o.path for o in group if qualifier_of(o, group) is not None}
        for path in qualifiers:
            picks[path] = Pick(None, "literal", "high")
        ranked = [(o.path, o, options_of(o, owner)) for o in group if o.path not in qualifiers]
        for start in range(0, len(ranked), BATCH):
            batch = ranked[start : start + BATCH]
            limit = NODE_CLASSES + NODE_PROPERTIES if node_ready else options
            note = NODE_OPTIONS_NOTE if node_ready else ""
            chosen = ask("property", batch, note, limit)
            again: dict[str, str] | None = None
            if confirm:
                reverse = [(p, o, list(reversed(rs[:limit]))) for p, o, rs in batch]
                again = ask("property", reverse, note, limit)
            for path, output, rs in batch:
                shown = rs[:limit]
                capped = False
                term = _answer(chosen, path, shown)
                if again is not None:
                    # The tier the pick earns from the second asking (applied below).
                    agreed = term is not None and _answer(again, path, shown) == term
                picked = next((r for r in shown if r.iri == term), None)
                if picked is not None and picked.kind == "class":
                    classes = [r for r in shown if r.kind == "class"]
                    node_class, replaced = _specific(term, classes, terms)
                    # Never high, confirmed or not: a class the matcher put in the model's place
                    # (set below when narrowed), or whose label shares no word of the name.
                    capped = replaced
                    narrower = _narrower(node_class, retrieved_classes.get(path, []), output, terms)
                    if narrower is not None:
                        node_class, capped = narrower, True
                    capped = capped or not name_fits(_label(terms, node_class), output)
                    # An identifier is shared across documents: an entity, not a value node.
                    shared = node_class is not None and is_identifier(terms, node_class)
                    picks[path] = Pick(
                        node_link,
                        "entity" if shared else "node",
                        "medium" if capped else _confidence(term, shown),
                        tuple(r.iri for r in rs),
                        entity_class=node_class,
                    )
                else:
                    picks[path] = _published(term, rs, terms, _confidence(term, shown))
                if again is not None and term is not None:
                    tier = _CONFIRMED[picks[path].confidence] if agreed else "low"
                    picks[path] = replace(picks[path], confidence=tier)
                if capped and picks[path].confidence == "high":
                    picks[path] = replace(picks[path], confidence="medium")

    map_outputs([o for o in outputs if o.kind == "field"], doc_owner)
    for table_path, rows in row_class.items():
        columns = [o for o in outputs if o.kind == "column" and o.path.startswith(f"{table_path}.")]
        map_outputs(columns, [rows] if rows else [])
    return picks


#: A pick confirmed by a second asking goes up a tier.
_CONFIRMED: dict[Confidence, Confidence] = {"low": "medium", "medium": "high", "high": "high"}


def _published(
    term: str | None, ranked: list[Ranked], terms: _Terms, confidence: Confidence
) -> Pick:
    """How the chosen property publishes its value: an object property, an entity of its range
    class; anything else a literal."""
    candidates = tuple(r.iri for r in ranked)
    chosen = next((r for r in ranked if r.iri == term), None)
    if chosen is None or chosen.kind != "object_property":
        return Pick(term, "literal", confidence, candidates)
    entity = next(
        (r for r in chosen.range if (t := terms.get(r)) is not None and str(t.kind) == "class"),
        None,
    )
    return Pick(term, "entity", confidence, candidates, entity_class=entity)


__all__ = [
    "CLASS_KINDS",
    "ChoiceRequest",
    "Chooser",
    "Embedding",
    "Pick",
    "Ranked",
    "choice_prompt",
    "choice_schema",
    "propose",
    "rerank",
]
