-- API keys entered in the UI for an LLM endpoint (ADR 0010, phase 3): AES-256-GCM under
-- LLM_SECRETS_KEY as `v1:base64(nonce|ciphertext|tag)`, written by the API, read by the worker.
-- A stored key wins over api_key_env; seeding from .env never touches it.
ALTER TABLE llm_endpoints ADD COLUMN api_key_enc text;
