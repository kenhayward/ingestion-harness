import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADERS = {
  timestamp: 'x-bridge-timestamp',
  nonce: 'x-bridge-nonce',
  signature: 'x-bridge-signature',
} as const;

/** How far a request's timestamp may be from the verifier's clock, either way. */
export const REPLAY_WINDOW_SECONDS = 300;

const unixNow = () => Math.floor(Date.now() / 1000);

interface Signable {
  method: string;
  /** The path with its query string, exactly as sent. */
  path: string;
  body: Buffer | string;
}

function signature(key: string, r: Signable, timestamp: string, nonce: string): string {
  const bodyHash = createHash('sha256').update(r.body).digest('hex');
  const canonical = [r.method.toUpperCase(), r.path, timestamp, nonce, bodyHash].join('\n');
  return createHmac('sha256', key).update(canonical).digest('hex');
}

/** The three headers that sign `req` with `key`. */
export function signRequest(
  key: string,
  req: Signable,
  now: () => number = unixNow,
  nonce: () => string = randomUUID,
): Record<string, string> {
  const timestamp = String(now());
  const n = nonce();
  return {
    [SIGNATURE_HEADERS.timestamp]: timestamp,
    [SIGNATURE_HEADERS.nonce]: n,
    [SIGNATURE_HEADERS.signature]: signature(key, req, timestamp, n),
  };
}

/** Nonces seen inside the replay window. */
export interface NonceStore {
  /** True when `nonce` was already seen (and not yet expired); records it either way. */
  seen(nonce: string, expiresAtSeconds: number, nowSeconds: number): boolean;
}

/** One process's nonces; enough while the verifier runs as a single instance. */
export class MemoryNonceStore implements NonceStore {
  private readonly nonces = new Map<string, number>();

  seen(nonce: string, expiresAtSeconds: number, nowSeconds: number): boolean {
    for (const [n, expires] of this.nonces) if (expires < nowSeconds) this.nonces.delete(n);
    const known = this.nonces.has(nonce);
    if (!known) this.nonces.set(nonce, expiresAtSeconds);
    return known;
  }
}

export type VerifyResult =
  { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'replayed' | 'bad_signature' };

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Whether `req` carries a fresh, unreplayed signature made with `key`. */
export function verifyRequest(
  key: string,
  req: Signable & { headers: Record<string, string | string[] | undefined> },
  nonces: NonceStore,
  now: () => number = unixNow,
): VerifyResult {
  const timestamp = header(req.headers, SIGNATURE_HEADERS.timestamp);
  const nonce = header(req.headers, SIGNATURE_HEADERS.nonce);
  const given = header(req.headers, SIGNATURE_HEADERS.signature);
  if (!timestamp || !nonce || !given) return { ok: false, reason: 'missing' };
  const at = Number(timestamp);
  const current = now();
  if (!Number.isInteger(at) || Math.abs(current - at) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: 'stale' };
  }
  const expected = Buffer.from(signature(key, req, timestamp, nonce), 'hex');
  const actual = Buffer.from(given, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (nonces.seen(nonce, at + REPLAY_WINDOW_SECONDS, current)) {
    return { ok: false, reason: 'replayed' };
  }
  return { ok: true };
}
