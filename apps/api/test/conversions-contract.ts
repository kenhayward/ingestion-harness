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
  /** The register actions recorded on an entry, oldest first. */
  actions(entryId: string): Promise<RegisterAction[]>;
  /** Removes an entry, as the worker does when a create replaces a detached tombstone. */
  dropEntry(entryId: string): Promise<void>;
  /** Moves an entry on, as a later run does (its state and batch, and its `updatedAt` to now). */
  moveEntry(entryId: string, to: { state: RegisterEntry['state']; batchId: string }): Promise<void>;
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
        reloadable: false,
        startedAt: null,
        finishedAt: null,
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
      expect(Object.keys(listed[1]!.counts)).toHaveLength(12);
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
        reloadable: false,
        startedAt: null,
        finishedAt: null,
      });
      expect(await repo.listItems(batchId)).toEqual([rerun]);
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
