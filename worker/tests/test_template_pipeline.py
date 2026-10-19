"""Running a template end to end with fakes: fields (atoms), a chunked table, normalisation,
issues, page markers and the review flag."""

from __future__ import annotations

import csv
import hashlib
import io
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
import yaml
from rdflib import RDFS, Graph, Literal, URIRef

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps, Target, mark_pages
from ingest_worker.queue import ClaimedJob
from ingest_worker.rdf import CT
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore

from .fakes import (
    BucketView,
    FakeBridge,
    FakeProvider,
    FakeQueue,
    FakeTargets,
    MemoryLinkedDataSettings,
)

TEMPLATE = {
    "id": "demo",
    "version": 1,
    "name": "Demo document",
    "preamble": "You read demo documents.",
    "document": {
        "sections": [{"id": "head", "anchor": r"\A"}, {"id": "body", "anchor": "^BODY"}],
    },
    "outputs": {
        "fields": [
            {"id": "product", "type": "text", "description": "Medicinal product name"},
            {"id": "executed_on", "type": "date"},
            {"id": "kind", "type": "enum", "enum": ["protocol", "report"]},
        ],
        "tables": [
            {
                "id": "results",
                "columns": [
                    {"id": "batch", "type": "text"},
                    {"id": "value", "type": "decimal"},
                    {"id": "aliases", "type": "list"},
                ],
            }
        ],
    },
    "pipeline": [
        {"type": "extract", "id": "header", "fields": ["product", "kind"], "sections": ["head"]},
        {
            "type": "extract",
            "id": "date",
            "fields": ["executed_on"],
            "sections": ["head"],
            "instructions": "The execution date is the date the first batch was made.",
        },
        {
            "type": "extract",
            "id": "data",
            "table": "results",
            "sections": ["body"],
            "chunkPages": 1,
        },
        {
            "type": "check",
            "id": "batch_check",
            "values": "results.batch",
            "reference": "results.batch",
        },
    ],
}

PAGES = ["Product: Richfer capsules\nMade 16/02/2023", "BODY\nG1 137·8", "G2 Complies"]

RESPONSES = [
    {
        "product": {
            "value": "Richfer capsules",
            "evidence": "Product: Richfer capsules",
            "page": 1,
        },
        "kind": {"value": "protocol", "evidence": None, "page": None},
    },
    {"executed_on": {"value": "16/02/2023", "evidence": "Made 16/02/2023", "page": 1}},
    {"rows": [{"batch": "G1", "value": "137·8", "aliases": []}]},
    {"rows": [{"batch": "G2", "value": "Complies", "aliases": ["G-2"]}]},
]

JOB = ClaimedJob(
    "job-1",
    "doc-1",
    "demo",
    1,
    "inbox",
    "demo/v1/doc-1.pdf",
    None,
    1,
    3,
    source_sha256=hashlib.sha256(b"%PDF").hexdigest(),
)


@pytest.fixture
def run(tmp_path: Path):  # type: ignore[no-untyped-def]
    return run_job(tmp_path, JOB)


