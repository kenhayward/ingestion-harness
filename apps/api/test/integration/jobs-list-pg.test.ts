/**
 * Opt-in Postgres integration test for listing jobs (PgRepo.listJobs).
 *
 * Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database: it applies db/migrations
 * and expects no other jobs in it. Example:
 *   docker run --rm -d --name ih-test-pg-jobs -e POSTGRES_PASSWORD=test -p 55434:5432 ih-postgres:pgvector
 *   IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55434/postgres \
 *     npx vitest run --config apps/api/vitest.integration.config.ts jobs-list-pg
 *   docker rm -f ih-test-pg-jobs
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { JobStatus } from '@ih/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgRepo } from '../../src/repositories/pg.js';
import type { NewDocument } from '../../src/repositories/types.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('listing jobs against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let repo: PgRepo;

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 3 });
    repo = PgRepo.fromUrl(url!);
  });

  afterAll(async () => {
    await pool?.end();
    await repo?.close();
  });

  const doc = (): NewDocument => {
    const id = randomUUID();
    return {
      id,
      filename: `${id}.pdf`,
      sha256: id.replaceAll('-', '').padEnd(64, '0'),
      sizeBytes: 10,
      specId: 'it-jobs',
      specVersion: 1,
      bucket: 'inbox',
      objectKey: `${id}.pdf`,
    };
  };
  /** A job in `status`, created `minutesAgo` minutes ago. */
  const jobAt = async (status: JobStatus, minutesAgo: number) => {
    const job = await repo.createDocumentAndJob(doc(), null);
    await pool.query(
      `UPDATE jobs SET status = $2, created_at = now() - make_interval(mins => $3) WHERE id = $1`,
      [job.id, status, minutesAgo],
    );
    return job.id;
  };

  it('lists a status group however old its jobs are, newest first', async () => {
    const oldReview = await jobAt('awaiting_review', 600);
    const oldFailure = await jobAt('failed', 500);
    const done = [await jobAt('succeeded', 3), await jobAt('cancelled', 2)];
    const running = await jobAt('running', 1);

    const newest = await repo.listJobs({ limit: 2 });
    expect(newest.map((j) => j.id)).toEqual([running, done[1]]);

    const attention = await repo.listJobs({ limit: 500, group: 'attention' });
    expect(attention.map((j) => j.id)).toEqual([oldFailure, oldReview]);
    expect((await repo.listJobs({ limit: 1, group: 'attention' })).map((j) => j.id)).toEqual([
      oldFailure,
    ]);
    expect((await repo.listJobs({ limit: 50, group: 'done' })).map((j) => j.id)).toEqual([
      done[1],
      done[0],
    ]);
    expect((await repo.listJobs({ limit: 50, group: 'active' })).map((j) => j.id)).toEqual([
      running,
    ]);
    // A status and a group together: both apply.
    expect(
      (await repo.listJobs({ limit: 50, group: 'attention', status: 'failed' })).map((j) => j.id),
    ).toEqual([oldFailure]);
    expect(await repo.listJobs({ limit: 50, group: 'done', status: 'failed' })).toEqual([]);
  });
});
