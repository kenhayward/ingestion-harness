import type { AccessToken } from '../api/client.js';

/** Anything with an expiry and an access-token-like status (user tokens, S3 keys). */
type Expiring = Pick<AccessToken, 'status' | 'expiresAt'>;

export type Expiry = '1' | '7' | '30' | '90' | '365' | 'never';

/** Expiry presets for tokens and S3 keys (the API accepts exactly these). */
export const EXPIRY_OPTIONS: readonly { value: Expiry; label: string }[] = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];

/** Admin tokens must expire, so they offer every preset but Never. */
export const ADMIN_EXPIRY_OPTIONS = EXPIRY_OPTIONS.filter((o) => o.value !== 'never');

export const expiryDays = (e: Expiry): number | null => (e === 'never' ? null : Number(e));

export type TokenGroup = 'active' | 'expired' | 'revoked';

/** The current admin token counts as active (it signs people in until the next restart). */
export const tokenGroup = (status: AccessToken['status']): TokenGroup =>
  status === 'current-admin' ? 'active' : status;

export function tokenCounts(tokens: readonly AccessToken[]) {
  const counts = { all: tokens.length, active: 0, expired: 0, revoked: 0 };
  for (const t of tokens) counts[tokenGroup(t.status)]++;
  return counts;
}

const DAY = 86_400_000;

/** An active user token that stops working within `days` (the list shows it amber). */
export function expiresSoon(token: Expiring, now: number, days = 7): boolean {
  if (token.status !== 'active' || !token.expiresAt) return false;
  const left = Date.parse(token.expiresAt) - now;
  return left > 0 && left <= days * DAY;
}

const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "in 2 days" / "6 weeks ago"; whole units, rounded down. */
function relative(ms: number): string {
  const past = ms < 0;
  const mins = Math.floor(Math.abs(ms) / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  const text =
    days >= 14
      ? unit(Math.floor(days / 7), 'week')
      : days >= 1
        ? unit(days, 'day')
        : hours >= 1
          ? `${hours} h`
          : `${mins} min`;
  return past ? `${text} ago` : `in ${text}`;
}

/** The Expires cell: the date (null when there isn't one) and how far away it is. */
export function expiryText(
  token: Expiring,
  now: number,
): { date: string | null; relative: string } {
  if (token.status === 'current-admin') return { date: null, relative: 'On restart' };
  if (!token.expiresAt) return { date: null, relative: 'Never' };
  return {
    date: new Date(token.expiresAt).toLocaleDateString(),
    relative: relative(Date.parse(token.expiresAt) - now),
  };
}
