import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * API keys of LLM endpoints entered in the UI (ADR 0010): AES-256-GCM under a master key from
 * `.env` (`LLM_SECRETS_KEY`, 32 bytes base64), stored as `v1:base64(nonce‖ciphertext‖tag)`.
 * The API encrypts and never returns a key; the worker decrypts (`llm/secrets.py`). Both sides
 * test against `packages/shared/test/fixtures/llm-secret.json`.
 */
export interface SecretsKeys {
  /** Encrypts new values, and is tried first. */
  current: Buffer;
  /** `LLM_SECRETS_KEY_PREVIOUS`: still decrypts during a rotation. */
  previous: Buffer | null;
}

const PREFIX = 'v1:';
const NONCE = 12;
const TAG = 16;

function masterKey(name: string, value: string | undefined): Buffer | null {
  if (!value) return null;
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value.trim()) {
    throw new Error(`${name} must be 32 bytes, base64 (openssl rand -base64 32)`);
  }
  return key;
}

/** The master keys from the environment; null when `LLM_SECRETS_KEY` is unset (no UI keys). */
export function secretsKeys(env: Record<string, string | undefined>): SecretsKeys | null {
  const current = masterKey('LLM_SECRETS_KEY', env.LLM_SECRETS_KEY);
  if (!current) return null;
  return {
    current,
    previous: masterKey('LLM_SECRETS_KEY_PREVIOUS', env.LLM_SECRETS_KEY_PREVIOUS),
  };
}

export function encryptSecret(plaintext: string, keys: SecretsKeys): string {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', keys.current, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
}

export function decryptSecret(stored: string, keys: SecretsKeys): string {
  if (!stored.startsWith(PREFIX)) throw new Error('unknown key format');
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  for (const key of [keys.current, keys.previous]) {
    if (!key) continue;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE));
      decipher.setAuthTag(raw.subarray(raw.length - TAG));
      return Buffer.concat([
        decipher.update(raw.subarray(NONCE, raw.length - TAG)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Wrong key or tampered: try the previous key, then give up.
    }
  }
  throw new Error('the stored key cannot be decrypted with LLM_SECRETS_KEY');
}
