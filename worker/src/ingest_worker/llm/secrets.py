"""Endpoint keys entered in the UI (ADR 0010): the API encrypts them with AES-256-GCM under
`LLM_SECRETS_KEY` as `v1:base64(nonce‖ciphertext‖tag)` (apps/api/src/llm/secrets.ts); the
worker only decrypts. Both sides test against packages/shared/test/fixtures/llm-secret.json."""

from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_PREFIX = "v1:"
_NONCE = 12


class SecretError(ValueError):
    """A stored key cannot be used: unknown format, wrong master key or tampered."""


def _master_key(name: str, value: str | None) -> bytes | None:
    if not value:
        return None
    try:
        key = base64.b64decode(value.strip(), validate=True)
    except binascii.Error:
        key = b""
    if len(key) != 32:
        raise SecretError(f"{name} must be 32 bytes, base64 (openssl rand -base64 32)")
    return key


def secrets_keys(env: Mapping[str, str]) -> list[bytes]:
    """`LLM_SECRETS_KEY` then `LLM_SECRETS_KEY_PREVIOUS` (a rotation); [] when unset."""
    current = _master_key("LLM_SECRETS_KEY", env.get("LLM_SECRETS_KEY"))
    if current is None:
        return []
    previous = _master_key("LLM_SECRETS_KEY_PREVIOUS", env.get("LLM_SECRETS_KEY_PREVIOUS"))
    return [current] if previous is None else [current, previous]


def decrypt_secret(stored: str, keys: list[bytes]) -> str:
    if not stored.startswith(_PREFIX):
        raise SecretError("unknown key format")
    try:
        raw = base64.b64decode(stored[len(_PREFIX) :], validate=True)
    except binascii.Error as exc:
        raise SecretError("the stored key cannot be decrypted (not base64)") from exc
    for key in keys:
        try:
            plain = AESGCM(key).decrypt(raw[:_NONCE], raw[_NONCE:], None)
        except InvalidTag:
            continue  # wrong key or tampered: try the previous key
        return plain.decode("utf-8")
    raise SecretError("the stored key cannot be decrypted with LLM_SECRETS_KEY")
