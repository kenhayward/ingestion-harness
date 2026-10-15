import type { SignInEvent, User } from '../api/client.js';
import { relativeTime } from '../jobs/derive.js';
import { matchesQuery } from '../shell/derive.js';
import { lockTime } from './passwords.js';

export type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral';
const DAY = 86_400_000;

const failures = (n: number) => `${n} failed sign-in${n === 1 ? '' : 's'}`;

/** A user's status tag (label and tone) and the line under it (ADR 0013). */
export function userStatusView(
  u: User,
  now: number,
): { label: string; tone: Tone; detail: string | null } {
  const counted = u.failedSignIns > 0 ? failures(u.failedSignIns) : null;
  switch (u.status) {
    case 'admin-from-log':
      return { label: 'Admin from the log', tone: 'info', detail: 'Rotates on every restart' };
    case 'locked':
      return {
        label: u.lockedUntil ? `Locked until ${lockTime(u.lockedUntil, now)}` : 'Locked',
        tone: 'warn',
        detail: counted,
      };
    case 'disabled':
      if (u.disabledReason === 'failed-sign-ins') {
        return {
          label: `Disabled: ${failures(u.failedSignIns)}`,
          tone: 'danger',
          detail: u.disabledAt ? relativeTime(u.disabledAt, now) : null,
        };
      }
      return {
        label: 'Disabled',
        tone: 'neutral',
        detail:
          u.disabledBy && u.disabledAt
            ? `By ${u.disabledBy}, ${relativeTime(u.disabledAt, now).toLowerCase()}`
            : null,
      };
    case 'must-change': {
      if (!u.oneTimeExpiresAt)
        return { label: 'Must change password', tone: 'info', detail: counted };
      const left = Date.parse(u.oneTimeExpiresAt) - now;
      if (left <= 0) {
        return {
          label: 'Must change password',
          tone: 'warn',
          detail: 'One-time password expired: reissue it',
        };
      }
      const days = Math.ceil(left / DAY);
      return {
        label: 'Must change password',
        tone: 'info',
        detail: `One-time password expires in ${days} day${days === 1 ? '' : 's'}`,
      };
    }
    default:
      return { label: 'Active', tone: 'ok', detail: counted };
  }
}

export type UserGroup = 'active' | 'must-change' | 'locked' | 'disabled';

/** The filter chip a user falls under (the admin from the log counts as active). */
export function userGroup(u: User): UserGroup {
  return u.status === 'admin-from-log' ? 'active' : u.status;
}

export function userCounts(users: User[]): Record<'all' | UserGroup, number> {
  const counts = { all: users.length, active: 0, 'must-change': 0, locked: 0, disabled: 0 };
  for (const u of users) counts[userGroup(u)] += 1;
  return counts;
}

/** The top-bar search: name or email. */
export const userMatches = (u: User, query: string) => matchesQuery(query, u.name, u.email ?? '');

/** A sign-in event's result in words, and its tone (ADR 0013, D11). */
export function signInResultView(e: SignInEvent, now: number): { label: string; tone: Tone } {
  switch (e.result) {
    case 'ok':
      return e.failures
        ? {
            label: `Signed in after ${e.failures} failed attempt${e.failures === 1 ? '' : 's'}`,
            tone: 'warn',
          }
        : { label: 'Signed in', tone: 'ok' };
    case 'wrong-password':
      if (e.lockedUntil) {
        return {
          label: `Wrong password: locked until ${lockTime(e.lockedUntil, now)}`,
          tone: 'danger',
        };
      }
      return {
        label:
          e.failures && e.failures > 1
            ? `Wrong password (${e.failures} in a row)`
            : 'Wrong password',
        tone: 'warn',
      };
    case 'unknown-login':
      return { label: 'Unknown email', tone: 'neutral' };
    case 'locked':
      return { label: 'Refused: locked', tone: 'warn' };
    case 'disabled':
      return { label: 'Refused: disabled', tone: 'neutral' };
    case 'expired-one-time':
      return { label: 'One-time password expired', tone: 'neutral' };
    case 'password-changed':
      return { label: 'Password changed', tone: 'ok' };
    case 'password-change-refused':
      return { label: 'Password change refused', tone: 'warn' };
  }
}

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

/** A user agent as "Browser on System"; anything else its first 40 characters; none "—". */
export function deviceName(userAgent: string | null): string {
  if (!userAgent) return '—';
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return userAgent.slice(0, 40);
}
