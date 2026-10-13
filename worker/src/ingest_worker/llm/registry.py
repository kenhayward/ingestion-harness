from __future__ import annotations

import logging
import os
import re
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .base import LLMProvider, ModelDescriptor, ProviderKind
from .secrets import SecretError, decrypt_secret, secrets_keys

log = logging.getLogger(__name__)


Location = Literal["local", "external"]


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
    #: A key entered in the UI, encrypted by the API (ADR 0010); it wins over `api_key_env`.
    api_key_enc: str | None = Field(default=None, alias="apiKeyEnc")
    api_key_required: bool = Field(default=True, alias="apiKeyRequired")
    #: Skip (with a warning) instead of failing startup when the API key is missing.
    optional: bool = False
    discover: bool = True
    #: Static models, always offered even when discovery fails or is disabled.
    models: list[str] = Field(default_factory=list)
    model_filter: str | None = Field(default=None, alias="modelFilter")
    #: Where requests go (ADR 0007 data policy). Undeclared providers count as external.
    location: Location = "external"
    options: dict[str, Any] = Field(default_factory=dict)

    @field_validator("models", mode="before")
    @classmethod
    def _split_model_lists(cls, value: Any) -> Any:
        """`models: [${LOCAL_LLM_MODELS:-a,b}]` expands to one comma-separated string."""
        if not isinstance(value, list):
            return value
        out: list[str] = []
        for item in value:
            if isinstance(item, str):
                out.extend(m.strip() for m in item.split(",") if m.strip())
            else:
                out.append(item)
        return out


class OcrConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    enabled: bool = True
    #: Alias or provider/model-id of a vision model (olmOCR-style prompt + front matter).
    model: str
    #: Endpoint for the OCR model's provider when OCR runs on a different server than
    #: extraction (OCR_BASE_URL). Empty/unset: the provider's own baseUrl.
    base_url: str | None = Field(default=None, alias="baseUrl")
    #: Env var with the OCR endpoint's API key (OCR_API_KEY). Unset/empty: the provider's key.
    api_key_env: str | None = Field(default=None, alias="apiKeyEnv")
    min_chars: int = Field(default=25, ge=0, alias="minChars")
    longest_dim: int = Field(default=1288, gt=0, alias="longestDim")
    max_tokens: int = Field(default=8000, gt=0, alias="maxTokens")
    temperature: float | None = 0.1
    concurrency: int = Field(default=1, ge=1, le=32)
    #: Reuse transcriptions across jobs of the same PDF (same model and settings).
    cache: bool = True

    @field_validator("base_url")
    @classmethod
    def _empty_is_unset(cls, value: str | None) -> str | None:
        return value or None  # ${OCR_BASE_URL:-} expands to ""


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

#: Env var holding the keys of `LLM_ENDPOINTS` endpoints, as `name=key;name2=key`.
ENDPOINT_KEYS_ENV = "LLM_ENDPOINT_KEYS"


def endpoint_key(cfg: ProviderConfig, env: Mapping[str, str]) -> str | None:
    """The endpoint's API key: the one stored encrypted (entered in the UI), else the one in
    the environment (None when unset or empty). A stored key that cannot be decrypted raises
    `SecretError`: never fall back to another key."""
    if cfg.api_key_enc:
        try:
            return decrypt_secret(cfg.api_key_enc, secrets_keys(env))
        except SecretError as exc:
            raise SecretError(f"provider {cfg.name}: {exc}") from exc
    if not cfg.api_key_env:
        return None
    if cfg.api_key_env == ENDPOINT_KEYS_ENV:
        for entry in (env.get(ENDPOINT_KEYS_ENV) or "").split(";"):
            name, sep, key = entry.partition("=")
            if sep and name.strip() == cfg.name and key.strip():
                return key.strip()
        return None
    return env.get(cfg.api_key_env) or None


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


