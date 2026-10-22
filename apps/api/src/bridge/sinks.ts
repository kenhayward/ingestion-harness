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

  /** Lists the bridge's sinks again; false (keeping what it had) when the bridge can't say. */
  async refresh(bridge: Pick<BridgeApi, 'listSinks'>): Promise<boolean> {
    try {
      this.sinks = new Map((await bridge.listSinks()).map((s) => [s.id, s]));
      return true;
    } catch {
      return false;
    }
  }

  get(id: string): SinkView | undefined {
    return this.sinks.get(id);
  }

  all(): SinkView[] {
    return [...this.sinks.values()];
  }
}
