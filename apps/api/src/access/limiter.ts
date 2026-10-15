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

/** A sign-in attempt being checked; `done(ok)` frees its place (a failure is then counted). */
export interface AttemptSlot {
  done(ok: boolean): void;
}

/**
 * Failed sign-in limiter (in memory): at most `perClient` failures per client (IP, or IPv6 /64)
 * within `windowMs`, counting the client's attempts still being checked (`begin`), so a burst
 * of parallel requests cannot slip past it. There is deliberately no global block on failures:
 * it would let anyone lock every user out. A surge across many clients is only reported
 * (`surge()`), for the logs. Separately, at most `maxInFlight` attempts are checked at once
 * across every client ('busy'): each costs a 32 MiB scrypt on libuv's small thread pool, which
 * file and DNS work share (ADR 0013). Per-account lockout is the main guessing defence.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly pending = new Map<string, number>();
  private inFlight = 0;

  constructor(
    private readonly perClient = 10,
    private readonly surgeThreshold = 100,
    private readonly windowMs = 15 * 60_000,
    private readonly maxInFlight = 8,
  ) {}

  /**
   * Reserve a place for an attempt: null when the client is over its limit (failures plus its
   * attempts in flight), 'busy' when too many attempts are being checked at once.
   */
  begin(ip: string, now = Date.now()): AttemptSlot | 'busy' | null {
    this.prune(now);
    const key = clientKey(ip);
    const pending = this.pending.get(key) ?? 0;
    if ((this.failures.get(key)?.length ?? 0) + pending >= this.perClient) return null;
    if (this.inFlight >= this.maxInFlight) return 'busy';
    this.pending.set(key, pending + 1);
    this.inFlight += 1;
    let open = true;
    return {
      done: (ok: boolean) => {
        if (!open) return;
        open = false;
        this.inFlight -= 1;
        const left = (this.pending.get(key) ?? 1) - 1;
        if (left > 0) this.pending.set(key, left);
        else this.pending.delete(key);
        if (!ok) this.fail(ip);
      },
    };
  }

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
