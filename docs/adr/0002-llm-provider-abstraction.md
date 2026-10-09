# 0002 — Multi-provider LLM layer with discovery

**Status:** accepted · 2026-10-09

## Context
Extraction must run on Anthropic and OpenAI models (Responses and Chat Completions formats) and on
custom OpenAI-compatible endpoints (local LLMs), with several selectable models and automatic
model discovery.

## Decision
A small `LLMProvider` protocol (`list_models`, `complete_json`) with three adapters
(`anthropic`, `openai-responses`, `openai-chat`) built on the official SDKs. Providers, static
models, discovery filters and aliases live in `config/llm-providers.yaml` with `${ENV}` expansion.
Discovered models are upserted into `llm_models`; the UI offers them as per-job overrides.
Output is always constrained by the extraction's JSON Schema and re-validated locally.

## Consequences
- Specs reference aliases (`default`, `fast`) so models can change without new spec versions.
- Local servers vary in structured-output support: `responseFormat` (`json_schema` /
  `json_object` / `none`) per provider; local validation + retry covers the gap.
- Provider-specific features (e.g. sending PDFs directly to Claude, prompt caching) are added
  inside the adapter behind optional request fields, keeping the pipeline provider-neutral.