def run_job(tmp_path: Path, job: ClaimedJob):  # type: ignore[no-untyped-def]
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(TEMPLATE), encoding="utf-8")
    provider = FakeProvider("local", responses=list(RESPONSES))
    store = MemoryObjectStore()
    store.put("inbox", job.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": provider},
            {"local": ProviderConfig(name="local", kind="openai-chat")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    queue = FakeQueue(jobs=[job])
    run_once(queue, deps, "w1")
    return provider, store, queue


def read_csv(store: MemoryObjectStore, key: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(store.get("outputs", key).decode("utf-8-sig"))))


def test_job_completes_with_one_call_per_step_and_chunk(run) -> None:  # type: ignore[no-untyped-def]
    provider, _, queue = run
    # the 'Complies' normalisation issue means the draft waits for review (see test_review.py)
    assert queue.awaiting and not queue.finished, queue.reviewed or queue.failed
    assert len(provider.calls) == 4


def test_fields_are_normalised_into_one_wide_row(run) -> None:  # type: ignore[no-untyped-def]
    _, store, _ = run
    assert read_csv(store, "demo/v1/fields/doc-1.csv") == [
        {
            "document_id": "doc-1",
            "product": "Richfer capsules",
            "executed_on": "2023-02-16",
            "kind": "protocol",
        }
    ]


def test_table_rows_are_merged_across_chunks_and_normalised(run) -> None:  # type: ignore[no-untyped-def]
    _, store, _ = run
    rows = read_csv(store, "demo/v1/results/doc-1.csv")
    assert [(r["batch"], r["value"], r["aliases"]) for r in rows] == [
        ("G1", "137.8", "[]"),
        ("G2", "Complies", '["G-2"]'),
    ]


def test_unparseable_values_are_kept_and_listed_as_issues(run) -> None:  # type: ignore[no-untyped-def]
    _, store, queue = run
    [issue] = read_csv(store, "demo/v1/issues/doc-1.csv")
    assert (issue["step"], issue["target"], issue["row"], issue["column"], issue["raw"]) == (
        "data",
        "results",
        "2",
        "value",
        "Complies",
    )
    assert any(msg == "review required" for _, _, msg in queue.events)


def test_document_json_carries_evidence_checks_and_review_flag(run) -> None:  # type: ignore[no-untyped-def]
    _, store, _ = run
    doc = json.loads(store.get("outputs", "demo/v1/document/doc-1.json"))
    assert doc["fields"]["product"] == {
        "value": "Richfer capsules",
        "evidence": "Product: Richfer capsules",
        "page": 1,
    }
    assert doc["fields"]["kind"]["value"] == "protocol"
    assert len(doc["tables"]["results"]) == 2
    assert doc["checks"]["batch_check"]["rows"]
    assert doc["review_required"] is True and doc["review_reasons"] == ["1 normalisation issue(s)"]
    assert doc["template"] == {"id": "demo", "version": 1, "name": "Demo document"}


def test_prompts_carry_page_markers_definitions_and_instructions(run) -> None:  # type: ignore[no-untyped-def]
    provider, _, _ = run
    header, date, chunk1, chunk2 = (req.prompt for _, req in provider.calls)
    assert "You read demo documents." in header
    assert "[page 1]" in header and "Medicinal product name" in header
    assert "The execution date is the date the first batch was made." in date
    assert "[page 2]" in chunk1 and "[page 3]" not in chunk1
    assert "page 2 of 2" in chunk2


def test_every_step_prompt_names_the_source_file(tmp_path: Path) -> None:
    """So a step can fill an output like the originating file name (no section holds it)."""
    job = replace(JOB, filename="TV-TEC-227036_New.docx")
    provider, _, _ = run_job(tmp_path, job)
    prompts = [req.prompt for _, req in provider.calls]
    assert len(prompts) == 4
    assert all('The source file is named "TV-TEC-227036_New.docx".' in p for p in prompts)


def test_without_a_file_name_the_prompt_does_not_mention_one(run) -> None:  # type: ignore[no-untyped-def]
    provider, _, _ = run
    assert not any("source file" in req.prompt for _, req in provider.calls)


def test_mark_pages_uses_original_page_numbers() -> None:
    assert mark_pages(["a", "b"], first_page=32) == ["[page 32]\na", "[page 33]\nb"]


def test_page_previews_are_saved_for_the_review_screen(tmp_path: Path) -> None:
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(TEMPLATE), encoding="utf-8")
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    previews: list[int] = []
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": FakeProvider("local", responses=list(RESPONSES))},
            {"local": ProviderConfig(name="local", kind="openai-chat")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
        render_preview=lambda pdf, index: (
            previews.append(index) or b"\xff\xd8jpeg" + bytes([index])
        ),  # type: ignore[func-returns-value]
    )
    run_once(FakeQueue(jobs=[JOB]), deps, "w1")

    assert previews == [0, 1, 2]
    assert store.get("runs", "job-1/pages/page-1.jpg") == b"\xff\xd8jpeg\x00"
    assert ("runs", "job-1/pages/page-3.jpg") in store.objects
    doc = json.loads(store.get("outputs", "demo/v1/document/doc-1.json"))
    assert doc["page_count"] == 3


def test_render_preview_jpeg_from_a_real_pdf() -> None:
    import pypdfium2 as pdfium
    from PIL import Image

    from ingest_worker.ocr import render_preview_jpeg

    doc = pdfium.PdfDocument.new()
    doc.new_page(612, 792)
    buf = io.BytesIO()
    doc.save(buf)
    image = Image.open(io.BytesIO(render_preview_jpeg(buf.getvalue(), 0)))
    assert image.format == "JPEG" and max(image.size) == 1400


def test_preview_failures_do_not_fail_the_job(run) -> None:  # type: ignore[no-untyped-def]
    """The default renderer can't read the fake '%PDF' bytes used here: the job still runs."""
    _, store, queue = run
    assert queue.awaiting and not queue.failed
    assert any(msg == "page previews unavailable" for _, _, msg in queue.events)
    assert not any(key.startswith("job-1/pages/") for _, key in store.objects)


def test_template_csvs_have_a_bom_and_a_utf8_content_type(run) -> None:  # type: ignore[no-untyped-def]
    _, store, _ = run
    csvs = [(k, v) for (b, k), v in store.objects.items() if b == "outputs" and k.endswith(".csv")]
    assert csvs
    for key, (body, content_type) in csvs:
        assert body.startswith(b"\xef\xbb\xbf"), key
        assert content_type == "text/csv; charset=utf-8", key


# --- RDF: graph output and delivered formats (ADR 0011) ---------------------------------------

SEMANTICS = {
    "prefixes": {"ex": "https://ex.example/def/"},
    "document": {"class": "ex:Protocol"},
    "fields": {"product": {"property": "ex:product"}},
}
GRAPH_KEY = "demo/v1/graph/doc-1.ttl"
BASE_IRI = "https://data.acme.example/"


def mapped_deps(
    tmp_path: Path, template: dict[str, Any], base: str | None
) -> tuple[PipelineDeps, FakeBridge]:
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(template), encoding="utf-8")
    store, target = MemoryObjectStore(), FakeBridge({"default": ("published", "pvp/")})
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": FakeProvider("local", responses=list(RESPONSES))},
            {"local": ProviderConfig(name="local", kind="openai-chat")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
        targets=FakeTargets({"default": Target("default", "published", "pvp/")}),
        bridge=target,
        linked_data=MemoryLinkedDataSettings(base),
    )
    return deps, target


def run_mapped(
    tmp_path: Path, template: dict[str, Any], base: str | None
) -> tuple[MemoryObjectStore, FakeBridge, FakeQueue]:
    deps, target = mapped_deps(tmp_path, template, base)
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert isinstance(deps.store, MemoryObjectStore)
    return deps.store, target, queue


def has(store: MemoryObjectStore | FakeBridge | BucketView, bucket: str, key: str) -> bool:
    return (bucket, key) in store.objects


