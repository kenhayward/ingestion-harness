import { randomUUID } from 'node:crypto';
import { bridgeError, type BridgeEvent, type Receipt } from '@ih/bridge-contract';
import type { Item } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { applyEvent } from '../src/bridge/events.js';
import { MemoryPublishTargetRepo } from '../src/publish-targets/repo.js';
import { MemoryRepo } from '../src/repositories/memory.js';

const AT = '2026-10-25T10:00:00.000Z';
const TARGET = 'manuals';
const URL = 'https://docs.example.test/documents/doc-1';

/**
 * A started batch of one item whose `decompose` job handed the document to the bridge: the
 * register entry is pending with its delivery, and the job is delivering. The item is still
 * `decomposing`: the worker records `delivering` with `workerRecords`, before or after the event.
 */
async function delivered(over: { persistentId?: string | null } = {}) {
  const repo = new MemoryRepo();
  const deps = { repo, targets: new MemoryPublishTargetRepo() };
  const batch = await repo.createBatch({
    targetId: TARGET,
    force: false,
    createdBy: { id: null, name: null },
  });
  const itemId = randomUUID();
  await repo.addItem({
    id: itemId,
    batchId: batch.id,
    sourceKey: 'reports/r1.docx',
    filename: 'r1.docx',
    contentSha256: 'a'.repeat(64),
    sizeBytes: 10,
    objectKey: `decompositions/${batch.id}/${itemId}.docx`,
  });
  const started = await repo.startBatch(batch.id, null);
  if (!started.ok) throw new Error('not started');
  const [jobId] = started.jobIds as [string];
  repo.backgroundJobs.find((j) => j.id === jobId)!.status = 'delivering';
  repo.conversionItems.get(itemId)!.outcome = 'decomposing';
  const deliveryId = randomUUID();
  const entry = repo.putRegisterEntry({
    sinkId: 'documents',
    instanceId: 'tenant-1',
    sourceKey: 'reports/r1.docx',
    contentSha256: 'a'.repeat(64),
    persistentId: over.persistentId ?? null,
    idempotencyKey: 'k'.repeat(64),
    deliveryId,
    batchId: batch.id,
  });
  await repo.recordDeliveries(jobId, [{ targetId: TARGET, deliveryId }]);
  return {
    repo,
    deps,
    jobId,
    deliveryId,
    entryId: entry.id,
    item: (): Item => ({ ...repo.conversionItems.get(itemId)! }),
    jobStatus: () => repo.backgroundJobs.find((j) => j.id === jobId)!.status,
    /** The job's last event: how it finished. */
    lastEvent: () => repo.events.get(jobId)?.at(-1)?.message,
    /** The worker's write once the bridge took the document (PgItemStore.decide's guard). */
    workerRecords: () => {
      const item = repo.conversionItems.get(itemId)!;
      if (item.outcome !== 'queued' && item.outcome !== 'decomposing') return false;
      Object.assign(item, {
        outcome: 'delivering',
        detail: 'a new source',
        registerEntryId: entry.id,
      });
      return true;
    },
  };
}

const documentReceipt = (persistentId: string, ok = true): Receipt => ({
  written: [
    { kind: 'image', id: 'img-1', label: null, url: null },
    { kind: 'document', id: persistentId, label: 'Results', url: URL },
  ],
  document: {
    persistentId,
    components: [{ kind: 'section', element: 's1', id: 'c1', version: '1' }],
    readBack: {
      ok,
      at: ok ? null : 'section s1',
      detail: ok ? null : 'text differs',
    },
  },
});

const event = (deliveryId: string, over: Partial<BridgeEvent> = {}): BridgeEvent => ({
  eventId: randomUUID(),
  deliveryId,
  sequence: 1,
  status: 'succeeded',
  error: null,
  receipt: documentReceipt('doc-1'),
  at: AT,
  ...over,
});

