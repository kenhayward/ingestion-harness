"""Mapping memory (docs/design/mapping-memory.md): the ontology mappings designers accepted,
offered again for outputs that look the same.

The API records the votes (one per recipe and output) and reviews; the worker reads them through
`MappingMemoryStore`, matches the outputs of a mapping run against them (`recall`) and decides
which answers to pre-select (`preselect`). `signature_of` is held in step with `signatureOf` in
`packages/shared/src/mapping-memory.ts` by the shared fixture `mapping-signature.json`.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

GENERIC_NAMES: tuple[str, ...] = (
    "average", "comment", "comments", "count", "max", "maximum", "mean", "min", "minimum",
    "notes", "other", "remarks", "result", "results", "rsd", "sd", "total", "value", "values",
)  # fmt: skip

UNIT_SPELLINGS: dict[str, str] = {
    "%": "%", "percent": "%", "mg": "mg", "g": "g", "kg": "kg", "ug": "µg", "µg": "µg",
    "ml": "ml", "l": "l", "mg/g": "mg/g", "mg/ml": "mg/ml", "ug/ml": "µg/ml", "µg/ml": "µg/ml",
    "cfu": "cfu", "cfu/g": "cfu/g", "cfu/ml": "cfu/ml", "ppm": "ppm", "ppb": "ppb",
    "min": "min", "minutes": "min", "h": "h", "hours": "h", "days": "day", "day": "day",
    "months": "month", "month": "month", "°c": "°c", "degc": "°c", "nm": "nm", "mm": "mm",
}  # fmt: skip

TRAILING_UNITS: tuple[str, ...] = ("%", "percent", "minutes", "min", "hours", "days", "months")

_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
_NON_WORD = re.compile(r"[^a-z0-9%/µ°]+")
_PARENS = re.compile(r"\(([^()]*)\)")


@dataclass(frozen=True)
class Signature:
    key: str
    words: str
    unit: str
    generic: bool


def _words(text: str) -> str:
    return " ".join(_NON_WORD.sub(" ", _CAMEL.sub(r"\1 \2", text).lower()).split())


def _unit_in(text: str) -> tuple[str, str]:
    for m in _PARENS.finditer(text):
        unit = UNIT_SPELLINGS.get(m.group(1).strip().lower())
        if unit:
            return unit, text.replace(m.group(0), " ", 1)
    return "", text


def _type_group(type_: str | None) -> str:
    t = (type_ or "").lower()
    if t in ("number", "integer", "decimal", "float"):
        return "number"
    if t in ("date", "datetime", "time"):
        return "date"
    return "boolean" if t == "boolean" else "text"


def signature_of(
    kind: str,
    name: str,
    description: str | None = None,
    type_: str | None = None,
    table: str | None = None,
) -> Signature:
    """An output's signature: what it looks like, independent of the recipe it is in."""
    unit, rest = _unit_in(name)
    words = _words(rest)
    if not unit:
        parts = words.split(" ")
        if len(parts) > 1 and parts[-1] in TRAILING_UNITS:
            unit, words = UNIT_SPELLINGS[parts[-1]], " ".join(parts[:-1])
    if not unit and description:
        unit = _unit_in(description)[0]
    group = "document" if kind == "document" else "table" if kind == "table" else "value"
    generic = group == "value" and words in GENERIC_NAMES
    types = _type_group(type_) if group == "value" else ""
    parts_ = [group, words, types, unit]
    if generic:
        parts_.append(_words(table) if table else "")
    return Signature("|".join(parts_), words, unit, generic)


#: The path of a recipe's value-node defaults (`VALUE_NODE_DEFAULTS_PATH` in TS).
VALUE_NODE_DEFAULTS_PATH = "#valueNodes"


def defaults_key(ontology_ids: Iterable[str]) -> str:
    """The signature key value-node defaults are remembered under: the pinned ontologies."""
    return "defaults|" + " ".join(sorted(set(ontology_ids)))


# --- answers ---------------------------------------------------------------------------------


