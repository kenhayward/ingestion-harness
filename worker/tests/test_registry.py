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
