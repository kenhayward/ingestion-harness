import { describe, expect, it } from 'vitest';
import { HttpGraphStore, MemoryGraphStore } from '../src/rdf/store.js';
import { SinkError } from '../src/sinks/port.js';

const G = 'https://data.example/ct/graph/source/abc/invoice';
const VERSION = 'https://id.stocks-hayward.com/ns/ct#graphVersion';

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A stubbed fetch: records each request and answers with `answer`. */
function stub(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const s: Seen = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const store = (fetchImpl: typeof fetch, user: string | null = 'ct-writer') =>
  new HttpGraphStore({
    endpoint: 'http://fuseki:3030/',
    dataset: 'ct',
    user,
    password: user ? 'pw' : null,
    fetch: fetchImpl,
  });

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof SinkError) return err.error.code;
    throw err;
  }
  return 'no error';
};

describe('HttpGraphStore', () => {
  it("put sends the body to the graph's data URL with basic auth", async () => {
    const { seen, fetchImpl } = stub(() => new Response(null, { status: 201 }));
    await store(fetchImpl).put(G, '<a> <b> <c> .', 'text/turtle');
    expect(seen).toHaveLength(1);
    const [s] = seen;
    expect(s!.method).toBe('PUT');
    expect(s!.url).toBe(`http://fuseki:3030/ct/data?graph=${encodeURIComponent(G)}`);
    expect(s!.headers['content-type']).toBe('text/turtle; charset=utf-8');
    expect(s!.headers.authorization).toBe(
      `Basic ${Buffer.from('ct-writer:pw').toString('base64')}`,
    );
    expect(s!.body).toBe('<a> <b> <c> .');
  });

  it('sends no authorization without a user', async () => {
    const { seen, fetchImpl } = stub(() => new Response(null, { status: 204 }));
    await store(fetchImpl, null).put(G, '', 'text/turtle');
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it('delete answers false on 404', async () => {
    const { seen, fetchImpl } = stub((s) => new Response(null, { status: s.url ? 404 : 200 }));
    expect(await store(fetchImpl).delete(G)).toBe(false);
    expect(seen[0]!.method).toBe('DELETE');
    const ok = stub(() => new Response(null, { status: 204 }));
    expect(await store(ok.fetchImpl).delete(G)).toBe(true);
  });

  it('version reads ct:graphVersion and is null for an absent graph', async () => {
    const results = (vs: number[]) =>
      Response.json({
        head: { vars: ['v'] },
        results: {
          bindings: vs.map((v) => ({
            v: {
              type: 'literal',
              datatype: 'http://www.w3.org/2001/XMLSchema#integer',
              value: String(v),
            },
          })),
        },
      });
    const { seen, fetchImpl } = stub(() => results([2, 5]));
    expect(await store(fetchImpl).version(G)).toBe(5);
    const s = seen[0]!;
    expect(s.method).toBe('POST');
    expect(s.url).toBe('http://fuseki:3030/ct/sparql');
    expect(s.headers['content-type']).toBe('application/sparql-query');
    expect(s.headers.accept).toBe('application/sparql-results+json');
    expect(s.body).toContain(`GRAPH <${G}>`);
    expect(s.body).toContain(`<${VERSION}>`);
    const none = stub(() => results([]));
    expect(await store(none.fetchImpl).version(G)).toBeNull();
  });

  it('ping asks the dataset and passes on 200', async () => {
    const { seen, fetchImpl } = stub(() => Response.json({ head: {}, boolean: true }));
    await store(fetchImpl).ping();
    expect(seen[0]!.url).toBe('http://fuseki:3030/ct/sparql');
    expect(seen[0]!.body).toBe('ASK {}');
  });

  it('5xx and a refused connection are instance_unavailable', async () => {
    const down = stub(() => new Response('boom', { status: 503 }));
    expect(await codeOf(store(down.fetchImpl).put(G, '', 'text/turtle'))).toBe(
      'instance_unavailable',
    );
    const refused = stub(() => Promise.reject(new TypeError('fetch failed')));
    expect(await codeOf(store(refused.fetchImpl).version(G))).toBe('instance_unavailable');
  });

  it('401 is credential_rejected', async () => {
    const { fetchImpl } = stub(() => new Response('nope', { status: 401 }));
    expect(await codeOf(store(fetchImpl).put(G, '', 'text/turtle'))).toBe('credential_rejected');
    expect(await codeOf(store(fetchImpl).ping())).toBe('credential_rejected');
  });

  it('400 is content_rejected without the response body', async () => {
    const { fetchImpl } = stub(() => new Response('secret parse detail', { status: 400 }));
    try {
      await store(fetchImpl).put(G, 'not turtle', 'text/turtle');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SinkError);
      const e = (err as SinkError).error;
      expect(e.code).toBe('content_rejected');
      expect(e.message).not.toContain('secret parse detail');
    }
  });
});

describe('MemoryGraphStore', () => {
  it('keeps graphs and their versions', async () => {
    const s = new MemoryGraphStore();
    expect(await s.version(G)).toBeNull();
    await s.put(G, `<${G}> <${VERSION}> 3 .`, 'text/turtle');
    expect(await s.version(G)).toBe(3);
    expect(s.graphs.get(G)).toContain('3');
    expect(await s.delete(G)).toBe(true);
    expect(await s.delete(G)).toBe(false);
    await s.ping();
  });
});
