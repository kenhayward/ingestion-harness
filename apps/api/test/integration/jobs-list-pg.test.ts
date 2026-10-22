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
import { JobPageQuerySchema, pageOfJobs, type JobStatus } from '@ih/shared';
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
    await pool.query('DELETE FROM jobs');
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

  it('pages exactly as pageOfJobs does, for every kind of query', async () => {
    await pool.query('DELETE FROM jobs');
    const statuses: JobStatus[] = ['succeeded', 'failed', 'running', 'awaiting_review'];
    const made: string[] = [];
    for (let n = 0; n < 12; n++) made.push(await jobAt(statuses[n % 4]!, 100 - n));
    // Two jobs created at the same moment: the id decides their order.
    const same = await jobAt('succeeded', 50);
    const twin = await jobAt('succeeded', 50);
    await pool.query(
      `UPDATE jobs SET created_at = (SELECT created_at FROM jobs WHERE id = $1) WHERE id = $2`,
      [same, twin],
    );
    // A file name holding LIKE's wildcards: searched as text.
    const odd = await jobAt('failed', 40);
    await pool.query(
      `UPDATE documents SET filename = '100%_done.pdf' WHERE id = (SELECT document_id FROM jobs WHERE id = $1)`,
      [odd],
    );
    const all = await repo.listJobs({ limit: 500 });
    const queries: Record<string, unknown>[] = [
      { size: 5 },
      { size: 5, before: made[3] },
      { size: 5, after: made[9] },
      { size: 5, after: made[1] },
      { size: 5, from: made[6] },
      { size: 5, before: same },
      { size: 5, before: twin },
      { size: 3, group: 'attention' },
      { size: 3, group: 'attention', before: made[2] },
      { size: 4, group: 'done', after: made[11] },
      { size: 10, q: 'FAILED' },
      { size: 10, q: '100%_' },
      { size: 10, q: '%' },
      { size: 10, q: 'it-jobs running' },
      { size: 5, before: randomUUID() },
    ];
    for (const q of queries) {
      const query = { ...JobPageQuerySchema.parse(q), mine: undefined };
      const expected = pageOfJobs(all, query);
      const got = await repo.jobPage(query);
      expect({ q, ...got, jobs: got.jobs.map((j) => j.id) }).toEqual({
        q,
        ...expected,
        jobs: expected.jobs.map((j) => j.id),
      });
    }
  });
});
