import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Connection secrets at rest: AES-256-GCM under `BRIDGE_SECRETS_KEY` (32 bytes, base64), stored
 * as `v1:base64(nonce‖ciphertext‖tag)`. The same algorithm and format as CT Studio's LLM keys
 * (apps/api/src/llm/secrets.ts), copied rather than imported because the bridge imports nothing
 * from apps/api; `test/secrets.test.ts` decrypts the shared fixture to prove the formats equal.
 */
export interface SecretsKeys {
  /** Encrypts new values, and is tried first. */
  current: Buffer;
  /** `BRIDGE_SECRETS_KEY_PREVIOUS`: still decrypts during a rotation. */
  previous: Buffer | null;
}

const PREFIX = 'v1:';
const NONCE = 12;
const TAG = 16;

/** A 32-byte master key written as base64 (`openssl rand -base64 32`); throws otherwise. */
export function parseMasterKey(value: string, name = 'the key'): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value.trim()) {
    throw new Error(`${name} must be 32 bytes, base64 (openssl rand -base64 32)`);
  }
  return key;
}

export function encryptSecret(plaintext: string, keys: SecretsKeys): string {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', keys.current, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
}

export function decryptSecret(stored: string, keys: SecretsKeys): string {
  if (!stored.startsWith(PREFIX)) throw new Error('unknown secret format');
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
  throw new Error('the stored secret cannot be decrypted with BRIDGE_SECRETS_KEY');
}
