import { randomUUID } from 'node:crypto';
import type { Capabilities } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { acceptDeliveries } from '../src/deliveries/accept.js';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { backoff, runOnce } from '../src/deliveries/runner.js';
import { MemoryPackageStore } from '../src/packages/store.js';
import { FakeSink } from '../src/sinks/fake.js';
import { MapSinkRegistry } from '../src/sinks/port.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { documentPackage } from './sink-builders.js';

const T0 = new Date('2026-10-19T12:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  browse: false,
  replace: true,
  withdraw: false,
  readBack: false,
  accepts: ['files', 'data'],
  ...over,
});

async function setup(sink = new FakeSink({ capabilities: caps() }), maxAttempts = 8) {
  const deliveries = new MemoryDeliveryRepo();
  const packages = new MemoryPackageStore();
  const targets = new MemoryTargetRepo();
  await targets.put({
    id: 't1',
    label: 'T1',
    sinkId: 'fake',
    instanceId: null,
    connectionId: null,
    destination: { bucket: 'b', prefix: 'out/' },
  });
  const sinks = new MapSinkRegistry({ fake: sink });
  const deps = {
    deliveries,
    packages,
    targets,
    sinks,
    maxAttempts,
    leaseSeconds: 300,
    pollSeconds: 30,
  };
  const submit = async (overrides: Record<string, string> = {}, now = T0) => {
    const result = await acceptDeliveries(
      { deliveries, packages, targets, sinks, retentionDays: 30 },
      {
        targets: ['t1'],
        actingUser: { id: 'u1', name: 'Pat', email: null },
        overrides: { t1: overrides },
        package: documentPackage,
      },
      now,
      randomUUID,
    );
    return result.deliveries[0]!.deliveryId;
  };
  return { deps, deliveries, sink, submit };
}

describe('backoff', () => {
  it('doubles from 30 s and stops at an hour', () => {
    expect([1, 2, 3, 10, 20].map(backoff)).toEqual([30, 60, 120, 3600, 3600]);
  });
});