def mapped(**extra: Any) -> dict[str, Any]:
    return {**TEMPLATE, "review": {"required": "never"}, "semantics": SEMANTICS, **extra}


def test_a_mapped_recipe_drafts_a_turtle_graph(tmp_path: Path) -> None:
    store, _, queue = run_mapped(tmp_path, mapped(), "https://data.acme.example/")
    assert store.objects[("outputs", GRAPH_KEY)][1] == "text/turtle"
    sha = hashlib.sha256(b"%PDF").hexdigest()
    graph = Graph().parse(data=store.get("outputs", GRAPH_KEY), format="turtle")
    doc = URIRef(f"https://data.acme.example/doc/{sha}")
    assert (doc, URIRef("https://ex.example/def/product"), Literal("Richfer capsules")) in graph
    [(_, drafts)] = queue.drafts
    assert "rdf" in {o.format for o in drafts}


def test_without_a_base_the_graph_is_skipped(tmp_path: Path) -> None:
    store, _, queue = run_mapped(tmp_path, mapped(), None)
    assert not has(store, "outputs", GRAPH_KEY)
    assert any(e[2].startswith("graph skipped") for e in queue.events)
    assert queue.finished


def test_delivery_formats_choose_what_is_published(tmp_path: Path) -> None:
    _, target, queue = run_mapped(
        tmp_path, mapped(delivery={"formats": ["json", "rdf"]}), "https://data.acme.example/"
    )
    [(_, published, _)] = queue.published
    assert {o.format for o in published} == {"json", "rdf"}
    assert has(target, "published", "pvp/" + GRAPH_KEY)
    assert not has(target, "published", "pvp/demo/v1/fields/doc-1.csv")


def test_the_graph_is_drafted_but_not_delivered_by_default(tmp_path: Path) -> None:
    store, target, _ = run_mapped(tmp_path, mapped(), "https://data.acme.example/")
    assert has(store, "outputs", GRAPH_KEY)
    assert not has(target, "published", "pvp/" + GRAPH_KEY)
    assert has(target, "published", "pvp/demo/v1/fields/doc-1.csv")


def test_a_recipe_without_semantics_is_unchanged(tmp_path: Path) -> None:
    template = {**TEMPLATE, "review": {"required": "never"}}
    store, _, queue = run_mapped(tmp_path, template, "https://data.acme.example/")
    assert not has(store, "outputs", GRAPH_KEY)
    assert not any(e[2].startswith("graph") for e in queue.events)
    [(_, published, _)] = queue.published
    assert {o.format for o in published} == {"csv", "json"}


# --- review fixes: graph failures never cost CSV/JSON; RDF-only needs a base -------------------

BAD_BASE = "https://data.acme.example/my ids/"  # a space: rdflib cannot serialise its IRIs


def test_a_graph_that_cannot_be_rendered_leaves_csv_and_json_delivered(tmp_path: Path) -> None:
    store, target, queue = run_mapped(tmp_path, mapped(), BAD_BASE)
    assert queue.finished and not queue.reviewed and not queue.failed
    assert not has(store, "outputs", GRAPH_KEY)
    assert has(target, "published", "pvp/demo/v1/fields/doc-1.csv")
    assert any(e[2].startswith("graph failed") for e in queue.events)


def test_a_delivered_graph_that_cannot_be_rendered_goes_to_review(tmp_path: Path) -> None:
    _, target, queue = run_mapped(tmp_path, mapped(delivery={"formats": ["json", "rdf"]}), BAD_BASE)
    [(_, reason)] = queue.reviewed
    assert reason.startswith("cannot render the graph")
    assert not target.objects


def test_a_document_iri_template_that_names_nothing_is_a_graph_failure(tmp_path: Path) -> None:
    semantics = {**SEMANTICS, "document": {"class": "ex:Protocol", "iri": "p/{protocol}"}}
    store, _, queue = run_mapped(tmp_path, mapped(semantics=semantics), BASE_IRI)
    assert queue.finished and not has(store, "outputs", GRAPH_KEY)
    assert any(e[2].startswith("graph failed") for e in queue.events)


def test_rdf_only_delivery_without_a_base_goes_to_review(tmp_path: Path) -> None:
    _, target, queue = run_mapped(tmp_path, mapped(delivery={"formats": ["rdf"]}), None)
    [(_, reason)] = queue.reviewed
    assert "set the customer under Administration > Linked data" in reason
    assert not target.objects and not queue.finished


ENTITY = {
    **SEMANTICS,
    "fields": {
        "product": {
            "property": "ex:product",
            "object": {"class": "ex:Product", "iri": "product/{value|slug}"},
        }
    },
}


def test_approval_publishes_the_graph_of_the_reviewed_document(tmp_path: Path) -> None:
    template = {
        **TEMPLATE,
        "review": {"required": "always"},
        "semantics": ENTITY,
        "delivery": {"formats": ["json", "rdf"]},
    }
    deps, target = mapped_deps(tmp_path, template, BASE_IRI)
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert queue.awaiting
    queue.jobs = [replace(JOB, task="publish")]
    queue.edits["job-1"] = [
        {
            "field": "product",
            "table": None,
            "row": None,
            "column": None,
            "value": "Ferric capsules",
            "editor": "kh",
            "reason": "misread",
            "at": "2026-10-14T10:00:00Z",
        }
    ]
    queue.decisions["job-1"] = {
        "reviewer": "kh",
        "note": None,
        "reviewed_at": "2026-10-14T10:05:00Z",
    }
    run_once(queue, deps, "w1")

    assert queue.finished
    [(_, published, _)] = queue.published
    assert {o.format for o in published} == {"json", "rdf"}
    assert not has(target, "published", "pvp/demo/v1/fields/doc-1.csv")
    graph = Graph().parse(data=target.get("published", "pvp/" + GRAPH_KEY), format="turtle")
    corrected = URIRef(f"{BASE_IRI}product/ferric-capsules")
    sha = hashlib.sha256(b"%PDF").hexdigest()
    doc = URIRef(f"{BASE_IRI}doc/{sha}")
    assert (doc, URIRef("https://ex.example/def/product"), corrected) in graph
    assert (corrected, RDFS.label, Literal("Ferric capsules")) in graph
    assert not list(graph.subjects(RDFS.label, Literal("Richfer capsules")))
    assert (URIRef(f"{BASE_IRI}job/job-1"), URIRef(f"{CT}reviewedBy"), Literal("kh")) in graph


