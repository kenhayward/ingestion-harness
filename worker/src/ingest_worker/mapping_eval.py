"""Ontology mapping evaluation (spike, docs/design/mapping-automation.md): research code, not
used by the Workbench. It scores matchers against a gold mapping: the Workbench mapping stage as
it runs today (`current`) and the per-output matcher (`per-output`, `mapping_match`).

    python -m ingest_worker.mapping_eval --gold FILE [--gold FILE…] [--matcher current,per-output]
        [--model REF] [--json]
    python -m ingest_worker.mapping_eval --template PROJECT [--model REF]

A gold file names a Workbench `project`; the harness then reads that project's newest mapping
job, so both matchers see exactly the draft, observed values and pinned ontologies the stage saw.
`--template` prints a gold file for a project from the current stage's answer, for an expert to
correct. It reads `DATABASE_URL`, calls the model (the drafting model unless `--model`), and
writes nothing.
"""

from __future__ import annotations

import json
import sys
import time
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, field, replace
from typing import Any, Literal, Protocol

import yaml

from .drafting import DraftParams
from .extract import ExtractionFailedError
from .mapping_match import (
    ChoiceRequest,
    Chooser,
    Confidence,
    Embedding,
    Pick,
    choice_schema,
    propose,
)
from .mapping_stage import (
    MappingInputs,
    OutputSpec,
    _embedder,
    outputs_of,
    query_text,
    run_mapping,
    stage_shortlists,
)
from .ontology import OntologyStore
from .pipeline import DocumentError, PipelineDeps, enforce_data_policy
from .queue import ClaimedJob
from .rdf import CURIE_PREFIXES

ValueAs = Literal["literal", "entity", "concept", "node"]
VALUE_AS: tuple[str, ...] = ("literal", "entity", "concept", "node")
KS = (1, 3, 5, 10)
KINDS = ("document", "field", "table", "column")


# --- gold ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Expected:
    """One output's right answer: any of `terms` (empty: leave it unmapped, unless `any_term`:
    any link property will do, the class carrying the meaning), how the value may be published
    when the gold says (empty: not scored), and its class(es): a table's row class, a field or
    column's entity or value node class."""

    terms: frozenset[str]
    value_as: frozenset[str] = frozenset()
    row_class: frozenset[str] = frozenset()
    any_term: bool = False


@dataclass(frozen=True)
class Gold:
    name: str
    project: str | None
    #: Inline inputs (tests): {draft, mapping, brief?}; else read from the project's mapping job.
    inputs: dict[str, Any] | None
    prefixes: dict[str, str]
    expected: dict[str, Expected]


def _expand(term: str, prefixes: dict[str, str]) -> str:
    if "://" in term or term.startswith("urn:"):
        return term
    prefix, sep, local = term.partition(":")
    if not sep or prefix not in prefixes:
        raise ValueError(f"{term}: no prefix {prefix!r} declared (prefixes:)")
    return prefixes[prefix] + local


def _terms(value: Any, prefixes: dict[str, str]) -> frozenset[str]:
    items = value if isinstance(value, list) else [value] if value else []
    return frozenset(_expand(str(t), prefixes) for t in items)


def load_gold(text: str) -> Gold:
    """A gold file (YAML): `project` or `inputs`, `prefixes`, and `expected`: path -> a term, a
    list of acceptable terms, `unmapped`, or {term, as, class}. The document's path is ''."""
    raw = yaml.safe_load(text) or {}
    if not raw.get("project") and not raw.get("inputs"):
        raise ValueError("a gold file names a project (or carries inputs)")
    prefixes = {**CURIE_PREFIXES, **(raw.get("prefixes") or {})}
    expected: dict[str, Expected] = {}
    for path, value in (raw.get("expected") or {}).items():
        path = "" if path is None else str(path)
        if value in (None, "unmapped"):
            expected[path] = Expected(frozenset())
        elif isinstance(value, dict):
            raw_as = value.get("as")
            how = frozenset(raw_as if isinstance(raw_as, list) else [raw_as] if raw_as else [])
            if not how <= set(VALUE_AS):
                raise ValueError(f"{path}: as must be one of {', '.join(VALUE_AS)}")
            any_term = value.get("term") == "any"
            expected[path] = Expected(
                frozenset() if any_term else _terms(value.get("term"), prefixes),
                how,
                _terms(value.get("class"), prefixes),
                any_term,
            )
        else:
            expected[path] = Expected(_terms(value, prefixes))
    return Gold(
        name=str(raw.get("name") or raw.get("project") or "gold"),
        project=raw.get("project"),
        inputs=raw.get("inputs"),
        prefixes=prefixes,
        expected=expected,
    )


