/** IPv6 clients usually own a whole /64: count them as one. */
function clientKey(ip: string): string {
  if (!ip.includes(':') || ip.startsWith('::ffff:')) return ip;
  const [head = '', tail = ''] = ip.split('::');
  const groups = [...head.split(':').filter(Boolean)];
  const fill = 8 - groups.length - tail.split(':').filter(Boolean).length;
  for (let i = 0; i < fill; i++) groups.push('0');
  groups.push(...tail.split(':').filter(Boolean));
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * Failed sign-in limiter (in memory): at most `perClient` failures per client (IP, or IPv6 /64)
 * within `windowMs`. There is deliberately no global block: it would let anyone lock every
 * user out. A surge across many clients is only reported (`surge()`), for the logs. Tokens are
 * 256-bit, so guessing is hopeless anyway; this keeps scanners slow and noisy.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly perClient = 10,
    private readonly surgeThreshold = 100,
    private readonly windowMs = 15 * 60_000,
  ) {}

  allowed(ip: string, now = Date.now()): boolean {
    this.prune(now);
    return (this.failures.get(clientKey(ip))?.length ?? 0) < this.perClient;
  }

  fail(ip: string, now = Date.now()): void {
    const key = clientKey(ip);
    this.failures.set(key, [...(this.failures.get(key) ?? []), now]);
  }

  /** Many failures overall within the window: worth a log line, never a lockout. */
  surge(now = Date.now()): boolean {
    this.prune(now);
    let total = 0;
    for (const times of this.failures.values()) total += times.length;
    return total >= this.surgeThreshold;
  }

  /** Clients currently tracked (memory stays bounded by the window). */
  size(): number {
    return this.failures.size;
  }

  private prune(now: number): void {
    const since = now - this.windowMs;
    for (const [key, times] of this.failures) {
      const recent = times.filter((t) => t > since);
      if (recent.length) this.failures.set(key, recent);
      else this.failures.delete(key);
    }
  }
}