def test_approving_an_old_draft_without_a_mapping_never_reads_the_inbox(tmp_path: Path) -> None:
    template = {**TEMPLATE, "review": {"required": "always"}}
    deps, target = mapped_deps(tmp_path, template, BASE_IRI)
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    store = deps.store
    assert isinstance(store, MemoryObjectStore)
    key = ("outputs", "demo/v1/document/doc-1.json")
    draft = json.loads(store.objects[key][0])
    del draft["source_sha256"]  # drafted before graphs existed
    store.put("outputs", key[1], json.dumps(draft).encode(), "application/json")
    store.delete("inbox", JOB.object_key)
    queue.jobs = [replace(JOB, task="publish")]
    run_once(queue, deps, "w1")
    assert queue.finished and not queue.failed
    assert has(target, "published", "pvp/demo/v1/fields/doc-1.csv")


# --- SHACL (ADR 0011 step 5) ----------------------------------------------------------------

SHAPES_NT = (
    Graph()
    .parse(
        data="""@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <https://ex.example/def/> .
    ex:ProtocolShape a sh:NodeShape ; sh:targetClass ex:Protocol ;
      sh:property [ sh:path ex:product ; sh:maxLength 5 ; sh:message "a product code is short" ] .""",
        format="turtle",
    )
    .serialize(format="nt", encoding="utf-8")
)
SHAPED = {**SEMANTICS, "shapes": [{"id": "ex-shapes", "version": 1}]}


def with_shapes(deps: PipelineDeps) -> PipelineDeps:
    from ingest_worker.storage import ontology_normalized_key

    deps.store.put(
        "runs", ontology_normalized_key("ex-shapes", 1), SHAPES_NT, "application/n-triples"
    )
    return deps


def test_a_shapes_violation_is_a_review_reason_and_the_report_is_kept(tmp_path: Path) -> None:
    deps, _ = mapped_deps(tmp_path, mapped(semantics=SHAPED), BASE_IRI)
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, with_shapes(deps), "w1")
    [(_, _, reasons)] = queue.awaiting
    assert "SHACL: ProtocolShape on product: a product code is short" in reasons
    report = json.loads(deps.store.get("runs", "job-1/shacl-report.json"))
    assert report["conforms"] is False
    assert report["results"][0]["output"] == "product"
    document = json.loads(deps.store.get("outputs", "demo/v1/document/doc-1.json"))
    assert "SHACL: ProtocolShape on product: a product code is short" in document["review_reasons"]


def test_without_a_graph_nothing_is_validated(tmp_path: Path) -> None:
    deps, _ = mapped_deps(tmp_path, mapped(semantics=SHAPED), None)
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, with_shapes(deps), "w1")
    assert queue.finished and not queue.awaiting
    assert ("runs", "job-1/shacl-report.json") not in deps.store.objects  # type: ignore[attr-defined]


def test_missing_shapes_send_the_job_to_review(tmp_path: Path) -> None:
    deps, _ = mapped_deps(tmp_path, mapped(semantics=SHAPED), BASE_IRI)
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")  # the shapes version's file was never stored
    [(_, reason)] = queue.reviewed
    assert "ex-shapes v1 is not available" in reason


def shaped_review(tmp_path: Path, formats: list[str]) -> tuple[PipelineDeps, FakeBridge, FakeQueue]:
    template = {
        **TEMPLATE,
        "review": {"required": "always"},
        "semantics": SHAPED,
        "delivery": {"formats": formats},
    }
    deps, target = mapped_deps(tmp_path, template, BASE_IRI)
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, with_shapes(deps), "w1")
    assert queue.awaiting
    queue.jobs = [replace(JOB, task="publish")]
    queue.decisions["job-1"] = {
        "reviewer": "kh",
        "note": None,
        "reviewed_at": "2026-10-14T10:05:00Z",
    }
    return deps, target, queue


def product_edit(value: str) -> dict[str, Any]:
    return {
        "field": "product", "table": None, "row": None, "column": None, "value": value,
        "editor": "kh", "reason": None, "at": "2026-10-14T10:00:00Z",
    }  # fmt: skip


def test_a_publish_that_delivers_rdf_is_refused_while_the_graph_violates_shapes(
    tmp_path: Path,
) -> None:
    deps, target, queue = shaped_review(tmp_path, ["json", "rdf"])
    run_once(queue, deps, "w1")
    assert not queue.finished and not queue.published and not target.objects
    (_, outputs, reasons) = queue.awaiting[-1]
    assert len(queue.awaiting) == 2 and outputs == []
    assert "SHACL: ProtocolShape on product: a product code is short" in reasons
    assert any(e[2] == "publish refused: graph violates shapes" for e in queue.events)


