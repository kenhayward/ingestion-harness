import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_ENV_NAMES } from '../src/connections/repo.js';
import { decryptSecret, encryptSecret, parseMasterKey } from '../src/secrets.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../packages/shared/test/fixtures/llm-secret.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>;

const keys = {
  current: parseMasterKey(fixture.key!),
  previous: parseMasterKey(fixture.previousKey!),
};

describe('bridge secrets', () => {
  it('decrypts the shared fixture under the current and the previous key', () => {
    expect(decryptSecret(fixture.ciphertext!, keys)).toBe(fixture.plaintext);
    expect(decryptSecret(fixture.previousCiphertext!, keys)).toBe('sk-older-key');
  });

  it('encrypting then decrypting returns the input', () => {
    const stored = encryptSecret('s3cr3t-ü', keys);
    expect(stored.startsWith('v1:')).toBe(true);
    expect(decryptSecret(stored, keys)).toBe('s3cr3t-ü');
  });

  it('refuses a ciphertext under an unknown key', () => {
    const other = { current: parseMasterKey(fixture.previousKey!), previous: null };
    expect(() => decryptSecret(fixture.ciphertext!, other)).toThrow(/cannot be decrypted/);
  });

  it('refuses a key that is not 32 bytes of base64', () => {
    expect(() => parseMasterKey('short', 'BRIDGE_SECRETS_KEY')).toThrow(/BRIDGE_SECRETS_KEY/);
  });

  it('allows the same credential variables as the API', () => {
    const api = readFileSync(
      new URL('../../api/src/publish-targets/stores.ts', import.meta.url),
      'utf8',
    );
    const block = /CREDENTIAL_ENV_NAMES[^[]*\[([^\]]*)\]/.exec(api)![1]!;
    const names = [...block.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
    expect([...CREDENTIAL_ENV_NAMES].sort()).toEqual(names.sort());
  });
});
