import { describe, expect, it } from 'vitest';
import type { AccessToken } from '../src/api/client.js';
import { expiresSoon, expiryText, tokenCounts, tokenGroup } from '../src/access/derive.js';

const now = Date.parse('2026-10-12T12:00:00Z');
const at = (ms: number) => new Date(now + ms).toISOString();
const H = 3_600_000;
const D = 24 * H;
const token = (o: Partial<AccessToken> = {}): AccessToken => ({
  id: 'x',
  label: 'Ken',
  role: 'user',
  createdAt: at(-10 * D),
  expiresAt: at(30 * D),
  revokedAt: null,
  lastUsedAt: null,
  status: 'active',
  ...o,
});

describe('tokenGroup / tokenCounts', () => {
  it('groups the current admin with active tokens', () => {
    expect(tokenGroup('current-admin')).toBe('active');
    expect(tokenGroup('revoked')).toBe('revoked');
    expect(
      tokenCounts([
        token({ status: 'current-admin' }),
        token(),
        token({ status: 'expired' }),
        token({ status: 'revoked' }),
      ]),
    ).toEqual({ all: 4, active: 2, expired: 1, revoked: 1 });
  });
});

describe('expiresSoon', () => {
  it.each<[Partial<AccessToken>, boolean]>([
    [{ expiresAt: at(2 * D) }, true],
    [{ expiresAt: at(7 * D) }, true],
    [{ expiresAt: at(8 * D) }, false],
    [{ expiresAt: at(5 * H) }, true],
    [{ expiresAt: null }, false],
    [{ expiresAt: at(-1 * D), status: 'expired' }, false],
    [{ expiresAt: at(2 * D), status: 'revoked' }, false],
    [{ expiresAt: null, status: 'current-admin', role: 'admin' }, false],
  ])('%j → %s', (o, soon) => expect(expiresSoon(token(o), now)).toBe(soon));
});

describe('expiryText', () => {
  it.each<[Partial<AccessToken>, string]>([
    [{ status: 'current-admin', role: 'admin', expiresAt: null }, 'On restart'],
    [{ expiresAt: null }, 'Never'],
    [{ expiresAt: at(2 * D) }, 'in 2 days'],
    [{ expiresAt: at(1 * D) }, 'in 1 day'],
    [{ expiresAt: at(5 * H) }, 'in 5 h'],
    [{ expiresAt: at(20 * 60_000) }, 'in 20 min'],
    [{ expiresAt: at(-3 * D), status: 'expired' }, '3 days ago'],
    [{ expiresAt: at(-45 * D), status: 'expired' }, '6 weeks ago'],
    [{ expiresAt: at(-2 * H), status: 'active' }, '2 h ago'],
  ])('%j → %s', (o, relative) => expect(expiryText(token(o), now).relative).toBe(relative));

  it('gives the date alongside', () => {
    const iso = at(2 * D);
    expect(expiryText(token({ expiresAt: iso }), now).date).toBe(
      new Date(iso).toLocaleDateString(),
    );
    expect(expiryText(token({ expiresAt: null }), now).date).toBeNull();
  });
});
