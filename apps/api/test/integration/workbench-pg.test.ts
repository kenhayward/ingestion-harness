/**
 * Opt-in Postgres integration test for the workbench SQL (PgRepo + PgWorkbenchRepo).
 *
 * Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database: it applies
 * db/migrations and writes rows (under random project ids). Example:
 *   docker run --rm -d --name ih-test-pg -e POSTGRES_PASSWORD=test -p 55433:5432 postgres:17-alpine
 *   IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres \
 *     npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg
 *   docker rm -f ih-test-pg
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { EMPTY_BRIEF } from '@ih/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgRepo } from '../../src/repositories/pg.js';
import {
  ReferenceConflictError,
  type NewDocument,
  type SegmentJobParams,
} from '../../src/repositories/types.js';
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

  it('round-trips a partial decision with its base draft, and defaults for survey proposals', async () => {
    const projectId = await newProject();
    const a = await repo.createDraftJob(projectId, { stage: 'outputs' });
    const b = await repo.createDraftJob(projectId, { stage: 'survey' });
    const base = { id: projectId, version: 1, outputs: { fields: [] } };
    await workbench.createProposal({
      id: a.id,
      projectId,
      stage: 'outputs',
      briefVersion: null,
      baseVersion: 1,
      baseDefinition: base,
    });
    const decided = await workbench.decideProposal(projectId, a.id, 'partially_accepted', [0, 2]);
    expect(decided).toMatchObject({
      decision: 'partially_accepted',
      acceptedChanges: [0, 2],
      baseVersion: 1,
      baseDefinition: base,
    });
    expect(await workbench.decideProposal(projectId, a.id, 'rejected')).toBeNull();

    const survey = await workbench.createProposal({
      id: b.id,
      projectId,
      stage: 'survey',
      briefVersion: null,
    });
    expect(survey).toMatchObject({
      acceptedChanges: null,
      baseVersion: null,
      baseDefinition: null,
    });
    expect(await workbench.decideProposal(projectId, b.id, 'accepted')).toMatchObject({
      acceptedChanges: null,
    });
  });

  it('stores feedback, resolves it once and only deletes open items', async () => {
    const projectId = await newProject();
    const item = {
      projectId,
      target: 'field' as const,
      targetId: 'sender',
      sampleId: null,
      iterationId: null,
      body: 'Use the letterhead',
    };
    const a = await workbench.createFeedback(item);
    const b = await workbench.createFeedback({ ...item, targetId: 'date' });
    expect(a).toMatchObject({ ...item, resolvedBy: null });
    expect((await workbench.listFeedback(projectId)).map((f) => f.id)).toEqual([b.id, a.id]);
    const job = await repo.createDraftJob(projectId, {});
    const p = await workbench.createProposal({
      id: job.id,
      projectId,
      stage: 'revise',
      briefVersion: null,
      feedbackIds: [a.id],
    });
    expect(p.feedbackIds).toEqual([a.id]);
    await workbench.resolveFeedback(projectId, [a.id], job.id);
    await workbench.resolveFeedback(projectId, [], job.id);
    expect((await workbench.listFeedback(projectId)).find((f) => f.id === a.id)?.resolvedBy).toBe(
      job.id,
    );
    expect(await workbench.deleteFeedback(projectId, a.id)).toBe('resolved');
    expect(await workbench.deleteFeedback(projectId, b.id)).toBe('deleted');
    expect(await workbench.deleteFeedback(projectId, b.id)).toBe('not-found');
    expect(await workbench.deleteFeedback('other-project', a.id)).toBe('not-found');
    const other = await repo.createDraftJob(projectId, {});
    const q = await workbench.createProposal({
      id: other.id,
      projectId,
      stage: 'outputs',
      briefVersion: null,
    });
    expect(q.feedbackIds).toBeNull();
  });

  it('reports feedback resolved by a revision that lands just before its delete', async () => {
    const projectId = await newProject();
    const item = await workbench.createFeedback({
      projectId,
      target: 'field',
      targetId: 'sender',
      sampleId: null,
      iterationId: null,
      body: 'Use the letterhead',
    });
    const job = await repo.createDraftJob(projectId, {});
    await workbench.createProposal({
      id: job.id,
      projectId,
      stage: 'revise',
      briefVersion: null,
      feedbackIds: [item.id],
    });
    // A pool whose DELETE first lets a concurrent accept resolve the item.
    const racing = new pg.Pool({ connectionString: url, max: 2 });
    const query = racing.query.bind(racing) as (...args: unknown[]) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg's overloaded query
    (racing as any).query = async (...args: unknown[]) => {
      if (String(args[0]).trimStart().startsWith('DELETE FROM workbench_feedback')) {
        await workbench.resolveFeedback(projectId, [item.id], job.id);
      }
      return query(...args);
    };
    try {
      expect(await new PgWorkbenchRepo(racing).deleteFeedback(projectId, item.id)).toBe('resolved');
    } finally {
      await racing.end();
    }
    expect((await workbench.listFeedback(projectId)).map((f) => f.id)).toEqual([item.id]);
  });

  it('records stage skips newest first', async () => {
    const projectId = await newProject();
    const first = await workbench.addSkip(projectId, 'survey');
    const second = await workbench.addSkip(projectId, 'outputs');
    expect(second.skippedAt >= first.skippedAt).toBe(true);
    expect((await workbench.listSkips(projectId)).map((s) => s.stage)).toEqual([
      'outputs',
      'survey',
    ]);
    expect(await workbench.listSkips('no-such-project')).toEqual([]);
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

  it('stores reference and model override on workbench jobs; lists runs and references with sha', async () => {
    const projectId = await newProject();
    const plain = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'process' });
    const source = doc(projectId);
    const first = await repo.createWorkbenchJob(source, { projectId, task: 'process' });
    const reference = await repo.createReference({
      templateId: projectId,
      name: 'first',
      documentId: first.documentId,
      sourceJobId: first.id,
      expected: { fields: {}, tables: {} },
    });
    const evaluation = await repo.createWorkbenchJob(doc(projectId), {
      projectId,
      task: 'process',
      referenceId: reference.id,
      modelOverride: 'draft',
    });
    await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'prepare' });
    expect(plain).toMatchObject({ referenceId: null, modelOverride: null });
    expect(evaluation).toMatchObject({ referenceId: reference.id, modelOverride: 'draft' });

    const runs = await repo.listProjectRuns(projectId);
    expect(runs.map((r) => r.job.id)).toEqual([evaluation.id, first.id, plain.id]);
    expect(runs.find((r) => r.job.id === first.id)!.sha256).toBe(source.sha256);

    const refs = await repo.listReferencesWithSha(projectId);
    expect(refs.map((r) => [r.name, r.sha256])).toEqual([['first', source.sha256]]);
  });

  it('pins, supersedes and carries references forward across versions', async () => {
    const projectId = await newProject();
    const source = doc(projectId);
    const job = await repo.createWorkbenchJob(source, { projectId, task: 'process' });
    const other = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'process' });
    const outputs = { fields: [{ id: 'sender' }] };
    const base = {
      templateId: projectId,
      documentId: job.documentId,
      sourceJobId: job.id,
      expected: { fields: {}, tables: {} },
    };
    const first = await repo.createReference({
      ...base,
      name: 'a',
      templateVersion: 1,
      verifiedOutputs: outputs,
    });
    expect(first).toMatchObject({ templateVersion: 1, verifiedOutputs: outputs, supersededAt: null });
    const again = await repo.createReference({
      ...base,
      name: 'a',
      templateVersion: 1,
      verifiedOutputs: outputs,
    });
    expect((await repo.listReferences(projectId, 1)).map((r) => r.id)).toEqual([again.id]);
    const all = await repo.listReferencesWithSha(projectId);
    expect(all.find((r) => r.id === first.id)!.supersededAt).not.toBeNull();
    // a different sample under a taken name is refused, and the refusal changes nothing
    await expect(
      repo.createReference({
        ...base,
        documentId: other.documentId,
        sourceJobId: other.id,
        name: 'a',
        templateVersion: 1,
        verifiedOutputs: outputs,
      }),
    ).rejects.toThrow(ReferenceConflictError);
    expect((await repo.listReferences(projectId, 1)).map((r) => r.id)).toEqual([again.id]);

    const [n1, n2] = await Promise.all([
      repo.carryReferencesForward(projectId, 2),
      repo.carryReferencesForward(projectId, 2),
    ]);
    expect(n1 + n2).toBe(1);
    const v2 = await repo.listReferences(projectId, 2);
    expect(v2.map((r) => [r.name, r.copiedFrom, r.templateVersion, r.verifiedOutputs])).toEqual([
      ['a', again.id, 2, outputs],
    ]);
    expect((await repo.listReferences(projectId, 1)).map((r) => r.id)).toEqual([again.id]);
    expect(await repo.carryReferencesForward(projectId, 2)).toBe(0);

    const unpinned = await repo.createReference({ ...base, name: 'u' });
    expect(unpinned).toMatchObject({ templateVersion: null, verifiedOutputs: null });
    expect((await repo.listReferences(projectId, 9)).map((r) => r.id)).toEqual([unpinned.id]);

    // deleting the source keeps the copy (copied_from ON DELETE SET NULL)
    await repo.deleteReference(projectId, again.id);
    const copies = (await repo.listReferences(projectId, 2)).filter((r) => r.templateVersion === 2);
    expect(copies.map((r) => [r.id, r.copiedFrom])).toEqual([[v2[0]!.id, null]]);
  });

  it('records iterations and caches their scores', async () => {
    const projectId = await newProject();
    const input = {
      projectId,
      templateVersion: 1,
      definition: { id: projectId, version: 1 },
      briefVersion: null,
      set: 'dev' as const,
    };
    const jobId = randomUUID();
    const a = await workbench.createIteration({ ...input, model: null, jobIds: [jobId] });
    const b = await workbench.createIteration({ ...input, model: 'fast', jobIds: [] });
    expect(a).toMatchObject({ scores: null, jobIds: [jobId], model: null, set: 'dev' });
    expect((await workbench.listIterations(projectId)).map((i) => i.id)).toEqual([b.id, a.id]);
    await workbench.setIterationScores(a.id, { score: 0.5, completed: 1, total: 1 });
    expect(await workbench.getIteration(projectId, a.id)).toMatchObject({
      scores: { score: 0.5, completed: 1, total: 1 },
      definition: input.definition,
    });
    expect(await workbench.getIteration('it-other', a.id)).toBeNull();
    expect(a).toMatchObject({ groupId: null, uncached: false, sampleShas: null });
    const c = await workbench.createIteration({
      ...input,
      set: 'holdout',
      model: null,
      jobIds: [jobId],
      sampleShas: ['a'.repeat(64), 'b'.repeat(64)],
    });
    expect((await workbench.getIteration(projectId, c.id))!.sampleShas).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
    ]);
  });

  it('stores the publish threshold and logs publications as numbers, newest first', async () => {
    const projectId = await newProject();
    expect((await workbench.getProject(projectId))!.publishThreshold).toBe(0.9);
    expect((await workbench.setPublishThreshold(projectId, 0.75))!.publishThreshold).toBe(0.75);
    expect(await workbench.setPublishThreshold('it-nope', 0.5)).toBeNull();
    const holdout = await workbench.createIteration({
      projectId,
      templateVersion: 1,
      definition: {},
      briefVersion: null,
      set: 'holdout',
      model: null,
      jobIds: [],
    });
    expect((await workbench.getIteration(projectId, holdout.id))!.set).toBe('holdout');
    const a = await workbench.recordPublication({
      projectId,
      version: 1,
      iterationId: null,
      score: null,
      threshold: 0.75,
      overrideReason: 'First version, no holdout yet',
      publishedBy: 'admin',
    });
    const b = await workbench.recordPublication({
      projectId,
      version: 2,
      iterationId: holdout.id,
      score: 0.92,
      threshold: 0.75,
      overrideReason: null,
      publishedBy: null,
    });
    expect(a).toMatchObject({ score: null, threshold: 0.75 });
    expect(b).toMatchObject({ score: 0.92, threshold: 0.75, iterationId: holdout.id });
    expect((await workbench.listPublications(projectId)).map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it('groups comparison iterations and records uncached runs', async () => {
    const projectId = await newProject();
    const input = {
      projectId,
      templateVersion: 1,
      definition: { id: projectId, version: 1 },
      briefVersion: null,
      set: 'dev' as const,
      jobIds: [],
    };
    const groupId = randomUUID();
    const a = await workbench.createIteration({ ...input, model: 'default', groupId });
    const b = await workbench.createIteration({
      ...input,
      model: 'fast',
      groupId,
      uncached: true,
    });
    await workbench.createIteration({ ...input, model: 'draft' });
    expect(await workbench.getIteration(projectId, b.id)).toMatchObject({
      groupId,
      uncached: true,
    });
    expect((await workbench.listGroup(projectId, groupId)).map((i) => i.id)).toEqual([a.id, b.id]);
    expect(await workbench.listGroup('it-other', groupId)).toEqual([]);
  });

  it('reads step runs served from the step cache', async () => {
    const projectId = await newProject();
    const job = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'process' });
    await pool.query(
      `INSERT INTO step_runs (job_id, step_id, trigger, status, started_at, cached)
       VALUES ($1, 'head', 'process', 'succeeded', now(), true),
              ($1, 'tail', 'process', 'succeeded', now(), false)`,
      [job.id],
    );
    expect((await repo.listStepRuns(job.id)).map((r) => [r.stepId, r.cached])).toEqual([
      ['head', true],
      ['tail', false],
    ]);
  });
});