# --- scores -------------------------------------------------------------------------------------


@dataclass
class KindScore:
    outputs: int = 0
    #: The pick is a right term, or unmapped where the gold leaves it unmapped.
    hit: int = 0
    mapped: int = 0
    mapped_right: int = 0
    gold_mapped: int = 0
    value_total: int = 0
    value_right: int = 0
    class_total: int = 0
    class_right: int = 0
    #: Gold-mapped outputs whose right term is among the first k candidates.
    recall_at: dict[int, int] = field(default_factory=lambda: dict.fromkeys(KS, 0))
    reciprocal_rank: float = 0.0
    #: Gold-mapped outputs that name a term (recall@k and MRR are over these; `any` names none).
    recall_total: int = 0
    #: confidence -> [picks, right picks]
    tiers: dict[str, list[int]] = field(
        default_factory=lambda: {"high": [0, 0], "medium": [0, 0], "low": [0, 0]}
    )
    #: Picks right in every way the gold names: the term, the form, the class (`_exact`).
    exact: int = 0
    #: confidence -> exact picks (a tier's real precision when the gold accepts `term: any`).
    tiers_exact: dict[str, int] = field(default_factory=lambda: {"high": 0, "medium": 0, "low": 0})

    @property
    def precision(self) -> float:
        return self.mapped_right / self.mapped if self.mapped else 0.0

    @property
    def recall(self) -> float:
        return self.mapped_right / self.gold_mapped if self.gold_mapped else 0.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if p + r else 0.0

    def add(self, pick: Pick, expected: Expected) -> None:
        self.outputs += 1
        mapped = expected.any_term or bool(expected.terms)
        right = _right(pick, expected)
        self.hit += right
        tier = self.tiers.setdefault(pick.confidence, [0, 0])
        tier[0] += 1
        tier[1] += right
        exact = _exact(pick, expected)
        self.exact += exact
        self.tiers_exact[pick.confidence] = self.tiers_exact.get(pick.confidence, 0) + exact
        if pick.term is not None:
            self.mapped += 1
            self.mapped_right += mapped and right
        if mapped:
            self.gold_mapped += 1
            if expected.terms:  # recall needs a named term (not `any`)
                self.recall_total += 1
                ranks = [i for i, c in enumerate(pick.candidates, 1) if c in expected.terms]
                for k in self.recall_at:
                    self.recall_at[k] += bool(ranks) and ranks[0] <= k
                self.reciprocal_rank += 1 / ranks[0] if ranks else 0.0
            if expected.value_as and right:
                self.value_total += 1
                self.value_right += pick.value_as in expected.value_as
        if expected.row_class:
            self.class_total += 1
            self.class_right += _chosen_class(pick) in expected.row_class

    def summary(self) -> dict[str, Any]:
        return {
            **asdict(self),
            "precision": round(self.precision, 4),
            "recall": round(self.recall, 4),
            "f1": round(self.f1, 4),
            "mrr": round(self.reciprocal_rank / self.recall_total, 4) if self.recall_total else 0.0,
        }


def _right(pick: Pick, expected: Expected) -> bool:
    """The pick is a right term, or unmapped where the gold leaves the output unmapped."""
    if expected.any_term:
        return pick.term is not None
    return (pick.term in expected.terms) if expected.terms else pick.term is None


def _exact(pick: Pick, expected: Expected) -> bool:
    """Right in every way the gold names: the term (or unmapped), how the value is published,
    and the class. With `term: any` a hit says only that the output was mapped; this says it
    was mapped as the gold says."""
    if not _right(pick, expected):
        return False
    if pick.term is None:
        return True
    if expected.value_as and pick.value_as not in expected.value_as:
        return False
    return not expected.row_class or _chosen_class(pick) in expected.row_class


def _chosen_class(pick: Pick) -> str | None:
    """The class a pick gives its output: a table's row class, else a value's entity class."""
    return pick.row_class if pick.row_class is not None else pick.entity_class


@dataclass
class Scores:
    overall: KindScore
    by_kind: dict[str, KindScore]
    seconds: float = 0.0
    calls: int = 0
    picks: dict[str, Pick] = field(default_factory=dict)
    #: Why the matcher gave no answer (its outputs then all count as unmapped), else None.
    failed: str | None = None


def score(picks: dict[str, Pick], gold: Gold, kinds: dict[str, str]) -> Scores:
    """Score `picks` against the gold's outputs (an output without a pick counts as unmapped)."""
    overall = KindScore()
    by_kind = {k: KindScore() for k in KINDS}
    for path, expected in gold.expected.items():
        pick = picks.get(path, Pick(None))
        overall.add(pick, expected)
        by_kind.setdefault(kinds.get(path, "field"), KindScore()).add(pick, expected)
    return Scores(overall, by_kind, picks=dict(picks))