class _Answer(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class LiteralAnswer(_Answer):
    form: Literal["literal"]
    property: str


class EntityAnswer(_Answer):
    form: Literal["entity"]
    property: str
    class_: str = Field(alias="class")
    iri: str
    label: bool | None = None


class ConceptAnswer(_Answer):
    form: Literal["concept"]
    property: str
    scheme: str | None = None
    values: dict[str, str] | None = None
    match: Literal["label"] | None = None


class NodeAnswer(_Answer):
    form: Literal["node"]
    link: str | None = None
    class_: str = Field(alias="class")
    value: str | None = None
    unit: str | None = None
    unitProperty: str | None = None


class UnmappedAnswer(_Answer):
    form: Literal["unmapped"]


class TableAnswer(_Answer):
    form: Literal["table"]
    link: str
    class_: str = Field(alias="class")
    iri: str | None = None


class DocumentAnswer(_Answer):
    form: Literal["document"]
    class_: str = Field(alias="class")
    iri: str


class ValueNodesAnswer(_Answer):
    form: Literal["valueNodes"]
    link: str | None = None
    value: str | None = None
    unitProperty: str | None = None


RememberedAnswer = Annotated[
    LiteralAnswer | EntityAnswer | ConceptAnswer | NodeAnswer | UnmappedAnswer | TableAnswer
    | DocumentAnswer | ValueNodesAnswer,
    Field(discriminator="form"),
]  # fmt: skip
_ANSWER: TypeAdapter[RememberedAnswer] = TypeAdapter(RememberedAnswer)


def parse_answer(raw: dict[str, Any]) -> RememberedAnswer:
    """A remembered answer (`RememberedAnswerSchema` in TS)."""
    return _ANSWER.validate_python(raw)


def answer_dict(answer: RememberedAnswer) -> dict[str, Any]:
    """The answer as the shared JSON (full IRIs, `class`, absent keys left out)."""
    return answer.model_dump(by_alias=True, exclude_none=True)


def answer_terms(answer: dict[str, Any]) -> list[str]:
    """The IRIs an answer uses (not its IRI template, label flag, match mode or unit)."""
    out: list[str] = []
    for k, v in answer.items():
        if k in ("form", "iri", "label", "match", "unit"):
            continue
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, dict):
            out.extend(str(x) for x in v.values())
    return list(dict.fromkeys(out))


# --- the store ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Vote:
    """One recipe's acceptance of an entry's answer for one of its outputs."""

    template_id: str
    path: str
    version: int
    name: str
    description: str
    table: str | None
    #: The recipe's project allows external models (its wording may be sent to one).
    external: bool


@dataclass(frozen=True)
class MemoryEntry:
    id: str
    kind: str
    signature_key: str
    name: str
    description: str
    type: str
    unit: str
    answer: dict[str, Any]
    ontologies: tuple[str, ...]
    status: str  # learned | confirmed | rejected
    votes: tuple[Vote, ...] = ()
    refusals: int = 0
    #: Added or confirmed by hand on a project that allows external models.
    external: bool = False

    @property
    def shareable(self) -> bool:
        """Its wording may reach an external model: a vote (or review) from such a project."""
        return self.external or any(v.external for v in self.votes)

    def wording(self, external: bool) -> tuple[str, str] | None:
        """The name and description to show a model; for an external one, from a vote whose
        project allows external models only."""
        if not external:
            return self.name, self.description
        for v in self.votes:
            if v.external:
                return v.name, v.description
        return (self.name, self.description) if self.external else None


class MappingMemoryStore(Protocol):
    def entries(self, ontology_ids: Sequence[str]) -> list[MemoryEntry]:
        """Every entry whose answer was given under one of these ontologies (not rejected ones
        excepted: a rejected entry removes its answer from the options)."""
        ...

    def vectors(self, model: str, entry_ids: Sequence[str]) -> dict[str, list[float]]: ...

    def store_vectors(self, model: str, vectors: dict[str, list[float]]) -> None: ...


# --- recall and pre-selection --------------------------------------------------------------------

#: Fuzzy matches: name trigram similarity, and embedding similarity of the signature text.
MIN_TRIGRAM = 0.5
MIN_COSINE = 0.82
MAX_FUZZY = 3


@dataclass(frozen=True)
class OutputLook:
    """What a mapping run knows of an output, to recall remembered answers for it."""

    path: str
    kind: str  # document | field | column | table
    name: str
    description: str
    type: str
    table: str | None = None


@dataclass(frozen=True)
class Hit:
    entry: MemoryEntry
    score: float
    exact: bool


@dataclass
class Recall:
    exact: list[Hit] = field(default_factory=list)
    fuzzy: list[Hit] = field(default_factory=list)
    #: Answers rejected for this output's signature (removed from its options).
    rejected: list[MemoryEntry] = field(default_factory=list)


def trigrams(text: str) -> set[str]:
    """pg_trgm's trigrams: each word padded with two spaces in front and one behind."""
    out: set[str] = set()
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        padded = f"  {w} "
        out.update(padded[i : i + 3] for i in range(len(padded) - 2))
    return out


