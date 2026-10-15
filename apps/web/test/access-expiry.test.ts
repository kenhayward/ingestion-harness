import { describe, expect, it } from 'vitest';
import type { S3Key } from '../src/api/client.js';
import { expiresSoon, expiryText } from '../src/access/expiry.js';

const now = Date.parse('2026-10-12T12:00:00Z');
const at = (ms: number) => new Date(now + ms).toISOString();
const H = 3_600_000;
const D = 24 * H;
const key = (o: Partial<S3Key> = {}): S3Key => ({
  id: 'x',
  accessKeyId: 'AKIA',
  createdAt: at(-10 * D),
  expiresAt: at(30 * D),
  revokedAt: null,
  status: 'active',
  ...o,
});

describe('expiresSoon', () => {
  it.each<[Partial<S3Key>, boolean]>([
    [{ expiresAt: at(2 * D) }, true],
    [{ expiresAt: at(7 * D) }, true],
    [{ expiresAt: at(8 * D) }, false],
    [{ expiresAt: at(5 * H) }, true],
    [{ expiresAt: null }, false],
    [{ expiresAt: at(-1 * D), status: 'expired' }, false],
    [{ expiresAt: at(2 * D), status: 'revoked' }, false],
  ])('%j → %s', (o, soon) => expect(expiresSoon(key(o), now)).toBe(soon));
});

describe('expiryText', () => {
  it.each<[Partial<S3Key>, string]>([
    [{ expiresAt: null }, 'Never'],
    [{ expiresAt: at(2 * D) }, 'in 2 days'],
    [{ expiresAt: at(1 * D) }, 'in 1 day'],
    [{ expiresAt: at(5 * H) }, 'in 5 h'],
    [{ expiresAt: at(20 * 60_000) }, 'in 20 min'],
    [{ expiresAt: at(-3 * D), status: 'expired' }, '3 days ago'],
    [{ expiresAt: at(-45 * D), status: 'expired' }, '6 weeks ago'],
    [{ expiresAt: at(-2 * H), status: 'active' }, '2 h ago'],
  ])('%j → %s', (o, relative) => expect(expiryText(key(o), now).relative).toBe(relative));

  it('gives the date alongside', () => {
    const iso = at(2 * D);
    expect(expiryText(key({ expiresAt: iso }), now).date).toBe(new Date(iso).toLocaleDateString());
    expect(expiryText(key({ expiresAt: null }), now).date).toBeNull();
  });
});
