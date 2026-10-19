import { randomBytes } from 'node:crypto';
import type { HandoffUser } from '@ih/bridge-contract';

/** How long a handoff code stays good: long enough to open a tab, no longer. */
export const HANDOFF_TTL_MS = 60_000;

/**
 * One-time codes that hand a signed-in CT Studio user to the bridge's connections page: minted
 * here for the user, redeemed once by the bridge (a signed server-to-server call) within 60
 * seconds. In memory: the API runs as one instance (ADR 0006).
 */
export class HandoffCodes {
  private readonly codes = new Map<string, { user: HandoffUser; expires: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  mint(user: HandoffUser, now: number = this.clock()): string {
    this.prune(now);
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { user: { ...user }, expires: now + HANDOFF_TTL_MS });
    return code;
  }

  /** The user the code was minted for; null when it is unknown, used or expired. */
  redeem(code: string, now: number = this.clock()): HandoffUser | null {
    const found = this.codes.get(code);
    this.codes.delete(code);
    this.prune(now);
    return found && found.expires > now ? found.user : null;
  }

  private prune(now: number): void {
    for (const [code, { expires }] of this.codes) if (expires <= now) this.codes.delete(code);
  }
}