describe('a conversion item, settled from the bridge events', () => {
  it('settles the item created from a delivered event', async () => {
    const t = await delivered();
    t.workerRecords();
    expect(await applyEvent(t.deps, event(t.deliveryId))).toBe('applied');
    expect(t.item()).toMatchObject({
      outcome: 'created',
      link: URL,
      registerEntryId: t.entryId,
    });
    expect(t.item().detail).toContain('doc-1');
    expect(t.jobStatus()).toBe('succeeded');
  });

  it('settles an update of a known document as updated', async () => {
    const t = await delivered({ persistentId: 'doc-1' });
    t.workerRecords();
    await applyEvent(t.deps, event(t.deliveryId));
    expect(t.item()).toMatchObject({ outcome: 'updated', link: URL });
  });

  it('a read-back failure settles as read_back_mismatch', async () => {
    const t = await delivered();
    t.workerRecords();
    await applyEvent(t.deps, event(t.deliveryId, { receipt: documentReceipt('doc-1', false) }));
    const item = t.item();
    expect(item).toMatchObject({ outcome: 'read_back_mismatch', link: URL });
    expect(item.detail).toContain('section s1');
    expect(item.detail).toContain('text differs');
  });

  it('changed_in_target settles the item and never awaits review', async () => {
    const t = await delivered({ persistentId: 'doc-1' });
    t.workerRecords();
    const error = bridgeError('changed_in_target', 'the document changed in the target', {
      changed: [{ id: 'c1', expected: '1', actual: '2' }],
    });
    await applyEvent(t.deps, event(t.deliveryId, { status: 'needs_user', error, receipt: null }));
    expect(t.item()).toMatchObject({
      outcome: 'changed_in_target',
      detail: 'the document changed in the target',
      link: null,
    });
    // R3: an outcome was decided, so the job succeeds; it never waits for a review.
    expect(t.jobStatus()).toBe('succeeded');
  });

  it('a failed delivery fails the item with its reason', async () => {
    const t = await delivered();
    t.workerRecords();
    const error = bridgeError('content_rejected', 'the sink refused the content');
    await applyEvent(t.deps, event(t.deliveryId, { status: 'failed', error, receipt: null }));
    expect(t.item()).toMatchObject({
      outcome: 'failed',
      detail: 'the sink refused the content',
    });
    expect(t.jobStatus()).toBe('succeeded');
  });

  it('settles the item whatever the order of event and worker write', async () => {
    const workerFirst = await delivered();
    workerFirst.workerRecords();
    await applyEvent(workerFirst.deps, event(workerFirst.deliveryId));

    const eventFirst = await delivered();
    await applyEvent(eventFirst.deps, event(eventFirst.deliveryId));
    // The worker's write comes late, and moves nothing the event settled.
    expect(eventFirst.workerRecords()).toBe(false);

    const comparable = (i: Item) => ({
      outcome: i.outcome,
      link: i.link,
      detail: i.detail,
    });
    expect(comparable(eventFirst.item())).toEqual(comparable(workerFirst.item()));
    expect(eventFirst.item()).toMatchObject({
      outcome: 'created',
      registerEntryId: eventFirst.entryId,
    });

    // A repeated event, or a later one, changes nothing.
    for (const t of [workerFirst, eventFirst]) {
      const before = t.item();
      await applyEvent(t.deps, event(t.deliveryId));
      await applyEvent(
        t.deps,
        event(t.deliveryId, {
          sequence: 5,
          status: 'failed',
          error: bridgeError('internal', 'late'),
          receipt: null,
        }),
      );
      expect(t.item()).toEqual(before);
    }
  });

  it('leaves an item the worker already decided alone', async () => {
    const t = await delivered();
    t.repo.conversionItems.get(t.item().id)!.outcome = 'already_loaded';
    await applyEvent(t.deps, event(t.deliveryId));
    expect(t.item().outcome).toBe('already_loaded');
  });

  it("the job's final event names the item's outcome, not just delivered", async () => {
    const created = await delivered();
    created.workerRecords();
    await applyEvent(created.deps, event(created.deliveryId));
    expect(created.lastEvent()).toBe('created: document doc-1');

    const changed = await delivered({ persistentId: 'doc-1' });
    changed.workerRecords();
    const error = bridgeError('changed_in_target', 'the document changed in the target');
    await applyEvent(
      changed.deps,
      event(changed.deliveryId, { status: 'needs_user', error, receipt: null }),
    );
    expect(changed.lastEvent()).toBe('changed in target: the document changed in the target');
  });

  it('a straggler event finishes the job succeeded after its entry moved on', async () => {
    // The register settled from an earlier event, and another batch re-pointed the entry, before
    // the job's own delivery row heard its final status (the reconcile's straggler pass).
    const t = await delivered();
    t.workerRecords();
    const entry = t.repo.register.get(t.entryId)!;
    Object.assign(entry, { state: 'pending', deliveryId: randomUUID() });
    const error = bridgeError('content_rejected', 'the sink refused the content');
    await applyEvent(t.deps, event(t.deliveryId, { status: 'failed', error, receipt: null }));
    expect(t.jobStatus()).toBe('succeeded');
  });

  it('a delivered event settles an item a late worker error failed', async () => {
    // The worker's last attempt failed after the bridge took the document: the document still
    // arrives, and the item says so.
    const t = await delivered();
    t.repo.conversionItems.get(t.item().id)!.outcome = 'failed';
    await applyEvent(t.deps, event(t.deliveryId));
    expect(t.item()).toMatchObject({ outcome: 'created', registerEntryId: t.entryId });
  });

  it('links only the document itself, never another written part', async () => {
    const t = await delivered();
    t.workerRecords();
    const receipt = documentReceipt('doc-1');
    receipt.written = [
      { kind: 'image', id: 'img-1', label: null, url: 'https://docs.example.test/img-1' },
      { kind: 'document', id: 'doc-1', label: null, url: null },
    ];
    await applyEvent(t.deps, event(t.deliveryId, { receipt }));
    expect(t.item()).toMatchObject({ outcome: 'created', link: null });
  });
});
