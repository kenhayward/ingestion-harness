import {
  MemoryNonceStore,
  verifyRequest,
  type TargetPutRequest,
  type TargetView,
} from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { HttpBridgeApi } from '../src/bridge/client.js';

const KEY = 'test-bridge-key';

interface Seen {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string>;
}

/** An HttpBridgeApi over a fetch that records each request and answers `answer`. */
function client(answer: (seen: Seen) => unknown) {
  const calls: Seen[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    const seen: Seen = {
      method: init.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body: typeof init.body === 'string' ? init.body : '',
      headers: init.headers as Record<string, string>,
    };
    calls.push(seen);
    return new Response(JSON.stringify(answer(seen)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { api: new HttpBridgeApi('http://bridge:3100', KEY, fetchImpl), calls };
}

const view: TargetView = {
  id: 'finance',
  label: 'Finance',
  sinkId: 's3',
  instanceId: null,
  connectionId: 'finance',
  destination: { bucket: 'pub' },
};

describe('HttpBridgeApi targets', () => {
  it('listTargets reads GET /v1/targets, signed', async () => {
    const { api, calls } = client(() => ({ targets: [view] }));
    expect(await api.listTargets()).toEqual([view]);
    expect(calls).toHaveLength(1);
    const [seen] = calls;
    expect(seen!.method).toBe('GET');
    expect(seen!.path).toBe('/v1/targets');
    expect(
      verifyRequest(KEY, { ...seen!, headers: seen!.headers }, new MemoryNonceStore()),
    ).toEqual({ ok: true });
  });

  it("putTarget returns the bridge's view", async () => {
    const { api, calls } = client(() => view);
    const { id, ...put } = view;
    const request: TargetPutRequest = put;
    expect(await api.putTarget(id, request)).toEqual(view);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.path).toBe('/v1/targets/finance');
    expect(JSON.parse(calls[0]!.body)).toEqual(put);
  });
});

describe('HttpBridgeApi connections', () => {
  it('reads a summary without `fields` (a bridge one version behind) as no fields', async () => {
    const summary = { id: 'lake', name: 'Lake', sinkId: 's3', status: 'ok', statusReason: null };
    const { api, calls } = client(() => ({ connections: [summary] }));
    expect(await api.listConnections('shared')).toEqual([{ ...summary, fields: {} }]);
    expect(calls[0]!.path).toBe('/v1/connections?kind=shared');
  });
});
