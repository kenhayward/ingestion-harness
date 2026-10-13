import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, secretsKeys } from '../src/llm/secrets.js';

/** Shared with worker/tests/test_llm_secrets.py: both sides read and write the same format. */
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../packages/shared/test/fixtures/llm-secret.json', import.meta.url),
    'utf8',
  ),
) as {
  key: string;
  previousKey: string;
  plaintext: string;
  ciphertext: string;
  previousCiphertext: string;
};

const keys = secretsKeys({
  LLM_SECRETS_KEY: fixture.key,
  LLM_SECRETS_KEY_PREVIOUS: fixture.previousKey,
})!;

describe('LLM endpoint key encryption', () => {
  it('decrypts the shared fixture', () => {
    expect(decryptSecret(fixture.ciphertext, keys)).toBe(fixture.plaintext);
  });

  it('round-trips with a fresh nonce every time', () => {
    const a = encryptSecret('sk-live-key', keys);
    const b = encryptSecret('sk-live-key', keys);
    expect(a).toMatch(/^v1:[A-Za-z0-9+/]+=*$/);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, keys)).toBe('sk-live-key');
  });

  it('decrypts with the previous key during a rotation, encrypts with the current one', () => {
    expect(decryptSecret(fixture.previousCiphertext, keys)).toBe('sk-older-key');
    const onlyPrevious = secretsKeys({ LLM_SECRETS_KEY: fixture.previousKey })!;
    expect(() => decryptSecret(encryptSecret('x', keys), onlyPrevious)).toThrow(
      'the stored key cannot be decrypted with LLM_SECRETS_KEY',
    );
  });

  it('refuses a tampered value', () => {
    const raw = Buffer.from(fixture.ciphertext.slice(3), 'base64');
    raw[20] = raw[20]! ^ 1;
    expect(() => decryptSecret(`v1:${raw.toString('base64')}`, keys)).toThrow(
      'cannot be decrypted',
    );
    expect(() => decryptSecret('v2:abc', keys)).toThrow('unknown key format');
  });

  it.each([
    [{}, null],
    [{ LLM_SECRETS_KEY: '' }, null],
  ])('has no keys without LLM_SECRETS_KEY (%o)', (env, expected) => {
    expect(secretsKeys(env)).toBe(expected);
  });

  it('refuses a master key that is not 32 bytes of base64', () => {
    expect(() => secretsKeys({ LLM_SECRETS_KEY: 'short' })).toThrow(
      'LLM_SECRETS_KEY must be 32 bytes, base64 (openssl rand -base64 32)',
    );
  });
});
