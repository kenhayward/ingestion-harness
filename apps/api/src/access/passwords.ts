import { randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** scrypt parameters (ADR 0013). Stored in each hash, so they can be raised later. */
export const SCRYPT_N = 32768;
let N = SCRYPT_N;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 200;

/**
 * The cost new hashes use (default `SCRYPT_N`). Only the API tests lower it (test/setup.ts), so
 * signing in does not dominate the suite; hashes made at any cost still verify.
 */
export function setScryptCost(n: number): void {
  if (!Number.isInteger(n) || n < 2 || n > 2 ** 20 || (n & (n - 1)) !== 0) {
    throw new Error('scrypt cost must be a power of two from 2 to 2^20');
  }
  N = n;
}

function derive(plain: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(plain.normalize('NFKC'), salt, KEY_BYTES, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(plain, salt, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** False for a wrong password and for anything that is not one of our hashes. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, key] = stored.split('$');
  if (kind !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  if (expected.length !== KEY_BYTES) return false;
  try {
    const actual = await derive(plain, Buffer.from(salt, 'base64url'), {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Verified against when the email is unknown, so timing does not reveal which emails exist. At
 * the current cost, so it takes as long as checking a real hash.
 */
export const dummyHash = () => `scrypt$${N}$${R}$${P}$${'A'.repeat(22)}$${'A'.repeat(43)}`;

const OTP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 16 characters in groups of 4 (about 79 bits): easy to read out, nothing ambiguous. */
export function newOneTimePassword(): string {
  const chars = Array.from({ length: 16 }, () => OTP_ALPHABET[randomInt(OTP_ALPHABET.length)]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/** Why a new password is refused, or null (ADR 0013, D8). */
export function passwordProblem(
  plain: string,
  ctx: { email: string | null; current?: string },
): string | null {
  if (plain.length < MIN_PASSWORD) return `passwords need at least ${MIN_PASSWORD} characters`;
  if (plain.length > MAX_PASSWORD) return `passwords can have at most ${MAX_PASSWORD} characters`;
  if (ctx.current !== undefined && plain === ctx.current) {
    return 'choose a password different from the current one';
  }
  const local = ctx.email?.split('@')[0] ?? '';
  if (local.length >= 4 && plain.toLowerCase().includes(local.toLowerCase())) {
    return 'the password must not contain your email address';
  }
  return null;
}
