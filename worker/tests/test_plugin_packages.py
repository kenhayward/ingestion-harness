"""Recipe plugins, slice 3d (docs/design/recipe-plugins.md): plugins from packages installed in
the worker's environment, found through the entry point group `ct_studio.plugins`.

The example package (`worker/plugins/example`, the plugin-writing guide's) is a dev dependency of
the worker, so these tests find it the way a deployment finds an installed package."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ConfigDict

from ingest_worker.main import run_once
from ingest_worker.nodes import NodeSpec
from ingest_worker.plugin_catalogue import catalogue_rows
from ingest_worker.plugin_preview import preview_samples
from ingest_worker.plugins import (
    BUILTINS,
    ENTRY_POINT_GROUP,
    Plugin,
    check_plugin,
    load_installed,
    plugins,
)

from .fakes import FakeQueue
from .test_plugin_preview import deps_with, preview_job, stored
from .test_plugins import RECIPE, run_recipe

LABEL_VALUE = "example.label_value@1"


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    word: str = "x"


class Loose(BaseModel):
    word: str = "x"


def plugin(
    plugin_id: str = "acme.words",
    version: int = 1,
    settings: type[BaseModel] = Settings,
    egress: Any = "none",
    kind: Any = "step",
    judge: Any = None,
) -> Plugin:
    def run(_ctx: Any, _settings: Any) -> dict[str, Any]:
        return {}

    return Plugin(
        spec=NodeSpec(plugin_id, version, run, dict, "pure", egress, False, "Count words."),
        settings=settings,
        check=lambda *_: [],
        run_settings=run,
        kind=kind,
        judge=judge,
    )


@dataclass(frozen=True)
class FakeEntryPoint:
    """What `load_installed` reads of an `importlib.metadata.EntryPoint`."""

    name: str
    value: str
    loader: Callable[[], Any]
    group: str = ENTRY_POINT_GROUP

    def load(self) -> Any:
        return self.loader()


def entry(name: str, obj: Any) -> FakeEntryPoint:
    return FakeEntryPoint(name, f"acme_{name}:PLUGIN", lambda: obj)


def raises(exc: Exception) -> Callable[[], Any]:
    def load() -> Any:
        raise exc

    return load


def test_an_installed_plugin_joins_under_its_id_and_major() -> None:
    words = plugin()
    loaded, problems = load_installed([entry("words", words)])
    assert loaded == {"acme.words@1": words}
    assert problems == []


def test_a_package_may_provide_several_plugins_or_majors() -> None:
    one, two = plugin(), plugin(version=2)
    loaded, problems = load_installed([entry("words", [one, two])])
    assert loaded == {"acme.words@1": one, "acme.words@2": two}
    assert problems == []


@pytest.mark.parametrize(
    ("obj", "problem"),
    [
        ("not a plugin", "is not a Plugin (or a list of Plugins)"),
        ([plugin(), "nor this"], "is not a Plugin (or a list of Plugins)"),
        (plugin(plugin_id="Words"), "Words@1 is not <id>@<major>"),
        (plugin(plugin_id="words"), "words@1 is not <id>@<major>"),
        (plugin(plugin_id="text.pattern", version=2), "text.pattern is built in"),
        (plugin(settings=Loose), "acme.words@1: its settings must refuse unknown keys"),
        (plugin(egress="remote"), "acme.words@1: egress remote belongs behind A2A"),
    ],
)
def test_a_plugin_that_breaks_the_contract_is_left_out_with_the_reason(
    obj: Any, problem: str
) -> None:
    loaded, problems = load_installed([entry("words", obj)])
    assert loaded == {}
    assert len(problems) == 1
    assert problems[0].startswith("words = acme_words:PLUGIN: ")
    assert problem in problems[0]


def _judge(_ctx: Any, _settings: Any) -> list[dict[str, Any]]:
    return []


@pytest.mark.parametrize(
    ("candidate", "problems"),
    [
        (plugin(kind="check", judge=_judge), []),
        (plugin(kind="check"), ["acme.words@1: a check plugin needs judge"]),
        (
            plugin(kind="check", judge=_judge, egress="model"),
            ["acme.words@1: a check plugin sends no data out (egress none)"],
        ),
        (plugin(judge=_judge), ["acme.words@1: a step plugin has no judge"]),
    ],
)
def test_check_plugin_rules(candidate: Plugin, problems: list[str]) -> None:
    assert check_plugin(candidate) == problems


def test_a_package_that_does_not_load_is_left_out_and_the_rest_still_load() -> None:
    words = plugin()
    loaded, problems = load_installed(
        [
            FakeEntryPoint("broken", "acme_broken:PLUGIN", raises(ImportError("no module x"))),
            entry("words", words),
        ]
    )
    assert loaded == {"acme.words@1": words}
    assert problems == ["broken = acme_broken:PLUGIN: could not load (ImportError: no module x)"]


def test_a_settings_model_without_a_json_schema_is_left_out() -> None:
    class Opaque(BaseModel):
        model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)
        thing: Callable[[], None] | None = None

    _, problems = load_installed([entry("words", plugin(settings=Opaque))])
    assert len(problems) == 1
    assert "acme.words@1: its settings have no JSON Schema" in problems[0]


def test_two_packages_with_one_ref_keep_the_first_by_entry_point_name() -> None:
    first, second = plugin(), plugin()
    loaded, problems = load_installed([entry("zz_words", second), entry("aa_words", first)])
    assert loaded == {"acme.words@1": first}
    assert problems == [
        "zz_words = acme_zz_words:PLUGIN: acme.words@1 is also provided by "
        "aa_words = acme_aa_words:PLUGIN"
    ]


def test_check_plugin_is_what_a_plugin_author_runs_in_their_own_tests() -> None:
    assert check_plugin(plugin()) == []
    assert check_plugin(plugin(settings=Loose)) == [
        "acme.words@1: its settings must refuse unknown keys"
    ]
    assert all(check_plugin(p) == [] for p in BUILTINS.values())


# --- the example package, installed ------------------------------------------------------------


def test_the_registry_holds_the_built_ins_and_the_installed_packages_plugins() -> None:
    registry = plugins()
    assert set(BUILTINS) <= set(registry)
    assert registry["text.pattern@1"] is BUILTINS["text.pattern@1"]
    assert LABEL_VALUE in registry
    assert check_plugin(registry[LABEL_VALUE]) == []


def test_the_worker_publishes_installed_plugins_in_its_catalogue() -> None:
    rows = {r["ref"]: r for r in catalogue_rows(plugins())}
    row = rows[LABEL_VALUE]
    assert row["id"] == "example.label_value"
    assert row["major"] == 1
    assert row["egress"] == "none"
    assert row["settingsSchema"]["additionalProperties"] is False
    assert "labels" in row["settingsSchema"]["properties"]


LABELLED: dict[str, Any] = {
    **RECIPE,
    "pipeline": [
        {
            "type": "plugin",
            "id": "refs",
            "uses": LABEL_VALUE,
            "fields": ["reference", "issued"],
            "sections": ["head"],
            "with": {"labels": {"reference": "Ref", "issued": "Issued"}},
        },
        *RECIPE["pipeline"][1:],
    ],
}


def test_a_plugin_from_an_installed_package_runs_in_a_recipe(tmp_path: Path) -> None:
    provider, queue, deps = run_recipe(tmp_path, LABELLED)
    assert queue.awaiting, queue.reviewed or queue.failed
    assert "INV-4021" in provider.calls[0][1].prompt  # the next step's context
    document = json.loads(deps.store.get("outputs", "demo/v1/document/doc-1.json"))
    reference = document["fields"]["reference"]
    assert reference == {"value": "INV-4021", "evidence": "Ref: INV-4021", "page": 1}
    assert document["fields"]["issued"]["value"] == "2026-03-01"


def test_a_plugin_from_an_installed_package_previews_on_samples() -> None:
    pages = ["Ref: X-1\nIssued 2026-01-02\n", "ITEMS\n"]
    result = preview_samples(LABELLED, "refs", "job-1", [("s1", "a.pdf", pages)])
    [sample] = result["samples"]
    assert sample["error"] is None
    assert sample["fields"]["reference"]["value"] == "X-1"


def test_bad_settings_for_an_installed_plugin_stop_the_job_before_any_model_call(
    tmp_path: Path,
) -> None:
    bad = replace_step_with({"labels": {"nope": "Ref"}})
    provider, queue, _ = run_recipe(tmp_path, bad)
    assert provider.calls == []
    [(_, reason)] = queue.reviewed
    assert "'nope' is not a field of this step" in reason


def replace_step_with(with_: dict[str, Any]) -> dict[str, Any]:
    first = {**LABELLED["pipeline"][0], "with": with_}
    return {**LABELLED, "pipeline": [first, *LABELLED["pipeline"][1:]]}


def test_a_preview_job_finds_an_installed_plugin_in_its_child_process(tmp_path: Path) -> None:
    """The preview runs in a child process (spawned on Windows, so it loads the registry again
    from the entry points)."""
    deps = deps_with(tmp_path)
    queue = FakeQueue(jobs=[preview_job(definition=LABELLED)])
    run_once(queue, deps, "w1")
    result = stored(deps)
    assert result["problem"] is None
    assert result["samples"][0]["fields"]["reference"]["value"] == "INV-4021"


def test_an_installed_plugin_may_call_a_model() -> None:
    asking = plugin(egress="model")
    loaded, problems = load_installed([entry("words", asking)])
    assert loaded == {"acme.words@1": asking}
    assert problems == []