describe('runOnce', () => {
  it('delivers and records the receipt, with the overrides merged into the destination', async () => {
    const { deps, deliveries, sink, submit } = await setup();
    const id = await submit({ prefix: 'other/' });
    expect(await runOnce(deps, T0)).toBe('worked');
    expect(sink.delivered[0]).toMatchObject({
      destination: { bucket: 'b', prefix: 'other/' },
      credential: null,
      instanceId: null,
      actingUser: { id: 'u1' },
      idempotencyKey: documentPackage.idempotencyKey,
    });
    expect(sink.delivered[0]!.package).toEqual(documentPackage);
    expect(await deliveries.get(id)).toMatchObject({
      status: 'succeeded',
      receipt: { written: [] },
    });
  });

  it('a pending answer waits, then a poll completes it', async () => {
    const sink = new FakeSink({ capabilities: caps() })
      .script('pending')
      .scriptStatus('pending', 'succeed');
    const { deps, deliveries, submit } = await setup(sink);
    const id = await submit();
    await runOnce(deps, T0);
    expect(await deliveries.get(id)).toMatchObject({
      status: 'waiting',
      sinkJobId: 'fake-1',
      runAfter: at(30),
    });
    expect(await runOnce(deps, at(29))).toBe('idle');
    await runOnce(deps, at(30));
    expect(await deliveries.get(id)).toMatchObject({ status: 'waiting', runAfter: at(60) });
    await runOnce(deps, at(60));
    expect((await deliveries.get(id))?.status).toBe('succeeded');
    expect(sink.delivered).toHaveLength(1);
  });

  it('a failed poll follows the error rules', async () => {
    const sink = new FakeSink({ capabilities: caps() })
      .script('pending')
      .scriptStatus({ error: 'content_rejected' });
    const { deps, deliveries, submit } = await setup(sink);
    const id = await submit();
    await runOnce(deps, T0);
    await runOnce(deps, at(30));
    expect(await deliveries.get(id)).toMatchObject({
      status: 'needs_user',
      error: { code: 'content_rejected' },
    });
  });

  it('a pending job that fails transiently is delivered afresh on retry', async () => {
    const sink = new FakeSink({ capabilities: caps() })
      .script('pending', 'succeed')
      .scriptStatus({ error: 'instance_unavailable' });
    const { deps, deliveries, submit } = await setup(sink);
    const id = await submit();
    await runOnce(deps, T0);
    await runOnce(deps, at(30));
    expect(await deliveries.get(id)).toMatchObject({
      status: 'queued',
      sinkJobId: null,
      runAfter: at(60),
    });
    await runOnce(deps, at(60));
    expect((await deliveries.get(id))?.status).toBe('succeeded');
    expect(sink.delivered).toHaveLength(2);
  });

  it('polls do not use up attempts or stretch the backoff', async () => {
    const polls = Array.from({ length: 10 }, () => 'pending' as const);
    const sink = new FakeSink({ capabilities: caps() })
      .script('pending')
      .scriptStatus(...polls, { error: 'timeout' });
    const { deps, deliveries, submit } = await setup(sink, 3);
    const id = await submit();
    await runOnce(deps, T0);
    for (let i = 1; i <= 11; i++) await runOnce(deps, at(30 * i));
    expect(await deliveries.get(id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      runAfter: at(330 + 30),
      error: { code: 'timeout' },
    });
  });

  it('drops the outcome of a run whose lease another runner took over', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sink = new FakeSink({ capabilities: caps() });
    const slowDeliver = sink.deliver.bind(sink);
    let calls = 0;
    sink.deliver = async (req) => {
      calls += 1;
      if (calls === 1) {
        await gate;
        throw new Error('late failure');
      }
      return slowDeliver(req);
    };
    const { deps, deliveries, submit } = await setup(sink);
    const id = await submit();
    const slow = runOnce(deps, T0);
    await new Promise((r) => setTimeout(r, 10));
    await runOnce(deps, at(301)); // the lease expired: another runner delivers
    expect((await deliveries.get(id))?.status).toBe('succeeded');
    release();
    await slow;
    expect((await deliveries.get(id))?.status).toBe('succeeded');
  });

  it('a needs_user refusal stops without retry', async () => {
    const sink = new FakeSink({ capabilities: caps() }).script({ error: 'name_conflict' });
    const { deps, deliveries, submit } = await setup(sink);
    const id = await submit();
    await runOnce(deps, T0);
    expect(await deliveries.get(id)).toMatchObject({
      status: 'needs_user',
      error: { class: 'needs_user', code: 'name_conflict' },
    });
    expect(await runOnce(deps, at(10_000))).toBe('idle');
  });

  it('a retryable error requeues with backoff and fails after maxAttempts', async () => {
    const sink = new FakeSink({ capabilities: caps() }).script(
      { error: 'instance_unavailable' },
      { error: 'instance_unavailable' },
      { error: 'instance_unavailable' },
    );
    const { deps, deliveries, submit } = await setup(sink, 3);
    const id = await submit();
    await runOnce(deps, T0);
    expect((await deliveries.get(id))?.runAfter).toEqual(at(30));
    await runOnce(deps, at(30));
    expect((await deliveries.get(id))?.runAfter).toEqual(at(90));
    await runOnce(deps, at(90));
    expect(await deliveries.get(id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      error: { code: 'instance_unavailable' },
    });
  });

  it('a thrown non-contract error is retryable internal', async () => {
    const sink = new FakeSink({ capabilities: caps() }).script({ throw: 'socket hang up' });
    const { deps, deliveries, submit } = await setup(sink);
    const id = await submit();
    await runOnce(deps, T0);
    expect(await deliveries.get(id)).toMatchObject({
      status: 'queued',
      error: { class: 'retryable', code: 'internal', message: 'socket hang up' },
    });
  });

  it('skips a second delivery of the same key to a sink without replace or withdraw', async () => {
    const sink = new FakeSink({ capabilities: caps({ replace: false, withdraw: false }) });
    const { deps, deliveries, submit } = await setup(sink);
    const first = await submit();
    await runOnce(deps, T0);
    const second = await submit({}, at(1));
    await runOnce(deps, at(1));
    expect(await deliveries.get(second)).toMatchObject({ status: 'skipped', skippedFor: first });
    expect(sink.delivered).toHaveLength(1);
  });

  it('does not skip when the sink can replace', async () => {
    const { deps, sink, submit } = await setup();
    await submit();
    await runOnce(deps, T0);
    await submit({}, at(1));
    await runOnce(deps, at(1));
    expect(sink.delivered).toHaveLength(2);
  });

  it('fails a delivery whose package has expired from the store', async () => {
    const { deps, deliveries, submit } = await setup();
    const id = await submit();
    const row = await deliveries.get(id);
    const pkg = await deliveries.getPackage(row!.packageId);
    await deps.packages.delete(pkg!.stagedKey);
    await runOnce(deps, T0);
    expect(await deliveries.get(id)).toMatchObject({
      status: 'failed',
      error: { code: 'internal', message: 'package expired' },
    });
  });

  it('a target whose sink is no longer registered is retried', async () => {
    const { deps, deliveries, submit } = await setup();
    const id = await submit();
    await deps.targets.put({
      id: 't1',
      label: 'T1',
      sinkId: 'nosuch',
      instanceId: null,
      connectionId: null,
      destination: {},
    });
    await runOnce(deps, T0);
    expect(await deliveries.get(id)).toMatchObject({
      status: 'queued',
      error: { code: 'sink_unavailable' },
    });
  });

  it("returns 'idle' when nothing is due", async () => {
    const { deps } = await setup();
    expect(await runOnce(deps, T0)).toBe('idle');
  });
});
