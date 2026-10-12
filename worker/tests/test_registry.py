from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from ingest_worker.llm.base import LLMProvider
from ingest_worker.llm.registry import (
    LLMConfig,
    ProviderConfig,
    build_registry,
    load_llm_config,
)

from .fakes import FakeProvider


def fake_factories(instances: dict[str, FakeProvider]):  # type: ignore[no-untyped-def]
    def make(cfg: ProviderConfig, api_key: str | None) -> LLMProvider:
        p = instances.setdefault(cfg.name, FakeProvider(cfg.name, kind=cfg.kind))
        return p

    return {"anthropic": make, "openai-chat": make, "openai-responses": make}


def config(**overrides: object) -> LLMConfig:
    return LLMConfig.model_validate(
        {
            "providers": [
                {
                    "name": "anthropic",
                    "kind": "anthropic",
                    "apiKeyEnv": "ANTHROPIC_API_KEY",
                    "models": ["claude-opus-5-5"],
                },
                {
                    "name": "local",
                    "kind": "openai-chat",
                    "baseUrl": "http://x/v1",
                    "apiKeyRequired": False,
                },
            ],
            "aliases": {"default": "anthropic/claude-opus-5-5", "cheap": "default"},
            **overrides,
        }
    )


def test_committed_config_parses_with_env_expansion(llm_config_path: Path) -> None:
    cfg = load_llm_config(llm_config_path, env={"LOCAL_LLM_BASE_URL": "http://vllm:8000/v1"})
    local = next(p for p in cfg.providers if p.name == "local")
    assert local.base_url == "http://vllm:8000/v1"
    assert local.enabled is True  # ${LOCAL_LLM_ENABLED:-true}
    assert cfg.aliases["default"] == "local/qwen3.8-27b-mtp"
    assert {"qwen3.8-27b-mtp", "olmocr-2-7b-1025"} <= set(local.models)
    assert cfg.ocr is not None and cfg.ocr.enabled
    assert cfg.ocr.model == "local/olmocr-2-7b-1025"


def test_ocr_can_be_disabled_by_env(llm_config_path: Path) -> None:
    cfg = load_llm_config(llm_config_path, env={"OCR_ENABLED": "false"})
    assert cfg.ocr is not None and not cfg.ocr.enabled


def test_resolves_aliases_transitively() -> None:
    registry = build_registry(
        config(), env={"ANTHROPIC_API_KEY": "k"}, factories=fake_factories({})
    )
    provider, model = registry.resolve("cheap")
    assert (provider.name, model) == ("anthropic", "claude-opus-5-5")
    provider, model = registry.resolve("local/meta/llama-3.1")
    assert (provider.name, model) == ("local", "meta/llama-3.1")


@pytest.mark.parametrize("ref", ["nope", "unknown/model", "anthropic/"])
def test_resolve_rejects_bad_refs(ref: str) -> None:
    registry = build_registry(
        config(), env={"ANTHROPIC_API_KEY": "k"}, factories=fake_factories({})
    )
    with pytest.raises(ValueError):
        registry.resolve(ref)


def test_alias_cycles_are_detected() -> None:
    registry = build_registry(
        config(aliases={"a": "b", "b": "a"}),
        env={"ANTHROPIC_API_KEY": "k"},
        factories=fake_factories({}),
    )
    with pytest.raises(ValueError, match="cycle"):
        registry.resolve("a")


def test_missing_key_fails_unless_optional() -> None:
    with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
        build_registry(config(), env={}, factories=fake_factories({}))

    cfg = config()
    cfg.providers[0].optional = True
    registry = build_registry(cfg, env={}, factories=fake_factories({}))
    assert registry.provider_names == ["local"]


def test_discovery_merges_static_and_discovered_and_tolerates_failures() -> None:
    instances: dict[str, FakeProvider] = {
        "anthropic": FakeProvider("anthropic", models=["claude-haiku-5-5"], kind="anthropic"),
        "local": FakeProvider("local"),
    }
    instances["local"].list_models_error = ConnectionError("endpoint down")
    registry = build_registry(
        config(), env={"ANTHROPIC_API_KEY": "k"}, factories=fake_factories(instances)
    )
    refs = [d.ref for d in registry.discover()]
    assert refs == ["anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5"]


def test_resolution_errors_have_a_dedicated_type() -> None:
    from ingest_worker.llm.registry import ModelResolutionError

    registry = build_registry(
        config(), env={"ANTHROPIC_API_KEY": "k"}, factories=fake_factories({})
    )
    with pytest.raises(ModelResolutionError, match="not configured"):
        registry.resolve("openai/gpt-5")
    assert issubclass(ModelResolutionError, ValueError)


def test_factories_apply_timeout_and_retry_options() -> None:
    from ingest_worker.llm.registry import DEFAULT_FACTORIES

    cfg = ProviderConfig.model_validate(
        {
            "name": "local",
            "kind": "openai-chat",
            "baseUrl": "http://x/v1",
            "options": {"timeoutS": 900, "maxRetries": 0},
        }
    )
    provider: Any = DEFAULT_FACTORIES["openai-chat"](cfg, None)
    assert provider._client.timeout == 900 and provider._client.max_retries == 0

    cfg = ProviderConfig.model_validate(
        {"name": "anthropic", "kind": "anthropic", "options": {"timeoutS": 300, "maxRetries": 1}}
    )
    provider = DEFAULT_FACTORIES["anthropic"](cfg, "key")
    assert provider._client.timeout == 300 and provider._client.max_retries == 1


