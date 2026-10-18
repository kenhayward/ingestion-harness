"""The mapping evaluation harness (spike, docs/design/mapping-automation.md): gold files, scores
per output kind, the mapping stage's answer read back as picks, and a report comparing matchers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.mapping_eval import (
    Expected,
    current_picks,
    draft_params,
    format_report,
    gold_template,
    load_gold,
    per_output_picks,
    picks_from_body,
    report_json,
    score,
)
from ingest_worker.mapping_match import ChoiceRequest, Pick
from ingest_worker.mapping_stage import outputs_of
from ingest_worker.ontology import parse_ontology

from .fakes import FakeProvider, MemoryOntologyStore
from .test_mapping_stage import FIXTURE, PH, blank

GOLD = Path(__file__).parent / "fixtures" / "mapping-gold" / "batch-record.yaml"


def gold() -> Any:
    return load_gold(GOLD.read_text("utf-8"))


def test_a_gold_file_expands_curies_and_reads_every_shape() -> None:
    g = gold()
    assert g.name == "batch-record (synthetic)" and g.project is None
    assert g.expected[""] == Expected(frozenset({f"{PH}BatchRecord"}))
    assert g.expected["lot"] == Expected(frozenset({f"{PH}batchNumber"}), value_as="literal")
    assert g.expected["notes"] == Expected(frozenset())  # unmapped is an answer
    assert g.expected["tests"].row_class == frozenset({f"{PH}TestResult"})
    assert g.expected["tests.ok"].terms == frozenset({f"{PH}conforms"})


@pytest.mark.parametrize(
    "text",
    [
        "expected: {}",  # neither project nor inputs
        "project: p\nexpected: {lot: {term: zz:nope}}",  # an undeclared prefix
        "project: p\nexpected: {lot: {as: blob}}",  # an unknown way to publish
    ],
)
def test_a_bad_gold_file_is_refused(text: str) -> None:
    with pytest.raises(ValueError):
        load_gold(text)


def kinds() -> dict[str, str]:
    draft = draft_params(gold(), None).draft
    assert draft is not None
    return {o.path: o.kind for o in outputs_of(draft)}


def test_scores_count_right_terms_unmapped_answers_tiers_and_recall() -> None:
    picks = {
        "": Pick(f"{PH}BatchRecord", "", "high", (f"{PH}BatchRecord",)),
        "lot": Pick(f"{PH}batchNumber", "literal", "high", (f"{PH}batchNumber",)),
        "expires": Pick(
            f"{PH}manufactureDate", "literal", "medium", (f"{PH}manufactureDate", f"{PH}expiryDate")
        ),
        "form": Pick(None, "literal", "low", ()),
        "notes": Pick(None, "literal", "low", ()),  # right: the gold leaves it unmapped
        "tests": Pick(
            f"{PH}hasResult", "entity", "high", (f"{PH}hasResult",), row_class=f"{PH}Batch"
        ),
        "tests.assay": Pick(f"{PH}testName", "entity", "medium", (f"{PH}testName",)),
        # tests.ok: no pick at all counts as unmapped
    }
    s = score(picks, gold(), kinds())
    overall = s.overall
    assert overall.outputs == 8
    assert overall.hit == 5  # document, lot, notes, tests, tests.assay
    assert overall.mapped == 5 and overall.mapped_right == 4  # expires is wrong
    assert overall.gold_mapped == 7
    assert overall.precision == pytest.approx(4 / 5)
    assert overall.recall == pytest.approx(4 / 7)
    # How the value is published counts where the gold says and the term is right: lot.
    assert overall.value_total == 1 and overall.value_right == 1
    assert overall.class_total == 1 and overall.class_right == 0
    assert overall.recall_at[1] == 4 and overall.recall_at[5] == 5  # expiryDate is 2nd
    assert overall.tiers["high"] == [3, 3] and overall.tiers["medium"] == [2, 1]
    assert s.by_kind["column"].outputs == 2


def test_the_stage_answer_reads_back_as_picks() -> None:
    body = {
        "notes": "",
        "changes": [
            {
                "op": "setDocumentMapping",
                "document": {"class": "ex:BatchRecord", "iri": "doc/{source}"},
                "ontologies": [],
                "prefixes": {"ex": PH},
                "confidence": "high",
            },
            {
                "op": "putFieldMapping",
                "field": "lot",
                "mapping": {"property": f"{PH}batchNumber"},
                "confidence": "medium",
            },
            {
                "op": "putFieldMapping",
                "field": "form",
                "mapping": {"property": "ex:dosageForm", "concepts": {"scheme": "ex:Forms"}},
            },
            {
                "op": "putTableMapping",
                "table": "tests",
                "mapping": {
                    "link": f"{PH}hasResult",
                    "class": f"{PH}TestResult",
                    "columns": {"assay": {"property": f"{PH}testName"}},
                },
                "confidence": "low",
            },
        ],
    }
    picks = picks_from_body(body, {})
    assert picks[""] == Pick(f"{PH}BatchRecord", "", "high")
    assert picks["lot"] == Pick(f"{PH}batchNumber", "literal", "medium")
    assert picks["form"].term == f"{PH}dosageForm" and picks["form"].value_as == "concept"
    assert picks["tests"] == Pick(f"{PH}hasResult", "entity", "low", row_class=f"{PH}TestResult")
    assert picks["tests.assay"].term == f"{PH}testName"


def store() -> MemoryOntologyStore:
    s = MemoryOntologyStore()
    s.saved[("pharma", 1)] = parse_ontology(FIXTURE.read_bytes(), "text/turtle", "o.ttl")
    return s


def test_the_mapping_stage_runs_as_a_matcher(fixture_specs_dir: Path) -> None:
    from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
    from ingest_worker.pipeline import Buckets, PipelineDeps
    from ingest_worker.storage import MemoryObjectStore

    provider = FakeProvider("drafter")
    provider.responses = [
        {
            "notes": "",
            "changes": [
                blank(
                    "setDocumentMapping",
                    documentClass=f"{PH}BatchRecord",
                    documentIri="doc/{source}",
                ),
                blank("putFieldMapping", "lot", property=f"{PH}batchNumber"),
            ],
        }
    ]
    config = ProviderConfig(name="drafter", kind="openai-chat", location="local")  # type: ignore[arg-type]
    deps = PipelineDeps(
        store=MemoryObjectStore(),
        specs={},
        models=ModelRegistry({"drafter": provider}, {"drafter": config}, {"draft": "drafter/big"}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        ontologies=store(),
    )
    params = draft_params(gold(), None)
    picks = current_picks(deps, params, "draft")
    assert picks[""].term == f"{PH}BatchRecord"
    assert picks["lot"].term == f"{PH}batchNumber"
    assert f"{PH}batchNumber" in picks["lot"].candidates  # the stage's own shortlist, for recall


def test_both_matchers_report_side_by_side() -> None:
    g = gold()
    params = draft_params(g, None)
    answers = {
        "": f"{PH}BatchRecord",
        "lot": f"{PH}batchNumber",
        "expires": f"{PH}expiryDate",
        "tests": f"{PH}hasResult",
        "tests#class": f"{PH}TestResult",
        "tests.assay": f"{PH}testName",
        "tests.ok": f"{PH}conforms",
    }

    def choose(request: ChoiceRequest) -> dict[str, str]:
        return {path: answers.get(path, "none") for path, _ in request.items}

    picks = per_output_picks(params, store(), choose, embed=None)
    scores = {"per-output": score(picks, g, kinds())}
    text = format_report(g.name, scores)
    assert "per-output" in text and "Hit@1" in text and "column" in text
    data = json.loads(report_json(g.name, scores))
    assert data["matchers"]["per-output"]["overall"]["hit"] >= 6


def test_a_gold_template_lists_every_output_with_a_matchers_picks() -> None:
    picks = {"": Pick(f"{PH}BatchRecord", ""), "lot": Pick(f"{PH}batchNumber", "literal")}
    text = gold_template(
        "demo", outputs_of(draft_params(gold(), None).draft or {}), picks, {"ex": PH}
    )
    again = load_gold(text)  # a template is a valid gold file once its project is right
    assert again.project == "demo"
    assert again.expected["lot"].terms == frozenset({f"{PH}batchNumber"})
    assert again.expected["notes"].terms == frozenset()  # no pick: unmapped, to check
    assert "# notes" in text  # each output says what it is, for the expert


@pytest.mark.parametrize(
    ("policy", "local_only", "refused"),
    [
        ("local", False, "data policy"),  # a local-only project never reaches an external model
        ("external", True, "local only"),  # nor does a local-only pinned ontology
        ("external", False, None),
    ],
)
def test_the_model_chooser_keeps_the_data_policy_before_any_call(
    policy: str, local_only: bool, refused: str | None
) -> None:
    from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
    from ingest_worker.mapping_eval import model_chooser
    from ingest_worker.pipeline import Buckets, DocumentError, PipelineDeps
    from ingest_worker.storage import MemoryObjectStore

    provider = FakeProvider("cloud")
    config = ProviderConfig(name="cloud", kind="openai-chat", location="external")  # type: ignore[arg-type]
    deps = PipelineDeps(
        store=MemoryObjectStore(),
        specs={},
        models=ModelRegistry({"cloud": provider}, {"cloud": config}, {"draft": "cloud/big"}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        ontologies=store(),
    )
    params = draft_params(gold(), None)
    mapping = dict(params.mapping or {})
    mapping["versions"] = [{**v, "localOnly": local_only} for v in mapping["versions"]]
    params = params.model_copy(update={"data_policy": policy, "mapping": mapping})
    if refused is None:
        model_chooser(deps, params, "draft", [0])
        return
    with pytest.raises(DocumentError, match=refused):
        model_chooser(deps, params, "draft", [0])
    assert provider.calls == []


def test_a_column_s_class_is_scored_and_any_link_property_may_be_accepted() -> None:
    """Class-centric ontologies (AFO, OBI) put the meaning in the class of the node a value sits
    on; the link to it is structural. A gold may then accept any link (`term: any`) and score the
    class: a field or column's `class` is its entity class (a table's, its row class)."""
    text = """
project: p
prefixes: {afr: "http://purl.allotrope.org/ontologies/result#"}
expected:
  t.water: {term: any, class: afr:AFR_0002445, as: entity}
  t.assay: {term: any, class: [afr:AFR_0000207, afr:AFR_0001602], as: entity}
"""
    g = load_gold(text)
    assert g.expected["t.water"].any_term
    picks = {
        "t.water": Pick(
            "https://x/hasPart",
            "entity",
            entity_class="http://purl.allotrope.org/ontologies/result#AFR_0002445",
        ),
        "t.assay": Pick("https://x/hasPart", "entity", entity_class="https://x/Other"),
    }
    s = score(picks, g, {"t.water": "column", "t.assay": "column"})
    assert s.overall.hit == 2  # any mapped link is a right term
    assert (s.overall.class_total, s.overall.class_right) == (2, 1)
    assert s.overall.value_total == 2 and s.overall.value_right == 2
    unmapped = score({}, g, {"t.water": "column", "t.assay": "column"})
    assert unmapped.overall.hit == 0 and unmapped.overall.class_right == 0
