import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public/sw.js'),
  'utf8',
);
const ORIGIN = 'https://ct.example';

type Listener = (event: FakeEvent) => void;
type FakeEvent = {
  request?: Request;
  waitUntil: (p: Promise<unknown>) => void;
  respondWith: (p: Promise<Response> | Response) => void;
};

/** public/sw.js run in a fake ServiceWorkerGlobalScope. */
function worker({ network }: { network: (req: Request) => Promise<Response> }) {
  const listeners = new Map<string, Listener>();
  const stored = new Map<string, Map<string, Response>>();
  const caches = {
    open: vi.fn(async (name: string) => {
      const cache = stored.get(name) ?? new Map<string, Response>();
      stored.set(name, cache);
      return {
        add: vi.fn(async (req: Request | string) => {
          const url = new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname;
          cache.set(url, new Response(`cached ${url}`, { status: 200 }));
        }),
      };
    }),
    keys: vi.fn(async () => [...stored.keys()]),
    delete: vi.fn(async (name: string) => stored.delete(name)),
    match: vi.fn(async (req: string) => {
      for (const cache of stored.values()) {
        const hit = cache.get(new URL(req, ORIGIN).pathname);
        if (hit) return hit.clone();
      }
      return undefined;
    }),
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
  runInNewContext(source, {
    self,
    caches,
    fetch: vi.fn(network),
    // A worker resolves relative URLs against its own location.
    Request: class extends Request {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init);
      }
    },
    Response,
    URL,
    Promise,
  });

  async function dispatch(type: string, request?: Request) {
    let waited: Promise<unknown> = Promise.resolve();
    let response: Promise<Response> | Response | undefined;
    listeners.get(type)!({
      request,
      waitUntil: (p) => (waited = p),
      respondWith: (p) => (response = p),
    });
    await waited;
    return response === undefined ? undefined : await response;
  }
  return { self, caches, stored, dispatch };
}

/** A request as the browser makes it; Node's Request cannot set mode 'navigate'. */
function req(path: string, { mode = 'cors', method = 'GET' } = {}): Request {
  const r = new Request(new URL(path, ORIGIN), { method });
  Object.defineProperty(r, 'mode', { value: mode });
  return r;
}
const page = (path: string) => req(path, { mode: 'navigate' });

describe('service worker (public/sw.js)', () => {
  let online: ReturnType<typeof vi.fn<(r: Request) => Promise<Response>>>;
  beforeEach(() => {
    online = vi.fn(async () => new Response('from network', { status: 200 }));
  });

  it('caches only the offline page on install, then takes over at once', async () => {
    const sw = worker({ network: online });
    await sw.dispatch('install');
    const cached = [...sw.stored.values()].flatMap((c) => [...c.keys()]);
    expect(cached).toEqual(['/offline.html']);
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });

  it('drops caches of older versions on activate and claims open pages', async () => {
    const sw = worker({ network: online });
    await sw.caches.open('ct-offline-v0');
    await sw.dispatch('install');
    await sw.dispatch('activate');
    expect(await sw.caches.keys()).toHaveLength(1);
    expect(sw.caches.delete).toHaveBeenCalledWith('ct-offline-v0');
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });

  it.each([
    ['an API call', req('/api/jobs')],
    ['the live job stream', req('/api/jobs/j1/events')],
    ['an upload', req('/api/documents', { method: 'POST' })],
    ['a built asset', req('/assets/index-abc123.js')],
    ['the manifest', req('/site.webmanifest')],
    ['the API docs page', page('/api/docs/')],
    ['a page on another site', page('https://elsewhere.example/')],
  ])('leaves %s to the browser', async (_, request) => {
    const sw = worker({ network: online });
    expect(await sw.dispatch('fetch', request)).toBeUndefined();
  });

  it('loads pages from the network first', async () => {
    const sw = worker({ network: online });
    await sw.dispatch('install');
    const res = await sw.dispatch('fetch', page('/'));
    expect(await res!.text()).toBe('from network');
  });

  it('shows the offline page when the network is gone', async () => {
    const sw = worker({ network: async () => Promise.reject(new TypeError('Failed to fetch')) });
    await sw.dispatch('install');
    const res = await sw.dispatch('fetch', page('/'));
    expect(await res!.text()).toBe('cached /offline.html');
  });

  it.each([502, 503, 504])('shows the offline page when a proxy answers %i', async (status) => {
    const sw = worker({ network: async () => new Response('Bad gateway', { status }) });
    await sw.dispatch('install');
    const res = await sw.dispatch('fetch', page('/'));
    expect(await res!.text()).toBe('cached /offline.html');
  });

  it('passes on other errors from the server', async () => {
    const sw = worker({ network: async () => new Response('nope', { status: 500 }) });
    await sw.dispatch('install');
    const res = await sw.dispatch('fetch', page('/'));
    expect(res!.status).toBe(500);
  });
});
