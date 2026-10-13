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
import { EMPTY_BRIEF, outputChanges } from '@ih/shared';
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

  it('lists brief versions oldest first and reads one', async () => {
    const projectId = await newProject();
    expect(await workbench.listBriefs(projectId)).toEqual([]);
    await workbench.saveBrief(projectId, { ...EMPTY_BRIEF, purpose: 'a' });
    await workbench.saveBrief(projectId, { ...EMPTY_BRIEF, purpose: 'b' });
    expect((await workbench.listBriefs(projectId)).map((b) => [b.version, b.body.purpose])).toEqual(
      [
        [1, 'a'],
        [2, 'b'],
      ],
    );
    expect(await workbench.getBrief(projectId, 2)).toMatchObject({
      version: 2,
      body: { purpose: 'b' },
    });
    expect(await workbench.getBrief(projectId, 3)).toBeNull();
  });

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

  it('creates a finished draft job that is listed and never claimable', async () => {
    const projectId = await newProject();
    const params = { stage: 'survey', dataPolicy: 'local', imported: true };
    const job = await repo.createFinishedDraftJob(projectId, params);
    expect(job).toMatchObject({ projectId, status: 'succeeded', error: null });
    expect((await repo.listDraftJobs(projectId)).map((j) => [j.id, j.status])).toEqual([
      [job.id, 'succeeded'],
    ]);
    const { rows } = await pool.query<{
      task: string;
      test: boolean;
      priority: number;
      document_id: string | null;
      params: Record<string, unknown>;
    }>('SELECT task, test, priority, document_id, params FROM jobs WHERE id = $1', [job.id]);
    expect(rows[0]).toEqual({
      task: 'draft',
      test: true,
      priority: -10,
      document_id: null,
      params,
    });
  });

  it('lists job reviews with their edits in one query, edits in id order with ISO times', async () => {
    const projectId = await newProject();
    const a = await repo.createWorkbenchJob(doc(projectId), {
      projectId,
      task: 'process',
      modelOverride: 'draft',
    });
    const b = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'process' });
    await pool.query(`UPDATE jobs SET status = 'awaiting_review' WHERE id = $1`, [a.id]);
    const first = await repo.addEdit(a.id, {
      field: 'total',
      table: null,
      row: null,
      column: null,
      oldValue: '1',
      newValue: '2',
      editor: 'kim',
      reason: null,
    });
    const second = await repo.addEdit(a.id, {
      field: null,
      table: 'line_items',
      row: 2,
      column: 'qty',
      oldValue: null,
      newValue: 5,
      editor: 'kim',
      reason: 'missing',
    });
    await repo.approve(a.id, 'ken', null);
    await pool.query(`UPDATE jobs SET status = 'succeeded' WHERE id = $1`, [a.id]);

    const reviews = await repo.listJobReviews([b.id, a.id, randomUUID()]);
    const byId = new Map(reviews.map((r) => [r.jobId, r]));
    expect(reviews).toHaveLength(2);
    expect(byId.get(a.id)).toEqual({
      jobId: a.id,
      status: 'succeeded',
      reviewer: 'ken',
      reviewedAt: expect.stringMatching(/Z$/),
      modelOverride: 'draft',
      edits: [first, second],
    });
    expect(byId.get(b.id)).toMatchObject({
      status: 'queued',
      reviewer: null,
      reviewedAt: null,
      edits: [],
    });
    expect(await repo.listJobReviews([])).toEqual([]);
  });

  it('keeps one export job per project, even when two start at once', async () => {
    const projectId = await newProject();
    const other = await newProject();
    const elsewhere = await repo.createExportJob(other, { stage: 'export' });
    const draft = await repo.createDraftJob(projectId, { stage: 'survey' });
    // Concurrent starts on a project with no export yet: without the lock both would miss the
    // other's insert and two exports would remain.
    const started = await Promise.all(
      [1, 2, 3, 4].map((n) => repo.createExportJob(projectId, { stage: 'export', n })),
    );
    const listed = await repo.listExportJobs(projectId);
    expect(listed).toHaveLength(1);
    const survivor = listed[0]!;
    expect(listed[0]).toMatchObject({ projectId, status: 'queued', error: null });
    // Every other export was removed exactly once, by the call that ran after it.
    const ids = started.map((s) => s.job.id);
    expect(ids).toContain(survivor.id);
    expect(started.flatMap((s) => s.removed).sort()).toEqual(
      ids.filter((id) => id !== survivor.id).sort(),
    );

    const next = await repo.createExportJob(projectId, { stage: 'export', n: 5 });
    expect(next.removed).toEqual([survivor.id]);
    expect((await repo.listExportJobs(projectId)).map((j) => j.id)).toEqual([next.job.id]);
    expect(await repo.getJobParams(next.job.id)).toEqual({ stage: 'export', n: 5 });
    const { rows } = await pool.query<{ test: boolean; priority: number; max_attempts: number }>(
      'SELECT test, priority, max_attempts FROM jobs WHERE id = $1',
      [next.job.id],
    );
    expect(rows[0]).toEqual({ test: true, priority: -10, max_attempts: 3 });

    // Other projects' exports and this project's draft jobs are untouched; none is a JobSummary.
    expect((await repo.listExportJobs(other)).map((j) => j.id)).toEqual([elsewhere.job.id]);
    expect((await repo.listDraftJobs(projectId)).map((j) => j.id)).toEqual([draft.id]);
    expect(await repo.listProjectJobs(projectId)).toEqual([]);
  });

  it('reads the newest event per job and message', async () => {
    const projectId = await newProject();
    const opts = { projectId, task: 'prepare' as const, params: { dataPolicy: 'local' } };
    const a = await repo.createWorkbenchJob(doc(projectId), opts);
    const b = await repo.createWorkbenchJob(doc(projectId), opts);
    const add = (jobId: string, message: string, data: unknown) =>
      pool.query(
        `INSERT INTO job_events (job_id, level, message, data) VALUES ($1, 'info', $2, $3)`,
        [jobId, message, JSON.stringify(data)],
      );
    await add(a.id, 'prepare progress', { stage: 'text', page: 2, of: 2 });
    await add(a.id, 'prepare progress', { stage: 'ocr', page: 1, of: 2 });
    await add(a.id, 'prepared', { pages: 2 });
    await add(b.id, 'prepare failed', { code: 'password', message: 'locked' });

    const events = await repo.latestEvents([a.id, b.id], ['prepare progress', 'prepare failed']);
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          jobId: a.id,
          message: 'prepare progress',
          data: { stage: 'ocr', page: 1, of: 2 },
          at: expect.any(String),
        },
        {
          jobId: b.id,
          message: 'prepare failed',
          data: { code: 'password', message: 'locked' },
          at: expect.any(String),
        },
      ]),
    );
    expect(await repo.latestEvents([], ['prepare progress'])).toEqual([]);
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

  it('records confirmations newest first', async () => {
    const projectId = await newProject();
    const first = await workbench.addConfirm(projectId, 'sections', '2026-10-13T09:00:00.000Z');
    const second = await workbench.addConfirm(projectId, 'steps', '2026-10-13T09:30:00.000Z');
    expect(first).toMatchObject({ projectId, stage: 'sections', upTo: '2026-10-13T09:00:00.000Z' });
    expect(second.confirmedAt >= first.confirmedAt).toBe(true);
    expect((await workbench.listConfirms(projectId)).map((c) => c.stage)).toEqual([
      'steps',
      'sections',
    ]);
    await expect(
      pool.query(
        `INSERT INTO workbench_stage_confirms (project_id, stage, up_to) VALUES ($1, 'survey', now())`,
        [projectId],
      ),
    ).rejects.toThrow(/check constraint/);
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
    expect(first).toMatchObject({
      templateVersion: 1,
      verifiedOutputs: outputs,
      supersededAt: null,
    });
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

    // copies keep the source's created_at
    expect(v2[0]!.createdAt).toBe(again.createdAt);

    // deleting a pinned source supersedes it: the copy keeps its link
    expect(await repo.deleteReference(projectId, again.id)).toBe(true);
    expect(await repo.deleteReference(projectId, again.id)).toBe(false);
    const copies = (await repo.listReferences(projectId, 2)).filter((r) => r.templateVersion === 2);
    expect(copies.map((r) => [r.id, r.copiedFrom])).toEqual([[v2[0]!.id, again.id]]);
    expect(
      (await repo.listReferences(projectId, 1)).filter((r) => r.templateVersion === 1),
    ).toEqual([]);
    // an unpinned reference is removed outright
    expect(await repo.deleteReference(projectId, unpinned.id)).toBe(true);
    expect((await repo.listReferencesWithSha(projectId)).map((r) => r.id)).not.toContain(
      unpinned.id,
    );

    // deleting every carried reference: the version keeps its (superseded) rows, no re-carry
    expect(await repo.deleteReference(projectId, v2[0]!.id)).toBe(true);
    expect(await repo.carryReferencesForward(projectId, 2)).toBe(0);
    expect(await repo.listReferences(projectId, 2)).toEqual([]);
  });

  it('carries an emptied version forward as empty, never the version before it', async () => {
    const projectId = await newProject();
    const job = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'process' });
    await repo.createReference({
      templateId: projectId,
      name: 'a',
      documentId: job.documentId,
      sourceJobId: job.id,
      expected: { fields: {}, tables: {} },
      templateVersion: 1,
      verifiedOutputs: {},
    });
    expect(await repo.carryReferencesForward(projectId, 2)).toBe(1);
    for (const r of await repo.listReferences(projectId, 2)) {
      expect(await repo.deleteReference(projectId, r.id)).toBe(true);
    }
    expect(await repo.carryReferencesForward(projectId, 3)).toBe(0);
    expect(await repo.listReferences(projectId, 3)).toEqual([]);
    expect((await repo.listReferences(projectId, 1)).map((r) => r.name)).toEqual(['a']);
  });

  it('stores params on document jobs and regression jobs', async () => {
    const projectId = await newProject();
    const outputs = { fields: [{ id: 'sender' }] };
    const job = await repo.createDocumentAndJob(doc(projectId), null, true, null, { outputs });
    expect(await paramsOf(job.id)).toEqual({ outputs });
    const plain = await repo.createDocumentAndJob(doc(projectId), null);
    expect(await paramsOf(plain.id)).toBeNull();
    const reference = await repo.createReference({
      templateId: projectId,
      name: 'r',
      documentId: job.documentId,
      sourceJobId: job.id,
      expected: { fields: {}, tables: {} },
    });
    const regression = await repo.createRegressionJob(reference, 2, { outputs });
    expect(await paramsOf(regression.id)).toEqual({ outputs });
    expect(await paramsOf((await repo.createRegressionJob(reference, 2)).id)).toBeNull();
  });

  it('marks a model curated only while its endpoint exists and is enabled', async () => {
    const on = `it-on-${randomUUID().slice(0, 8)}`;
    const off = `it-off-${randomUUID().slice(0, 8)}`;
    const gone = `it-gone-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO llm_endpoints (name, kind, enabled) VALUES ($1, 'openai-chat', true),
              ($2, 'openai-chat', false)`,
      [on, off],
    );
    await pool.query(
      `INSERT INTO llm_models (provider, provider_kind, model_id, curated) VALUES
         ($1, 'openai-chat', 'picked', true), ($1, 'openai-chat', 'found', false),
         ($2, 'openai-chat', 'picked', true), ($3, 'openai-chat', 'picked', true)`,
      [on, off, gone],
    );
    const mine = (await repo.listModels()).filter((m) => [on, off, gone].includes(m.provider));
    expect(mine.map((m) => [m.ref, m.curated])).toEqual(
      [
        [`${on}/found`, false],
        [`${on}/picked`, true],
        [`${off}/picked`, false],
        [`${gone}/picked`, false],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  });

  it('stores who queued a job and lists only their jobs', async () => {
    const projectId = await newProject();
    const label = `it-user-${randomUUID().slice(0, 8)}`;
    const mine = await repo.createDocumentAndJob(doc(projectId), null, false, null, null, label);
    expect(mine.createdBy).toBe(label);
    const sample = await repo.createWorkbenchJob(doc(projectId), {
      projectId,
      task: 'process',
      createdBy: label,
    });
    expect(sample.createdBy).toBe(label);
    const other = await repo.createDocumentAndJob(doc(projectId), null);
    expect(other.createdBy).toBeNull();
    const reference = await repo.createReference({
      templateId: projectId,
      name: 'r',
      documentId: mine.documentId,
      sourceJobId: mine.id,
      expected: { fields: {}, tables: {} },
    });
    const regression = await repo.createRegressionJob(reference, 2, null, label);
    expect(regression.createdBy).toBe(label);
    const listed = await repo.listJobs({ limit: 10, createdBy: label });
    expect(listed.map((j) => j.id).sort()).toEqual([mine.id, sample.id, regression.id].sort());
    expect(await repo.listJobs({ limit: 10, createdBy: label, status: 'failed' })).toEqual([]);
  });

  it('refreshes the outputs snapshot on retry, keeping the other params', async () => {
    const projectId = await newProject();
    const job = await repo.createWorkbenchJob(doc(projectId), {
      projectId,
      task: 'process',
      params: { dataPolicy: 'local', outputs: { fields: [] } },
    });
    await pool.query(`UPDATE jobs SET status = 'failed' WHERE id = $1`, [job.id]);
    const outputs = { fields: [{ id: 'sender' }] };
    expect(await repo.retryJob(job.id, { outputs })).not.toBeNull();
    expect(await paramsOf(job.id)).toEqual({ dataPolicy: 'local', outputs });
    const plain = await repo.createDocumentAndJob(doc(projectId), null, true);
    await pool.query(`UPDATE jobs SET status = 'failed' WHERE id = $1`, [plain.id]);
    expect(await repo.retryJob(plain.id, { outputs: null })).not.toBeNull();
    expect(await paramsOf(plain.id)).toEqual({ outputs: null });
    await pool.query(`UPDATE jobs SET status = 'failed' WHERE id = $1`, [plain.id]);
    expect(await repo.retryJob(plain.id)).not.toBeNull();
    expect(await paramsOf(plain.id)).toEqual({ outputs: null }); // untouched without the option
  });

  it('serializes concurrent saves of the same PDF at one version', async () => {
    const projectId = await newProject();
    const source = doc(projectId);
    const job = await repo.createWorkbenchJob(source, { projectId, task: 'process' });
    const twin = await repo.createWorkbenchJob(
      { ...doc(projectId), sha256: source.sha256 },
      { projectId, task: 'process' },
    );
    const save = (j: { id: string; documentId: string }, name: string) =>
      repo.createReference({
        templateId: projectId,
        name,
        documentId: j.documentId,
        sourceJobId: j.id,
        expected: { fields: {}, tables: {} },
        templateVersion: 1,
        verifiedOutputs: {},
      });
    for (let i = 0; i < 5; i++) {
      await Promise.all([save(job, `a${i}`), save(twin, `b${i}`)]);
      expect(await repo.listReferences(projectId, 1)).toHaveLength(1);
    }
  });

  it('keeps a backfilled pre-5b reference unpinned, never carried, with its verified outputs', async () => {
    const projectId = await newProject();
    const job = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'process' });
    const outputs = { fields: [{ id: 'sender', type: 'text' }] };
    // the shape migration 0018 leaves: template_version NULL, verified_outputs set
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO template_references
         (template_id, name, document_id, source_job_id, expected, verified_outputs)
       VALUES ($1, 'legacy', $2, $3, '{}', $4) RETURNING id`,
      [projectId, job.documentId, job.id, JSON.stringify(outputs)],
    );
    const id = rows[0]!.id;
    expect(await repo.carryReferencesForward(projectId, 2)).toBe(0);
    const [legacy] = await repo.listReferences(projectId, 2);
    expect(legacy).toMatchObject({ id, templateVersion: null, verifiedOutputs: outputs });
    // what the Workbench and regression compute against v2's outputs
    expect(outputChanges(legacy!.verifiedOutputs, outputs)).toEqual([]);
    expect(
      outputChanges(legacy!.verifiedOutputs, { fields: [{ id: 'sender', type: 'date' }] }),
    ).toEqual(['field:sender']);
  });

  it('reads job params', async () => {
    const projectId = await newProject();
    const job = await repo.createWorkbenchJob(doc(projectId), {
      projectId,
      task: 'process',
      params: { forceReview: true, outputs: { fields: [] } },
    });
    expect(await repo.getJobParams(job.id)).toEqual({ forceReview: true, outputs: { fields: [] } });
    expect(await repo.getJobParams(randomUUID())).toBeNull();
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

  it('stores the publish gate cache of an iteration', async () => {
    const projectId = await newProject();
    const i = await workbench.createIteration({
      projectId,
      templateVersion: 1,
      definition: { id: projectId, version: 1 },
      briefVersion: null,
      set: 'holdout',
      model: null,
      jobIds: [randomUUID()],
    });
    expect(i.gateCache).toBeNull();
    const hints = [
      { key: 'sent_on', accuracy: 0.5, cause: 'low_accuracy' as const, stage: 'revise' as const },
      { key: 'lines.qty', accuracy: 0, cause: 'no_step' as const, stage: 'steps' as const },
    ];
    const cache = {
      fingerprint: 'f'.repeat(64),
      score: 0.75,
      completed: 3,
      total: 4,
      hints,
      hintsThreshold: 0.9,
    };
    await workbench.setGateCache(i.id, cache);
    expect((await workbench.getIteration(projectId, i.id))!.gateCache).toEqual(cache);
    const unscored = { fingerprint: 'e'.repeat(64), score: null, completed: 0, total: 1 };
    await workbench.setGateCache(i.id, unscored);
    expect((await workbench.listIterations(projectId))[0]!.gateCache).toEqual(unscored);
  });

  it('stores the publish threshold and logs publications as numbers, newest first', async () => {
    const projectId = await newProject();
    expect((await workbench.getProject(projectId))!.publishThreshold).toBe(0.9);
    expect(await workbench.getProject(projectId)).toMatchObject({
      thresholdSetBy: null,
      thresholdSetAt: null,
    });
    const set = (await workbench.setPublishThreshold(projectId, 0.75, 'ken'))!;
    expect(set).toMatchObject({ publishThreshold: 0.75, thresholdSetBy: 'ken' });
    expect(Number.isNaN(Date.parse(set.thresholdSetAt!))).toBe(false);
    expect(await workbench.setPublishThreshold('it-nope', 0.5, null)).toBeNull();
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

  describe('publishDraft', () => {
    const definition = { id: 'x', version: 1, outputs: { fields: [] }, name: 'Letter' };
    const draftOf = async () => {
      const projectId = await newProject();
      await pool.query(
        `INSERT INTO templates (id, version, status, definition) VALUES ($1, 1, 'draft', $2)`,
        [projectId, JSON.stringify(definition)],
      );
      return projectId;
    };
    const publication = (projectId: string) => ({
      projectId,
      version: 1,
      iterationId: null,
      score: 0.95,
      threshold: 0.9,
      overrideReason: null,
      publishedBy: 'ken',
    });
    const statusOf = async (projectId: string) =>
      (
        await pool.query<{ status: string; published_at: Date | null }>(
          'SELECT status, published_at FROM templates WHERE id = $1 AND version = 1',
          [projectId],
        )
      ).rows[0]!;

    it('publishes the draft and records the publication together', async () => {
      const projectId = await draftOf();
      const result = await workbench.publishDraft({
        projectId,
        version: 1,
        // Key order differs from the stored jsonb: compared as stable JSON.
        definition: { name: 'Letter', outputs: { fields: [] }, version: 1, id: 'x' },
        publication: publication(projectId),
      });
      expect(result.result).toBe('published');
      expect(await statusOf(projectId)).toMatchObject({ status: 'published' });
      expect((await statusOf(projectId)).published_at).not.toBeNull();
      const listed = await workbench.listPublications(projectId);
      expect(result).toEqual({ result: 'published', publication: listed[0] });
      expect(listed[0]).toMatchObject(publication(projectId));
    });

    it('writes nothing when the draft changed or is not an open draft', async () => {
      const projectId = await draftOf();
      const input = { projectId, version: 1, publication: publication(projectId) };
      expect(
        await workbench.publishDraft({ ...input, definition: { ...definition, name: 'Old' } }),
      ).toEqual({ result: 'changed' });
      expect(await workbench.publishDraft({ ...input, version: 2, definition })).toEqual({
        result: 'not-draft',
      });
      expect(await statusOf(projectId)).toMatchObject({ status: 'draft' });
      await pool.query(`UPDATE templates SET status = 'published' WHERE id = $1`, [projectId]);
      expect(await workbench.publishDraft({ ...input, definition })).toEqual({
        result: 'not-draft',
      });
      expect(await workbench.listPublications(projectId)).toEqual([]);
    });

    it('rolls the publish back when the publication insert fails', async () => {
      const projectId = await draftOf();
      await expect(
        workbench.publishDraft({
          projectId,
          version: 1,
          definition,
          // No such iteration: the foreign key fails the INSERT inside the transaction.
          publication: { ...publication(projectId), iterationId: randomUUID() },
        }),
      ).rejects.toThrow(/foreign key/);
      expect(await statusOf(projectId)).toEqual({ status: 'draft', published_at: null });
      expect(await workbench.listPublications(projectId)).toEqual([]);
    });
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

  it('deletes a project with every row it owns in one call, and leaves another project alone', async () => {
    /** A project with samples, jobs of every kind, a reference, iterations and the rest. */
    const populate = async () => {
      const projectId = await newProject();
      const sampleDoc = doc(projectId);
      const prepare = await repo.createWorkbenchJob(sampleDoc, { projectId, task: 'prepare' });
      await workbench.addSample({
        projectId,
        documentId: prepare.documentId,
        role: 'dev',
        addedForVersion: 1,
      });
      await workbench.saveBrief(projectId, EMPTY_BRIEF);
      await workbench.addSkip(projectId, 'survey');
      await workbench.addConfirm(projectId, 'outputs', new Date().toISOString());
      const source = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'process' });
      const reference = await repo.createReference({
        templateId: projectId,
        name: 'first',
        documentId: source.documentId,
        sourceJobId: source.id,
        expected: { fields: {}, tables: {} },
      });
      const run = await repo.createWorkbenchJob(doc(projectId), {
        projectId,
        task: 'process',
        referenceId: reference.id,
      });
      await pool.query(
        `INSERT INTO job_outputs (job_id, output_id, format, bucket, object_key, stage)
         VALUES ($1, 'document', 'json', 'outputs', $2, 'draft')`,
        [run.id, `${projectId}/draft.json`],
      );
      await pool.query(
        `INSERT INTO step_runs (job_id, step_id, trigger, status, started_at)
         VALUES ($1, 'head', 'process', 'succeeded', now())`,
        [run.id],
      );
      await pool.query(`INSERT INTO job_events (job_id, level, message) VALUES ($1, 'info', 'x')`, [
        run.id,
      ]);
      const iteration = await workbench.createIteration({
        projectId,
        templateVersion: 1,
        definition: {},
        briefVersion: 1,
        set: 'dev',
        model: null,
        jobIds: [run.id],
      });
      const draft = await repo.createDraftJob(projectId, { stage: 'outputs' });
      const proposal = await workbench.createProposal({
        id: draft.id,
        projectId,
        stage: 'outputs',
        briefVersion: 1,
      });
      const feedback = await workbench.createFeedback({
        projectId,
        target: 'field',
        targetId: 'sender',
        sampleId: null,
        iterationId: iteration.id,
        body: 'Use the letterhead',
      });
      await workbench.resolveFeedback(projectId, [feedback.id], proposal.id);
      await workbench.recordPublication({
        projectId,
        version: 1,
        iterationId: iteration.id,
        score: 1,
        threshold: 0.9,
        overrideReason: null,
        publishedBy: null,
      });
      await repo.createSegmentJob(projectId, segmentParams);
      await repo.createExportJob(projectId, { stage: 'export' });
      // A Templates-page test upload of the type: a test job with no project.
      const upload = await repo.createDocumentAndJob(doc(projectId), null, true);
      await pool.query(
        `INSERT INTO templates (id, version, status, definition) VALUES ($1, 1, 'draft', '{}')`,
        [projectId],
      );
      return { projectId, sampleDoc, run, upload };
    };
    const counts = async (projectId: string) => {
      const { rows } = await pool.query<Record<string, number>>(
        `SELECT
           (SELECT count(*)::int FROM workbench_projects WHERE id = $1) AS projects,
           (SELECT count(*)::int FROM workbench_samples WHERE project_id = $1) AS samples,
           (SELECT count(*)::int FROM workbench_briefs WHERE project_id = $1) AS briefs,
           (SELECT count(*)::int FROM workbench_stage_skips WHERE project_id = $1) AS skips,
           (SELECT count(*)::int FROM workbench_stage_confirms WHERE project_id = $1) AS confirms,
           (SELECT count(*)::int FROM workbench_proposals WHERE project_id = $1) AS proposals,
           (SELECT count(*)::int FROM workbench_iterations WHERE project_id = $1) AS iterations,
           (SELECT count(*)::int FROM workbench_feedback WHERE project_id = $1) AS feedback,
           (SELECT count(*)::int FROM workbench_publications WHERE project_id = $1) AS publications,
           (SELECT count(*)::int FROM template_references WHERE template_id = $1) AS refs,
           (SELECT count(*)::int FROM jobs WHERE project_id = $1) AS jobs,
           (SELECT count(*)::int FROM documents WHERE spec_id = $1) AS documents,
           (SELECT count(*)::int FROM templates WHERE id = $1) AS templates`,
        [projectId],
      );
      return rows[0]!;
    };
    const target = await populate();
    const other = await populate();
    const before = await counts(other.projectId);
    expect(Object.values(before).every((n) => n > 0)).toBe(true);

    const removed = await workbench.deleteProject(target.projectId);
    if (!removed || removed === 'published') throw new Error(`not deleted: ${removed}`);
    // prepare, source, run, draft, segment and export jobs, and the project-less test upload.
    expect(removed.jobs).toHaveLength(7);
    expect(removed.jobs.map((j) => j.jobId)).toContain(target.upload.id);
    expect(removed.jobs.find((j) => j.jobId === target.run.id)!.draftObjects).toEqual([
      { bucket: 'outputs', key: `${target.projectId}/draft.json` },
    ]);
    expect(removed.documents).toHaveLength(4);
    expect(removed.documents).toContainEqual({ bucket: 'inbox', key: target.sampleDoc.objectKey });

    expect(Object.values(await counts(target.projectId)).every((n) => n === 0)).toBe(true);
    const orphans = await pool.query(
      `SELECT 1 FROM job_outputs WHERE job_id = $1
       UNION ALL SELECT 1 FROM step_runs WHERE job_id = $1
       UNION ALL SELECT 1 FROM job_events WHERE job_id = $1`,
      [target.run.id],
    );
    expect(orphans.rowCount).toBe(0);
    expect(await counts(other.projectId)).toEqual(before);
    expect(await workbench.deleteProject(target.projectId)).toBeNull();
  });

  describe('deleteProject against publishDraft', () => {
    const definition = { id: 'x', version: 1, outputs: { fields: [] } };
    const projectWithDraft = async () => {
      const projectId = await newProject();
      const prepare = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'prepare' });
      await workbench.addSample({
        projectId,
        documentId: prepare.documentId,
        role: 'dev',
        addedForVersion: 1,
      });
      await pool.query(
        `INSERT INTO templates (id, version, status, definition) VALUES ($1, 1, 'draft', $2)`,
        [projectId, JSON.stringify(definition)],
      );
      return projectId;
    };
    const publish = (projectId: string) =>
      workbench.publishDraft({
        projectId,
        version: 1,
        definition,
        publication: {
          projectId,
          version: 1,
          iterationId: null,
          score: null,
          threshold: 0.9,
          overrideReason: 'integration race',
          publishedBy: null,
        },
      });
    const state = async (projectId: string) =>
      (
        await pool.query<Record<string, number>>(
          `SELECT
             (SELECT count(*)::int FROM workbench_projects WHERE id = $1) AS projects,
             (SELECT count(*)::int FROM workbench_samples WHERE project_id = $1) AS samples,
             (SELECT count(*)::int FROM workbench_publications WHERE project_id = $1) AS publications,
             (SELECT count(*)::int FROM templates WHERE id = $1 AND status = 'published') AS published,
             (SELECT count(*)::int FROM templates WHERE id = $1) AS templates`,
          [projectId],
        )
      ).rows[0]!;

    it('refuses a published type and writes nothing', async () => {
      const projectId = await projectWithDraft();
      await pool.query(
        `INSERT INTO templates (id, version, status, definition) VALUES ($1, 2, 'draft', '{}')`,
        [projectId],
      );
      expect((await publish(projectId)).result).toBe('published');
      expect(await workbench.deleteProject(projectId)).toBe('published');
      expect(await state(projectId)).toEqual({
        projects: 1,
        samples: 1,
        publications: 1,
        published: 1,
        templates: 2,
      });
    });

    it('never deadlocks and leaves one consistent outcome when both run at once', async () => {
      for (let round = 0; round < 8; round++) {
        const projectId = await projectWithDraft();
        // Alternate which call is issued first.
        const [published, deleted] =
          round % 2 === 0
            ? await Promise.all([publish(projectId), workbench.deleteProject(projectId)])
            : await Promise.all([workbench.deleteProject(projectId), publish(projectId)]).then(
                ([d, p]) => [p, d] as const,
              );
        if (published.result === 'published') {
          expect(deleted).toBe('published');
          expect(await state(projectId)).toEqual({
            projects: 1,
            samples: 1,
            publications: 1,
            published: 1,
            templates: 1,
          });
        } else {
          expect(published).toEqual({ result: 'not-draft' });
          expect(deleted).toMatchObject({ jobs: expect.any(Array) });
          expect(await state(projectId)).toEqual({
            projects: 0,
            samples: 0,
            publications: 0,
            published: 0,
            templates: 0,
          });
        }
      }
    });
  });
  describe('project list support', () => {
    const fingerprintOf = async (id: string) =>
      (await workbench.projectFingerprints()).find((f) => f.id === id)!;

    it('moves the fingerprint on every input the overview reads, and only for that project', async () => {
      const projectId = await newProject();
      const other = await newProject();
      await pool.query(
        `INSERT INTO templates (id, version, status, definition) VALUES ($1, 1, 'draft', '{}')`,
        [projectId],
      );
      const prepare = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'prepare' });
      const sample = await workbench.addSample({
        projectId,
        documentId: prepare.documentId,
        role: 'dev',
        addedForVersion: 1,
      });
      const otherBefore = await fingerprintOf(other);
      expect(await fingerprintOf(projectId)).toEqual(await fingerprintOf(projectId));

      // Each input applied in turn; every one must move the fingerprint.
      const inputs: [string, () => Promise<unknown>][] = [];
      const add = (label: string, change: () => Promise<unknown>) => inputs.push([label, change]);
      // A worker status write; this one deliberately leaves updated_at alone.
      add('job status', () =>
        pool.query(`UPDATE jobs SET status = 'succeeded' WHERE id = $1`, [prepare.id]),
      );
      add('job updated_at', () =>
        pool.query(`UPDATE jobs SET updated_at = now() WHERE id = $1`, [prepare.id]),
      );
      let draftJobId = '';
      add('draft job created', async () => {
        draftJobId = (await repo.createDraftJob(projectId, { stage: 'survey' })).id;
      });
      add('draft job status', () =>
        pool.query(`UPDATE jobs SET status = 'running' WHERE id = $1`, [draftJobId]),
      );
      let extraDoc = '';
      add('prepare job created', async () => {
        const job = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'prepare' });
        extraDoc = job.documentId;
      });
      add('sample added', () =>
        workbench.addSample({ projectId, documentId: extraDoc, role: 'dev', addedForVersion: 1 }),
      );
      add('sample role', () => workbench.setSampleRole(projectId, sample.id, 'holdout'));
      add('sample role back', () => workbench.setSampleRole(projectId, sample.id, 'dev'));
      add('brief saved', () => workbench.saveBrief(projectId, EMPTY_BRIEF));
      add('template draft edit', () =>
        pool.query(
          `UPDATE templates SET definition = '{"x":1}', updated_at = now() WHERE id = $1`,
          [projectId],
        ),
      );
      add('threshold', () => workbench.setPublishThreshold(projectId, 0.75, 'me'));
      add('data policy', () => workbench.setDataPolicy(projectId, 'external', 'me'));
      add('name', () =>
        pool.query(`UPDATE workbench_projects SET name = 'Renamed' WHERE id = $1`, [projectId]),
      );
      add('stage skip', () => workbench.addSkip(projectId, 'survey'));
      add('stage skip deleted', () =>
        pool.query('DELETE FROM workbench_stage_skips WHERE project_id = $1', [projectId]),
      );
      add('stage confirm', () =>
        workbench.addConfirm(projectId, 'sections', new Date().toISOString()),
      );
      add('proposal created', () =>
        workbench.createProposal({
          id: draftJobId,
          projectId,
          stage: 'survey',
          briefVersion: null,
        }),
      );
      add('proposal decided', () => workbench.decideProposal(projectId, draftJobId, 'accepted'));
      let iterationId = '';
      add('iteration created', async () => {
        const iteration = await workbench.createIteration({
          projectId,
          templateVersion: 1,
          definition: {},
          briefVersion: null,
          set: 'holdout',
          model: null,
          jobIds: [],
        });
        iterationId = iteration.id;
      });
      add('iteration scored', () =>
        workbench.setIterationScores(iterationId, { score: 1, completed: 0, total: 0 }),
      );
      add('gate cache', () =>
        workbench.setGateCache(iterationId, { fingerprint: 'f', score: 1, completed: 0, total: 0 }),
      );
      const feedback = (targetId: string) =>
        workbench.createFeedback({
          projectId,
          target: 'field',
          targetId,
          sampleId: null,
          iterationId: null,
          body: 'wrong',
        });
      let resolvedId = '';
      let openId = '';
      add('feedback added', async () => {
        resolvedId = (await feedback('x')).id;
      });
      add('feedback resolved', () =>
        workbench.resolveFeedback(projectId, [resolvedId], draftJobId),
      );
      add('more feedback added', async () => {
        openId = (await feedback('y')).id;
      });
      add('feedback deleted', () => workbench.deleteFeedback(projectId, openId));
      let referenceId = '';
      add('reference saved', async () => {
        const reference = await repo.createReference({
          templateId: projectId,
          name: 'a',
          documentId: prepare.documentId,
          sourceJobId: prepare.id,
          expected: { fields: {}, tables: {} },
          templateVersion: 1,
          verifiedOutputs: {},
        });
        referenceId = reference.id;
      });
      add('reference superseded', () => repo.deleteReference(projectId, referenceId));
      add('publication', () =>
        workbench.recordPublication({
          projectId,
          version: 1,
          iterationId: null,
          score: null,
          threshold: 0.9,
          overrideReason: null,
          publishedBy: null,
        }),
      );
      add('template published', () =>
        pool.query(`UPDATE templates SET status = 'published' WHERE id = $1`, [projectId]),
      );
      add('sample removed', () => workbench.removeSample(projectId, sample.id));
      add('job deleted', () => pool.query('DELETE FROM jobs WHERE id = $1', [prepare.id]));

      const moved: string[] = [];
      for (const [label, change] of inputs) {
        const before = (await fingerprintOf(projectId)).fingerprint;
        await change();
        if ((await fingerprintOf(projectId)).fingerprint !== before) moved.push(label);
      }
      expect(moved).toEqual(inputs.map(([label]) => label));
      expect(await fingerprintOf(other)).toEqual(otherBefore);
    });

    it('moves lastActivityAt forward after adding a sample', async () => {
      const projectId = await newProject();
      const before = (await fingerprintOf(projectId)).lastActivityAt;
      expect(before).toBe((await workbench.getProject(projectId))!.createdAt);
      const job = await repo.createWorkbenchJob(doc(projectId), { projectId, task: 'prepare' });
      // Only the sample's own time counts here.
      await pool.query(`UPDATE jobs SET updated_at = '2000-01-01T00:00:00Z' WHERE id = $1`, [
        job.id,
      ]);
      await workbench.addSample({
        projectId,
        documentId: job.documentId,
        role: 'dev',
        addedForVersion: 1,
      });
      expect((await fingerprintOf(projectId)).lastActivityAt > before).toBe(true);
    });

    it('upserts the list cache and ignores an unknown project', async () => {
      const projectId = await newProject();
      await workbench.putListCache(projectId, 'f1', { name: 'one' });
      await workbench.putListCache(projectId, 'f2', { name: 'two' });
      await workbench.putListCache('it-missing-project', 'f1', {});
      const cache = await workbench.listCache();
      expect(cache.get(projectId)).toEqual({ fingerprint: 'f2', item: { name: 'two' } });
      expect(cache.has('it-missing-project')).toBe(false);
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM workbench_list_cache WHERE project_id = $1',
        [projectId],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('pins per owner, newest first, and unpins idempotently', async () => {
      const a = await newProject();
      const b = await newProject();
      const owner = `owner-${randomUUID()}`;
      expect(await workbench.listPins(owner)).toEqual([]);
      expect(await workbench.pin(owner, a)).toBe(true);
      expect(await workbench.pin(owner, b)).toBe(true);
      expect(await workbench.pin(owner, 'it-missing-project')).toBe(false);
      expect(await workbench.pin(`${owner}-2`, a)).toBe(true);
      expect(await workbench.listPins(owner)).toEqual([b, a]);
      await workbench.unpin(owner, b);
      await workbench.unpin(owner, b);
      expect(await workbench.listPins(owner)).toEqual([a]);
      expect(await workbench.listPins(`${owner}-2`)).toEqual([a]);
    });

    it('drops the cache row and pins with the project', async () => {
      const projectId = await newProject();
      const keep = await newProject();
      const owner = `owner-${randomUUID()}`;
      await workbench.putListCache(projectId, 'f', {});
      await workbench.putListCache(keep, 'f', {});
      await workbench.pin(owner, projectId);
      await workbench.pin(owner, keep);
      expect(await workbench.deleteProject(projectId)).not.toBeNull();
      const cache = await workbench.listCache();
      expect(cache.has(projectId)).toBe(false);
      expect(cache.has(keep)).toBe(true);
      expect(await workbench.listPins(owner)).toEqual([keep]);
      expect((await workbench.projectFingerprints()).some((f) => f.id === projectId)).toBe(false);
    });
  });
});