def trigram_similarity(a: str, b: str) -> float:
    ta, tb = trigrams(a), trigrams(b)
    return len(ta & tb) / len(ta | tb) if ta and tb else 0.0


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def signature_text(name: str, description: str, table: str | None = None) -> str:
    """The text embedded for a signature (and for an output looked up)."""
    return " — ".join(p for p in (name, description, table or "") if p)


def _kind_group(kind: str) -> str:
    return "value" if kind in ("field", "column") else kind


def recall(
    entries: Iterable[MemoryEntry],
    outputs: Sequence[OutputLook],
    *,
    usable: Callable[[MemoryEntry], bool],
    external: bool,
    output_vectors: dict[str, list[float]] | None = None,
    entry_vectors: dict[str, list[float]] | None = None,
) -> dict[str, Recall]:
    """Each output's remembered answers: exact (the same signature key) and fuzzy (a similar
    name, or a similar embedded signature), of the same kind of output. `usable` says whether an
    entry's terms hold in the run's pinned ontology versions; for an `external` model, entries
    whose wording may not leave the deployment are left out."""
    pool = [e for e in entries if usable(e) and (not external or e.shareable)]
    out: dict[str, Recall] = {}
    for o in outputs:
        sig = signature_of(o.kind, o.name, o.description, o.type, o.table)
        found = Recall()
        group = _kind_group(o.kind)
        for e in pool:
            if _kind_group(e.kind) != group:
                continue
            if e.signature_key == sig.key:
                if e.status == "rejected":
                    found.rejected.append(e)
                else:
                    found.exact.append(Hit(e, 1.0, True))
                continue
            if e.status == "rejected":
                continue
            score = trigram_similarity(sig.words, _words(e.name))
            vec_o = (output_vectors or {}).get(o.path)
            vec_e = (entry_vectors or {}).get(e.id)
            semantic = cosine(vec_o, vec_e) if vec_o is not None and vec_e is not None else 0.0
            if score >= MIN_TRIGRAM or semantic >= MIN_COSINE:
                found.fuzzy.append(Hit(e, max(score, semantic), False))
        if sig.generic is False and len({h.entry.answer.get("form") for h in found.exact}) > 1:
            # Conflicting answers for one name: those voted from a table of the same name first.
            same = [h for h in found.exact if any(v.table == o.table for v in h.entry.votes)]
            if same and o.table:
                found.exact = same
        found.fuzzy = sorted(found.fuzzy, key=lambda h: -h.score)[:MAX_FUZZY]
        if found.exact or found.fuzzy or found.rejected:
            out[o.path] = found
    return out


@dataclass(frozen=True)
class Choice:
    """A remembered answer pre-selected for an output, and the ones it was preferred to."""

    entry: MemoryEntry
    confidence: str  # high | medium
    alternatives: tuple[MemoryEntry, ...] = ()


def net_votes(e: MemoryEntry) -> int:
    return len({v.template_id for v in e.votes}) - e.refusals


def preselect(found: Recall) -> Choice | None:
    """Greedy pre-selection (decision 3): an exact answer, not left unmapped, not refused in
    more recipes than it was accepted in; the confirmed one wins a conflict, else the most net
    votes. High confidence when confirmed or two or more recipes agree; medium for one."""
    candidates = [
        h.entry
        for h in found.exact
        if h.entry.answer.get("form") != "unmapped" and net_votes(h.entry) >= 0
        and (h.entry.status == "confirmed" or h.entry.votes)
    ]  # fmt: skip
    if not candidates:
        return None
    confirmed = [e for e in candidates if e.status == "confirmed"]
    if len(confirmed) == 1:
        chosen = confirmed[0]
    elif confirmed:
        chosen = max(confirmed, key=net_votes)
    else:
        chosen = max(candidates, key=net_votes)
    others = tuple(e for e in candidates if e is not chosen)
    recipes = len({v.template_id for v in chosen.votes})
    if not confirmed and others:
        confidence = "medium"
    else:
        confidence = "high" if chosen.status == "confirmed" or recipes >= 2 else "medium"
    return Choice(chosen, confidence, others)


def hint_line(found: Recall, *, external: bool) -> str | None:
    """One line for the output's prompt: what was accepted before for outputs like it."""
    parts = []
    for h in [*found.exact, *found.fuzzy]:
        wording = h.entry.wording(external)
        if wording is None:
            continue
        recipes = len({v.template_id for v in h.entry.votes})
        status = " (confirmed)" if h.entry.status == "confirmed" else ""
        parts.append(
            f'"{wording[0]}" in {recipes} recipe{"" if recipes == 1 else "s"}{status}: '
            f"{describe_answer(h.entry.answer)}"
        )
    return "Accepted before for " + "; ".join(parts) if parts else None


