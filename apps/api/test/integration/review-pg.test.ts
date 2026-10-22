/**
 * Opt-in Postgres test of approving a job (delivery bridge phase 6): the reviewer's name
 * overrides are stored with the approval (migration 202610221500) and a re-approval replaces
 * them. Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgRepo } from '../../src/repositories/pg.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('approving against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let repo: PgRepo;

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 2 });
    repo = PgRepo.fromUrl(url!);
  });

  afterAll(async () => {
    await pool?.end();
    await repo?.close();
  });

  async function awaiting() {
    const id = randomUUID();
    const job = await repo.createDocumentAndJob(
      {
        id,
        filename: `${id}.pdf`,
        sha256: 'd'.repeat(64),
        sizeBytes: 10,
        specId: 'demo',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `${id}.pdf`,
      },
      null,
    );
    await pool.query(`UPDATE jobs SET status = 'awaiting_review' WHERE id = $1`, [job.id]);
    return job;
  }

  it('stores the name overrides with the approval, and a re-approval replaces them', async () => {
    const job = await awaiting();
    expect(await repo.deliveryOverrides(job.id)).toEqual({});
    await repo.approve(job.id, 'Ken', null, { 'fake-target': { name: 'Chosen' } });
    expect(await repo.deliveryOverrides(job.id)).toEqual({ 'fake-target': { name: 'Chosen' } });
    await pool.query(`UPDATE jobs SET status = 'awaiting_review' WHERE id = $1`, [job.id]);
    await repo.approve(job.id, 'Ken', null);
    expect(await repo.deliveryOverrides(job.id)).toEqual({});
  });
});