#: A matcher run: its name and a one-item call counter -> picks per output path.
MatcherRun = Callable[[str, list[int]], dict[str, Pick]]


def run_matchers(
    matchers: list[str], gold: Gold, kinds: dict[str, str], run: MatcherRun
) -> dict[str, Scores]:
    """Each matcher's picks scored against the gold. A matcher that fails (a model that never
    gave a valid answer) is scored as leaving every output unmapped, with its reason in
    `failed`, and the next matcher still runs."""
    results: dict[str, Scores] = {}
    for matcher in matchers:
        started, calls = time.monotonic(), [0]
        failed: str | None = None
        try:
            picks = run(matcher, calls)
        except (DocumentError, ExtractionFailedError) as exc:
            picks, failed = {}, str(exc)
        result = score(picks, gold, kinds)
        result.seconds = time.monotonic() - started
        result.calls = calls[0]
        result.failed = failed
        results[matcher] = result
    return results


# --- matchers -------------------------------------------------------------------------------------


def picks_from_body(
    body: dict[str, Any], prefixes: dict[str, str], defaults: dict[str, Any] | None = None
) -> dict[str, Pick]:
    """The mapping stage's answer (typed changes) as picks, terms expanded to full IRIs. A value
    node without its own link takes the answer's value-node defaults, else `defaults` (the
    draft's `semantics.valueNodes`)."""
    known = {**CURIE_PREFIXES, **prefixes}
    link_default = (defaults or {}).get("link")
    for change in body.get("changes") or []:
        if change.get("op") == "setDocumentMapping":
            known.update(change.get("prefixes") or {})
            link_default = (change.get("valueNodes") or {}).get("link") or link_default

    def full(term: str | None) -> str | None:
        if not term:
            return None
        try:
            return _expand(term, known)
        except ValueError:
            return term

    def output(mapping: dict[str, Any], confidence: Confidence) -> Pick:
        node = mapping.get("node")
        if node:
            link = full(mapping.get("property") or link_default)
            return Pick(link, "node", confidence, entity_class=full(node.get("class")))
        how = (
            "entity"
            if mapping.get("object")
            else "concept"
            if mapping.get("concepts")
            else "literal"
        )
        entity = full((mapping.get("object") or {}).get("class"))
        return Pick(full(mapping.get("property")), how, confidence, entity_class=entity)

    picks: dict[str, Pick] = {}
    for change in body.get("changes") or []:
        op = change.get("op")
        stated = change.get("confidence")
        confidence: Confidence = stated if stated in ("high", "medium", "low") else "medium"
        if op == "setDocumentMapping":
            picks[""] = Pick(full(change["document"].get("class")), "", confidence)
        elif op == "putFieldMapping":
            picks[change["field"]] = output(change["mapping"], confidence)
        elif op == "putTableMapping":
            mapping = change["mapping"]
            picks[change["table"]] = Pick(
                full(mapping.get("link")),
                "entity",
                confidence,
                row_class=full(mapping.get("class")),
            )
            for column, m in (mapping.get("columns") or {}).items():
                picks[f"{change['table']}.{column}"] = output(m, confidence)
    return picks


