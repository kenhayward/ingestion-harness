import { randomUUID } from 'node:crypto';
import { BatchSchema, BatchSummarySchema, DecomposeParamsSchema, ItemSchema } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import type { ConversionRepo, NewItem } from '../src/conversions/repo.js';

/** A queued job as the repo wrote it (the jobs table, or MemoryRepo's background jobs). */
export interface QueuedJob {
  task: string;
  priority: number;
  maxAttempts: number;
  params: unknown;
  createdBy: string | null;
  createdByUser: string | null;
}

export interface ConversionFacts {
  job(id: string): Promise<QueuedJob | null>;
}

const ADA = { id: '7a1f3c52-1b2e-4c3d-8e4f-5a6b7c8d9e0f', name: 'Ada' };

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
      });
      expect(await repo.getItem(a.id)).toEqual(items[0]);
      expect(await repo.getItem(randomUUID())).toBeNull();
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
  });
}
