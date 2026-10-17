import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { TripleStoreDump } from './ports.js';

/**
 * The whole Fuseki dataset through the Graph Store Protocol on `/{dataset}/data` (the `ct-writer`
 * endpoint): GET without `?graph` returns every graph as N-Quads, PUT replaces them all. Checked
 * against Fuseki 6.2.0 (the backup task's spike).
 */

export interface FusekiOptions {
  /** `RDF_ENDPOINT`; blank = no triple store. */
  endpoint: string;
  /** `RDF_DATASET` (default `ct`). */
  dataset: string;
  user: string;
  password: string;
}

const NQUADS = 'application/n-quads';

export function datasetUrl(opts: Pick<FusekiOptions, 'endpoint' | 'dataset'>): string {
  return `${opts.endpoint.trim().replace(/\/+$/, '')}/${encodeURIComponent(opts.dataset)}/data`;
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

export class FusekiTripleStore implements TripleStoreDump {
  /** `fetchFn` is for tests. */
  constructor(
    private readonly opts: FusekiOptions,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async available(): Promise<boolean> {
    return this.opts.endpoint.trim() !== '';
  }

  private async send(init: RequestInit & { duplex?: 'half' }, what: string): Promise<Response> {
    const res = await this.fetchFn(datasetUrl(this.opts), {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        authorization: basicAuth(this.opts.user, this.opts.password),
      },
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`the triple store refused to ${what}: ${res.status} ${text}`.trim());
    }
    return res;
  }

  async dump(): Promise<Readable> {
    const res = await this.send({ method: 'GET', headers: { accept: NQUADS } }, 'dump its dataset');
    if (!res.body) return Readable.from([]);
    return Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  }

  async replace(body: Readable): Promise<void> {
    const res = await this.send(
      {
        method: 'PUT',
        headers: { 'content-type': NQUADS },
        body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
        duplex: 'half',
      },
      'replace its dataset',
    );
    await res.body?.cancel();
  }
}
