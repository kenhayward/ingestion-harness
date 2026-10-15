import { describe, expect, it } from 'vitest';
import { LoginLimiter } from '../src/access/limiter.js';

describe('LoginLimiter', () => {
  it('blocks an IP after 10 failures in 15 minutes, then forgives', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 10; i++) l.fail('203.0.113.5', 0);
    expect(l.allowed('203.0.113.5', 1)).toBe(false);
    expect(l.allowed('203.0.113.6', 1)).toBe(true);
    expect(l.allowed('203.0.113.5', 15 * 60_000 + 1)).toBe(true);
  });

  it('cannot be used to lock everyone out (no global block)', () => {
    const l = new LoginLimiter();
    for (let ip = 0; ip < 50; ip++) for (let i = 0; i < 10; i++) l.fail(`198.51.100.${ip}`, 0);
    expect(l.allowed('203.0.113.9', 1)).toBe(true);
    expect(l.surge(1)).toBe(true); // reported, not enforced
  });

  it('treats an IPv6 /64 as one client', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 10; i++) l.fail(`2001:db8:1:2::${i + 1}`, 0);
    expect(l.allowed('2001:db8:1:2:ffff::1', 1)).toBe(false);
    expect(l.allowed('2001:db8:1:3::1', 1)).toBe(true);
  });

  it('forgets clients whose failures have aged out (bounded memory)', () => {
    const l = new LoginLimiter();
    for (let ip = 0; ip < 200; ip++) l.fail(`198.51.100.${ip % 250}`, 0);
    expect(l.size()).toBeGreaterThan(0);
    l.allowed('203.0.113.1', 15 * 60_000 + 1);
    expect(l.size()).toBe(0);
  });
});

/** A slot that must have been granted (neither over the limit nor busy). */
function granted(limiter: LoginLimiter, ip: string) {
  const slot = limiter.begin(ip);
  if (slot === null || slot === 'busy') throw new Error(`no slot for ${ip}: ${slot}`);
  return slot;
}

describe('LoginLimiter: attempts in flight', () => {
  it('counts attempts still being checked towards the per-client limit', () => {
    const limiter = new LoginLimiter(10, 100, 15 * 60_000, 100); // a global cap above 10
    const held = Array.from({ length: 10 }, () => granted(limiter, '203.0.113.9'));
    expect(limiter.begin('203.0.113.9')).toBeNull();
    expect(limiter.begin('203.0.113.10')).not.toBeNull(); // other clients are unaffected
    held[0]!.done(true); // a success frees its place
    expect(limiter.begin('203.0.113.9')).not.toBeNull();
  });

  it('turns a failed attempt into a failure, and frees it either way', () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < 10; i++) granted(limiter, '203.0.113.9').done(false);
    expect(limiter.allowed('203.0.113.9')).toBe(false);
    expect(limiter.begin('203.0.113.9')).toBeNull();
  });

  it('caps the attempts being checked at once across every client', () => {
    const limiter = new LoginLimiter(10, 100, 15 * 60_000, 3);
    const slots = [1, 2, 3].map((n) => granted(limiter, `203.0.113.${n}`));
    expect(limiter.begin('203.0.113.4')).toBe('busy');
    slots[0]!.done(true);
    expect(limiter.begin('203.0.113.4')).not.toBeNull();
  });

  it('ignores a second done()', () => {
    const limiter = new LoginLimiter(10, 100, 15 * 60_000, 1);
    const slot = granted(limiter, '203.0.113.1');
    slot.done(false);
    slot.done(false);
    expect(limiter.begin('203.0.113.2')).not.toBe('busy');
    expect(limiter.size()).toBe(1);
  });
});