def test_temperature_option_reaches_openai_providers(llm_config_path: Path) -> None:
    from ingest_worker.llm.registry import DEFAULT_FACTORIES

    cfg = ProviderConfig.model_validate(
        {
            "name": "local",
            "kind": "openai-chat",
            "baseUrl": "http://x/v1",
            "options": {"temperature": 0},
        }
    )
    provider: Any = DEFAULT_FACTORIES["openai-chat"](cfg, None)
    assert provider._temperature == 0
    committed = load_llm_config(llm_config_path, env={})
    local = next(p for p in committed.providers if p.name == "local")
    assert local.options["temperature"] == 0  # deterministic extraction on the local model
    assert committed.ocr is not None and committed.ocr.temperature == 0


def recording_factories(made: list[ProviderConfig]):  # type: ignore[no-untyped-def]
    def make(cfg: ProviderConfig, api_key: str | None) -> LLMProvider:
        made.append(cfg)
        return FakeProvider(cfg.name, kind=cfg.kind)

    return {"anthropic": make, "openai-chat": make, "openai-responses": make}


def test_ocr_base_url_comes_from_env(llm_config_path: Path) -> None:
    cfg = load_llm_config(llm_config_path, env={"OCR_BASE_URL": "http://ocr-box:8000/v1"})
    assert cfg.ocr is not None and cfg.ocr.base_url == "http://ocr-box:8000/v1"
    unset = load_llm_config(llm_config_path, env={})
    assert unset.ocr is not None and unset.ocr.base_url is None  # empty -> same endpoint


def test_ocr_base_url_gives_ocr_its_own_endpoint() -> None:
    made: list[ProviderConfig] = []
    registry = build_registry(
        config(
            ocr={"model": "ocr-model", "baseUrl": "http://ocr-box/v1"},
            aliases={"ocr-model": "local/olmocr"},
        ),
        env={"ANTHROPIC_API_KEY": "k"},
        factories=recording_factories(made),
    )
    ocr_provider, model_id = registry.resolve_ocr("ocr-model")
    extraction_provider, _ = registry.resolve("local/qwen")
    assert model_id == "olmocr"
    # Same provider name, so the OCR cache key (provider/model) is unchanged.
    assert ocr_provider.name == "local" and ocr_provider is not extraction_provider
    assert [c.base_url for c in made if c.name == "local"] == ["http://x/v1", "http://ocr-box/v1"]
    assert registry.provider_names == ["anthropic", "local"]


def test_without_ocr_base_url_ocr_uses_the_regular_provider() -> None:
    registry = build_registry(
        config(ocr={"model": "local/olmocr"}),
        env={"ANTHROPIC_API_KEY": "k"},
        factories=recording_factories([]),
    )
    assert registry.resolve_ocr("local/olmocr")[0] is registry.resolve("local/x")[0]


def test_ocr_base_url_for_an_unconfigured_provider_fails_at_resolution() -> None:
    from ingest_worker.llm.registry import ModelResolutionError

    registry = build_registry(
        config(ocr={"model": "openai/vision", "baseUrl": "http://ocr-box/v1"}),
        env={"ANTHROPIC_API_KEY": "k"},
        factories=recording_factories([]),
    )
    with pytest.raises(ModelResolutionError, match="not configured"):
        registry.resolve_ocr("openai/vision")


def recording_keys(made: list[tuple[str | None, str | None]]):  # type: ignore[no-untyped-def]
    def make(cfg: ProviderConfig, api_key: str | None) -> LLMProvider:
        made.append((cfg.base_url, api_key))
        return FakeProvider(cfg.name, kind=cfg.kind)

    return {"anthropic": make, "openai-chat": make, "openai-responses": make}


def test_committed_config_reads_the_ocr_api_key_from_ocr_api_key(llm_config_path: Path) -> None:
    cfg = load_llm_config(llm_config_path, env={})
    assert cfg.ocr is not None and cfg.ocr.api_key_env == "OCR_API_KEY"


@pytest.mark.parametrize(
    ("ocr", "env", "ocr_client"),
    [
        # OCR_API_KEY wins on the OCR endpoint...
        (
            {"baseUrl": "http://ocr-box/v1"},
            {"OCR_KEY": "ocr-secret", "LOCAL_KEY": "local-secret"},
            ("http://ocr-box/v1", "ocr-secret"),
        ),
        # ...falls back to the provider's own key when unset...
        (
            {"baseUrl": "http://ocr-box/v1"},
            {"LOCAL_KEY": "local-secret"},
            ("http://ocr-box/v1", "local-secret"),
        ),
        # ...and on its own (no OCR_BASE_URL) re-keys the provider's endpoint for OCR.
        ({}, {"OCR_KEY": "ocr-secret", "LOCAL_KEY": "local-secret"}, ("http://x/v1", "ocr-secret")),
    ],
)
def test_ocr_api_key_overrides_the_providers_key(
    ocr: dict[str, str], env: dict[str, str], ocr_client: tuple[str, str]
) -> None:
    cfg = config(ocr={"model": "local/olmocr", "apiKeyEnv": "OCR_KEY", **ocr})
    cfg.providers[1].api_key_env = "LOCAL_KEY"
    made: list[tuple[str | None, str | None]] = []
    registry = build_registry(
        cfg, env={"ANTHROPIC_API_KEY": "k", **env}, factories=recording_keys(made)
    )
    assert made[-1] == ocr_client
    assert made[1] == ("http://x/v1", env["LOCAL_KEY"])  # extraction keeps its own key
    assert registry.resolve_ocr("local/olmocr")[0] is not registry.resolve("local/x")[0]


def test_no_ocr_overrides_means_no_extra_client() -> None:
    made: list[tuple[str | None, str | None]] = []
    build_registry(
        config(ocr={"model": "local/olmocr", "apiKeyEnv": "OCR_KEY"}),
        env={"ANTHROPIC_API_KEY": "k"},
        factories=recording_keys(made),
    )
    assert len(made) == 2  # anthropic + local only
