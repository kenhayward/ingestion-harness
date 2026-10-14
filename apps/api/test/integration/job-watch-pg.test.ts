/**
 * Opt-in Postgres integration test for live job streams: the migration 0031 triggers and
 * PgJobWatch's LISTEN connection. Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY
 * database (it applies db/migrations and writes rows). Example:
 *   docker run --rm -d --name ih-test-pg -e POSTGRES_PASSWORD=test -p 55433:5432 postgres:17-alpine
 *   IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres \
 *     npx vitest run --config apps/api/vitest.integration.config.ts job-watch-pg
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgJobWatch } from '../../src/jobs/watch.js';
import { PgRepo } from '../../src/repositories/pg.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('job change notifications against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let repo: PgRepo;
  let watch: PgJobWatch;

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 2 });
    repo = PgRepo.fromUrl(url!);
    watch = new PgJobWatch(url!);
  });

  afterAll(async () => {
    await watch?.close();
    await pool?.end();
    await repo?.close();
  });

  async function newJob() {
    const id = randomUUID();
    return repo.createDocumentAndJob(
      {
        id,
        filename: `${id}.pdf`,
        sha256: id.replaceAll('-', '').padEnd(64, '0'),
        sizeBytes: 10,
        specId: 'watch-it',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `${id}.pdf`,
      },
      null,
    );
  }

  /** Resolves on the job's next notification (or fails after 5 s). */
  const next = (jobId: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no notification for ${jobId}`)), 5000);
      const stop = watch.subscribe(jobId, () => {
        clearTimeout(timer);
        stop();
        resolve();
      });
    });

  it('notifies on a status change, a new event and a step run, for that job only', async () => {
    const job = await newJob();
    const other = await newJob();
    await new Promise((r) => setTimeout(r, 300)); // the LISTEN connection is up
    let others = 0;
    const stopOther = watch.subscribe(other.id, () => others++);

    let seen = next(job.id);
    await pool.query(`UPDATE jobs SET status = 'running' WHERE id = $1`, [job.id]);
    await seen;

    seen = next(job.id);
    await pool.query(
      `INSERT INTO job_events (job_id, level, message, data) VALUES ($1, 'info', 'step progress', '{}')`,
      [job.id],
    );
    await seen;

    seen = next(job.id);
    await pool.query(
      `INSERT INTO step_runs (job_id, step_id, trigger, status, started_at) VALUES ($1, 'head', 'process', 'succeeded', now())`,
      [job.id],
    );
    await seen;

    stopOther();
    expect(others).toBe(0);
  });

  it('reconnects after losing its connection, and re-reads every watched job then', async () => {
    const lossy = new PgJobWatch(url!, () => {}, 50);
    try {
      const job = await newJob();
      await new Promise((r) => setTimeout(r, 300));
      let calls = 0;
      const stop = lossy.subscribe(job.id, () => calls++);
      await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND query = 'LISTEN ih_job_changed'`,
      );
      for (let i = 0; i < 100 && calls === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(calls).toBe(1); // the catch-up after reconnecting
      await pool.query(`UPDATE jobs SET attempts = attempts + 1 WHERE id = $1`, [job.id]);
      for (let i = 0; i < 100 && calls === 1; i++) await new Promise((r) => setTimeout(r, 50));
      expect(calls).toBe(2); // listening again
      stop();
    } finally {
      await lossy.close();
    }
  });
});
