/**
 * Failed sign-in limiter (in memory): at most `perIp` failures per client IP and `total`
 * failures overall within `windowMs`. Tokens are 256-bit, so guessing is hopeless anyway; this
 * keeps scanners slow and noisy.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  private all: number[] = [];

  constructor(
    private readonly perIp = 10,
    private readonly total = 100,
    private readonly windowMs = 15 * 60_000,
  ) {}

  allowed(ip: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
    this.all = this.all.filter((t) => t > since);
    const mine = (this.failures.get(ip) ?? []).filter((t) => t > since);
    if (mine.length) this.failures.set(ip, mine);
    else this.failures.delete(ip);
    return mine.length < this.perIp && this.all.length < this.total;
  }

  fail(ip: string, now = Date.now()): void {
    this.failures.set(ip, [...(this.failures.get(ip) ?? []), now]);
    this.all.push(now);
  }
}
