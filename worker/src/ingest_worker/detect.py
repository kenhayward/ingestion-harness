"""Document type detection research (step 1): could a document's type be told from its text?

Scores a document against every candidate type with the type's own layout, exactly as
production prepares it (page range, copy selection, page markers, then `section_spans`), and
reports how the Workbench samples, whose type is known, would be detected. No model calls.

    python -m ingest_worker.detect [--published-only] [--json]

reads `DATABASE_URL` and the runs bucket (`S3_*`, `S3_BUCKET_RUNS`) and writes nothing.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Protocol

from .segment import PAGE_BREAK, section_spans, select_copy
from .specs import DocumentLayout
from .storage import ObjectStore, prepared_text_key

Status = Literal["published", "draft"]
Verdict = Literal["match", "ambiguous", "none"]
#: required: exactly one type matches all its distinctive required sections (production's own
#: check). coverage: the share of a type's distinctive sections found, required or not.
Rule = Literal["required", "coverage"]
RULES: tuple[Rule, ...] = ("required", "coverage")
#: The coverage rule's answer needs at least this share of the type's distinctive sections...
COVERAGE_MIN = 0.5
#: ...and every other type at least this far below it (else: ambiguous between them).
COVERAGE_MARGIN = 0.25
Outcome = Literal["correct", "ambiguous", "none", "wrong", "unscorable"]
OUTCOMES: tuple[Outcome, ...] = ("correct", "ambiguous", "none", "wrong", "unscorable")


@dataclass(frozen=True)
class Candidate:
    """A document type that detection may answer: one version's layout."""

    type_id: str
    version: int
    status: Status
    document: DocumentLayout
    page_markers: bool = False
    name: str = ""


@dataclass(frozen=True)
class TypeScore:
    type_id: str
    version: int
    page_fit: bool
    #: Required sections whose anchor can only match real text (not `\A` and the like).
    required_matched: int
    required_total: int
    optional_matched: int
    optional_total: int
    missing_required: list[str]
    error: str | None = None

    @property
    def vacuous(self) -> bool:
        """No informative required section: a full match would say nothing about the type."""
        return self.required_total == 0

    @property
    def full(self) -> bool:
        return (
            self.error is None
            and self.page_fit
            and not self.vacuous
            and self.required_matched == self.required_total
        )

    @property
    def coverage(self) -> float:
        """The share of the type's distinctive sections found (0 without any)."""
        total = self.required_total + self.optional_total
        return (self.required_matched + self.optional_matched) / total if total else 0.0

    def rank_key(self) -> tuple[bool, bool, float, int]:
        ratio = self.required_matched / self.required_total if self.required_total else 0.0
        return (self.full, self.page_fit, ratio, self.optional_matched)


@dataclass(frozen=True)
class Detection:
    verdict: Verdict
    #: The fully matching types, by type id.
    matches: list[str]
    #: Every candidate's score, best first.
    ranking: list[TypeScore]


def _informative(anchor: str) -> bool:
    """An anchor that matches empty text (`\\A`, `^`, `.*`) is no evidence of anything."""
    return re.search(anchor, "", re.MULTILINE) is None


def score_type(pages: list[str], candidate: Candidate) -> TypeScore:
    """How well `pages` (raw page text after OCR) fit one type's layout."""
    document = candidate.document
    fit = not document.pages or document.pages.min <= len(pages) <= document.pages.max
    try:
        kept = pages
        first = 0
        if document.copies:
            first, kept = select_copy(pages, document.copies)
        if candidate.page_markers:
            kept = [f"[page {first + 1 + i}]\n{text}" for i, text in enumerate(kept)]
        informative = {s.id: _informative(s.anchor) for s in document.sections}
        _, unmatched = section_spans(PAGE_BREAK.join(kept), document.sections)
    except re.error as exc:
        bad = next((s.id for s in document.sections if not _compiles(s.anchor)), "copies")
        return TypeScore(candidate.type_id, candidate.version, fit, 0, 0, 0, 0, [], f"{bad}: {exc}")
    missing = set(unmatched)
    required = [s for s in document.sections if s.required and informative[s.id]]
    optional = [s for s in document.sections if not s.required and informative[s.id]]
    return TypeScore(
        type_id=candidate.type_id,
        version=candidate.version,
        page_fit=fit,
        required_matched=sum(s.id not in missing for s in required),
        required_total=len(required),
        optional_matched=sum(s.id not in missing for s in optional),
        optional_total=len(optional),
        missing_required=[s.id for s in required if s.id in missing],
    )


