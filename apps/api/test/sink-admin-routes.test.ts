import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FakeBridgeApi } from './fake-bridge.js';
import { FAKE_ADMIN_SINK, FAKE_SINK } from './fake-sink.js';
import { accessApp, testApp } from './helpers.js';

const BASE = '/api/publish-targets/sinks';
const unitAdmin = { id: 'unit-test-admin', name: 'admin' };
const instance = {
  id: 'north',
  label: 'North',
  fields: { address: 'https://north.example.test' },
  locked: false,
  createdAt: '2026-10-27T09:00:00.000Z',
  createdBy: unitAdmin,
};
const client = {
  id: 'c_1',
  name: 'Reports',
  prefix: 'sk_abc',
  instances: 'all',
  access: 'read',
  locked: false,
  createdAt: '2026-10-27T09:00:00.000Z',
  createdBy: unitAdmin,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
};
const TOKEN = 'sk_abc_the-secret-token-value';

async function setup() {
  const ctx = await testApp();
  ctx.bridge.sinkViews = [FAKE_SINK, FAKE_ADMIN_SINK];
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `${BASE}${url}`, ...(payload ? { payload } : {}) });
  return { ...ctx, call };
}

describe('sink administration routes', () => {
  it('lists instances through the bridge, acting as the signed-in admin', async () => {
    const c = await setup();
    c.bridge.adminAnswer = () => ({ instances: [instance] });
    const res = await c.call('GET', '/admin-sink/admin/instances');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ instances: [instance] });
    expect(c.bridge.adminCalls).toEqual([
      {
        sinkId: 'admin-sink',
        call: { call: 'listInstances', id: null, request: { actingAdmin: unitAdmin } },
      },
    ]);
  });

  it('adds, renames and removes an instance, each call as the sink takes it', async () => {
    const c = await setup();
    c.bridge.adminAnswer = (_s, call) =>
      call.call === 'removeInstance' ? { id: 'north', removed: true } : instance;
    const add = await c.call('POST', '/admin-sink/admin/instances', {
      id: 'north',
      label: 'North',
      fields: { address: 'https://north.example.test' },
    });
    expect(add.statusCode).toBe(201);
    const rename = await c.call('POST', '/admin-sink/admin/instances/north/rename', {
      label: 'North',
    });
    expect(rename.statusCode).toBe(200);
    const remove = await c.call('POST', '/admin-sink/admin/instances/north/remove');
    expect(remove.statusCode).toBe(200);
    expect(remove.json()).toEqual({ id: 'north', removed: true });
    expect(c.bridge.adminCalls.map((a) => a.call)).toEqual([
      {
        call: 'addInstance',
        id: null,
        request: {
          actingAdmin: unitAdmin,
          id: 'north',
          label: 'North',
          fields: { address: 'https://north.example.test' },
        },
      },
      { call: 'renameInstance', id: 'north', request: { actingAdmin: unitAdmin, label: 'North' } },
      { call: 'removeInstance', id: 'north', request: { actingAdmin: unitAdmin } },
    ]);
  });

  it('lists, issues and revokes clients; reads the audit log by cursor', async () => {
    const c = await setup();
    c.bridge.adminAnswer = (_s, call) => {
      if (call.call === 'listClients') return { clients: [client] };
      if (call.call === 'issueClient') return { client, token: TOKEN };
      if (call.call === 'revokeClient') return { ...client, revokedAt: '2026-10-27T10:00:00.000Z' };
      return { entries: [], nextCursor: null };
    };
    expect((await c.call('GET', '/admin-sink/admin/clients')).json()).toEqual({
      clients: [client],
    });
    const issue = await c.call('POST', '/admin-sink/admin/clients', {
      name: 'Reports',
      instances: 'all',
      access: 'read',
      expiresInDays: 30,
    });
    expect(issue.statusCode).toBe(201);
    expect(issue.json()).toEqual({ client, token: TOKEN });
    const revoke = await c.call('POST', '/admin-sink/admin/clients/c_1/revoke');
    expect(revoke.statusCode).toBe(200);
    const audit = await c.call('GET', '/admin-sink/admin/audit?cursor=abc&limit=20');
    expect(audit.json()).toEqual({ entries: [], nextCursor: null });
    expect(c.bridge.adminCalls.map((a) => a.call).slice(1)).toEqual([
      {
        call: 'issueClient',
        id: null,
        request: {
          actingAdmin: unitAdmin,
          name: 'Reports',
          instances: 'all',
          access: 'read',
          expiresInDays: 30,
        },
      },
      { call: 'revokeClient', id: 'c_1', request: { actingAdmin: unitAdmin } },
      {
        call: 'listAudit',
        id: null,
        request: { actingAdmin: unitAdmin, cursor: 'abc', limit: 20 },
      },
    ]);
  });

  it('refuses a body the call does not take, before the bridge sees it', async () => {
    const c = await setup();
    const res = await c.call('POST', '/admin-sink/admin/clients', {
      name: 'Reports',
      instances: 'all',
      access: 'admin',
      expiresInDays: 30,
    });
    expect(res.statusCode).toBe(400);
    const actingAs = await c.call('POST', '/admin-sink/admin/instances/north/rename', {
      label: 'x',
      actingAdmin: { id: 'someone', name: 'Someone else' },
    });
    expect(actingAs.statusCode).toBe(400);
    expect(c.bridge.adminCalls).toEqual([]);
  });

  it('refuses a sink that does not declare administration, and an unknown sink', async () => {
    const c = await setup();
    const plain = await c.call('GET', '/fake/admin/instances');
    expect(plain.statusCode).toBe(409);
    expect(plain.json()).toEqual({
      error: 'Fake sink does not offer administration',
      code: 'not_offered',
    });
    const unknown = await c.call('GET', '/nobody/admin/instances');
    expect(unknown.statusCode).toBe(404);
    expect(c.bridge.adminCalls).toEqual([]);
  });

  it("passes the sink's refusal through with its status and code", async () => {
    const c = await setup();
    c.bridge.adminAnswer = () => {
      throw FakeBridgeApi.refusal('north is from the configuration', 'locked', 409);
    };
    const res = await c.call('POST', '/admin-sink/admin/instances/north/remove');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'north is from the configuration', code: 'locked' });
  });

  it('answers 502 when the bridge cannot be reached', async () => {
    const c = await setup();
    c.bridge.adminAnswer = () => {
      throw new Error('down');
    };
    const res = await c.call('GET', '/admin-sink/admin/clients');
    expect(res.statusCode).toBe(502);
  });

  it('never logs an issued token', async () => {
    // Pino writes to stdout through fs (sync or not, by platform): every way is watched.
    const written: string[] = [];
    const keep = (data: unknown) => {
      written.push(String(data));
    };
    const spies = [
      vi.spyOn(fs, 'writeSync').mockImplementation((_fd, data: unknown) => {
        keep(data);
        return 0;
      }),
      vi.spyOn(fs, 'write').mockImplementation(((
        _fd: number,
        data: unknown,
        ...rest: unknown[]
      ) => {
        keep(data);
        const done = rest.at(-1);
        if (typeof done === 'function') (done as (e: null, n: number) => void)(null, 0);
      }) as never),
      vi.spyOn(process.stdout, 'write').mockImplementation((data: unknown) => {
        keep(data);
        return true;
      }),
    ];
    try {
      const ctx = await testApp({ logger: { level: 'trace' } });
      ctx.bridge.sinkViews = [FAKE_ADMIN_SINK];
      ctx.bridge.adminAnswer = () => ({ client, token: TOKEN });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `${BASE}/admin-sink/admin/clients`,
        payload: { name: 'Reports', instances: 'all', access: 'read', expiresInDays: null },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    // The request was logged (so the check sees the log), and the token was not.
    expect(written.join('')).toContain('admin-sink');
    expect(written.join('')).not.toContain(TOKEN);
  });
});

describe('sink administration routes, with access control', () => {
  it('are for admins only, and act as the signed-in admin', async () => {
    const ctx = await accessApp();
    ctx.bridge.sinkViews = [FAKE_ADMIN_SINK];
    ctx.bridge.adminAnswer = () => ({ instances: [] });
    const asUser = await ctx.app.inject({
      url: `${BASE}/admin-sink/admin/instances`,
      headers: { cookie: ctx.userCookie },
    });
    expect(asUser.statusCode).toBe(403);
    expect(ctx.bridge.adminCalls).toEqual([]);
    const asAdmin = await ctx.app.inject({
      url: `${BASE}/admin-sink/admin/instances`,
      headers: { cookie: ctx.adminCookie },
    });
    expect(asAdmin.statusCode).toBe(200);
    const me = (await ctx.access.listUsers()).find((u) => u.name === 'Admin')!;
    expect(ctx.bridge.adminCalls[0]!.call.request).toEqual({
      actingAdmin: { id: me.id, name: 'Admin' },
    });
  });
});
