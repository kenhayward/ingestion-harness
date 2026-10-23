import { randomUUID } from 'node:crypto';
import { bridgeError, type BridgeEvent, type Receipt } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { applyEvent } from '../src/bridge/events.js';
import { MemoryPublishTargetRepo } from '../src/publish-targets/repo.js';
import { MemoryRepo } from '../src/repositories/memory.js';

const AT = '2026-10-23T10:00:00.000Z';

function setup() {
  const repo = new MemoryRepo();
  return { repo, deps: { repo, targets: new MemoryPublishTargetRepo() } };
}

/** A pending entry, as the worker writes it before delivering. */
function pending(repo: MemoryRepo, over: { persistentId?: string | null } = {}) {
  const deliveryId = randomUUID();
  const entry = repo.putRegisterEntry({
    sinkId: 'documents',
    instanceId: 'tenant-1',
    sourceKey: 'batch/a.docx',
    contentSha256: 'a'.repeat(64),
    persistentId: over.persistentId ?? null,
    idempotencyKey: 'k'.repeat(64),
    deliveryId,
    batchId: null,
  });
  return { deliveryId, entryId: entry.id };
}

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
    // An older event the job delivery refuses as stale leaves the register alone too.
    expect(
      await applyEvent(
        deps,
        event(deliveryId, { sequence: 1, status: 'failed', error: bridgeError('internal', 'x') }),
      ),
    ).toBe('stale');
    expect(await entryOf(repo, deliveryId)).toMatchObject({ state: 'delivered', lastError: null });
  });
});
