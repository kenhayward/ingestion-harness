import type { SinkView } from '@ih/bridge-contract';
import type { PublishTargetView } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { FakeBridgeApi } from './fake-bridge.js';
import { testApp } from './helpers.js';

/** The fake external sink as the bridge's catalog lists it. */
export const FAKE_SINK: SinkView = {
  id: 'fake',
  name: 'Fake sink',
  status: 'available',
  contractVersion: 1,
  capabilities: {
    browse: true,
    replace: true,
    withdraw: false,
    readBack: false,
    accepts: ['files', 'data'],
  },
  connectionKind: 'shared',
  instances: [],
  destinationFields: [
    {
      id: 'space',
      label: 'Space',
      kind: 'fixed',
      required: true,
      overridable: false,
      browse: true,
    },
    {
      id: 'name',
      label: 'Name',
      kind: 'pattern',
      required: true,
      overridable: true,
      browse: false,
    },
  ],
  credentialFields: [{ id: 'token', label: 'Token', secret: true }],
};

const sinkBody = (over: object = {}) => ({
  kind: 'sink',
  label: 'Fake target',
  sinkId: 'fake',
  instanceId: null,
  connectionId: 'fake-account',
  destination: { space: 'reports', name: '{source.stem}' },
  ...over,
});

const recipe = (version: number, publishTo: string[]) => ({
  id: 'letter',
  version,
  name: 'Letter',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: 'sender', type: 'text' }] },
  pipeline: [{ type: 'extract', id: 'head', fields: ['sender'], sections: ['all'] }],
  delivery: { publishTo },
});

async function setup() {
  const ctx = await testApp();
  ctx.bridge.sinkViews = [FAKE_SINK];
  ctx.bridge.summaries.push({
    id: 'fake-account',
    name: 'Fake account',
    sinkId: 'fake',
    status: 'ok',
    statusReason: null,
  });
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api${url}`, ...(payload ? { payload } : {}) });
  return { ...ctx, call };
}

describe('targets of an external sink', () => {
  it('an admin creates one: the bridge takes the sink, connection and destination', async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets', sinkBody());
    expect(res.statusCode).toBe(201);
    expect(c.bridge.targets.get('fake-target')).toEqual({
      label: 'Fake target',
      sinkId: 'fake',
      instanceId: null,
      connectionId: 'fake-account',
      destination: { space: 'reports', name: '{source.stem}' },
    });
    expect(res.json()).toMatchObject({
      id: 'fake-target',
      kind: 'sink',
      sinkId: 'fake',
      sinkName: 'Fake sink',
      deliverOnly: true,
      destination: { space: 'reports', name: '{source.stem}' },
      connection: { id: 'fake-account', name: 'Fake account', status: 'ok' },
    });
  });

  it("passes the bridge's refusal through, and stores nothing", async () => {
    const c = await setup();
    c.bridge.failNext = FakeBridgeApi.refusal('colour is not a destination field of fake');
    const res = await c.call(
      'POST',
      '/publish-targets',
      sinkBody({ destination: { colour: 'x' } }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'colour is not a destination field of fake' });
    expect(await c.targets.get('fake-target')).toBeNull();
  });

  it('refuses the built-in sinks by this route', async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets', sinkBody({ sinkId: 's3' }));
    expect(res.statusCode).toBe(400);
  });

  it('in use, its fixed fields lock; the label, connection and patterns do not', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', sinkBody());
    await c.templates.create('letter', 1, recipe(1, ['default', 'fake-target']), 'draft');
    await c.templates.publish('letter', 1, 'Ken');
    const locked = await c.call('PATCH', '/publish-targets/fake-target', {
      destination: { space: 'elsewhere', name: '{source.stem}' },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toMatch(/^Space of Fake target is locked: Fake target is used by/);
    const free = await c.call('PATCH', '/publish-targets/fake-target', {
      label: 'Renamed',
      connectionId: null,
      destination: { space: 'reports', name: '{field:sender}' },
    });
    expect(free.statusCode).toBe(200);
    expect(c.bridge.targets.get('fake-target')).toMatchObject({
      label: 'Renamed',
      connectionId: null,
      destination: { space: 'reports', name: '{field:sender}' },
    });
  });

  it('a field of a sink the catalog does not know locks as fixed', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', sinkBody());
    c.bridge.sinkViews = [];
    await c.templates.create('letter', 1, recipe(1, ['default', 'fake-target']), 'draft');
    await c.templates.publish('letter', 1, 'Ken');
    const res = await c.call('PATCH', '/publish-targets/fake-target', {
      destination: { space: 'reports', name: 'other' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('a sink target takes no S3 settings, and an S3 target no destination', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', sinkBody());
    expect(
      (await c.call('PATCH', '/publish-targets/fake-target', { bucket: 'x' })).statusCode,
    ).toBe(400);
    expect(
      (await c.call('PATCH', '/publish-targets/default', { destination: { bucket: 'x' } }))
        .statusCode,
    ).toBe(400);
  });

  it('the choices list it with its sink, after the S3 targets', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', sinkBody());
    const { choices } = (await c.call('GET', '/publish-targets/choices')).json() as {
      choices: { id: string; kind: string; sinkName: string | null; layout: string | null }[];
    };
    expect(choices.find((ch) => ch.id === 'fake-target')).toMatchObject({
      kind: 'sink',
      sinkName: 'Fake sink',
      layout: null,
    });
  });

  it('lists the sinks for Published outputs', async () => {
    const c = await setup();
    const res = await c.call('GET', '/publish-targets/sinks');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sinks: [FAKE_SINK] });
  });

  it('the list shows a sink target with its sink name', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', sinkBody());
    const { targets } = (await c.call('GET', '/publish-targets')).json() as {
      targets: PublishTargetView[];
    };
    expect(targets.find((t) => t.id === 'fake-target')).toMatchObject({
      sinkName: 'Fake sink',
      deliverOnly: true,
    });
    expect(targets.find((t) => t.id === 'default')).toMatchObject({
      sinkName: null,
      deliverOnly: false,
    });
  });
});
