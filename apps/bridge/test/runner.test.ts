import { randomUUID } from 'node:crypto';
import type { BridgePackage, Capabilities, ConditionalUpdate } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { acceptDeliveries } from '../src/deliveries/accept.js';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { backoff, runOnce } from '../src/deliveries/runner.js';
import { MemoryPackageStore } from '../src/packages/store.js';
import { FakeSink } from '../src/sinks/fake.js';
import { FakeDocumentSink } from '../src/sinks/fake-documents.js';
import { MapSinkRegistry } from '../src/sinks/port.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { Credentials } from '../src/connections/credential.js';
import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { encryptSecret } from '../src/secrets.js';
import { connection } from './connections-contract.js';
import { SECRETS } from './helpers.js';
import { decomposedPackage, documentPackage } from './sink-builders.js';

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

async function setup<S extends FakeSink | FakeDocumentSink = FakeSink>(
  sink: S = new FakeSink({ capabilities: caps() }) as S,
  maxAttempts = 8,
  destination: Record<string, string> = { bucket: 'b', prefix: 'out/' },
) {
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
  const sinks = new MapSinkRegistry({ fake: sink });
  const connections = new MemoryConnectionRepo(targets);
  const deps = {
    deliveries,
    packages,
    targets,
    sinks,
    maxAttempts,
    leaseSeconds: 300,
    pollSeconds: 30,
  };
  const submit = async (
    overrides: Record<string, string> = {},
    now = T0,
    extra: { package?: BridgePackage; update?: ConditionalUpdate } = {},
  ) => {
    const result = await acceptDeliveries(
      { deliveries, packages, targets, sinks, connections, retentionDays: 30 },
      {
        targets: ['t1'],
        actingUser: { id: 'u1', name: 'Pat', email: null },
        overrides: { t1: overrides },
        patterns: {},
        package: extra.package ?? documentPackage,
        ...(extra.update ? { update: extra.update } : {}),
      },
      now,
      randomUUID,
    );
    return result.deliveries[0]!.deliveryId;
  };
  return { deps, deliveries, packages, sink, submit };
}

describe('backoff', () => {
  it('doubles from 30 s and stops at an hour', () => {
    expect([1, 2, 3, 10, 20].map(backoff)).toEqual([30, 60, 120, 3600, 3600]);
  });
});