def _compiles(pattern: str) -> bool:
    try:
        re.compile(pattern)
    except re.error:
        return False
    return True


def detect(pages: list[str], candidates: list[Candidate], rule: Rule = "required") -> Detection:
    """The type `pages` belong to: `match` only when one type stands out under `rule`."""
    scores = [score_type(pages, c) for c in candidates]
    if rule == "required":
        ranking = sorted(scores, key=TypeScore.rank_key, reverse=True)
        matches = sorted(s.type_id for s in ranking if s.full)
    else:
        ranking = sorted(
            scores, key=lambda s: (s.error is None and s.page_fit, s.coverage), reverse=True
        )
        fit = [s for s in ranking if s.error is None and s.page_fit and s.coverage >= COVERAGE_MIN]
        best = fit[0].coverage if fit else 0.0
        matches = sorted(s.type_id for s in fit if s.coverage >= best - COVERAGE_MARGIN)
    verdict: Verdict = "match" if len(matches) == 1 else "ambiguous" if matches else "none"
    return Detection(verdict, matches, ranking)


def candidate_from_definition(raw: dict[str, Any], status: Status) -> Candidate:
    """A candidate from a stored template (or legacy spec) definition. Only the `document`
    block is validated: a draft whose steps are still broken can still be told apart. Raises
    when that block is invalid."""
    from .template import TemplateDocument

    legacy = "extractions" in raw
    document = (DocumentLayout if legacy else TemplateDocument).model_validate(raw["document"])
    return Candidate(
        type_id=str(raw["id"]),
        version=int(raw["version"]),
        status=status,
        document=document,
        page_markers=isinstance(document, TemplateDocument) and document.page_markers,
        name=str(raw.get("title" if legacy else "name") or ""),
    )


# --- the research report ---------------------------------------------------------------------


@dataclass(frozen=True)
class LabelledSample:
    """A document whose type is known (a Workbench sample of that type's project)."""

    type_id: str
    name: str
    role: str
    pages: list[str]


@dataclass(frozen=True)
class SampleResult:
    type_id: str
    name: str
    role: str
    pages: int
    outcome: Outcome
    #: The fully matching types.
    detected: list[str]
    #: The labelled type's informative required sections that did not match.
    own_missing: list[str]
    own_page_fit: bool | None
    best: str | None


@dataclass(frozen=True)
class TypeRow:
    type_id: str
    status: str
    counts: dict[str, int]


@dataclass
class Report:
    candidates: list[Candidate]
    types: list[TypeRow]
    samples: list[SampleResult]
    #: (labelled type, other type) -> samples of the first that also fully matched the second.
    confusions: dict[tuple[str, str], int]
    #: Candidates no document can be detected as (no distinctive section the rule counts).
    uninformative: list[str]
    skipped: list[str] = field(default_factory=list)
    rule: Rule = "required"


def _outcome(type_id: str, detection: Detection, known: set[str]) -> Outcome:
    if type_id not in known:
        return "unscorable"
    if detection.verdict == "match":
        return "correct" if detection.matches == [type_id] else "wrong"
    return detection.verdict


def research_report(
    samples: list[LabelledSample],
    candidates: list[Candidate],
    skipped: list[str] | None = None,
    rule: Rule = "required",
) -> Report:
    known = {c.type_id for c in candidates}
    results: list[SampleResult] = []
    confusions: Counter[tuple[str, str]] = Counter()
    for sample in samples:
        detection = detect(sample.pages, candidates, rule)
        own = next((s for s in detection.ranking if s.type_id == sample.type_id), None)
        results.append(
            SampleResult(
                type_id=sample.type_id,
                name=sample.name,
                role=sample.role,
                pages=len(sample.pages),
                outcome=_outcome(sample.type_id, detection, known),
                detected=detection.matches,
                own_missing=own.missing_required if own else [],
                own_page_fit=own.page_fit if own else None,
                best=detection.ranking[0].type_id if detection.ranking else None,
            )
        )
        for other in detection.matches:
            if other != sample.type_id:
                confusions[(sample.type_id, other)] += 1

    status = {c.type_id: c.status for c in candidates}
    rows: list[TypeRow] = []
    for type_id in sorted({s.type_id for s in samples}):
        mine = [r for r in results if r.type_id == type_id]
        counts: dict[str, int] = {o: sum(r.outcome == o for r in mine) for o in OUTCOMES}
        counts["samples"] = len(mine)
        rows.append(TypeRow(type_id, status.get(type_id, "not a candidate"), counts))
    empty = {c.type_id: score_type([""], c) for c in candidates}
    uninformative = sorted(
        t
        for t, s in empty.items()
        if (s.vacuous if rule == "required" else s.required_total + s.optional_total == 0)
    )
    return Report(candidates, rows, results, dict(confusions), uninformative, skipped or [], rule)


