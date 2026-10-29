import { randomUUID } from 'node:crypto';
import {
  bridgeError,
  changedInTargetDetails,
  documentMissing,
  type Receipt,
} from '@ih/bridge-contract';
import {
  BatchSchema,
  BatchSummarySchema,
  DecomposeParamsSchema,
  ItemSchema,
  type Item,
} from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { acceptPlanOf } from '../src/conversions/accept.js';
import type { ConversionRepo, NewItem, RegisterAction } from '../src/conversions/repo.js';
import type { RegisterEntry } from '../src/repositories/types.js';

/** A queued job as the repo wrote it (the jobs table, or MemoryRepo's background jobs). */
export interface QueuedJob {
  task: string;
  priority: number;
  maxAttempts: number;
  params: unknown;
  createdBy: string | null;
  createdByUser: string | null;
}

/** A register entry as the worker and the bridge's events leave it (a test seeds it). */
export type EntrySeed = Pick<
  RegisterEntry,
  'sourceKey' | 'state' | 'persistentId' | 'lastReceipt' | 'lastError' | 'batchId'
>;

export interface ConversionFacts {
  job(id: string): Promise<QueuedJob | null>;
  /** Seeds a register entry; its id. */
  entry(seed: EntrySeed): Promise<string>;
  /** Links an item to an entry with an outcome, as the worker or an event does. */
  settleItem(itemId: string, outcome: Item['outcome'], entryId: string | null): Promise<void>;
  /** Holds an item for review, as the worker does: `awaiting_review`, with its held files. */
  hold(itemId: string): Promise<void>;
  /** The register actions recorded on an entry, oldest first. */
  actions(entryId: string): Promise<RegisterAction[]>;
  /** Removes an entry, as the worker does when a create replaces a detached tombstone. */
  dropEntry(entryId: string): Promise<void>;
  /** Moves an entry on, as a later run does (its state and batch, and its `updatedAt` to now). */
  moveEntry(entryId: string, to: { state: RegisterEntry['state']; batchId: string }): Promise<void>;
  /** Makes the batch a watched folder's (the worker does this in production). */
  watch(batchId: string, name: string): Promise<string>;
  /** The pickup that led to an item, at `step` (the worker writes these). */
  pickup(itemId: string, step: 'queued' | 'finished' | 'abandoned'): Promise<void>;
  /** The batch the watch adds its next pickup to (null: it starts a new one). */
  watchBatch(watchId: string): Promise<string | null>;
  /** Records when an item started and finished, as the worker and the settle do. */
  times(itemId: string, startedAt: string | null, finishedAt: string | null): Promise<void>;
}

const ADA = { id: '7a1f3c52-1b2e-4c3d-8e4f-5a6b7c8d9e0f', name: 'Ada' };

const RECEIPT: Receipt = {
  written: [{ kind: 'document', id: 'doc-1', label: null, url: null }],
  document: {
    persistentId: 'doc-1',
    components: [
      { kind: 'map', id: 'doc-1/map', version: '1', element: null },
      { kind: 'section', id: 'doc-1/section/s1', version: '1', element: 's1' },
      { kind: 'section', id: 'doc-1/section/s2', version: '1', element: 's2' },
    ],
    readBack: { ok: true, at: null, detail: null },
  },
};

const CHANGED = [
  { id: 'doc-1/section/s1', expected: '1', actual: '2' },
  { id: 'doc-1/section/s2', expected: '1', actual: null },
];

const changedSeed = (sourceKey: string, batchId: string): EntrySeed => ({
  sourceKey,
  state: 'changed',
  persistentId: 'doc-1',
  lastReceipt: RECEIPT,
  lastError: bridgeError('changed_in_target', '2 changed', changedInTargetDetails(CHANGED)),
  batchId,
});

