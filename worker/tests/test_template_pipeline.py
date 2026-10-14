"""Running a template end to end with fakes: fields (atoms), a chunked table, normalisation,
issues, page markers and the review flag."""

from __future__ import annotations

import csv
import hashlib
import io
import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from rdflib import Graph, Literal, URIRef

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps, Target, mark_pages
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeProvider, FakeQueue, MemoryLinkedDataSettings

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

JOB = ClaimedJob("job-1", "doc-1", "demo", 1, "inbox", "demo/v1/doc-1.pdf", None, 1, 3)


@pytest.fixture
def run(tmp_path: Path):  # type: ignore[no-untyped-def]
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(TEMPLATE), encoding="utf-8")
    provider = FakeProvider("local", responses=list(RESPONSES))
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
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
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    return provider, store, queue


def read_csv(store: MemoryObjectStore, key: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(store.get("outputs", key).decode("utf-8-sig"))))


def test_job_completes_with_one_call_per_step_and_chunk(run) -> None:  # type: ignore[no-untyped-def]
    provider, _, queue = run
    # the 'Complies' normalisation issue means the draft waits for review (see test_review.py)
    assert queue.awaiting and not queue.completed, queue.reviewed or queue.failed
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


def run_mapped(
    tmp_path: Path, template: dict[str, Any], base: str | None
) -> tuple[MemoryObjectStore, MemoryObjectStore, FakeQueue]:
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(template), encoding="utf-8")
    store, target = MemoryObjectStore(), MemoryObjectStore()
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
        target=Target(store=target, bucket="published", prefix="pvp/"),
        linked_data=MemoryLinkedDataSettings(base),
    )
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    return store, target, queue


def has(store: MemoryObjectStore, bucket: str, key: str) -> bool:
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
    assert queue.completed


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
