/**
 * Opt-in Postgres test of the Results list's `show` filter (GET /api/results?show=): reviewed
 * and auto-approved are WHERE conditions, with issues a HAVING one beside the paging cursor.
 * Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database (it applies db/migrations
 * and writes rows).
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgRepo } from '../../src/repositories/pg.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('published results against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let repo: PgRepo;
  /** A type of this run only, so rows from other runs never show. */
  const type = `results-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 2 });
    repo = PgRepo.fromUrl(url!);
  });

  afterAll(async () => {
    await pool?.end();
    await repo?.close();
  });

  /** A succeeded job published at `at`, reviewed or not, with an issues output of `issues` rows. */
  async function published(
    filename: string,
    at: string,
    { reviewed, issues }: { reviewed: boolean; issues: number | null },
  ) {
    const id = randomUUID();
    const job = await repo.createDocumentAndJob(
      {
        id,
        filename,
        sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        sizeBytes: 10,
        specId: type,
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `${id}.pdf`,
      },
      null,
    );
    await pool.query(
      `UPDATE jobs SET status = 'succeeded',
              reviewer = CASE WHEN $2 THEN 'Ken' END, reviewed_at = CASE WHEN $2 THEN now() END
        WHERE id = $1`,
      [job.id, reviewed],
    );
    await pool.query(
      `INSERT INTO job_outputs (job_id, output_id, stage, format, bucket, object_key, target_id,
         created_at)
       VALUES ($1, 'document', 'published', 'json', 'pub', $2, 'default', $3)`,
      [job.id, `${type}/${job.id}.json`, at],
    );
    if (issues !== null) {
      await pool.query(
        `INSERT INTO job_outputs (job_id, output_id, stage, format, bucket, object_key, target_id,
           row_count, created_at)
         VALUES ($1, 'issues', 'published', 'csv', 'pub', $2, 'default', $3, $4)`,
        [job.id, `${type}/${job.id}-issues.csv`, issues, at],
      );
    }
    return job;
  }

  it('shows reviewed, auto-approved or with-issues results, with the other filters and paging', async () => {
    await published('reviewed.pdf', '2026-10-01T00:00:00.000Z', { reviewed: true, issues: null });
    await published('auto.pdf', '2026-10-02T00:00:00.000Z', { reviewed: false, issues: null });
    await published('issues.pdf', '2026-10-03T00:00:00.000Z', { reviewed: true, issues: 3 });
    await published('clean.pdf', '2026-10-04T00:00:00.000Z', { reviewed: false, issues: 0 });
    await published('auto-issues.pdf', '2026-10-05T00:00:00.000Z', {
      reviewed: false,
      issues: 1,
    });
    const names = async (query: Parameters<PgRepo['listPublished']>[0]) =>
      (await repo.listPublished({ templateId: type, ...query })).map((r) => r.filename);

    expect(await names({ limit: 50 })).toEqual([
      'auto-issues.pdf',
      'clean.pdf',
      'issues.pdf',
      'auto.pdf',
      'reviewed.pdf',
    ]);
    expect(await names({ limit: 50, show: 'reviewed' })).toEqual(['issues.pdf', 'reviewed.pdf']);
    expect(await names({ limit: 50, show: 'auto' })).toEqual([
      'auto-issues.pdf',
      'clean.pdf',
      'auto.pdf',
    ]);
    // An issues output with no rows is not "with issues".
    expect(await names({ limit: 50, show: 'issues' })).toEqual(['auto-issues.pdf', 'issues.pdf']);
    expect(await names({ limit: 50, show: 'auto', q: 'ISSUES' })).toEqual(['auto-issues.pdf']);

    // The cursor and the issues condition are both HAVING clauses: each still applies.
    const [first] = await repo.listPublished({ templateId: type, limit: 1, show: 'issues' });
    expect(first!.filename).toBe('auto-issues.pdf');
    expect(
      await names({
        limit: 50,
        show: 'issues',
        before: first!.publishedAt,
        beforeId: first!.jobId,
      }),
    ).toEqual(['issues.pdf']);
    const [auto] = await repo.listPublished({ templateId: type, limit: 1, show: 'auto' });
    expect(
      await names({ limit: 50, show: 'auto', before: auto!.publishedAt, beforeId: auto!.jobId }),
    ).toEqual(['clean.pdf', 'auto.pdf']);
  });
});
