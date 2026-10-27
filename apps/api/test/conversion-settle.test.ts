import { randomUUID } from 'node:crypto';
import { bridgeError, documentMissing, type BridgeEvent, type Receipt } from '@ih/bridge-contract';
import { GONE_DETAIL, type Item } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { applyEvent } from '../src/bridge/events.js';
import { reconcileOnce, STRAGGLER_MINUTES } from '../src/bridge/reconcile.js';
import { linkOf } from '../src/bridge/register.js';
import { MemoryPublishTargetRepo } from '../src/publish-targets/repo.js';
import { MemoryRepo } from '../src/repositories/memory.js';
import { FakeBridgeApi } from './fake-bridge.js';

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
    item: (): Omit<
      Item,
      'resolution' | 'unversioned' | 'gone' | 'unconfirmed' | 'reloadable' | 'rerunIn' | 'rerunAt'
    > => ({
      ...repo.conversionItems.get(itemId)!,
    }),
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

  it('records when a delivered or refused item finished', async () => {
    const t = await delivered();
    t.workerRecords();
    expect(t.item().finishedAt).toBeNull();
    await applyEvent(t.deps, event(t.deliveryId));
    expect(Date.parse(t.item().finishedAt!)).not.toBeNaN();

    const refused = await delivered({ persistentId: 'doc-1' });
    refused.workerRecords();
    const error = bridgeError('changed_in_target', 'the document changed in the target');
    await applyEvent(
      refused.deps,
      event(refused.deliveryId, { status: 'needs_user', error, receipt: null }),
    );
    expect(refused.item()).toMatchObject({
      outcome: 'changed_in_target',
      finishedAt: expect.any(String),
    });
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

  it("an update refused with the target's missing-document marker settles unresolved: gone", async () => {
    const t = await delivered({ persistentId: 'doc-1' });
    t.workerRecords();
    const error = documentMissing('doc-1', 'Repository lib has no map doc-1 for this update');
    await applyEvent(t.deps, event(t.deliveryId, { status: 'needs_user', error, receipt: null }));
    expect(await t.repo.getItem(t.item().id)).toMatchObject({
      outcome: 'unresolved',
      detail: GONE_DETAIL,
      gone: true,
      resolution: null,
    });
    expect(t.repo.register.get(t.entryId)).toMatchObject({
      state: 'failed',
      persistentId: 'doc-1',
    });
    expect(t.jobStatus()).toBe('succeeded');
  });

  it('an update refused as not_found without the marker, or for another document, fails', async () => {
    for (const error of [
      bridgeError('not_found', 'no such route'),
      bridgeError('not_found', 'no sink job 7'),
      documentMissing('doc-2', 'Repository lib has no map doc-2'),
    ]) {
      const t = await delivered({ persistentId: 'doc-1' });
      t.workerRecords();
      await applyEvent(t.deps, event(t.deliveryId, { status: 'needs_user', error, receipt: null }));
      expect(await t.repo.getItem(t.item().id), error.message).toMatchObject({
        outcome: 'failed',
        detail: error.message,
        gone: false,
        reloadable: false,
      });
    }
  });

  it("the reconcile's not_found for a delivery the bridge lost is no gone document", async () => {
    const t = await delivered({ persistentId: 'doc-1' });
    t.workerRecords();
    t.repo.ageRegisterEntry(t.entryId, new Date(Date.now() - (STRAGGLER_MINUTES + 1) * 60_000));
    expect(
      await reconcileOnce({ ...t.deps, bridge: new FakeBridgeApi() }, new Date()),
    ).toBeGreaterThan(0);
    expect(t.repo.register.get(t.entryId)).toMatchObject({
      state: 'failed',
      lastError: { code: 'not_found' },
    });
    expect(await t.repo.getItem(t.item().id)).toMatchObject({
      outcome: 'failed',
      gone: false,
      reloadable: false,
    });
  });

  it('a create refused as not found is no gone document: it fails', async () => {
    const t = await delivered();
    t.workerRecords();
    const error = bridgeError('not_found', 'no such space');
    await applyEvent(t.deps, event(t.deliveryId, { status: 'needs_user', error, receipt: null }));
    expect(await t.repo.getItem(t.item().id)).toMatchObject({
      outcome: 'failed',
      detail: 'no such space',
      gone: false,
    });
  });

  it('settles the item whatever the order of event and worker write', async () => {
    const workerFirst = await delivered();
    workerFirst.workerRecords();
    await applyEvent(workerFirst.deps, event(workerFirst.deliveryId));

    const eventFirst = await delivered();
    await applyEvent(eventFirst.deps, event(eventFirst.deliveryId));
    // The worker's write comes late, and moves nothing the event settled.
    expect(eventFirst.workerRecords()).toBe(false);

    const comparable = (i: Pick<Item, 'outcome' | 'link' | 'detail'>) => ({
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

  it("links the document's map entry, the sink's own name for the document", async () => {
    const t = await delivered();
    t.workerRecords();
    const receipt = documentReceipt('doc-1');
    const map = 'https://docs.example.test/maps/doc-1';
    receipt.written = [
      { kind: 'topic', id: 'doc-1/t1', label: 'Intro', url: 'https://docs.example.test/t1' },
      { kind: 'map', id: 'doc-1/map', label: 'Results', url: map },
    ];
    await applyEvent(t.deps, event(t.deliveryId, { receipt }));
    expect(t.item()).toMatchObject({ outcome: 'created', link: map });
  });
});

describe('linkOf', () => {
  const entry = (kind: string, id: string, url: string | null) => ({ kind, id, label: null, url });
  const receipt = (written: Receipt['written'], mapId?: string): Receipt => ({
    written,
    document: {
      persistentId: 'doc-1',
      components: mapId ? [{ kind: 'map', id: mapId, version: '1', element: null }] : [],
      readBack: { ok: true, at: null, detail: null },
    },
  });

  it("takes a document or map entry's url", () => {
    expect(linkOf(receipt([entry('map', 'm', 'https://t.test/m')]))).toBe('https://t.test/m');
    expect(linkOf(receipt([entry('document', 'd', 'https://t.test/d')]))).toBe('https://t.test/d');
  });

  it("never takes a topic's or an image's url", () => {
    const written = [
      entry('topic', 't', 'https://t.test/t'),
      entry('image', 'i', 'https://t.test/i'),
      entry('map', 'm', null),
    ];
    expect(linkOf(receipt(written))).toBeNull();
    expect(linkOf(null)).toBeNull();
  });

  it("prefers the entry that is the receipt's map component", () => {
    const written = [
      entry('map', 'other-map', 'https://t.test/other'),
      entry('document', 'doc-1', 'https://t.test/doc'),
      entry('map', 'doc-1/map', 'https://t.test/map'),
    ];
    expect(linkOf(receipt(written, 'doc-1/map'))).toBe('https://t.test/map');
    expect(linkOf(receipt(written))).toBe('https://t.test/other');
  });
});
