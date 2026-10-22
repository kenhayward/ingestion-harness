import { CreateDeliveriesResultSchema, DeliveryViewSchema } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { MemoryPackageStore } from '../src/packages/store.js';
import { FakeSink } from '../src/sinks/fake.js';
import { MapSinkRegistry, type SinkRegistry } from '../src/sinks/port.js';
import { CachingSinkRegistry } from '../src/sinks/registry.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { KEY, signedInject, testBridge } from './helpers.js';
import { documentPackage } from './sink-builders.js';

const request = (targets: string[], pkg: unknown = documentPackage) => ({
  targets,
  actingUser: { id: 'u1', name: 'Pat', email: null },
  overrides: {},
  package: pkg,
});

async function setup(registry?: (sink: FakeSink) => Promise<SinkRegistry>) {
  const deliveries = new MemoryDeliveryRepo();
  const packages = new MemoryPackageStore();
  const targets = new MemoryTargetRepo();
  for (const id of ['t1', 't2']) {
    await targets.put({
      id,
      label: id,
      sinkId: 'fake',
      instanceId: null,
      connectionId: null,
      destination: { bucket: 'b' },
    });
  }
  await targets.put({
    id: 'gone',
    label: 'gone',
    sinkId: 'nosuch',
    instanceId: null,
    connectionId: null,
    destination: {},
  });
  const sink = new FakeSink({
    capabilities: {
      browse: false,
      replace: true,
      withdraw: false,
      readBack: false,
      accepts: ['files', 'data'],
    },
  });
  const sinks = registry ? await registry(sink) : new MapSinkRegistry({ fake: sink });
  const app = await testBridge({ deliveries, packages, targets, sinks });
  return { app, deliveries, packages };
}

describe('POST /v1/deliveries', () => {
  it('accepts a package for two targets and queues one delivery each', async () => {
    const { app, deliveries, packages } = await setup();
    const res = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/deliveries',
      body: request(['t1', 't2']),
    });
    expect(res.statusCode).toBe(202);
    const result = CreateDeliveriesResultSchema.parse(res.json());
    expect(result.deliveries.map((d) => d.targetId)).toEqual(['t1', 't2']);
    for (const d of result.deliveries) {
      expect(await deliveries.get(d.deliveryId)).toMatchObject({
        status: 'queued',
        packageId: result.packageId,
      });
    }
    const pkg = await deliveries.getPackage(result.packageId);
    expect(pkg?.expiresAt).toBeInstanceOf(Date);
    expect(await packages.get(pkg!.stagedKey)).toEqual(documentPackage);
    expect(JSON.stringify(pkg!.manifest)).not.toContain(documentPackage.files[0]!.content);
  });

  it('refuses the whole request when one target is missing, writing nothing', async () => {
    const { app, deliveries } = await setup();
    const res = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/deliveries',
      body: request(['t1', 'nope']),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      class: 'needs_user',
      code: 'target_missing',
      details: { targetId: 'nope' },
    });
    expect(await deliveries.claim(new Date('2100-01-01'), 300)).toBeNull();
  });

  it('answers 503 when a target names a sink that is not registered', async () => {
    const { app } = await setup();
    const res = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/deliveries',
      body: request(['gone']),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ class: 'retryable', code: 'sink_unavailable' });
  });

  it('refuses a part the sink does not accept', async () => {
    const { app } = await setup();
    const withRdf = {
      ...documentPackage,
      rdf: { graphName: 'https://example.com/g', version: 1, turtle: '' },
    };
    const res = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/deliveries',
      body: request(['t1'], withRdf),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'unsupported_part', details: { part: 'rdf' } });
  });

  it('refuses a malformed request with 400', async () => {
    const { app } = await setup();
    const res = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/deliveries',
      body: { targets: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'content_rejected' });
  });
});

