import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HandoffUserSchema, type HandoffUser } from '@ih/bridge-contract';
import { z } from 'zod';

export const SESSION_COOKIE = 'bridge_session';
export const SESSION_SECONDS = 30 * 60;

/** Who is using the connections page, and the token their forms must carry. */
export interface PageSession {
  user: HandoffUser;
  csrf: string;
  /** Unix seconds. */
  expires: number;
}

const SessionSchema = z.strictObject({
  user: HandoffUserSchema,
  csrf: z.string().min(1),
  expires: z.number().int(),
});

const mac = (key: string, payload: string) =>
  createHmac('sha256', `page-session\n${key}`).update(payload).digest('base64url');

/** A new session for `user`, valid for 30 minutes from `now` (ms). */
export function newSession(user: HandoffUser, now: number): PageSession {
  return {
    user,
    csrf: randomBytes(24).toString('base64url'),
    expires: Math.floor(now / 1000) + SESSION_SECONDS,
  };
}

/** The cookie value: the session as base64url JSON, HMAC-signed with the bridge's client key. */
export function sealSession(s: PageSession, key: string): string {
  const payload = Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${payload}.${mac(key, payload)}`;
}

/** The session in a cookie value; null when it is missing, tampered with or expired. */
export function openSession(
  value: string | undefined,
  key: string,
  now: number,
): PageSession | null {
  if (!value) return null;
  const [payload, given, extra] = value.split('.');
  if (!payload || !given || extra !== undefined) return null;
  const expected = Buffer.from(mac(key, payload));
  const actual = Buffer.from(given);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = SessionSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    if (!parsed.success || parsed.data.expires <= Math.floor(now / 1000)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Whether a form's token is the session's. */
export function csrfMatches(session: PageSession, given: unknown): boolean {
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(session.csrf);
  return a.length === b.length && timingSafeEqual(a, b);
}
