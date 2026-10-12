import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AVAILABLE_STAGES,
  BriefBodySchema,
  DRAFT_STAGES,
  DataPolicySchema,
  EVALUATION_MODELS,
  DraftResultSchema,
  EMPTY_BRIEF,
  MAX_SAMPLES,
  PreparedTextSchema,
  PreparedTriageSchema,
  SampleRoleSchema,
  SegmentDocumentSchema,
  SegmentationResultSchema,
  SurveyBodySchema,
  applyChanges,
  blockingStage,
  buildScorecard,
  conflictingChanges,
  draftingKey,
  finishedJob,
  firstIncomplete,
  inboxKey,
  isChangeStage,
  parseChangeBody,
  preparedTextKey,
  preparedTriageKey,
  referencesStage,
  segmentationKey,
  stageStates,
  type ChangeBody,
  type DraftStage,
  type IterationSummary,
  type IterationView,
  type JobDetail,
  type JobStatus,
  type JobSummary,
  type ProjectSummary,
  type ProjectView,
  type ProposalStatus,
  type ProposalView,
  type Reference,
  type ReferenceRow,
  type SampleResult,
  type SampleState,
  type SampleView,
  type SegmentationView,
  type StageView,
  type SurveyBody,
  type WorkbenchProject,
} from '@ih/shared';
import { compareToReference } from '../regression/compare.js';
import { jobDocument, regressionFinished } from '../regression/report.js';
import type { NewDocument, ProjectJob, SegmentJob } from '../repositories/types.js';
import { createNextDraft, pinned, skeleton } from '../templates/drafts.js';
import type { TemplateRecord, TemplateRepo } from '../templates/repo.js';
import { validateTemplate } from '../templates/definitions.js';
import { isPdf, multipartField } from '../uploads.js';
import {
  WorkbenchConflictError,
  type IterationRecord,
  type ProposalRecord,
  type SampleRecord,
} from '../workbench/repo.js';

const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase id: [a-z][a-z0-9_-]*');
const CreateProject = z.object({ id: Id, name: z.string().min(1).optional() }).strict();

type ProjectParams = { id: string };

const PolicyBody = z.object({ dataPolicy: DataPolicySchema }).strict();
const StageParams = z.object({ id: Id, stage: z.enum(DRAFT_STAGES) });
const ProposalParams = z.object({ id: Id, pid: z.string().uuid() });
const DecisionBody = z
  .object({
    decision: z.enum(['accepted', 'rejected']),
    changes: z.array(z.number().int().min(0)).min(1).optional(),
  })
  .strict();
const SkipParams = StageParams;

const isAdmin = (app: FastifyInstance, req: FastifyRequest) =>
  app.deps.access === null || req.auth?.role === 'admin';

const StartSegmentation = z.object({ document: z.unknown().optional() }).strict();
const SegmentationParams = z.object({ id: Id, jobId: z.string().uuid() });

function segmentationView(job: SegmentJob, result: SegmentationView['result']): SegmentationView {
  return { jobId: job.id, status: job.status, error: job.error, result };
}

/** The open draft, the latest published version and the newest record of a document type. */
export async function versionsOf(templates: TemplateRepo, id: string) {
  const versions = (await templates.list()).filter((r) => r.id === id);
  return {
    draft: versions.find((v) => v.status === 'draft')?.version ?? null,
    published: versions.filter((v) => v.status === 'published').at(-1)?.version ?? null,
    latest: (versions.at(-1) ?? null) as TemplateRecord | null,
  };
}

async function projectView(app: FastifyInstance, project: WorkbenchProject): Promise<ProjectView> {
  const { draft, published } = await versionsOf(app.deps.templates, project.id);
  return { project, draft, published, brief: await app.deps.workbench.latestBrief(project.id) };
}

const SampleParams = z.object({ id: Id, sid: z.string().uuid() });
const RoleBody = z.object({ role: SampleRoleSchema }).strict();

function stateOf(job: JobSummary | null): SampleState {
  if (job?.status === 'succeeded') return 'ready';
  if (job?.status === 'queued' || job?.status === 'running') return 'preparing';
  return 'failed';
}

async function readJson(app: FastifyInstance, key: string): Promise<unknown | null> {
  const raw = await app.deps.store.get(app.deps.buckets.runs, key);
  return raw ? (JSON.parse(raw.toString('utf8')) as unknown) : null;
}

