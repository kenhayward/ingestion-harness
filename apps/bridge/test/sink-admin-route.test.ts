import { bridgeError, type AdminCallName, type SinkDescribe } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { FakeSink } from '../src/sinks/fake.js';
import { MapSinkRegistry, SinkError, type SinkPort } from '../src/sinks/port.js';
import { KEY, signedInject, testBridge } from './helpers.js';

const admin = { id: 'u1', name: 'Ada Admin' };
const instance = {
  id: 'north',
  label: 'North',
  fields: { address: 'https://north.example.test' },
  locked: false,
  createdAt: '2026-10-27T09:00:00.000Z',
  createdBy: admin,
};

const ADMINISTERED: Partial<SinkDescribe> = {
  contractVersion: 3,
  capabilities: {
    browse: false,
    replace: true,
    withdraw: false,
    readBack: false,
    accepts: ['files'],
    administration: {
      instances: true,
      clients: true,
      instanceFields: [{ id: 'address', label: 'Address', required: true, hint: null }],
    },
  },
};

/** A sink that answers administration calls as told, keeping what it was asked. */
class AdminSink extends FakeSink {
  readonly asked: { call: AdminCallName; id: string | null; request: unknown }[] = [];
  answer: unknown = { instances: [instance] };
  refuse: SinkError | null = null;

  async admin(call: AdminCallName, id: string | null, request: unknown): Promise<unknown> {
    this.asked.push({ call, id, request });
    if (this.refuse) throw this.refuse;
    return this.answer;
  }
}

async function setup(sinks: Record<string, SinkPort>) {
  const app = await testBridge({ sinks: new MapSinkRegistry(sinks) });
  const post = (sinkId: string, body: unknown) =>
    signedInject(app, KEY, { method: 'POST', url: `/v1/sinks/${sinkId}/admin`, body });
  return { app, post };
}

describe('POST /v1/sinks/:sinkId/admin', () => {
  it("relays a call to the sink and answers the sink's answer with the call's status", async () => {
    const sink = new AdminSink(ADMINISTERED);
    const { post } = await setup({ admin: sink });
    const res = await post('admin', {
      call: 'listInstances',
      id: null,
      request: { actingAdmin: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ instances: [instance] });
    expect(sink.asked).toEqual([
      { call: 'listInstances', id: null, request: { actingAdmin: admin } },
    ]);

    sink.answer = instance;
    const added = await post('admin', {
      call: 'addInstance',
      id: null,
      request: { actingAdmin: admin, id: 'north', label: 'North', fields: {} },
    });
    expect(added.statusCode).toBe(201);
  });

  it("refuses a request that is not the call's, before the sink sees it", async () => {
    const sink = new AdminSink(ADMINISTERED);
    const { post } = await setup({ admin: sink });
    const noAdmin = await post('admin', { call: 'listInstances', id: null, request: {} });
    expect(noAdmin.statusCode).toBe(400);
    const noId = await post('admin', {
      call: 'renameInstance',
      id: null,
      request: { actingAdmin: admin, label: 'x' },
    });
    expect(noId.statusCode).toBe(400);
    expect(sink.asked).toEqual([]);
  });

  it('refuses a sink that does not declare administration, and an unknown one', async () => {
    const { post } = await setup({ plain: new FakeSink() });
    const body = { call: 'listInstances', id: null, request: { actingAdmin: admin } };
    const plain = await post('plain', body);
    expect(plain.statusCode).toBe(422);
    expect(plain.json()).toMatchObject({ code: 'content_rejected' });
    expect(plain.json().message).toMatch(/does not offer administration/);
    const unknown = await post('nobody', body);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'not_found' });
  });

  it("keeps the sink's refusal and its status", async () => {
    const sink = new AdminSink(ADMINISTERED);
    sink.refuse = new SinkError(bridgeError('locked', 'north is configured'));
    const { post } = await setup({ admin: sink });
    const res = await post('admin', {
      call: 'removeInstance',
      id: 'north',
      request: { actingAdmin: admin },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(bridgeError('locked', 'north is configured'));
  });

  it('is signed like every producer call', async () => {
    const { app } = await setup({ admin: new AdminSink(ADMINISTERED) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sinks/admin/admin',
      payload: { call: 'listInstances', id: null, request: { actingAdmin: admin } },
    });
    expect(res.statusCode).toBe(401);
  });
});
