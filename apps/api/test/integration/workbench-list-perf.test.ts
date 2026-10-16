/**
 * Opt-in load test of the Workbench project list (redesign W1): p95 of
 * GET /api/workbench/projects under 200 ms with 1,000 seeded projects.
 *
 * Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database: it applies
 * db/migrations and writes 1,000 projects (under a random id prefix). Example:
 *   docker run --rm -d --name ih-test-pg-perf -e POSTGRES_PASSWORD=test -p 55442:5432 ih-postgres:pgvector (deploy/docker/postgres.Dockerfile)
 *   IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55442/postgres \
 *     npx vitest run --config apps/api/vitest.integration.config.ts workbench-list-perf
 *   docker stop ih-test-pg-perf
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ProjectListPageSchema } from '@ih/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { migrate } from '../../src/db/migrate.js';
import { PgRepo } from '../../src/repositories/pg.js';
import { SpecRegistry } from '../../src/specs/spec-registry.js';
import { MemoryObjectStore } from '../../src/storage/object-store.js';
import { MemoryLlmConfigRepo } from '../../src/llm/repo.js';
import { MemoryOntologyRepo } from '../../src/ontologies/repo.js';
import { MemoryMaintenanceRepo } from '../../src/maintenance/repo.js';
import { MemoryLinkedDataRepo } from '../../src/linked-data/repo.js';
import { MemoryGitHubSyncRepo } from '../../src/github-sync/repo.js';
import { MemoryProfileRepo } from '../../src/profile/repo.js';
import { PgTemplateRepo } from '../../src/templates/repo.js';
import { PgWorkbenchRepo } from '../../src/workbench/repo.js';
import { seedWorkbenchProjects } from '../../src/workbench/seed.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
const PROJECTS = 1000;
const REQUESTS = 40;
const P95_MS = 200;

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

describe.skipIf(!url)('Workbench project list with 1,000 projects', { timeout: 600_000 }, () => {
  let pool: pg.Pool;
  let repo: PgRepo;
  let app: FastifyInstance;
  let ids: string[];
  const pools: pg.Pool[] = [];

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 3 });
    const prefix = `perf${randomUUID().slice(0, 6)}`;
    ids = await seedWorkbenchProjects(pool, PROJECTS, prefix);
    repo = PgRepo.fromUrl(url!);
    // Pool sizes as in server.ts.
    const templatesPool = new pg.Pool({ connectionString: url, max: 5 });
    const workbenchPool = new pg.Pool({ connectionString: url, max: 3 });
    pools.push(templatesPool, workbenchPool);
    app = await buildApp({
      repo,
      store: new MemoryObjectStore(), // no prepared triage or proposal bodies: read as missing
      targetStore: new MemoryObjectStore(),
      target: { bucket: 'published', prefix: 'pub/' },
      templates: new PgTemplateRepo(templatesPool),
      workbench: new PgWorkbenchRepo(workbenchPool),
      specs: SpecRegistry.fromDefinitions([]),
      buckets: { inbox: 'inbox', outputs: 'outputs', runs: 'runs' },
      maxUploadBytes: 1024 * 1024,
      access: null,
      profiles: new MemoryProfileRepo(),
      githubSync: new MemoryGitHubSyncRepo(),
      s3Keys: null,
      llm: new MemoryLlmConfigRepo(),
      ontologies: new MemoryOntologyRepo(),
      ontologyFetch: { hosts: [], maxBytes: 1 },
      linkedData: new MemoryLinkedDataRepo(),
      maintenance: new MemoryMaintenanceRepo(),
      llmSecrets: null,
      logger: { level: 'error' }, // a 500 prints its stack
    });
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    await repo?.close();
    await Promise.all(pools.map((p) => p.end()));
    await pool?.end();
  });

  const list = async (query: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/workbench/projects${query}` });
    expect(res.statusCode, res.body).toBe(200);
    return ProjectListPageSchema.parse(res.json());
  };

  it('answers within p95 < 200 ms once the cache is warm', async () => {
    expect(ids).toHaveLength(PROJECTS);
    expect(ids[0]).toMatch(/-0001$/);

    // Cold: every row is computed and cached. No time bound, but logged.
    const coldStart = performance.now();
    const first = await list('');
    const coldMs = performance.now() - coldStart;
    expect(first.total).toBeGreaterThanOrEqual(PROJECTS);
    const cached = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM workbench_list_cache WHERE project_id = ANY($1)',
      [ids],
    );
    expect(Number(cached.rows[0]!.n)).toBe(PROJECTS);
    // The seed's variety reaches every facet.
    for (const facet of ['attention', 'running', 'ready', 'progress', 'published'] as const) {
      expect(first.facets[facet], facet).toBeGreaterThan(0);
    }

    const prefix = ids[0]!.slice(0, ids[0]!.lastIndexOf('-'));
    const queries = [
      '',
      '?sort=name',
      '?sort=score&size=50',
      '?sort=samples&size=100',
      '?filter=attention',
      '?filter=running&sort=name',
      '?filter=ready',
      '?filter=published&page=2',
      `?q=${prefix}-01`,
      '?phase=draft&policy=local',
      '?filter=progress&page=3&size=50',
      `?ids=${ids.slice(0, 20).join(',')}`,
    ];
    const timings: number[] = [];
    for (let n = 0; n < REQUESTS; n++) {
      if (n % 10 === 0) {
        // A few projects change between batches: their rows recompute on the next request.
        const touched = Array.from({ length: 3 }, () => ids[Math.floor(Math.random() * PROJECTS)]!);
        await pool.query(
          `UPDATE jobs SET updated_at = now()
            WHERE id IN (SELECT DISTINCT ON (project_id) id FROM jobs
                          WHERE project_id = ANY($1) ORDER BY project_id, created_at)`,
          [touched],
        );
      }
      const start = performance.now();
      const page = await list(queries[n % queries.length]!);
      timings.push(performance.now() - start);
      expect(page.items.length).toBeLessThanOrEqual(100);
    }

    const sorted = [...timings].sort((a, b) => a - b);
    const stats = {
      coldMs: Math.round(coldMs),
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      max: Math.round(sorted.at(-1)!),
    };
    console.log(`workbench list, ${PROJECTS} projects:`, JSON.stringify(stats));
    expect(stats.p95).toBeLessThan(P95_MS);
  });
});