#: Provider options that never change what a model answers (excluded from step cache keys).
OPERATIONAL_OPTIONS = frozenset({"timeoutS", "maxRetries"})


class ModelRegistry:
    def __init__(
        self,
        providers: dict[str, LLMProvider],
        configs: dict[str, ProviderConfig],
        aliases: dict[str, str],
        ocr_providers: dict[str, LLMProvider] | None = None,
        offered_only: bool = False,
    ) -> None:
        self._providers = providers
        self._configs = configs
        self._aliases = aliases
        #: Only each provider's configured `models` resolve (ADR 0010: endpoints from the
        #: database). A registry built from the config file alone resolves any model id.
        self._offered_only = offered_only
        #: Same-named providers for OCR's own endpoint/key (OcrConfig.base_url, api_key_env).
        self._ocr_providers = ocr_providers or {}

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
        if self._offered_only and model_id not in self._configs[provider_name].models:
            raise ModelResolutionError(
                f"model {ref} is not offered on endpoint {provider_name}: add it on the Models page"
            )
        return provider, model_id

    def location(self, provider_name: str) -> Location:
        """Data-policy location of a configured provider; unknown names count as external."""
        cfg = self._configs.get(provider_name)
        return cfg.location if cfg else "external"

    def options(self, provider_name: str) -> dict[str, Any]:
        """The provider's output-affecting options (operational settings dropped); {} if unknown."""
        cfg = self._configs.get(provider_name)
        if cfg is None:
            return {}
        return {k: v for k, v in cfg.options.items() if k not in OPERATIONAL_OPTIONS}

    def cache_fingerprint(self, provider_name: str) -> dict[str, Any]:
        """What about a provider can change a step's answer: its kind, endpoint and
        output-affecting options (step cache keys)."""
        cfg = self._configs.get(provider_name)
        return {
            "kind": cfg.kind if cfg else None,
            "baseUrl": cfg.base_url if cfg else None,
            "options": self.options(provider_name),
        }

    def resolve_ocr(self, ref: str) -> tuple[LLMProvider, str]:
        """Like resolve(), but uses the provider's OCR endpoint/key when configured. The
        provider keeps its name, so OCR cache keys don't depend on the endpoint."""
        provider, model_id = self.resolve(ref)
        return self._ocr_providers.get(provider.name, provider), model_id

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
    offered_only: bool = False,
) -> ModelRegistry:
    providers: dict[str, LLMProvider] = {}
    configs: dict[str, ProviderConfig] = {}
    for cfg in config.providers:
        if not cfg.enabled:
            continue
        try:
            api_key = endpoint_key(cfg, env)
        except SecretError as exc:
            if not cfg.optional:
                raise
            log.warning("%s — skipping optional provider", exc)
            continue
        if cfg.api_key_required and not api_key:
            msg = f"provider {cfg.name}: environment variable {cfg.api_key_env} is not set"
            if cfg.optional:
                log.warning("%s — skipping optional provider", msg)
                continue
            raise ValueError(msg)
        providers[cfg.name] = factories[cfg.kind](cfg, api_key)
        configs[cfg.name] = cfg
    registry = ModelRegistry(providers, configs, config.aliases, offered_only=offered_only)
    ocr = config.ocr
    ocr_key = env.get(ocr.api_key_env) if ocr and ocr.api_key_env else None
    if ocr is None or not ocr.enabled or not (ocr.base_url or ocr_key):
        return registry
    try:
        name = registry.resolve(ocr.model)[0].name
    except ModelResolutionError:
        return registry  # reported when a job needs OCR, like any unresolvable model
    ocr_cfg = configs[name].model_copy(update={"base_url": ocr.base_url or configs[name].base_url})
    api_key = ocr_key or endpoint_key(ocr_cfg, env)
    ocr_provider = factories[ocr_cfg.kind](ocr_cfg, api_key)
    return ModelRegistry(
        providers, configs, config.aliases, {name: ocr_provider}, offered_only=offered_only
    )
