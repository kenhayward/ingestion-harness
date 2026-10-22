import type { SinkView } from '@ih/bridge-contract';
import type { BridgeApi } from './client.js';

/**
 * The bridge's sinks as it last listed them (`GET /v1/sinks`): their names, fields and
 * capabilities, for target forms, locking and recipe checks. Refreshed by every pull of the
 * targets and every Published outputs list; a sink it doesn't know is checked by the bridge
 * alone.
 */
export class SinkCatalog {
  private sinks = new Map<string, SinkView>();
  private askedAt: number | null = null;
  private lastOk = false;
  private readonly ttlMs: number;
  private readonly now: () => number;

  /** `ttlMs`: how long a listing (or a failed try) stands before the bridge is asked again. */
  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Lists the bridge's sinks again, at most once per time to live (`force`: now); false
   * (keeping what it had) when the bridge can't say. A request never waits on the bridge twice
   * in a row while it is down.
   */
  async refresh(
    bridge: Pick<BridgeApi, 'listSinks'>,
    opts: { force?: boolean } = {},
  ): Promise<boolean> {
    const at = this.now();
    if (!opts.force && this.askedAt !== null && at - this.askedAt < this.ttlMs) return this.lastOk;
    this.askedAt = at;
    try {
      this.sinks = new Map((await bridge.listSinks()).map((s) => [s.id, s]));
      this.lastOk = true;
    } catch {
      this.lastOk = false;
    }
    return this.lastOk;
  }

  get(id: string): SinkView | undefined {
    return this.sinks.get(id);
  }

  all(): SinkView[] {
    return [...this.sinks.values()];
  }
}