describe('GET /v1/deliveries/:id', () => {
  it('reads a delivery back, and 404s an unknown one', async () => {
    const { app } = await setup();
    const created = CreateDeliveriesResultSchema.parse(
      (
        await signedInject(app, KEY, {
          method: 'POST',
          url: '/v1/deliveries',
          body: request(['t1']),
        })
      ).json(),
    );
    const id = created.deliveries[0]!.deliveryId;
    const res = await signedInject(app, KEY, { method: 'GET', url: `/v1/deliveries/${id}` });
    expect(res.statusCode).toBe(200);
    expect(DeliveryViewSchema.parse(res.json())).toMatchObject({
      id,
      status: 'queued',
      attempts: 0,
    });
    const missing = await signedInject(app, KEY, {
      method: 'GET',
      url: '/v1/deliveries/00000000-0000-4000-8000-000000000000',
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /v1/deliveries to an unavailable sink', () => {
  it('is refused as retryable and writes nothing', async () => {
    const { app, deliveries } = await setup(async (sink) => {
      const sinks = new CachingSinkRegistry({ fake: sink });
      await sinks.refresh();
      const real = sink.describe.bind(sink);
      sink.describe = async () => {
        throw new Error('down');
      };
      await sinks.refresh();
      sink.describe = real;
      return sinks;
    });
    const res = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/deliveries',
      body: request(['t1']),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ class: 'retryable', code: 'sink_unavailable' });
    expect(await deliveries.claim(new Date(), 300)).toBeNull();
  });
});

describe('POST /v1/deliveries resolves name patterns', () => {
  it('refuses an override of a fixed field, writing nothing', async () => {
    const { app, deliveries } = await setup();
    const res = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/deliveries',
      body: { ...request(['t1']), overrides: { t1: { bucket: 'other' } } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'content_rejected' });
    expect(await deliveries.claim(new Date(), 300)).toBeNull();
  });
});

describe('POST /v1/deliveries, a pattern that resolves to nothing', () => {
  it('is pattern_unresolved, naming the field', async () => {
    const named = new FakeSink({
      capabilities: {
        browse: false,
        replace: true,
        withdraw: false,
        readBack: false,
        accepts: ['files', 'data'],
      },
      destinationFields: [
        {
          id: 'bucket',
          label: 'Bucket',
          kind: 'fixed',
          required: true,
          overridable: false,
          browse: false,
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
    });
    const { app, deliveries } = await setup(async () => new MapSinkRegistry({ fake: named }));
    const res = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/deliveries',
      body: { ...request(['t1']), patterns: { t1: { name: '{field:nowhere}' } } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'pattern_unresolved',
      details: { targetId: 't1', field: 'name', variables: ['field:nowhere'] },
    });
    expect(await deliveries.claim(new Date(), 300)).toBeNull();
  });
});

describe('POST /v1/deliveries:preflight', () => {
  it("says which targets the acting user can't be delivered as, writing nothing", async () => {
    const personal = new FakeSink({
      connectionKind: 'personal',
      instances: [{ id: 'sandbox', label: 'Sandbox' }],
      credentialFields: [{ id: 'token', label: 'Token', secret: true }],
    });
    const { app, deliveries } = await setup(
      async (shared) => new MapSinkRegistry({ fake: shared, acme: personal }),
    );
    await app.deps.targets.put({
      id: 'acme',
      label: 'Acme',
      sinkId: 'acme',
      instanceId: 'sandbox',
      connectionId: null,
      destination: { bucket: 'b' },
    });
    const res = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/deliveries:preflight',
      body: {
        targets: ['t1', 'acme', 'nosuch'],
        actingUser: { id: 'u1', name: 'Pat', email: null },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      targets: [
        { targetId: 't1', problem: null },
        {
          targetId: 'acme',
          problem: {
            class: 'needs_user',
            code: 'connection_missing',
            message: 'Pat has no connection for Acme: add one on the connections page',
            details: { targetId: 'acme', userId: 'u1' },
          },
        },
        {
          targetId: 'nosuch',
          problem: {
            class: 'needs_user',
            code: 'target_missing',
            message: 'no target nosuch',
            details: { targetId: 'nosuch' },
          },
        },
      ],
    });
    expect(await deliveries.claim(new Date(), 300)).toBeNull();
  });
});
