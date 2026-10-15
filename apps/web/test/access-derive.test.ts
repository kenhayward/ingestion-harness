import { describe, expect, it } from 'vitest';
import type { SignInEvent } from '../src/api/client.js';
import {
  deviceName,
  signInResultView,
  userCounts,
  userGroup,
  userMatches,
  userStatusView,
} from '../src/access/derive.js';
import { ADMIN_FROM_LOG, user } from './fake-api.js';

const now = Date.parse('2026-10-15T10:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(now + ms).toISOString();
const time = (ms: number) =>
  new Date(now + ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

describe('userStatusView', () => {
  it.each([
    [
      'admin from the log',
      ADMIN_FROM_LOG,
      'Admin from the log',
      'info',
      'Rotates on every restart',
    ],
    ['active', user(), 'Active', 'ok', null],
    [
      'must change, expiring',
      user({ status: 'must-change', oneTimeExpiresAt: iso(30 * HOUR) }),
      'Must change password',
      'info',
      'One-time password expires in 2 days',
    ],
    [
      'must change, 1 day',
      user({ status: 'must-change', oneTimeExpiresAt: iso(20 * HOUR) }),
      'Must change password',
      'info',
      'One-time password expires in 1 day',
    ],
    [
      'must change, expired',
      user({ status: 'must-change', oneTimeExpiresAt: iso(-HOUR) }),
      'Must change password',
      'warn',
      'One-time password expired: reissue it',
    ],
    [
      'locked',
      user({ status: 'locked', lockedUntil: iso(HOUR / 4), failedSignIns: 10 }),
      `Locked until ${time(HOUR / 4)}`,
      'warn',
      '10 failed sign-ins',
    ],
    [
      'lock ran out',
      user({ lockedUntil: iso(-1), failedSignIns: 10 }),
      'Active',
      'ok',
      '10 failed sign-ins',
    ],
    [
      'disabled by an admin',
      user({
        status: 'disabled',
        disabledReason: 'admin',
        disabledBy: 'Ann',
        disabledAt: iso(-2 * 24 * HOUR),
      }),
      'Disabled',
      'neutral',
      'By Ann, 2 days ago',
    ],
    [
      'disabled by failed sign-ins',
      user({
        status: 'disabled',
        disabledReason: 'failed-sign-ins',
        disabledAt: iso(-HOUR),
        failedSignIns: 20,
      }),
      'Disabled: 20 failed sign-ins',
      'danger',
      '1 h ago',
    ],
    ['failures before a lock', user({ failedSignIns: 3 }), 'Active', 'ok', '3 failed sign-ins'],
    ['one failure', user({ failedSignIns: 1 }), 'Active', 'ok', '1 failed sign-in'],
  ] as const)('%s', (_case, u, label, tone, detail) => {
    expect(userStatusView(u, now)).toEqual({ label, tone, detail });
  });
});

describe('groups and counts', () => {
  it('counts each chip; the admin from the log counts as active', () => {
    const users = [
      ADMIN_FROM_LOG,
      user(),
      user({ status: 'must-change' }),
      user({ status: 'locked' }),
      user({ status: 'disabled' }),
      user({ status: 'disabled' }),
    ];
    expect(userCounts(users)).toEqual({
      all: 6,
      active: 2,
      'must-change': 1,
      locked: 1,
      disabled: 2,
    });
    expect(userGroup(ADMIN_FROM_LOG)).toBe('active');
  });

  it('matches the query by name or email', () => {
    expect(userMatches(user(), 'hayward')).toBe(true);
    expect(userMatches(user(), 'EXAMPLE.com')).toBe(true);
    expect(userMatches(user(), 'zzz')).toBe(false);
    expect(userMatches(ADMIN_FROM_LOG, 'admin')).toBe(true);
    expect(userMatches(user(), '')).toBe(true);
  });
});

const event = (fields: Partial<SignInEvent>): SignInEvent => ({
  id: '1',
  at: iso(0),
  userId: 'u1',
  name: 'Ken',
  result: 'ok',
  failures: null,
  lockedUntil: null,
  ip: '10.0.0.1',
  userAgent: null,
  ...fields,
});

describe('signInResultView', () => {
  it.each([
    [{ result: 'ok' }, 'Signed in', 'ok'],
    [{ result: 'ok', failures: 0 }, 'Signed in', 'ok'],
    [{ result: 'ok', failures: 3 }, 'Signed in after 3 failed attempts', 'warn'],
    [{ result: 'ok', failures: 1 }, 'Signed in after 1 failed attempt', 'warn'],
    [{ result: 'wrong-password', failures: 3 }, 'Wrong password (3 in a row)', 'warn'],
    [{ result: 'wrong-password', failures: 1 }, 'Wrong password', 'warn'],
    [
      { result: 'wrong-password', failures: 10, lockedUntil: iso(HOUR / 4) },
      `Wrong password: locked until ${time(HOUR / 4)}`,
      'danger',
    ],
    [{ result: 'wrong-password', failures: null }, 'Wrong password', 'warn'],
    [{ result: 'unknown-login', userId: null }, 'Unknown email', 'neutral'],
    [{ result: 'locked', lockedUntil: iso(HOUR) }, 'Refused: locked', 'warn'],
    [{ result: 'disabled' }, 'Refused: disabled', 'neutral'],
    [{ result: 'expired-one-time' }, 'One-time password expired', 'neutral'],
    [{ result: 'password-changed' }, 'Password changed', 'ok'],
    [{ result: 'password-change-refused', failures: 2 }, 'Password change refused', 'warn'],
  ] as const)('%j', (fields, label, tone) => {
    expect(signInResultView(event(fields), now)).toEqual({ label, tone });
  });
});

describe('deviceName', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
      'Firefox on Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome on Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Safari on macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari on iPhone',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari on iPad',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome on ChromeOS',
    ],
    ['curl/8.4.0', 'curl/8.4.0'],
    ['x'.repeat(60), 'x'.repeat(40)],
    [null, '—'],
  ])('%s', (ua, name) => {
    expect(deviceName(ua)).toBe(name);
  });
});
