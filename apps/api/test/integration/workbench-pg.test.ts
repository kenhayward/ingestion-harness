/**
 * Opt-in Postgres integration test for the workbench SQL (PgRepo + PgWorkbenchRepo).
 *
 * Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database: it applies
 * db/migrations and writes rows (under random project ids). Example:
 *   docker run --rm -d --name ih-test-pg -e POSTGRES_PASSWORD=test -p 55433:5432 postgres:17-alpine
 *   IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres \
 *     npx vitest run apps/api/test/integration
 *   docker rm -f ih-test-pg
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { EMPTY_BRIEF } from '@ih/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgRepo } from '../../src/repositories/pg.js';
import type { NewDocument, SegmentJobParams } from '../../src/repositories/types.js';
import { PgWorkbenchRepo } from '../../src/workbench/repo.js';

const url = process.env.IH_TEST_DATABASE_URL;
const segmentParams: SegmentJobParams = {
  samples: [{ sampleId: 's1', sha256: 'abc' }],
  document: { sections: [{ id: 'all', anchor: '\\A', required: true }], pageMarkers: true },
};
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

// Generous timeout: the first queries against a freshly started container can be slow.
describe.skipIf(!url)('workbench SQL against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let repo: PgRepo;
  let workbench: PgWorkbenchRepo;

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 3 });
    repo = PgRepo.fromUrl(url!);
    workbench = new PgWorkbenchRepo(new pg.Pool({ connectionString: url, max: 3 }));
  });

  afterAll(async () => {
    await pool?.end();
    await repo?.close();
  });

  const doc = (projectId: string): NewDocument => {
    const id = randomUUID();
    return {
      id,
      filename: `${id}.pdf`,
      sha256: id.replaceAll('-', '').padEnd(64, '0'),
      sizeBytes: 10,
      specId: projectId,
      specVersion: 1,
      bucket: 'inbox',
      objectKey: `${id}.pdf`,
    };
  };
  const paramsOf = async (jobId: string) =>
    (
      await pool.query<{ params: Record<string, unknown> | null }>(
        'SELECT params FROM jobs WHERE id = $1',
        [jobId],
      )
    ).rows[0]!.params;
  const newProject = async () => {
    const id = `it-${randomUUID().slice(0, 8)}`;
    await workbench.createProject(id, 'Integration');
    return id;
  };

  it('stores params on workbench jobs and draft jobs, and lists draft jobs', async () => {
    const projectId = await newProject();
    const prepare = await repo.createWorkbenchJob(doc(projectId), {
      projectId,
      task: 'prepare',
      params: { dataPolicy: 'local' },
    });
    expect(prepare).toMatchObject({ projectId, task: 'prepare', test: true });
    expect(await paramsOf(prepare.id)).toEqual({ dataPolicy: 'local' });
    const production = await repo.createDocumentAndJob(doc(projectId), null);
    expect(await paramsOf(production.id)).toBeNull();

    const first = await repo.createDraftJob(projectId, { stage: 'survey', dataPolicy: 'local' });
    const second = await repo.createDraftJob(projectId, { stage: 'survey', dataPolicy: 'local' });
    expect(first).toMatchObject({ projectId, status: 'queued', error: null });
    expect(await paramsOf(first.id)).toEqual({ stage: 'survey', dataPolicy: 'local' });
    const listed = await repo.listDraftJobs(projectId);
    expect(new Set(listed.map((j) => j.id))).toEqual(new Set([first.id, second.id]));
    // Draft jobs are document-less: never in a JobSummary listing.
    expect((await repo.listProjectJobs(projectId)).map((j) => j.id)).toEqual([prepare.id]);
  });

  it('creates, lists and decides proposals once', async () => {
    const projectId = await newProject();
    const a = await repo.createDraftJob(projectId, { stage: 'survey' });
    const b = await repo.createDraftJob(projectId, { stage: 'survey' });
    const pa = await workbench.createProposal({
      id: a.id,
      projectId,
      stage: 'survey',
      briefVersion: null,
    });
    expect(pa).toMatchObject({ id: a.id, projectId, decision: null, decidedAt: null });
    await workbench.saveBrief(projectId, EMPTY_BRIEF);
    await workbench.createProposal({ id: b.id, projectId, stage: 'survey', briefVersion: 1 });
    const listed = await workbench.listProposals(projectId);
    expect(listed.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(listed.find((p) => p.id === b.id)!.briefVersion).toBe(1);

    const decided = await workbench.decideProposal(projectId, a.id, 'accepted');
    expect(decided).toMatchObject({ id: a.id, decision: 'accepted' });
    expect(decided!.decidedAt).not.toBeNull();
    expect(await workbench.decideProposal(projectId, a.id, 'rejected')).toBeNull();
    expect(await workbench.decideProposal('other-project', b.id, 'rejected')).toBeNull();
  });

  it('revoking to local downgrades existing project jobs; allowing never upgrades', async () => {
    const projectId = await newProject();
    const other = await newProject();
    const allowed = await workbench.setDataPolicy(projectId, 'external', 'admin');
    expect(allowed).toMatchObject({ dataPolicy: 'external', dataPolicyChangedBy: 'admin' });
    expect(allowed!.dataPolicyChangedAt).not.toBeNull();

    const external = { dataPolicy: 'external' };
    const prepare = await repo.createWorkbenchJob(doc(projectId), {
      projectId,
      task: 'prepare',
      params: external,
    });
    const run = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'process' });
    const draft = await repo.createDraftJob(projectId, { stage: 'survey', ...external });
    const segment = await repo.createSegmentJob(projectId, segmentParams);
    await workbench.setDataPolicy(other, 'external', null);
    const elsewhere = await repo.createDraftJob(other, { stage: 'survey', ...external });

    const revoked = await workbench.setDataPolicy(projectId, 'local', 'admin');
    expect(revoked).toMatchObject({ dataPolicy: 'local' });
    expect(await paramsOf(prepare.id)).toEqual({ dataPolicy: 'local' });
    // A job created without params gets them.
    expect(await paramsOf(run.id)).toEqual({ dataPolicy: 'local' });
    expect(await paramsOf(draft.id)).toEqual({ stage: 'survey', dataPolicy: 'local' });
    // Segment previews keep their strictly validated params; other projects are untouched.
    expect(await paramsOf(segment.job.id)).toEqual(segmentParams);
    expect(await paramsOf(elsewhere.id)).toEqual({ stage: 'survey', ...external });

    await workbench.setDataPolicy(projectId, 'external', 'admin');
    expect(await paramsOf(prepare.id)).toEqual({ dataPolicy: 'local' });
    expect(await paramsOf(draft.id)).toEqual({ stage: 'survey', dataPolicy: 'local' });

    expect(await workbench.setDataPolicy('it-missing', 'local', null)).toBeNull();
  });
});
