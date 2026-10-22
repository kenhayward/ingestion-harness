import { signRequest } from '@ih/bridge-contract';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { HandoffCodes } from '../src/bridge/handoff.js';
import { accessApp, signInNewUser, testApp, TEST_BRIDGE_KEY } from './helpers.js';

const PUBLIC_URL = 'https://ct.example.com/bridge';

/** A request signed by the bridge (the shared BRIDGE_CLIENT_KEY). */
function signed(app: FastifyInstance, url: string, body: unknown, key = TEST_BRIDGE_KEY) {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url,
    headers: {
      ...signRequest(key, { method: 'POST', path: url, body: payload }),
      'content-type': 'application/json',
    },
    payload,
  });
}

const codeOf = (url: string) => new URL(url).searchParams.get('code')!;

describe('HandoffCodes', () => {
  it('redeems a code once, within 60 seconds, for the user it was minted for', () => {
    const codes = new HandoffCodes();
    const user = { id: 'u1', name: 'Ada', email: null, role: 'admin' as const };
    const t0 = 1_000_000;
    const code = codes.mint(user, t0);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codes.redeem(code, t0 + 1_000)).toEqual(user);
    expect(codes.redeem(code, t0 + 2_000)).toBeNull();
    const late = codes.mint(user, t0);
    expect(codes.redeem(late, t0 + 61_000)).toBeNull();
    expect(codes.redeem('unknown', t0)).toBeNull();
  });
});

