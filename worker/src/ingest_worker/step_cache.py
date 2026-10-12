"""Workbench step cache (ADR 0007, phase 4b).

An extract step's output is reused when its full input is unchanged: the rendered prompts
(preamble, instructions, section text and context values are all inside them), the output
schema, the system prompt, the page images, the step id, the resolved model and its provider's
kind, endpoint (baseUrl) and output-affecting options. Entries live in the runs bucket keyed by
content, so identical inputs share one. A hit is still validated against the step's schema
before use (an invalid entry is a miss).

Unlike the OCR cache, which deliberately ignores the endpoint so OCR can move servers without
re-transcribing, the step cache keys on the provider's kind and baseUrl: the same model name on
a different server (LOCAL_LLM_BASE_URL) or adapter may answer differently."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .llm.registry import OPERATIONAL_OPTIONS
from .storage import ObjectStore, step_cache_object_key

__all__ = [
    "CACHE_VERSION",
    "OPERATIONAL_OPTIONS",
    "CachedStep",
    "StepCache",
    "step_cache_key",
]

#: Bump when provider adapters change how requests are shaped or responses are parsed: the
#: rest of the key cannot see such a change, and old entries would otherwise still hit.
CACHE_VERSION = 1


def step_cache_key(
    *,
    model_ref: str,
    provider: dict[str, Any],
    step_id: str,
    system: str,
    schema: dict[str, Any],
    prompts: list[str],
    images: tuple[bytes, ...],
    max_tokens: int,
    max_attempts: int,
) -> str:
    payload = {
        "v": CACHE_VERSION,
        "model": model_ref,
        "provider": provider,
        "step": step_id,
        "system": system,
        "schema": schema,
        "prompts": prompts,
        "images": [hashlib.sha256(image).hexdigest() for image in images],
        "maxTokens": max_tokens,
        "maxAttempts": max_attempts,
    }
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CachedStep:
    data: dict[str, Any]
    model_ref: str
    input_tokens: int | None
    output_tokens: int | None


class StepCache:
    """Reads and writes cached step outputs; `read=False` skips lookups but still writes."""

    def __init__(self, store: ObjectStore, bucket: str, *, read: bool = True) -> None:
        self._store = store
        self._bucket = bucket
        self._read = read

    def get(self, key: str) -> CachedStep | None:
        if not self._read:
            return None
        raw = self._store.get_optional(self._bucket, step_cache_object_key(key))
        if raw is None:
            return None
        try:
            entry = json.loads(raw)
            return CachedStep(
                data=dict(entry["data"]),
                model_ref=str(entry["modelRef"]),
                input_tokens=entry.get("inputTokens"),
                output_tokens=entry.get("outputTokens"),
            )
        except (ValueError, KeyError, TypeError, AttributeError):
            return None  # unreadable: a miss; the fresh result overwrites it

    def put(self, key: str, entry: CachedStep) -> None:
        body = {
            "data": entry.data,
            "modelRef": entry.model_ref,
            "inputTokens": entry.input_tokens,
            "outputTokens": entry.output_tokens,
            "createdAt": datetime.now(UTC).isoformat(),
        }
        self._store.put(
            self._bucket,
            step_cache_object_key(key),
            json.dumps(body, ensure_ascii=False).encode("utf-8"),
            "application/json",
        )
