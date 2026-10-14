/**
 * Opt-in Postgres test for PgOntologyRepo (migration 0032). Skipped unless IH_TEST_DATABASE_URL
 * points at a THROWAWAY database: it applies db/migrations and writes ontology rows. Example:
 * docker run --rm -d --name ih-test-pg -e POSTGRES_PASSWORD=test -p 55433:5432 postgres:17-alpine
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgOntologyRepo, type NewOntologyVersion } from '../../src/ontologies/repo.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
const C = 'https://example.org/pv#';

const input = (over: Partial<NewOntologyVersion> = {}): NewOntologyVersion => ({
  ontologyId: 'pv-pg',
  meta: { label: 'PV', description: '', tags: ['industry:pharma'], localOnly: false },
  fileName: 'pv.ttl',
  mediaType: 'text/turtle',
  sourceKey: 'k',
  sha256: 'aaa',
  bytes: 10,
  by: 'Ken',
  ...over,
});

describe.skipIf(!url)('ontology library against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let repo: PgOntologyRepo;

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 3 });
    repo = new PgOntologyRepo(pool);
    await pool.query(`DELETE FROM ontologies WHERE id = 'pv-pg'`);
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM ontologies WHERE id = 'pv-pg'`);
    await pool?.end();
  });

  it('imports, indexes, searches, describes and deletes', async () => {
    const created = await repo.createVersion(input());
    expect(created).toMatchObject({ ok: true, version: { version: 1, status: 'queued' } });
    expect(await repo.createVersion(input({ meta: null }))).toEqual({
      ok: false,
      reason: 'duplicate',
      version: 1,
    });
    const job = await pool.query(
      `SELECT task, priority, created_by, params FROM jobs WHERE id = $1`,
      [created.ok ? created.jobId : null],
    );
    expect(job.rows[0]).toMatchObject({
      task: 'ontology',
      priority: -10,
      created_by: 'Ken',
      params: { ontologyId: 'pv-pg', version: 1, sourceKey: 'k' },
    });
    expect(await repo.deleteVersion('pv-pg', 1)).toEqual({ result: 'busy' });

    // What the worker writes.
    await pool.query(
      `INSERT INTO ontology_terms
         (ontology_id, version, iri, kind, label, alt_labels, parents, ranges, root, child_count)
       VALUES ('pv-pg', 1, $1, 'class', 'Document', '{}', '{}', '{}', true, 1),
              ('pv-pg', 1, $2, 'class', 'Protocol', '{Validation protocol}', $3, '{}', false, 0),
              ('pv-pg', 1, $4, 'object_property', 'has protocol', '{}', '{}', $5, true, 0)`,
      [`${C}Document`, `${C}Protocol`, [`${C}Document`], `${C}hasProtocol`, [`${C}Protocol`]],
    );
    await pool.query(`UPDATE ontology_versions SET status = 'ready' WHERE ontology_id = 'pv-pg'`);
    await expect(
      pool.query(`UPDATE ontology_versions SET error = 'x' WHERE ontology_id = 'pv-pg'`),
    ).rejects.toThrow(/cannot change/);

    const roots = await repo.terms('pv-pg', 1, {
      group: 'classes',
      root: true,
      offset: 0,
      limit: 10,
    });
    expect(roots!.items.map((t) => t.label)).toEqual(['Document']);
    const kids = await repo.terms('pv-pg', 1, { parent: `${C}Document`, offset: 0, limit: 10 });
    expect(kids!.items.map((t) => t.label)).toEqual(['Protocol']);
    const found = await repo.terms('pv-pg', 1, { q: 'validation', offset: 0, limit: 10 });
    expect(found!.items.map((t) => t.label)).toEqual(['Protocol']);
    const ranked = await repo.terms('pv-pg', 1, { q: 'document', offset: 0, limit: 10 });
    expect(ranked!.items[0]!.label).toBe('Document');
    const literal = await repo.terms('pv-pg', 1, { q: '%', offset: 0, limit: 10 });
    expect(literal!.total).toBe(0);
    const protocol = await repo.term('pv-pg', 1, `${C}Protocol`);
    expect(protocol).toMatchObject({
      parentTerms: [{ label: 'Document' }],
      asRange: [{ label: 'has protocol' }],
    });

    expect(await repo.update('pv-pg', { retired: true })).toMatchObject({
      retiredAt: expect.any(String),
    });
    expect((await repo.list({ retired: false })).some((o) => o.id === 'pv-pg')).toBe(false);
    expect(await repo.deleteVersion('pv-pg', 1)).toEqual({
      result: 'deleted',
      sha256: 'aaa',
      fileName: 'pv.ttl',
    });
    expect(await repo.get('pv-pg')).toBeNull();
  });

  it('reads a version whose job stopped as failed, and lets it be deleted', async () => {
    const created = await repo.createVersion(input({ sha256: 'stuck' }));
    if (!created.ok) throw new Error('not created');
    await pool.query(`UPDATE jobs SET status = 'running' WHERE id = $1`, [created.jobId]);
    expect((await repo.get('pv-pg'))!.versions[0]!.status).toBe('queued');
    expect(await repo.deleteVersion('pv-pg', 1)).toEqual({ result: 'busy' });
    await pool.query(
      `UPDATE jobs SET status = 'needs_review', error = 'this worker has no ontology store'
        WHERE id = $1`,
      [created.jobId],
    );
    expect((await repo.get('pv-pg'))!.versions[0]).toMatchObject({
      status: 'failed',
      error: 'this worker has no ontology store',
    });
    expect(
      (await repo.list({ retired: false })).find((o) => o.id === 'pv-pg')!.latest,
    ).toMatchObject({ status: 'failed' });
    expect(await repo.deleteVersion('pv-pg', 1)).toMatchObject({ result: 'deleted' });
  });
});