def test_after_an_edit_that_fixes_the_value_the_publish_goes_through(tmp_path: Path) -> None:
    deps, target, queue = shaped_review(tmp_path, ["json", "rdf"])
    queue.edits["job-1"] = [product_edit("Rich")]
    run_once(queue, deps, "w1")
    assert queue.finished
    assert has(target, "published", "pvp/" + GRAPH_KEY)


def test_without_rdf_delivered_a_violation_never_stops_the_publish(tmp_path: Path) -> None:
    deps, target, queue = shaped_review(tmp_path, ["csv", "json"])
    run_once(queue, deps, "w1")
    assert queue.finished
    assert has(target, "published", "pvp/demo/v1/fields/doc-1.csv")
    assert any(e[2] == "graph violates shapes" for e in queue.events)


WARNING_NT = (
    Graph()
    .parse(
        data="""@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <https://ex.example/def/> .
    ex:ProtocolShape a sh:NodeShape ; sh:targetClass ex:Protocol ;
      sh:property [ sh:path ex:product ; sh:maxLength 5 ; sh:severity sh:Warning ] .""",
        format="turtle",
    )
    .serialize(format="nt", encoding="utf-8")
)


def test_a_step_rerun_replaces_the_shacl_issues_instead_of_counting_them(tmp_path: Path) -> None:
    from ingest_worker.storage import ontology_normalized_key

    deps, _ = mapped_deps(tmp_path, mapped(semantics=SHAPED), BASE_IRI)
    deps.store.put("runs", ontology_normalized_key("ex-shapes", 1), WARNING_NT, "text/plain")
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    for _ in range(2):
        deps.models._providers["local"].responses = [RESPONSES[0]]  # type: ignore[attr-defined]
        queue.jobs = [replace(JOB, task="rerun", rerun={"step": "header"})]
        run_once(queue, deps, "w1")
    document = json.loads(deps.store.get("outputs", "demo/v1/document/doc-1.json"))
    assert [i["step"] for i in document["issues"]].count("shacl") == 1
    assert not any("normalisation issue" in r for r in document["review_reasons"])


def test_a_publish_without_rdf_needs_no_shapes_file(tmp_path: Path) -> None:
    from ingest_worker.storage import ontology_normalized_key

    deps, target, queue = shaped_review(tmp_path, ["csv", "json"])
    del deps.store.objects[("runs", ontology_normalized_key("ex-shapes", 1))]  # type: ignore[attr-defined]
    run_once(queue, deps, "w1")
    assert queue.finished and not queue.reviewed
    assert has(target, "published", "pvp/demo/v1/fields/doc-1.csv")


# --- Fuseki (ADR 0011 step 6) ----------------------------------------------------------------

SOURCE_SHA = hashlib.sha256(b"%PDF").hexdigest()
GRAPH_IRI = f"{BASE_IRI}graph/source/{SOURCE_SHA}/demo"


def to_publish(
    tmp_path: Path,
    formats: list[str] | None = None,
    store: bool = True,
    semantics: dict[str, Any] | None = None,
) -> tuple[PipelineDeps, FakeBridge, FakeQueue]:
    """A reviewed job of a mapped recipe, about to be published (registry, optional store)."""
    from ingest_worker.graph_registry import MemoryGraphRegistry

    from .fakes import FakeGraphStore

    template = {
        **TEMPLATE,
        "review": {"required": "always"},
        "semantics": semantics or ENTITY,
        "delivery": {"formats": formats or ["json", "rdf"]},
    }
    deps, target = mapped_deps(tmp_path, template, BASE_IRI)
    deps = replace(
        deps,
        graph_registry=MemoryGraphRegistry(),
        graph_store=FakeGraphStore() if store else None,
    )
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert queue.awaiting
    queue.jobs = [replace(JOB, task="publish")]
    queue.decisions["job-1"] = {
        "reviewer": "kh",
        "note": None,
        "reviewed_at": "2026-10-14T10:05:00Z",
    }
    return deps, target, queue


def graph_event(queue: FakeQueue) -> dict[str, Any]:
    [data] = [d for _, _, m, d in queue.event_details if m == "graph published"]
    return data


def test_a_publish_puts_the_versioned_graph_into_the_store(tmp_path: Path) -> None:
    deps, target, queue = to_publish(tmp_path)
    run_once(queue, deps, "w1")
    assert queue.finished
    store = deps.graph_store
    [(method, graph, body, ctype)] = store.requests  # type: ignore[union-attr]
    assert (method, graph, ctype) == ("PUT", GRAPH_IRI, "text/turtle")
    assert body is not None
    put = Graph().parse(data=body, format="turtle")
    assert (URIRef(GRAPH_IRI), URIRef(f"{CT}graphVersion"), Literal(1)) in put
    copy = target.get("published", f"pvp/graphs/{SOURCE_SHA}/demo/v1.ttl")
    assert copy == body
    current = deps.graph_registry.current(SOURCE_SHA, "demo")  # type: ignore[union-attr]
    assert current is not None and current.version == 1 and current.job_id == "job-1"
    assert current.base_iri == BASE_IRI and current.triples == len(put) - 2
    assert graph_event(queue) == {
        "graph": GRAPH_IRI,
        "version": 1,
        "triples": current.triples,
        "endpoint": True,
    }
    product = f"{BASE_IRI}product/richfer-capsules"
    assert deps.graph_registry.entity(product) == (  # type: ignore[union-attr]
        "https://ex.example/def/Product",
        ["Richfer capsules"],
    )


