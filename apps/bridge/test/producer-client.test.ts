import { MemoryNonceStore, verifyRequest } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { HttpProducerClient } from '../src/producer/client.js';
import { KEY } from './helpers.js';

describe('HttpProducerClient', () => {
  it('redeems a code with a signed call, and reads a 404 as no user', async () => {
    const seen: { url: string; ok: boolean }[] = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const verdict = verifyRequest(
        KEY,
        { method: 'POST', path: url.pathname, body: String(init.body), headers },
        new MemoryNonceStore(),
      );
      seen.push({ url: url.toString(), ok: verdict.ok });
      const { code } = JSON.parse(String(init.body)) as { code: string };
      return code === 'good'
        ? Response.json({ id: 'u1', name: 'Ada', email: null, role: 'admin' })
        : new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const client = new HttpProducerClient('http://api:3000/api/', KEY, fetchImpl);
    expect(await client.redeem('good')).toEqual({
      id: 'u1',
      name: 'Ada',
      email: null,
      role: 'admin',
    });
    expect(await client.redeem('used')).toBeNull();
    expect(seen).toEqual([
      { url: 'http://api:3000/api/bridge/handoff/redeem', ok: true },
      { url: 'http://api:3000/api/bridge/handoff/redeem', ok: true },
    ]);
  });
});
