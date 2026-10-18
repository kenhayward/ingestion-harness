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
from dataclasses import dataclass, field
from typing import Any, Literal

from .mapping_stage import (
    CLASS_KINDS,
    PROPERTY_KINDS,
    MappingInputs,
    OutputSpec,
    outputs_of,
    query_text,
)
from .ontology import OntologyStore, Term
from .retrieval import shortlist

Confidence = Literal["high", "medium", "low"]

#: Candidates retrieved per output before re-ranking, and options the model chooses among.
RETRIEVE = 20
OPTIONS = 6
#: Outputs per model question.
BATCH = 8
#: A top option this far ahead of the next is a confident pick (re-rank score units).
MARGIN = 0.3

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


def rerank(
    store: OntologyStore | _Terms,
    versions: list[tuple[str, int]],
    output: OutputSpec,
    iris: Sequence[str],
    *,
    owner: Sequence[str],
) -> list[Ranked]:
    """Re-rank retrieved candidates (best first) for `output`, which hangs off `owner` (the
    document's or row's class, empty when not chosen yet). Deprecated and unknown terms go."""
    terms = store if isinstance(store, _Terms) else _Terms(store, versions)
    owners = terms.ancestors(owner) if owner else set()
    names = _names(output)
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
) -> dict[str, Pick]:
    """Map every output of `draft` (path -> Pick; a table's pick holds its link and row class)."""
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

    picks: dict[str, Pick] = {}

    def ask(what: str, batch: list[tuple[str, OutputSpec, list[Ranked]]]) -> dict[str, str]:
        request = ChoiceRequest(
            what=what,
            items=[(path, [r.iri for r in ranked[:options]]) for path, _, ranked in batch],
            prompt=choice_prompt(
                what, [(o, ranked[:options], seen.get(o.path, [])) for _, o, ranked in batch]
            ),
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

    # 3. Fields (they hang off the document), then each table's columns (off its rows).
    def map_outputs(group: list[OutputSpec], owner: list[str]) -> None:
        ranked = [
            (o.path, o, rerank(terms, versions, o, candidates(o, PROPERTY_KINDS), owner=owner))
            for o in group
        ]
        for start in range(0, len(ranked), BATCH):
            batch = ranked[start : start + BATCH]
            chosen = ask("property", batch)
            for path, _output, rs in batch:
                term = _answer(chosen, path, rs[:options])
                picks[path] = _published(term, rs, terms, _confidence(term, rs[:options]))

    map_outputs([o for o in outputs if o.kind == "field"], doc_owner)
    for table_path, rows in row_class.items():
        columns = [o for o in outputs if o.kind == "column" and o.path.startswith(f"{table_path}.")]
        map_outputs(columns, [rows] if rows else [])
    return picks


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
