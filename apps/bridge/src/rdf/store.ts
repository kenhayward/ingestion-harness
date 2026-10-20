import { bridgeError } from '@ih/bridge-contract';
import { SinkError } from '../sinks/port.js';

/** The predicate each published graph carries its version under (ADR 0011, `ct:graphVersion`). */
export const GRAPH_VERSION = 'https://id.stocks-hayward.com/ns/ct#graphVersion';

/**
 * A triple store's named graphs (SPARQL 1.1 Graph Store Protocol): the `rdf` sink's only way to
 * Fuseki. Every failure is a SinkError in contract terms.
 */
export interface GraphStorePort {
  /** Replace the graph with `body`. */
  put(graphIri: string, body: string, contentType: 'text/turtle'): Promise<void>;
  /** Drop the graph; false when there was none. */
  delete(graphIri: string): Promise<boolean>;
  /** The graph's `ct:graphVersion` (the greatest, if several), or null when it has none. */
  version(graphIri: string): Promise<number | null>;
  /** Whether the dataset answers these credentials (Test connection). */
  ping(): Promise<void>;
}

export interface HttpGraphStoreOptions {
  endpoint: string;
  dataset: string;
  user: string | null;
  password: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Fuseki over HTTP: `{endpoint}/{dataset}/data?graph=` and `{endpoint}/{dataset}/sparql`. */
export class HttpGraphStore implements GraphStorePort {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly auth: string | null;

  constructor(opts: HttpGraphStoreOptions) {
    this.base = `${opts.endpoint.replace(/\/+$/, '')}/${opts.dataset}`;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.auth = opts.user
      ? `Basic ${Buffer.from(`${opts.user}:${opts.password ?? ''}`).toString('base64')}`
      : null;
  }

  private dataUrl(graphIri: string): string {
    return `${this.base}/data?graph=${encodeURIComponent(graphIri)}`;
  }

  /** One request; a transport error or 5xx is retryable, 401/403 the credentials, else content. */
  private async request(url: string, init: RequestInit, what: string): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.auth) headers.set('authorization', this.auth);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SinkError(
        bridgeError('instance_unavailable', `the triple store did not answer ${what}`),
      );
    }
    if (res.ok || res.status === 404) return res;
    await res.body?.cancel();
    if (res.status >= 500) {
      throw new SinkError(
        bridgeError('instance_unavailable', `the triple store answered ${res.status} to ${what}`),
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new SinkError(
        bridgeError(
          'credential_rejected',
          `the triple store refused these credentials (${res.status})`,
        ),
      );
    }
    throw new SinkError(
      bridgeError('content_rejected', `the triple store refused ${what} (${res.status})`),
    );
  }

  async put(graphIri: string, body: string, contentType: 'text/turtle'): Promise<void> {
    const res = await this.request(
      this.dataUrl(graphIri),
      { method: 'PUT', headers: { 'content-type': `${contentType}; charset=utf-8` }, body },
      'a graph',
    );
    await res.body?.cancel();
    if (res.status === 404) {
      throw new SinkError(bridgeError('content_rejected', 'the triple store has no such dataset'));
    }
  }

  async delete(graphIri: string): Promise<boolean> {
    const res = await this.request(this.dataUrl(graphIri), { method: 'DELETE' }, 'a graph drop');
    await res.body?.cancel();
    return res.status !== 404;
  }

  private async query(sparql: string, what: string): Promise<unknown> {
    const res = await this.request(
      `${this.base}/sparql`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/sparql-query',
          accept: 'application/sparql-results+json',
        },
        body: sparql,
      },
      what,
    );
    if (res.status === 404) {
      await res.body?.cancel();
      throw new SinkError(bridgeError('content_rejected', 'the triple store has no such dataset'));
    }
    return res.json();
  }

  async version(graphIri: string): Promise<number | null> {
    const g = `<${graphIri}>`;
    const answer = (await this.query(
      `SELECT ?v WHERE { GRAPH ${g} { ${g} <${GRAPH_VERSION}> ?v } }`,
      'a version query',
    )) as { results?: { bindings?: { v?: { value?: string } }[] } };
    const versions = (answer.results?.bindings ?? [])
      .map((b) => Number.parseInt(b.v?.value ?? '', 10))
      .filter((v) => Number.isInteger(v));
    return versions.length ? Math.max(...versions) : null;
  }

  async ping(): Promise<void> {
    await this.query('ASK {}', 'a test query');
  }
}

/** In-memory graphs for tests: the version is read from the stored Turtle's `ct:graphVersion`. */
export class MemoryGraphStore implements GraphStorePort {
  readonly graphs = new Map<string, string>();

  async put(graphIri: string, body: string, _contentType: 'text/turtle'): Promise<void> {
    this.graphs.set(graphIri, body);
  }

  async delete(graphIri: string): Promise<boolean> {
    return this.graphs.delete(graphIri);
  }

  async version(graphIri: string): Promise<number | null> {
    const body = this.graphs.get(graphIri);
    if (body === undefined) return null;
    const escaped = GRAPH_VERSION.replace(/[.*+?^${}()|[\]\\/#]/g, '\\$&');
    const match = new RegExp(`<${escaped}>\\s+"?(\\d+)`).exec(body);
    return match ? Number(match[1]) : null;
  }

  async ping(): Promise<void> {}
}
