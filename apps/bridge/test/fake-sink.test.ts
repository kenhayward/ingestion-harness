import { SinkDescribeSchema } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { MemoryPackageStore } from '../src/packages/store.js';
import { FakeSink } from '../src/sinks/fake.js';
import { MapSinkRegistry, SinkError } from '../src/sinks/port.js';
import { deliverRequest, documentPackage as pkg } from './sink-builders.js';

describe('FakeSink', () => {
  it('describes itself validly', async () => {
    expect(SinkDescribeSchema.safeParse(await new FakeSink().describe()).success).toBe(true);
    expect((await new FakeSink({ name: 'Other' }).describe()).name).toBe('Other');
  });

  it('plays its script in order, then succeeds', async () => {
    const sink = new FakeSink().script('pending', { error: 'name_conflict' }, { throw: 'boom' });
    expect(await sink.deliver(deliverRequest())).toEqual({
      status: 'pending',
      sinkJobId: 'fake-1',
    });
    await expect(sink.deliver(deliverRequest())).rejects.toMatchObject({
      error: { class: 'needs_user', code: 'name_conflict' },
    });
    const thrown = await sink.deliver(deliverRequest()).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(SinkError);
    expect(await sink.deliver(deliverRequest())).toEqual({
      status: 'succeeded',
      receipt: { written: [] },
    });
    expect(sink.delivered).toHaveLength(4);
  });

  it('answers status polls from its own script', async () => {
    const sink = new FakeSink().scriptStatus('pending', { error: 'timeout' }, 'succeed');
    expect(await sink.deliveryStatus('fake-1')).toEqual({ status: 'pending' });
    expect(await sink.deliveryStatus('fake-1')).toMatchObject({
      status: 'failed',
      error: { code: 'timeout' },
    });
    expect(await sink.deliveryStatus('fake-1')).toEqual({
      status: 'succeeded',
      receipt: { written: [] },
    });
  });
});

describe('MapSinkRegistry', () => {
  it('finds sinks by id', () => {
    const sink = new FakeSink();
    const sinks = new MapSinkRegistry({ fake: sink });
    expect(sinks.get('fake')).toBe(sink);
    expect(sinks.get('nope')).toBeNull();
    expect(sinks.ids()).toEqual(['fake']);
  });
});

describe('MemoryPackageStore', () => {
  it('round-trips and deletes a package', async () => {
    const store = new MemoryPackageStore();
    await store.put('packages/p.json', pkg);
    expect(await store.get('packages/p.json')).toEqual(pkg);
    await store.delete('packages/p.json');
    expect(await store.get('packages/p.json')).toBeNull();
  });
});
