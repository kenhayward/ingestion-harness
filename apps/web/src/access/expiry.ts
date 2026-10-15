import type { S3Key } from '../api/client.js';

/** Anything with an expiry and a key-like status (data-lake S3 keys). */
type Expiring = Pick<S3Key, 'status' | 'expiresAt'>;

export type Expiry = '1' | '7' | '30' | '90' | '365' | 'never';

/** Expiry presets for S3 keys (the API accepts exactly these). */
export const EXPIRY_OPTIONS: readonly { value: Expiry; label: string }[] = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];

export const expiryDays = (e: Expiry): number | null => (e === 'never' ? null : Number(e));

const DAY = 86_400_000;

/** An active key that stops working within `days` (the list shows it amber). */
export function expiresSoon(key: Expiring, now: number, days = 7): boolean {
  if (key.status !== 'active' || !key.expiresAt) return false;
  const left = Date.parse(key.expiresAt) - now;
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
export function expiryText(key: Expiring, now: number): { date: string | null; relative: string } {
  if (!key.expiresAt) return { date: null, relative: 'Never' };
  return {
    date: new Date(key.expiresAt).toLocaleDateString(),
    relative: relative(Date.parse(key.expiresAt) - now),
  };
}
