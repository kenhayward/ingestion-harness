import { SinkViewSchema, TargetViewSchema } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { FakeSink } from '../src/sinks/fake.js';
import { MapSinkRegistry } from '../src/sinks/port.js';
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
      destination: { bucket: 'b' },
    });
    const app = await testBridge({ targets });
    const res = await signedInject(app, KEY, { method: 'GET', url: '/v1/targets' });
    expect(res.json().targets.map((t: unknown) => TargetViewSchema.parse(t))).toEqual([
      { id: 'a', label: 'A', sinkId: 'fake', instanceId: null, destination: { bucket: 'b' } },
    ]);
  });
});
