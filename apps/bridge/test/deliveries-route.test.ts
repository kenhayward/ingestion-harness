import { CreateDeliveriesResultSchema, DeliveryViewSchema } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { MemoryPackageStore } from '../src/packages/store.js';
import { FakeSink } from '../src/sinks/fake.js';
import { MapSinkRegistry } from '../src/sinks/port.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { KEY, signedInject, testBridge } from './helpers.js';
import { documentPackage } from './sink-builders.js';

const request = (targets: string[], pkg: unknown = documentPackage) => ({
  targets,
  actingUser: { id: 'u1', name: 'Pat', email: null },
  overrides: {},
  package: pkg,
});

async function setup() {
  const deliveries = new MemoryDeliveryRepo();
  const packages = new MemoryPackageStore();
  const targets = new MemoryTargetRepo();
  for (const id of ['t1', 't2']) {
    await targets.put({
      id,
      label: id,
      sinkId: 'fake',
      instanceId: null,
      destination: { bucket: 'b' },
    });
  }
  await targets.put({
    id: 'gone',
    label: 'gone',
    sinkId: 'nosuch',
    instanceId: null,
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
  const sinks = new MapSinkRegistry({ fake: sink });
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