/** Like `readJson`, but a corrupt object reads as `undefined` instead of throwing. */
async function readJsonSafe(
  app: FastifyInstance,
  key: string,
): Promise<unknown | null | undefined> {
  try {
    return await readJson(app, key);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

function parseBody(stage: DraftStage, body: unknown): SurveyBody | ChangeBody | null {
  if (stage === 'survey') {
    const survey = SurveyBodySchema.safeParse(body);
    return survey.success ? survey.data : null;
  }
  return isChangeStage(stage) ? parseChangeBody(stage, body) : null;
}

/** Proposal status without reading its body (stage rail; order checks). */
function statusOf(p: ProposalRecord, job: ProjectJob | null): ProposalStatus {
  if (p.decision) return p.decision;
  if (!job || job.status === 'queued' || job.status === 'running') return 'running';
  return job.status === 'succeeded' ? 'ready' : 'failed';
}

async function stagesOf(app: FastifyInstance, projectId: string): Promise<StageView[]> {
  const jobs = new Map((await app.deps.repo.listDraftJobs(projectId)).map((j) => [j.id, j]));
  const proposals = (await app.deps.workbench.listProposals(projectId)).map((p) => ({
    stage: p.stage,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
    status: statusOf(p, jobs.get(p.id) ?? null),
  }));
  return stageStates(proposals, await app.deps.workbench.listSkips(projectId));
}

/** The body of the latest accepted survey, or null (context for the change stages). */
async function acceptedSurvey(app: FastifyInstance, projectId: string): Promise<SurveyBody | null> {
  const p = (await app.deps.workbench.listProposals(projectId)).find(
    (x) => x.stage === 'survey' && x.decision === 'accepted',
  );
  if (!p) return null;
  const raw = await readJsonSafe(app, draftingKey(projectId, p.id));
  const parsed = raw == null ? null : DraftResultSchema.safeParse(raw);
  const body = parsed?.success ? SurveyBodySchema.safeParse(parsed.data.body) : null;
  return body?.success ? body.data : null;
}

async function proposalView(
  app: FastifyInstance,
  p: ProposalRecord,
  job: ProjectJob | null,
): Promise<ProposalView> {
  const base = {
    id: p.id,
    stage: p.stage,
    briefVersion: p.briefVersion,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
    acceptedChanges: p.acceptedChanges,
  };
  const empty = { ...base, model: null, body: null };
  if (!job || job.status === 'queued' || job.status === 'running') {
    return { ...empty, status: p.decision ?? 'running', error: null };
  }
  if (job.status !== 'succeeded') {
    return { ...empty, status: p.decision ?? 'failed', error: job.error ?? job.status };
  }
  const raw = await readJsonSafe(app, draftingKey(job.projectId, job.id));
  const parsed = raw == null ? null : DraftResultSchema.safeParse(raw);
  const body = parsed?.success ? parseBody(p.stage, parsed.data.body) : null;
  if (!parsed?.success || !body) {
    return {
      ...empty,
      status: p.decision ?? 'failed',
      error: raw === null ? 'result missing' : 'result unreadable',
    };
  }
  return {
    ...base,
    status: p.decision ?? 'ready',
    error: null,
    model: parsed.data.model,
    body,
  };
}

/** Samples with their state, derived from each one's latest prepare job. */
export async function sampleViews(app: FastifyInstance, projectId: string) {
  const prepares = (await app.deps.repo.listProjectJobs(projectId)).filter(
    (j) => j.task === 'prepare',
  );
  const records = await app.deps.workbench.listSamples(projectId);
  return Promise.all(
    records.map(async (record) => ({
      record,
      view: await toView(
        app,
        record,
        prepares.find((j) => j.documentId === record.documentId) ?? null,
      ),
    })),
  );
}

async function toView(
  app: FastifyInstance,
  s: SampleRecord,
  job: JobSummary | null,
): Promise<SampleView> {
  const state = stateOf(job);
  const triage = state === 'ready' ? await readJson(app, preparedTriageKey(s.sha256)) : null;
  return {
    id: s.id,
    projectId: s.projectId,
    documentId: s.documentId,
    filename: s.filename,
    sizeBytes: s.sizeBytes,
    sha256: s.sha256,
    role: s.role,
    addedForVersion: s.addedForVersion,
    createdAt: s.createdAt,
    state,
    prepareJobId: job?.id ?? null,
    error: state === 'failed' ? (job?.error ?? job?.status ?? 'preparation job missing') : null,
    triage: triage === null ? null : PreparedTriageSchema.parse(triage),
  };
}

/** A new document for a test run of `sample` against template version `version`. */
function sampleDocument(sample: SampleRecord, projectId: string, version: number): NewDocument {
  return {
    id: randomUUID(),
    filename: sample.filename,
    sha256: sample.sha256,
    sizeBytes: sample.sizeBytes,
    specId: projectId,
    specVersion: version,
    bucket: sample.bucket,
    objectKey: sample.objectKey,
  };
}

const activeJob = (status: JobStatus) => status === 'queued' || status === 'running';

/** A reference row plus the sample's newest reference run (draft model), for stage state. */
interface ReferenceEntry {
  row: ReferenceRow;
  draftRun: JobSummary | null;
}

/** Ready dev samples with their newest reference (by PDF sha256) and newest non-evaluation run. */
async function referenceRows(app: FastifyInstance, projectId: string): Promise<ReferenceRow[]> {
  return (await referenceEntries(app, projectId)).map((e) => e.row);
}

async function referenceEntries(
  app: FastifyInstance,
  projectId: string,
): Promise<ReferenceEntry[]> {
  const samples = (await sampleViews(app, projectId))
    .filter((s) => s.view.role === 'dev' && s.view.state === 'ready')
    .map((s) => s.record)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const references = await app.deps.repo.listReferencesWithSha(projectId);
  const runs = (await app.deps.repo.listProjectRuns(projectId)).filter(
    (r) => r.job.referenceId === null,
  );
  return samples.map((s) => {
    const reference = references.find((r) => r.sha256 === s.sha256) ?? null;
    const run = runs.find((r) => r.sha256 === s.sha256)?.job ?? null;
    const draftRun =
      runs.find((r) => r.sha256 === s.sha256 && r.job.modelOverride === 'draft')?.job ?? null;
    return {
      draftRun,
      row: {
        sampleId: s.id,
        filename: s.filename,
        sha256: s.sha256,
        reference: reference && {
          id: reference.id,
          name: reference.name,
          createdAt: reference.createdAt,
        },
        run: run && {
          jobId: run.id,
          status: run.status,
          error: run.error,
          modelOverride: run.modelOverride,
        },
      },
    };
  });
}

async function referencesView(
  app: FastifyInstance,
  projectId: string,
  earlier: StageView[],
): Promise<StageView> {
  const entries = await referenceEntries(app, projectId);
  const rows = entries.map((e) => e.row);
  const verified = rows.filter((r) => r.reference !== null);
  // Only reference runs (draft model) of samples still without a reference count: a 3a test
  // run or an old run of a verified sample says nothing about this stage.
  const referenceRuns = entries
    .filter((e) => e.row.reference === null && e.draftRun !== null)
    .map((e) => e.draftRun!);
  const skips = await app.deps.workbench.listSkips(projectId);
  return referencesStage(earlier, {
    devSamples: rows.length,
    verified: verified.length,
    lastVerifiedAt:
      verified
        .map((r) => r.reference!.createdAt)
        .sort()
        .at(-1) ?? null,
    running: referenceRuns.some((r) => activeJob(r.status)),
    hasRuns: referenceRuns.length > 0,
    skippedAt: skips.find((s) => s.stage === 'references')?.skippedAt ?? null,
  });
}

/** All five stages: the four proposal stages, then references (derived separately). */
async function allStages(app: FastifyInstance, projectId: string): Promise<StageView[]> {
  const earlier = await stagesOf(app, projectId);
  return [...earlier, await referencesView(app, projectId, earlier)];
}

const EvaluateBody = z.object({ model: z.enum(EVALUATION_MODELS).optional() }).strict();
const IterationParams = z.object({ id: Id, iid: z.string().uuid() });

/**
 * A finished job's comparison with its reference; null when the job has no readable document
 * (none written, corrupt JSON, or not shaped like a document).
 */
async function sampleComparison(app: FastifyInstance, job: JobDetail, reference: Reference) {
  try {
    const document = await jobDocument(app, job);
    return document ? compareToReference(reference.expected, document) : null;
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof TypeError) {
      app.log.warn({ jobId: job.id, err }, 'evaluation document unreadable');
      return null;
    }
    throw err;
  }
}

/**
 * The scorecard of an iteration, computed from its jobs; caches the summary once complete, and
 * updates the cache when it changed since (a job retried or re-reviewed after completion).
 */
async function iterationView(
  app: FastifyInstance,
  iteration: IterationRecord,
): Promise<IterationView> {
  const references = await app.deps.repo.listReferencesWithSha(iteration.projectId);
  const samples = await app.deps.workbench.listSamples(iteration.projectId);
  const results: SampleResult[] = await Promise.all(
    iteration.jobIds.map(async (jobId) => {
      const job = await app.deps.repo.getJob(jobId);
      const reference = job ? (references.find((r) => r.id === job.referenceId) ?? null) : null;
      const sample = reference
        ? (samples.find((s) => s.sha256 === reference.sha256) ?? null)
        : null;
      const comparison =
        job && reference && regressionFinished(job.status)
          ? await sampleComparison(app, job, reference)
          : null;
      return {
        sampleId: sample?.id ?? null,
        filename: job?.filename ?? 'deleted job',
        jobId: job?.id ?? null,
        status: job?.status ?? null,
        error: job?.error ?? null,
        comparison,
      };
    }),
  );
  const scorecard = buildScorecard(results);
  const status = results.every((r) => finishedJob(r.status)) ? 'complete' : 'running';
  const scores = { score: scorecard.score, completed: scorecard.completed, total: scorecard.total };
  const cached = iteration.scores;
  const changed =
    cached === null ||
    cached.score !== scores.score ||
    cached.completed !== scores.completed ||
    cached.total !== scores.total;
  if (status === 'complete' && changed) {
    await app.deps.workbench.setIterationScores(iteration.id, scores);
  }
  return { ...summaryOf(iteration), status, ...scores, scorecard, samples: results };
}

function summaryOf(
  iteration: IterationRecord,
): Omit<IterationSummary, 'status' | 'score' | 'completed' | 'total'> {
  return {
    id: iteration.id,
    projectId: iteration.projectId,
    templateVersion: iteration.templateVersion,
    briefVersion: iteration.briefVersion,
    set: iteration.set,
    model: iteration.model,
    createdAt: iteration.createdAt,
  };
}

/** /api/workbench (ADR 0007, phase 1): projects, samples, brief, dev test runs. */
export const workbenchRoutes: FastifyPluginAsync = async (app) => {
  const { workbench, templates } = app.deps;

  app.get('/workbench/projects', async (): Promise<ProjectSummary[]> => {
    const projects = await workbench.listProjects();
    return Promise.all(
      projects.map(async (p) => {
        const { draft, published } = await versionsOf(templates, p.id);
        return { ...p, draft, published, samples: (await workbench.listSamples(p.id)).length };
      }),
    );
  });

  /** New project. An existing document type is opened: its open draft, or a new next draft. */
  app.post('/workbench/projects', async (req, reply) => {
    const body = CreateProject.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const { id } = body.data;
    if (await workbench.getProject(id)) {
      return reply.code(409).send({ error: `a workbench project for ${id} already exists` });
    }
    const { draft, latest } = await versionsOf(templates, id);
    let name = body.data.name;
    if (latest === null) {
      if (!name) return reply.code(400).send({ error: 'name is required for a new document type' });
      await templates.create(id, 1, skeleton(id, name), 'draft');
    } else {
      name = String(latest.definition.name ?? id);
      if (draft === null) await createNextDraft(templates, id);
    }
    try {
      const project = await workbench.createProject(id, name);
      return reply.code(201).send(await projectView(app, project));
    } catch (err) {
      if (err instanceof WorkbenchConflictError)
        return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id', async (req, reply) => {
    const project = await workbench.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return projectView(app, project);
  });

  const findSample = async (projectId: string, sampleId: string) =>
    (await sampleViews(app, projectId)).find((s) => s.record.id === sampleId) ?? null;

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/samples', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    return (await sampleViews(app, req.params.id)).map((s) => s.view);
  });

  /** Upload one sample PDF (multipart: `role` field first, then the file). */
  app.post<{ Params: ProjectParams }>('/workbench/projects/:id/samples', async (req, reply) => {
    const projectId = req.params.id;
    const project = await workbench.getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'file part is required' });
    const role = SampleRoleSchema.safeParse(multipartField(file, 'role') ?? 'dev');
    if (!role.success) return reply.code(400).send({ error: 'role must be dev or holdout' });
    const body = await file.toBuffer(); // throws RequestFileTooLargeError (413) past the limit
    if (!isPdf(body)) return reply.code(415).send({ error: 'file is not a PDF' });

    const samples = await workbench.listSamples(projectId);
    if (samples.length >= MAX_SAMPLES) {
      return reply.code(409).send({ error: `a project holds at most ${MAX_SAMPLES} samples` });
    }
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (samples.some((s) => s.sha256 === sha256)) {
      return reply.code(409).send({ error: 'this PDF is already a sample of the project' });
    }

    const { draft, published } = await versionsOf(templates, projectId);
    const version = draft ?? published ?? 1;
    const documentId = randomUUID();
    const key = inboxKey(projectId, version, documentId);
    await app.deps.store.put(app.deps.buckets.inbox, key, body, 'application/pdf');
    const job = await app.deps.repo.createWorkbenchJob(
      {
        id: documentId,
        filename: file.filename,
        sha256,
        sizeBytes: body.length,
        specId: projectId,
        specVersion: version,
        bucket: app.deps.buckets.inbox,
        objectKey: key,
      },
      { projectId, task: 'prepare', params: { dataPolicy: project.dataPolicy } },
    );
    try {
      const record = await workbench.addSample({
        projectId,
        documentId,
        role: role.data,
        addedForVersion: version,
      });
      return reply.code(201).send(await toView(app, record, job));
    } catch (err) {
      if (err instanceof WorkbenchConflictError)
        return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.patch<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/samples/:sid',
    async (req, reply) => {
      const params = SampleParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'sample not found' });
      const body = RoleBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const updated = await workbench.setSampleRole(
        params.data.id,
        params.data.sid,
        body.data.role,
      );
      if (!updated) return reply.code(404).send({ error: 'sample not found' });
      return (await findSample(params.data.id, params.data.sid))!.view;
    },
  );

  app.delete<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/samples/:sid',
    async (req, reply) => {
      const params = SampleParams.safeParse(req.params);
      const removed =
        params.success && (await workbench.removeSample(params.data.id, params.data.sid));
      return removed ? reply.code(204).send() : reply.code(404).send({ error: 'sample not found' });
    },
  );

  app.get<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/samples/:sid/text',
    async (req, reply) => {
      const params = SampleParams.safeParse(req.params);
      const sample = params.success ? await findSample(params.data.id, params.data.sid) : null;
      if (!sample) return reply.code(404).send({ error: 'sample not found' });
      if (sample.view.state !== 'ready') {
        return reply.code(409).send({ error: `sample is ${sample.view.state}, not ready` });
      }
      const text = await readJson(app, preparedTextKey(sample.record.sha256));
      if (text === null) return reply.code(409).send({ error: 'prepared text is missing' });
      return PreparedTextSchema.parse(text);
    },
  );

  /** Save the brief: a new version when it changed, else the latest one (200). */
  app.put<{ Params: ProjectParams }>('/workbench/projects/:id/brief', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const body = BriefBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const latest = await workbench.latestBrief(req.params.id);
    if (latest && JSON.stringify(latest.body) === JSON.stringify(body.data)) return latest;
    return reply.code(201).send(await workbench.saveBrief(req.params.id, body.data));
  });

  /** Test-run the open draft on every prepared dev sample (holdout samples are not used). */
  app.post<{ Params: ProjectParams }>('/workbench/projects/:id/test-runs', async (req, reply) => {
    const projectId = req.params.id;
    const project = await workbench.getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const { draft } = await versionsOf(templates, projectId);
    if (draft === null) {
      return reply.code(409).send({ error: 'no open draft to test; start the next version first' });
    }
    const issues = validateTemplate((await templates.get(projectId, draft))!.definition);
    if (issues.length) return reply.code(400).send({ error: 'the draft is not valid', issues });
    const ready = (await sampleViews(app, projectId)).filter(
      (s) => s.view.role === 'dev' && s.view.state === 'ready',
    );
    if (!ready.length) return reply.code(409).send({ error: 'no prepared dev samples to run' });
    const jobs = await Promise.all(
      ready.map(({ record }) =>
        app.deps.repo.createWorkbenchJob(sampleDocument(record, projectId, draft), {
          projectId,
          task: 'process',
          params: { dataPolicy: project.dataPolicy },
        }),
      ),
    );
    return reply.code(201).send({ jobs });
  });

  /** Preview anchors over every prepared sample (worker task `segment`; ADR 0007). */
  app.post<{ Params: ProjectParams }>(
    '/workbench/projects/:id/segmentations',
    async (req, reply) => {
      const projectId = req.params.id;
      if (!(await workbench.getProject(projectId))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const body = StartSegmentation.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      let candidate = body.data.document;
      if (candidate === undefined) {
        const { draft, latest } = await versionsOf(templates, projectId);
        const record = draft !== null ? await templates.get(projectId, draft) : latest;
        const block = (record?.definition.document ?? {}) as Record<string, unknown>;
        candidate = {
          sections: block.sections,
          ...(block.copies !== undefined ? { copies: block.copies } : {}),
          ...(block.pageMarkers !== undefined ? { pageMarkers: block.pageMarkers } : {}),
        };
      }
      const document = SegmentDocumentSchema.safeParse(candidate);
      if (!document.success) {
        return reply.code(400).send({ error: 'invalid sections', issues: document.error.issues });
      }
      const samples = (await sampleViews(app, projectId))
        .filter((s) => s.view.state === 'ready')
        .map((s) => ({ sampleId: s.record.id, sha256: s.record.sha256 }));
      if (!samples.length) return reply.code(409).send({ error: 'no prepared samples to segment' });
      const { job, removed } = await app.deps.repo.createSegmentJob(projectId, {
        samples,
        document: document.data,
      });
      await Promise.all(
        removed.map((id) =>
          app.deps.store
            .delete(app.deps.buckets.runs, segmentationKey(projectId, id))
            .catch((err: unknown) => req.log.warn({ err, id }, 'old segmentation not deleted')),
        ),
      );
      return reply.code(202).send(segmentationView(job, null));
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    '/workbench/projects/:id/segmentations/:jobId',
    async (req, reply) => {
      const params = SegmentationParams.safeParse(req.params);
      const job = params.success
        ? await app.deps.repo.getSegmentJob(params.data.id, params.data.jobId)
        : null;
      if (!job) return reply.code(404).send({ error: 'segmentation not found' });
      if (job.status !== 'succeeded') return segmentationView(job, null);
      const raw = await readJson(app, segmentationKey(job.projectId, job.id));
      if (raw === null) return { ...segmentationView(job, null), error: 'result missing' };
      return segmentationView(job, SegmentationResultSchema.parse(raw));
    },
  );

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/test-runs', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    return (await app.deps.repo.listProjectJobs(req.params.id)).filter((j) => j.task !== 'prepare');
  });

  app.put<{ Params: ProjectParams }>('/workbench/projects/:id/data-policy', async (req, reply) => {
    if (!isAdmin(app, req)) return reply.code(403).send({ error: 'admins only' });
    const body = PolicyBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const project = await workbench.setDataPolicy(
      req.params.id,
      body.data.dataPolicy,
      req.auth?.label ?? null,
    );
    if (!project) return reply.code(404).send({ error: 'project not found' });
    req.log.info({ projectId: project.id, dataPolicy: project.dataPolicy }, 'data policy changed');
    return projectView(app, project);
  });

  /** References stage: run the draft model on every ready dev sample that has no reference. */
  async function startReferences(projectId: string, reply: FastifyReply) {
    const project = await workbench.getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const blocking = firstIncomplete(await stagesOf(app, projectId));
    if (blocking) {
      return reply
        .code(409)
        .send({ error: `finish the ${blocking} stage first (accept or skip it)` });
    }
    const { draft } = await versionsOf(templates, projectId);
    if (draft === null) {
      return reply
        .code(409)
        .send({ error: 'no open draft; start the next version on the Template tab' });
    }
    const issues = validateTemplate((await templates.get(projectId, draft))!.definition);
    if (issues.length) return reply.code(400).send({ error: 'the draft is not valid', issues });
    const entries = await referenceEntries(app, projectId);
    if (!entries.length) return reply.code(409).send({ error: 'no prepared dev samples to run' });
    const unverified = entries.filter((e) => e.row.reference === null);
    if (!unverified.length) {
      return reply.code(409).send({ error: 'every dev sample already has a reference' });
    }
    const todo = unverified
      .filter((e) => !(e.draftRun && activeJob(e.draftRun.status)))
      .map((e) => e.row);
    if (!todo.length) {
      return reply.code(409).send({ error: 'reference runs are already running' });
    }
    const records = new Map(
      (await sampleViews(app, projectId)).map((s) => [s.record.id, s.record]),
    );
    const jobs = await Promise.all(
      todo.map((row) =>
        app.deps.repo.createWorkbenchJob(
          sampleDocument(records.get(row.sampleId)!, projectId, draft),
          {
            projectId,
            task: 'process',
            // forceReview: the worker stops every reference run for review, so it can be
            // verified, approved and saved as a reference.
            params: { dataPolicy: project.dataPolicy, forceReview: true },
            modelOverride: 'draft',
          },
        ),
      ),
    );
    return reply.code(201).send({ jobs });
  }

  app.post<{ Params: { id: string; stage: string } }>(
    '/workbench/projects/:id/stages/:stage',
    async (req, reply) => {
      if (req.params.stage === 'references') return startReferences(req.params.id, reply);
      const params = StageParams.safeParse(req.params);
      if (!params.success || !AVAILABLE_STAGES.includes(params.data.stage)) {
        return reply.code(400).send({ error: `stage ${req.params.stage} is not available yet` });
      }
      const { id: projectId, stage } = params.data;
      const project = await workbench.getProject(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const blocking = blockingStage(await stagesOf(app, projectId), stage);
      if (blocking) {
        return reply
          .code(409)
          .send({ error: `finish the ${blocking} stage first (accept or skip it)` });
      }
      const { draft, latest } = await versionsOf(templates, projectId);
      const changeStage = isChangeStage(stage);
      if (changeStage && draft === null) {
        return reply
          .code(409)
          .send({ error: 'no open draft; start the next version on the Template tab' });
      }
      const record = draft !== null ? await templates.get(projectId, draft) : latest;
      if (!record) return reply.code(409).send({ error: 'the project has no template version' });
      // Holdout rule (ADR 0007): only dev samples ever reach a drafting model.
      const samples = (await sampleViews(app, projectId))
        .filter((s) => s.view.role === 'dev' && s.view.state === 'ready')
        .map((s) => ({
          sampleId: s.record.id,
          filename: s.record.filename,
          sha256: s.record.sha256,
          role: 'dev' as const,
        }));
      if (!samples.length) return reply.code(409).send({ error: 'no prepared dev samples' });
      const brief = await workbench.latestBrief(projectId);
      const job = await app.deps.repo.createDraftJob(projectId, {
        stage,
        dataPolicy: project.dataPolicy,
        briefVersion: brief?.version ?? null,
        brief: brief?.body ?? EMPTY_BRIEF,
        draft: record.definition,
        samples,
        ...(changeStage ? { survey: await acceptedSurvey(app, projectId) } : {}),
      });
      const proposal = await workbench.createProposal({
        id: job.id,
        projectId,
        stage,
        briefVersion: brief?.version ?? null,
        baseVersion: changeStage ? record.version : null,
        baseDefinition: changeStage ? record.definition : null,
      });
      return reply.code(202).send(await proposalView(app, proposal, job));
    },
  );

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/stages', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    return allStages(app, req.params.id);
  });

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/references', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    return referenceRows(app, req.params.id);
  });

  app.post<{ Params: { id: string; stage: string } }>(
    '/workbench/projects/:id/stages/:stage/skip',
    async (req, reply) => {
      const params = SkipParams.safeParse(req.params);
      if (
        !params.success ||
        !(params.data.stage === 'references' || AVAILABLE_STAGES.includes(params.data.stage))
      ) {
        return reply.code(400).send({ error: `stage ${req.params.stage} is not available yet` });
      }
      const { id: projectId, stage } = params.data;
      if (!(await workbench.getProject(projectId))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const states = await stagesOf(app, projectId);
      const blocking =
        stage === 'references' ? firstIncomplete(states) : blockingStage(states, stage);
      if (blocking) {
        return reply
          .code(409)
          .send({ error: `finish the ${blocking} stage first (accept or skip it)` });
      }
      await workbench.addSkip(projectId, stage);
      return reply.code(201).send(await allStages(app, projectId));
    },
  );

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/proposals', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const jobs = new Map((await app.deps.repo.listDraftJobs(req.params.id)).map((j) => [j.id, j]));
    const proposals = await workbench.listProposals(req.params.id);
    return Promise.all(proposals.map((p) => proposalView(app, p, jobs.get(p.id) ?? null)));
  });

  app.post<{ Params: { id: string; pid: string } }>(
    '/workbench/projects/:id/proposals/:pid/decision',
    async (req, reply) => {
      const params = ProposalParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'proposal not found' });
      const body = DecisionBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { id: projectId, pid } = params.data;
      const record = (await workbench.listProposals(projectId)).find((p) => p.id === pid);
      if (!record) return reply.code(404).send({ error: 'proposal not found' });
      const job = (await app.deps.repo.listDraftJobs(projectId)).find((j) => j.id === pid) ?? null;
      const current = await proposalView(app, record, job);
      if (current.status !== 'ready') {
        return reply.code(409).send({ error: `proposal is ${current.status}` });
      }
      const { decision, changes } = body.data;
      if (!isChangeStage(record.stage) || decision === 'rejected') {
        if (changes) {
          return reply.code(400).send({
            error: 'changes can only be chosen when accepting a drafting change proposal',
          });
        }
        const decided = await workbench.decideProposal(projectId, pid, decision);
        if (!decided) return reply.code(409).send({ error: 'proposal was already decided' });
        return proposalView(app, decided, job);
      }
      const proposed = (current.body as ChangeBody).changes;
      if (!changes) return reply.code(400).send({ error: 'choose the changes to accept' });
      const chosen = [...new Set(changes)].sort((a, b) => a - b);
      if (chosen.some((i) => i >= proposed.length)) {
        return reply.code(400).send({ error: 'no such change' });
      }
      const { draft } = await versionsOf(templates, projectId);
      if (draft === null || draft !== record.baseVersion) {
        return reply
          .code(409)
          .send({ error: 'the draft version changed since this proposal; re-run the stage' });
      }
      const draftRecord = (await templates.get(projectId, draft))!;
      const selected = chosen.map((i) => proposed[i]!);
      const clashes = conflictingChanges(
        record.baseDefinition ?? {},
        draftRecord.definition,
        selected,
      ).map((k) => chosen[k]! + 1);
      if (clashes.length) {
        return reply.code(409).send({
          error: `the draft changed since this proposal where these changes apply: ${clashes.join(', ')}; re-run the stage or accept the others`,
        });
      }
      // Apply first: if the draft was published meanwhile nothing is written and the proposal
      // stays undecided. Re-applying the same changes after a lost race is idempotent.
      const updated = await templates.updateDraft(
        projectId,
        draft,
        pinned(applyChanges(draftRecord.definition, selected), projectId, draft),
      );
      if (!updated) {
        return reply.code(409).send({
          error: 'the draft is no longer open; start the next version and re-run the stage',
        });
      }
      const decided = await workbench.decideProposal(
        projectId,
        pid,
        chosen.length === proposed.length ? 'accepted' : 'partially_accepted',
        chosen,
      );
      if (!decided) return reply.code(409).send({ error: 'proposal was already decided' });
      req.log.info({ projectId, proposal: pid, applied: chosen }, 'drafting changes applied');
      return proposalView(app, decided, job);
    },
  );

  app.post<{ Params: ProjectParams }>('/workbench/projects/:id/evaluations', async (req, reply) => {
    const projectId = req.params.id;
    const project = await workbench.getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const body = EvaluateBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const { draft } = await versionsOf(templates, projectId);
    if (draft === null) {
      return reply
        .code(409)
        .send({ error: 'no open draft; start the next version on the Template tab' });
    }
    const record = (await templates.get(projectId, draft))!;
    const issues = validateTemplate(record.definition);
    if (issues.length) return reply.code(400).send({ error: 'the draft is not valid', issues });
    const rows = (await referenceRows(app, projectId)).filter((r) => r.reference !== null);
    if (!rows.length) {
      return reply.code(409).send({
        error:
          'no verified references for the dev samples; verify some on the References tab first',
      });
    }
    const records = new Map(
      (await sampleViews(app, projectId)).map((s) => [s.record.id, s.record]),
    );
    const model = body.data.model ?? null;
    const jobs = await Promise.all(
      rows.map((row) =>
        app.deps.repo.createWorkbenchJob(
          sampleDocument(records.get(row.sampleId)!, projectId, draft),
          {
            projectId,
            task: 'process',
            params: { dataPolicy: project.dataPolicy },
            referenceId: row.reference!.id,
            modelOverride: model,
          },
        ),
      ),
    );
    const brief = await workbench.latestBrief(projectId);
    const iteration = await workbench.createIteration({
      projectId,
      templateVersion: draft,
      definition: record.definition,
      briefVersion: brief?.version ?? null,
      set: 'dev',
      model,
      jobIds: jobs.map((j) => j.id),
    });
    req.log.info(
      { projectId, iteration: iteration.id, version: draft, model, jobs: jobs.length },
      'evaluation started',
    );
    return reply.code(201).send(await iterationView(app, iteration));
  });

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/iterations', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const iterations = await workbench.listIterations(req.params.id);
    return Promise.all(
      iterations.map(async (iteration): Promise<IterationSummary> => {
        if (iteration.scores)
          return { ...summaryOf(iteration), status: 'complete', ...iteration.scores };
        const view = await iterationView(app, iteration);
        return {
          ...summaryOf(iteration),
          status: view.status,
          score: view.score,
          completed: view.completed,
          total: view.total,
        };
      }),
    );
  });

  /** The iteration named by the route params, or null for an unknown or malformed id. */
  async function iterationOf(params: unknown) {
    const parsed = IterationParams.safeParse(params);
    return parsed.success ? workbench.getIteration(parsed.data.id, parsed.data.iid) : null;
  }

  app.get<{ Params: { id: string; iid: string } }>(
    '/workbench/projects/:id/iterations/:iid',
    async (req, reply) => {
      const iteration = await iterationOf(req.params);
      if (!iteration) return reply.code(404).send({ error: 'iteration not found' });
      return iterationView(app, iteration);
    },
  );

  app.post<{ Params: { id: string; iid: string } }>(
    '/workbench/projects/:id/iterations/:iid/restore',
    async (req, reply) => {
      const iteration = await iterationOf(req.params);
      if (!iteration) return reply.code(404).send({ error: 'iteration not found' });
      const { projectId } = iteration;
      const { draft } = await versionsOf(templates, projectId);
      if (draft === null) {
        return reply
          .code(409)
          .send({ error: 'no open draft; start the next version on the Template tab' });
      }
      const saved = await templates.updateDraft(
        projectId,
        draft,
        pinned(iteration.definition, projectId, draft),
      );
      if (!saved) return reply.code(409).send({ error: 'the draft is no longer open' });
      req.log.info({ projectId, iteration: iteration.id, version: draft }, 'iteration restored');
      return projectView(app, (await workbench.getProject(projectId))!);
    },
  );
};