def coverage_matrix(
    samples: list[LabelledSample], candidates: list[Candidate]
) -> dict[tuple[str, str], list[float]]:
    """(labelled type, candidate) -> the candidate's coverage of each sample of that type."""
    matrix: dict[tuple[str, str], list[float]] = {}
    for sample in samples:
        for candidate in candidates:
            score = score_type(sample.pages, candidate)
            matrix.setdefault((sample.type_id, candidate.type_id), []).append(score.coverage)
    return matrix


def format_matrix(matrix: dict[tuple[str, str], list[float]]) -> str:
    """Mean (min-max) coverage: rows are the samples' labelled types, columns the candidates."""
    rows = sorted({a for a, _ in matrix})
    cols = sorted({b for _, b in matrix})
    out = []
    for b in cols:
        out.append(f"scored as {b}:")
        for a in rows:
            v = matrix.get((a, b), [])
            if v:
                mean = sum(v) / len(v)
                out.append(f"  {a:<40} {mean:.2f} ({min(v):.2f}-{max(v):.2f}), n={len(v)}")
    return "\n".join(out)


def format_report(report: Report) -> str:
    out: list[str] = []
    total = Counter[str]()
    for row in report.types:
        total.update(row.counts)
    scored = total["samples"] - total["unscorable"]
    out.append(
        f"Rule: {report.rule}. "
        f"{len(report.candidates)} candidate types, {total['samples']} labelled samples "
        f"({scored} of types that are candidates)"
    )
    if scored:
        out.append(
            "  "
            + ", ".join(
                f"{o} {total[o]} ({100 * total[o] / scored:.0f}%)"
                for o in ("correct", "ambiguous", "none", "wrong")
            )
        )
    out.append("")
    header = f"{'type':<32} {'status':<16} {'n':>4} {'ok':>4} {'amb':>4} {'none':>4} {'wrong':>5}"
    out += ["Per type (labelled type of the sample):", header, "-" * len(header)]
    for row in report.types:
        c = row.counts
        out.append(
            f"{row.type_id:<32} {row.status:<16} {c['samples']:>4} {c['correct']:>4} "
            f"{c['ambiguous']:>4} {c['none']:>4} {c['wrong']:>5}"
        )
    if report.confusions:
        out += ["", "Also fully matched (labelled type -> other type: samples):"]
        for (a, b), n in sorted(report.confusions.items(), key=lambda kv: (-kv[1], kv[0])):
            out.append(f"  {a} -> {b}: {n}")
    if report.uninformative:
        out += [
            "",
            "Types with no distinctive section this rule counts (never detected): "
            + ", ".join(report.uninformative),
        ]
    misses = [r for r in report.samples if r.outcome not in ("correct", "unscorable")]
    if misses:
        out += ["", "Samples not detected as their type:"]
        for r in misses:
            why = []
            if r.type_id in report.uninformative:
                why.append("the type has no distinctive section this rule counts")
            if r.own_page_fit is False:
                why.append("page count outside the type's range")
            if r.own_missing and report.rule == "required":
                why.append("own required sections missing: " + ", ".join(r.own_missing))
            if r.detected:
                why.append("fully matched: " + ", ".join(r.detected))
            out.append(
                f"  [{r.outcome}] {r.type_id} / {r.name} ({r.role}, {r.pages} p): " + "; ".join(why)
            )
    if report.skipped:
        out += ["", "Skipped:"] + [f"  {s}" for s in report.skipped]
    return "\n".join(out)


