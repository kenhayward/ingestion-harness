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
