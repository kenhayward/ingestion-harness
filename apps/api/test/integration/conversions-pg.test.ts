/**
 * Opt-in Postgres test of conversion batches (decomposition phase 3, migration
 * 202610251200_decomposition_batches): the repo contract, the outcome check, and that `decompose`
 * jobs stay out of the Jobs list. Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY
 * database (it applies db/migrations and deletes batches, items and decompose jobs).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bridgeError, documentMissing, type BridgeEvent } from '@ih/bridge-contract';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { applyEvent } from '../../src/bridge/events.js';
import { migrate } from '../../src/db/migrate.js';
import { MemoryPublishTargetRepo } from '../../src/publish-targets/repo.js';
import { PgRepo } from '../../src/repositories/pg.js';
import { DOCX_MIME, GONE_DETAIL } from '@ih/shared';
import type { RegisterAction } from '../../src/conversions/repo.js';
import type { RegisterEntry } from '../../src/repositories/types.js';
import { conversionsContract, type EntrySeed } from '../conversions-contract.js';
import { docx } from '../docx-fixtures.js';
import { FAKE_DOCUMENT_SINK } from '../fake-sink.js';
import { multipart, testApp } from '../helpers.js';

const url = process.env.IH_TEST_DATABASE_URL;
/** The sink the contract's register entries are seeded on (and cleared from). */
const CONTRACT_SINK = 'conversions-contract';
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('conversion batches against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool | undefined;
  let repo: PgRepo | undefined;
  /**
   * A connection or a lock that never comes fails the test with that reason instead of a silent
   * 30 s timeout (a statement waiting on a lock held by another session, or a connect that the
   * host's port forwarding never completes).
   */
  const poolOptions = {
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 5_000,
    options: '-c lock_timeout=5000',
  };

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool(poolOptions);
    repo = new PgRepo(new pg.Pool(poolOptions));
  });

  /** Items hold their jobs: other tests' `DELETE FROM jobs` needs them gone first. */
  const clear = async (p: pg.Pool) => {
    // A detached entry is gone, so its actions are found by nothing but the table itself.
    await p.query('DELETE FROM register_actions');
    await p.query(`DELETE FROM decomposition_register WHERE sink_id = '${CONTRACT_SINK}'`);
    await p.query('DELETE FROM decomposition_items');
    await p.query('DELETE FROM decomposition_batches');
    await p.query(`DELETE FROM job_events WHERE job_id IN
                     (SELECT id FROM jobs WHERE task = 'decompose')`);
    await p.query(`DELETE FROM jobs WHERE task = 'decompose'`);
  };

  const make = async () => {
    const p = pool!;
    await clear(p);
    return {
      repo: repo!,
      p,
      facts: {
        job: async (id: string) => {
          const { rows } = await p.query<{
            task: string;
            priority: number;
            max_attempts: number;
            params: unknown;
            created_by: string | null;
            created_by_user: string | null;
          }>(
            `SELECT task, priority, max_attempts, params, created_by, created_by_user
               FROM jobs WHERE id = $1`,
            [id],
          );
          const r = rows[0];
          return r
            ? {
                task: r.task,
                priority: r.priority,
                maxAttempts: r.max_attempts,
                params: r.params,
                createdBy: r.created_by,
                createdByUser: r.created_by_user,
              }
            : null;
        },
        entry: async (seed: EntrySeed) => {
          const { rows } = await p.query<{ id: string }>(
            `INSERT INTO decomposition_register
               (sink_id, instance_id, source_key, content_sha256, persistent_id, state,
                idempotency_key, last_receipt, last_error, batch_id)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id::text`,
            [
              CONTRACT_SINK,
              seed.sourceKey,
              'a'.repeat(64),
              seed.persistentId,
              seed.state,
              'k'.repeat(64),
              seed.lastReceipt === null ? null : JSON.stringify(seed.lastReceipt),
              seed.lastError === null ? null : JSON.stringify(seed.lastError),
              seed.batchId,
            ],
          );
          return rows[0]!.id;
        },
        settleItem: async (itemId: string, outcome: string, entryId: string | null) => {
          await p.query(
            `UPDATE decomposition_items SET outcome = $2, register_entry_id = $3 WHERE id = $1`,
            [itemId, outcome, entryId],
          );
        },
        hold: async (itemId: string) => {
          await p.query(
            `UPDATE decomposition_items
                SET outcome = 'awaiting_review', held_sha256 = repeat('a', 64)
              WHERE id = $1`,
            [itemId],
          );
        },
        times: async (itemId: string, startedAt: string | null, finishedAt: string | null) => {
          await p.query(
            `UPDATE decomposition_items SET started_at = $2, finished_at = $3 WHERE id = $1`,
            [itemId, startedAt, finishedAt],
          );
        },
        dropEntry: async (entryId: string) => {
          await p.query('DELETE FROM decomposition_register WHERE id = $1', [entryId]);
        },
        moveEntry: async (
          entryId: string,
          to: { state: RegisterEntry['state']; batchId: string },
        ) => {
          await p.query(
            `UPDATE decomposition_register SET state = $2, batch_id = $3, updated_at = now()
              WHERE id = $1`,
            [entryId, to.state, to.batchId],
          );
        },
        actions: async (entryId: string): Promise<RegisterAction[]> => {
          const { rows } = await p.query<{
            id: string;
            entry_id: string;
            action: RegisterAction['action'];
            by: RegisterAction['by'];
            at: Date;
            details: RegisterAction['details'];
          }>(
            `SELECT id::text, entry_id::text, action, by, at, details FROM register_actions
              WHERE entry_id = $1 ORDER BY at, id`,
            [entryId],
          );
          return rows.map(
            (r) =>
              ({
                id: r.id,
                entryId: r.entry_id,
                action: r.action,
                by: r.by,
                at: r.at.toISOString(),
                details: r.details,
              }) as RegisterAction,
          );
        },
      },
    };
  };

  afterAll(async () => {
    if (pool) await clear(pool);
    await pool?.end();
    await repo?.close();
  });

  conversionsContract('pg', make);

  it('a detach waits for a worker holding the entry, and leaves it once it is pending', async () => {
    const { repo, p, facts } = await make();
    const by = { id: null, name: 'Ada' };
    const batch = await repo.createBatch({ targetId: 'manuals', force: false, createdBy: by });
    const id = randomUUID();
    await repo.addItem({
      id,
      batchId: batch.id,
      sourceKey: 'a.docx',
      filename: 'a.docx',
      contentSha256: 'a'.repeat(64),
      sizeBytes: 1,
      objectKey: `decompositions/${batch.id}/${id}.docx`,
    });
    const entryId = await facts.entry({
      sourceKey: 'a.docx',
      state: 'delivered',
      persistentId: 'doc-1',
      lastReceipt: null,
      lastError: null,
      batchId: batch.id,
    });
    // The item has its outcome: only the worker's lock can hold the detach off.
    await facts.settleItem(id, 'created', entryId);
    // The worker's next run locks the entry (`by_key`), decides, and writes it pending.
    const worker = await p.connect();
    try {
      await worker.query('BEGIN');
      await worker.query('SELECT 1 FROM decomposition_register WHERE id = $1 FOR UPDATE', [
        entryId,
      ]);
      const detaching = repo.detachRegisterEntry({
        itemId: id,
        entryId,
        targetIds: ['manuals'],
        by,
        detail: () => 'detached',
      });
      await new Promise((r) => setTimeout(r, 200));
      await worker.query(`UPDATE decomposition_register SET state = 'pending' WHERE id = $1`, [
        entryId,
      ]);
      await worker.query('COMMIT');
      expect(await detaching).toEqual({ ok: false, reason: 'pending' });
    } finally {
      worker.release();
    }
    expect((await repo.registerEntry(entryId))?.state).toBe('pending');
    expect(await facts.actions(entryId)).toEqual([]);
    expect((await repo.getItem(id))?.detail).toBeNull();
  });

  it("indexes items by source key for detach's running check", async () => {
    const { p } = await make();
    const { rows } = await p.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'decomposition_items'`,
    );
    expect(rows.map((r) => r.indexdef)).toContainEqual(expect.stringMatching(/\(source_key\)$/));
  });

  it('refuses an item outcome outside the fifteen', async () => {
    const { repo, p } = await make();
    const batch = await repo.createBatch({
      targetId: 'manuals',
      force: false,
      createdBy: { id: null, name: null },
    });
    const id = randomUUID();
    await repo.addItem({
      id,
      batchId: batch.id,
      sourceKey: 'a.docx',
      filename: 'a.docx',
      contentSha256: 'a'.repeat(64),
      sizeBytes: 1,
      objectKey: `decompositions/${batch.id}/${id}.docx`,
    });
    await expect(
      p.query(`UPDATE decomposition_items SET outcome = 'loaded' WHERE id = $1`, [id]),
    ).rejects.toThrow(/decomposition_items_outcome_check/);
    await p.query(`UPDATE decomposition_items SET outcome = 'read_back_mismatch' WHERE id = $1`, [
      id,
    ]);
    expect((await repo.getItem(id))?.outcome).toBe('read_back_mismatch');
    await p.query(`UPDATE decomposition_items SET outcome = 'waiting_to_deliver' WHERE id = $1`, [
      id,
    ]);
    expect((await repo.getItem(id))?.outcome).toBe('waiting_to_deliver');
  });

  it('adds the lane columns and indexes the items holding or waiting for a lane', async () => {
    const { p } = await make();
    const { rows: cols } = await p.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name, column_name) IN (('decomposition_items', 'lane_claimed_at'),
                                            ('decomposition_batches', 'last_lane_at'),
                                            ('publish_targets', 'lanes'))`,
    );
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual([
      'decomposition_batches.last_lane_at',
      'decomposition_items.lane_claimed_at',
      'publish_targets.lanes',
    ]);
    const { rows } = await p.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'decomposition_items'`,
    );
    expect(rows.map((r) => r.indexdef)).toContainEqual(
      // Covers the lane count: every outcome that holds a lane, and the claim column.
      expect.stringMatching(
        /decomposition_items_lane_idx .*\(outcome, lane_claimed_at, batch_id\) WHERE .*decomposing.*waiting_to_deliver.*delivering/,
      ),
    );
    const { rows: checks } = await p.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'publish_targets'::regclass AND contype = 'c'`,
    );
    expect(checks.map((c) => c.def)).toContainEqual(
      expect.stringMatching(/lanes >= 1.*lanes <= 64/),
    );
  });

  it('keeps decompose jobs out of the Jobs list and the queue counts', async () => {
    const { repo, p } = await make();
    const before = await repo.queueStats();
    const allBefore = (await repo.jobPage({ size: 100 })).counts.all;
    const batch = await repo.createBatch({
      targetId: 'manuals',
      force: false,
      createdBy: { id: null, name: 'Ada' },
    });
    const id = randomUUID();
    await repo.addItem({
      id,
      batchId: batch.id,
      sourceKey: 'a.docx',
      filename: 'a.docx',
      contentSha256: 'a'.repeat(64),
      sizeBytes: 1,
      objectKey: `decompositions/${batch.id}/${id}.docx`,
    });
    const started = await repo.startBatch(batch.id, { name: 'Ada', userId: null });
    if (!started.ok) throw new Error(started.reason);
    const listed = await repo.listJobs({ limit: 500 });
    expect(listed.map((j) => j.id)).not.toContain(started.jobIds[0]);
    const page = await repo.jobPage({ size: 100 });
    expect(page.jobs.map((j) => j.id)).not.toContain(started.jobIds[0]);
    expect(page.counts.all).toBe(allBefore);
    expect((await repo.queueStats()).queued).toBe(before.queued);
    const { rows } = await p.query<{ document_id: string | null }>(
      'SELECT document_id FROM jobs WHERE id = $1',
      [started.jobIds[0]],
    );
    expect(rows[0]?.document_id).toBeNull();
  });

  /**
   * A started one-item batch whose job handed the document to the bridge: the entry pending with
   * its delivery, the job delivering with it, and the item still `decomposing` (the worker records
   * `delivering` after the bridge answers, so the event may come first).
   */
  async function handedOff(over: { persistentId?: string | null } = {}) {
    const { repo, p } = await make();
    const inserted = await p.query(
      `INSERT INTO publish_targets (id, label, kind, sink_id, connection_id, destination)
       VALUES ('manuals', 'Manuals', 'sink', 'docs', 'manuals-keys', '{"space": "lib"}')
       ON CONFLICT (id) DO NOTHING`,
    );
    const batch = await repo.createBatch({
      targetId: 'manuals',
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
      sizeBytes: 1,
      objectKey: `decompositions/${batch.id}/${itemId}.docx`,
    });
    const started = await repo.startBatch(batch.id, null);
    if (!started.ok) throw new Error(started.reason);
    const jobId = started.jobIds[0]!;
    const deliveryId = randomUUID();
    const sinkId = `sink-${randomUUID()}`;
    const entry = await p.query<{ id: string }>(
      `INSERT INTO decomposition_register
         (sink_id, instance_id, source_key, content_sha256, persistent_id, state,
          idempotency_key, delivery_id, batch_id)
       VALUES ($1, 'tenant-1', 'reports/r1.docx', $2, $3, 'pending', $4, $5, $6)
       RETURNING id::text`,
      [sinkId, 'a'.repeat(64), over.persistentId ?? null, 'k'.repeat(64), deliveryId, batch.id],
    );
    onTestFinished(async () => {
      await p.query('DELETE FROM job_deliveries WHERE delivery_id = $1', [deliveryId]);
      await p.query('DELETE FROM decomposition_register WHERE sink_id = $1', [sinkId]);
      if (inserted.rowCount) await p.query(`DELETE FROM publish_targets WHERE id = 'manuals'`);
    });
    await p.query(`UPDATE jobs SET status = 'delivering' WHERE id = $1`, [jobId]);
    await p.query(`UPDATE decomposition_items SET outcome = 'decomposing' WHERE id = $1`, [itemId]);
    await repo.recordDeliveries(jobId, [{ targetId: 'manuals', deliveryId }]);
    const deps = { repo, targets: new MemoryPublishTargetRepo() };
    const event = (o: Partial<BridgeEvent> = {}): BridgeEvent => ({
      eventId: randomUUID(),
      deliveryId,
      sequence: 1,
      status: 'succeeded',
      error: null,
      receipt: {
        written: [{ kind: 'document', id: 'doc-1', label: null, url: 'https://docs.test/doc-1' }],
        document: {
          persistentId: 'doc-1',
          components: [{ kind: 'section', element: 's1', id: 'c1', version: '1' }],
          readBack: { ok: true, at: null, detail: null },
        },
      },
      at: new Date().toISOString(),
      ...o,
    });
    const jobStatus = async () =>
      (await p.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [jobId])).rows[0]
        ?.status;
    return { repo, p, deps, event, itemId, jobId, entryId: entry.rows[0]!.id, jobStatus };
  }

  it('settles the item from its delivery, before the worker recorded it delivering', async () => {
    const t = await handedOff();
    expect(await applyEvent(t.deps, t.event())).toBe('applied');
    expect(await t.repo.getItem(t.itemId)).toMatchObject({
      outcome: 'created',
      link: 'https://docs.test/doc-1',
      registerEntryId: t.entryId,
      detail: 'document doc-1',
      finishedAt: expect.any(String),
    });
    expect(await t.jobStatus()).toBe('succeeded');
    // A repeated event changes nothing.
    await applyEvent(t.deps, t.event({ sequence: 2 }));
    expect((await t.repo.getItem(t.itemId))?.outcome).toBe('created');
  });

  it("settles an item still waiting for its lane when its delivery's event comes first", async () => {
    const t = await handedOff();
    await t.p.query(`UPDATE decomposition_items SET outcome = 'waiting_to_deliver' WHERE id = $1`, [
      t.itemId,
    ]);
    await applyEvent(t.deps, t.event());
    expect(await t.repo.getItem(t.itemId)).toMatchObject({
      outcome: 'created',
      registerEntryId: t.entryId,
      finishedAt: expect.any(String),
    });
  });

  it('settles a changed document as changed_in_target, and the job never awaits review', async () => {
    const t = await handedOff({ persistentId: 'doc-1' });
    await t.p.query(`UPDATE decomposition_items SET outcome = 'delivering' WHERE id = $1`, [
      t.itemId,
    ]);
    const error = bridgeError('changed_in_target', 'the document changed in the target');
    await applyEvent(t.deps, t.event({ status: 'needs_user', error, receipt: null }));
    expect(await t.repo.getItem(t.itemId)).toMatchObject({
      outcome: 'changed_in_target',
      detail: 'the document changed in the target',
      finishedAt: expect.any(String),
    });
    expect(await t.jobStatus()).toBe('succeeded');
    const { rows } = await t.p.query<{ message: string }>(
      `SELECT message FROM job_events WHERE job_id = $1 ORDER BY id DESC LIMIT 1`,
      [t.jobId],
    );
    expect(rows[0]?.message).toBe('changed in target: the document changed in the target');
  });

  it("a not_found without the sink's marker (the reconcile's lost delivery) is not gone", async () => {
    const plain = await handedOff({ persistentId: 'doc-1' });
    const lost = bridgeError('not_found', 'the bridge has no record of this delivery');
    await applyEvent(plain.deps, plain.event({ status: 'failed', error: lost, receipt: null }));
    expect(await plain.repo.getItem(plain.itemId)).toMatchObject({
      outcome: 'failed',
      gone: false,
      reloadable: false,
    });
  });

  it("settles an update refused with the sink's missing-document marker as gone", async () => {
    const t = await handedOff({ persistentId: 'doc-1' });
    await t.p.query(`UPDATE decomposition_items SET outcome = 'delivering' WHERE id = $1`, [
      t.itemId,
    ]);
    const error = documentMissing('doc-1', 'Repository lib has no map doc-1 for this update');
    await applyEvent(t.deps, t.event({ status: 'needs_user', error, receipt: null }));
    expect(await t.repo.getItem(t.itemId)).toMatchObject({
      outcome: 'unresolved',
      detail: GONE_DETAIL,
      gone: true,
      reloadable: true,
      resolution: null,
      finishedAt: expect.any(String),
    });
    expect(await t.jobStatus()).toBe('succeeded');
  });

  it("migration 202610261330 fills a delivered item's missing link by linkOf's rule", async () => {
    const { repo, p } = await make();
    const batch = await repo.createBatch({
      targetId: 'manuals',
      force: false,
      createdBy: { id: null, name: null },
    });
    const sinkId = `sink-${randomUUID()}`;
    onTestFinished(async () => {
      await p.query('DELETE FROM decomposition_register WHERE sink_id = $1', [sinkId]);
    });
    const w = (kind: string, id: string, url: string | null) => ({ kind, id, label: null, url });
    const receipt = (written: object[], mapId?: string) => ({
      written,
      document: {
        persistentId: 'doc',
        components: mapId ? [{ kind: 'map', id: mapId, version: '1', element: null }] : [],
        readBack: { ok: true, at: null, detail: null },
      },
    });
    const cases: Record<string, { outcome: string; link?: string; receipt: object | null }> = {
      map: {
        outcome: 'created',
        receipt: receipt([
          w('topic', 't1', 'https://t.test/t1'),
          w('map', 'm', 'https://t.test/m'),
        ]),
      },
      preferred: {
        outcome: 'updated',
        receipt: receipt(
          [w('map', 'other', 'https://t.test/other'), w('map', 'doc/map', 'https://t.test/map')],
          'doc/map',
        ),
      },
      firstOfSeveral: {
        outcome: 'read_back_mismatch',
        receipt: receipt([
          w('document', 'd', 'https://t.test/d'),
          w('map', 'm', 'https://t.test/m'),
        ]),
      },
      imageOnly: {
        outcome: 'created',
        receipt: receipt([
          w('image', 'i', 'https://t.test/i'),
          w('topic', 't', 'https://t.test/t'),
        ]),
      },
      notDelivered: { outcome: 'failed', receipt: receipt([w('map', 'm', 'https://t.test/m')]) },
      kept: {
        outcome: 'created',
        link: 'https://t.test/kept',
        receipt: receipt([w('map', 'm', 'https://t.test/m')]),
      },
      noReceipt: { outcome: 'created', receipt: null },
    };
    const ids: Record<string, string> = {};
    for (const [name, c] of Object.entries(cases)) {
      const itemId = randomUUID();
      ids[name] = itemId;
      await repo.addItem({
        id: itemId,
        batchId: batch.id,
        sourceKey: `${name}.docx`,
        filename: `${name}.docx`,
        contentSha256: 'a'.repeat(64),
        sizeBytes: 1,
        objectKey: `decompositions/${batch.id}/${itemId}.docx`,
      });
      const entry = await p.query<{ id: string }>(
        `INSERT INTO decomposition_register
           (sink_id, instance_id, source_key, content_sha256, persistent_id, state,
            idempotency_key, last_receipt, batch_id)
         VALUES ($1, NULL, $2, $3, 'doc', 'delivered', $4, $5, $6) RETURNING id::text`,
        [
          sinkId,
          `${name}.docx`,
          'a'.repeat(64),
          'k'.repeat(64),
          c.receipt === null ? null : JSON.stringify(c.receipt),
          batch.id,
        ],
      );
      await p.query(
        `UPDATE decomposition_items SET outcome = $2, register_entry_id = $3, link = $4
          WHERE id = $1`,
        [itemId, c.outcome, entry.rows[0]!.id, c.link ?? null],
      );
    }
    const sql = readFileSync(
      `${migrations}/202610261330_decomposition_items_link_backfill.sql`,
      'utf8',
    );
    await p.query(sql);
    const links = Object.fromEntries(
      await Promise.all(
        Object.entries(ids).map(async ([name, id]) => [name, (await repo.getItem(id))?.link]),
      ),
    );
    expect(links).toEqual({
      map: 'https://t.test/m',
      preferred: 'https://t.test/map',
      firstOfSeveral: 'https://t.test/d',
      imageOnly: null,
      notDelivered: null,
      kept: 'https://t.test/kept',
      noReceipt: null,
    });
  });

  it('settles an entry whose batch id is not a batch (a command-line delivery)', async () => {
    const { repo, p } = await make();
    const deliveryId = randomUUID();
    const sinkId = `sink-${randomUUID()}`;
    await p.query(
      `INSERT INTO decomposition_register
         (sink_id, instance_id, source_key, content_sha256, state, idempotency_key, delivery_id,
          batch_id)
       VALUES ($1, NULL, 'r1.docx', $2, 'pending', $3, $4, 'cli-batch')`,
      [sinkId, 'a'.repeat(64), 'k'.repeat(64), deliveryId],
    );
    onTestFinished(async () => {
      await p.query('DELETE FROM decomposition_register WHERE sink_id = $1', [sinkId]);
    });
    const deps = { repo, targets: new MemoryPublishTargetRepo() };
    const final: BridgeEvent = {
      eventId: randomUUID(),
      deliveryId,
      sequence: 1,
      status: 'failed',
      error: bridgeError('internal', 'x'),
      receipt: null,
      at: new Date().toISOString(),
    };
    expect(await applyEvent(deps, final)).toBe('applied');
    expect((await repo.registerEntryByDelivery(deliveryId))?.state).toBe('failed');
  });

  it('refuses a NUL in a source key or a file name before Postgres sees it', async () => {
    const { repo } = await make();
    // testApp's own target repo counts deliveries from a MemoryRepo's maps; with PgRepo the
    // targets need a repo of their own (nothing here depends on target usage).
    const c = await testApp({ repo, targets: new MemoryPublishTargetRepo() });
    onTestFinished(() => c.app.close());
    c.bridge.sinkViews = [FAKE_DOCUMENT_SINK];
    const target = await c.app.inject({
      method: 'POST',
      url: '/api/publish-targets',
      payload: {
        kind: 'sink',
        label: 'Manuals',
        sinkId: 'docs',
        destination: { space: 'lib', name: '{source.stem}' },
      },
    });
    expect(target.statusCode).toBe(201);
    const batch = await c.app.inject({
      method: 'POST',
      url: '/api/conversions/batches',
      payload: { targetId: 'manuals' },
    });
    const batchId = batch.json<{ id: string }>().id;
    const upload = (sourceKey: string, filename: string) =>
      c.app.inject({
        method: 'POST',
        url: `/api/conversions/batches/${batchId}/items`,
        ...multipart({ sourceKey }, { filename, content: docx(), contentType: DOCX_MIME }),
      });
    const nul = String.fromCharCode(0);

    const badKey = await upload(`a${nul}.docx`, 'a.docx');
    expect(badKey.statusCode).toBe(422);
    expect(badKey.json()).toMatchObject({ code: 'bad_source_key' });
    const badName = await upload('a.docx', `a${nul}.docx`);
    expect(badName.statusCode).toBe(422);
    expect(badName.json()).toMatchObject({ code: 'bad_filename' });
    expect([...c.store.objects.keys()].filter((k) => k.startsWith('runs/'))).toEqual([]);

    const good = await upload('Manuals/a.docx', 'a.docx');
    expect(good.statusCode).toBe(201);
    expect(await repo.listItems(batchId)).toHaveLength(1);
  });
});
