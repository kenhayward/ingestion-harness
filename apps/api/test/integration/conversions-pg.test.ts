/**
 * Opt-in Postgres test of conversion batches (decomposition phase 3, migration
 * 202610251200_decomposition_batches): the repo contract, the outcome check, and that `decompose`
 * jobs stay out of the Jobs list. Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY
 * database (it applies db/migrations and deletes batches, items and decompose jobs).
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgRepo } from '../../src/repositories/pg.js';
import { conversionsContract } from '../conversions-contract.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('conversion batches against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool | undefined;
  let repo: PgRepo | undefined;

  /** Items hold their jobs: other tests' `DELETE FROM jobs` needs them gone first. */
  const clear = async (p: pg.Pool) => {
    await p.query('DELETE FROM decomposition_items');
    await p.query('DELETE FROM decomposition_batches');
    await p.query(`DELETE FROM job_events WHERE job_id IN
                     (SELECT id FROM jobs WHERE task = 'decompose')`);
    await p.query(`DELETE FROM jobs WHERE task = 'decompose'`);
  };

  const make = async () => {
    if (!pool) {
      await migrate(url!, migrations);
      pool = new pg.Pool({ connectionString: url, max: 4 });
      repo = PgRepo.fromUrl(url!);
    }
    await clear(pool);
    const p = pool;
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
          }>('SELECT task, priority, max_attempts, params, created_by FROM jobs WHERE id = $1', [
            id,
          ]);
          const r = rows[0];
          return r
            ? {
                task: r.task,
                priority: r.priority,
                maxAttempts: r.max_attempts,
                params: r.params,
                createdBy: r.created_by,
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
});
