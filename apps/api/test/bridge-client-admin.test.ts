import { MemoryNonceStore, verifyRequest } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { BridgeApiError, HttpBridgeApi } from '../src/bridge/client.js';

const KEY = 'test-bridge-key';
const admin = { id: 'u1', name: 'Ada Admin' };

function client(status: number, answer: unknown) {
  const calls: { method: string; path: string; body: string; headers: Record<string, string> }[] =
    [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    calls.push({
      method: init.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body: typeof init.body === 'string' ? init.body : '',
      headers: init.headers as Record<string, string>,
    });
    return new Response(JSON.stringify(answer), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { api: new HttpBridgeApi('http://bridge:3100', KEY, fetchImpl), calls };
}

describe('HttpBridgeApi sink administration', () => {
  it('posts the call to /v1/sinks/{id}/admin, signed, and answers the checked answer', async () => {
    const { api, calls } = client(200, { instances: [] });
    const call = { call: 'listInstances' as const, id: null, request: { actingAdmin: admin } };
    expect(await api.sinkAdmin('acme', call)).toEqual({ instances: [] });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/sinks/acme/admin' });
    expect(JSON.parse(calls[0]!.body)).toEqual(call);
    expect(verifyRequest(KEY, calls[0]!, new MemoryNonceStore())).toEqual({ ok: true });
  });

  it("refuses an answer that is not the call's", async () => {
    const { api } = client(200, { instances: 'no' });
    await expect(
      api.sinkAdmin('acme', { call: 'listInstances', id: null, request: { actingAdmin: admin } }),
    ).rejects.toThrow();
  });

  it("raises the bridge's refusal with its status and code", async () => {
    const refusal = { class: 'needs_user', code: 'locked', message: 'north is configured' };
    const { api } = client(409, refusal);
    const err = await api
      .sinkAdmin('acme', { call: 'removeInstance', id: 'north', request: { actingAdmin: admin } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeApiError);
    expect((err as BridgeApiError).status).toBe(409);
    expect((err as BridgeApiError).error).toEqual(refusal);
  });
});
