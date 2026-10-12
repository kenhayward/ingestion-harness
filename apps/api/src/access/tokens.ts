import { createHash, randomBytes } from 'node:crypto';

/** An access token: `ih_` + 32 random bytes (base64url). Shown once; only its hash is stored. */
export function newToken(): string {
  return `ih_${randomBytes(32).toString('base64url')}`;
}

/** A browser session id (cookie value). Only its hash is stored. */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens and session ids are high-entropy, so a plain (fast) SHA-256 is the right hash. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
