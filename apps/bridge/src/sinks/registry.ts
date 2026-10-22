import { readFileSync } from 'node:fs';
import { bridgeError, RESOURCE_ID, type SinkDescribe } from '@ih/bridge-contract';
import { SinkError, type SinkPort, type SinkRegistry } from './port.js';

/** One registered external sink, as BRIDGE_SINKS lists it. */
export interface SinkEntry {
  id: string;
  url: string;
  /** The key the bridge signs its calls to this sink with. */
  key: string;
}

const BUILT_IN = new Set(['s3', 'rdf']);

/** Why an entry is refused (never its key); null when it is good. */
function entryProblem(e: Record<string, unknown>): string | null {
  if (typeof e.id !== 'string' || !RESOURCE_ID.test(e.id)) {
    return 'the id is 1-40 of a-z, 0-9, _ and -, starting with a letter or digit';
  }
  if (BUILT_IN.has(e.id)) return 's3 and rdf are built in';
  let url: URL | null = null;
  try {
    url = typeof e.url === 'string' ? new URL(e.url) : null;
  } catch {
    url = null;
  }
  if (
    !url ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search
  ) {
    return 'url is an http(s) URL with no credentials and no query';
  }
  if (typeof e.key !== 'string' || e.key.length < 32) return 'key is at least 32 characters';
  return null;
}

/**
 * The external sinks of BRIDGE_SINKS (a JSON list of `{ id, url, key }`), or of the file
 * BRIDGE_SINKS_FILE names (for a Docker secret). Unset is none. Any problem stops the bridge,
 * naming the entry but never its key.
 */
export function parseSinkEntries(env: NodeJS.ProcessEnv): SinkEntry[] {
  const inline = env.BRIDGE_SINKS?.trim() ?? '';
  const file = env.BRIDGE_SINKS_FILE?.trim() ?? '';
  if (inline && file) throw new Error('BRIDGE_SINKS or BRIDGE_SINKS_FILE, not both');
  const source = file ? 'BRIDGE_SINKS_FILE' : 'BRIDGE_SINKS';
  const text = file ? readFileSync(file, 'utf8') : inline;
  if (!text.trim()) return [];
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not JSON`);
  }
  if (!Array.isArray(list)) throw new Error(`${source} is a JSON list of sinks`);
  const seen = new Set<string>();
  return list.map((raw: unknown, i) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const name = typeof e.id === 'string' && e.id ? e.id : `#${i + 1}`;
    const problem = entryProblem(e) ?? (seen.has(name) ? 'the id is used twice' : null);
    if (problem) throw new Error(`${source}: sink ${name}: ${problem}`);
    seen.add(name);
    return { id: e.id as string, url: e.url as string, key: e.key as string };
  });
}

/**
 * What the bridge uses of a sink's describe. An external sink's `withdraw` and `readBack` are
 * not used yet (contract v1 names their routes but not their bodies), so they read as false:
 * nothing offers to withdraw from it or read back through it.
 */
export function effectiveDescribe(id: string, d: SinkDescribe): SinkDescribe {
  if (BUILT_IN.has(id)) return d;
  return { ...d, capabilities: { ...d.capabilities, withdraw: false, readBack: false } };
}

/**
 * Sinks with their describes cached: `refresh()` describes each one (at start, then on an
 * interval), and `get(id).describe()` answers from the cache. A sink whose describe fails keeps
 * its last good answer but is `unavailable`; one never described has no describe, so whatever
 * needs it is refused as retryable. Every other call goes straight to the sink.
 */
export class CachingSinkRegistry implements SinkRegistry {
  private readonly described = new Map<string, SinkDescribe>();
  private readonly available = new Set<string>();
  private readonly ports = new Map<string, SinkPort>();

  constructor(private readonly sinks: Record<string, SinkPort>) {
    for (const [id, sink] of Object.entries(sinks)) this.ports.set(id, this.cached(id, sink));
  }

  async refresh(): Promise<void> {
    await Promise.all(
      Object.entries(this.sinks).map(async ([id, sink]) => {
        try {
          this.described.set(id, await sink.describe());
          this.available.add(id);
        } catch {
          this.available.delete(id);
        }
      }),
    );
  }

  /** Describes again the sinks that are unavailable now (a sink that started late, or blinked). */
  async refreshUnavailable(): Promise<void> {
    await Promise.all(
      Object.entries(this.sinks)
        .filter(([id]) => !this.available.has(id))
        .map(async ([id, sink]) => {
          try {
            this.described.set(id, await sink.describe());
            this.available.add(id);
          } catch {
            // Still unavailable: the next try, or the full refresh, sees it again.
          }
        }),
    );
  }

  status(id: string): 'available' | 'unavailable' {
    return this.available.has(id) ? 'available' : 'unavailable';
  }

  get(id: string): SinkPort | null {
    return this.ports.get(id) ?? null;
  }

  ids(): string[] {
    return Object.keys(this.sinks);
  }

  private cached(id: string, sink: SinkPort): SinkPort {
    const port = Object.create(sink) as SinkPort;
    port.describe = async () => {
      const d = this.described.get(id);
      if (!d) {
        throw new SinkError(
          bridgeError('sink_unavailable', `the sink ${id} has not described itself yet`),
        );
      }
      return effectiveDescribe(id, structuredClone(d));
    };
    return port;
  }
}
