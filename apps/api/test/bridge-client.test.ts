import {
  MemoryNonceStore,
  verifyRequest,
  type TargetPutRequest,
  type TargetView,
} from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { BridgeApiError, HttpBridgeApi } from '../src/bridge/client.js';

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
  it('reads a summary from an older bridge (no fields, kind, instance or last used) as shared', async () => {
    const summary = { id: 'lake', name: 'Lake', sinkId: 's3', status: 'ok', statusReason: null };
    const { api, calls } = client(() => ({ connections: [summary] }));
    expect(await api.listConnections('shared')).toEqual([
      { ...summary, fields: {}, kind: 'shared', instanceId: null, lastUsedAt: null },
    ]);
    expect(calls[0]!.path).toBe('/v1/connections?kind=shared');
  });
});

/** A client whose every call is answered with `status` and `body`. */
const answering = (status: number, body: unknown) =>
  new HttpBridgeApi(
    'http://bridge:3100',
    KEY,
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  );

describe('HttpBridgeApi.readObject', () => {
  it('reads an object as bytes', async () => {
    const api = answering(200, { content: Buffer.from('a,b').toString('base64') });
    expect((await api.readObject('finance', 'b', 'k'))?.toString()).toBe('a,b');
  });

  it('answers null for a missing object', async () => {
    const api = answering(404, { class: 'needs_user', code: 'not_found', message: 'no such key' });
    expect(await api.readObject('finance', 'b', 'k')).toBeNull();
  });

  it('throws for a target the bridge lacks, rather than calling the object missing', async () => {
    const api = answering(404, {
      class: 'needs_user',
      code: 'target_missing',
      message: 'no target finance',
    });
    const err = await api.readObject('finance', 'b', 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeApiError);
    expect(err).toMatchObject({ status: 404, error: { code: 'target_missing' } });
  });
});

describe('HttpBridgeApi timeouts', () => {
  it('marks a call the bridge did not answer in time, unlike one it could not be reached for', async () => {
    const failing = (err: Error) =>
      new HttpBridgeApi('http://bridge:3100', KEY, (async () => {
        throw err;
      }) as unknown as typeof fetch);
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    await expect(failing(timeout).deleteTarget('finance')).rejects.toMatchObject({
      status: 0,
      timedOut: true,
    });
    await expect(
      failing(new TypeError('fetch failed')).deleteTarget('finance'),
    ).rejects.toMatchObject({ status: 0, timedOut: false });
  });
});

describe('HttpBridgeApi personal connections', () => {
  it("lists one owner's personal connections", async () => {
    const summary = {
      id: 'u-1',
      name: 'Mine',
      sinkId: 'acme',
      kind: 'personal',
      instanceId: 'sandbox',
      status: 'ok',
      statusReason: null,
      lastUsedAt: null,
      fields: {},
    };
    const { api, calls } = client(() => ({ connections: [summary] }));
    expect(await api.listPersonalConnections('user 1')).toEqual([summary]);
    expect(calls[0]!.path).toBe('/v1/connections?kind=personal&owner=user+1');
  });

  it("deletes a user's connections and reconciles the live users, answering the counts", async () => {
    const { api, calls } = client(() => ({ deleted: 2 }));
    expect(await api.deleteUserConnections('u/1')).toBe(2);
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/v1/users/u%2F1/connections' });
    expect(await api.reconcileUsers(['a', 'b'])).toBe(2);
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/v1/users:reconcile' });
    expect(JSON.parse(calls[1]!.body)).toEqual({ liveUserIds: ['a', 'b'] });
  });

  it('lists the sinks', async () => {
    const sink = {
      id: 'acme',
      name: 'Acme',
      status: 'available',
      contractVersion: 1,
      capabilities: {
        browse: false,
        replace: true,
        withdraw: false,
        readBack: false,
        accepts: ['files'],
      },
      connectionKind: 'personal',
      instances: [{ id: 'sandbox', label: 'Sandbox' }],
      destinationFields: [],
      credentialFields: [],
    };
    const { api, calls } = client(() => ({ sinks: [sink] }));
    expect(await api.listSinks()).toEqual([sink]);
    expect(calls[0]!.path).toBe('/v1/sinks');
  });
});
