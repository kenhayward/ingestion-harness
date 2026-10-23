import { randomUUID } from 'node:crypto';
import {
  bridgeError,
  type BridgeEvent,
  type DeliveryView,
  type Receipt,
} from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { applyEvent } from '../src/bridge/events.js';
import { reconcileOnce, STRAGGLER_MINUTES, UNRECORDED_MINUTES } from '../src/bridge/reconcile.js';
import { MemoryPublishTargetRepo } from '../src/publish-targets/repo.js';
import { MemoryRepo } from '../src/repositories/memory.js';
import { FakeBridgeApi } from './fake-bridge.js';

const AT = '2026-10-23T10:00:00.000Z';

function setup() {
  const repo = new MemoryRepo();
  return { repo, deps: { repo, targets: new MemoryPublishTargetRepo() } };
}

/** A pending entry, as the worker writes it before delivering (before `set_delivery` if unsent). */
function entry(
  repo: MemoryRepo,
  over: { persistentId?: string | null; deliveryId: string | null },
) {
  return repo.putRegisterEntry({
    sinkId: 'documents',
    instanceId: 'tenant-1',
    sourceKey: 'batch/a.docx',
    contentSha256: 'a'.repeat(64),
    persistentId: over.persistentId ?? null,
    idempotencyKey: 'k'.repeat(64),
    deliveryId: over.deliveryId,
    batchId: null,
  }).id;
}

/** A pending entry whose delivery the bridge accepted. */
function pending(repo: MemoryRepo, over: { persistentId?: string | null } = {}) {
  const deliveryId = randomUUID();
  return { deliveryId, entryId: entry(repo, { ...over, deliveryId }) };
}

/** A pending entry the worker has not recorded a delivery for yet. */
const unsent = (repo: MemoryRepo) => entry(repo, { deliveryId: null });

const documentReceipt = (persistentId: string, ok = true): Receipt => ({
  written: [{ kind: 'document', id: persistentId, label: null, url: null }],
  document: {
    persistentId,
    components: [{ kind: 'section', element: 's1', id: 'c1', version: '1' }],
    readBack: { ok, at: ok ? null : 'section s1', detail: ok ? null : 'text differs' },
  },
});

const event = (deliveryId: string, over: Partial<BridgeEvent> = {}): BridgeEvent => ({
  eventId: randomUUID(),
  deliveryId,
  sequence: 1,
  status: 'succeeded',
  error: null,
  receipt: { written: [] },
  at: AT,
  ...over,
});

const entryOf = async (repo: MemoryRepo, deliveryId: string) =>
  (await repo.registerEntryByDelivery(deliveryId))!;

