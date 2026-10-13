"""Endpoint keys stored by the API (ADR 0010): the worker decrypts what TypeScript encrypted,
held in step by packages/shared/test/fixtures/llm-secret.json."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from ingest_worker.llm.registry import ProviderConfig, endpoint_key
from ingest_worker.llm.secrets import SecretError, decrypt_secret, secrets_keys

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "shared"
        / "test"
        / "fixtures"
        / "llm-secret.json"
    ).read_text(encoding="utf-8")
)
ENV = {
    "LLM_SECRETS_KEY": FIXTURE["key"],
    "LLM_SECRETS_KEY_PREVIOUS": FIXTURE["previousKey"],
}


def test_decrypts_what_the_api_encrypted() -> None:
    keys = secrets_keys(ENV)
    assert decrypt_secret(FIXTURE["ciphertext"], keys) == FIXTURE["plaintext"]
    assert decrypt_secret(FIXTURE["previousCiphertext"], keys) == "sk-older-key"


def test_refuses_a_wrong_key_a_tampered_value_and_an_unknown_format() -> None:
    only_previous = secrets_keys({"LLM_SECRETS_KEY": FIXTURE["previousKey"]})
    with pytest.raises(SecretError, match="cannot be decrypted"):
        decrypt_secret(FIXTURE["ciphertext"], only_previous)
    raw = bytearray(base64.b64decode(FIXTURE["ciphertext"][3:]))
    raw[20] ^= 1
    with pytest.raises(SecretError, match="cannot be decrypted"):
        decrypt_secret("v1:" + base64.b64encode(bytes(raw)).decode(), secrets_keys(ENV))
    with pytest.raises(SecretError, match="unknown key format"):
        decrypt_secret("v2:abc", secrets_keys(ENV))


def test_no_master_key_means_no_keys() -> None:
    assert secrets_keys({}) == []
    assert secrets_keys({"LLM_SECRETS_KEY": ""}) == []
    with pytest.raises(SecretError, match="LLM_SECRETS_KEY must be 32 bytes"):
        secrets_keys({"LLM_SECRETS_KEY": "short"})


def stored(**over: object) -> ProviderConfig:
    data: dict[str, object] = {
        "name": "gpu2",
        "kind": "openai-chat",
        "baseUrl": "http://gpu2/v1",
        "apiKeyEnv": "LLM_ENDPOINT_KEYS",
        "apiKeyEnc": FIXTURE["ciphertext"],
    }
    data.update(over)
    return ProviderConfig.model_validate(data)


def test_a_stored_key_wins_over_the_environment() -> None:
    env = {**ENV, "LLM_ENDPOINT_KEYS": "gpu2=from-env"}
    assert endpoint_key(stored(), env) == FIXTURE["plaintext"]
    assert endpoint_key(stored(apiKeyEnc=None), env) == "from-env"


def test_a_stored_key_that_cannot_be_decrypted_is_an_error() -> None:
    # Never fall back to the env key (or no key): the endpoint must be skipped.
    with pytest.raises(SecretError, match="gpu2"):
        endpoint_key(stored(), {"LLM_ENDPOINT_KEYS": "gpu2=from-env"})
