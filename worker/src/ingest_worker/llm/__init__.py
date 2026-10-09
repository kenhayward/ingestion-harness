"""Provider-agnostic LLM layer: Anthropic, OpenAI Chat Completions, OpenAI Responses.

Any OpenAI-compatible server (vLLM, Ollama, LM Studio, LiteLLM...) is an `openai-chat` or
`openai-responses` provider with a custom `baseUrl` in config/llm-providers.yaml.
"""

from .base import (
    CompletionRequest,
    CompletionResult,
    LLMError,
    LLMProvider,
    ModelDescriptor,
    RefusalError,
)
from .registry import (
    LLMConfig,
    ModelRegistry,
    ModelResolutionError,
    ProviderConfig,
    build_registry,
    load_llm_config,
)

__all__ = [
    "CompletionRequest",
    "CompletionResult",
    "LLMConfig",
    "LLMError",
    "LLMProvider",
    "ModelDescriptor",
    "ModelRegistry",
    "ModelResolutionError",
    "ProviderConfig",
    "RefusalError",
    "build_registry",
    "load_llm_config",
]