def report_json(reports: list[Report], matrix: dict[tuple[str, str], list[float]]) -> str:
    return json.dumps(
        {
            "rules": [
                {
                    "rule": r.rule,
                    "types": [asdict(t) for t in r.types],
                    "samples": [asdict(s) for s in r.samples],
                    "confusions": [
                        {"type": a, "other": b, "samples": n} for (a, b), n in r.confusions.items()
                    ],
                    "uninformative": r.uninformative,
                }
                for r in reports
            ],
            "coverage": [{"type": a, "scoredAs": b, "coverage": v} for (a, b), v in matrix.items()],
            "skipped": reports[0].skipped if reports else [],
        },
        indent=2,
    )


# --- loading the corpus ------------------------------------------------------------------------


class CorpusRows(Protocol):
    def templates(self) -> list[tuple[str, int, str, dict[str, Any]]]:
        """(id, version, status, definition) of every template version."""
        ...

    def samples(self) -> list[tuple[str, str, str, str]]:
        """(project id = type id, filename, role, sha256) of every Workbench sample."""
        ...


def load_corpus(
    rows: CorpusRows, store: ObjectStore, runs_bucket: str, published_only: bool = False
) -> tuple[list[Candidate], list[LabelledSample], list[str]]:
    """Candidates (each type's newest published version, else, unless `published_only`, its
    newest draft) and the samples whose text is prepared, plus what was skipped and why."""
    skipped: list[str] = []
    chosen: dict[str, tuple[bool, int, str, dict[str, Any]]] = {}
    for type_id, version, status, definition in rows.templates():
        published = status == "published"
        if published_only and not published:
            continue
        key = (published, version)
        if type_id not in chosen or key > chosen[type_id][:2]:
            chosen[type_id] = (published, version, status, definition)
    candidates: list[Candidate] = []
    for type_id in sorted(chosen):
        _, version, status, definition = chosen[type_id]
        try:
            candidates.append(
                candidate_from_definition(
                    definition, "published" if status == "published" else "draft"
                )
            )
        except Exception as exc:  # an invalid draft: say so and leave it out
            skipped.append(
                f"type {type_id} v{version}: invalid document block ({str(exc).splitlines()[0]})"
            )

    samples: list[LabelledSample] = []
    for type_id, name, role, sha256 in rows.samples():
        body = store.get_optional(runs_bucket, prepared_text_key(sha256))
        if body is None:
            skipped.append(f"sample {type_id} / {name}: not prepared")
            continue
        pages = [str(p.get("text", "")) for p in json.loads(body)["pages"]]
        samples.append(LabelledSample(type_id, name, role, pages))
    return candidates, samples, skipped


class PgCorpusRows:
    """Read-only queries over the templates and Workbench samples."""

    def __init__(self, database_url: str) -> None:
        import psycopg

        self._conn = psycopg.connect(database_url, autocommit=True)

    def templates(self) -> list[tuple[str, int, str, dict[str, Any]]]:
        rows = self._conn.execute(
            "SELECT id, version, status, definition FROM templates ORDER BY id, version"
        ).fetchall()
        return [(r[0], r[1], r[2], r[3]) for r in rows]

    def samples(self) -> list[tuple[str, str, str, str]]:
        rows = self._conn.execute(
            "SELECT s.project_id, d.filename, s.role, d.sha256 FROM workbench_samples s "
            "JOIN documents d ON d.id = s.document_id ORDER BY s.project_id, d.filename"
        ).fetchall()
        return [(r[0], r[1], r[2], r[3]) for r in rows]

    def close(self) -> None:
        self._conn.close()


def main(argv: list[str] = sys.argv[1:]) -> int:
    import os

    from .storage import S3ObjectStore

    unknown = [a for a in argv if a not in ("--published-only", "--json")]
    if unknown:
        print(__doc__)
        return 2
    env = os.environ
    rows = PgCorpusRows(env["DATABASE_URL"])
    store = S3ObjectStore(
        env["S3_ENDPOINT"],
        env.get("S3_REGION", "us-east-1"),
        env["S3_ACCESS_KEY"],
        env["S3_SECRET_KEY"],
    )
    try:
        candidates, samples, skipped = load_corpus(
            rows, store, env.get("S3_BUCKET_RUNS", "ingest-runs"), "--published-only" in argv
        )
    finally:
        rows.close()
    reports = [research_report(samples, candidates, skipped, rule) for rule in RULES]
    matrix = coverage_matrix(samples, candidates)
    if "--json" in argv:
        print(report_json(reports, matrix))
        return 0
    for report in reports:
        print(format_report(report), end="\n\n")
    print("Coverage of each type's distinctive sections, mean (min-max):")
    print(format_matrix(matrix))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