class _Quiet:
    """The queue a matcher run reports to: nothing is recorded."""

    def event(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def is_cancelled(self, _job: ClaimedJob) -> bool:
        return False


def progress_line(data: dict[str, Any]) -> str:
    """A drafting progress event as one line: the phase, the try, the reply's tokens so far and,
    with tools, the tool running or the number of tool calls."""
    if data.get("phase") != "model":
        return "reading the inputs" if data.get("phase") == "reading" else str(data.get("phase"))
    parts = ["model"]
    if data.get("attempt") is not None:
        parts[0] += f", try {data['attempt']} of {data.get('of')}"
    if data.get("tokens") is not None:
        parts.append(f"~{data['tokens']:,} tokens")
    tool = data.get("tool")
    if tool:
        parts.append(str(tool.get("summary") or tool.get("name")))
    elif data.get("toolCalls") is not None:
        parts.append(f"{data['toolCalls']} tool calls")
    return " · ".join(parts)


class LiveProgress(_Quiet):
    """The queue a matcher run reports to, printing each new progress line with the time since
    the matcher started (the harness has no job to record events on)."""

    def __init__(
        self,
        matcher: str,
        write: Callable[[str], None],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._matcher, self._write, self._clock = matcher, write, clock
        self._started = clock()
        self._last: str | None = None

    def say(self, line: str) -> None:
        elapsed = int(self._clock() - self._started)
        self._write(f"[{elapsed // 60:02d}:{elapsed % 60:02d}] {self._matcher}: {line}")

    def event(self, *args: Any, **_kwargs: Any) -> None:
        from .drafting import DRAFT_PROGRESS

        _job_id, _level, message, data = args
        if message != DRAFT_PROGRESS:
            return
        line = progress_line(data)
        if line != self._last:
            self._last = line
            self.say(line)


def _job(params: DraftParams) -> ClaimedJob:
    draft = params.draft or {}
    return ClaimedJob(
        "mapping-eval", "", str(draft.get("id", "")), 0, "", "", None, 1, 1,
        task="draft", test=True, project_id="mapping-eval", params=params.model_dump(by_alias=True),
    )  # fmt: skip


def _observed(params: DraftParams) -> MappingInputs:
    """The mapping inputs with the holdout rule the stage applies: dev samples' values only."""
    inputs = MappingInputs.model_validate(params.mapping or {})
    dev = {s.filename for s in params.samples if s.role == "dev"}
    observed = {p: [v for v in vs if v.sample in dev] for p, vs in inputs.observed.items()}
    return inputs.model_copy(update={"observed": {p: v for p, v in observed.items() if v}})


def current_picks(
    deps: PipelineDeps, params: DraftParams, model_ref: str, queue: Any = None
) -> dict[str, Pick]:
    """Run the Workbench mapping stage as it is (one answer over the shortlists) and read its
    answer back; each pick's candidates are the stage's own shortlist (before the term budget)."""
    provider, model_id = deps.models.resolve(model_ref)
    job = _job(params)
    queue = queue if queue is not None else _Quiet()
    enforce_data_policy(job, deps, provider, model_ref)
    output = run_mapping(
        job, deps, queue, params, provider, model_id, f"{provider.name}/{model_id}"
    )
    draft = params.draft or {}
    semantics = draft.get("semantics") or {}
    picks = picks_from_body(
        output["body"], semantics.get("prefixes") or {}, semantics.get("valueNodes")
    )
    store = deps.ontologies
    assert store is not None
    inputs = _observed(params)
    versions = [(v.id, v.version) for v in inputs.versions]
    outputs = outputs_of(draft)
    queries = {o.path: query_text(o, inputs.observed.get(o.path, [])) for o in outputs}
    embedder = _embedder(job, deps, queue, params.data_policy == "local", [])
    vectors: dict[str, list[float]] = {}
    if embedder is not None and store.has_embeddings(versions, embedder.model_ref):
        paths = list(queries)
        vectors = dict(
            zip(
                paths,
                embedder.provider.embed(embedder.model_id, [queries[p] for p in paths]),
                strict=True,
            )
        )
    lists = stage_shortlists(
        store, versions, outputs, queries, vectors, embedder.model_ref if embedder else None
    )
    out: dict[str, Pick] = {}
    for o in outputs:
        pick = picks.get(o.path, Pick(None))
        out[o.path] = Pick(
            pick.term,
            pick.value_as,
            pick.confidence,
            tuple(c.iri for c in lists.get(o.path, [])),
            pick.row_class,
            pick.entity_class,
        )
    return out


def per_output_picks(
    params: DraftParams,
    store: OntologyStore,
    choose: Chooser,
    embed: Embedding | None,
    *,
    confirm: bool = False,
    remembered: dict[str, Pick] | None = None,
) -> dict[str, Pick]:
    """The per-output matcher's picks; `confirm` asks each field and column again with the
    options reversed; `remembered` outputs are answered by the mapping memory (`propose`)."""
    inputs = _observed(params)
    versions = [(v.id, v.version) for v in inputs.versions]
    return propose(
        params.draft or {}, inputs, store, versions, choose=choose, embed=embed,
        confirm=confirm, remembered=remembered,
    )  # fmt: skip


# --- mapping memory (docs/design/mapping-memory.md) ----------------------------------------------


def answer_pick(answer: dict[str, Any], confidence: str) -> Pick:
    """A remembered answer as the pick the matchers make."""
    conf: Confidence = confidence if confidence in ("high", "medium", "low") else "medium"  # type: ignore[assignment]
    form = answer.get("form")
    if form == "unmapped":
        return Pick(None, "literal", conf)
    if form == "document":
        return Pick(answer["class"], "", conf, (answer["class"],))
    if form == "table":
        return Pick(answer["link"], "entity", conf, (answer["link"],), row_class=answer["class"])
    if form == "node":
        link = answer.get("link")
        return Pick(link, "node", conf, (link,) if link else (), entity_class=answer["class"])
    term = answer.get("property")
    entity = answer.get("class") if form == "entity" else None
    return Pick(term, str(form), conf, (term,) if term else (), entity_class=entity)


def self_loo_picks(gold: Gold, outputs: list[OutputSpec]) -> dict[str, Pick]:
    """Leave one out on the gold itself: each output answered by the gold's answer for another
    output with the same signature (the memory a recipe repeating an output would give), its
    own answer never used. Outputs no other output looks like get no pick."""
    from .mapping_memory import signature_of

    tables = {o.path: o.name for o in outputs if o.kind == "table"}
    keys = {
        o.path: signature_of(
            o.kind, o.name, o.description, o.type,
            tables.get(o.path.split(".", 1)[0]) if o.kind == "column" else None,
        ).key
        for o in outputs
    }  # fmt: skip
    picks: dict[str, Pick] = {}
    for o in outputs:
        for other in outputs:
            expected = gold.expected.get(other.path)
            if other.path == o.path or keys[other.path] != keys[o.path] or expected is None:
                continue
            if not expected.any_term and not expected.terms:
                continue  # left unmapped: never pre-selected
            term = "urn:any" if expected.any_term else sorted(expected.terms)[0]
            cls = sorted(expected.row_class)[0] if expected.row_class else None
            default = "entity" if o.kind == "table" else "literal"
            how = sorted(expected.value_as)[0] if expected.value_as else default
            picks[o.path] = Pick(
                term, how, "high", (term,),
                row_class=cls if o.kind == "table" else None,
                entity_class=cls if o.kind != "table" else None,
            )  # fmt: skip
            break
    return picks


class LeaveOneOutMemory:
    """The deployment's mapping memory without the votes of the recipe being evaluated (its
    own answers would make the score meaningless), read only: no vectors are written."""

    def __init__(self, inner: Any, template_id: str | None) -> None:
        self._inner, self._template = inner, template_id

    def entries(self, ontology_ids: Any) -> list[Any]:
        from dataclasses import replace as replace_

        out = []
        for e in self._inner.entries(ontology_ids):
            votes = tuple(v for v in e.votes if v.template_id != self._template)
            if votes or e.status != "learned":
                out.append(replace_(e, votes=votes))
        return out

    def vectors(self, model: str, entry_ids: Any) -> dict[str, list[float]]:
        return dict(self._inner.vectors(model, entry_ids))

    def store_vectors(self, model: str, vectors: dict[str, list[float]]) -> None:
        return None


def memory_picks(memory: Any, params: DraftParams, store: OntologyStore) -> dict[str, Pick]:
    """The answers the mapping memory pre-selects for the gold's outputs (exact signatures)."""
    from .mapping_memory import OutputLook, answer_terms, preselect, recall

    inputs = MappingInputs.model_validate(params.mapping or {})
    versions = [(v.id, v.version) for v in inputs.versions]
    draft = params.draft or {}
    outputs = outputs_of(draft)
    tables = {o.path: o.name for o in outputs if o.kind == "table"}
    looks = [
        OutputLook(
            o.path, o.kind, o.name, o.description, o.type,
            tables.get(o.path.split(".", 1)[0]) if o.kind == "column" else None,
        )
        for o in outputs
    ]  # fmt: skip

    def usable(e: Any) -> bool:
        return all(
            (t := store.term(versions, iri)) is not None and not t.deprecated
            for iri in answer_terms(e.answer)
        )

    entries = memory.entries(sorted({i for i, _ in versions}))
    found = recall(entries, looks, usable=usable, external=False)
    picks = {}
    for path, f in found.items():
        choice = preselect(f)
        if choice is not None:
            picks[path] = answer_pick(choice.entry.answer, choice.confidence)
    return picks


def check_policy(deps: PipelineDeps, params: DraftParams, model_ref: str) -> None:
    """The mapping stage's data-policy checks, before any model call: a local-only project, or a
    local-only pinned ontology (or one its terms were imported from), never reaches an external
    model (`run_mapping` does the same for the stage itself)."""
    provider, _ = deps.models.resolve(model_ref)
    enforce_data_policy(_job(params), deps, provider, model_ref)
    inputs = MappingInputs.model_validate(params.mapping or {})
    versions = [(v.id, v.version) for v in inputs.versions]
    store = deps.ontologies
    restricted = {f"{v.id} v{v.version}" for v in inputs.versions if v.local_only} | set(
        store.local_only_sources(versions) if store is not None else []
    )
    if restricted and deps.models.location(provider.name) == "external":
        raise DocumentError(
            f"{', '.join(sorted(restricted))} is local only: the mapping needs a local model"
        )


def model_chooser(
    deps: PipelineDeps,
    params: DraftParams,
    model_ref: str,
    counter: list[int],
    say: Callable[[str], None] | None = None,
) -> Chooser:
    """Answer each ChoiceRequest with one structured model call (enum per output), after the
    data-policy checks (`check_policy`). `say` hears each call and its reply's tokens so far."""
    from . import drafting
    from .extract import run_extraction

    check_policy(deps, params, model_ref)
    provider, model_id = deps.models.resolve(model_ref)
    limit = drafting.output_limit(deps, f"{provider.name}/{model_id}")

    def choose(request: ChoiceRequest) -> dict[str, str]:
        counter[0] += 1
        n = counter[0]
        streaming: dict[str, Any] = {}
        if say is not None:
            outputs = len(request.items)
            say(f"choice {n} ({outputs} output{'' if outputs == 1 else 's'})")
            streaming["on_tokens"] = drafting.TokenThrottle(
                lambda tokens: say(f"choice {n}: ~{tokens:,} tokens")
            )
        result = run_extraction(
            extraction_id="mapping-choice",
            provider=provider,
            model_id=model_id,
            prompt=request.prompt,
            schema=choice_schema(request),
            max_attempts=2,
            max_tokens=limit,
            system=drafting.DRAFT_SYSTEM,
            **streaming,
        )
        return {k: str(v) for k, v in result.data.items()}

    return choose


# --- inputs, report, template ------------------------------------------------------------------


class JobParams(Protocol):
    def newest_mapping_params(self, project: str) -> dict[str, Any] | None: ...


def draft_params(gold: Gold, rows: JobParams | None) -> DraftParams:
    """The mapping job's parameters: the project's newest mapping job, or the gold's own inputs."""
    if gold.project and rows is not None:
        raw = rows.newest_mapping_params(gold.project)
        if raw is None:
            raise ValueError(f"project {gold.project} has no mapping job: run the stage once")
        return DraftParams.model_validate(raw)
    inputs = gold.inputs or {}
    samples = sorted(
        {
            v["sample"]
            for vs in (inputs.get("mapping") or {}).get("observed", {}).values()
            for v in vs
        }
    )
    return DraftParams.model_validate(
        {
            "stage": "mapping",
            "dataPolicy": "local",
            "brief": inputs.get("brief") or {},
            "draft": inputs["draft"],
            "samples": [
                {"sampleId": f"s{i}", "filename": name, "sha256": f"sha-{i}", "role": "dev"}
                for i, name in enumerate(samples, 1)
            ],
            "mapping": inputs["mapping"],
        }
    )


def _pct(n: int, d: int) -> str:
    return f"{100 * n / d:.0f}%" if d else "-"


def format_report(name: str, results: dict[str, Scores]) -> str:
    lines = [f"Gold: {name}", ""]
    head = f"{'matcher':<12} {'kind':<9} {'n':>3} {'Hit@1':>6} {'P':>5} {'R':>5} {'F1':>5} {'R@1':>5} {'R@5':>5} {'R@10':>5} {'MRR':>5} {'as':>5} {'class':>5} {'Exact':>5}"
    lines.append(head)
    for matcher, s in results.items():
        for kind, k in [("all", s.overall), *s.by_kind.items()]:
            if not k.outputs:
                continue
            summary = k.summary()
            lines.append(
                f"{matcher:<12} {kind:<9} {k.outputs:>3} {_pct(k.hit, k.outputs):>6} "
                f"{_pct(k.mapped_right, k.mapped):>5} {_pct(k.mapped_right, k.gold_mapped):>5} "
                f"{100 * k.f1:>4.0f}% {_pct(k.recall_at[1], k.recall_total):>5} "
                f"{_pct(k.recall_at[5], k.recall_total):>5} {_pct(k.recall_at[10], k.recall_total):>5} "
                f"{summary['mrr']:>5.2f} {_pct(k.value_right, k.value_total):>5} "
                f"{_pct(k.class_right, k.class_total):>5} {_pct(k.exact, k.outputs):>5}"
            )
    lines += ["", "Confidence tiers (picks, precision, exact precision):"]
    for matcher, s in results.items():
        tiers = ", ".join(
            f"{t} {n} ({_pct(right, n)}, exact {_pct(s.overall.tiers_exact.get(t, 0), n)})"
            for t, (n, right) in s.overall.tiers.items()
            if n
        )
        lines.append(f"  {matcher}: {tiers}, {s.calls} model calls, {s.seconds:.0f} s")
    failures = [f"  {m}: failed: {s.failed}" for m, s in results.items() if s.failed]
    if failures:
        lines += ["", "Failed matchers (scored as unmapped):", *failures]
    return "\n".join(lines)


def format_details(gold: Gold, results: dict[str, Scores], kinds: dict[str, str]) -> str:
    """One line per gold output: the gold's answer, then each matcher's pick (term, value as,
    class) marked ok or no, and class:ok or class:no where the gold names a class."""

    def terms(iris: Iterable[str]) -> str:
        return "/".join(sorted(_compact(i, gold.prefixes) for i in iris))

    lines = []
    for path, expected in gold.expected.items():
        want = "any" if expected.any_term else terms(expected.terms) or "unmapped"
        if expected.value_as:
            want += f" as {'/'.join(sorted(expected.value_as))}"
        if expected.row_class:
            want += f" class {terms(expected.row_class)}"
        parts = [f"{path or '(document)':<36} {kinds.get(path, 'field'):<8} gold {want}"]
        for matcher, s in results.items():
            pick = s.picks.get(path, Pick(None))
            got = _compact(pick.term, gold.prefixes) if pick.term else "unmapped"
            if pick.term and pick.value_as:
                got += f" as {pick.value_as}"
            chosen = _chosen_class(pick)
            if chosen:
                got += f" class {_compact(chosen, gold.prefixes)}"
            mark = "ok" if _right(pick, expected) else "no"
            if expected.row_class:
                mark += " class:ok" if chosen in expected.row_class else " class:no"
            if pick.term is not None:
                mark += f" · {pick.confidence}"
            parts.append(f"| {matcher}: {got} {mark}")
        lines.append(" ".join(parts))
    return "\n".join(lines)


def report_json(name: str, results: dict[str, Scores]) -> str:
    return json.dumps(
        {
            "gold": name,
            "matchers": {
                m: {
                    "overall": s.overall.summary(),
                    "byKind": {k: v.summary() for k, v in s.by_kind.items()},
                    "seconds": round(s.seconds, 1),
                    "calls": s.calls,
                    "failed": s.failed,
                }
                for m, s in results.items()
            },
        },
        indent=2,
    )


def _compact(iri: str, prefixes: dict[str, str]) -> str:
    for name, ns in sorted(prefixes.items(), key=lambda kv: -len(kv[1])):
        if iri.startswith(ns) and name not in CURIE_PREFIXES:
            return f"{name}:{iri[len(ns) :]}"
    for name, ns in CURIE_PREFIXES.items():
        if iri.startswith(ns):
            return f"{name}:{iri[len(ns) :]}"
    return iri


def gold_template(
    project: str, outputs: list[OutputSpec], picks: dict[str, Pick], prefixes: dict[str, str]
) -> str:
    """A gold file for an expert to correct: every output, described, with a matcher's pick."""
    lines = [
        f"# Gold mapping for {project}: correct each answer (a term, a list of acceptable terms,",
        "# or unmapped). Start from the proposal below; it is not the right answer until checked.",
        f"name: {project}",
        f"project: {project}",
        "prefixes:",
        *(f"  {k}: {v}" for k, v in sorted(prefixes.items()) if k not in CURIE_PREFIXES),
        "expected:",
    ]
    for o in outputs:
        what = "the whole document" if o.kind == "document" else f"{o.path} ({o.kind}, {o.type})"
        desc = f": {o.description}" if o.description else ""
        lines.append(f"  # {what}{desc}")
        pick = picks.get(o.path, Pick(None))
        key = "''" if o.path == "" else o.path
        if pick.term is None:
            lines.append(f"  {key}: unmapped")
        elif o.kind == "document":
            lines.append(f"  {key}: {_compact(pick.term, prefixes)}")
        elif o.kind == "table":
            row = f", class: {_compact(pick.row_class, prefixes)}" if pick.row_class else ""
            lines.append(f"  {key}: {{term: {_compact(pick.term, prefixes)}{row}}}")
        else:
            entity = (
                f", class: {_compact(pick.entity_class, prefixes)}" if pick.entity_class else ""
            )
            lines.append(
                f"  {key}: {{term: {_compact(pick.term, prefixes)}, as: {pick.value_as}{entity}}}"
            )
    return "\n".join(lines) + "\n"


# --- the deployment ---------------------------------------------------------------------------


class PgJobParams:
    def __init__(self, conn: Any) -> None:
        self._conn = conn

    @property
    def conn(self) -> Any:
        return self._conn

    def newest_mapping_params(self, project: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            """SELECT params FROM jobs
                WHERE task = 'draft' AND project_id = %s AND params->>'stage' = 'mapping'
                ORDER BY created_at DESC LIMIT 1""",
            (project,),
        ).fetchone()
        return dict(row[0]) if row else None


def _deployment() -> tuple[PipelineDeps, PgJobParams]:
    import os

    import psycopg

    from .linked_data import PgLinkedDataSettings
    from .llm.endpoints import LiveModels, PgLlmConfigStore
    from .ontology import PgOntologyStore
    from .pipeline import Buckets
    from .specs import SpecRegistry
    from .storage import MemoryObjectStore

    conn = psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)
    live = LiveModels(PgLlmConfigStore(conn), None)  # reads the stored config; seeds nothing
    deps = PipelineDeps(
        store=MemoryObjectStore(),  # the stage's result and model log stay in memory
        specs=SpecRegistry([]),
        models=live.registry,
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        ontologies=PgOntologyStore(conn),
        linked_data=PgLinkedDataSettings(conn),
        embedding_model=live.embedding_model,
    )
    return deps, PgJobParams(conn)


def _embedding(deps: PipelineDeps, params: DraftParams) -> Embedding | None:
    embedder = _embedder(_job(params), deps, _Quiet(), params.data_policy == "local", [])  # type: ignore[arg-type]
    if embedder is None:
        return None
    return Embedding(
        embedder.model_ref, lambda texts: embedder.provider.embed(embedder.model_id, texts)
    )


def main(argv: list[str] = sys.argv[1:]) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="python -m ingest_worker.mapping_eval")
    parser.add_argument("--gold", action="append", default=[])
    parser.add_argument("--template")
    parser.add_argument("--matcher", default="current,per-output")
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="per-output: ask each field and column twice (options reversed) for confidence",
    )
    parser.add_argument("--model", default="draft")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--details", action="store_true", help="each output's gold and picks")
    parser.add_argument(
        "--memory",
        choices=["none", "deployment", "self-loo"],
        default="none",
        help="mapping memory: the deployment's (the gold's own recipe left out), or the gold's "
        "own answers for other outputs like each one (leave one out); per-output and current",
    )
    args = parser.parse_args(argv)
    if not args.gold and not args.template:
        parser.print_help()
        return 2
    deps, rows = _deployment()
    if args.template:
        stub = Gold(args.template, args.template, None, dict(CURIE_PREFIXES), {})
        params = draft_params(stub, rows)
        picks = current_picks(deps, params, args.model)
        draft = params.draft or {}
        prefixes = (draft.get("semantics") or {}).get("prefixes") or {}
        print(gold_template(args.template, outputs_of(draft), picks, prefixes), end="")
        return 0
    matchers = [m.strip() for m in args.matcher.split(",") if m.strip()]
    for path in args.gold:
        with open(path, encoding="utf-8") as f:
            gold = load_gold(f.read())
        params = draft_params(gold, rows)
        kinds = {o.path: o.kind for o in outputs_of(params.draft or {})}
        store = deps.ontologies
        assert store is not None
        check_policy(deps, params, args.model)  # before any matcher calls the model
        unknown = [m for m in matchers if m not in ("current", "per-output")]
        if unknown:
            raise SystemExit(f"unknown matcher {', '.join(unknown)}")

        memory: Any = None
        remembered: dict[str, Pick] = {}
        if args.memory == "deployment":
            from .mapping_memory import PgMappingMemoryStore

            assert isinstance(rows, PgJobParams)
            memory = LeaveOneOutMemory(PgMappingMemoryStore(rows.conn), gold.project)
            remembered = memory_picks(memory, params, store)
        elif args.memory == "self-loo":
            remembered = self_loo_picks(gold, outputs_of(params.draft or {}))
        if args.memory != "none":
            print(
                f"Memory ({args.memory}): {len(remembered)} outputs pre-selected", file=sys.stderr
            )

        def run(
            matcher: str,
            calls: list[int],
            params: DraftParams = params,
            store: OntologyStore = store,
            memory: Any = memory,
            remembered: dict[str, Pick] = remembered,
        ) -> dict[str, Pick]:
            live = LiveProgress(matcher, lambda line: print(line, file=sys.stderr, flush=True))
            if matcher == "current":
                calls[0] = 1
                run_deps = replace(deps, mapping_memory=memory) if memory is not None else deps
                return current_picks(run_deps, params, args.model, live)
            choose = model_chooser(deps, params, args.model, calls, say=live.say)
            return per_output_picks(
                params, store, choose, _embedding(deps, params), confirm=args.confirm,
                remembered=remembered or None,
            )  # fmt: skip

        results = run_matchers(matchers, gold, kinds, run)
        print(report_json(gold.name, results) if args.json else format_report(gold.name, results))
        if args.details and not args.json:
            print()
            print(format_details(gold, results, kinds))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