def test_publishing_the_same_file_again_is_the_next_version_of_its_graph(tmp_path: Path) -> None:
    deps, target, queue = to_publish(tmp_path)
    run_once(queue, deps, "w1")
    queue.jobs = [replace(JOB, task="publish")]
    run_once(queue, deps, "w1")
    store = deps.graph_store
    assert [r[1] for r in store.requests] == [GRAPH_IRI, GRAPH_IRI]  # type: ignore[union-attr]
    assert has(target, "published", f"pvp/graphs/{SOURCE_SHA}/demo/v2.ttl")
    versions = [d["version"] for _, _, m, d in queue.event_details if m == "graph published"]
    assert versions == [1, 2]


def test_without_a_store_the_version_is_still_recorded(tmp_path: Path) -> None:
    deps, target, queue = to_publish(tmp_path, store=False)
    run_once(queue, deps, "w1")
    assert queue.finished
    assert has(target, "published", f"pvp/graphs/{SOURCE_SHA}/demo/v1.ttl")
    assert graph_event(queue)["endpoint"] is False


def test_a_recipe_not_delivering_rdf_publishes_no_graph(tmp_path: Path) -> None:
    deps, target, queue = to_publish(tmp_path, formats=["csv", "json"])
    run_once(queue, deps, "w1")
    assert queue.finished
    assert deps.graph_store.requests == []  # type: ignore[union-attr]
    assert deps.graph_registry.all_current() == []  # type: ignore[union-attr]
    assert not any(k.startswith("pvp/graphs/") for _, k in target.objects)


def test_an_approved_test_run_never_touches_the_store(tmp_path: Path) -> None:
    deps, _, queue = to_publish(tmp_path)
    queue.jobs = [replace(JOB, task="publish", test=True)]
    run_once(queue, deps, "w1")
    assert queue.finished
    assert deps.graph_store.requests == []  # type: ignore[union-attr]
    assert deps.graph_registry.all_current() == []  # type: ignore[union-attr]


def test_a_store_outage_is_retried_and_records_nothing(tmp_path: Path) -> None:
    from ingest_worker.graph_store import GraphStoreUnavailable

    deps, _, queue = to_publish(tmp_path)
    deps.graph_store.fail = GraphStoreUnavailable("graph store answered 503")  # type: ignore[union-attr]
    run_once(queue, deps, "w1")
    assert queue.failed and "503" in queue.failed[0][1]
    assert deps.graph_registry.all_current() == []  # type: ignore[union-attr]
    deps.graph_store.fail = None  # type: ignore[union-attr]
    queue.jobs = [replace(JOB, task="publish")]
    run_once(queue, deps, "w1")
    assert graph_event(queue)["version"] == 1  # the retry is the first version


def test_a_refused_graph_goes_to_review(tmp_path: Path) -> None:
    from ingest_worker.graph_store import GraphStoreRejected

    deps, _, queue = to_publish(tmp_path)
    deps.graph_store.fail = GraphStoreRejected("graph store refused the PUT (400): bad")  # type: ignore[union-attr]
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "refused the PUT (400)" in reason
    assert deps.graph_registry.all_current() == []  # type: ignore[union-attr]


def test_the_pinned_ontologies_are_loaded_once_per_base(tmp_path: Path) -> None:
    from ingest_worker.storage import ontology_normalized_key

    pinned = {**ENTITY, "ontologies": [{"id": "ex", "version": 2}]}
    deps, _, queue = to_publish(tmp_path, semantics=pinned)
    nt = b'<https://ex.example/def/Product> <http://www.w3.org/2000/01/rdf-schema#label> "Product" .\n'
    deps.store.put("runs", ontology_normalized_key("ex", 2), nt, "application/n-triples")
    run_once(queue, deps, "w1")
    queue.jobs = [replace(JOB, task="publish")]
    run_once(queue, deps, "w1")
    tbox = f"{BASE_IRI}graph/ontology/ex/2"
    requests = deps.graph_store.requests  # type: ignore[union-attr]
    assert [(r[0], r[1], r[3]) for r in requests] == [
        ("PUT", tbox, "application/n-triples"),
        ("PUT", GRAPH_IRI, "text/turtle"),
        ("PUT", GRAPH_IRI, "text/turtle"),
    ]
    assert requests[0][2] == nt
    assert deps.graph_registry.ontology_loaded("ex", 2, BASE_IRI)  # type: ignore[union-attr]


def test_a_document_delivered_without_review_publishes_its_graph(tmp_path: Path) -> None:
    from ingest_worker.graph_registry import MemoryGraphRegistry

    from .fakes import FakeGraphStore

    template = {**TEMPLATE, "review": {"required": "never"}, "semantics": ENTITY,
                "delivery": {"formats": ["json", "rdf"]}}  # fmt: skip
    deps, target = mapped_deps(tmp_path, template, BASE_IRI)
    deps = replace(deps, graph_registry=MemoryGraphRegistry(), graph_store=FakeGraphStore())
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert queue.finished and not queue.awaiting
    assert [r[1] for r in deps.graph_store.requests] == [GRAPH_IRI]  # type: ignore[union-attr]
    assert has(target, "published", f"pvp/graphs/{SOURCE_SHA}/demo/v1.ttl")
    assert graph_event(queue)["version"] == 1
    assert queue.published  # its outputs are recorded too