describe('the register, kept from bridge events', () => {
  it('success with document receipt delivers', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo);
    const receipt = documentReceipt('doc-1');
    expect(await applyEvent(deps, event(deliveryId, { receipt }))).toBe('applied');
    const entry = await entryOf(repo, deliveryId);
    expect(entry).toMatchObject({
      state: 'delivered',
      persistentId: 'doc-1',
      lastReceipt: receipt,
      lastError: null,
    });
    expect(entry.deliveredAt).not.toBeNull();
  });

  it('read-back failure marks incomplete', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo);
    const receipt = documentReceipt('doc-1', false);
    await applyEvent(deps, event(deliveryId, { receipt }));
    const entry = await entryOf(repo, deliveryId);
    expect(entry).toMatchObject({
      state: 'incomplete',
      persistentId: 'doc-1',
      lastReceipt: receipt,
    });
    expect(entry.deliveredAt).not.toBeNull();
  });

  it('receipt without document marks incomplete', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo, { persistentId: 'doc-0' });
    await applyEvent(deps, event(deliveryId, { receipt: { written: [] } }));
    expect(await entryOf(repo, deliveryId)).toMatchObject({
      state: 'incomplete',
      persistentId: 'doc-0',
      lastReceipt: null,
    });
  });

  it('changed_in_target marks changed', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo, { persistentId: 'doc-1' });
    const error = bridgeError('changed_in_target', 'the document changed in the target', {
      components: [{ kind: 'section', element: 's1', expected: '1', actual: '2' }],
    });
    await applyEvent(deps, event(deliveryId, { status: 'needs_user', error, receipt: null }));
    expect(await entryOf(repo, deliveryId)).toMatchObject({
      state: 'changed',
      persistentId: 'doc-1',
      lastError: error,
      deliveredAt: null,
    });
  });

  it('other failure marks failed and keeps a known persistent id', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo, { persistentId: 'doc-1' });
    const error = bridgeError('content_rejected', 'the sink refused the content');
    await applyEvent(deps, event(deliveryId, { status: 'needs_user', error, receipt: null }));
    expect(await entryOf(repo, deliveryId)).toMatchObject({
      state: 'failed',
      persistentId: 'doc-1',
      lastError: error,
    });
  });

  it('a failure whose receipt reports a persistent id records it', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo);
    const error = bridgeError('internal', 'failed part-way');
    await applyEvent(
      deps,
      event(deliveryId, { status: 'failed', error, receipt: documentReceipt('doc-2', false) }),
    );
    expect(await entryOf(repo, deliveryId)).toMatchObject({
      state: 'failed',
      persistentId: 'doc-2',
    });
  });

  it('events for other deliveries are ignored', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo);
    expect(await applyEvent(deps, event(randomUUID(), { receipt: documentReceipt('x') }))).toBe(
      'unknown',
    );
    expect(await entryOf(repo, deliveryId)).toMatchObject({ state: 'pending', persistentId: null });
  });

  it('non-final events change nothing', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo);
    for (const status of ['queued', 'running', 'waiting'] as const) {
      expect(await applyEvent(deps, event(deliveryId, { status, receipt: null }))).toBe('stale');
    }
    expect(await entryOf(repo, deliveryId)).toMatchObject({ state: 'pending' });
  });

  it('a repeated or later event never moves a settled entry, nor clears its persistent id', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo);
    await applyEvent(deps, event(deliveryId, { sequence: 3, receipt: documentReceipt('doc-1') }));
    const error = bridgeError('internal', 'late');
    expect(
      await applyEvent(deps, event(deliveryId, { sequence: 4, status: 'failed', error })),
    ).toBe('stale');
    expect(await entryOf(repo, deliveryId)).toMatchObject({
      state: 'delivered',
      persistentId: 'doc-1',
      lastError: null,
    });
  });

  it('a job delivery and its register entry move together, once', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo);
    await repo.recordDeliveries(randomUUID(), [{ targetId: 'documents', deliveryId }]);
    expect(
      await applyEvent(deps, event(deliveryId, { sequence: 2, receipt: documentReceipt('d') })),
    ).toBe('applied');
    expect(await entryOf(repo, deliveryId)).toMatchObject({ state: 'delivered' });
    // An older event the job delivery refuses as stale finds the entry settled already.
    expect(
      await applyEvent(
        deps,
        event(deliveryId, { sequence: 1, status: 'failed', error: bridgeError('internal', 'x') }),
      ),
    ).toBe('stale');
    expect(await entryOf(repo, deliveryId)).toMatchObject({ state: 'delivered', lastError: null });
  });

  it('a skipped delivery marks incomplete, keeping the persistent id', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo, { persistentId: 'doc-1' });
    await applyEvent(deps, event(deliveryId, { status: 'skipped', receipt: null }));
    expect(await entryOf(repo, deliveryId)).toMatchObject({
      state: 'incomplete',
      persistentId: 'doc-1',
      deliveredAt: null,
    });
  });

  it('an event before the worker recorded its delivery is unknown and moves nothing', async () => {
    const { repo, deps } = setup();
    const entryId = unsent(repo);
    expect(await applyEvent(deps, event(randomUUID(), { receipt: documentReceipt('d') }))).toBe(
      'unknown',
    );
    expect(repo.register.get(entryId)).toMatchObject({ state: 'pending', persistentId: null });
  });

  it('a resent final event settles an entry whose first register write failed', async () => {
    const { repo, deps } = setup();
    const { deliveryId } = pending(repo);
    await repo.recordDeliveries(randomUUID(), [{ targetId: 'documents', deliveryId }]);
    const settle = repo.settleRegisterEntry.bind(repo);
    let failures = 1;
    repo.settleRegisterEntry = async (id, s) => {
      if (failures-- > 0) throw new Error('connection lost');
      return settle(id, s);
    };
    const final = event(deliveryId, { sequence: 2, receipt: documentReceipt('doc-1') });
    await expect(applyEvent(deps, final)).rejects.toThrow('connection lost');
    expect((await repo.deliveriesOf(repo.deliveries.get(deliveryId)!.jobId))[0]).toMatchObject({
      status: 'succeeded',
    });
    expect(await entryOf(repo, deliveryId)).toMatchObject({ state: 'pending' });
    // The bridge sends it again: the job delivery has it (stale), the register takes it now.
    expect(await applyEvent(deps, { ...final, eventId: randomUUID() })).toBe('stale');
    expect(await entryOf(repo, deliveryId)).toMatchObject({
      state: 'delivered',
      persistentId: 'doc-1',
    });
  });
});