/** The same contract for MemoryRepo (unit) and PgRepo (integration/conversions-pg.test.ts). */
export function conversionsContract(
  name: string,
  make: () => Promise<{ repo: ConversionRepo; facts: ConversionFacts }>,
): void {
  describe(`ConversionRepo (${name})`, () => {
    const item = (batchId: string, sourceKey: string): NewItem => {
      const id = randomUUID();
      return {
        id,
        batchId,
        sourceKey,
        filename: sourceKey.split('/').pop()!,
        contentSha256: 'a'.repeat(64),
        sizeBytes: 1234,
        objectKey: `decompositions/${batchId}/${id}.docx`,
      };
    };

    it('creates an open batch, not started, with its creator', async () => {
      const { repo } = await make();
      const batch = BatchSchema.parse(
        await repo.createBatch({ targetId: 'manuals', force: true, createdBy: ADA }),
      );
      expect(batch).toMatchObject({
        targetId: 'manuals',
        force: true,
        createdBy: ADA,
        state: 'open',
        startedAt: null,
      });
      expect(await repo.getBatch(batch.id)).toEqual(batch);
      expect(await repo.getBatch(randomUUID())).toBeNull();
    });

    it('adds items in upload order, queued, without a job', async () => {
      const { repo } = await make();
      const batch = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      const a = item(batch.id, 'folder/b.docx');
      const b = item(batch.id, 'folder/a.docx');
      const added = await repo.addItem(a);
      expect(added.ok).toBe(true);
      await repo.addItem(b);
      const items = (await repo.listItems(batch.id)).map((i) => ItemSchema.parse(i));
      expect(items.map((i) => i.sourceKey)).toEqual(['folder/b.docx', 'folder/a.docx']);
      expect(items[0]).toEqual({
        ...a,
        jobId: null,
        outcome: 'queued',
        detail: null,
        registerEntryId: null,
        reportKey: null,
        link: null,
        redeliverOf: null,
        resolution: null,
        unversioned: false,
        gone: false,
        unconfirmed: false,
        partWay: false,
        links: [],
        reloadable: false,
        rerunIn: null,
        rerunAt: null,
        startedAt: null,
        finishedAt: null,
        flagCount: null,
        held: false,
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      });
      expect(await repo.getItem(a.id)).toEqual(items[0]);
      expect(await repo.getItem(randomUUID())).toBeNull();
    });

    it('says when an item started and finished converting', async () => {
      const { repo, facts } = await make();
      const batch = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      const running = item(batch.id, 'running.docx');
      const done = item(batch.id, 'done.docx');
      await repo.addItem(running);
      await repo.addItem(done);
      await facts.times(running.id, '2026-10-26T13:00:00.000Z', null);
      await facts.times(done.id, '2026-10-26T13:00:00.000Z', '2026-10-26T13:01:12.000Z');
      expect(ItemSchema.parse(await repo.getItem(running.id))).toMatchObject({
        startedAt: '2026-10-26T13:00:00.000Z',
        finishedAt: null,
      });
      const listed = await repo.listItems(batch.id);
      expect(listed.find((i) => i.id === done.id)).toMatchObject({
        startedAt: '2026-10-26T13:00:00.000Z',
        finishedAt: '2026-10-26T13:01:12.000Z',
      });
    });

    it('refuses a repeated source key in one batch, but not in another', async () => {
      const { repo } = await make();
      const one = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      const two = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      await repo.addItem(item(one.id, 'a.docx'));
      expect(await repo.addItem(item(one.id, 'a.docx'))).toEqual({
        ok: false,
        reason: 'duplicate',
      });
      expect((await repo.addItem(item(two.id, 'a.docx'))).ok).toBe(true);
      expect(await repo.listItems(one.id)).toHaveLength(1);
    });

    it('adds no item to a missing or started batch', async () => {
      const { repo } = await make();
      expect(await repo.addItem(item(randomUUID(), 'a.docx'))).toEqual({
        ok: false,
        reason: 'missing',
      });
      const batch = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      await repo.addItem(item(batch.id, 'a.docx'));
      await repo.startBatch(batch.id, null);
      expect(await repo.addItem(item(batch.id, 'b.docx'))).toEqual({
        ok: false,
        reason: 'not_open',
      });
    });

    it('starts a batch: one decompose job per item, at an upload priority', async () => {
      const { repo, facts } = await make();
      const batch = await repo.createBatch({ targetId: 'manuals', force: true, createdBy: ADA });
      const a = item(batch.id, 'a.docx');
      const b = item(batch.id, 'sub/b.docx');
      await repo.addItem(a);
      await repo.addItem(b);
      const started = await repo.startBatch(batch.id, { name: 'Ada', userId: ADA.id });
      if (!started.ok) throw new Error(started.reason);
      expect(BatchSchema.parse(started.batch)).toMatchObject({ id: batch.id, state: 'started' });
      expect(started.batch.startedAt).not.toBeNull();
      expect(started.jobIds).toHaveLength(2);

      const items = await repo.listItems(batch.id);
      expect(items.map((i) => i.jobId)).toEqual(started.jobIds);
      for (const [i, it] of items.entries()) {
        const job = await facts.job(started.jobIds[i]!);
        expect(job).toEqual({
          task: 'decompose',
          priority: 0,
          maxAttempts: 3,
          params: {
            batchId: batch.id,
            itemId: it.id,
            targetId: 'manuals',
            sourceKey: it.sourceKey,
            force: true,
          },
          createdBy: 'Ada',
          createdByUser: ADA.id,
        });
        DecomposeParamsSchema.parse(job!.params);
      }
      expect(await repo.startBatch(batch.id, null)).toEqual({ ok: false, reason: 'not_open' });
    });

    it('keeps an auto-approving batch so, and its jobs carry it', async () => {
      const { repo, facts } = await make();
      const batch = await repo.createBatch({
        targetId: 'manuals',
        force: false,
        autoApprove: true,
        createdBy: ADA,
      });
      expect(batch.autoApprove).toBe(true);
      expect((await repo.getBatch(batch.id))?.autoApprove).toBe(true);
      const a = item(batch.id, 'a.pdf');
      await repo.addItem(a);
      const started = await repo.startBatch(batch.id, null);
      if (!started.ok) throw new Error(started.reason);
      const params = DecomposeParamsSchema.parse((await facts.job(started.jobIds[0]!))!.params);
      expect(params).toMatchObject({ force: false, autoApprove: true });
      const plain = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      expect(plain.autoApprove).toBe(false);
    });

    it('does not start a batch with no items, or a missing one', async () => {
      const { repo } = await make();
      const batch = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      expect(await repo.startBatch(batch.id, null)).toEqual({ ok: false, reason: 'empty' });
      expect((await repo.getBatch(batch.id))?.state).toBe('open');
      expect(await repo.startBatch(randomUUID(), null)).toEqual({ ok: false, reason: 'missing' });
    });

    it('discards an open batch and names its objects; a started one stays', async () => {
      const { repo } = await make();
      const batch = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      const a = item(batch.id, 'a.docx');
      await repo.addItem(a);
      expect(await repo.discardBatch(batch.id)).toEqual({ ok: true, objectKeys: [a.objectKey] });
      expect((await repo.getBatch(batch.id))?.state).toBe('discarded');
      expect((await repo.addItem(item(batch.id, 'b.docx'))).ok).toBe(false);
      expect(await repo.discardBatch(batch.id)).toEqual({ ok: false, reason: 'not_open' });

      const started = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      await repo.addItem(item(started.id, 'a.docx'));
      await repo.startBatch(started.id, null);
      expect(await repo.discardBatch(started.id)).toEqual({ ok: false, reason: 'not_open' });
      expect(await repo.discardBatch(randomUUID())).toEqual({ ok: false, reason: 'missing' });
    });

    it('lists open and started batches newest first, counted per outcome', async () => {
      const { repo } = await make();
      const first = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      await repo.addItem(item(first.id, 'a.docx'));
      await repo.addItem(item(first.id, 'b.docx'));
      const gone = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      await repo.discardBatch(gone.id);
      const second = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });

      const listed = (await repo.listBatches(50)).map((b) => BatchSummarySchema.parse(b));
      expect(listed.map((b) => b.id)).toEqual([second.id, first.id]);
      expect(listed[1]).toMatchObject({ ...first, itemCount: 2 });
      expect(listed[1]!.counts.queued).toBe(2);
      expect(listed[1]!.counts.created).toBe(0);
      expect(Object.keys(listed[1]!.counts)).toHaveLength(15);
      expect(listed[0]).toMatchObject({ itemCount: 0 });
      expect(await repo.listBatches(1)).toHaveLength(1);
    });

    /** A started batch of one finished item, and its batch. */
    const finished = async (sourceKey = 'manuals/a.docx') => {
      const { repo, facts } = await make();
      const batch = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      const a = item(batch.id, sourceKey);
      await repo.addItem(a);
      await repo.startBatch(batch.id, null);
      await facts.settleItem(a.id, 'created', null);
      return { repo, facts, batch, item: (await repo.getItem(a.id))! };
    };

    const rerunOf = (of: Item) => {
      const batchId = randomUUID();
      const itemId = randomUUID();
      return {
        batchId,
        itemId,
        of,
        targetId: 'manuals',
        createdBy: ADA,
        by: { name: 'Ada', userId: ADA.id },
        source: {
          filename: 'new.docx',
          contentSha256: 'b'.repeat(64),
          sizeBytes: 9,
          objectKey: `decompositions/${batchId}/${itemId}.docx`,
        },
      };
    };

    it('reruns an item as a started batch of one, forced, under its source key', async () => {
      const { repo, facts, item: of } = await finished();
      const asked = rerunOf(of);
      const { batchId, itemId } = asked;

      const done = await repo.rerunItem(asked);

      if (!done.ok) throw new Error(done.reason);
      const { batch, item: rerun } = done;
      expect(BatchSchema.parse(batch)).toMatchObject({
        id: batchId,
        targetId: 'manuals',
        force: true,
        state: 'started',
        createdBy: ADA,
      });
      expect(batch.startedAt).not.toBeNull();
      expect(ItemSchema.parse(rerun)).toEqual({
        id: itemId,
        batchId,
        sourceKey: of.sourceKey,
        filename: 'new.docx',
        contentSha256: 'b'.repeat(64),
        sizeBytes: 9,
        objectKey: asked.source.objectKey,
        jobId: expect.any(String),
        outcome: 'queued',
        detail: null,
        registerEntryId: null,
        reportKey: null,
        link: null,
        redeliverOf: of.id,
        resolution: null,
        unversioned: false,
        gone: false,
        unconfirmed: false,
        partWay: false,
        links: [],
        reloadable: false,
        rerunIn: null,
        rerunAt: null,
        startedAt: null,
        finishedAt: null,
        flagCount: null,
        held: false,
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      });
      expect(await repo.listItems(batchId)).toEqual([rerun]);
      expect(await repo.getItem(of.id)).toMatchObject({
        rerunIn: batchId,
        rerunAt: batch.startedAt,
      });
      expect(await facts.job(rerun.jobId!)).toEqual({
        task: 'decompose',
        priority: 0,
        maxAttempts: 3,
        params: { batchId, itemId, targetId: 'manuals', sourceKey: of.sourceKey, force: true },
        createdBy: 'Ada',
        createdByUser: ADA.id,
      });
    });

    it('reruns an item once while its rerun is unfinished', async () => {
      const { repo, facts, item: of } = await finished();
      const first = await repo.rerunItem(rerunOf(of));
      if (!first.ok) throw new Error(first.reason);
      const second = rerunOf(of);

      expect(await repo.rerunItem(second)).toEqual({ ok: false, reason: 'running' });
      expect(await repo.getBatch(second.batchId)).toBeNull();
      expect(await repo.getItem(second.itemId)).toBeNull();
      // Once the rerun has an outcome, the item may be rerun again.
      await facts.settleItem(first.item.id, 'updated', null);
      expect((await repo.rerunItem(rerunOf(of))).ok).toBe(true);
    });

    /** A started batch of two items that failed, and its batch. */
    const failedPair = async () => {
      const { repo, facts } = await make();
      const batch = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      const a = item(batch.id, 'manuals/a.docx');
      const b = item(batch.id, 'manuals/b.docx');
      await repo.addItem(a);
      await repo.addItem(b);
      await repo.startBatch(batch.id, null);
      await facts.settleItem(a.id, 'failed', null);
      await facts.settleItem(b.id, 'failed', null);
      return {
        repo,
        facts,
        batch,
        items: [(await repo.getItem(a.id))!, (await repo.getItem(b.id))!],
      };
    };

    const retryOf = (items: Item[], force = false) => ({
      items,
      targetId: 'manuals',
      force,
      by: { name: 'Ada', userId: ADA.id },
    });

    it('deletes a started batch once its items have finished, and nothing else', async () => {
      const { repo, facts, batch, item: a } = await finished();
      // a force-load of `a` in another batch, delivering the file `a` was stored as
      const asked = { ...rerunOf(a), source: { ...rerunOf(a).source, objectKey: a.objectKey } };
      const rerun = await repo.rerunItem(asked);
      if (!rerun.ok) throw new Error(rerun.reason);

      expect(await repo.deleteBatch(asked.batchId)).toEqual({
        ok: false,
        reason: 'running',
        running: 1,
      });
      await facts.hold(rerun.item.id);
      expect(await repo.deleteBatch(asked.batchId)).toMatchObject({ reason: 'running' });
      await facts.settleItem(rerun.item.id, 'failed', null);
      expect(await repo.getItem(a.id)).toMatchObject({ rerunIn: asked.batchId });

      // the re-run batch's own prefix holds nothing another batch names
      expect(await repo.deleteBatch(asked.batchId)).toEqual({ ok: true, kept: [] });
      expect(await repo.getBatch(asked.batchId)).toBeNull();
      expect(await repo.getItem(rerun.item.id)).toBeNull();
      expect(await repo.listItems(asked.batchId)).toEqual([]);
      // `a` was re-run in the deleted batch only: it is re-run nowhere now
      expect(await repo.getItem(a.id)).toMatchObject({ rerunIn: null, rerunAt: null });

      // deleting `a`'s batch keeps the file a later re-run of it delivers
      const again = { ...rerunOf(a), source: { ...rerunOf(a).source, objectKey: a.objectKey } };
      const second = await repo.rerunItem(again);
      if (!second.ok) throw new Error(second.reason);
      expect(await repo.deleteBatch(batch.id)).toEqual({ ok: true, kept: [a.objectKey] });
      expect(await repo.getItem(a.id)).toBeNull();
      expect((await repo.listBatches(10)).map((b) => b.id)).toEqual([again.batchId]);
      expect(await repo.getItem(second.item.id)).toMatchObject({ objectKey: a.objectKey });
    });

    it("deletes a watch's batch's finished documents, keeps the unfinished ones and the batch", async () => {
      const { repo, facts } = await make();
      const batch = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      const [a, b, c] = ['a.docx', 'b.docx', 'c.docx'].map((k) => item(batch.id, k));
      for (const i of [a!, b!, c!]) await repo.addItem(i);
      await repo.startBatch(batch.id, null);
      const watchId = await facts.watch(batch.id, 'Inbox');
      expect(await repo.getBatch(batch.id)).toMatchObject({
        watch: { id: watchId, name: 'Inbox' },
      });
      await facts.settleItem(a!.id, 'created', null);
      await facts.settleItem(b!.id, 'failed', null);
      await facts.settleItem(c!.id, 'awaiting_review', null);

      const done = await repo.deleteBatch(batch.id);
      expect(done).toEqual({ ok: true, kept: [], remove: [a!.objectKey, b!.objectKey].sort() });
      expect(await repo.getItem(a!.id)).toBeNull();
      expect(await repo.getItem(b!.id)).toBeNull();
      expect(await repo.getItem(c!.id)).toMatchObject({ outcome: 'awaiting_review' });
      expect(await repo.getBatch(batch.id)).not.toBeNull();

      // The next pickup starts a new batch; this one stays while a document is under way.
      expect(await facts.watchBatch(watchId)).toBeNull();
      expect(await repo.deleteBatch(batch.id)).toEqual({ ok: true, kept: [], remove: [] });
      await facts.settleItem(c!.id, 'failed', null);
      expect(await repo.deleteBatch(batch.id)).toEqual({ ok: true, kept: [] });
      expect(await repo.getBatch(batch.id)).toBeNull();
    });

    it("keeps a watch's document until the watch has filed its file, whatever its outcome", async () => {
      const { repo, facts } = await make();
      const batch = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      const [a, b, c] = ['a.docx', 'b.docx', 'c.docx'].map((k) => item(batch.id, k));
      for (const i of [a!, b!, c!]) await repo.addItem(i);
      await repo.startBatch(batch.id, null);
      const watchId = await facts.watch(batch.id, 'Inbox');
      for (const i of [a!, b!, c!]) await facts.settleItem(i.id, 'created', null);
      await facts.pickup(a!.id, 'queued'); // settled, but its file is still in processing/
      await facts.pickup(b!.id, 'finished');
      await facts.pickup(c!.id, 'abandoned');

      expect(await repo.deleteBatch(batch.id)).toEqual({
        ok: true,
        kept: [],
        remove: [b!.objectKey, c!.objectKey].sort(),
      });
      expect(await repo.getItem(a!.id)).toMatchObject({ outcome: 'created' });
      expect(await repo.getBatch(batch.id)).not.toBeNull();
      expect(await facts.watchBatch(watchId)).toBeNull();

      await facts.pickup(a!.id, 'finished');
      expect(await repo.deleteBatch(batch.id)).toEqual({ ok: true, kept: [] });
      expect(await repo.getBatch(batch.id)).toBeNull();
    });

    it('deletes no open, discarded or missing batch', async () => {
      const { repo } = await make();
      const open = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      await repo.addItem(item(open.id, 'a.docx'));
      expect(await repo.deleteBatch(open.id)).toEqual({ ok: false, reason: 'not_started' });
      await repo.discardBatch(open.id);
      expect(await repo.deleteBatch(open.id)).toEqual({ ok: false, reason: 'not_started' });
      expect(await repo.getBatch(open.id)).toMatchObject({ state: 'discarded' });
      expect(await repo.deleteBatch(randomUUID())).toEqual({ ok: false, reason: 'missing' });
    });

    it('re-runs auto-approving when asked', async () => {
      const { repo, facts, items } = await failedPair();
      const done = await repo.retryItems({ ...retryOf(items.slice(0, 1)), autoApprove: true });
      if (!done.ok) throw new Error(done.reason);
      const job = await facts.job(done.items[0]!.jobId!);
      expect(DecomposeParamsSchema.parse(job!.params).autoApprove).toBe(true);
    });

    it('re-runs failed items in place: each queued again in its batch, with a new job', async () => {
      const { repo, facts, batch, items } = await failedPair();

      const done = await repo.retryItems(retryOf(items));

      if (!done.ok) throw new Error(done.reason);
      expect(done.items.map((i) => ItemSchema.parse(i))).toEqual(
        items.map((of) => ({
          ...of,
          jobId: expect.any(String),
          outcome: 'queued',
          detail: null,
          reportKey: null,
          link: null,
          startedAt: null,
          finishedAt: null,
          flagCount: null,
          held: false,
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: null,
        })),
      );
      expect(done.items.map((i) => i.jobId)).not.toContain(items[0]!.jobId);
      // The batch still has its two items, now queued: no other batch or item is made.
      expect(await repo.listItems(batch.id)).toEqual(done.items);
      expect(await facts.job(done.items[1]!.jobId!)).toEqual({
        task: 'decompose',
        priority: 0,
        maxAttempts: 3,
        params: {
          batchId: batch.id,
          itemId: items[1]!.id,
          targetId: 'manuals',
          sourceKey: items[1]!.sourceKey,
          force: false,
        },
        createdBy: 'Ada',
        createdByUser: ADA.id,
      });
    });

    it('re-runs forced when asked', async () => {
      const { repo, facts, items } = await failedPair();
      const done = await repo.retryItems(retryOf(items.slice(0, 1), true));
      if (!done.ok) throw new Error(done.reason);
      expect(await facts.job(done.items[0]!.jobId!)).toMatchObject({
        params: { force: true },
      });
    });

    it('re-runs nothing while one of them is under way, and again once it failed again', async () => {
      const { repo, facts, items } = await failedPair();
      const first = await repo.retryItems(retryOf(items.slice(1)));
      if (!first.ok) throw new Error(first.reason);

      expect(await repo.retryItems(retryOf(items))).toEqual({
        ok: false,
        reason: 'running',
        itemId: items[1]!.id,
      });
      // The other was left as it was.
      expect(await repo.getItem(items[0]!.id)).toEqual(items[0]);
      await facts.settleItem(items[1]!.id, 'failed', null);
      expect((await repo.retryItems(retryOf(items))).ok).toBe(true);
    });

    it('re-runs no item that is not failed: one done, or rejected', async () => {
      const { repo, facts, items } = await failedPair();
      for (const outcome of ['created', 'rejected'] as const) {
        await facts.settleItem(items[1]!.id, outcome, null);
        expect(await repo.retryItems(retryOf(items)), outcome).toEqual({
          ok: false,
          reason: 'not_failed',
          itemId: items[1]!.id,
        });
      }
      expect(await repo.getItem(items[0]!.id)).toEqual(items[0]);
    });

    it('re-runs no item that was run again in another batch: that one is re-run there', async () => {
      const { repo, facts, items } = await failedPair();
      const [, of] = items as [Item, Item];
      const reload = await repo.rerunItem({ ...rerunOf(of), force: false });
      if (!reload.ok) throw new Error(reload.reason);
      expect(await repo.retryItems(retryOf(items))).toEqual({
        ok: false,
        reason: 'running',
        itemId: of.id,
      });
      await facts.settleItem(reload.item.id, 'failed', null);
      expect(await repo.retryItems(retryOf(items))).toEqual({
        ok: false,
        reason: 'already_rerun',
        itemId: of.id,
      });
    });

    it('a reload of an item being re-run in place waits', async () => {
      const { repo, items } = await failedPair();
      const [of] = items as [Item, Item];
      expect((await repo.retryItems(retryOf([of]))).ok).toBe(true);
      const again = { ...rerunOf(of), force: false };
      expect(await repo.rerunItem(again)).toEqual({ ok: false, reason: 'running' });
      expect(await repo.getBatch(again.batchId)).toBeNull();
    });

    it('holds a rerun for review like one under way', async () => {
      const { repo, facts, item: of } = await finished();
      const first = await repo.rerunItem(rerunOf(of));
      if (!first.ok) throw new Error(first.reason);
      await facts.settleItem(first.item.id, 'awaiting_review', null);

      const second = rerunOf(of);
      expect(await repo.rerunItem(second)).toEqual({ ok: false, reason: 'running' });
      expect(await repo.getBatch(second.batchId)).toBeNull();
      expect(ItemSchema.parse(await repo.getItem(first.item.id)).outcome).toBe('awaiting_review');
      // Rejected is final: the item may be run again.
      await facts.settleItem(first.item.id, 'rejected', null);
      expect((await repo.rerunItem(rerunOf(of))).ok).toBe(true);
    });

    it('detaches no entry whose source awaits review', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const entryId = await facts.entry(changedSeed(a.sourceKey, batch.id));
      await facts.settleItem(a.id, 'awaiting_review', entryId);
      const detach = { itemId: a.id, entryId, targetIds: ['manuals'], by: ADA, detail: () => 'x' };

      expect(await repo.detachRegisterEntry(detach)).toEqual({ ok: false, reason: 'pending' });
      expect((await repo.registerEntry(entryId))?.state).toBe('changed');
      expect(await facts.actions(entryId)).toEqual([]);
    });

    /** A started, forced batch of one item held for review. */
    const held = async (force = true) => {
      const { repo, facts } = await make();
      const batch = await repo.createBatch({ targetId: 'manuals', force, createdBy: ADA });
      const a = item(batch.id, 'manuals/a.pdf');
      await repo.addItem(a);
      await repo.startBatch(batch.id, null);
      await facts.hold(a.id);
      return { repo, facts, batch, item: (await repo.getItem(a.id))! };
    };
    const REVIEWER = { name: 'Rae', userId: '5b9d2f60-7c1e-4a38-9f4d-0c6e1a2b3d44' };

    it('approves a held item: reviewer recorded, queued, one decompose job approved', async () => {
      const { repo, facts, item: a } = await held();

      const done = await repo.approveItem({ id: a.id, by: REVIEWER, note: 'looks right' });

      if (done.kind !== 'approved') throw new Error(done.kind);
      const after = ItemSchema.parse(await repo.getItem(a.id));
      expect(after).toMatchObject({
        outcome: 'queued',
        jobId: done.jobId,
        reviewedBy: { id: REVIEWER.userId, name: 'Rae' },
        reviewNote: 'looks right',
      });
      expect(after.reviewedAt).not.toBeNull();
      const job = await facts.job(done.jobId);
      expect(job).toEqual({
        task: 'decompose',
        priority: 0,
        maxAttempts: 3,
        // The held run's force (its batch's) is what the approved run delivers with.
        params: {
          batchId: a.batchId,
          itemId: a.id,
          targetId: 'manuals',
          sourceKey: a.sourceKey,
          force: true,
          approved: true,
        },
        createdBy: 'Rae',
        createdByUser: REVIEWER.userId,
      });
      DecomposeParamsSchema.parse(job!.params);
    });

    it('says an item is held only while it awaits review', async () => {
      const { repo, facts, item: a } = await held();
      expect(a).toMatchObject({ outcome: 'awaiting_review', held: true });

      const done = await repo.approveItem({ id: a.id, by: REVIEWER, note: null });

      if (done.kind !== 'approved') throw new Error(done.kind);
      expect(await repo.getItem(a.id)).toMatchObject({ outcome: 'queued', held: false });
      // The approved run delivered it (the worker then deletes the held files).
      await facts.settleItem(a.id, 'created', null);
      expect(await repo.getItem(a.id)).toMatchObject({ outcome: 'created', held: false });
    });

    it('approves with the batch not forced as not forced, and no note as none', async () => {
      const { repo, facts, item: a } = await held(false);

      const done = await repo.approveItem({ id: a.id, by: null, note: null });

      if (done.kind !== 'approved') throw new Error(done.kind);
      expect((await facts.job(done.jobId))!.params).toMatchObject({ force: false, approved: true });
      expect(await repo.getItem(a.id)).toMatchObject({
        reviewedBy: { id: null, name: null },
        reviewNote: null,
      });
    });

    it('approves a held item once: the second is refused and queues nothing', async () => {
      const { repo, facts, item: a } = await held();
      const first = await repo.approveItem({ id: a.id, by: REVIEWER, note: null });
      if (first.kind !== 'approved') throw new Error(first.kind);

      expect(await repo.approveItem({ id: a.id, by: REVIEWER, note: null })).toEqual({
        kind: 'not_awaiting',
      });
      expect(await repo.rejectItem({ id: a.id, by: REVIEWER, note: 'no' })).toEqual({
        kind: 'not_awaiting',
      });
      expect((await repo.getItem(a.id))!.jobId).toBe(first.jobId);
      expect(await facts.job(first.jobId)).not.toBeNull();
    });

    it('approves or rejects only an item awaiting review', async () => {
      const { repo, item: a } = await finished();

      expect(await repo.approveItem({ id: a.id, by: null, note: null })).toEqual({
        kind: 'not_awaiting',
      });
      expect(await repo.rejectItem({ id: a.id, by: null, note: 'no' })).toEqual({
        kind: 'not_awaiting',
      });
      expect(await repo.getItem(a.id)).toMatchObject({ outcome: 'created', reviewedBy: null });
      const missing = randomUUID();
      expect(await repo.approveItem({ id: missing, by: null, note: null })).toEqual({
        kind: 'not_found',
      });
      expect(await repo.rejectItem({ id: missing, by: null, note: 'no' })).toEqual({
        kind: 'not_found',
      });
    });

    it('rejects a held item: final, with who, when and the note, and no new job', async () => {
      const { repo, item: a } = await held();
      const before = (await repo.getItem(a.id))!.jobId;

      const done = await repo.rejectItem({ id: a.id, by: REVIEWER, note: 'a table is wrong' });

      if (done.kind !== 'rejected') throw new Error(done.kind);
      expect(ItemSchema.parse(done.item)).toMatchObject({
        outcome: 'rejected',
        reviewedBy: { id: REVIEWER.userId, name: 'Rae' },
        reviewNote: 'a table is wrong',
        jobId: before,
        // Its held files are deleted, and rejected is final: it finished now.
        held: false,
      });
      expect(done.item.reviewedAt).not.toBeNull();
      expect(done.item.finishedAt).toBe(done.item.reviewedAt);
      expect(await repo.getItem(a.id)).toEqual(done.item);
    });

    it('detaches an entry: a tombstone, recorded, and said on the item', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const entryId = await facts.entry(changedSeed(a.sourceKey, batch.id));
      await facts.settleItem(a.id, 'changed_in_target', entryId);
      const before = (await repo.registerEntry(entryId))!;

      const done = await repo.detachRegisterEntry({
        itemId: a.id,
        entryId,
        targetIds: ['manuals'],
        by: ADA,
        detail: (e) => `gone ${e.persistentId}`,
      });

      if (!done.ok) throw new Error(done.reason);
      expect(done.item).toMatchObject({ id: a.id, detail: 'gone doc-1', registerEntryId: entryId });
      expect(await repo.getItem(a.id)).toEqual(done.item);
      const actions = await facts.actions(entryId);
      expect(actions).toEqual([
        {
          id: expect.any(String),
          entryId,
          action: 'detach',
          by: ADA,
          at: expect.any(String),
          details: { persistentId: 'doc-1', sourceKey: a.sourceKey },
        },
      ]);
      expect(done.entry).toMatchObject({
        id: entryId,
        state: 'detached',
        persistentId: 'doc-1',
        detachActionId: actions[0]!.id,
      });
      expect(await repo.registerEntry(entryId)).toEqual(done.entry);
      // Later as `updatedAt` reads (to the millisecond): a preview from before is stale.
      expect(Date.parse(done.entry.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
      const again = { itemId: a.id, entryId, targetIds: ['manuals'], by: ADA, detail: () => 'x' };
      expect(await repo.detachRegisterEntry(again)).toEqual({ ok: false, reason: 'missing' });
      expect(await facts.actions(entryId)).toHaveLength(1);
    });

    it('detaches no pending entry, nor one whose source is being rerun', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const entryId = await facts.entry({
        ...changedSeed(a.sourceKey, batch.id),
        state: 'pending',
      });
      const detach = { itemId: a.id, entryId, targetIds: ['manuals'], by: ADA, detail: () => 'x' };
      expect(await repo.detachRegisterEntry(detach)).toEqual({ ok: false, reason: 'pending' });
      expect((await repo.registerEntry(entryId))?.state).toBe('pending');

      const other = await finished('manuals/b.docx');
      const changed = await other.facts.entry(changedSeed('manuals/b.docx', other.batch.id));
      const rerun = await other.repo.rerunItem(rerunOf(other.item));
      expect(rerun.ok).toBe(true);
      expect(
        await other.repo.detachRegisterEntry({
          ...detach,
          itemId: other.item.id,
          entryId: changed,
        }),
      ).toEqual({ ok: false, reason: 'pending' });
      expect((await other.repo.registerEntry(changed))?.state).toBe('changed');
      expect(await facts.actions(entryId)).toEqual([]);
    });

    it("accepts the target's state of a changed entry, and records who", async () => {
      const { repo, facts, batch, item: a } = await finished();
      const entryId = await facts.entry(changedSeed(a.sourceKey, batch.id));
      await facts.settleItem(a.id, 'changed_in_target', entryId);
      const seen = (await repo.registerEntry(entryId))!.updatedAt;
      const accept = (over: { entryId?: string; seen?: string } = {}) =>
        repo.acceptTargetState({
          itemId: a.id,
          entryId,
          seen,
          by: ADA,
          plan: acceptPlanOf,
          detail: () => 'ok',
          ...over,
        });

      const done = await accept();

      if (!done.ok) throw new Error(done.reason);
      expect(done.changed).toEqual(CHANGED);
      expect(done.item).toMatchObject({ id: a.id, detail: 'ok' });
      const entry = (await repo.registerEntry(entryId))!;
      expect(entry).toMatchObject({ state: 'accepted', lastError: null, persistentId: 'doc-1' });
      expect(entry.lastReceipt).toEqual({
        ...RECEIPT,
        document: {
          ...RECEIPT.document!,
          components: [
            { kind: 'map', id: 'doc-1/map', version: '1', element: null },
            { kind: 'section', id: 'doc-1/section/s1', version: '2', element: 's1' },
          ],
        },
      });
      expect(await facts.actions(entryId)).toEqual([
        {
          id: expect.any(String),
          entryId,
          action: 'accept',
          by: ADA,
          at: expect.any(String),
          details: { changed: CHANGED },
        },
      ]);
      // The entry moved on: the same preview is stale now, and the current one isn't changed.
      expect(await accept()).toEqual({ ok: false, reason: 'stale' });
      expect(await accept({ seen: entry.updatedAt })).toMatchObject({
        ok: false,
        reason: 'not_acceptable',
      });
      expect(await facts.actions(entryId)).toHaveLength(1);
      expect(await accept({ entryId: randomUUID() })).toEqual({ ok: false, reason: 'missing' });
    });

    /** A later moment than any written so far (both repos keep times to the millisecond). */
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

    /** Another started batch holding `sourceKey`, started now; its item. */
    const startedAgain = async (repo: ConversionRepo, sourceKey: string) => {
      const later = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
      const b = item(later.id, sourceKey);
      await repo.addItem(b);
      await repo.startBatch(later.id, null);
      return b;
    };

    it('every item on an entry says how it was resolved', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const entryId = await facts.entry(changedSeed(a.sourceKey, batch.id));
      await facts.settleItem(a.id, 'changed_in_target', entryId);
      await tick();
      // A later batch the register check refused at once, from the same refusal.
      const b = await startedAgain(repo, a.sourceKey);
      await facts.settleItem(b.id, 'changed_in_target', entryId);
      const unlinked = await startedAgain(repo, 'manuals/other.docx');
      const resolutions = async () => [
        (await repo.getItem(a.id))?.resolution,
        (await repo.listItems(b.batchId)).map((i) => i.resolution),
        (await repo.getItem(unlinked.id))?.resolution,
      ];
      expect(await resolutions()).toEqual([null, [null], null]);

      const seen = (await repo.registerEntry(entryId))!.updatedAt;
      const accepted = await repo.acceptTargetState({
        itemId: a.id,
        entryId,
        seen,
        by: ADA,
        plan: acceptPlanOf,
        detail: () => 'ok',
      });
      if (!accepted.ok) throw new Error(accepted.reason);
      expect(ItemSchema.parse(accepted.item).resolution).toBe('accepted');
      expect(await resolutions()).toEqual(['accepted', ['accepted'], null]);
    });

    it('every item on a detached entry says so, and still once a create replaced it', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const entryId = await facts.entry(changedSeed(a.sourceKey, batch.id));
      await facts.settleItem(a.id, 'changed_in_target', entryId);
      const created = await startedAgain(repo, 'manuals/kept.docx');
      await facts.settleItem(created.id, 'created', entryId); // an earlier delivery's item

      const detached = await repo.detachRegisterEntry({
        itemId: a.id,
        entryId,
        targetIds: ['manuals'],
        by: ADA,
        detail: () => 'gone',
      });
      if (!detached.ok) throw new Error(detached.reason);
      expect(ItemSchema.parse(detached.item).resolution).toBe('detached');
      expect((await repo.getItem(created.id))?.resolution).toBe('detached');

      // The next create of the source replaces the tombstone: the items stay detached.
      await facts.dropEntry(entryId);
      expect((await repo.getItem(a.id))?.resolution).toBe('detached');
    });

    it('a refusal a later run moved on from is superseded', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const entryId = await facts.entry(changedSeed(a.sourceKey, batch.id));
      await facts.settleItem(a.id, 'changed_in_target', entryId);
      const resolution = async (id: string) => (await repo.getItem(id))?.resolution;
      expect(await resolution(a.id)).toBeNull();

      // A later run delivers (pending, then delivered): the old refusal is no longer the entry's.
      await tick();
      const b = await startedAgain(repo, a.sourceKey);
      await facts.moveEntry(entryId, { state: 'pending', batchId: b.batchId });
      expect(await resolution(a.id)).toBe('superseded');
      await facts.moveEntry(entryId, { state: 'delivered', batchId: b.batchId });
      expect(await resolution(a.id)).toBe('superseded');
      await facts.settleItem(b.id, 'updated', entryId);
      expect(await resolution(b.id)).toBeNull(); // only a refused item is superseded

      // Refused again, from a newer delivery: that refusal is the newer item's, not the old one's.
      await tick();
      const c = await startedAgain(repo, a.sourceKey);
      await facts.moveEntry(entryId, { state: 'changed', batchId: c.batchId });
      await facts.settleItem(c.id, 'changed_in_target', entryId);
      expect([await resolution(a.id), await resolution(c.id)]).toEqual(['superseded', null]);
    });

    it('detaches only a document refused as changed in the target', async () => {
      const { repo, facts, batch, item: a } = await finished();
      for (const state of ['delivered', 'accepted', 'incomplete', 'failed'] as const) {
        const entryId = await facts.entry({ ...changedSeed(a.sourceKey, batch.id), state });
        await facts.settleItem(a.id, 'changed_in_target', entryId);
        const before = await repo.registerEntry(entryId);
        expect(
          await repo.detachRegisterEntry({
            itemId: a.id,
            entryId,
            targetIds: ['manuals'],
            by: ADA,
            detail: () => 'x',
          }),
        ).toEqual({ ok: false, reason: 'not_refused' });
        expect(await repo.registerEntry(entryId)).toEqual(before);
        expect(await facts.actions(entryId)).toEqual([]);
        await facts.dropEntry(entryId);
      }
    });

    it('detaches a document whose versions were never recorded, from any settled state', async () => {
      const { repo, facts, batch, item: a } = await finished();
      for (const state of ['delivered', 'incomplete', 'failed'] as const) {
        for (const lastReceipt of [
          null,
          { ...RECEIPT, document: { ...RECEIPT.document!, components: [] } },
        ]) {
          const entryId = await facts.entry({
            ...changedSeed(a.sourceKey, batch.id),
            state,
            lastReceipt,
            lastError: null,
          });
          await facts.settleItem(a.id, 'unresolved', entryId);
          expect(ItemSchema.parse(await repo.getItem(a.id))).toMatchObject({
            unversioned: true,
            resolution: null,
          });

          const detached = await repo.detachRegisterEntry({
            itemId: a.id,
            entryId,
            targetIds: ['manuals'],
            by: ADA,
            detail: () => 'gone',
          });

          if (!detached.ok) throw new Error(`${state}: ${detached.reason}`);
          expect(detached.entry.state).toBe('detached');
          expect(ItemSchema.parse(detached.item)).toMatchObject({
            resolution: 'detached',
            unversioned: false,
          });
          await facts.dropEntry(entryId);
        }
      }
    });

    it('an entry with versions, or with no document, is not unversioned', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const unversioned = async () => (await repo.getItem(a.id))?.unversioned;
      expect(await unversioned()).toBe(false); // no entry
      const live = await facts.entry({ ...changedSeed(a.sourceKey, batch.id), state: 'delivered' });
      await facts.settleItem(a.id, 'unresolved', live);
      expect(await unversioned()).toBe(false);
      await facts.dropEntry(live);
      const never = await facts.entry({
        ...changedSeed(a.sourceKey, batch.id),
        state: 'failed',
        persistentId: null,
        lastReceipt: null,
        lastError: null,
      });
      await facts.settleItem(a.id, 'unresolved', never);
      expect(await unversioned()).toBe(false);
      expect(
        await repo.detachRegisterEntry({
          itemId: a.id,
          entryId: never,
          targetIds: ['manuals'],
          by: ADA,
          detail: () => 'x',
        }),
      ).toEqual({ ok: false, reason: 'not_refused' });
    });

    it('detaches a create the target may have taken, so the next run creates under a new key', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const entryId = await facts.entry({
        ...changedSeed(a.sourceKey, batch.id),
        state: 'failed',
        persistentId: null,
        lastReceipt: null,
        lastError: bridgeError('content_rejected', 'an earlier delivery stopped part-way'),
      });
      await facts.settleItem(a.id, 'failed', entryId);
      expect(ItemSchema.parse(await repo.getItem(a.id))).toMatchObject({
        unconfirmed: true,
        unversioned: false,
        gone: false,
        resolution: null,
      });
      expect((await repo.listItems(batch.id))[0]?.unconfirmed).toBe(true);

      const detached = await repo.detachRegisterEntry({
        itemId: a.id,
        entryId,
        targetIds: ['manuals'],
        by: ADA,
        detail: () => 'detached',
      });

      if (!detached.ok) throw new Error(detached.reason);
      expect(detached.entry.state).toBe('detached');
      expect(ItemSchema.parse(detached.item)).toMatchObject({
        resolution: 'detached',
        unconfirmed: false,
        partWay: false,
      });
      expect(await facts.actions(entryId)).toMatchObject([
        { action: 'detach', details: { persistentId: null, sourceKey: a.sourceKey } },
      ]);
    });

    it('detaches a document the sink refused as part-way, create or update, and no other refusal', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const partWay = bridgeError('content_rejected', 'an earlier delivery stopped part-way', {
        reason: 'delivery_part_way',
        repositoryId: 'R1',
      });
      // Not part-way: another content_rejected, the marker on another code, or not failed.
      for (const seed of [
        { state: 'failed', lastError: bridgeError('content_rejected', 'no', { reason: 'other' }) },
        {
          state: 'failed',
          lastError: bridgeError('not_found', 'no', { reason: 'delivery_part_way' }),
        },
        { state: 'pending', lastError: partWay },
      ] as const) {
        const other = await facts.entry({
          ...changedSeed(`${a.sourceKey}#${JSON.stringify(seed)}`, batch.id),
          persistentId: 'doc-1',
          ...seed,
        });
        await facts.settleItem(a.id, 'failed', other);
        expect((await repo.getItem(a.id))?.partWay, JSON.stringify(seed)).toBe(false);
      }

      // An update: the entry has its document and its versions, so nothing else frees it.
      const entryId = await facts.entry({
        ...changedSeed(a.sourceKey, batch.id),
        state: 'failed',
        persistentId: 'doc-1',
        lastError: partWay,
      });
      await facts.settleItem(a.id, 'failed', entryId);
      expect(ItemSchema.parse(await repo.getItem(a.id))).toMatchObject({
        partWay: true,
        unconfirmed: false,
        unversioned: false,
        gone: false,
        resolution: null,
      });
      expect((await repo.listItems(batch.id))[0]?.partWay).toBe(true);

      const detached = await repo.detachRegisterEntry({
        itemId: a.id,
        entryId,
        targetIds: ['manuals'],
        by: ADA,
        detail: () => 'detached',
      });

      if (!detached.ok) throw new Error(detached.reason);
      expect(detached.entry.state).toBe('detached');
      expect(ItemSchema.parse(detached.item)).toMatchObject({
        resolution: 'detached',
        partWay: false,
      });
      expect(await facts.actions(entryId)).toMatchObject([
        { action: 'detach', details: { persistentId: 'doc-1', sourceKey: a.sourceKey } },
      ]);
    });

    it("a refused or failed item carries its entry's error links; any other state none", async () => {
      const { repo, facts, batch, item: a } = await finished();
      const links = [
        { label: 'Open the document', url: 'https://t.test/doc' },
        { label: 'Open the locked topic', url: 'https://t.test/topic' },
      ];
      const lastError = bridgeError('changed_in_target', 'locked', {
        links: [...links, { label: 'bad', url: 'javascript:x' }],
      });
      expect((await repo.getItem(a.id))?.links).toEqual([]); // no entry
      for (const [state, expected] of [
        ['changed', links],
        ['failed', links],
        ['delivered', []],
        ['pending', []],
      ] as const) {
        const entryId = await facts.entry({
          ...changedSeed(`${a.sourceKey}#${state}`, batch.id),
          state,
          lastError,
        });
        await facts.settleItem(a.id, 'changed_in_target', entryId);
        expect(ItemSchema.parse(await repo.getItem(a.id)).links, state).toEqual(expected);
        expect((await repo.listItems(batch.id))[0]?.links, state).toEqual(expected);
      }
    });

    it('a create refused before acceptance, with a document, or with no error, is not unconfirmed', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const unconfirmed = async () => (await repo.getItem(a.id))?.unconfirmed;
      expect(await unconfirmed()).toBe(false); // no entry
      const partWay = bridgeError('content_rejected', 'stopped part-way');
      for (const seed of [
        // Refused outright: the worker's next run creates under a new key by itself.
        {
          state: 'failed',
          persistentId: null,
          lastError: bridgeError('content_rejected', 'no', { refusedBeforeAcceptance: true }),
        },
        { state: 'failed', persistentId: null, lastError: null },
        { state: 'pending', persistentId: null, lastError: partWay },
        { state: 'failed', persistentId: 'doc-1', lastError: partWay },
      ] as const) {
        const other = await facts.entry({
          ...changedSeed(a.sourceKey, batch.id),
          lastReceipt: null,
          ...seed,
        });
        await facts.settleItem(a.id, 'failed', other);
        expect(await unconfirmed(), JSON.stringify(seed)).toBe(false);
        if (seed.state !== 'pending') {
          expect(
            await repo.detachRegisterEntry({
              itemId: a.id,
              entryId: other,
              targetIds: ['manuals'],
              by: ADA,
              detail: () => 'x',
            }),
            JSON.stringify(seed),
          ).toMatchObject({ ok: seed.persistentId !== null });
        }
        await facts.dropEntry(other);
      }
    });

    it('an entry the target refused with its missing-document marker is gone', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const gone = async () => (await repo.getItem(a.id))?.gone;
      expect(await gone()).toBe(false); // no entry
      const notFound = documentMissing('doc-1', 'no map doc-1 for this update to replace');
      const entryId = await facts.entry({
        ...changedSeed(a.sourceKey, batch.id),
        state: 'failed',
        lastError: notFound,
      });
      await facts.settleItem(a.id, 'unresolved', entryId);
      expect(ItemSchema.parse(await repo.getItem(a.id))).toMatchObject({
        gone: true,
        unversioned: false,
        resolution: null,
      });
      expect((await repo.listItems(batch.id))[0]?.gone).toBe(true);
      await facts.dropEntry(entryId);

      // Not gone: a not_found without the marker (a lost delivery, no route, no sink job), the
      // marker naming another document, another failure, a refusal as changed, or no document.
      for (const seed of [
        { state: 'failed', lastError: bridgeError('not_found', 'no map doc-1 for this update') },
        {
          state: 'failed',
          lastError: bridgeError('not_found', 'the bridge has no record of this delivery'),
        },
        { state: 'failed', lastError: documentMissing('doc-2', 'no map doc-2') },
        { state: 'failed', lastError: bridgeError('content_rejected', 'no') },
        { state: 'changed', lastError: notFound },
        { state: 'delivered', lastError: notFound },
        { state: 'failed', lastError: notFound, persistentId: null },
      ] as const) {
        const other = await facts.entry({ ...changedSeed(a.sourceKey, batch.id), ...seed });
        await facts.settleItem(a.id, 'failed', other);
        expect(await gone(), JSON.stringify(seed)).toBe(false);
        await facts.dropEntry(other);
      }
    });

    it('detaches a document gone from the target, recording why', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const entryId = await facts.entry({
        ...changedSeed(a.sourceKey, batch.id),
        state: 'failed',
        lastError: documentMissing('doc-1', 'no map doc-1 for this update to replace'),
      });
      await facts.settleItem(a.id, 'unresolved', entryId);

      const detached = await repo.detachRegisterEntry({
        itemId: a.id,
        entryId,
        targetIds: ['manuals'],
        by: ADA,
        reason: 'gone',
        detail: () => 'detached',
      });

      if (!detached.ok) throw new Error(detached.reason);
      expect(detached.entry.state).toBe('detached');
      expect(ItemSchema.parse(detached.item)).toMatchObject({
        resolution: 'detached',
        gone: false,
      });
      expect((await facts.actions(entryId))[0]?.details).toEqual({
        persistentId: 'doc-1',
        sourceKey: a.sourceKey,
        reason: 'gone',
      });
    });

    it('an item is reloadable while its entry is gone or still a detached tombstone', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const reloadable = async () => ItemSchema.parse(await repo.getItem(a.id)).reloadable;
      expect(await reloadable()).toBe(false); // no entry
      const entryId = await facts.entry({
        ...changedSeed(a.sourceKey, batch.id),
        state: 'failed',
        lastError: documentMissing('doc-1', 'no map doc-1'),
      });
      await facts.settleItem(a.id, 'unresolved', entryId);
      expect(await reloadable()).toBe(true);
      const detached = await repo.detachRegisterEntry({
        itemId: a.id,
        entryId,
        targetIds: ['manuals'],
        by: ADA,
        reason: 'gone',
        detail: () => 'detached',
      });
      expect(detached.ok).toBe(true);
      expect(await reloadable()).toBe(true); // still the tombstone
      // A later create replaced the tombstone: detached, but no longer reloadable.
      await facts.dropEntry(entryId);
      expect((await repo.getItem(a.id))?.resolution).toBe('detached');
      expect(await reloadable()).toBe(false);

      // A refusal a later run moved on from (superseded) is not reloadable, even when gone.
      const later = await facts.entry({
        ...changedSeed(a.sourceKey, batch.id),
        state: 'failed',
        lastError: documentMissing('doc-1', 'no map doc-1'),
      });
      await facts.settleItem(a.id, 'changed_in_target', later);
      expect(ItemSchema.parse(await repo.getItem(a.id))).toMatchObject({
        gone: true,
        resolution: 'superseded',
        reloadable: false,
      });
      // A live entry is not reloadable either.
      await facts.dropEntry(later);
      const live = await facts.entry({ ...changedSeed(a.sourceKey, batch.id), state: 'delivered' });
      await facts.settleItem(a.id, 'created', live);
      expect(await reloadable()).toBe(false);
    });

    it('a rerun that needs a detached tombstone checks it with the batch insert', async () => {
      const { repo, facts, batch, item: of } = await finished();
      const entryId = await facts.entry({
        ...changedSeed(of.sourceKey, batch.id),
        state: 'failed',
        lastError: documentMissing('doc-1', 'no map doc-1'),
      });
      const asked = { ...rerunOf(of), force: false, whileDetached: entryId };
      // Not detached: refused, and nothing is written.
      expect(await repo.rerunItem(asked)).toEqual({ ok: false, reason: 'not_detached' });
      expect(await repo.getBatch(asked.batchId)).toBeNull();
      await repo.detachRegisterEntry({
        itemId: of.id,
        entryId,
        targetIds: ['manuals'],
        by: ADA,
        detail: () => 'detached',
      });
      const done = await repo.rerunItem({ ...asked, ...rerunOf(of), force: false });
      expect(done.ok).toBe(true);
      // Gone (a create replaced the tombstone): refused.
      await facts.settleItem(done.ok ? done.item.id : '', 'created', null);
      await facts.dropEntry(entryId);
      expect(
        await repo.rerunItem({ ...rerunOf(of), force: false, whileDetached: entryId }),
      ).toEqual({ ok: false, reason: 'not_detached' });
    });

    it('reruns an item unforced when asked, as a plain create', async () => {
      const { repo, facts, item: of } = await finished();
      const done = await repo.rerunItem({ ...rerunOf(of), force: false });
      if (!done.ok) throw new Error(done.reason);
      expect(done.batch.force).toBe(false);
      expect(done.item.redeliverOf).toBe(of.id);
      expect((await facts.job(done.item.jobId!))?.params).toMatchObject({ force: false });
      // The same guard: a second rerun while it is unfinished is refused.
      expect(await repo.rerunItem({ ...rerunOf(of), force: false })).toEqual({
        ok: false,
        reason: 'running',
      });
    });

    it('accepts nothing from a preview the entry has moved on from', async () => {
      const { repo, facts, batch, item: a } = await finished();
      const entryId = await facts.entry(changedSeed(a.sourceKey, batch.id));
      const before = (await repo.registerEntry(entryId))!;

      const stale = await repo.acceptTargetState({
        itemId: a.id,
        entryId,
        seen: new Date(Date.parse(before.updatedAt) - 1000).toISOString(),
        by: ADA,
        plan: acceptPlanOf,
        detail: () => 'ok',
      });

      expect(stale).toEqual({ ok: false, reason: 'stale' });
      expect(await repo.registerEntry(entryId)).toEqual(before);
      expect(await facts.actions(entryId)).toEqual([]);
    });
  });
}
