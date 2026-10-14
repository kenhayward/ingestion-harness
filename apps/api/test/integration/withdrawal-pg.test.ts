/**
 * Opt-in Postgres test of withdrawals (ADR 0011 step 7, migration 0037): what a job deletion
 * and a retirement queue, and the published graph rows they remove. Skipped unless
 * IH_TEST_DATABASE_URL points at a THROWAWAY database (it applies db/migrations and writes rows).
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgRepo } from '../../src/repositories/pg.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('withdrawals against Postgres', { timeout: 30_000 }, () => {
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

  /** A succeeded, delivered job of `type` with one published output and one draft. */
  async function delivered(type: string, sha: string) {
    const id = randomUUID();
    const job = await repo.createDocumentAndJob(
      {
        id,
        filename: `${id}.pdf`,
        sha256: sha,
        sizeBytes: 10,
        specId: type,
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `${id}.pdf`,
      },
      null,
    );
    await pool.query(`UPDATE jobs SET status = 'succeeded' WHERE id = $1`, [job.id]);
    await pool.query(
      `INSERT INTO job_outputs (job_id, output_id, stage, format, bucket, object_key)
       VALUES ($1, 'fields', 'published', 'csv', 'pub', $2), ($1, 'fields', 'draft', 'csv', 'out', $2)`,
      [job.id, `${type}/${job.id}.csv`],
    );
    return job;
  }

  async function publishGraph(sha: string, type: string, jobId: string, version: number) {
    const iri = `https://d.example/graph/source/${sha}/${type}`;
    const values = [sha, type, iri, version, jobId, randomUUID()];
    await pool.query(
      `INSERT INTO published_graphs (sha256, template_id, graph_iri, version, job_id, document_id,
         template_version, base_iri, triples) VALUES ($1, $2, $3, $4, $5, $6, 1, 'https://d.example/', 3)
       ON CONFLICT (sha256, template_id) DO UPDATE SET version = $4, job_id = $5`,
      values,
    );
    await pool.query(
      `INSERT INTO published_graph_versions (sha256, template_id, graph_iri, version, job_id,
         document_id, template_version, base_iri, triples)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 'https://d.example/', 3)`,
      values,
    );
    await pool.query(
      `INSERT INTO published_entities (iri, kind, scoped_key) VALUES ($1, 'k', '["x"]')
       ON CONFLICT DO NOTHING`,
      [`https://d.example/e/${sha}`],
    );
    await pool.query(
      `INSERT INTO published_entity_sources (iri, sha256, template_id, job_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [`https://d.example/e/${sha}`, sha, type, jobId],
    );
    return iri;
  }

  const params = async (jobId: string | null | undefined) =>
    (
      await pool.query<{ task: string; params: unknown; priority: number; max_attempts: number }>(
        'SELECT task, params, priority, max_attempts FROM jobs WHERE id = $1',
        [jobId],
      )
    ).rows[0];

  it('deleting a job withdraws its outputs and drops the graph it published last', async () => {
    const type = `wd-${randomUUID().slice(0, 8)}`;
    const sha = randomUUID().replaceAll('-', '');
    const first = await delivered(type, sha);
    const second = await delivered(type, sha);
    await publishGraph(sha, type, first.id, 1);
    const iri = await publishGraph(sha, type, second.id, 2);

    const older = await repo.deleteJob(first.id);
    expect(older.result).toBe('deleted');
    const kept = older.result === 'deleted' ? older.removed.withdrawJobId : null;
    expect(await params(kept)).toEqual({
      task: 'withdraw',
      priority: 0,
      max_attempts: 100,
      params: {
        objects: [{ bucket: 'pub', key: `${type}/${first.id}.csv` }],
        graphs: [{ sha256: sha, templateId: type, graphIri: null, versions: [1] }],
      },
    });
    expect(
      (await pool.query('SELECT version FROM published_graphs WHERE sha256 = $1', [sha])).rows,
    ).toEqual([{ version: 2 }]);

    const newest = await repo.deleteJob(second.id);
    const dropped = newest.result === 'deleted' ? newest.removed.withdrawJobId : null;
    expect((await params(dropped))!.params).toEqual({
      objects: [{ bucket: 'pub', key: `${type}/${second.id}.csv` }],
      graphs: [{ sha256: sha, templateId: type, graphIri: iri, versions: [2] }],
    });
    for (const table of [
      'published_graphs',
      'published_graph_versions',
      'published_entity_sources',
    ]) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE sha256 = $1`, [sha])).rowCount).toBe(
        0,
      );
    }
    expect(
      (
        await pool.query('SELECT 1 FROM published_entities WHERE iri = $1', [
          `https://d.example/e/${sha}`,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('retiring withdraws once, readers skip withdrawn outputs, unretiring republishes', async () => {
    const type = `rt-${randomUUID().slice(0, 8)}`;
    const sha = randomUUID().replaceAll('-', '');
    const job = await delivered(type, sha);
    const iri = await publishGraph(sha, type, job.id, 1);

    const withdrawId = await repo.withdrawType(type, 'admin');
    expect((await params(withdrawId))!.params).toEqual({
      objects: [{ bucket: 'pub', key: `${type}/${job.id}.csv` }],
      graphs: [{ sha256: sha, templateId: type, graphIri: iri, versions: [1] }],
    });
    expect((await repo.getJob(job.id))!.outputs.map((o) => o.stage)).toEqual(['draft']);
    expect(await repo.getPublishedAt(job.id)).toBeNull();
    expect(await repo.withdrawType(type, 'admin')).toBeNull();
    // Version rows are kept, so a republish continues the numbering.
    expect(
      (await pool.query('SELECT 1 FROM published_graph_versions WHERE sha256 = $1', [sha]))
        .rowCount,
    ).toBe(1);

    const republishId = await repo.republishType(type, 'admin');
    expect(await params(republishId)).toMatchObject({
      task: 'republish',
      priority: -10,
      params: { templateId: type },
    });
    expect(await repo.republishType(`${type}-none`, 'admin')).toBeNull();
    expect(await repo.withdrawalStatus()).toMatchObject({ queued: expect.any(Number) });
    await pool.query(`DELETE FROM jobs WHERE task IN ('withdraw', 'republish')`);
  });
});
