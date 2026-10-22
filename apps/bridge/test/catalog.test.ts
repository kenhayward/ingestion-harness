import { SinkViewSchema, TargetViewSchema } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { FakeSink } from '../src/sinks/fake.js';
import { MapSinkRegistry } from '../src/sinks/port.js';
import { CachingSinkRegistry } from '../src/sinks/registry.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { KEY, signedInject, testBridge } from './helpers.js';

describe('GET /v1/sinks', () => {
  it('lists every registered sink, showing one that cannot describe itself as unavailable', async () => {
    const broken = new FakeSink();
    broken.describe = async () => {
      throw new Error('down');
    };
    const app = await testBridge({
      sinks: new MapSinkRegistry({ fake: new FakeSink({ name: 'Fake' }), broken }),
    });
    const res = await signedInject(app, KEY, { method: 'GET', url: '/v1/sinks' });
    expect(res.statusCode).toBe(200);
    const sinks = res.json().sinks.map((s: unknown) => SinkViewSchema.parse(s));
    expect(sinks).toEqual([
      expect.objectContaining({
        id: 'fake',
        name: 'Fake',
        status: 'available',
        contractVersion: 1,
      }),
      expect.objectContaining({ id: 'broken', name: 'broken', status: 'unavailable' }),
    ]);
  });
});

describe('GET /v1/targets', () => {
  it('lists the targets', async () => {
    const targets = new MemoryTargetRepo();
    await targets.put({
      id: 'a',
      label: 'A',
      sinkId: 'fake',
      instanceId: null,
      connectionId: null,
      destination: { bucket: 'b' },
    });
    const app = await testBridge({ targets });
    const res = await signedInject(app, KEY, { method: 'GET', url: '/v1/targets' });
    expect(res.json().targets.map((t: unknown) => TargetViewSchema.parse(t))).toEqual([
      {
        id: 'a',
        label: 'A',
        sinkId: 'fake',
        instanceId: null,
        connectionId: null,
        destination: { bucket: 'b' },
      },
    ]);
  });
});

describe('GET /v1/sinks, external sinks', () => {
  it("shows an external sink's fields, its cached status, and no withdraw or read-back", async () => {
    const remote = new FakeSink({
      name: 'Remote',
      credentialFields: [{ id: 'token', label: 'Token', secret: true }],
      capabilities: {
        browse: true,
        replace: true,
        withdraw: true,
        readBack: true,
        accepts: ['files', 'data'],
      },
    });
    const sinks = new CachingSinkRegistry({ fake: remote });
    await sinks.refresh();
    const app = await testBridge({ sinks });
    const [view] = (await signedInject(app, KEY, { method: 'GET', url: '/v1/sinks' })).json()
      .sinks as unknown[];
    expect(SinkViewSchema.parse(view)).toMatchObject({
      id: 'fake',
      name: 'Remote',
      status: 'available',
      capabilities: { browse: true, replace: true, withdraw: false, readBack: false },
      credentialFields: [{ id: 'token', label: 'Token', secret: true }],
      destinationFields: [expect.objectContaining({ id: 'bucket', kind: 'fixed' })],
    });
    remote.describe = async () => {
      throw new Error('down');
    };
    await sinks.refresh();
    const after = (await signedInject(app, KEY, { method: 'GET', url: '/v1/sinks' })).json();
    expect(after.sinks[0]).toMatchObject({ name: 'Remote', status: 'unavailable' });
  });
});