describe('runOnce', () => {
  it("delivers the destination resolved at accept (a reviewer's name over the target's)", async () => {
    const named = new FakeSink({
      capabilities: caps(),
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
    const { deps, deliveries, sink, submit } = await setup(named);
    const id = await submit({ name: 'Chosen' });
    expect(await runOnce(deps, T0)).toBe('worked');
    expect(sink.delivered[0]).toMatchObject({
      destination: { bucket: 'b', prefix: 'out/', name: 'Chosen' },
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

describe('runOnce with a connection', () => {
  const credentialFields = [
    { id: 'user', label: 'User', secret: false },
    { id: 'token', label: 'Token', secret: true },
  ];

  async function withConnection(sink: FakeSink) {
    const { deps, deliveries, submit } = await setup(sink);
    const connections = new MemoryConnectionRepo(deps.targets);
    await connections.put({
      ...connection('c1', { sinkId: 'fake', fields: { user: 'pat' } }),
      secretEnc: encryptSecret('tok', SECRETS),
    });
    const t1 = (await deps.targets.get('t1'))!;
    await deps.targets.put({ ...t1, connectionId: 'c1' });
    const full = {
      ...deps,
      connections,
      credentials: new Credentials({ connections, secrets: SECRETS, env: {} }),
    };
    return { deps: full, deliveries, connections, submit };
  }

  it("passes the connection's decrypted secret as the credential", async () => {
    const sink = new FakeSink({ capabilities: caps(), credentialFields });
    const { deps, connections, submit } = await withConnection(sink);
    await submit();
    await runOnce(deps, T0);
    expect(sink.delivered[0]!.credential).toEqual({ user: 'pat', token: 'tok' });
    expect(await connections.get('c1')).toMatchObject({ status: 'ok', lastUsedAt: T0 });
  });

  it('a rejected credential marks the connection needs_attention', async () => {
    const sink = new FakeSink({ capabilities: caps(), credentialFields }).script({
      error: 'credential_rejected',
    });
    const { deps, deliveries, connections, submit } = await withConnection(sink);
    const id = await submit();
    await runOnce(deps, T0);
    expect((await deliveries.get(id))?.status).toBe('needs_user');
    expect(await connections.get('c1')).toMatchObject({
      status: 'needs_attention',
      statusReason: 'scripted credential_rejected',
      lastUsedAt: null,
    });
  });

  it('a missing connection stops the delivery for a person', async () => {
    const sink = new FakeSink({ capabilities: caps(), credentialFields });
    const { deps, deliveries, connections, submit } = await withConnection(sink);
    const t1 = (await deps.targets.get('t1'))!;
    await deps.targets.put({ ...t1, connectionId: 'gone' });
    const id = await submit();
    await runOnce(deps, T0);
    expect(await deliveries.get(id)).toMatchObject({
      status: 'needs_user',
      error: { code: 'connection_missing' },
    });
    expect(sink.delivered).toEqual([]);
    expect((await connections.get('c1'))?.status).toBe('untested');
  });
});

describe('a personal sink', () => {
  const credentialFields = [
    { id: 'username', label: 'Username', secret: false },
    { id: 'password', label: 'Password', secret: true },
  ];
  const pat = { id: 'u1', name: 'Pat', email: null };
  const sam = { id: 'u2', name: 'Sam', email: null };

  async function personal(sink = new FakeSink({})) {
    const deliveries = new MemoryDeliveryRepo();
    const packages = new MemoryPackageStore();
    const targets = new MemoryTargetRepo();
    await targets.put({
      id: 'acme',
      label: 'Acme',
      sinkId: 'acme',
      instanceId: 'sandbox',
      connectionId: null,
      destination: { bucket: 'b' },
    });
    const connections = new MemoryConnectionRepo(targets);
    const mine = (id: string, owner: string, password: string) =>
      connections.put({
        ...connection(id, {
          kind: 'personal',
          owner,
          sinkId: 'acme',
          instanceId: 'sandbox',
          fields: { username: owner },
        }),
        secretEnc: encryptSecret(password, SECRETS),
      });
    await mine('u-pat', 'u1', 'pat-pw');
    await mine('u-sam', 'u2', 'sam-pw');
    const sinks = new MapSinkRegistry({ acme: sink });
    const deps = {
      deliveries,
      packages,
      targets,
      sinks,
      connections,
      credentials: new Credentials({ connections, secrets: SECRETS, env: {} }),
      maxAttempts: 8,
      leaseSeconds: 300,
      pollSeconds: 30,
    };
    const submit = (actingUser: typeof pat | null) =>
      acceptDeliveries(
        { deliveries, packages, targets, sinks, connections, retentionDays: 30 },
        { targets: ['acme'], actingUser, overrides: {}, patterns: {}, package: documentPackage },
        T0,
        randomUUID,
      );
    return { deps, deliveries, connections, submit };
  }
  const acmeSink = () =>
    new FakeSink({
      capabilities: caps(),
      connectionKind: 'personal',
      instances: [{ id: 'sandbox', label: 'Sandbox' }],
      credentialFields,
    });

  it('accept refuses a delivery with no person to deliver as, writing nothing', async () => {
    const { deliveries, submit } = await personal(acmeSink());
    await expect(submit(null)).rejects.toMatchObject({
      error: {
        code: 'connection_missing',
        message: 'delivering to Acme needs a person to deliver as',
      },
    });
    expect(await deliveries.claim(T0, 300)).toBeNull();
  });

  it('accept refuses an acting user with no connection for the instance', async () => {
    const { submit } = await personal(acmeSink());
    await expect(submit({ id: 'u3', name: 'Lee', email: null })).rejects.toMatchObject({
      error: {
        code: 'connection_missing',
        message: 'Lee has no connection for Acme: add one on the connections page',
        details: { targetId: 'acme', userId: 'u3' },
      },
    });
  });

  it("delivers with the acting user's own credential and marks that connection", async () => {
    const sink = acmeSink();
    const { deps, connections, submit } = await personal(sink);
    await submit(sam);
    await runOnce(deps, T0);
    expect(sink.delivered[0]!.credential).toEqual({ username: 'u2', password: 'sam-pw' });
    expect(await connections.get('u-sam')).toMatchObject({ status: 'ok', lastUsedAt: T0 });
    expect(await connections.get('u-pat')).toMatchObject({ status: 'untested', lastUsedAt: null });
  });

  it("a rejected credential flags the acting user's connection", async () => {
    const sink = acmeSink().script({ error: 'credential_rejected' });
    const { deps, deliveries, connections, submit } = await personal(sink);
    const id = (await submit(pat)).deliveries[0]!.deliveryId;
    await runOnce(deps, T0);
    expect((await deliveries.get(id))?.status).toBe('needs_user');
    expect(await connections.get('u-pat')).toMatchObject({ status: 'needs_attention' });
    expect((await connections.get('u-sam'))?.status).toBe('untested');
  });

  it('a connection deleted after accept stops the delivery for a person, after one attempt', async () => {
    const sink = acmeSink();
    const { deps, deliveries, connections, submit } = await personal(sink);
    const id = (await submit(pat)).deliveries[0]!.deliveryId;
    await connections.removeOwner('u1');
    await runOnce(deps, T0);
    expect(await deliveries.get(id)).toMatchObject({
      status: 'needs_user',
      attempts: 1,
      error: { code: 'connection_missing' },
    });
    expect(sink.delivered).toEqual([]);
  });
});

describe('a personal sink, polled', () => {
  const credentialFields = [{ id: 'password', label: 'Password', secret: true }];

  async function pending() {
    const sink = new FakeSink({
      capabilities: caps(),
      connectionKind: 'personal',
      instances: [],
      credentialFields,
    }).script('pending');
    const deliveries = new MemoryDeliveryRepo();
    const packages = new MemoryPackageStore();
    const targets = new MemoryTargetRepo();
    await targets.put({
      id: 'acme',
      label: 'Acme',
      sinkId: 'acme',
      instanceId: null,
      connectionId: null,
      destination: { bucket: 'b' },
    });
    const connections = new MemoryConnectionRepo(targets);
    await connections.put({
      ...connection('u-pat', { kind: 'personal', owner: 'u1', sinkId: 'acme', fields: {} }),
      secretEnc: encryptSecret('pw', SECRETS),
    });
    const sinks = new MapSinkRegistry({ acme: sink });
    const deps = {
      deliveries,
      packages,
      targets,
      sinks,
      connections,
      credentials: new Credentials({ connections, secrets: SECRETS, env: {} }),
      maxAttempts: 8,
      leaseSeconds: 300,
      pollSeconds: 30,
    };
    const { deliveries: made } = await acceptDeliveries(
      { deliveries, packages, targets, sinks, connections, retentionDays: 30 },
      {
        targets: ['acme'],
        actingUser: { id: 'u1', name: 'Pat', email: null },
        overrides: {},
        patterns: {},
        package: documentPackage,
      },
      T0,
      randomUUID,
    );
    await runOnce(deps, T0);
    return { deps, deliveries, connections, sink, id: made[0]!.deliveryId };
  }

  it('a pending job is still read when the connection went meanwhile', async () => {
    const { deps, deliveries, connections, sink, id } = await pending();
    expect((await deliveries.get(id))?.status).toBe('waiting');
    await connections.removeOwner('u1');
    sink.scriptStatus('succeed');
    await runOnce(deps, at(60));
    expect((await deliveries.get(id))?.status).toBe('succeeded');
  });

  it("a polled success marks the acting user's connection", async () => {
    const { deps, connections, sink } = await pending();
    sink.scriptStatus('succeed');
    await runOnce(deps, at(60));
    expect(await connections.get('u-pat')).toMatchObject({ status: 'ok', lastUsedAt: at(60) });
  });
});

describe('a delivery accepted before phase 6', () => {
  it('has no resolved destination: its overrides merge over the target, as before', async () => {
    const { deps, deliveries, sink } = await setup();
    await deliveries.create(
      {
        id: 'p-old',
        kind: 'document',
        idempotencyKey: documentPackage.idempotencyKey,
        manifest: {},
        stagedKey: 'packages/p-old.json',
        expiresAt: null,
      },
      [
        {
          id: 'd-old',
          targetId: 't1',
          actingUser: null,
          overrides: { prefix: 'old/' },
          destination: null,
        },
      ],
      T0,
    );
    await deps.packages.put('packages/p-old.json', documentPackage);
    await runOnce(deps, T0);
    expect(sink.delivered[0]!.destination).toEqual({ bucket: 'b', prefix: 'old/' });
  });
});

describe('runOnce, contract version 2', () => {
  /** A version 2 sink that records what it is sent, taking decomposed documents. */
  const v2Sink = (over: Partial<Capabilities> = {}) =>
    new FakeSink({
      contractVersion: 2,
      capabilities: caps({
        readBack: true,
        accepts: ['files', 'data', 'document', 'images'],
        decomposedDocuments: { equations: ['mathml'] },
        ...over,
      }),
    });
  const update: ConditionalUpdate = {
    persistentId: 'doc-1',
    expected: [{ kind: 'map', id: 'doc-1/map', version: '1', element: null }],
  };
  /** The decomposed fixture under another key: a later edit of the same document. */
  const edited = { ...decomposedPackage, idempotencyKey: 'e'.repeat(64) };

  it('passes update to the sink', async () => {
    const { deps, deliveries, sink, submit } = await setup(v2Sink());
    const id = await submit({}, T0, { package: decomposedPackage, update });
    await runOnce(deps, T0);
    expect(sink.delivered[0]!.update).toEqual(update);
    expect((await deliveries.get(id))?.status).toBe('succeeded');
  });

  it('sends no update when the delivery has none', async () => {
    const { deps, sink, submit } = await setup(v2Sink());
    await submit({}, T0, { package: decomposedPackage });
    await runOnce(deps, T0);
    expect(sink.delivered[0]).not.toHaveProperty('update');
  });

  it('upgrades v1 packages for v2 sinks', async () => {
    const { deps, deliveries, packages, sink, submit } = await setup(v2Sink());
    const id = await submit();
    await runOnce(deps, T0);
    expect(sink.delivered[0]!.package).toEqual({ ...documentPackage, contractVersion: 2 });
    const meta = await deliveries.getPackage((await deliveries.get(id))!.packageId);
    expect(await packages.get(meta!.stagedKey)).toEqual(documentPackage);
    expect(meta!.manifest).toMatchObject({ contractVersion: 1 });
  });

  it('downgrades a v2 package without a document for a v1 sink', async () => {
    const { deps, deliveries, packages, sink, submit } = await setup();
    const v2 = { ...documentPackage, contractVersion: 2 as const };
    const id = await submit({}, T0, { package: v2 });
    await runOnce(deps, T0);
    expect(sink.delivered[0]!.package).toEqual(documentPackage);
    const meta = await deliveries.getPackage((await deliveries.get(id))!.packageId);
    expect(await packages.get(meta!.stagedKey)).toEqual(v2);
    expect(meta!.manifest).toMatchObject({ contractVersion: 2 });
  });

  it('a v2 sink gets a v2 package as it was', async () => {
    const { deps, sink, submit } = await setup(v2Sink());
    await submit({}, T0, { package: decomposedPackage });
    await runOnce(deps, T0);
    expect(sink.delivered[0]!.package).toEqual(decomposedPackage);
  });

  it('a v1 sink gets the v1 package as it was', async () => {
    const { deps, sink, submit } = await setup();
    await submit();
    await runOnce(deps, T0);
    expect(sink.delivered[0]!.package).toEqual(documentPackage);
  });

  it('does not skip a repeated key that carries an update, even where the sink cannot replace', async () => {
    const { deps, deliveries, sink, submit } = await setup(
      v2Sink({ replace: false, withdraw: false }),
    );
    await submit({}, T0, { package: decomposedPackage });
    await runOnce(deps, T0);
    const second = await submit({}, at(1), { package: decomposedPackage, update });
    await runOnce(deps, at(1));
    expect((await deliveries.get(second))?.status).toBe('succeeded');
    expect(sink.delivered).toHaveLength(2);
  });

  it('does not skip a repeated document package, even where the sink cannot replace', async () => {
    // The sink is idempotent by key: a replay gets the first write's receipt, so the entry
    // learns the document's persistent id instead of ending with none.
    const { deps, deliveries, sink, submit } = await setup(
      v2Sink({ replace: false, withdraw: false }),
    );
    await submit({}, T0, { package: decomposedPackage });
    await runOnce(deps, T0);
    const second = await submit({}, at(1), { package: decomposedPackage });
    await runOnce(deps, at(1));
    expect((await deliveries.get(second))?.status).toBe('succeeded');
    expect(sink.delivered).toHaveLength(2);
  });

  it('stores a document receipt', async () => {
    const { deps, deliveries, submit } = await setup(new FakeDocumentSink(), 8, { space: 'S' });
    const id = await submit({}, T0, { package: decomposedPackage });
    await runOnce(deps, T0);
    const row = await deliveries.get(id);
    expect(row?.status).toBe('succeeded');
    expect(row?.receipt?.document?.persistentId).toBe('doc-1');
    expect(row?.receipt?.document?.readBack.ok).toBe(true);
  });

  it('changed_in_target ends in needs_user with details', async () => {
    const { deps, deliveries, sink, submit } = await setup(new FakeDocumentSink(), 8, {
      space: 'S',
    });
    const created = await submit({}, T0, { package: decomposedPackage });
    await runOnce(deps, T0);
    const components = (await deliveries.get(created))!.receipt!.document!.components;
    sink.edit('doc-1', 'doc-1/map');
    const id = await submit({}, at(1), {
      package: edited,
      update: { persistentId: 'doc-1', expected: components },
    });
    await runOnce(deps, at(1));
    expect(await deliveries.get(id)).toMatchObject({
      status: 'needs_user',
      attempts: 1,
      error: {
        class: 'needs_user',
        code: 'changed_in_target',
        details: { changed: [{ id: 'doc-1/map', expected: '1', actual: '2' }] },
      },
    });
  });

  it('an update the target still matches replaces the document', async () => {
    const { deps, deliveries, submit } = await setup(new FakeDocumentSink(), 8, { space: 'S' });
    const created = await submit({}, T0, { package: decomposedPackage });
    await runOnce(deps, T0);
    const components = (await deliveries.get(created))!.receipt!.document!.components;
    const id = await submit({}, at(1), {
      package: edited,
      update: { persistentId: 'doc-1', expected: components },
    });
    await runOnce(deps, at(1));
    const document = (await deliveries.get(id))?.receipt?.document;
    expect(document?.persistentId).toBe('doc-1');
    expect(document?.components.find((c) => c.id === 'doc-1/map')?.version).toBe('2');
  });
});