describe('POST /api/bridge/connections-link', () => {
  it('returns a URL under BRIDGE_PUBLIC_URL', async () => {
    const { app, adminCookie } = await accessApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/bridge/connections-link',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const { url } = res.json() as { url: string };
    expect(url.startsWith(`${PUBLIC_URL}/connections/start?code=`)).toBe(true);
    expect(codeOf(url)).toHaveLength(43);
  });

  it('is open to every role: an operator gets a link minted for them, as an operator', async () => {
    const { app, access } = await accessApp();
    const { cookie, user } = await signInNewUser(app, access, 'Olu', 'operator');
    const res = await app.inject({
      method: 'POST',
      url: '/api/bridge/connections-link',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const code = codeOf((res.json() as { url: string }).url);
    const redeemed = await signed(app, '/api/bridge/handoff/redeem', { code });
    expect(redeemed.json()).toMatchObject({
      id: user.id,
      name: 'Olu',
      role: 'operator',
    });
  });
});

describe('POST /api/bridge/handoff/redeem', () => {
  it('returns the user once; a second redeem is 404; after 61 s it is 404', async () => {
    let now = 5_000_000;
    const codes = new HandoffCodes(() => now);
    const { app, adminCookie } = await accessApp({
      bridgeAuth: {
        key: TEST_BRIDGE_KEY,
        publicUrl: PUBLIC_URL,
        codes,
      },
    });
    const link = async () =>
      codeOf(
        (
          await app.inject({
            method: 'POST',
            url: '/api/bridge/connections-link',
            headers: { cookie: adminCookie },
          })
        ).json().url as string,
      );
    const code = await link();
    const first = await signed(app, '/api/bridge/handoff/redeem', { code });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      id: expect.any(String),
      name: 'Admin',
      email: null,
      role: 'admin',
    });
    expect((await signed(app, '/api/bridge/handoff/redeem', { code })).statusCode).toBe(404);
    const late = await link();
    now += 61_000;
    expect((await signed(app, '/api/bridge/handoff/redeem', { code: late })).statusCode).toBe(404);
  });

  it('an unsigned redeem is 401, and so is one signed with another key or replayed', async () => {
    const { app } = await testApp();
    const unsigned = await app.inject({
      method: 'POST',
      url: '/api/bridge/handoff/redeem',
      payload: { code: 'x' },
    });
    expect(unsigned.statusCode).toBe(401);
    const forged = await signed(app, '/api/bridge/handoff/redeem', { code: 'x' }, 'z'.repeat(32));
    expect(forged.statusCode).toBe(401);
    const payload = JSON.stringify({ code: 'x' });
    const headers = {
      ...signRequest(TEST_BRIDGE_KEY, {
        method: 'POST',
        path: '/api/bridge/handoff/redeem',
        body: payload,
      }),
      'content-type': 'application/json',
    };
    const once = await app.inject({
      method: 'POST',
      url: '/api/bridge/handoff/redeem',
      headers,
      payload,
    });
    expect(once.statusCode).toBe(404);
    const again = await app.inject({
      method: 'POST',
      url: '/api/bridge/handoff/redeem',
      headers,
      payload,
    });
    expect(again.statusCode).toBe(401);
  });

  it('a body other than the signed bytes is refused', async () => {
    const { app } = await testApp();
    const headers = {
      ...signRequest(TEST_BRIDGE_KEY, {
        method: 'POST',
        path: '/api/bridge/handoff/redeem',
        body: JSON.stringify({ code: 'a' }),
      }),
      'content-type': 'application/json',
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/bridge/handoff/redeem',
      headers,
      payload: JSON.stringify({ code: 'b' }),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/profile/connections', () => {
  const summary = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: `Connection ${id}`,
    sinkId: 'acme',
    kind: 'personal' as const,
    instanceId: 'sandbox',
    status: 'ok' as const,
    statusReason: null,
    lastUsedAt: '2026-10-22T09:00:00.000Z',
    fields: {},
    ...over,
  });
  const acme = {
    id: 'acme',
    name: 'Acme',
    status: 'available' as const,
    contractVersion: 1,
    capabilities: {
      browse: false,
      replace: true,
      withdraw: false,
      readBack: false,
      accepts: ['files' as const],
    },
    connectionKind: 'personal' as const,
    instances: [{ id: 'sandbox', label: 'Sandbox' }],
  };

  it("answers the signed-in user's own connections, with the system and instance named", async () => {
    const { app, access, bridge } = await accessApp();
    const { cookie, user } = await signInNewUser(app, access, 'Olu', 'operator');
    bridge.sinkViews = [acme];
    bridge.personal.set(user.id, [
      summary('u-1'),
      summary('u-2', {
        instanceId: 'gone',
        status: 'needs_attention',
        statusReason: 'the password was refused',
        lastUsedAt: null,
      }),
    ]);
    bridge.personal.set('someone-else', [summary('u-9')]);
    const res = await app.inject({ url: '/api/profile/connections', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      personalSinks: true,
      connections: [
        {
          id: 'u-1',
          name: 'Connection u-1',
          sinkName: 'Acme',
          instanceLabel: 'Sandbox',
          status: 'ok',
          statusReason: null,
          lastUsedAt: '2026-10-22T09:00:00.000Z',
        },
        {
          id: 'u-2',
          name: 'Connection u-2',
          sinkName: 'Acme',
          instanceLabel: 'gone',
          status: 'needs_attention',
          statusReason: 'the password was refused',
          lastUsedAt: null,
        },
      ],
    });
    expect(bridge.personalAsked).toEqual([user.id]);
  });

  it('says when no system uses personal connections', async () => {
    const { app, userCookie } = await accessApp();
    const res = await app.inject({
      url: '/api/profile/connections',
      headers: { cookie: userCookie },
    });
    expect(res.json()).toEqual({ personalSinks: false, connections: [] });
  });

  it('answers 502 while the bridge is down', async () => {
    const { app, userCookie, bridge } = await accessApp();
    bridge.failNext = new Error('connect ECONNREFUSED');
    const res = await app.inject({
      url: '/api/profile/connections',
      headers: { cookie: userCookie },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'connections are unavailable right now' });
  });
});

describe('disabling a user deletes their personal connections', () => {
  it('after the disable; enabling deletes nothing', async () => {
    const { app, access, adminCookie, bridge } = await accessApp();
    const { user } = await signInNewUser(app, access, 'Olu', 'operator');
    const off = await app.inject({
      method: 'POST',
      url: `/api/users/${user.id}/disable`,
      headers: { cookie: adminCookie },
    });
    expect(off.statusCode).toBe(200);
    expect(bridge.userDeletes).toEqual([user.id]);
    await app.inject({
      method: 'POST',
      url: `/api/users/${user.id}/enable`,
      headers: { cookie: adminCookie },
    });
    expect(bridge.userDeletes).toEqual([user.id]);
  });

  it('a bridge that is down does not undo the disable', async () => {
    const { app, access, adminCookie, bridge } = await accessApp();
    const { user } = await signInNewUser(app, access, 'Olu', 'operator');
    bridge.failNext = new Error('connect ECONNREFUSED');
    const off = await app.inject({
      method: 'POST',
      url: `/api/users/${user.id}/disable`,
      headers: { cookie: adminCookie },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ status: 'disabled' });
  });
});