def describe_answer(answer: dict[str, Any]) -> str:
    form = answer.get("form")
    if form == "unmapped":
        return "left unmapped"
    if form == "node":
        unit = f", unit {answer['unit']}" if answer.get("unit") else ""
        return f"value node of {answer['class']}{unit}"
    if form == "entity":
        return f"entity of {answer['class']} via {answer['property']}"
    if form == "concept":
        return f"concept via {answer['property']}"
    if form == "table":
        return f"rows of {answer['class']} via {answer['link']}"
    if form == "document":
        return f"document of {answer['class']}"
    if form == "valueNodes":
        return "value-node defaults"
    return f"literal via {answer.get('property')}"


class MemoryMappingMemoryStore:
    """In-memory store (tests, and the harness's leave-one-out memory)."""

    def __init__(self, entries: Iterable[MemoryEntry] = ()) -> None:
        self.saved: list[MemoryEntry] = list(entries)
        self.saved_vectors: dict[tuple[str, str], list[float]] = {}

    def entries(self, ontology_ids: Sequence[str]) -> list[MemoryEntry]:
        wanted = set(ontology_ids)
        return [e for e in self.saved if not e.ontologies or wanted & set(e.ontologies)]

    def vectors(self, model: str, entry_ids: Sequence[str]) -> dict[str, list[float]]:
        return {i: v for (m, i), v in self.saved_vectors.items() if m == model and i in entry_ids}

    def store_vectors(self, model: str, vectors: dict[str, list[float]]) -> None:
        for i, v in vectors.items():
            self.saved_vectors[(model, i)] = v


class PgMappingMemoryStore:
    """The mapping memory on Postgres (migration 202610181509_mapping_memory); the API writes
    it, the worker reads it and keeps the signature embeddings."""

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    def entries(self, ontology_ids: Sequence[str]) -> list[MemoryEntry]:
        rows = self._conn.execute(
            """SELECT m.id::text, m.kind, m.signature_key, m.name, m.description, m.type, m.unit,
                      m.answer, m.ontologies, m.status, m.reviewed_external,
                      COALESCE((SELECT json_agg(json_build_object(
                                  't', v.template_id, 'p', v.output_path, 'v', v.version,
                                  'n', v.name, 'd', v.description, 'tb', v.table_name,
                                  'x', v.external) ORDER BY v.template_id, v.output_path)
                                  FROM mapping_memory_votes v WHERE v.entry_id = m.id), '[]'),
                      (SELECT count(DISTINCT r.template_id)
                         FROM mapping_memory_refusals r WHERE r.entry_id = m.id)
                 FROM mapping_memory m
                WHERE m.ontologies && %s::text[] OR cardinality(m.ontologies) = 0
                ORDER BY m.created_at, m.id""",
            (list(ontology_ids),),
        ).fetchall()
        return [
            MemoryEntry(
                r[0],
                r[1],
                r[2],
                r[3],
                r[4],
                r[5],
                r[6],
                dict(r[7]),
                tuple(r[8]),
                r[9],
                tuple(
                    Vote(v["t"], v["p"], int(v["v"]), v["n"], v["d"] or "", v["tb"], bool(v["x"]))
                    for v in r[11]
                ),
                int(r[12]),
                bool(r[10]),
            )
            for r in rows
        ]

    def vectors(self, model: str, entry_ids: Sequence[str]) -> dict[str, list[float]]:
        if not entry_ids:
            return {}
        rows = self._conn.execute(
            """SELECT entry_id::text, embedding FROM mapping_memory_embeddings
                WHERE model = %s AND entry_id = ANY(%s::uuid[])""",
            (model, list(entry_ids)),
        ).fetchall()
        return {r[0]: [float(x) for x in r[1]] for r in rows}

    def store_vectors(self, model: str, vectors: dict[str, list[float]]) -> None:
        for entry_id, vector in vectors.items():
            # An entry deleted meanwhile (its last vote moved) stores nothing.
            self._conn.execute(
                """INSERT INTO mapping_memory_embeddings (entry_id, model, embedding)
                   SELECT id, %s, %s::real[] FROM mapping_memory WHERE id = %s::uuid
                   ON CONFLICT (entry_id, model) DO UPDATE SET embedding = EXCLUDED.embedding""",
                (model, vector, entry_id),
            )
