import { describe, expect, it } from 'vitest';
import { MemoryNonceStore, signRequest, verifyRequest } from '../src/index.js';

const key = 'k'.repeat(32);
const req = { method: 'POST', path: '/v1/deliveries', body: '{"a":1}' };
const signed = (at = 1000, nonce = 'n1') =>
  signRequest(
    key,
    req,
    () => at,
    () => nonce,
  );

describe('request signing', () => {
  it('accepts what it signed', () => {
    const headers = signed();
    expect(verifyRequest(key, { ...req, headers }, new MemoryNonceStore(), () => 1000)).toEqual({
      ok: true,
    });
  });

  it('accepts a Buffer body the same as its string', () => {
    const headers = signed();
    const body = Buffer.from(req.body);
    expect(
      verifyRequest(key, { ...req, body, headers }, new MemoryNonceStore(), () => 1000).ok,
    ).toBe(true);
  });

  it.each([
    ['changed body', { body: '{"a":2}' }, key],
    ['other path', { path: '/v1/other' }, key],
    ['other method', { method: 'PUT' }, key],
    ['wrong key', {}, 'x'.repeat(32)],
  ])('refuses a %s', (_name, change, verifyKey) => {
    const headers = signed();
    const result = verifyRequest(
      verifyKey,
      { ...req, ...change, headers },
      new MemoryNonceStore(),
      () => 1000,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a signature of the wrong length', () => {
    const headers = { ...signed(), 'x-bridge-signature': 'abc' };
    expect(verifyRequest(key, { ...req, headers }, new MemoryNonceStore(), () => 1000)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a stale timestamp, in either direction', () => {
    const headers = signed(1000);
    const store = new MemoryNonceStore();
    expect(verifyRequest(key, { ...req, headers }, store, () => 1301)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(verifyRequest(key, { ...req, headers }, store, () => 699)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('refuses a replayed nonce', () => {
    const headers = signed();
    const store = new MemoryNonceStore();
    expect(verifyRequest(key, { ...req, headers }, store, () => 1000).ok).toBe(true);
    expect(verifyRequest(key, { ...req, headers }, store, () => 1001)).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  it('refuses missing headers', () => {
    expect(verifyRequest(key, { ...req, headers: {} }, new MemoryNonceStore(), () => 1000)).toEqual(
      {
        ok: false,
        reason: 'missing',
      },
    );
  });

  it('forgets nonces once their window has passed', () => {
    const store = new MemoryNonceStore();
    expect(store.seen('n', 10, 0)).toBe(false);
    expect(store.seen('n', 10, 5)).toBe(true);
    expect(store.seen('n', 30, 11)).toBe(false);
  });
});