def test_delivered_outputs_are_recorded_even_when_the_store_then_fails(tmp_path: Path) -> None:
    from ingest_worker.graph_store import GraphStoreUnavailable

    deps, target, queue = to_publish(tmp_path)
    deps.graph_store.fail = GraphStoreUnavailable("graph store answered 503")  # type: ignore[union-attr]
    run_once(queue, deps, "w1")
    assert queue.failed
    [(_, published, _)] = queue.published  # written to the target, so recorded
    assert {o.format for o in published} == {"json", "rdf"}
    assert has(target, "published", "pvp/" + GRAPH_KEY)


# --- publishing targets: each recipe version delivers to its own target ------------------------


def finance_deps(
    tmp_path: Path, template: dict[str, Any]
) -> tuple[PipelineDeps, BucketView, BucketView, FakeQueue]:
    """v1 of `template` (no publishTo) as a file; v2, naming finance-lake, in the database."""
    from ingest_worker.graph_registry import MemoryGraphRegistry

    from .fakes import FakeGraphStore

    deps, bridge = mapped_deps(tmp_path, template, BASE_IRI)
    bridge.targets["finance-lake"] = ("finance", "fin/")
    default, finance = BucketView(bridge, "published"), BucketView(bridge, "finance")
    targets = FakeTargets(
        {
            "default": Target("default", "published", "pvp/"),
            "finance-lake": Target("finance-lake", "finance", "fin/"),
        }
    )
    deps = replace(
        deps,
        targets=targets,
        graph_registry=MemoryGraphRegistry(),
        graph_store=FakeGraphStore(),
    )
    v2 = {
        **template,
        "version": 2,
        "delivery": {**template["delivery"], "publishTo": "finance-lake"},
    }
    queue = FakeQueue(templates={("demo", 2): v2})
    return deps, default, finance, queue


DELIVERED_TEMPLATE = {
    **TEMPLATE,
    "review": {"required": "never"},
    "semantics": ENTITY,
    "delivery": {"formats": ["json", "rdf"]},
}
V2 = replace(JOB, spec_version=2)


def test_a_version_naming_a_target_delivers_its_outputs_and_graph_there(tmp_path: Path) -> None:
    deps, default, finance, queue = finance_deps(tmp_path, DELIVERED_TEMPLATE)
    queue.jobs = [V2]
    deps.store.put("inbox", V2.object_key, b"%PDF", "application/pdf")
    run_once(queue, deps, "w1")
    assert queue.finished, queue.reviewed or queue.failed
    [(_, published, target_id)] = queue.published
    assert target_id == "finance-lake"
    assert all(o.key.startswith("fin/demo/v2/") for o in published)
    assert has(finance, "finance", "fin/demo/v2/document/doc-1.json")
    assert has(finance, "finance", f"fin/graphs/{SOURCE_SHA}/demo/v1.ttl")
    assert not default.objects
    current = deps.graph_registry.current(SOURCE_SHA, "demo")  # type: ignore[union-attr]
    assert current is not None and current.target_id == "finance-lake"


def test_a_version_naming_no_target_delivers_to_the_default(tmp_path: Path) -> None:
    deps, default, finance, queue = finance_deps(tmp_path, DELIVERED_TEMPLATE)
    queue.jobs = [JOB]
    run_once(queue, deps, "w1")
    [(_, _, target_id)] = queue.published
    assert target_id == "default"
    assert has(default, "published", f"pvp/graphs/{SOURCE_SHA}/demo/v1.ttl")
    assert not finance.objects
    current = deps.graph_registry.current(SOURCE_SHA, "demo")  # type: ignore[union-attr]
    assert current is not None and current.target_id == "default"


def test_a_missing_target_goes_to_review_before_anything_is_delivered(tmp_path: Path) -> None:
    deps, default, finance, queue = finance_deps(tmp_path, DELIVERED_TEMPLATE)
    assert isinstance(deps.targets, FakeTargets)
    del deps.targets.targets["finance-lake"]
    queue.jobs = [V2]
    deps.store.put("inbox", V2.object_key, b"%PDF", "application/pdf")
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert reason == "no publishing target finance-lake"
    assert not queue.published and not queue.finished
    assert not default.objects and not finance.objects
    assert deps.graph_registry.all_current() == []  # type: ignore[union-attr]
    provider = deps.models._providers["local"]
    assert isinstance(provider, FakeProvider) and provider.calls == []  # no model was called
    assert not queue.drafts


def test_an_approval_whose_target_is_missing_goes_to_review_unwritten(tmp_path: Path) -> None:
    template = {**DELIVERED_TEMPLATE, "review": {"required": "always"}}
    deps, default, finance, queue = finance_deps(tmp_path, template)
    assert isinstance(deps.targets, FakeTargets)
    queue.jobs = [V2]
    deps.store.put("inbox", V2.object_key, b"%PDF", "application/pdf")
    run_once(queue, deps, "w1")
    assert queue.awaiting
    del deps.targets.targets["finance-lake"]  # removed while the job awaited review
    queue.jobs = [replace(V2, task="publish")]
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert reason == "no publishing target finance-lake"
    assert not queue.published and not default.objects and not finance.objects
    assert ("runs", "job-1/reviewed-document.json") not in deps.store.objects  # type: ignore[attr-defined]


def test_an_approval_delivers_to_the_jobs_version_target(tmp_path: Path) -> None:
    template = {**DELIVERED_TEMPLATE, "review": {"required": "always"}}
    deps, default, finance, queue = finance_deps(tmp_path, template)
    queue.jobs = [V2]
    deps.store.put("inbox", V2.object_key, b"%PDF", "application/pdf")
    run_once(queue, deps, "w1")
    queue.jobs = [replace(V2, task="publish")]
    run_once(queue, deps, "w1")
    assert queue.finished
    [(_, _, target_id)] = queue.published
    assert target_id == "finance-lake"
    assert has(finance, "finance", f"fin/graphs/{SOURCE_SHA}/demo/v1.ttl")
    assert not default.objects


