/**
 * Opt-in Postgres test for PgOntologyRepo (migration 0032). Skipped unless IH_TEST_DATABASE_URL
 * points at a THROWAWAY database: it applies db/migrations and writes ontology rows. Example:
 * docker run --rm -d --name ih-test-pg -e POSTGRES_PASSWORD=test -p 55433:5432 ih-postgres:pgvector (deploy/docker/postgres.Dockerfile)
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
  source: { kind: 'upload', sourceKey: 'k', sha256: 'aaa', bytes: 10 },
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
    expect(
      await repo.termKinds(
        [{ id: 'pv-pg', version: 1 }],
        [`${C}Protocol`, `${C}hasProtocol`, `${C}Nope`],
      ),
    ).toEqual({ [`${C}Protocol`]: ['class'], [`${C}hasProtocol`]: ['object_property'] });
    expect(await repo.termKinds([{ id: 'pv-pg', version: 2 }], [`${C}Protocol`])).toEqual({});
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
      mediaType: 'text/turtle',
    });
    expect(await repo.get('pv-pg')).toBeNull();
  });

  it('fetches a bounded number of rows to describe a hub term', async () => {
    await pool.query(`DELETE FROM ontologies WHERE id = 'pv-pg'`);
    const created = await repo.createVersion(
      input({ source: { kind: 'upload', sourceKey: 'k', sha256: 'hub', bytes: 10 } }),
    );
    if (!created.ok) throw new Error('not created');
    const S = `${C}Stages`;
    await pool.query(
      `INSERT INTO ontology_terms (ontology_id, version, iri, kind, label, parents, scheme, root)
       VALUES ('pv-pg', 1, $1, 'scheme', 'Stages', '{}', NULL, true)`,
      [S],
    );
    await pool.query(
      `INSERT INTO ontology_terms (ontology_id, version, iri, kind, label, parents, scheme)
       SELECT 'pv-pg', 1, $1 || 'c' || n, 'concept', 'Concept ' || lpad(n::text, 4, '0'),
              ARRAY[$2], $2
         FROM generate_series(1, 1000) n`,
      [C, S],
    );
    let fetched = 0;
    const counting = {
      query: async (...args: Parameters<pg.Pool['query']>) => {
        const result = await (pool.query as (...a: unknown[]) => Promise<pg.QueryResult>)(...args);
        fetched += result.rows.length;
        return result;
      },
      connect: () => pool.connect(),
    } as unknown as pg.Pool;
    const detail = await new PgOntologyRepo(counting).term('pv-pg', 1, S);
    expect(detail!.concepts).toHaveLength(200);
    expect(detail!.children).toHaveLength(200);
    expect(detail!.concepts[0]!.label).toBe('Concept 0001');
    expect(fetched).toBeLessThanOrEqual(2 * 200 + 10);
    const near = await repo.neighbours('pv-pg', 1, [S], 300);
    expect(near).toHaveLength(300);
    // The rows asked for come first, then the rest by label.
    expect(near!.slice(0, 2).map((t) => t.label)).toEqual(['Stages', 'Concept 0001']);
    expect(await repo.neighbours('pv-pg', 9, [S], 10)).toBeNull();
    await pool.query(`DELETE FROM ontologies WHERE id = 'pv-pg'`);
  });

  it('reads a version whose job stopped as failed, and lets it be deleted', async () => {
    const created = await repo.createVersion(
      input({ source: { kind: 'upload', sourceKey: 'k', sha256: 'stuck', bytes: 10 } }),
    );
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

  it('reads rows from before step 2 with defaults, and URL versions without bytes', async () => {
    await pool.query(`DELETE FROM ontologies WHERE id = 'pv-legacy'`);
    await pool.query(`INSERT INTO ontologies (id, label) VALUES ('pv-legacy', 'Legacy')`);
    await pool.query(
      `INSERT INTO ontology_versions
         (ontology_id, version, status, file_name, media_type, sha256, bytes, stats, imports)
       VALUES ('pv-legacy', 1, 'ready', 'pv.ttl', 'text/turtle', 'abc', 10,
               '{"triples":1,"classes":1,"properties":0,"concepts":0,"schemes":0,"shapes":0}',
               '[{"iri":"https://x.org/base","resolution":"unresolved"}]')`,
    );
    await pool.query(
      `INSERT INTO ontology_terms (ontology_id, version, iri, kind, label, root)
       VALUES ('pv-legacy', 1, 'https://x.org/A', 'class', 'A', true)`,
    );
    const legacy = (await repo.get('pv-legacy'))!.versions[0]!;
    expect(legacy).toMatchObject({
      sourceKind: 'upload',
      sourceUrl: null,
      stats: { imported: 0 },
      imports: [
        {
          iri: 'https://x.org/base',
          resolution: 'unresolved',
          ontologyId: null,
          version: null,
          reason: null,
        },
      ],
    });
    const terms = await repo.terms('pv-legacy', 1, { offset: 0, limit: 10 });
    expect(terms!.items[0]).toMatchObject({ label: 'A', definedIn: null });
    const url = await repo.createVersion({
      ontologyId: 'pv-legacy',
      meta: null,
      fileName: 'core.ttl',
      mediaType: '',
      source: { kind: 'url', url: 'https://w3id.org/core.ttl' },
      by: 'Ken',
    });
    expect(url).toMatchObject({
      ok: true,
      version: { version: 2, sha256: null, bytes: null, sourceKind: 'url' },
    });
    const job = await pool.query(`SELECT params FROM jobs WHERE id = $1`, [
      url.ok ? url.jobId : null,
    ]);
    expect(job.rows[0].params).toEqual({
      ontologyId: 'pv-legacy',
      version: 2,
      sourceUrl: 'https://w3id.org/core.ttl',
      fileName: 'core.ttl',
      mediaType: '',
    });
    await pool.query(`DELETE FROM ontologies WHERE id = 'pv-legacy'`);
  });
});
