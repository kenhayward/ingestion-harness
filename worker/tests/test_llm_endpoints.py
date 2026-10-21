"""LLM endpoints in the database (ADR 0010): seeding from .env, the registry built from the
store, and live reload. The store contract runs against the in-memory fake and, when
IH_TEST_DATABASE_URL points at a THROWAWAY migrated database (it empties the llm_* tables),
against Postgres."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Protocol

import pytest

from ingest_worker.llm.base import LLMProvider
from ingest_worker.llm.endpoints import (
    Choice,
    LiveModels,
    Seed,
    default_choice_of,
    parse_choices,
    parse_endpoints,
    registry_from_seed,
    seed_from_config,
)
from ingest_worker.llm.registry import (
    LLMConfig,
    ModelRegistry,
    ModelResolutionError,
    OcrConfig,
    ProviderConfig,
    endpoint_key,
    load_llm_config,
)

from .fakes import FakeProvider, MemoryLlmConfigStore, ToolFakeProvider


def fake_factories(made: list[str] | None = None):  # type: ignore[no-untyped-def]
    def make(cfg: ProviderConfig, api_key: str | None) -> LLMProvider:
        if made is not None:
            made.append(f"{cfg.name}:{api_key}")
        return FakeProvider(cfg.name, kind=cfg.kind)

    return {"anthropic": make, "openai-chat": make, "openai-responses": make}


def endpoint(name: str, **over: Any) -> ProviderConfig:
    data: dict[str, Any] = {
        "name": name,
        "kind": "openai-chat",
        "baseUrl": f"http://{name}/v1",
        "location": "local",
        "apiKeyRequired": False,
        "models": [f"{name}-model"],
    }
    data.update(over)
    return ProviderConfig.model_validate(data)


# --- seeding from the committed config and .env ---------------------------------------------


def seeded(endpoints: list[ProviderConfig], aliases: dict[str, str] | None = None) -> Seed:
    """A Seed from the old alias shape: `default` becomes the default choice (`main`), `draft`
    and `ocr` the pipeline settings, any other name a choice of that id."""
    aliases = aliases or {}
    choices = [
        Choice(k, k, v)
        for k, v in aliases.items()
        if k not in ("default", "draft", "ocr", "embedding")
    ]
    settings: dict[str, str] = {}
    if "default" in aliases:
        choices.append(Choice("main", "Main", aliases["default"]))
        settings["default_choice"] = "main"
    if "draft" in aliases:
        settings["drafting_model"] = aliases["draft"]
    if "ocr" in aliases:
        settings["ocr_model"] = aliases["ocr"]
    if "embedding" in aliases:
        settings["embedding_model"] = aliases["embedding"]
    return Seed(endpoints, choices, settings)


def test_seed_from_the_committed_config_keeps_todays_defaults(llm_config_path: Path) -> None:
    seed = seed_from_config(load_llm_config(llm_config_path, env={}), env={})
    by_name = {e.name: e for e in seed.endpoints}
    assert list(by_name) == ["anthropic", "openai", "local"]
    assert by_name["anthropic"].models == [
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
    ]
    assert by_name["openai"].models == []
    assert by_name["local"].models == ["qwen3.8-27b-mtp", "olmocr-2-7b-1025"]
    assert by_name["local"].location == "local"
    # Without LLM_CHOICES, DEFAULT_MODEL and FAST_MODEL seed two labelled choices.
    assert seed.choices == [
        Choice("main", "Default model", "local/qwen3.8-27b-mtp"),
        Choice("fast", "Fast model", "anthropic/claude-haiku-5-5"),
    ]
    assert seed.settings == {
        "default_choice": "main",
        "drafting_model": "local/qwen3.8-27b-mtp",
        "ocr_model": "local/olmocr-2-7b-1025",
    }
    # What the worker resolves: the choices, `default` (the default choice) and `draft`. The OCR
    # model is the OCR stage's alone: it is never a model a step or a job can name.
    assert seed.aliases == {
        "main": "local/qwen3.8-27b-mtp",
        "fast": "anthropic/claude-haiku-5-5",
        "default": "main",
        "draft": "local/qwen3.8-27b-mtp",
    }


def test_env_sets_the_model_lists_and_the_compatible_choices(llm_config_path: Path) -> None:
    env = {
        "ANTHROPIC_MODELS": "claude-opus-5-5, claude-haiku-5-5",
        "OPENAI_MODELS": "gpt-5",
        "LOCAL_LLM_MODELS": "qwen3-32b,olmocr-2-7b-1025,",
        "DEFAULT_MODEL": "local/qwen3-32b",
        "FAST_MODEL": "openai/gpt-5",
        "DRAFT_MODEL": "anthropic/claude-opus-5-5",
        "OCR_MODEL": "local/olmocr-2-7b-1025",
    }
    seed = seed_from_config(load_llm_config(llm_config_path, env=env), env=env)
    by_name = {e.name: e for e in seed.endpoints}
    assert by_name["anthropic"].models == ["claude-opus-5-5", "claude-haiku-5-5"]
    assert by_name["openai"].models == ["gpt-5"]
    assert by_name["local"].models == ["qwen3-32b", "olmocr-2-7b-1025"]
    assert [(c.id, c.ref) for c in seed.choices] == [
        ("main", "local/qwen3-32b"),
        ("fast", "openai/gpt-5"),
    ]
    assert seed.settings["drafting_model"] == "anthropic/claude-opus-5-5"


def test_llm_choices_define_the_labelled_choices(llm_config_path: Path) -> None:
    env = {
        "LLM_CHOICES": (
            "main=Main Production Model|local/qwen3.8-27b-mtp;"
            " test=New for testing only|anthropic/claude-haiku-5-5|default"
        ),
        "DEFAULT_MODEL": "local/ignored",
        "FAST_MODEL": "local/ignored-too",
    }
    seed = seed_from_config(load_llm_config(llm_config_path, env=env), env=env)
    assert seed.choices == [
        Choice("main", "Main Production Model", "local/qwen3.8-27b-mtp"),
        Choice("test", "New for testing only", "anthropic/claude-haiku-5-5"),
    ]
    assert seed.settings["default_choice"] == "test"
    assert seed.settings["ocr_model"] == "local/olmocr-2-7b-1025"


def test_the_first_choice_is_the_default_unless_one_is_marked() -> None:
    assert [c.id for c in parse_choices("a=A|local/a;b=B|local/b")] == ["a", "b"]
    assert default_choice_of("a=A|local/a;b=B|local/b") == "a"
    assert default_choice_of("a=A|local/a;b=B|local/b|default") == "b"


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ("main", "main: expected id=Label|endpoint/model"),
        ("Main=Label|local/a", "'Main': ids are lower-case"),
        ("main=|local/a", "main: a label is required"),
        ("main=Label|qwen", "main: the model must be endpoint/model-id"),
        ("main=Label|local/a|primary", "main: only `default` may follow the model"),
        ("a=A|local/a|default;b=B|local/b|default", "only one choice can be the default"),
        ("a=A|local/a;a=B|local/b", "a: listed twice"),
        ("ocr=OCR|local/olmocr", "ocr: reserved"),
        ("default=Default|local/a", "default: reserved"),
        ("draft=Draft|local/a", "draft: reserved"),
    ],
)
def test_bad_llm_choices_entries_are_refused(value: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        parse_choices(value)


def test_a_disabled_local_endpoint_is_seeded_disabled(llm_config_path: Path) -> None:
    env = {"LOCAL_LLM_ENABLED": "false"}
    seed = seed_from_config(load_llm_config(llm_config_path, env=env), env=env)
    assert next(e for e in seed.endpoints if e.name == "local").enabled is False


def test_more_endpoints_come_from_llm_endpoints(llm_config_path: Path) -> None:
    env = {
        "LLM_ENDPOINTS": (
            "gpu2=http://192.168.1.140:8000/v1|llama-4-70b,qwen3-32b;"
            " cloudy=https://llm.example.com/v1|big-model|external|openai-responses"
        )
    }
    seed = seed_from_config(load_llm_config(llm_config_path, env=env), env=env)
    by_name = {e.name: e for e in seed.endpoints}
    assert list(by_name) == ["anthropic", "openai", "local", "gpu2", "cloudy"]
    gpu2 = by_name["gpu2"]
    assert (gpu2.kind, gpu2.base_url, gpu2.location) == (
        "openai-chat",
        "http://192.168.1.140:8000/v1",
        "local",
    )
    assert gpu2.models == ["llama-4-70b", "qwen3-32b"]
    assert gpu2.api_key_env == "LLM_ENDPOINT_KEYS"
    assert gpu2.api_key_required is False
    # Same server type as the shipped local endpoint: same request options.
    assert gpu2.options == by_name["local"].options
    cloudy = by_name["cloudy"]
    assert (cloudy.kind, cloudy.location) == ("openai-responses", "external")
    assert cloudy.options == {}


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ("gpu2", "gpu2: expected name=baseUrl|models"),
        ("gpu2=|m", "gpu2: a base URL is required"),
        ("GPU 2=http://x/v1|m", "'GPU 2': names are lower-case"),
        ("gpu2=http://x/v1|m|nearby", "gpu2: location must be local or external"),
        ("gpu2=http://x/v1|m|local|grpc", "gpu2: kind must be"),
        ("gpu2=http://x/v1|m;gpu2=http://y/v1|m", "gpu2: listed twice"),
    ],
)
def test_bad_llm_endpoints_entries_are_refused(value: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        parse_endpoints(value)


def test_llm_endpoints_may_not_redefine_a_shipped_provider(llm_config_path: Path) -> None:
    env = {"LLM_ENDPOINTS": "local=http://x/v1|m"}
    with pytest.raises(ValueError, match="local: already defined"):
        seed_from_config(load_llm_config(llm_config_path, env=env), env=env)


@pytest.mark.parametrize(
    ("cfg", "env", "key"),
    [
        (
            endpoint("gpu2", apiKeyEnv="LLM_ENDPOINT_KEYS"),
            {"LLM_ENDPOINT_KEYS": "gpu2=k2;x=k"},
            "k2",
        ),
        (endpoint("gpu3", apiKeyEnv="LLM_ENDPOINT_KEYS"), {"LLM_ENDPOINT_KEYS": "gpu2=k2"}, None),
        (endpoint("gpu2", apiKeyEnv="LLM_ENDPOINT_KEYS"), {}, None),
        (endpoint("a", apiKeyEnv="ANTHROPIC_API_KEY"), {"ANTHROPIC_API_KEY": "sk"}, "sk"),
        (endpoint("a", apiKeyEnv="ANTHROPIC_API_KEY"), {"ANTHROPIC_API_KEY": ""}, None),
        (endpoint("a"), {"ANTHROPIC_API_KEY": "sk"}, None),
    ],
)
def test_endpoint_keys(cfg: ProviderConfig, env: dict[str, str], key: str | None) -> None:
    assert endpoint_key(cfg, env) == key


# --- the registry built from the store ------------------------------------------------------


def test_the_registry_comes_from_the_stored_endpoints_and_choices() -> None:
    seed = seeded(
        [
            endpoint("local"),
            endpoint("gpu2", location="external", apiKeyEnv="LLM_ENDPOINT_KEYS"),
            endpoint("off", enabled=False),
            endpoint(
                "keyless", kind="anthropic", apiKeyEnv="ANTHROPIC_API_KEY", apiKeyRequired=True
            ),
        ],
        {"default": "gpu2/gpu2-model", "ocr": "local/olmocr"},
    )
    made: list[str] = []
    registry = registry_from_seed(
        seed, None, env={"LLM_ENDPOINT_KEYS": "gpu2=secret"}, factories=fake_factories(made)
    )
    # A missing key skips the endpoint (it may have been added in the UI): never a crash.
    assert registry.provider_names == ["local", "gpu2"]
    assert made == ["local:None", "gpu2:secret"]
    provider, model = registry.resolve("default")
    assert (provider.name, model) == ("gpu2", "gpu2-model")
    assert registry.location("gpu2") == "external"
    with pytest.raises(ModelResolutionError):
        registry.resolve("off/x")


def test_the_ocr_setting_picks_the_ocr_model_and_is_not_a_model_to_name() -> None:
    seed = seeded([endpoint("local", models=["vision-2"])], {"ocr": "local/vision-2"})
    ocr = OcrConfig.model_validate({"model": "local/olmocr", "baseUrl": "http://ocr-host/v1"})
    live = LiveModels(MemoryLlmConfigStore(seed), ocr, env={}, factories=fake_factories())
    assert live.ocr_model == "local/vision-2"
    provider, model = live.registry.resolve_ocr(live.ocr_model)
    assert model == "vision-2"
    assert provider is not live.registry.resolve("local/vision-2")[0]  # OCR keeps its own endpoint
    # Only the OCR stage uses it: a step or a job cannot name it.
    with pytest.raises(ModelResolutionError):
        live.registry.resolve("ocr")


def test_live_models_rebuild_only_when_the_stored_config_changes() -> None:
    store = MemoryLlmConfigStore(
        seeded([endpoint("local", models=["a", "b"])], {"default": "local/a"})
    )
    made: list[str] = []
    live = LiveModels(store, None, env={}, factories=fake_factories(made))
    assert live.registry.resolve("default")[1] == "a"
    assert live.refresh() is False
    assert made == ["local:None"]
    store.edit_choice("main", "local/b")
    assert live.refresh() is True
    assert live.registry.resolve("default")[1] == "b"
    assert made == ["local:None", "local:None"]


# --- the store contract: .env seeds, the UI wins --------------------------------------------


class StoreHarness(Protocol):
    store: Any

    def edit_endpoint(self, name: str, base_url: str) -> None: ...
    def edit_choice(self, choice_id: str, ref: str) -> None: ...
    def set_setting(self, name: str, value: str) -> None: ...
    def add_ui_choice(self, choice: Choice) -> None: ...
    def uncurate(self, provider: str, model_id: str) -> None: ...
    def add_ui_endpoint(self, cfg: ProviderConfig) -> None: ...
    def set_key(self, name: str, encrypted: str) -> None: ...
    def disable_model(self, provider: str, model_id: str) -> None: ...
    def set_output_limit(self, provider: str, model_id: str, limit: int | None) -> None: ...
    def set_parallel_calls(self, provider: str, model_id: str, calls: int | None) -> None: ...


class MemoryHarness:
    def __init__(self) -> None:
        self.store = MemoryLlmConfigStore()

    def edit_endpoint(self, name: str, base_url: str) -> None:
        self.store.edit_endpoint(name, base_url=base_url)

    def edit_choice(self, choice_id: str, ref: str) -> None:
        self.store.edit_choice(choice_id, ref)

    def set_setting(self, name: str, value: str) -> None:
        self.store.set_setting(name, value)

    def add_ui_choice(self, choice: Choice) -> None:
        self.store.add_ui_choice(choice)

    def uncurate(self, provider: str, model_id: str) -> None:
        self.store.uncurate(provider, model_id)

    def add_ui_endpoint(self, cfg: ProviderConfig) -> None:
        self.store.add_ui_endpoint(cfg)

    def set_key(self, name: str, encrypted: str) -> None:
        self.store.edit_endpoint(name, api_key_enc=encrypted)

    def disable_model(self, provider: str, model_id: str) -> None:
        self.store.disable_model(provider, model_id)

    def set_output_limit(self, provider: str, model_id: str, limit: int | None) -> None:
        self.store.set_output_limit(provider, model_id, limit)

    def set_parallel_calls(self, provider: str, model_id: str, calls: int | None) -> None:
        self.store.set_parallel_calls(provider, model_id, calls)


class PgHarness:
    """PgLlmConfigStore on a throwaway database; edits are made the way the admin API will."""

    def __init__(self, url: str) -> None:
        import psycopg

        from ingest_worker.llm.endpoints import PgLlmConfigStore

        self.conn = psycopg.connect(url, autocommit=True)
        self.store = PgLlmConfigStore(self.conn)

    def edit_endpoint(self, name: str, base_url: str) -> None:
        self.conn.execute(
            "UPDATE llm_endpoints SET base_url = %s, edited_at = now() WHERE name = %s",
            (base_url, name),
        )

    def edit_choice(self, choice_id: str, ref: str) -> None:
        self.conn.execute(
            "UPDATE llm_choices SET ref = %s, edited_at = now() WHERE id = %s", (ref, choice_id)
        )

    def set_setting(self, name: str, value: str) -> None:
        self.conn.execute(
            """INSERT INTO llm_settings (name, value, edited_at) VALUES (%s, %s, now())
               ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, edited_at = now()""",
            (name, value),
        )

    def add_ui_choice(self, choice: Choice) -> None:
        self.conn.execute(
            """INSERT INTO llm_choices (id, label, description, ref, source, edited_at)
               VALUES (%s, %s, %s, %s, 'ui', now())""",
            (choice.id, choice.label, choice.description, choice.ref),
        )

    def uncurate(self, provider: str, model_id: str) -> None:
        self.conn.execute(
            """UPDATE llm_models SET curated = false, curated_edited_at = now()
                WHERE provider = %s AND model_id = %s""",
            (provider, model_id),
        )

    def disable_model(self, provider: str, model_id: str) -> None:
        self.conn.execute(
            "UPDATE llm_models SET enabled = false WHERE provider = %s AND model_id = %s",
            (provider, model_id),
        )

    def set_output_limit(self, provider: str, model_id: str, limit: int | None) -> None:
        self.conn.execute(
            "UPDATE llm_models SET max_output_tokens = %s WHERE provider = %s AND model_id = %s",
            (limit, provider, model_id),
        )

    def set_parallel_calls(self, provider: str, model_id: str, calls: int | None) -> None:
        self.conn.execute(
            "UPDATE llm_models SET max_concurrent_calls = %s WHERE provider = %s AND model_id = %s",
            (calls, provider, model_id),
        )

    def set_key(self, name: str, encrypted: str) -> None:
        self.conn.execute(
            "UPDATE llm_endpoints SET api_key_enc = %s, edited_at = now() WHERE name = %s",
            (encrypted, name),
        )

    def add_ui_endpoint(self, cfg: ProviderConfig) -> None:
        self.conn.execute(
            """INSERT INTO llm_endpoints (name, kind, base_url, location, source, edited_at)
               VALUES (%s, %s, %s, %s, 'ui', now())""",
            (cfg.name, cfg.kind, cfg.base_url, cfg.location),
        )


@pytest.fixture(params=["memory", pytest.param("pg", marks=pytest.mark.integration)])
def harness(request: pytest.FixtureRequest) -> Iterator[StoreHarness]:
    if request.param == "memory":
        yield MemoryHarness()
        return
    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set (a throwaway database: the test empties llm_*)")
    h = PgHarness(url)
    # The tables are shared: start from nothing so seeding's deletes are observable.
    h.conn.execute("DELETE FROM llm_choices")
    h.conn.execute("DELETE FROM llm_settings")
    h.conn.execute("DELETE FROM llm_endpoints")
    h.conn.execute("DELETE FROM llm_models")
    yield h
    h.conn.close()


def names(seed: Seed) -> list[str]:
    return [e.name for e in seed.endpoints]


def test_seeding_inserts_then_follows_env_changes(harness: StoreHarness) -> None:
    store = harness.store
    store.seed(seeded([endpoint("local"), endpoint("gpu2")], {"default": "local/local-model"}))
    loaded = store.load()
    assert names(loaded) == ["gpu2", "local"]
    assert loaded.choices == [Choice("main", "Main", "local/local-model")]
    assert loaded.settings == {"default_choice": "main"}
    assert next(e for e in loaded.endpoints if e.name == "local").models == ["local-model"]

    # .env changed: gpu2 gone, local moved and serves another model, the alias moved too.
    store.seed(
        seeded(
            [endpoint("local", baseUrl="http://new/v1", models=["other"])],
            {"default": "local/other", "fast": "local/other", "draft": "local/other"},
        )
    )
    loaded = store.load()
    assert names(loaded) == ["local"]
    local = loaded.endpoints[0]
    assert (local.base_url, local.models) == ("http://new/v1", ["other"])
    assert loaded.choices == [
        Choice("fast", "fast", "local/other"),
        Choice("main", "Main", "local/other"),
    ]
    assert loaded.settings == {"default_choice": "main", "drafting_model": "local/other"}

    # .env dropped the fast choice and the drafting model: both go (nobody edited them).
    store.seed(seeded([endpoint("local", models=["other"])], {"default": "local/other"}))
    loaded = store.load()
    assert [c.id for c in loaded.choices] == ["main"]
    assert loaded.settings == {"default_choice": "main"}


def test_ui_edits_win_over_env(harness: StoreHarness) -> None:
    store = harness.store
    store.seed(
        seeded(
            [endpoint("local", models=["a", "b"]), endpoint("gpu2")],
            {"default": "local/a", "fast": "local/b", "ocr": "local/b"},
        )
    )
    harness.edit_endpoint("gpu2", "http://edited/v1")
    harness.edit_choice("main", "gpu2/gpu2-model")
    harness.uncurate("local", "b")
    harness.add_ui_endpoint(endpoint("mine"))
    harness.add_ui_choice(Choice("test", "New for testing only", "local/a", "Try it"))
    harness.set_setting("default_choice", "test")
    harness.set_setting("ocr_model", "local/a")
    # A restart with the same .env (or one without gpu2 and fast): the edits stay.
    store.seed(
        seeded([endpoint("local", models=["a", "b"])], {"default": "local/a", "ocr": "local/b"})
    )
    loaded = store.load()
    assert names(loaded) == ["gpu2", "local", "mine"]
    by_name = {e.name: e for e in loaded.endpoints}
    assert by_name["gpu2"].base_url == "http://edited/v1"
    assert by_name["local"].models == ["a"]
    assert loaded.choices == [
        Choice("main", "Main", "gpu2/gpu2-model"),
        Choice("test", "New for testing only", "local/a", "Try it"),
    ]
    assert loaded.settings == {"default_choice": "test", "ocr_model": "local/a"}


def test_the_version_moves_when_the_config_changes(harness: StoreHarness) -> None:
    store = harness.store
    store.seed(seeded([endpoint("local")], {"default": "local/local-model"}))
    before = store.version()
    harness.edit_choice("main", "local/other")
    assert store.version() != before
    before = store.version()
    harness.set_setting("drafting_model", "local/other")
    assert store.version() != before


def test_the_stored_endpoint_round_trips(harness: StoreHarness) -> None:
    store = harness.store
    full = endpoint(
        "gpu2",
        kind="openai-responses",
        location="external",
        apiKeyEnv="LLM_ENDPOINT_KEYS",
        apiKeyRequired=True,
        discover=False,
        modelFilter="^llama",
        options={"temperature": 0, "timeoutS": 900},
        enabled=False,
        toolCalls=False,
        models=["b", "a"],
    )
    store.seed(Seed([full]))
    (loaded,) = store.load().endpoints
    assert loaded.model_dump() == {**full.model_dump(), "models": ["a", "b"], "optional": True}


def test_tools_run_only_where_the_endpoint_allows_and_the_adapter_can() -> None:
    providers: dict[str, Any] = {
        "tools": ToolFakeProvider("tools"),
        "off": ToolFakeProvider("off"),
        "plain": FakeProvider("plain"),
    }
    configs = {
        "tools": endpoint("tools"),
        "off": endpoint("off", toolCalls=False),
        "plain": endpoint("plain"),
    }
    registry = ModelRegistry(providers, configs, {})
    assert registry.supports_tools("tools")
    assert not registry.supports_tools("off")  # an admin turned them off
    assert not registry.supports_tools("plain")  # the adapter cannot hold a conversation
    assert not registry.supports_tools("unknown")


def test_llm_config_without_ocr_has_no_ocr_model() -> None:
    cfg = LLMConfig.model_validate({"providers": [], "aliases": {"default": "local/a"}})
    assert seed_from_config(cfg, env={}).settings == {"default_choice": "main"}


def test_an_unchanged_env_does_not_move_the_version(harness: StoreHarness) -> None:
    # Every worker seeds on start: identical .env values must not make the others rebuild.
    store = harness.store
    seed = seeded(
        [endpoint("local", models=["a", "b"])],
        {"default": "local/a", "fast": "local/b", "draft": "local/a"},
    )
    store.seed(seed)
    before = store.version()
    store.seed(seed)
    assert store.version() == before


def test_the_worker_swaps_in_the_rebuilt_registry_and_ocr_model() -> None:
    from ingest_worker.main import refresh_models
    from ingest_worker.ocr import OcrSettings
    from ingest_worker.pipeline import Buckets, PipelineDeps
    from ingest_worker.specs import SpecRegistry
    from ingest_worker.storage import MemoryObjectStore

    store = MemoryLlmConfigStore(
        seeded(
            [endpoint("local", models=["a", "b", "olmocr", "vision-2"])],
            {"default": "local/a", "ocr": "local/olmocr"},
        )
    )
    ocr = OcrConfig.model_validate({"model": "local/olmocr"})
    live = LiveModels(store, ocr, env={}, factories=fake_factories())
    deps = PipelineDeps(
        store=MemoryObjectStore(),
        specs=SpecRegistry([]),
        models=live.registry,
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        ocr=OcrSettings(model="local/olmocr", concurrency=2),
    )
    assert refresh_models(live, deps) is False
    store.set_setting("ocr_model", "local/vision-2")
    store.edit_choice("main", "local/b")
    assert refresh_models(live, deps) is True
    assert deps.models is live.registry
    assert deps.models.resolve("default")[1] == "b"
    assert deps.ocr == OcrSettings(model="local/vision-2", concurrency=2)


def test_a_key_set_in_the_ui_loads_and_survives_seeding(harness: StoreHarness) -> None:
    store = harness.store
    store.seed(Seed([endpoint("gpu2")]))
    harness.set_key("gpu2", "v1:stored")
    store.seed(Seed([endpoint("gpu2")]))
    (loaded,) = store.load().endpoints
    assert loaded.api_key_enc == "v1:stored"


def test_an_endpoint_whose_stored_key_cannot_be_decrypted_is_skipped() -> None:
    seed = Seed([endpoint("local"), endpoint("gpu2", apiKeyEnc="v1:not-for-this-master-key")])
    registry = registry_from_seed(seed, None, env={}, factories=fake_factories())
    assert registry.provider_names == ["local"]


# --- only configured models run (ADR 0010, phase 4) -----------------------------------------


@pytest.mark.parametrize(
    ("ref", "resolved"),
    [
        ("local/a", ("local", "a")),
        ("default", ("local", "a")),
        ("main", ("local", "a")),
        ("ryzen/openai/gpt-oss-20b", ("ryzen", "openai/gpt-oss-20b")),
    ],
)
def test_offered_models_resolve(ref: str, resolved: tuple[str, str]) -> None:
    seed = seeded(
        [endpoint("local", models=["a"]), endpoint("ryzen", models=["openai/gpt-oss-20b"])],
        {"default": "local/a"},
    )
    registry = registry_from_seed(seed, None, env={}, factories=fake_factories())
    provider, model = registry.resolve(ref)
    assert (provider.name, model) == resolved


@pytest.mark.parametrize(
    ("ref", "message"),
    [
        ("local/advertised", "model local/advertised is not offered on endpoint local"),
        ("stale", "model local/gone is not offered on endpoint local"),
        ("ryzen/gpt-oss-20b", "model ryzen/gpt-oss-20b is not offered on endpoint ryzen"),
    ],
)
def test_models_not_offered_never_run(ref: str, message: str) -> None:
    seed = seeded(
        [endpoint("local", models=["a"]), endpoint("ryzen", models=["openai/gpt-oss-20b"])],
        {"stale": "local/gone"},
    )
    registry = registry_from_seed(seed, None, env={}, factories=fake_factories())
    with pytest.raises(ModelResolutionError, match=message):
        registry.resolve(ref)
    with pytest.raises(ModelResolutionError, match="Administration > Models"):
        registry.resolve_ocr(ref)


def test_a_registry_built_from_the_config_file_alone_is_not_restricted() -> None:
    # Tests and tools that build a registry straight from a config keep resolving any model.
    from ingest_worker.llm.registry import build_registry

    cfg = LLMConfig.model_validate(
        {"providers": [{"name": "local", "kind": "openai-chat", "apiKeyRequired": False}]}
    )
    registry = build_registry(cfg, env={}, factories=fake_factories())
    assert registry.resolve("local/anything")[1] == "anything"


def test_a_disabled_model_is_not_offered(harness: StoreHarness) -> None:
    store = harness.store
    store.seed(Seed([endpoint("local", models=["a", "b"])]))
    harness.disable_model("local", "b")
    (local,) = store.load().endpoints
    assert local.models == ["a"]


# --- a model's output limit (Administration > Models) ---------------------------------------


def test_an_offered_models_output_limit_loads_and_moves_the_version(
    harness: StoreHarness,
) -> None:
    store = harness.store
    store.seed(Seed([endpoint("local", models=["a", "b"])]))
    before = store.version()
    harness.set_output_limit("local", "b", 32000)
    assert store.version() != before  # workers rebuild
    (local,) = store.load().endpoints
    assert local.max_output_tokens == {"b": 32000}
    harness.uncurate("local", "b")  # only offered models run, so only theirs load
    (local,) = store.load().endpoints
    assert local.max_output_tokens == {}


@pytest.mark.parametrize(
    ("ref", "limit"),
    [
        ("local/b", 32000),
        ("big", 32000),  # a model choice
        ("draft", 32000),  # the drafting model setting
        ("local/a", None),  # not set: the caller's default
        ("default", None),
    ],
)
def test_the_registry_gives_a_refs_output_limit(ref: str, limit: int | None) -> None:
    seed = seeded(
        [endpoint("local", models=["a", "b"], maxOutputTokens={"b": 32000})],
        {"default": "local/a", "big": "local/b", "draft": "local/b"},
    )
    registry = registry_from_seed(seed, None, env={}, factories=fake_factories())
    assert registry.max_output_tokens(ref) == limit


def test_an_unknown_ref_has_no_output_limit() -> None:
    seed = seeded([endpoint("local", models=["a"])], {"default": "local/a"})
    registry = registry_from_seed(seed, None, env={}, factories=fake_factories())
    assert registry.max_output_tokens("nope/x") is None


# --- a model's parallel calls (Administration > Models) -------------------------------------


def test_an_offered_models_parallel_calls_load_and_move_the_version(
    harness: StoreHarness,
) -> None:
    store = harness.store
    store.seed(Seed([endpoint("local", models=["a", "b"])]))
    before = store.version()
    harness.set_parallel_calls("local", "b", 4)
    assert store.version() != before  # workers rebuild
    (local,) = store.load().endpoints
    assert local.max_concurrent_calls == {"b": 4}
    harness.set_parallel_calls("local", "b", None)
    (local,) = store.load().endpoints
    assert local.max_concurrent_calls == {}


@pytest.mark.parametrize(
    ("ref", "calls"),
    [
        ("local/b", 4),
        ("big", 4),  # a model choice
        ("local/a", None),  # not set: the caller's default (one at a time; OCR its config)
        ("nope/x", None),
    ],
)
def test_the_registry_gives_a_refs_parallel_calls(ref: str, calls: int | None) -> None:
    seed = seeded(
        [endpoint("local", models=["a", "b"], maxConcurrentCalls={"b": 4})],
        {"default": "local/a", "big": "local/b"},
    )
    registry = registry_from_seed(seed, None, env={}, factories=fake_factories())
    assert registry.max_concurrent_calls(ref) == calls


# --- the embedding model (ADR 0011) -----------------------------------------------------------


def test_embedding_model_is_seeded_from_env(llm_config_path: Path) -> None:
    env = {"EMBEDDING_MODEL": " local/nomic-embed "}
    seed = seed_from_config(load_llm_config(llm_config_path, env=env), env=env)
    assert seed.settings["embedding_model"] == "local/nomic-embed"
    seed = seed_from_config(load_llm_config(llm_config_path, env={}), env={})
    assert "embedding_model" not in seed.settings


def test_the_embedding_setting_resolves_only_to_a_provider_that_embeds() -> None:
    seed = seeded(
        [
            endpoint("local", models=["nomic-embed"]),
            endpoint("anthropic", kind="anthropic", models=["c"]),
        ],
        {"embedding": "local/nomic-embed"},
    )
    live = LiveModels(MemoryLlmConfigStore(seed), None, env={}, factories=fake_factories())
    assert live.embedding_model == "local/nomic-embed"
    provider, model = live.registry.resolve_embedding("local/nomic-embed")
    assert (provider.name, model) == ("local", "nomic-embed")
    with pytest.raises(ModelResolutionError, match="cannot embed"):
        live.registry.resolve_embedding("anthropic/c")
    # Never a model to name in a step.
    with pytest.raises(ModelResolutionError):
        live.registry.resolve("embedding")


def test_no_embedding_setting_means_no_embedding_model() -> None:
    live = LiveModels(
        MemoryLlmConfigStore(seeded([endpoint("local", models=["m"])])),
        None,
        env={},
        factories=fake_factories(),
    )
    assert live.embedding_model is None
