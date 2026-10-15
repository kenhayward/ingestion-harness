/** The API's password rule (ADR 0013, D8): length is checked here first, the rest by the API. */
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 200;
export const PASSWORD_RULES =
  '12 to 200 characters, different from the current one, and not containing your email address. A passphrase of a few words works well.';

/** When a lock ends: the time today, else the date and time, in the viewer's locale. */
export function lockTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === new Date(now).toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

/** A locked account's message (D3). */
export const lockedText = (iso: string) =>
  `Too many failed sign-ins for this account. Try again after ${lockTime(iso)}.`;

/** Why a new password can't be sent yet, or null. */
export function newPasswordProblem(next: string, repeat: string): string | null {
  if (next.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (next.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  if (next !== repeat) return 'The two new passwords differ.';
  return null;
}
