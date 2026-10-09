from __future__ import annotations

import logging
import os
import re
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .base import LLMProvider, ModelDescriptor, ProviderKind

log = logging.getLogger(__name__)


class ModelResolutionError(ValueError):
    """A model alias/ref cannot be resolved to a configured provider (a config error, not
    something a retry will fix)."""


_ENV_REF = re.compile(r"\$\{([A-Z0-9_]+)(?::-([^}]*))?\}")


class ProviderConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]*$")
    kind: ProviderKind
    enabled: bool = True
    base_url: str | None = Field(default=None, alias="baseUrl")
    api_key_env: str | None = Field(default=None, alias="apiKeyEnv")
    api_key_required: bool = Field(default=True, alias="apiKeyRequired")
    #: Skip (with a warning) instead of failing startup when the API key is missing.
    optional: bool = False
    discover: bool = True
    #: Static models, always offered even when discovery fails or is disabled.
    models: list[str] = Field(default_factory=list)
    model_filter: str | None = Field(default=None, alias="modelFilter")
    options: dict[str, Any] = Field(default_factory=dict)


class OcrConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    enabled: bool = True
    #: Alias or provider/model-id of a vision model (olmOCR-style prompt + front matter).
    model: str
    min_chars: int = Field(default=25, ge=0, alias="minChars")
    longest_dim: int = Field(default=1288, gt=0, alias="longestDim")
    max_tokens: int = Field(default=8000, gt=0, alias="maxTokens")
    temperature: float | None = 0.1
    concurrency: int = Field(default=1, ge=1, le=32)


class LLMConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    providers: list[ProviderConfig]
    aliases: dict[str, str] = Field(default_factory=dict)
    ocr: OcrConfig | None = None


def _expand_env(value: Any, env: Mapping[str, str]) -> Any:
    """Expand ${VAR} / ${VAR:-default} in every string of a parsed YAML tree."""
    if isinstance(value, str):
        return _ENV_REF.sub(lambda m: env.get(m.group(1)) or (m.group(2) or ""), value)
    if isinstance(value, list):
        return [_expand_env(v, env) for v in value]
    if isinstance(value, dict):
        return {k: _expand_env(v, env) for k, v in value.items()}
    return value


def load_llm_config(path: Path, env: Mapping[str, str] = os.environ) -> LLMConfig:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return LLMConfig.model_validate(_expand_env(raw, env))


ProviderFactory = Callable[[ProviderConfig, str | None], LLMProvider]


def _anthropic_factory(cfg: ProviderConfig, api_key: str | None) -> LLMProvider:
    import anthropic

    from .anthropic_provider import AnthropicProvider

    client = anthropic.Anthropic(
        api_key=api_key,
        base_url=cfg.base_url,
        timeout=float(cfg.options.get("timeoutS", 600)),
        max_retries=int(cfg.options.get("maxRetries", 2)),
    )
    return AnthropicProvider(
        cfg.name,
        client,
        effort=cfg.options.get("effort", "high"),
        server_fallbacks=bool(cfg.options.get("serverFallbacks", True)),
    )


def _openai_factory(cfg: ProviderConfig, api_key: str | None) -> LLMProvider:
    import openai

    from .openai_providers import OpenAIChatProvider, OpenAIResponsesProvider

    client = openai.OpenAI(
        api_key=api_key or "not-needed",
        base_url=cfg.base_url,
        timeout=float(cfg.options.get("timeoutS", 600)),
        max_retries=int(cfg.options.get("maxRetries", 2)),
    )
    cls = OpenAIChatProvider if cfg.kind == "openai-chat" else OpenAIResponsesProvider
    return cls(
        cfg.name,
        client,
        model_filter=cfg.model_filter,
        strict=bool(cfg.options.get("strict", True)),
        response_format=cfg.options.get("responseFormat", "json_schema"),
        max_tokens_param=cfg.options.get("maxTokensParam"),
        temperature=(
            float(cfg.options["temperature"])
            if cfg.options.get("temperature") is not None
            else None
        ),
    )


DEFAULT_FACTORIES: dict[str, ProviderFactory] = {
    "anthropic": _anthropic_factory,
    "openai-chat": _openai_factory,
    "openai-responses": _openai_factory,
}


class ModelRegistry:
    def __init__(
        self,
        providers: dict[str, LLMProvider],
        configs: dict[str, ProviderConfig],
        aliases: dict[str, str],
    ) -> None:
        self._providers = providers
        self._configs = configs
        self._aliases = aliases

    @property
    def provider_names(self) -> list[str]:
        return list(self._providers)

    def resolve(self, ref: str) -> tuple[LLMProvider, str]:
        """Resolve an alias or "provider/model-id" to a provider and model id."""
        seen: list[str] = []
        while ref in self._aliases:
            if ref in seen:
                raise ModelResolutionError(f"alias cycle: {' -> '.join([*seen, ref])}")
            seen.append(ref)
            ref = self._aliases[ref]
        provider_name, sep, model_id = ref.partition("/")
        if not sep or not model_id:
            raise ModelResolutionError(f"unknown model alias or malformed ref {ref!r}")
        provider = self._providers.get(provider_name)
        if provider is None:
            raise ModelResolutionError(
                f"model {ref!r}: provider {provider_name!r} is not configured/enabled"
            )
        return provider, model_id

    def discover(self) -> list[ModelDescriptor]:
        """Static models plus each provider's discovered models. Discovery errors are logged,
        not raised — a down local endpoint must not stop the worker."""
        found: dict[str, ModelDescriptor] = {}
        for name, provider in self._providers.items():
            cfg = self._configs[name]
            for model_id in cfg.models:
                d = ModelDescriptor(name, cfg.kind, model_id)
                found[d.ref] = d
            if not cfg.discover:
                continue
            try:
                for d in provider.list_models():
                    found[d.ref] = d  # discovered entries carry display names
            except Exception as exc:
                log.warning("model discovery failed for provider %s: %s", name, exc)
        return sorted(found.values(), key=lambda d: d.ref)


def build_registry(
    config: LLMConfig,
    env: Mapping[str, str] = os.environ,
    factories: Mapping[str, ProviderFactory] = DEFAULT_FACTORIES,
) -> ModelRegistry:
    providers: dict[str, LLMProvider] = {}
    configs: dict[str, ProviderConfig] = {}
    for cfg in config.providers:
        if not cfg.enabled:
            continue
        api_key = env.get(cfg.api_key_env) if cfg.api_key_env else None
        if cfg.api_key_required and not api_key:
            msg = f"provider {cfg.name}: environment variable {cfg.api_key_env} is not set"
            if cfg.optional:
                log.warning("%s — skipping optional provider", msg)
                continue
            raise ValueError(msg)
        providers[cfg.name] = factories[cfg.kind](cfg, api_key)
        configs[cfg.name] = cfg
    return ModelRegistry(providers, configs, config.aliases)
