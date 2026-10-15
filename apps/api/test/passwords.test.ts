import { describe, expect, it } from 'vitest';
import {
  DUMMY_HASH,
  hashPassword,
  newOneTimePassword,
  normaliseEmail,
  passwordProblem,
  verifyPassword,
} from '../src/access/passwords.js';

describe('passwords', () => {
  it('hashes with a fresh salt and verifies', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterY', a)).toBe(false);
  });

  it('refuses malformed stored hashes instead of throwing', async () => {
    for (const bad of ['', 'scrypt$1$2', 'bcrypt$x', 'scrypt$32768$8$1$!!$!!']) {
      expect(await verifyPassword('x', bad)).toBe(false);
    }
  });

  it('has a dummy hash that verifies nothing', async () => {
    expect(await verifyPassword('', DUMMY_HASH)).toBe(false);
  });

  it('makes readable one-time passwords', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = newOneTimePassword();
      expect(p).toMatch(/^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });

  it.each([
    ['short', 'a'.repeat(11), null, 'passwords need at least 12 characters'],
    ['long', 'a'.repeat(201), null, 'passwords can have at most 200 characters'],
    [
      'email',
      'kenhayward-2026!',
      'kenhayward@x.com',
      'the password must not contain your email address',
    ],
    ['ok', 'a perfectly fine phrase', 'ken@x.com', null],
    ['short local part is ignored', 'bob is my uncle ok', 'bob@x.com', null],
  ])('policy: %s', (_case, pw, email, problem) => {
    expect(passwordProblem(pw, { email })).toBe(problem);
  });

  it('policy: must differ from the current password', () => {
    expect(
      passwordProblem('same old phrase!', { email: null, current: 'same old phrase!' }),
    ).toBe('choose a password different from the current one');
  });

  it('normalises emails', () => {
    expect(normaliseEmail('  Ken@Stocks-Hayward.COM ')).toBe('ken@stocks-hayward.com');
  });
});