def test_a_draft_test_run_never_touches_a_target(tmp_path: Path) -> None:
    deps, default, finance, queue = finance_deps(tmp_path, DELIVERED_TEMPLATE)
    assert isinstance(deps.targets, FakeTargets)
    queue.jobs = [replace(V2, test=True)]
    deps.store.put("inbox", V2.object_key, b"%PDF", "application/pdf")
    run_once(queue, deps, "w1")
    assert queue.finished and not queue.published
    reviewed = {**DELIVERED_TEMPLATE, "review": {"required": "always"}}
    queue.templates[("demo", 2)] = {**reviewed, "version": 2}
    queue.jobs = [replace(V2, test=True, task="publish")]
    run_once(queue, deps, "w1")
    assert deps.targets.gets == []
    assert not default.objects and not finance.objects


def test_a_legacy_spec_always_delivers_to_the_default(specs_dir: Path) -> None:
    from ingest_worker.pipeline import target_for

    legacy = load_specs(specs_dir).get("process-validation-protocol", 2)
    default = Target("default", "published")
    targets = FakeTargets({"default": default})
    deps = PipelineDeps(
        store=MemoryObjectStore(),
        specs=load_specs(specs_dir),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        targets=targets,
    )
    assert target_for(deps, legacy) is default
    assert target_for(replace(deps, targets=None), legacy) is None


# --- delivery through the bridge (delivery bridge phase 2) --------------------------------------


def test_an_auto_published_job_is_handed_to_the_bridge_at_todays_keys(tmp_path: Path) -> None:
    template = {**TEMPLATE, "review": {"required": "never"}}
    _, bridge, queue = run_mapped(tmp_path, template, BASE_IRI)
    [request] = bridge.requests
    assert request.targets == ["default"]
    [(job_id, outputs, deliveries)] = queue.handed_over
    [(_, published, _)] = queue.published
    # Each file's key, under the target's prefix, is the key publishing wrote before the bridge.
    expected = {"pvp/" + o.key for o in outputs if o.format in ("csv", "json")}
    assert {"pvp/" + f.name for f in request.package.files} == expected
    assert {o.key for o in published} == expected
    assert "pvp/demo/v1/fields/doc-1.csv" in expected
    assert has(bridge, "published", "pvp/demo/v1/fields/doc-1.csv")
    assert not queue.completed
    assert job_id == "job-1" and outputs
    [(target_id, delivery_id)] = deliveries
    assert target_id == "default"
    assert queue.published_deliveries == [("job-1", "default", delivery_id)]


def test_a_refused_delivery_sends_the_job_to_review_with_the_bridges_message(
    tmp_path: Path,
) -> None:
    from ingest_worker.bridge.models import BridgeError

    template = {**TEMPLATE, "review": {"required": "never"}}
    deps, bridge = mapped_deps(tmp_path, template, BASE_IRI)
    bridge.refusals = [
        BridgeError(class_="needs_user", code="target_missing", message="no target default")
    ]
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert queue.reviewed == [("job-1", "no target default")]
    assert not queue.published and not queue.handed_over and not bridge.objects


def test_connection_refused_is_retryable_and_records_nothing(tmp_path: Path) -> None:
    from ingest_worker.bridge.client import BridgeUnavailable

    template = {**TEMPLATE, "review": {"required": "never"}}
    deps, bridge = mapped_deps(tmp_path, template, BASE_IRI)
    bridge.refusals = [BridgeUnavailable("the bridge could not be reached: connection refused")]
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert queue.published == [] and not queue.handed_over and not queue.reviewed
    [(_, error)] = queue.failed
    assert "BridgeUnavailable" in error


def test_the_graph_copy_goes_through_put_object_at_todays_key(tmp_path: Path) -> None:
    deps, bridge, queue = to_publish(tmp_path)
    run_once(queue, deps, "w1")
    assert ("default", "published", f"pvp/graphs/{SOURCE_SHA}/demo/v1.ttl") in bridge.puts
    assert has(bridge, "published", f"pvp/graphs/{SOURCE_SHA}/demo/v1.ttl")


def test_auto_published_jobs_act_as_the_uploader_reviewed_ones_as_the_reviewer(
    tmp_path: Path,
) -> None:
    from ingest_worker.bridge.models import ActingUser

    uploader = ActingUser(id="u-up", name="Uma", email=None)
    reviewer = ActingUser(id="u-rev", name="kh", email="kh@example.com")
    auto = {**TEMPLATE, "review": {"required": "never"}}
    deps, bridge = mapped_deps(tmp_path, auto, BASE_IRI)
    queue = FakeQueue(jobs=[JOB], uploaders={"job-1": uploader})
    run_once(queue, deps, "w1")
    assert bridge.requests[-1].acting_user == uploader
    assert bridge.requests[-1].package.provenance is not None
    assert bridge.requests[-1].package.provenance.approver is None

    deps, bridge, queue = to_publish(tmp_path / "reviewed")
    queue.uploaders["job-1"] = uploader
    queue.reviewers["job-1"] = reviewer
    run_once(queue, deps, "w1")
    assert bridge.requests[-1].acting_user == reviewer
    assert bridge.requests[-1].package.provenance is not None
    assert bridge.requests[-1].package.provenance.approver == reviewer
