import { randomUUID } from 'node:crypto';
import type { BridgePackage, ConditionalUpdate } from '@ih/bridge-contract';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptDeliveries } from '../src/deliveries/accept.js';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { runOnce } from '../src/deliveries/runner.js';
import { MemoryPackageStore } from '../src/packages/store.js';
import { FakeSink } from '../src/sinks/fake.js';
import { FakeDocumentSink } from '../src/sinks/fake-documents.js';
import { HttpSink } from '../src/sinks/http.js';
import { MapSinkRegistry, SinkError } from '../src/sinks/port.js';
import { serveSink } from '../src/sinks/serve.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { KEY } from './helpers.js';
import { decomposedPackage } from './sink-builders.js';

const T0 = new Date('2026-10-23T12:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

/** Serve `sink` over HTTP and reach it the way the bridge does. */
async function remote(sink: FakeSink | FakeDocumentSink, destination: Record<string, string>) {
  const app = await serveSink(sink, KEY);
  open.push(app);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const http = new HttpSink({ id: 'fake', url, key: KEY, timeouts: { short: 2_000, long: 2_000 } });
  const deliveries = new MemoryDeliveryRepo();
  const packages = new MemoryPackageStore();
  const targets = new MemoryTargetRepo();
  await targets.put({
    id: 't1',
    label: 'T1',
    sinkId: 'fake',
    instanceId: null,
    connectionId: null,
    destination,
  });
  const sinks = new MapSinkRegistry({ fake: http });
  const connections = new MemoryConnectionRepo(targets);
  const submit = async (pkg: BridgePackage, update?: ConditionalUpdate, now = T0) => {
    const result = await acceptDeliveries(
      { deliveries, packages, targets, sinks, connections, retentionDays: 30 },
      {
        targets: ['t1'],
        actingUser: { id: 'u1', name: 'Pat', email: null },
        overrides: {},
        patterns: {},
        package: pkg,
        ...(update ? { update } : {}),
      },
      now,
      randomUUID,
    );
    return result.deliveries[0]!.deliveryId;
  };
  const run = (now: Date) =>
    runOnce(
      { deliveries, packages, targets, sinks, maxAttempts: 8, leaseSeconds: 300, pollSeconds: 30 },
      now,
    );
  return { deliveries, submit, run };
}

describe('decomposed documents through the bridge, over HTTP', () => {
  it('creates, updates, refuses over a target edit, and keeps version 1 targets out', async () => {
    const fake = new FakeDocumentSink();
    const { deliveries, submit, run } = await remote(fake, { space: 'S' });

    // 1. Created, with a persistent id.
    const first = await submit(decomposedPackage);
    await run(T0);
    const created = await deliveries.get(first);
    expect(created?.status).toBe('succeeded');
    const document = created!.receipt!.document!;
    expect(document.persistentId).toBe('doc-1');
    expect(document.readBack.ok).toBe(true);
    const section = document.components.find((c) => c.kind === 'section')!;

    // 2. An update with the receipt's versions succeeds with the same id.
    const again = { ...decomposedPackage, idempotencyKey: 'a'.repeat(64) };
    const second = await submit(
      again,
      { persistentId: document.persistentId, expected: document.components },
      at(1),
    );
    await run(at(1));
    const updated = await deliveries.get(second);
    expect(updated?.status).toBe('succeeded');
    expect(updated?.receipt?.document?.persistentId).toBe('doc-1');

    const seen = updated!.receipt!.document!.components;

    // 3. Someone edits one section in the target.
    const before = seen.find((c) => c.id === section.id)!.version;
    fake.edit('doc-1', section.id);

    // 4. An update expecting the versions it last saw is refused, naming that section alone.
    const stale = { ...decomposedPackage, idempotencyKey: 'b'.repeat(64) };
    const third = await submit(
      stale,
      { persistentId: document.persistentId, expected: seen },
      at(2),
    );
    await run(at(2));
    expect(await deliveries.get(third)).toMatchObject({
      status: 'needs_user',
      error: {
        class: 'needs_user',
        code: 'changed_in_target',
        details: {
          changed: [{ id: section.id, expected: before, actual: String(Number(before) + 1) }],
        },
      },
    });

    // 5. A version 1 target refuses the document.
    const v1 = await remote(new FakeSink(), { bucket: 'b' });
    const refused = await v1.submit(decomposedPackage).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(SinkError);
    expect((refused as SinkError).error).toMatchObject({ code: 'unsupported_part' });
  });
});
