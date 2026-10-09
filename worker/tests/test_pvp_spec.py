"""The shipped Process Validation Protocol spec against both real samples (docs/samples).

TEXT sample: gmpsop template with a text layer (read with the real pypdf extractor).
IMAGE sample: Safetab scanned protocol-cum-report; olmOCR output recorded in
tests/fixtures/samples/pvp-image-ocr.json (pages 1-30 blank protocol, 31-60 executed copy).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from ingest_worker.pdf import extract_pages
from ingest_worker.pipeline import PAGE_MARKER, mark_pages
from ingest_worker.prompts import render_prompt
from ingest_worker.segment import segment, select_copy
from ingest_worker.specs import LoadedSpec, LoadedTemplate, load_specs
from ingest_worker.template import compile_step

REPO_ROOT = Path(__file__).resolve().parents[2]
TEXT_PDF = REPO_ROOT / "docs" / "samples" / "TEXT process_validation_protocol.pdf"
IMAGE_OCR = Path(__file__).parent / "fixtures" / "samples" / "pvp-image-ocr.json"


@pytest.fixture(scope="module")
def pvp() -> LoadedSpec:
    return load_specs(REPO_ROOT / "specs").get("process-validation-protocol", 1)


@pytest.fixture(scope="module")
def text_pages() -> list[str]:
    return extract_pages(TEXT_PDF.read_bytes())


@pytest.fixture(scope="module")
def image_pages() -> list[str]:
    pages: list[str] = json.loads(IMAGE_OCR.read_text(encoding="utf-8"))["pages"]
    return pages


def prepare(spec: LoadedSpec, pages: list[str]) -> tuple[int, dict[str, str]]:
    assert spec.spec.document.copies is not None
    first, kept = select_copy(pages, spec.spec.document.copies)
    return first, segment(kept, spec.spec.document.sections)


def test_text_sample_is_a_single_copy_and_segments(pvp: LoadedSpec, text_pages: list[str]) -> None:
    first, sections = prepare(pvp, text_pages)
    assert first == 0
    assert "MULTI VITAMIN TABLETS" in sections["front_matter"]
    assert "APPROVED FOR EXECUTION" in sections["approvals"]
    assert "three Multi vitamin tablet lots" in sections["strategy"]
    assert "Identification of Critical Tabletting steps" in sections["process"]
    assert "Equipment Used" in sections["process"]
    assert "MONITORING, SAMPLING & TESTING" in sections["test_program"]
    assert "Critical deviations are those" in sections["deviations"]
    assert sections["test_data"] == "" and sections["report_approval"] == ""


def test_image_sample_uses_the_executed_copy(pvp: LoadedSpec, image_pages: list[str]) -> None:
    first, sections = prepare(pvp, image_pages)
    assert first + 1 == 32  # 1-based page where the executed copy's approval page starts
    assert "Prepared By" in sections["approvals"]
    assert "batch size of 13,50,000" in sections["purpose_scope"]
    assert "RICHFER" in sections["product"]
    assert "Master Formula Record" in sections["references"]
    assert "Carbonyl Iron  RMAC0073" in sections["materials"]
    assert "CRITICAL PROCESS STAGES" in sections["process"]
    assert "Blend uniformity" in sections["test_program"]
    # Executed results (blank in the first copy) are what gets extracted.
    assert "TCL  120.1  116.4" in sections["test_data"]
    assert "three commercial batches" in sections["conclusion"]
    assert "19.2 Verified By" in sections["report_approval"]


def test_every_extraction_prompt_renders_for_both_samples(
    pvp: LoadedSpec, text_pages: list[str], image_pages: list[str]
) -> None:
    for pages in (text_pages, image_pages):
        _, sections = prepare(pvp, pages)
        for ex in pvp.spec.extractions:
            prompt = render_prompt(pvp.directory, ex.prompt, sections, ex.sections)
            assert "Process Validation Protocol" in prompt, ex.id  # shared preamble included
            assert len(prompt) < 120_000, ex.id  # well inside the 128k-token local context


def test_header_extraction_reads_page_one_as_an_image(pvp: LoadedSpec) -> None:
    protocol = next(e for e in pvp.spec.extractions if e.id == "protocol")
    assert protocol.page_images == [1]


@pytest.mark.parametrize("spec_dir", sorted((REPO_ROOT / "specs").glob("*/v*")), ids=str)
def test_extraction_schemas_are_strict_structured_output_compatible(spec_dir: Path) -> None:
    """Strict structured outputs (OpenAI strict, Anthropic, llama.cpp grammars) need every object
    to forbid extra keys and list all properties as required (optional = nullable type)."""
    loaded = load_specs(REPO_ROOT / "specs").get(spec_dir.parent.name, int(spec_dir.name[1:]))

    def check(node: object, path: str) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object" or "properties" in node:
                assert node.get("additionalProperties") is False, f"{path}: additionalProperties"
                assert set(node.get("required", [])) == set(node.get("properties", {})), (
                    f"{path}: every property must be required"
                )
            for key, child in node.items():
                check(child, f"{path}/{key}")
        elif isinstance(node, list):
            for i, child in enumerate(node):
                check(child, f"{path}/{i}")

    extractions = (
        [compile_step(loaded.template, step) for step in loaded.template.extract_steps()]
        if isinstance(loaded, LoadedTemplate)
        else loaded.spec.extractions
    )
    for ex in extractions:
        Draft202012Validator.check_schema(ex.schema_)
        check(ex.schema_, ex.id)


# --- v2: chunked test results, consistency check, wider protocol context --------------------


@pytest.fixture(scope="module")
def pvp2() -> LoadedSpec:
    return load_specs(REPO_ROOT / "specs").get("process-validation-protocol", 2)


def test_v2_segments_both_samples_like_v1(
    pvp: LoadedSpec, pvp2: LoadedSpec, text_pages: list[str], image_pages: list[str]
) -> None:
    for pages in (text_pages, image_pages):
        assert prepare(pvp2, pages) == prepare(pvp, pages)


def test_v2_test_results_run_one_page_at_a_time(pvp2: LoadedSpec, image_pages: list[str]) -> None:
    ex = next(e for e in pvp2.spec.extractions if e.id == "test_results")
    assert (ex.chunk_pages, ex.merge_path, ex.sections) == (1, "results", ["test_data"])
    _, sections = prepare(pvp2, image_pages)
    pages = [p for p in sections["test_data"].split("\f") if p.strip()]
    assert len(pages) == 14  # executed copy pages 44-57 (deviations start on page 58)
    prompt = render_prompt(
        pvp2.directory,
        ex.prompt,
        {**sections, "test_data": pages[0]},
        ex.sections,
        chunk={"index": 1, "count": 14},
    )
    assert "page 1 of 14" in prompt and "TCL  120.1  116.4" in prompt
    assert "Mixing time (5 min" not in prompt  # page 2's lubrication table is not included


def test_v2_protocol_sees_reason_for_validation_and_all_stages(
    pvp2: LoadedSpec, image_pages: list[str]
) -> None:
    ex = next(e for e in pvp2.spec.extractions if e.id == "protocol")
    _, sections = prepare(pvp2, image_pages)
    prompt = render_prompt(pvp2.directory, ex.prompt, sections, ex.sections)
    assert "REASON FOR VALIDATION" in prompt and "New formulation" in prompt
    assert "Capsule filling" in prompt
    assert ex.page_images == [1]


def test_v2_prompts_treat_template_guidance_as_non_data(
    pvp2: LoadedSpec, text_pages: list[str]
) -> None:
    ex = next(e for e in pvp2.spec.extractions if e.id == "protocol")
    _, sections = prepare(pvp2, text_pages)
    prompt = render_prompt(pvp2.directory, ex.prompt, sections, ex.sections)
    assert "XXXXkg" in prompt  # the trap is present in the document ...
    assert "guidance" in prompt and "XXXX" in prompt.split("<section")[0]  # ... and in the rules


def test_v2_cross_checks_batch_numbers_and_outputs_the_result(pvp2: LoadedSpec) -> None:
    [check] = pvp2.spec.checks
    assert (check.id, check.values, check.reference, check.aliases) == (
        "batch_numbers",
        "test_results.results[*].batch_number",
        "batches.batches[*].batch_number",
        "batches.batches[*].batch_number_variants[*]",
    )
    out = next(o for o in pvp2.spec.outputs if o.id == "batch_number_check")
    assert out.from_ == "batch_numbers" and out.format == "csv"


# --- v3: document template (fields + tables + steps) ----------------------------------------


@pytest.fixture(scope="module")
def pvp3() -> Any:
    loaded = load_specs(REPO_ROOT / "specs").get("process-validation-protocol", 3)
    assert isinstance(loaded, LoadedTemplate)
    return loaded


def prepare_v3(pvp3: Any, pages: list[str]) -> tuple[int, dict[str, str]]:
    doc = pvp3.template.document
    first, kept = select_copy(pages, doc.copies)
    marked = mark_pages(kept, first + 1)
    return first, segment(marked, doc.sections, page_marker=PAGE_MARKER)


def test_v3_segments_both_samples_like_v2_plus_page_markers(
    pvp2: LoadedSpec, pvp3: Any, text_pages: list[str], image_pages: list[str]
) -> None:
    for pages in (text_pages, image_pages):
        first2, v2 = prepare(pvp2, pages)
        first3, v3 = prepare_v3(pvp3, pages)
        assert first3 == first2 and set(v3) == set(v2)
        for section_id, text in v2.items():
            plain = "\n".join(
                line for line in v3[section_id].splitlines() if not line.startswith("[page ")
            )
            assert plain.split() == text.split(), section_id
    _, image = prepare_v3(pvp3, image_pages)
    assert image["approvals"].startswith("[page 32]")
    assert image["test_data"].startswith("[page 44]")


def test_v3_declares_the_atoms_and_fills_some_with_dedicated_prompts(pvp3: Any) -> None:
    t = pvp3.template
    types = {f.id: f.type for f in t.outputs.fields}
    assert types["compound"] == "list"
    assert types["medicinal_product"] == "text"
    assert types["execution_date"] == "date"
    assert types["effective_date"] == "date" and types["number_of_batches"] == "integer"
    single = {s.fields[0] for s in t.extract_steps() if len(s.fields) == 1}
    assert {"compound", "execution_date"} <= single
    assert t.filler_of_field("protocol_number").page_images == [1]


def test_v3_tables_fix_v2_stage_and_decimal_problems(pvp3: Any) -> None:
    results = pvp3.template.table("test_results")
    columns = {c.id: c for c in results.columns}
    assert columns["stage"].type == "enum"
    assert columns["stage"].enum == ["Blending", "Lubrication", "Capsule filling", "Other"]
    assert columns["result"].type == "text" and columns["result_value"].type == "decimal"
    step = pvp3.template.filler_of_table("test_results")
    assert (step.chunk_pages, step.sections) == (1, ["test_data"])


def test_v3_cross_checks_batch_numbers(pvp3: Any) -> None:
    [check] = [s for s in pvp3.template.pipeline if s.type == "check"]
    assert (check.values, check.reference, check.aliases) == (
        "test_results.batch_number",
        "batches.batch_number",
        "batches.batch_number_variants",
    )


def test_v3_builtin_prompts_render_for_every_step_on_both_samples(
    pvp3: Any, text_pages: list[str], image_pages: list[str]
) -> None:
    t = pvp3.template
    for pages in (text_pages, image_pages):
        _, sections = prepare_v3(pvp3, pages)
        for step in t.extract_steps():
            ex = compile_step(t, step)
            chunk = {"index": 1, "count": 2} if ex.chunk_pages else None
            prompt = render_prompt(
                pvp3.directory, ex.prompt, sections, ex.sections, chunk, ex.prompt_context
            )
            assert "Process Validation Protocol" in prompt, step.id
            assert "[page" in prompt, step.id
            assert len(prompt) < 120_000, step.id
