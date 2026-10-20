"""Part 5 of docs/design/worker-nodes-refactor.md: one data-policy gate (JobModels), one
cancellation runner (run_nodes) and the built-in node descriptions (NODES)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, get_type_hints

import pytest

from ingest_worker.llm.registry import ModelRegistry, ModelResolutionError, ProviderConfig
from ingest_worker.nodes import NODES
from ingest_worker.pipeline import DocumentError, JobCancelled, JobModels, run_nodes
from ingest_worker.queue import ClaimedJob

from .fakes import FakeProvider, FakeQueue

SRC = Path(__file__).resolve().parents[1] / "src" / "ingest_worker"
CLOUD, LOCAL = FakeProvider("cloud", kind="anthropic"), FakeProvider("local")
REGISTRY = ModelRegistry(
    {"cloud": CLOUD, "local": LOCAL},  # type: ignore[dict-item]
    {
        "cloud": ProviderConfig(name="cloud", kind="anthropic"),  # no location: external
        "local": ProviderConfig(name="local", kind="openai-chat", location="local"),
    },
    {"default": "cloud/big"},
)


def job(project: str | None = "letter", policy: str | None = "local") -> ClaimedJob:
    return ClaimedJob(
        "job-1", "doc-1", "letter", 1, "inbox", "letter/v1/doc-1.pdf", None, 1, 3,
        project_id=project, params=None if policy is None else {"dataPolicy": policy},
    )  # fmt: skip


# --- JobModels: the data-policy gate ----------------------------------------------------------


def test_a_local_only_project_never_gets_an_external_provider() -> None:
    with pytest.raises(DocumentError) as refused:
        JobModels(job(), REGISTRY).resolve("default", what="extraction 'header'")
    assert str(refused.value) == (
        "data policy: project is local-only but default resolves to external provider cloud"
    )
    assert CLOUD.calls == []


@pytest.mark.parametrize(
    ("claimed", "ref"),
    [
        (job(), "local/small"),
        (job(policy="external"), "default"),
        (job(project=None, policy=None), "default"),  # production jobs carry no policy
    ],
)
def test_allowed_models_resolve_as_the_registry_does(claimed: ClaimedJob, ref: str) -> None:
    assert JobModels(claimed, REGISTRY).resolve(ref, what="x") == REGISTRY.resolve(ref)


def test_an_unknown_model_is_a_document_error_named_by_its_use() -> None:
    with pytest.raises(DocumentError, match=r"^OCR model: unknown model alias"):
        JobModels(job(), REGISTRY).resolve_ocr("nothing", what="OCR model")


def test_without_a_use_an_unknown_model_raises_as_the_registry_does() -> None:
    with pytest.raises(ModelResolutionError):
        JobModels(job(), REGISTRY).resolve("nothing")


def test_ocr_resolves_through_the_registrys_ocr_endpoint() -> None:
    assert JobModels(job(), REGISTRY).resolve_ocr("local/olm", what="OCR model") == (
        REGISTRY.resolve_ocr("local/olm")
    )
    with pytest.raises(DocumentError, match="data policy"):
        JobModels(job(), REGISTRY).resolve_ocr("cloud/olm", what="OCR model")


def test_allow_checks_a_provider_resolved_elsewhere() -> None:
    JobModels(job(), REGISTRY).allow(LOCAL, "local/small")
    with pytest.raises(DocumentError, match="data policy"):
        JobModels(job(), REGISTRY).allow(CLOUD, "cloud/big")  # type: ignore[arg-type]


def test_nothing_resolves_a_model_around_the_gate() -> None:
    """Chat, vision and OCR models are resolved through JobModels only (llm/ builds them, and
    embeddings have their own location checks in the mapping stage)."""
    direct = re.compile(r"\bmodels\.resolve(?:_ocr)?\(")
    offenders = [
        f"{path.relative_to(SRC)}:{n}"
        for path in SRC.rglob("*.py")
        if "llm" not in path.relative_to(SRC).parts
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if direct.search(line)
    ]
    assert offenders == []


# --- run_nodes: one safe point before every node ---------------------------------------------


def test_run_nodes_threads_the_state_through_each_node_in_order() -> None:
    seen: list[int] = []

    def add(n: int) -> Any:
        def node(state: list[int]) -> list[int]:
            seen.append(n)
            return [*state, n]

        return node

    assert run_nodes(job(), FakeQueue(), [add(1), add(2), add(3)], [0]) == [0, 1, 2, 3]
    assert seen == [1, 2, 3]


def test_run_nodes_stops_before_the_next_node_once_cancelled() -> None:
    ran: list[str] = []
    cancelled = {"now": False}

    def first(state: str) -> str:
        ran.append("first")
        cancelled["now"] = True
        return state

    def second(state: str) -> str:
        ran.append("second")
        return state

    queue = FakeQueue(cancel_when=lambda: cancelled["now"])
    with pytest.raises(JobCancelled):
        run_nodes(job(), queue, [first, second], "s")
    assert ran == ["first"]


def test_run_nodes_checks_before_the_first_node_too() -> None:
    with pytest.raises(JobCancelled):
        run_nodes(job(), FakeQueue(cancel_when=lambda: True), [lambda s: s], "s")


def test_run_nodes_with_no_nodes_returns_the_state() -> None:
    assert run_nodes(job(), FakeQueue(), [], {"a": 1}) == {"a": 1}


# --- NODES: what each built-in node is ---------------------------------------------------------


def test_each_node_is_registered_under_its_own_id() -> None:
    assert all(spec.id == key for key, spec in NODES.items())
    assert all(re.fullmatch(r"[a-z]+\.[a-z_]+", key) for key in NODES)


def test_each_node_returns_what_its_description_says() -> None:
    for spec in NODES.values():
        assert get_type_hints(spec.fn)["return"] == spec.output, spec.id


def test_the_nodes_that_reach_a_model_are_the_ones_that_say_so() -> None:
    model = {key for key, spec in NODES.items() if spec.egress == "model"}
    assert model == {"read.pages", "extract.step"}


def test_effectful_nodes_are_the_ones_that_write_results() -> None:
    effectful = {key for key, spec in NODES.items() if spec.effects == "effectful"}
    assert effectful == {"document.write_drafts", "job.apply_outcome", "publication.deliver"}