describe('reconciling the register', () => {
  const NOW = new Date(AT);
  const view = (id: string, over: Partial<DeliveryView> = {}): DeliveryView => ({
    id,
    packageId: randomUUID(),
    targetId: 'documents',
    status: 'succeeded',
    attempts: 1,
    error: null,
    receipt: documentReceipt('doc-1'),
    skippedFor: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });
  const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

  it('settles a stuck pending entry from a final bridge delivery', async () => {
    const { repo, deps } = setup();
    const bridge = new FakeBridgeApi();
    const { deliveryId, entryId } = pending(repo);
    repo.ageRegisterEntry(entryId, ago(STRAGGLER_MINUTES + 1));
    bridge.deliveries.set(deliveryId, view(deliveryId));
    expect(await reconcileOnce({ ...deps, bridge }, NOW)).toBe(1);
    expect(await entryOf(repo, deliveryId)).toMatchObject({
      state: 'delivered',
      persistentId: 'doc-1',
    });
    expect(await reconcileOnce({ ...deps, bridge }, NOW)).toBe(0);
  });

  it('leaves an entry pending while its bridge delivery is still running', async () => {
    const { repo, deps } = setup();
    const bridge = new FakeBridgeApi();
    const { deliveryId, entryId } = pending(repo);
    repo.ageRegisterEntry(entryId, ago(STRAGGLER_MINUTES + 5));
    bridge.deliveries.set(deliveryId, view(deliveryId, { status: 'running', receipt: null }));
    expect(await reconcileOnce({ ...deps, bridge }, NOW)).toBe(0);
    bridge.failNext = new Error('down');
    expect(await reconcileOnce({ ...deps, bridge }, NOW)).toBe(0);
    expect(await entryOf(repo, deliveryId)).toMatchObject({ state: 'pending' });
  });

  it('does not poll a young entry, nor one without a delivery', async () => {
    const { repo, deps } = setup();
    const bridge = new FakeBridgeApi();
    const young = pending(repo);
    repo.ageRegisterEntry(young.entryId, ago(STRAGGLER_MINUTES - 1));
    const unsentId = unsent(repo);
    repo.ageRegisterEntry(unsentId, ago(UNRECORDED_MINUTES - 1));
    bridge.deliveries.set(young.deliveryId, view(young.deliveryId));
    const asked: string[] = [];
    const get = bridge.getDelivery.bind(bridge);
    bridge.getDelivery = async (id) => {
      asked.push(id);
      return get(id);
    };
    expect(await reconcileOnce({ ...deps, bridge }, NOW)).toBe(0);
    expect(asked).toEqual([]);
    expect(repo.register.get(young.entryId)).toMatchObject({ state: 'pending' });
    expect(repo.register.get(unsentId)).toMatchObject({ state: 'pending' });
  });

  it('fails an entry left without a delivery for UNRECORDED_MINUTES', async () => {
    const { repo, deps } = setup();
    const bridge = new FakeBridgeApi();
    const stale = unsent(repo);
    repo.ageRegisterEntry(stale, ago(UNRECORDED_MINUTES + 1));
    const fresh = unsent(repo);
    repo.ageRegisterEntry(fresh, ago(UNRECORDED_MINUTES - 1));
    const settled = pending(repo);
    repo.ageRegisterEntry(settled.entryId, ago(UNRECORDED_MINUTES + 1));
    bridge.deliveries.set(
      settled.deliveryId,
      view(settled.deliveryId, { status: 'running', receipt: null }),
    );
    expect(await reconcileOnce({ ...deps, bridge }, NOW)).toBe(1);
    expect(repo.register.get(stale)).toMatchObject({
      state: 'failed',
      lastError: { code: 'not_recorded', message: 'the delivery was never recorded' },
    });
    expect(repo.register.get(fresh)).toMatchObject({ state: 'pending' });
    expect(repo.register.get(settled.entryId)).toMatchObject({ state: 'pending' });
    expect(await reconcileOnce({ ...deps, bridge }, NOW)).toBe(0);
  });

  it('fails a stuck entry whose delivery the bridge has no record of', async () => {
    const { repo, deps } = setup();
    const bridge = new FakeBridgeApi();
    const { deliveryId, entryId } = pending(repo, { persistentId: 'doc-1' });
    repo.ageRegisterEntry(entryId, ago(STRAGGLER_MINUTES + 1));
    expect(await reconcileOnce({ ...deps, bridge }, NOW)).toBe(1);
    expect(await entryOf(repo, deliveryId)).toMatchObject({
      state: 'failed',
      persistentId: 'doc-1',
      lastError: { code: 'not_found' },
    });
  });
});
