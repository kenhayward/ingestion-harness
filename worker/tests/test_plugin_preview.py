"""Plugin step previews (recipe plugins 3c): a plugin step run on the Workbench's prepared dev
samples, cut into sections as production does, in a child process with a time limit."""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path
from typing import Any

import pytest

from ingest_worker import plugin_preview
from ingest_worker.capped import CallTimedOut, capped_call
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.plugin_preview import preview_samples
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, plugin_preview_key, prepared_text_key

from .fakes import FakeQueue
from .test_plugins import PAGES, RECIPE


def sample(name: str, pages: list[str] | None) -> tuple[str, str, list[str] | None]:
    return (f"id-{name}", name, pages)


# --- the preview itself (pure) ------------------------------------------------------------------


def test_a_field_step_is_previewed_with_typed_values_evidence_and_pages() -> None:
    result = preview_samples(RECIPE, "refs", "p1", [sample("inv.pdf", PAGES)])
    assert result["stepId"] == "refs" and result["uses"] == "text.pattern@1"
    [one] = result["samples"]
    assert one["sampleId"] == "id-inv.pdf" and one["fileName"] == "inv.pdf"
    assert one["error"] is None and one["rows"] is None
    assert one["fields"] == {
        "reference": {"value": "INV-4021", "evidence": "Ref: INV-4021", "page": 1},
        "issued": {"value": "2026-03-01", "evidence": "Issued 2026-03-01", "page": 1},
    }
    assert one["issues"] == []


def test_a_table_step_is_previewed_as_typed_rows_with_their_issues() -> None:
    pages = [PAGES[0], "ITEMS\nABC1 x2\nXYZ22 xlots\n"]
    recipe = copy.deepcopy(RECIPE)
    recipe["pipeline"][2]["with"] = {"row": r"^(?P<sku>[A-Z]{3}\d+)\s+x(?P<qty>\w+)$"}
    [one] = preview_samples(recipe, "rows", "p1", [sample("a.pdf", pages)])["samples"]
    assert one["fields"] is None
    assert one["rows"] == [{"sku": "ABC1", "qty": 2}, {"sku": "XYZ22", "qty": "lots"}]
    [issue] = one["issues"]
    assert (issue["row"], issue["column"], issue["raw"]) == (2, "qty", "lots")


@pytest.mark.parametrize(
    ("pages", "error"),
    [
        (None, "not prepared yet"),
        (["", "  "], "no text"),
        (["ACME LTD\nRef: INV-1\n"], "missing required section"),
    ],
)
def test_a_sample_that_cannot_be_read_says_why(pages: list[str] | None, error: str) -> None:
    [one] = preview_samples(RECIPE, "refs", "p1", [sample("a.pdf", pages)])["samples"]
    assert error in one["error"]
    assert one["fields"] is None and one["rows"] is None


def test_each_sample_is_previewed_on_its_own() -> None:
    result = preview_samples(RECIPE, "refs", "p1", [sample("a.pdf", None), sample("b.pdf", PAGES)])
    assert [s["error"] is None for s in result["samples"]] == [False, True]


# --- the time limit ------------------------------------------------------------------------------


def test_a_capped_call_returns_what_the_function_returns() -> None:
    assert capped_call(sorted, ([3, 1, 2],), 30) == [1, 2, 3]


def test_a_capped_call_is_stopped_at_its_limit() -> None:
    started = time.monotonic()
    with pytest.raises(CallTimedOut):
        capped_call(time.sleep, (60,), 2)
    assert time.monotonic() - started < 30


# --- the preview job ----------------------------------------------------------------------------


def preview_job(**params: Any) -> ClaimedJob:
    base = {
        "samples": [{"sampleId": "s1", "fileName": "inv.pdf", "sha256": "sha-1"}],
        "definition": RECIPE,
        "stepId": "refs",
    }
    return ClaimedJob(
        "p1", None, "demo", 1, "", "", None, 1, 1,
        task="plugin", test=True, project_id="demo", params={**base, **params},
    )  # fmt: skip


def deps_with(tmp_path: Path, pages: list[str] | None = PAGES) -> PipelineDeps:
    store = MemoryObjectStore()
    if pages is not None:
        text = {
            "sha256": "sha-1",
            "pages": [{"number": i + 1, "text": p, "ocr": False} for i, p in enumerate(pages)],
        }
        store.put("runs", prepared_text_key("sha-1"), json.dumps(text).encode(), "application/json")
    return PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=None,  # type: ignore[arg-type]
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
    )  # fmt: skip


def stored(deps: PipelineDeps) -> dict[str, Any]:
    result: dict[str, Any] = json.loads(deps.store.get("runs", plugin_preview_key("demo", "p1")))
    return result


def test_a_preview_job_writes_its_result_and_succeeds(tmp_path: Path) -> None:
    deps, queue = deps_with(tmp_path), FakeQueue(jobs=[preview_job()])
    run_once(queue, deps, "w1")
    assert queue.completed, queue.reviewed or queue.failed
    result = stored(deps)
    assert result["problem"] is None
    assert result["samples"][0]["fields"]["reference"]["value"] == "INV-4021"


@pytest.mark.parametrize(
    ("change", "problem"),
    [
        ({"stepId": "nope"}, "no plugin step nope in the recipe"),
        (
            {"definition": {**RECIPE, "pipeline": [{**RECIPE["pipeline"][0], "uses": "acme.x@1"}, *RECIPE["pipeline"][1:]]}},
            "no plugin acme.x@1 on this worker",
        ),
        (
            {"definition": {**RECIPE, "pipeline": [{**RECIPE["pipeline"][0], "with": {"patterns": {"reference": "("}}}, *RECIPE["pipeline"][1:]]}},
            "text.pattern@1: reference: not a regular expression",
        ),
    ],
)  # fmt: skip
def test_a_preview_that_cannot_run_says_why_and_still_succeeds(
    tmp_path: Path, change: dict[str, Any], problem: str
) -> None:
    deps, queue = deps_with(tmp_path), FakeQueue(jobs=[preview_job(**change)])
    run_once(queue, deps, "w1")
    assert queue.completed, queue.reviewed or queue.failed
    assert problem in stored(deps)["problem"]
    assert stored(deps)["samples"] == []


def test_a_preview_past_its_time_limit_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def too_slow(*_: Any) -> Any:
        raise CallTimedOut(20)

    monkeypatch.setattr(plugin_preview, "capped_call", too_slow)
    deps, queue = deps_with(tmp_path), FakeQueue(jobs=[preview_job()])
    run_once(queue, deps, "w1")
    assert "did not finish within 20s" in stored(deps)["problem"]


def test_only_plugins_that_send_no_data_out_are_previewed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from dataclasses import replace

    from ingest_worker.plugins import PLUGINS

    pattern = PLUGINS["text.pattern@1"]
    calling = replace(pattern, spec=replace(pattern.spec, egress="model"))
    monkeypatch.setitem(PLUGINS, "text.pattern@1", calling)
    deps, queue = deps_with(tmp_path), FakeQueue(jobs=[preview_job()])
    run_once(queue, deps, "w1")
    assert "only plugins that send no data out can be previewed" in stored(deps)["problem"]


def test_parameters_the_worker_cannot_read_go_to_review(tmp_path: Path) -> None:
    deps, queue = deps_with(tmp_path), FakeQueue(jobs=[preview_job(extra=1)])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert reason.startswith("invalid plugin preview parameters")
