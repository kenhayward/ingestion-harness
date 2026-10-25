/**
 * Opt-in Postgres test of conversion batches (decomposition phase 3, migration
 * 202610251200_decomposition_batches): the repo contract, the outcome check, and that `decompose`
 * jobs stay out of the Jobs list. Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY
 * database (it applies db/migrations and deletes batches, items and decompose jobs).
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { MemoryPublishTargetRepo } from '../../src/publish-targets/repo.js';
import { PgRepo } from '../../src/repositories/pg.js';
import { DOCX_MIME } from '@ih/shared';
import { conversionsContract } from '../conversions-contract.js';
import { docx } from '../docx-fixtures.js';
import { FAKE_DOCUMENT_SINK } from '../fake-sink.js';
import { multipart, testApp } from '../helpers.js';

const url = process.env.IH_TEST_DATABASE_URL;
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
      },
    };
  };

  afterAll(async () => {
    if (pool) await clear(pool);
    await pool?.end();
    await repo?.close();
  });

  conversionsContract('pg', make);

  it('refuses an item outcome outside the twelve', async () => {
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
