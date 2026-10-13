import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  answeredFeedback,
  AVAILABLE_STAGES,
  BriefBodySchema,
  BriefSchema,
  BriefVersionViewSchema,
  briefVersions,
  ComparisonViewSchema,
  DRAFT_STAGES,
  DataPolicySchema,
  EVALUATION_MODELS,
  EVALUATION_SETS,
  DraftResultSchema,
  EMPTY_BRIEF,
  FeedbackBodySchema,
  FeedbackItemSchema,
  GateViewSchema,
  PublishGateViewSchema,
  gateHints,
  IterationSummarySchema,
  KEEPABLE_STAGES,
  IterationViewSchema,
  MAX_SAMPLES,
  JobSummarySchema,
  PreparedTextSchema,
  ProjectListPageSchema,
  ProjectListQuerySchema,
  ProjectSummarySchema,
  ProjectViewSchema,
  ProposalViewSchema,
  PublicationSchema,
  PublishBodySchema,
  ReferenceRowSchema,
  PreparedTriageSchema,
  SampleRoleSchema,
  SampleViewSchema,
  SegmentationViewSchema,
  STAGE_ORDER,
  StageViewSchema,
  SegmentDocumentSchema,
  SegmentationResultSchema,
  SurveyBodySchema,
  ThresholdBodySchema,
  applyChanges,
  blockingStage,
  buildScorecard,
  conflictingChanges,
  failureDiffs,
  revisionFailures,
  type RevisionFeedback,
  draftingKey,
  finishedJob,
  firstIncomplete,
  inboxKey,
  isChangeStage,
  outputChanges,
  parseChangeBody,
  preparedTextKey,
  preparedTriageKey,
  publishGate,
  referencesStage,
  segmentationKey,
  stableJson,
  stageStates,
  type ChangeBody,
  type ComparisonView,
  type DraftStage,
  type EvaluationModel,
  type EvaluationSet,
  type GateCandidate,
  type FailureDiff,
  type FeedbackItem,
  type GateHint,
  type GateView,
  type PublishGateView,
  type IterationSummary,
  type IterationView,
  type JobDetail,
  type JobStatus,
  type JobSummary,
  type ProjectSummary,
  type ProjectView,
  type ProposalStatus,
  type ProposalView,
  type Publication,
  type Reference,
  type ReferenceRow,
  type SampleResult,
  type SampleRole,
  type SampleState,
  type SampleView,
  type SegmentationView,
  type StageView,
  type SurveyBody,
  type WorkbenchProject,
  ReferenceDetailSchema,
  correctionOutput,
  outputCoverage,
  outputProvenance,
  referenceCorrections,
  type ReferenceDetail,
  type ReferenceInfo,
} from '@ih/shared';
import { removeJobFiles } from '../jobs/delete.js';
import { listProjectsPage } from '../workbench/list.js';
import { PREPARE_EVENTS, prepareError, prepareProgress } from '../workbench/prepare.js';
import { error, md, multipart, noContent, res } from '../openapi/zod.js';
import { compareToReference } from '../regression/compare.js';
import { jobDocument, regressionFinished } from '../regression/report.js';
import type { JobEventRecord, NewDocument, ProjectJob, SegmentJob } from '../repositories/types.js';
import { createNextDraft, pinned, skeleton } from '../templates/drafts.js';
import type { TemplateRecord, TemplateRepo } from '../templates/repo.js';
import {
  draftOutputsSnapshot,
  templateIssues,
  validateTemplate,
} from '../templates/definitions.js';
import { checkSource, multipartField, NOT_A_SOURCE, TRACKED_CHANGES } from '../uploads.js';
import {
  WorkbenchConflictError,
  type IterationRecord,
  type ProposalRecord,
  type SampleRecord,
} from '../workbench/repo.js';

export const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase id: [a-z][a-z0-9_-]*');
const CreateProject = z.object({ id: Id, name: z.string().min(1).optional() }).strict();

type ProjectParams = { id: string };

/** Route docs (docs/design/api-docs.md). */
export const ProjectIdParams = z.object({
  id: z.string().describe('The project id: the id of its document type.'),
});
const SampleIdParams = z.object({
  id: z.string().describe('The project id.'),
  sid: z.string().uuid().describe('The sample id.'),
});
export const PROJECT_NOT_FOUND = error('`project not found`.');
const BriefVersionParams = z.object({ id: Id, version: z.coerce.number().int().positive() });
const BRIEF_VERSION_NOT_FOUND = '`project not found` or `brief version not found`.';
const SAMPLE_NOT_FOUND = error('`sample not found`.');
const DRAFT_NOT_VALID = res(
  'The open draft is not valid: `the draft is not valid`, with `issues`.',
  z.object({
    error: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
);
const STAGE_ORDER_CONFLICT = '`finish the {stage} stage first (accept or skip it)`';
const JobsCreated = z.object({ jobs: z.array(JobSummarySchema) });
const EVALUATION_REFUSED = {
  400: DRAFT_NOT_VALID,
  404: PROJECT_NOT_FOUND,
  409: error(
    '`no open draft; start the next version on the Template tab`, or `no verified references ' +
      'for the {set} samples; verify …`.',
  ),
};
const IterationIdParams = z.object({
  id: z.string().describe('The project id.'),
  iid: z.string().uuid().describe('The iteration id.'),
});
const ITERATION_NOT_FOUND = error('`iteration not found`.');
const WORKBENCH_DOCS =
  'https://github.com/kenhayward/ingestion-harness/blob/main/docs/design/workbench.md';

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
const FeedbackParams = z.object({ id: Id, fid: z.string().uuid() });

export const isAdmin = (app: FastifyInstance, req: FastifyRequest) =>
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

export async function projectView(
  app: FastifyInstance,
  project: WorkbenchProject,
): Promise<ProjectView> {
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
export async function readJsonSafe(
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

export function parseBody(stage: DraftStage, body: unknown): SurveyBody | ChangeBody | null {
  if (stage === 'survey') {
    const survey = SurveyBodySchema.safeParse(body);
    return survey.success ? survey.data : null;
  }
  return isChangeStage(stage) ? parseChangeBody(stage, body) : null;
}

/** Proposal status without reading its body (stage rail; order checks). */
export function statusOf(p: ProposalRecord, job: ProjectJob | null): ProposalStatus {
  if (p.decision) return p.decision;
  if (!job || job.status === 'queued' || job.status === 'running') return 'running';
  return job.status === 'succeeded' ? 'ready' : 'failed';
}

/** The four proposal stages (`STAGE_ORDER`), without references. */
export async function stagesOf(app: FastifyInstance, projectId: string): Promise<StageView[]> {
  const jobs = new Map((await app.deps.repo.listDraftJobs(projectId)).map((j) => [j.id, j]));
  const proposals = (await app.deps.workbench.listProposals(projectId)).map((p) => ({
    stage: p.stage,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
    status: statusOf(p, jobs.get(p.id) ?? null),
  }));
  const [skips, confirms] = await Promise.all([
    app.deps.workbench.listSkips(projectId),
    app.deps.workbench.listConfirms(projectId),
  ]);
  return stageStates(proposals, skips, confirms);
}

/** The body of the latest accepted survey, or null (context for the change stages). */
export async function acceptedSurvey(
  app: FastifyInstance,
  projectId: string,
): Promise<SurveyBody | null> {
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

/** The ready dev samples a drafting call may send (the holdout rule, ADR 0007), in sample order. */
function devSamplesOf(views: Awaited<ReturnType<typeof sampleViews>>) {
  return views
    .filter((s) => s.view.role === 'dev' && s.view.state === 'ready')
    .map((s) => ({
      sampleId: s.record.id,
      filename: s.record.filename,
      sha256: s.record.sha256,
      role: 'dev' as const,
    }));
}

/** Samples with their state, derived from each one's latest prepare job. */
export async function sampleViews(app: FastifyInstance, projectId: string) {
  const prepares = (await app.deps.repo.listProjectJobs(projectId)).filter(
    (j) => j.task === 'prepare',
  );
  // Progress and failure reasons (handoff SM1-SM2): only jobs running or needing review have any.
  const watched = prepares
    .filter((j) => j.status === 'running' || j.status === 'needs_review')
    .map((j) => j.id);
  const events = watched.length ? await app.deps.repo.latestEvents(watched, PREPARE_EVENTS) : [];
  const records = await app.deps.workbench.listSamples(projectId);
  // Holdout history: the holdout iterations that evaluated this sample's PDF.
  const holdoutIterations = (await app.deps.workbench.listIterations(projectId)).filter(
    (i) => i.set === 'holdout',
  );
  const shaByJob = await jobShas(app, projectId);
  const holdoutRuns = (sha256: string) =>
    holdoutIterations.filter((i) => iterationShas(i, shaByJob).includes(sha256)).length;
  return Promise.all(
    records.map(async (record) => ({
      record,
      view: await toView(
        app,
        record,
        prepares.find((j) => j.documentId === record.documentId) ?? null,
        holdoutRuns(record.sha256),
        events,
      ),
    })),
  );
}

/** The sha256 of each project job's PDF, by job id (deleted jobs are missing). */
async function jobShas(app: FastifyInstance, projectId: string): Promise<Map<string, string>> {
  return new Map((await app.deps.repo.listProjectRuns(projectId)).map((r) => [r.job.id, r.sha256]));
}

/**
 * The samples (sha256) an iteration evaluated: as recorded at creation (migration 0017), else,
 * for older iterations, from the documents of its jobs that still exist.
 */
function iterationShas(iteration: IterationRecord, shaByJob: Map<string, string>): string[] {
  return (
    iteration.sampleShas ??
    iteration.jobIds.flatMap((id) => {
      const sha = shaByJob.get(id);
      return sha ? [sha] : [];
    })
  );
}

async function toView(
  app: FastifyInstance,
  s: SampleRecord,
  job: JobSummary | null,
  holdoutRuns: number,
  events: readonly JobEventRecord[],
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
    prepare: prepareProgress(job, events),
    prepareError: prepareError(state, job, events),
    triage: triage === null ? null : PreparedTriageSchema.parse(triage),
    holdoutRuns,
  };
}

/**
 * Adds a PDF or Word document as a sample (queues its prepare job). Shared by upload and bundle
 * import.
 */
export async function addSampleFile(
  app: FastifyInstance,
  project: WorkbenchProject,
  input: {
    filename: string;
    body: Buffer;
    role: SampleRole;
    /** Label of the access token adding the sample: its prepare job's creator. */
    createdBy: string | null;
  },
): Promise<{ view: SampleView } | { code: 409 | 415 | 422; error: string }> {
  const { workbench, templates } = app.deps;
  const { filename, body, role, createdBy } = input;
  const projectId = project.id;
  const source = checkSource(body);
  if (!source.ok) return { code: source.code, error: source.error };

  const samples = await workbench.listSamples(projectId);
  if (samples.length >= MAX_SAMPLES) {
    return { code: 409, error: `a project holds at most ${MAX_SAMPLES} samples` };
  }
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (samples.some((s) => s.sha256 === sha256)) {
    return { code: 409, error: 'this file is already a sample of the project' };
  }

  const { draft, published } = await versionsOf(templates, projectId);
  const version = draft ?? published ?? 1;
  const documentId = randomUUID();
  const key = inboxKey(projectId, version, documentId, source.ext);
  await app.deps.store.put(app.deps.buckets.inbox, key, body, source.contentType);
  const job = await app.deps.repo.createWorkbenchJob(
    {
      id: documentId,
      filename,
      sha256,
      sizeBytes: body.length,
      specId: projectId,
      specVersion: version,
      bucket: app.deps.buckets.inbox,
      objectKey: key,
    },
    { projectId, task: 'prepare', params: { dataPolicy: project.dataPolicy }, createdBy },
  );
  try {
    const record = await workbench.addSample({
      projectId,
      documentId,
      role,
      addedForVersion: version,
    });
    return { view: await toView(app, record, job, 0, []) };
  } catch (err) {
    if (err instanceof WorkbenchConflictError) return { code: 409, error: err.message };
    throw err;
  }
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

/** Params of a reference run: forced review, plus the draft's outputs snapshot. */
const referenceRunParams = (
  dataPolicy: z.infer<typeof DataPolicySchema>,
  definition: Record<string, unknown>,
) => ({ dataPolicy, forceReview: true, ...draftOutputsSnapshot(definition) });

/** The project's current version (open draft, else latest published) and its definition. */
async function currentDefinition(app: FastifyInstance, projectId: string) {
  const { draft, published } = await versionsOf(app.deps.templates, projectId);
  const version = draft ?? published;
  const record = version === null ? null : await app.deps.templates.get(projectId, version);
  return {
    draft,
    version,
    definition: (record?.definition as Record<string, unknown> | undefined) ?? null,
  };
}

type CurrentReference = Awaited<ReturnType<typeof currentReferences>>['references'][number];

/** A reference row plus the sample's newest reference run (draft model), for stage state. */
interface ReferenceEntry {
  row: ReferenceRow;
  reference: CurrentReference | null;
  draftRun: JobSummary | null;
}

/** A reference that can be evaluated: present and verified against the current outputs. */
const verifiedRow = (row: ReferenceRow) =>
  row.reference !== null && row.reference.outdated.length === 0;

/**
 * The project's references for its current version (the open draft, else the latest published
 * version): carried forward from the newest earlier version when the draft has none yet, with
 * each one's `outputChanges` against the current outputs.
 */
async function currentReferences(app: FastifyInstance, projectId: string) {
  const current = await currentDefinition(app, projectId);
  const { draft, version, definition } = current;
  if (draft !== null) await app.deps.repo.carryReferencesForward(projectId, draft);
  const all = await app.deps.repo.listReferencesWithSha(projectId);
  const outputs = definition?.outputs ?? null;
  const versionOfRow = new Map(all.map((r) => [r.id, r.templateVersion]));
  // A re-verification supersedes the carried copy of the same PDF at the same version: that
  // copy says which version it came from and which output changes made it outdated.
  const replacedCopy = (r: (typeof all)[number]) =>
    r.copiedFrom !== null || r.templateVersion === null
      ? null
      : (all.find(
          (o) =>
            o.supersededAt !== null &&
            o.copiedFrom !== null &&
            o.sha256 === r.sha256 &&
            o.templateVersion === r.templateVersion,
        ) ?? null); // `all` is newest first
  const references = all
    .filter(
      (r) =>
        r.supersededAt === null && (r.templateVersion === null || r.templateVersion === version),
    )
    .map((r) => {
      const copy = replacedCopy(r);
      const from = copy === null ? null : (versionOfRow.get(copy.copiedFrom!) ?? null);
      return {
        ...r,
        carriedFrom: r.copiedFrom === null ? null : (versionOfRow.get(r.copiedFrom) ?? null),
        outdated: outputChanges(r.verifiedOutputs, outputs),
        reverified:
          copy === null || from === null
            ? null
            : { from, changed: outputChanges(copy.verifiedOutputs, r.verifiedOutputs) },
      };
    });
  return { references, definition: current.definition };
}

/**
 * Ready samples of one set with their newest reference (by PDF sha256) and newest
 * non-evaluation run.
 */
export async function referenceRows(
  app: FastifyInstance,
  projectId: string,
  set: EvaluationSet = 'dev',
  preloaded?: SampleViews,
  withReviews = false,
): Promise<ReferenceRow[]> {
  return (await referenceEntries(app, projectId, set, preloaded, withReviews)).entries.map(
    (e) => e.row,
  );
}

/**
 * One sample's reference with each current output's value and provenance (handoff RF2), or why
 * there is none. Reads the sample's set the same way as `referenceRows` (one review query).
 */
async function referenceDetail(
  app: FastifyInstance,
  projectId: string,
  sampleId: string,
): Promise<ReferenceDetail | 'sample not found' | 'no reference for this sample'> {
  const views = await sampleViews(app, projectId);
  const sample = views.find((s) => s.record.id === sampleId);
  if (!sample) return 'sample not found';
  const { entries, definition } = await referenceEntries(
    app,
    projectId,
    sample.view.role,
    views,
    true,
  );
  const entry = entries.find((e) => e.row.sampleId === sampleId);
  if (!entry?.reference || !entry.row.reference) return 'no reference for this sample';
  const { reference } = entry;
  const info = entry.row.reference;
  const values = outputCoverage(definition).outputs.map((o) => {
    const own =
      info.corrections === null
        ? null
        : info.corrections.filter((c) => correctionOutput(c.key) === o.id);
    const first = own?.[0];
    return {
      id: o.id,
      kind: o.kind,
      value:
        o.kind === 'field'
          ? (reference.expected.fields[o.id] ?? null)
          : (reference.expected.tables[o.id] ?? []),
      // An output the reference was not verified for (outdated) has no value to attribute.
      provenance:
        own === null || info.outdated.includes(`${o.kind}:${o.id}`) ? null : outputProvenance(own),
      proposed: o.kind === 'field' && first?.kind === 'corrected' ? first.proposed : null,
      corrections: own ?? [],
    };
  });
  const job = info.sourceJobId ? await app.deps.repo.getJob(info.sourceJobId) : null;
  const models = job
    ? [
        ...new Set(
          (await app.deps.repo.listStepRuns(job.id)).flatMap((r) =>
            r.status === 'succeeded' && r.model ? [r.model] : [],
          ),
        ),
      ]
    : [];
  return {
    sampleId,
    filename: sample.record.filename,
    role: sample.view.role,
    reference: info,
    run: job && { jobId: job.id, modelOverride: job.modelOverride, models },
    values,
    corrections: info.corrections,
  };
}

/** `sampleViews`' result: pass it to `referenceRows` when the caller has already loaded it. */
export type SampleViews = Awaited<ReturnType<typeof sampleViews>>;

async function referenceEntries(
  app: FastifyInstance,
  projectId: string,
  set: EvaluationSet = 'dev',
  preloaded?: SampleViews,
  /** Fetch the source runs' reviews for `corrections` (one query); only the references routes read them. */
  withReviews = false,
): Promise<{ entries: ReferenceEntry[]; definition: Record<string, unknown> | null }> {
  const samples = (preloaded ?? (await sampleViews(app, projectId)))
    .filter((s) => s.view.role === set && s.view.state === 'ready')
    .map((s) => s.record)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const { references, definition } = await currentReferences(app, projectId);
  const runs = (await app.deps.repo.listProjectRuns(projectId)).filter(
    (r) => r.job.referenceId === null,
  );
  // Newest first; a reference pinned to the current version wins over an unpinned one.
  const picked = samples.map(
    (s) =>
      references.find((r) => r.sha256 === s.sha256 && r.templateVersion !== null) ??
      references.find((r) => r.sha256 === s.sha256) ??
      null,
  );
  const sourceIds = picked.flatMap((r) => (r?.sourceJobId ? [r.sourceJobId] : []));
  const reviews = new Map(
    (withReviews && sourceIds.length ? await app.deps.repo.listJobReviews(sourceIds) : []).map(
      (r) => [r.jobId, r],
    ),
  );
  const info = (r: CurrentReference): ReferenceInfo => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    version: r.templateVersion,
    carriedFrom: r.carriedFrom,
    outdated: r.outdated,
    sourceJobId: r.sourceJobId,
    ...referenceCorrections((r.sourceJobId && reviews.get(r.sourceJobId)) || null, r.createdAt),
    reverified: r.reverified,
  });
  const entries = samples.map((s, i) => {
    const reference = picked[i]!;
    const run = runs.find((r) => r.sha256 === s.sha256)?.job ?? null;
    const draftRun =
      runs.find((r) => r.sha256 === s.sha256 && r.job.modelOverride === 'draft')?.job ?? null;
    return {
      draftRun,
      reference,
      row: {
        sampleId: s.id,
        filename: s.filename,
        sha256: s.sha256,
        reference: reference && info(reference),
        run: run && {
          jobId: run.id,
          status: run.status,
          error: run.error,
          modelOverride: run.modelOverride,
        },
      },
    };
  });
  return { entries, definition };
}

async function referencesView(
  app: FastifyInstance,
  projectId: string,
  earlier: StageView[],
): Promise<StageView> {
  const { entries } = await referenceEntries(app, projectId, 'dev');
  const rows = entries.map((e) => e.row);
  const verified = rows.filter(verifiedRow);
  // Only reference runs (draft model) of samples still without a verified reference count: a
  // 3a test run or an old run of a verified sample says nothing about this stage.
  const referenceRuns = entries
    .filter((e) => !verifiedRow(e.row) && e.draftRun !== null)
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
export async function allStages(app: FastifyInstance, projectId: string): Promise<StageView[]> {
  const earlier = await stagesOf(app, projectId);
  return [...earlier, await referencesView(app, projectId, earlier)];
}

const EvaluateBody = z
  .object({
    model: z.enum(EVALUATION_MODELS).optional(),
    uncached: z.boolean().optional(),
    set: z.enum(EVALUATION_SETS).optional(),
  })
  .strict();
const ReferencesQuery = z.object({ set: z.enum(EVALUATION_SETS).optional() });
const CompareBody = z.object({ uncached: z.boolean().optional() }).strict();
const IterationParams = z.object({ id: Id, iid: z.string().uuid() });
const ComparisonParams = z.object({ id: Id, groupId: z.string().uuid() });

/**
 * A finished job's comparison with its reference; null when the job has no readable document
 * (none written, corrupt JSON, or not shaped like a document). `raw` compares the models'
 * output, ignoring review edits (holdout: a review must not raise the score).
 */
async function sampleComparison(
  app: FastifyInstance,
  job: JobDetail,
  reference: Reference,
  raw: boolean,
) {
  try {
    const document = await jobDocument(app, job, { raw });
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
          ? await sampleComparison(app, job, reference, iteration.set === 'holdout')
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
  const runs = (await Promise.all(iteration.jobIds.map((id) => app.deps.repo.listStepRuns(id))))
    .flat()
    .filter((r) => r.status === 'succeeded');
  return {
    ...summaryOf(iteration),
    status,
    ...scores,
    cache: { reused: runs.filter((r) => r.cached).length, total: runs.length },
    scorecard,
    samples: results,
  };
}

/** A job whose result can still change: the gate does not cache an iteration holding one. */
export const unsettledJob = (status: JobStatus) =>
  status === 'queued' || status === 'running' || status === 'awaiting_review';

/**
 * What the gate's cached score of an iteration depends on: each of its jobs (in `jobIds` order)
 * as `[id, status, updatedAt, referenceId]`, a deleted job as `[id, null, null, null]`.
 */
function gateFingerprint(jobIds: string[], jobs: (JobSummary | null)[]): string {
  const parts = jobIds.map((id, n) => {
    const job = jobs[n];
    return job ? [id, job.status, job.updatedAt, job.referenceId] : [id, null, null, null];
  });
  return createHash('sha256').update(stableJson(parts)).digest('hex');
}

/**
 * The publish gate for the open draft (ADR 0007). Only holdout iterations that ran exactly this
 * draft (version and definition) with the template's own models count; their scores are computed
 * from the jobs (raw output, so review edits never raise them) and cached per iteration under a
 * fingerprint of its jobs (`gateFingerprint`), so a score is reused only while none of its jobs
 * changed. Coverage is always measured against the holdout samples that are ready now.
 * `definition` is the draft the gate was decided for.
 */
export async function gateFor(
  app: FastifyInstance,
  project: WorkbenchProject,
  /** The hints are wanted: a cache row without them (or for another threshold) is a miss. */
  { withHints = false }: { withHints?: boolean } = {},
): Promise<
  GateView & {
    draft: number | null;
    definition: Record<string, unknown> | null;
    /** What lowers the deciding iteration's score; cached with its score (EV1). */
    hints: GateHint[];
  }
> {
  const { draft } = await versionsOf(app.deps.templates, project.id);
  if (draft === null) {
    return {
      threshold: project.publishThreshold,
      iterationId: null,
      score: null,
      passes: false,
      reason: 'no open draft to publish',
      draft,
      definition: null,
      hints: [],
    };
  }
  const { definition } = (await app.deps.templates.get(project.id, draft))!;
  const current = stableJson(definition);
  const ready = (await sampleViews(app, project.id))
    .filter((s) => s.record.role === 'holdout' && s.view.state === 'ready')
    .map((s) => s.record.sha256);
  const runs = await app.deps.repo.listProjectRuns(project.id);
  const shaByJob = new Map(runs.map((r) => [r.job.id, r.sha256]));
  const jobById = new Map(runs.map((r) => [r.job.id, r.job]));
  const holdout = (await app.deps.workbench.listIterations(project.id)).filter(
    (i) => i.set === 'holdout',
  );
  const hintsOf = new Map<string, GateHint[]>();
  const candidates = await Promise.all(
    holdout.map(async (i): Promise<GateCandidate> => {
      const matchesDraft = i.templateVersion === draft && stableJson(i.definition) === current;
      const evaluated = new Set(iterationShas(i, shaByJob));
      const base = {
        id: i.id,
        createdAt: i.createdAt,
        matchesDraft,
        model: i.model,
        covered: ready.filter((sha) => evaluated.has(sha)).length,
        holdoutSamples: ready.length,
      };
      if (!matchesDraft || i.model !== null) {
        // publishGate ignores it; not worth scoring.
        return { ...base, status: 'running', score: null, completed: 0, total: i.jobIds.length };
      }
      // Relies on evaluation jobs being RUN_TASKS (process, rerun, publish), the tasks
      // listProjectRuns returns: a job of any other task would read as deleted (null) here.
      const jobs = i.jobIds.map((id) => jobById.get(id) ?? null);
      const fingerprint = gateFingerprint(i.jobIds, jobs);
      const cache = i.gateCache;
      if (
        cache?.fingerprint === fingerprint &&
        (!withHints ||
          (cache.hints !== undefined && cache.hintsThreshold === project.publishThreshold))
      ) {
        // Only stored once every job had finished, so the iteration is complete.
        const { score, completed, total } = cache;
        if (cache.hints !== undefined) hintsOf.set(i.id, cache.hints);
        return { ...base, status: 'complete', score, completed, total };
      }
      const view = await iterationView(app, i);
      const { status, score, completed, total } = view;
      const hints = gateHints({
        threshold: project.publishThreshold,
        scorecard: view.scorecard,
        definition,
      });
      hintsOf.set(i.id, hints);
      if (status === 'complete' && jobs.every((j) => j === null || !unsettledJob(j.status))) {
        await app.deps.workbench.setGateCache(i.id, {
          fingerprint,
          score,
          completed,
          total,
          hints,
          hintsThreshold: project.publishThreshold,
        });
      }
      return { ...base, status, score, completed, total };
    }),
  );
  const decided = publishGate({ threshold: project.publishThreshold, candidates });
  return {
    ...decided,
    draft,
    definition,
    hints: (decided.iterationId && hintsOf.get(decided.iterationId)) || [],
  };
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
    groupId: iteration.groupId,
    uncached: iteration.uncached,
    createdAt: iteration.createdAt,
  };
}

/** What an evaluation needs, checked once per request (a comparison starts three). */
interface EvaluationInputs {
  project: WorkbenchProject;
  draft: number;
  record: TemplateRecord;
  rows: ReferenceRow[];
  samples: Map<string, SampleRecord>;
}

/**
 * Checks that the project, its open draft and the verified references of `set` are ready for
 * an evaluation. Sends the error reply and returns null when they are not.
 */
async function evaluationInputs(
  app: FastifyInstance,
  projectId: string,
  reply: FastifyReply,
  set: EvaluationSet = 'dev',
): Promise<EvaluationInputs | null> {
  const { workbench, templates } = app.deps;
  const project = await workbench.getProject(projectId);
  if (!project) {
    await reply.code(404).send({ error: 'project not found' });
    return null;
  }
  const { draft } = await versionsOf(templates, projectId);
  if (draft === null) {
    await reply
      .code(409)
      .send({ error: 'no open draft; start the next version on the Template tab' });
    return null;
  }
  const record = (await templates.get(projectId, draft))!;
  const issues = validateTemplate(record.definition);
  if (issues.length) {
    await reply.code(400).send({ error: 'the draft is not valid', issues });
    return null;
  }
  const rows = (await referenceRows(app, projectId, set)).filter(verifiedRow);
  if (!rows.length) {
    await reply.code(409).send({
      error:
        set === 'dev'
          ? 'no verified references for the dev samples; verify some on the References tab first'
          : 'no verified references for the holdout samples; verify them on the References tab first',
    });
    return null;
  }
  const samples = new Map((await sampleViews(app, projectId)).map((s) => [s.record.id, s.record]));
  return { project, draft, record, rows, samples };
}

/**
 * Starts an evaluation of the open draft against the verified references of `options.set`
 * (the rows `evaluationInputs` gathered for that set): one job per reference, recorded as an
 * iteration of that set.
 */
async function startIteration(
  app: FastifyInstance,
  req: FastifyRequest<{ Params: ProjectParams }>,
  inputs: EvaluationInputs,
  options: {
    set: EvaluationSet;
    model: EvaluationModel | null;
    uncached: boolean;
    groupId: string | null;
  },
): Promise<IterationRecord> {
  const { workbench } = app.deps;
  const projectId = req.params.id;
  const { project, draft, record, rows, samples } = inputs;
  const { set, model, uncached, groupId } = options;
  const jobs = await Promise.all(
    rows.map((row) =>
      app.deps.repo.createWorkbenchJob(
        sampleDocument(samples.get(row.sampleId)!, projectId, draft),
        {
          projectId,
          task: 'process',
          params: {
            dataPolicy: project.dataPolicy,
            ...(uncached ? { uncached: true } : {}),
            ...draftOutputsSnapshot(record.definition),
          },
          referenceId: row.reference!.id,
          modelOverride: model,
          createdBy: req.auth?.label ?? null,
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
    set,
    model,
    jobIds: jobs.map((j) => j.id),
    sampleShas: rows.map((row) => row.sha256),
    groupId,
    uncached,
  });
  req.log.info(
    {
      projectId,
      iteration: iteration.id,
      version: draft,
      set,
      model,
      uncached,
      groupId,
      jobs: jobs.length,
    },
    'evaluation started',
  );
  return iteration;
}

/** /api/workbench (ADR 0007, phase 1): projects, samples, brief, dev test runs. */
export const workbenchRoutes: FastifyPluginAsync = async (app) => {
  const { workbench, templates } = app.deps;

  app.get<{ Querystring: Record<string, string> }>(
    '/workbench/projects',
    {
      schema: {
        tags: ['Projects & data policy'],
        operationId: 'listProjects',
        summary: 'List Workbench projects',
        description: md`
          A page of the Workbench projects (one per document type), each with its stage states,
          phase, next step, holdout score and sample counts. \`q\` matches the name or id;
          \`phase\`, \`policy\` and \`ids\` (comma-separated, at most 20) narrow the list; \`filter\` picks a chip. \`total\` counts
          what every filter leaves, and \`facets\` count each chip ignoring \`filter\` (but
          honouring \`q\`, \`phase\`, \`policy\` and \`ids\`). Sorts: \`activity\` (latest first),
          \`name\`, \`score\` (lowest first, none last), \`samples\` (fewest first). A page
          past the end has no items. Rows are recomputed only for projects that changed since
          the last request.

          Deprecated: \`all=1\` returns every project unpaged, as an array of summaries (draft,
          published version and sample count), and ignores the other parameters. Unused by the
          web; kept for API consumers.
        `,
        querystring: ProjectListQuerySchema.extend({
          all: z.literal('1').optional().describe('Deprecated: the unpaged summary array.'),
        }),
        response: {
          200: res(
            'The page; with `all=1` the unpaged list (deprecated).',
            z.union([ProjectListPageSchema, z.array(ProjectSummarySchema)]),
          ),
          400: error(
            'Zod issues for an invalid query (for example `size` other than 25, 50 or 100).',
          ),
        },
      },
    },
    async (req, reply) => {
      if (req.query.all !== '1') {
        const query = ProjectListQuerySchema.safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: query.error.issues });
        return listProjectsPage(app, query.data);
      }
      return listAllProjects();
    },
  );

  /** The unpaged list behind `?all=1` (unused by the web; kept for API consumers). */
  async function listAllProjects(): Promise<ProjectSummary[]> {
    const projects = await workbench.listProjects();
    return Promise.all(
      projects.map(async (p) => {
        const { draft, published } = await versionsOf(templates, p.id);
        return { ...p, draft, published, samples: (await workbench.listSamples(p.id)).length };
      }),
    );
  }

  /** New project. An existing document type is opened: its open draft, or a new next draft. */
  app.post(
    '/workbench/projects',
    {
      schema: {
        tags: ['Projects & data policy'],
        operationId: 'createProject',
        summary: 'Create a Workbench project',
        description: md`
          Starts a project for a document type. For a new type, \`name\` is required and a v1
          draft is created. For an existing type, the project opens its draft (a new next draft
          when none is open) and takes the type's name. New projects are \`local\`: their
          samples may only be sent to local models until an admin allows external ones. See the
          [Workbench design](${WORKBENCH_DOCS}).`,
        body: CreateProject,
        response: {
          201: res('The new project.', ProjectViewSchema),
          400: error(
            'Zod issues for an invalid id, or `name is required for a new document type`.',
          ),
          409: error('`a workbench project for {id} already exists`.'),
        },
      },
    },
    async (req, reply) => {
      const body = CreateProject.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { id } = body.data;
      if (await workbench.getProject(id)) {
        return reply.code(409).send({ error: `a workbench project for ${id} already exists` });
      }
      const { draft, latest } = await versionsOf(templates, id);
      let name = body.data.name;
      if (latest === null) {
        if (!name)
          return reply.code(400).send({ error: 'name is required for a new document type' });
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
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id',
    {
      schema: {
        tags: ['Projects & data policy'],
        operationId: 'getProject',
        summary: 'Get a Workbench project',
        description: md`
          The project's settings (data policy, publish threshold, who changed them), its open
          draft and latest published version, and the latest version of its brief.
        `,
        params: ProjectIdParams,
        response: { 200: res('The project.', ProjectViewSchema), 404: PROJECT_NOT_FOUND },
      },
    },
    async (req, reply) => {
      const project = await workbench.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      return projectView(app, project);
    },
  );

  /** Project settings: the holdout score at which the (informational) publish gate passes. */
  app.patch<{ Params: ProjectParams }>(
    '/workbench/projects/:id',
    {
      schema: {
        tags: ['Projects & data policy'],
        operationId: 'updateProject',
        summary: 'Set the publish threshold',
        description: md`
          Sets the holdout score (0 to 1, default 0.9) at which the publish gate passes. The gate
          is informational: publishing never needs it. The change is recorded with the signed-in token's label.
        `,
        params: ProjectIdParams,
        body: ThresholdBodySchema,
        response: {
          200: res('The project.', ProjectViewSchema),
          400: error('Zod issues: `publishThreshold` must be between 0 and 1.'),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const body = ThresholdBodySchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const project = await workbench.setPublishThreshold(
        req.params.id,
        body.data.publishThreshold,
        req.auth?.label ?? null,
      );
      if (!project) return reply.code(404).send({ error: 'project not found' });
      req.log.info(
        {
          projectId: project.id,
          publishThreshold: project.publishThreshold,
          by: project.thresholdSetBy,
        },
        'publish threshold changed',
      );
      return projectView(app, project);
    },
  );

  /**
   * Delete a project whose type was never published: its rows and template drafts in one
   * transaction (which also refuses a published type), then its internal files (best-effort).
   * Published types keep their project.
   */
  app.delete<{ Params: ProjectParams }>(
    '/workbench/projects/:id',
    {
      schema: {
        tags: ['Projects & data policy'],
        operationId: 'deleteProject',
        summary: 'Delete an unpublished project',
        description: md`
          Deletes a project whose document type was never published: its samples, brief,
          proposals, feedback, iterations, jobs and template drafts, then its files (best
          effort). A document type with a published version keeps its project.
        `,
        params: ProjectIdParams,
        response: {
          204: noContent('Deleted.'),
          404: PROJECT_NOT_FOUND,
          409: error(
            '`{id} has a published version; published document types keep their project`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const id = req.params.id;
      const removed = await workbench.deleteProject(id);
      if (!removed) return reply.code(404).send({ error: 'project not found' });
      if (removed === 'published') {
        return reply.code(409).send({
          error: `${id} has a published version; published document types keep their project`,
        });
      }
      const { store, buckets } = app.deps;
      await Promise.all(removed.jobs.map((job) => removeJobFiles(app.deps, job, req.log)));
      const files = await Promise.allSettled([
        ...removed.documents.map((o) => store.delete(o.bucket, o.key)),
        ...['drafting', 'segmentation', 'exports'].map((prefix) =>
          store.deletePrefix(buckets.runs, `${prefix}/${id}/`),
        ),
      ]);
      for (const result of files) {
        if (result.status === 'rejected') {
          req.log.warn({ err: result.reason, projectId: id }, 'project file clean-up failed');
        }
      }
      req.log.info(
        { projectId: id, jobs: removed.jobs.length, documents: removed.documents.length },
        'workbench project deleted',
      );
      return reply.code(204).send();
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/publish-gate',
    {
      schema: {
        tags: ['Holdout & publish gate'],
        operationId: 'getPublishGate',
        summary: 'Check the publish gate',
        description: md`
          Whether the open draft meets the holdout bar. Informational only: references and
          evaluation are optional, and publishing never needs the gate. The newest complete
          holdout iteration that evaluated the draft exactly as it is now (version and
          definition), with the template's own models, decides. It passes only when it covered
          every ready holdout sample, compared every sample it evaluated (a job that failed,
          needs review, was cancelled or deleted fails it), and scored at or above the
          project's threshold. \`reason\` says why it passes or fails. Scores are recomputed
          from the models' raw output, so review edits cannot raise them.

          \`hints\` (handoff EV1) are the deciding iteration's fields and \`table.column\`s
          below the threshold, worst first, at most 5: \`no_step\` when no step of the draft
          fills the output (fix on the Steps tab, \`stage: steps\`), else \`low_accuracy\`
          (\`stage: revise\`). Empty without a deciding iteration. The overview's \`gate\`
          carries no hints.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The gate and what lowers its score.', PublishGateViewSchema),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply): Promise<PublishGateView> => {
      const project = await workbench.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const { threshold, iterationId, score, passes, reason, hints } = await gateFor(app, project, {
        withHints: true,
      });
      return { threshold, iterationId, score, passes, reason, hints };
    },
  );

  /** Publish the open draft; the holdout gate is recorded but never blocks. */
  app.post<{ Params: ProjectParams }>(
    '/workbench/projects/:id/publish',
    {
      schema: {
        tags: ['Holdout & publish gate'],
        operationId: 'publishProject',
        summary: 'Publish the draft through the gate',
        description: md`
          Publishes the open draft when it is valid. References and evaluation are optional: the
          publish gate is informational only, and its iteration and score (if any) are recorded
          with the publication. \`overrideReason\` is still accepted but ignored (no override is
          needed or recorded). If the draft changes after the gate was decided, nothing is published: check the gate
          again. Every publication is logged (\`GET …/publications\`). This is the only way to
          publish a Workbench document type. See
          [ADR 0007](https://github.com/kenhayward/ingestion-harness/blob/main/docs/adr/0007-workbench.md).
        `,
        params: ProjectIdParams,
        body: PublishBodySchema,
        response: {
          201: res(
            'Published.',
            z.object({ publication: PublicationSchema, project: ProjectViewSchema }),
          ),
          400: res(
            'Zod issues (an ignored override reason under 10 characters), or `the draft is not ' +
              'valid` ' +
              '(with `issues`).',
            z.object({ error: z.unknown(), issues: z.array(z.unknown()).optional() }),
          ),
          404: PROJECT_NOT_FOUND,
          409: res(
            '`no open draft to publish`, or `the draft changed while publishing; check the gate ' +
              'again`.',
            z.object({ error: z.string(), gate: GateViewSchema.optional() }),
          ),
        },
      },
    },
    async (req, reply) => {
      const body = PublishBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const projectId = req.params.id;
      const project = await workbench.getProject(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const { draft, definition, ...gate } = await gateFor(app, project);
      if (draft === null) return reply.code(409).send({ error: 'no open draft to publish' });
      const issues = await templateIssues(
        app.deps,
        (await templates.get(projectId, draft))!.definition,
      );
      if (issues.length) return reply.code(400).send({ error: 'the draft is not valid', issues });
      // The gate was decided for the draft as it was read then; an edit since then voids it. The
      // re-check, the publish and the publication record share one transaction.
      const outcome = await workbench.publishDraft({
        projectId,
        version: draft,
        definition: definition!,
        publication: {
          projectId,
          version: draft,
          iterationId: gate.iterationId,
          score: gate.score,
          threshold: gate.threshold,
          // References and evaluation are optional: the gate never blocks, so nothing is overridden.
          overrideReason: null,
          publishedBy: req.auth?.label ?? null,
        },
      });
      if (outcome.result === 'changed') {
        return reply
          .code(409)
          .send({ error: 'the draft changed while publishing; check the gate again' });
      }
      if (outcome.result === 'not-draft') {
        return reply.code(409).send({ error: 'no open draft to publish' });
      }
      const { publication } = outcome;
      req.log.info(
        {
          projectId,
          version: draft,
          iterationId: gate.iterationId,
          score: gate.score,
          threshold: gate.threshold,
          passes: gate.passes,
        },
        'workbench draft published',
      );
      return reply.code(201).send({ publication, project: await projectView(app, project) });
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/publications',
    {
      schema: {
        tags: ['Holdout & publish gate'],
        operationId: 'listPublications',
        summary: "List a project's publications",
        description: md`
          Every version published from the Workbench, newest first: the iteration and score the
          gate used (null when no holdout evaluation decided it), the threshold, the override
          reason of publications made while overrides were still needed, and who published it.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The publications.', z.array(PublicationSchema)),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply): Promise<Publication[]> => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      return workbench.listPublications(req.params.id);
    },
  );

  const findSample = async (projectId: string, sampleId: string) =>
    (await sampleViews(app, projectId)).find((s) => s.record.id === sampleId) ?? null;

  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/samples',
    {
      schema: {
        tags: ['Samples & brief'],
        operationId: 'listSamples',
        summary: "List a project's samples",
        description: md`
          The project's sample PDFs with their role (\`dev\` or \`holdout\`) and preparation
          state: \`preparing\` while the worker extracts the text (with OCR where needed),
          \`ready\` with the triage (pages, OCR'd pages, characters), or \`failed\` with the
          error. \`holdoutRuns\` counts the holdout evaluations that used the PDF. While preparing,
          \`prepare\` says how far the current attempt got (\`text\` read, or \`page\` of \`of\` OCR
          pages done); a failed sample's \`prepareError\` gives a \`code\` (\`password\`,
          \`corrupt\`, \`too_large\`, \`other\`) and the message.
        `,
        params: ProjectIdParams,
        response: { 200: res('The samples.', z.array(SampleViewSchema)), 404: PROJECT_NOT_FOUND },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      return (await sampleViews(app, req.params.id)).map((s) => s.view);
    },
  );

  /** Upload one sample PDF or Word document (multipart: `role` field first, then the file). */
  app.post<{ Params: ProjectParams }>(
    '/workbench/projects/:id/samples',
    {
      schema: {
        tags: ['Samples & brief'],
        operationId: 'addSample',
        summary: 'Upload a sample document',
        consumes: ['multipart/form-data'],
        description: md`
          Adds a sample to the project and queues its preparation (text extraction, with OCR
          for pages without a text layer). A sample is a PDF or a Word document (\`.docx\`,
          without tracked changes), which the worker converts to PDF first. Send \`role\`
          **before** the file. **Dev** samples are what drafting sees; **holdout** samples are
          only used to score the draft before publishing, never shown to a drafting model. A
          project holds at most 12 samples, each file once.
        `,
        params: ProjectIdParams,
        body: multipart(
          {
            role: {
              type: 'string',
              enum: ['dev', 'holdout'],
              description: '`dev` (default) or `holdout`.',
            },
          },
          [],
        ),
        response: {
          201: res('The new sample, preparing.', SampleViewSchema),
          400: error('`file part is required`, or `role must be dev or holdout`.'),
          404: PROJECT_NOT_FOUND,
          406: error('The request is not `multipart/form-data`.'),
          409: error(
            '`a project holds at most 12 samples`, or `this file is already a sample of the ' +
              'project`.',
          ),
          413: error('The file is larger than the upload limit.'),
          415: error(`\`${NOT_A_SOURCE}\`.`),
          422: error(`\`${TRACKED_CHANGES}\`, or the Word document is too large to check.`),
        },
      },
    },
    async (req, reply) => {
      const projectId = req.params.id;
      const project = await workbench.getProject(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'file part is required' });
      const role = SampleRoleSchema.safeParse(multipartField(file, 'role') ?? 'dev');
      if (!role.success) return reply.code(400).send({ error: 'role must be dev or holdout' });
      const body = await file.toBuffer(); // throws RequestFileTooLargeError (413) past the limit
      const added = await addSampleFile(app, project, {
        filename: file.filename,
        body,
        role: role.data,
        createdBy: req.auth?.label ?? null,
      });
      if ('error' in added) return reply.code(added.code).send({ error: added.error });
      return reply.code(201).send(added.view);
    },
  );

  app.patch<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/samples/:sid',
    {
      schema: {
        tags: ['Samples & brief'],
        operationId: 'setSampleRole',
        summary: "Change a sample's role",
        description: md`
          Moves a sample between the dev and holdout sets. A sample moved to holdout stops
          being sent to drafting models, and bundles exported while it was dev can no longer be
          downloaded.
        `,
        params: SampleIdParams,
        body: RoleBody,
        response: {
          200: res('The sample.', SampleViewSchema),
          400: error('Zod issues: `role` must be `dev` or `holdout`.'),
          404: SAMPLE_NOT_FOUND,
        },
      },
    },
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
    {
      schema: {
        tags: ['Samples & brief'],
        operationId: 'removeSample',
        summary: 'Remove a sample',
        description: md`
          Removes a sample from the project. Its document and earlier jobs are kept, so past
          evaluations still show it.
        `,
        params: SampleIdParams,
        response: { 204: noContent('Removed.'), 404: SAMPLE_NOT_FOUND },
      },
    },
    async (req, reply) => {
      const params = SampleParams.safeParse(req.params);
      const removed =
        params.success && (await workbench.removeSample(params.data.id, params.data.sid));
      return removed ? reply.code(204).send() : reply.code(404).send({ error: 'sample not found' });
    },
  );

  app.get<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/samples/:sid/text',
    {
      schema: {
        tags: ['Samples & brief'],
        operationId: 'getSampleText',
        summary: "Get a sample's prepared text",
        description: md`
          The text the worker extracted from a ready sample, page by page, with \`ocr: true\`
          on pages read by the vision model. This is the text segmentation and drafting work
          from.
        `,
        params: SampleIdParams,
        response: {
          200: res('The prepared text.', PreparedTextSchema),
          404: SAMPLE_NOT_FOUND,
          409: error('`sample is {state}, not ready`, or `prepared text is missing`.'),
        },
      },
    },
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
  app.put<{ Params: ProjectParams }>(
    '/workbench/projects/:id/brief',
    {
      schema: {
        tags: ['Samples & brief'],
        operationId: 'saveBrief',
        summary: 'Save the brief',
        description: md`
          The brief tells the drafting model what the document type is for: its purpose, the
          outputs wanted, an example, a glossary, known variants, rules, and the answers to the
          survey's questions. Saving a changed brief creates a new version (\`201\`); saving
          the same brief returns the latest version (\`200\`). Missing fields are empty.
        `,
        params: ProjectIdParams,
        body: BriefBodySchema,
        response: {
          200: res('Unchanged: the latest version.', BriefSchema),
          201: res('The new version.', BriefSchema),
          400: error('Zod issues for an invalid brief.'),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const body = BriefBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const latest = await workbench.latestBrief(req.params.id);
      if (latest && JSON.stringify(latest.body) === JSON.stringify(body.data)) return latest;
      return reply.code(201).send(await workbench.saveBrief(req.params.id, body.data));
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/briefs',
    {
      schema: {
        tags: ['Samples & brief'],
        operationId: 'listBriefVersions',
        summary: "List the brief's versions",
        description: md`
          Every saved version of the brief, newest first. \`changedSections\` names the
          sections that differ from the previous version (for version 1, the sections with
          text); \`usedBy\` names the drafting stages whose newest accepted or partially
          accepted proposal was drafted from that version.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The versions, newest first.', z.array(BriefVersionViewSchema)),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      return briefVersions(
        await workbench.listBriefs(req.params.id),
        await workbench.listProposals(req.params.id),
      );
    },
  );

  app.get<{ Params: { id: string; version: string } }>(
    '/workbench/projects/:id/briefs/:version',
    {
      schema: {
        tags: ['Samples & brief'],
        operationId: 'getBriefVersion',
        summary: 'Get one version of the brief',
        description: md`
          The body of one saved version, for comparing versions (the Brief tab diffs two of
          them section by section).
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          version: z.string().describe('The brief version: 1, 2, …'),
        }),
        response: { 200: res('That version.', BriefSchema), 404: error(BRIEF_VERSION_NOT_FOUND) },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const params = BriefVersionParams.safeParse(req.params);
      const found = params.success
        ? await workbench.getBrief(params.data.id, params.data.version)
        : null;
      return found ?? reply.code(404).send({ error: 'brief version not found' });
    },
  );

  /** Test-run the open draft on every prepared dev sample (holdout samples are not used). */
  app.post<{ Params: ProjectParams }>(
    '/workbench/projects/:id/test-runs',
    {
      schema: {
        tags: ['Test runs'],
        operationId: 'startTestRuns',
        summary: 'Test-run the draft on the dev samples',
        description: md`
          Queues a test job of the open draft for every ready dev sample (holdout samples are
          never used). Jobs carry the project's data policy and a snapshot of the draft's
          outputs. Test runs reuse a step's stored output when its full input is unchanged
          (the step cache), so only changed steps call a model. They are never delivered.
        `,
        params: ProjectIdParams,
        response: {
          201: res('The queued jobs.', z.object({ jobs: z.array(JobSummarySchema) })),
          400: DRAFT_NOT_VALID,
          404: PROJECT_NOT_FOUND,
          409: error(
            '`no open draft to test; start the next version first`, or `no prepared dev ' +
              'samples to run`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const projectId = req.params.id;
      const project = await workbench.getProject(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const { draft } = await versionsOf(templates, projectId);
      if (draft === null) {
        return reply
          .code(409)
          .send({ error: 'no open draft to test; start the next version first' });
      }
      const { definition } = (await templates.get(projectId, draft))!;
      const issues = validateTemplate(definition);
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
            params: { dataPolicy: project.dataPolicy, ...draftOutputsSnapshot(definition) },
            createdBy: req.auth?.label ?? null,
          }),
        ),
      );
      return reply.code(201).send({ jobs });
    },
  );

  /** Preview anchors over every prepared sample (worker task `segment`; ADR 0007). */
  app.post<{ Params: ProjectParams }>(
    '/workbench/projects/:id/segmentations',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'previewSegmentation',
        summary: 'Preview section anchors on the samples',
        description: md`
          Queues an anchor preview: the worker splits every ready sample into sections with the
          given \`document\` block (\`sections\`, and optionally \`copies\` and
          \`pageMarkers\`; default: the open draft's), using the same code as production.
          Poll \`GET …/segmentations/{jobId}\`. A project has one preview at a time: a new one
          replaces the old. A preview that runs over 10 seconds (an anchor regex that
          backtracks) is stopped and goes to \`needs_review\`.
        `,
        params: ProjectIdParams,
        body: z.object({
          document: z
            .unknown()
            .optional()
            .describe("A template's `document` block. Default: the open draft's."),
        }),
        response: {
          202: res('The queued preview.', SegmentationViewSchema),
          400: error('Zod issues, or `invalid sections` (with `issues`).'),
          404: PROJECT_NOT_FOUND,
          409: error('`no prepared samples to segment`.'),
        },
      },
    },
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
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'getSegmentation',
        summary: 'Get an anchor preview',
        description: md`
          A preview's status and, once it succeeded, its result: per sample, the kept copy's
          pages, the sections found (pages and characters) and the required sections missing;
          and the anchors whose regex is invalid. \`suggestions\` lists, for required sections
          that missed a sample, an anchor that would find it (the sample writes the label
          another way: a synonym, another case, an indent) and why. \`error: result missing\`
          when the result file is gone.
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          jobId: z.string().uuid().describe('The preview job id.'),
        }),
        response: {
          200: res('The preview.', SegmentationViewSchema),
          404: error('`segmentation not found`.'),
        },
      },
    },
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

  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/test-runs',
    {
      schema: {
        tags: ['Test runs'],
        operationId: 'listTestRuns',
        summary: "List a project's jobs",
        description: md`
          The project's jobs except sample preparation: test runs, reference runs and
          evaluation jobs, newest first. Open one with \`GET /api/jobs/{id}/review\`.
        `,
        params: ProjectIdParams,
        response: { 200: res('The jobs.', z.array(JobSummarySchema)), 404: PROJECT_NOT_FOUND },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      return (await app.deps.repo.listProjectJobs(req.params.id)).filter(
        (j) => j.task !== 'prepare',
      );
    },
  );

  app.put<{ Params: ProjectParams }>(
    '/workbench/projects/:id/data-policy',
    {
      schema: {
        tags: ['Projects & data policy'],
        'x-admin': true,
        operationId: 'setDataPolicy',
        summary: "Set a project's data policy",
        description: md`
          **Admin token required.** \`local\`: the project's documents and sample text may only
          go to models on providers marked \`location: local\`. \`external\`: external
          providers are allowed too. Switching to \`local\` also makes every existing job of the
          project local-only, so queued jobs, retries and step re-runs cannot go external after
          the revocation; switching to \`external\` never upgrades old jobs. See
          [ADR 0007](https://github.com/kenhayward/ingestion-harness/blob/main/docs/adr/0007-workbench.md).
        `,
        params: ProjectIdParams,
        body: PolicyBody,
        response: {
          200: res('The project.', ProjectViewSchema),
          400: error('Zod issues: `dataPolicy` must be `local` or `external`.'),
          403: error('`admins only`.'),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      if (!isAdmin(app, req)) return reply.code(403).send({ error: 'admins only' });
      const body = PolicyBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const project = await workbench.setDataPolicy(
        req.params.id,
        body.data.dataPolicy,
        req.auth?.label ?? null,
      );
      if (!project) return reply.code(404).send({ error: 'project not found' });
      req.log.info(
        { projectId: project.id, dataPolicy: project.dataPolicy },
        'data policy changed',
      );
      return projectView(app, project);
    },
  );

  /** References stage: run the draft model on every ready dev sample that has no reference. */
  async function startReferences(projectId: string, createdBy: string | null, reply: FastifyReply) {
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
    const { definition } = (await templates.get(projectId, draft))!;
    const issues = validateTemplate(definition);
    if (issues.length) return reply.code(400).send({ error: 'the draft is not valid', issues });
    const { entries } = await referenceEntries(app, projectId, 'dev');
    if (!entries.length) return reply.code(409).send({ error: 'no prepared dev samples to run' });
    const unverified = entries.filter((e) => !verifiedRow(e.row));
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
            // verified, approved and saved as a reference. outputs: what it is verified against.
            params: referenceRunParams(project.dataPolicy, definition),
            modelOverride: 'draft',
            createdBy,
          },
        ),
      ),
    );
    return reply.code(201).send({ jobs });
  }

  /**
   * What a revision is asked to answer (also the RV1 preview). Holdout rule (ADR 0007): feedback
   * naming a sample that is not a ready dev sample now is dropped, and the failures come from the
   * latest complete dev iteration, restricted to the current dev samples and trimmed with
   * `revisionFailures` (the worker's own selection is then a no-op, so what the preview shows is
   * what is sent). The template's own runs are preferred over model-comparison members (groupId
   * set), which fall back only when no own run is complete; failuresFrom names the iteration used.
   * Each feedback item carries its id: the model answers feedback by it (RV2).
   */
  async function reviseInputs(
    projectId: string,
    dev: { sampleId: string; filename: string }[],
  ): Promise<{
    params: {
      feedback: RevisionFeedback[];
      failures: FailureDiff[];
      failuresFrom?: { templateVersion: number; model: EvaluationModel | null };
      feedbackIds: string[];
    };
    /** Failing dev samples before the cap. */
    failuresTotal: number;
    source: { iteration: IterationRecord; compared: number } | null;
  }> {
    const names = new Map(dev.map((s) => [s.sampleId, s.filename]));
    const devIds = new Set(names.keys());
    const open = (await workbench.listFeedback(projectId)).filter(
      (f) => f.resolvedBy === null && (f.sampleId === null || names.has(f.sampleId)),
    );
    let all: FailureDiff[] = [];
    let source: { iteration: IterationRecord; compared: number } | null = null;
    const devRuns = (await workbench.listIterations(projectId)).filter((i) => i.set === 'dev');
    // Stable sort: own runs first, newest first within each group.
    const candidates = [...devRuns].sort(
      (a, b) => Number(a.groupId !== null) - Number(b.groupId !== null),
    );
    for (const iteration of candidates) {
      const view = await iterationView(app, iteration);
      if (view.status !== 'complete') continue;
      all = failureDiffs(view.samples, devIds);
      const compared = view.samples.filter(
        (s) => s.comparison !== null && s.sampleId !== null && devIds.has(s.sampleId),
      ).length;
      source = { iteration, compared };
      break;
    }
    return {
      params: {
        feedback: open.map((f) => ({
          id: f.id,
          target: f.target,
          targetId: f.targetId,
          sample: f.sampleId === null ? null : (names.get(f.sampleId) ?? null),
          body: f.body,
        })),
        failures: revisionFailures(all, new Set(names.values())),
        ...(source
          ? {
              failuresFrom: {
                templateVersion: source.iteration.templateVersion,
                model: source.iteration.model,
              },
            }
          : {}),
        feedbackIds: open.map((f) => f.id),
      },
      failuresTotal: all.length,
      source,
    };
  }

  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/feedback',
    {
      schema: {
        tags: ['Feedback & revise'],
        operationId: 'listFeedback',
        summary: "List a project's feedback",
        description: md`
          Every feedback note, open or resolved. \`resolvedBy\` names the revise proposal that
          answered it (accepted fully or partly); null while it is open.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The feedback.', z.array(FeedbackItemSchema)),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const items: FeedbackItem[] = await workbench.listFeedback(req.params.id);
      return items;
    },
  );

  app.post<{ Params: ProjectParams }>(
    '/workbench/projects/:id/feedback',
    {
      schema: {
        tags: ['Feedback & revise'],
        operationId: 'addFeedback',
        summary: 'Add feedback for the revise stage',
        description: md`
          A note on what the draft gets wrong, aimed at a field, table, step or section
          (\`targetId\`), optionally about one sample and one iteration. Open feedback is what
          the \`revise\` stage answers. Feedback is sent to the drafting model, so it may only
          name a ready **dev** sample and a **dev** iteration (the holdout rule).
        `,
        params: ProjectIdParams,
        body: FeedbackBodySchema,
        response: {
          201: res('The new feedback.', FeedbackItemSchema),
          400: error(
            'Zod issues, `feedback can only refer to dev samples`, `unknown iteration`, or ' +
              '`feedback can only refer to dev iterations`.',
          ),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const projectId = req.params.id;
      if (!(await workbench.getProject(projectId))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const body = FeedbackBodySchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { sampleId, iterationId, ...rest } = body.data;
      if (sampleId !== undefined) {
        // Holdout rule (ADR 0007): feedback may only name a ready dev sample.
        const sample = await findSample(projectId, sampleId);
        if (!sample || sample.view.role !== 'dev' || sample.view.state !== 'ready') {
          return reply.code(400).send({ error: 'feedback can only refer to dev samples' });
        }
      }
      if (iterationId !== undefined) {
        const iteration = await workbench.getIteration(projectId, iterationId);
        if (!iteration) return reply.code(400).send({ error: 'unknown iteration' });
        // Holdout rule (ADR 0007): feedback, which a revision sends to a model, names dev runs only.
        if (iteration.set !== 'dev') {
          return reply.code(400).send({ error: 'feedback can only refer to dev iterations' });
        }
      }
      const item = await workbench.createFeedback({
        projectId,
        ...rest,
        sampleId: sampleId ?? null,
        iterationId: iterationId ?? null,
      });
      return reply.code(201).send(item);
    },
  );

  app.delete<{ Params: { id: string; fid: string } }>(
    '/workbench/projects/:id/feedback/:fid',
    {
      schema: {
        tags: ['Feedback & revise'],
        operationId: 'deleteFeedback',
        summary: 'Delete open feedback',
        description: md`
          Deletes a feedback note that is still open. Resolved feedback is kept: it records what
          a revision answered.
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          fid: z.string().uuid().describe('The feedback id.'),
        }),
        response: {
          204: noContent('Deleted.'),
          404: error('`feedback not found`.'),
          409: error('`resolved feedback cannot be deleted`.'),
        },
      },
    },
    async (req, reply) => {
      const params = FeedbackParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'feedback not found' });
      const result = await workbench.deleteFeedback(params.data.id, params.data.fid);
      if (result === 'resolved') {
        return reply.code(409).send({ error: 'resolved feedback cannot be deleted' });
      }
      if (result === 'not-found') return reply.code(404).send({ error: 'feedback not found' });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string; stage: string } }>(
    '/workbench/projects/:id/stages/:stage',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'startStage',
        summary: 'Run a drafting stage',
        description: md`
          Asks the drafting model (the \`draft\` alias) for a stage's proposal, as a \`draft\`
          job; poll \`GET …/proposals\`. Stages run in order (\`survey\`, \`outputs\`,
          \`sections\`, \`steps\`): an earlier stage must be accepted or skipped first.

          - \`survey\` proposes questions about the document type; the other stages propose
            typed changes to the open draft (fields and tables, sections and copies, steps).
            The \`sections\` stage checks its anchors on every dev sample and gets one round of
            feedback.
          - \`revise\` (outside the order, cannot be skipped) answers the open feedback and the
            latest dev evaluation's failures; it needs open feedback.
          - \`references\` instead queues reference runs (\`201\` with the jobs): the draft
            model on every ready dev sample without a reference, stopped for review so the
            values can be verified and saved as references.

          Only dev samples are ever sent to the model (the holdout rule). A \`local\` project
          only uses local models.
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          stage: z
            .enum(['survey', 'outputs', 'sections', 'steps', 'references', 'revise'])
            .describe('The stage.'),
        }),
        response: {
          201: res('`references`: the queued reference runs.', JobsCreated),
          202: res('The proposal, running.', ProposalViewSchema),
          400: error(
            '`stage {stage} is not available yet`, or `the draft is not valid` (references).',
          ),
          404: PROJECT_NOT_FOUND,
          409: error(
            `${STAGE_ORDER_CONFLICT}, \`no open draft; start the next version on the Template ` +
              'tab`, `the project has no template version`, `add feedback before asking for a ' +
              'revision`, `no prepared dev samples`, or for references `no prepared dev samples ' +
              'to run`, `every dev sample already has a reference` or `reference runs are ' +
              'already running`.',
          ),
        },
      },
    },
    async (req, reply) => {
      if (req.params.stage === 'references')
        return startReferences(req.params.id, req.auth?.label ?? null, reply);
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
      const samples = devSamplesOf(await sampleViews(app, projectId));
      const revision = stage === 'revise' ? await reviseInputs(projectId, samples) : null;
      if (revision && !revision.params.feedback.length) {
        return reply.code(409).send({ error: 'add feedback before asking for a revision' });
      }
      // A revision can work from feedback alone; the other stages read the samples.
      if (!samples.length && !revision) {
        return reply.code(409).send({ error: 'no prepared dev samples' });
      }
      const brief = await workbench.latestBrief(projectId);
      const job = await app.deps.repo.createDraftJob(projectId, {
        stage,
        dataPolicy: project.dataPolicy,
        briefVersion: brief?.version ?? null,
        brief: brief?.body ?? EMPTY_BRIEF,
        draft: record.definition,
        samples,
        ...(changeStage ? { survey: await acceptedSurvey(app, projectId) } : {}),
        ...(revision?.params ?? {}),
      });
      const proposal = await workbench.createProposal({
        id: job.id,
        projectId,
        stage,
        briefVersion: brief?.version ?? null,
        baseVersion: changeStage ? record.version : null,
        baseDefinition: changeStage ? record.definition : null,
        feedbackIds: revision?.params.feedbackIds ?? null,
      });
      return reply.code(202).send(await proposalView(app, proposal, job));
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/stages',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'listStages',
        summary: "Get the drafting stages' states",
        description: md`
          Each stage's state: \`pending\`, \`running\`, \`proposed\` (waiting for a
          decision), \`accepted\`, \`skipped\`, or \`stale\` (an earlier stage was accepted
          again since). \`references\` is accepted once every ready dev sample has a verified
          reference. States are derived, never stored. \`skippedAt\` is the stage's latest skip, kept after
          it is run or accepted again (the Survey tab's "You skipped this stage" banner).
        `,
        params: ProjectIdParams,
        response: { 200: res('The stages.', z.array(StageViewSchema)), 404: PROJECT_NOT_FOUND },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      return allStages(app, req.params.id);
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/references',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'listReferenceRows',
        summary: "List the samples' references",
        description: md`
          One row per ready sample of the set (\`dev\` by default, or \`holdout\`): its
          reference for the open draft's version, if any (pinned version, the version it was
          carried from, \`outdated\`: output changes since it was verified, which mean verify it
          again, and \`reverified\`: the carried copy a re-verification replaced and why), and its
          latest reference or test run. \`corrections\` (handoff RF1) is derived from the
          reviewed run's edits: \`corrected\` where the model proposed a value the reviewer
          changed, \`entered\` where it proposed nothing; keys are a field id or
          \`table[row].column\` (1-based row). It is \`null\` when unknown: no source run, or the
          run was re-run or reviewed again after the save. \`verifiedBy\` is the run's approver,
          else its last editor.
        `,
        params: ProjectIdParams,
        querystring: ReferencesQuery,
        response: {
          200: res('The rows.', z.array(ReferenceRowSchema)),
          400: error('Zod issues: `set` must be `dev` or `holdout`.'),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const query = ReferencesQuery.safeParse(req.query ?? {});
      if (!query.success) return reply.code(400).send({ error: query.error.issues });
      return referenceRows(app, req.params.id, query.data.set ?? 'dev', undefined, true);
    },
  );

  app.get<{ Params: { id: string; sid: string } }>(
    '/workbench/projects/:id/references/:sid',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'getReferenceDetail',
        summary: "Read one sample's reference",
        description: md`
          The References tab's detail panel (handoff RF2): the sample's reference for the
          current version (as in the list), the run that proposed its values (job, model
          override, the models its step runs used) and one entry per output of the current
          version with the expected value (a table's rows) and its provenance: \`model\` (the
          model proposed it and nobody changed it), \`corrected\` (with the model's value in
          \`proposed\` for a field) or \`entered\` (the model proposed nothing); \`null\` when the
          corrections are unknown or the reference is outdated for that output (listed in
          \`reference.outdated\`: re-verify). A run saved without a review counts as unknown. Dev and holdout samples alike: holdout values are shown to
          the user, never to a model.
        `,
        params: SampleIdParams,
        response: {
          200: res('The reference.', ReferenceDetailSchema),
          404: error(
            '`project not found`, `sample not found` or `no reference for this sample` (none yet, or the sample is not ready).',
          ),
        },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const params = SampleParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'sample not found' });
      const detail = await referenceDetail(app, params.data.id, params.data.sid);
      if (typeof detail === 'string') return reply.code(404).send({ error: detail });
      return detail;
    },
  );

  /**
   * Holdout references: run the template's own models (no override) on every ready holdout
   * sample that has no reference and no active run, forcing review so each can be verified.
   * Not a stage: it has no stage state and is not blocked by the stage order.
   */
  app.post<{ Params: ProjectParams }>(
    '/workbench/projects/:id/holdout/reference-runs',
    {
      schema: {
        tags: ['Holdout & publish gate'],
        operationId: 'startHoldoutReferenceRuns',
        summary: 'Start reference runs on the holdout samples',
        description: md`
          Runs the open draft with the template's own models (never the drafting model, which
          must not see holdout) on every ready holdout sample that has no reference and no
          active run, stopping each for review. Verify the values, approve, then save each job
          as a reference: holdout evaluations and the publish gate need them. Not a stage: the
          stage order does not apply.
        `,
        params: ProjectIdParams,
        response: {
          201: res('The queued reference runs.', JobsCreated),
          400: DRAFT_NOT_VALID,
          404: PROJECT_NOT_FOUND,
          409: error(
            '`no open draft; start the next version on the Template tab`, `no prepared holdout ' +
              'samples to run`, `every holdout sample already has a reference`, or `reference ' +
              'runs are already running`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const projectId = req.params.id;
      const project = await workbench.getProject(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const { draft } = await versionsOf(templates, projectId);
      if (draft === null) {
        return reply
          .code(409)
          .send({ error: 'no open draft; start the next version on the Template tab' });
      }
      const { definition } = (await templates.get(projectId, draft))!;
      const issues = validateTemplate(definition);
      if (issues.length) return reply.code(400).send({ error: 'the draft is not valid', issues });
      const { entries: holdout } = await referenceEntries(app, projectId, 'holdout');
      if (!holdout.length) {
        return reply.code(409).send({ error: 'no prepared holdout samples to run' });
      }
      const unverified = holdout.filter((e) => !verifiedRow(e.row));
      if (!unverified.length) {
        return reply.code(409).send({ error: 'every holdout sample already has a reference' });
      }
      const todo = unverified
        .filter((e) => !(e.row.run && activeJob(e.row.run.status)))
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
              params: referenceRunParams(project.dataPolicy, definition),
              // The template's own models: drafting never sees holdout, so no draft model.
              modelOverride: null,
              createdBy: req.auth?.label ?? null,
            },
          ),
        ),
      );
      req.log.info({ projectId, version: draft, jobs: jobs.length }, 'holdout reference runs');
      return reply.code(201).send({ jobs });
    },
  );

  app.post<{ Params: { id: string; stage: string } }>(
    '/workbench/projects/:id/stages/:stage/skip',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'skipStage',
        summary: 'Skip a drafting stage',
        description: md`
          Marks a stage done without a proposal, for when the draft already covers it. The
          stage order still applies. \`revise\` cannot be skipped.
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          stage: z.string().describe('The stage.'),
        }),
        response: {
          201: res("Every stage's state.", z.array(StageViewSchema)),
          400: error('`stage revise cannot be skipped`, or `stage {stage} is not available yet`.'),
          404: PROJECT_NOT_FOUND,
          409: error(`${STAGE_ORDER_CONFLICT}.`),
        },
      },
    },
    async (req, reply) => {
      if (req.params.stage === 'revise') {
        return reply.code(400).send({ error: 'stage revise cannot be skipped' });
      }
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

  app.post<{ Params: { id: string; stage: string } }>(
    '/workbench/projects/:id/stages/:stage/confirm',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'confirmStage',
        summary: 'Keep a stale stage as it is',
        description: md`
          Clears \`stale\` from a stage without a new proposal (the Sections tab's _Keep these
          anchors_): its current content is confirmed against the earlier stages as they are now.
          Its \`completedAt\` and its state (\`accepted\`, or \`skipped\` for a kept skip) are
          unchanged, so later stages do not go stale; an earlier stage completing again makes it
          stale again. Only \`outputs\`, \`sections\` and \`steps\` can be kept, and only while
          stale. Nothing is proposed and the draft is not changed.
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          stage: z.string().describe('The stage: outputs, sections or steps.'),
        }),
        response: {
          201: res("Every stage's state.", z.array(StageViewSchema)),
          400: error('`stage {stage} cannot be kept`.'),
          404: PROJECT_NOT_FOUND,
          409: error('`stage {stage} is not stale`.'),
        },
      },
    },
    async (req, reply) => {
      const stage = KEEPABLE_STAGES.find((s) => s === req.params.stage);
      if (!stage) {
        return reply.code(400).send({ error: `stage ${req.params.stage} cannot be kept` });
      }
      const projectId = req.params.id;
      if (!(await workbench.getProject(projectId))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const states = await stagesOf(app, projectId);
      const index = STAGE_ORDER.indexOf(stage);
      if (states[index]?.state !== 'stale') {
        return reply.code(409).send({ error: `stage ${stage} is not stale` });
      }
      // What the stage is kept against: the earlier completions read for the check above. One
      // that lands after this read (even concurrently) is newer, so it makes the stage stale again.
      const upTo = states
        .slice(0, index)
        .map((s) => s.completedAt)
        .filter((at): at is string => at !== null)
        .sort()
        .at(-1)!;
      await workbench.addConfirm(projectId, stage, upTo);
      req.log.info({ projectId, stage, upTo }, 'workbench stage kept');
      return reply.code(201).send(await allStages(app, projectId));
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/proposals',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'listProposals',
        summary: "List a project's proposals",
        description: md`
          Every drafting proposal, with its status (derived from its job): \`running\`,
          \`ready\` (waiting for a decision), \`failed\`, \`accepted\`,
          \`partially_accepted\` or \`rejected\`. A ready proposal's \`body\` is the survey's
          questions, or the stage's notes and typed changes.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The proposals.', z.array(ProposalViewSchema)),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const jobs = new Map(
        (await app.deps.repo.listDraftJobs(req.params.id)).map((j) => [j.id, j]),
      );
      const proposals = await workbench.listProposals(req.params.id);
      return Promise.all(proposals.map((p) => proposalView(app, p, jobs.get(p.id) ?? null)));
    },
  );

  app.post<{ Params: { id: string; pid: string } }>(
    '/workbench/projects/:id/proposals/:pid/decision',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'decideProposal',
        summary: 'Accept or reject a proposal',
        description: md`
          Decides a ready proposal. Rejecting, or accepting a survey, records the decision.
          Accepting a change proposal applies the chosen \`changes\` (indexes into its list;
          all of them for \`accepted\`, some for \`partially_accepted\`) to the open draft.
          It is refused when the draft version changed since the proposal, or when the draft
          was edited where a chosen change applies (accept the others, or run the stage again).
          Accepting a \`revise\` proposal, fully or partly, resolves the feedback its applied
          changes answer (their \`answers\`); a proposal whose changes name none resolves all the
          feedback it was sent.
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          pid: z.string().uuid().describe('The proposal id.'),
        }),
        body: DecisionBody,
        response: {
          200: res('The decided proposal.', ProposalViewSchema),
          400: error(
            'Zod issues, `changes can only be chosen when accepting a drafting change ' +
              'proposal`, `choose the changes to accept`, or `no such change`.',
          ),
          404: error('`proposal not found`.'),
          409: error(
            '`proposal is {status}`, `proposal was already decided`, `the draft version changed ' +
              'since this proposal; re-run the stage`, `the draft changed since this proposal ' +
              'where these changes apply: …`, or `the draft is no longer open; …`.',
          ),
        },
      },
    },
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
      // Accepted, fully or partly (RV2): the feedback the applied changes answer, or all of it
      // when no change names any (proposals from before RV2).
      if (record.stage === 'revise') {
        await workbench.resolveFeedback(
          projectId,
          answeredFeedback(proposed, chosen, record.feedbackIds ?? []),
          pid,
        );
      }
      req.log.info({ projectId, proposal: pid, applied: chosen }, 'drafting changes applied');
      return proposalView(app, decided, job);
    },
  );

  app.post<{ Params: ProjectParams }>(
    '/workbench/projects/:id/evaluations',
    {
      schema: {
        tags: ['Evaluation, iterations & comparisons'],
        operationId: 'evaluate',
        summary: 'Evaluate the draft against the references',
        description: md`
          Runs the open draft on every sample of the set (\`dev\` by default, or \`holdout\`)
          that has a verified reference, one test job each, and records an iteration with a
          snapshot of the definition. The scorecard fills in as the jobs finish (poll
          \`GET …/iterations/{iid}\`).

          \`model\` overrides every step with an alias (\`default\`, \`fast\` or \`draft\`)
          for exploration; only iterations with the template's own models count for the publish
          gate. \`uncached\` makes every step call its model instead of reusing the step cache.
          Holdout scores always compare the models' raw output, never reviewed values.
        `,
        params: ProjectIdParams,
        body: EvaluateBody,
        response: {
          201: res('The new iteration, running.', IterationViewSchema),
          ...EVALUATION_REFUSED,
          400: res(
            'Zod issues for an invalid body, or `the draft is not valid` (with `issues`).',
            z.object({ error: z.unknown(), issues: z.array(z.unknown()).optional() }),
          ),
        },
      },
    },
    async (req, reply) => {
      const body = EvaluateBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const set = body.data.set ?? 'dev';
      const inputs = await evaluationInputs(app, req.params.id, reply, set);
      if (!inputs) return reply;
      const iteration = await startIteration(app, req, inputs, {
        set,
        model: body.data.model ?? null,
        uncached: body.data.uncached ?? false,
        groupId: null,
      });
      return reply.code(201).send(await iterationView(app, iteration));
    },
  );

  app.post<{ Params: ProjectParams }>(
    '/workbench/projects/:id/evaluations/compare',
    {
      schema: {
        tags: ['Evaluation, iterations & comparisons'],
        operationId: 'compareModels',
        summary: 'Compare models on the dev samples',
        description: md`
          Evaluates the open draft on the dev samples three times, overriding every step with
          the \`default\`, \`fast\` and \`draft\` aliases, as one comparison group. Read it
          with \`GET …/comparisons/{groupId}\`. Comparisons are dev-only: they inform drafting,
          which never sees holdout.
        `,
        params: ProjectIdParams,
        body: CompareBody,
        response: {
          201: res('The comparison, running.', ComparisonViewSchema),
          ...EVALUATION_REFUSED,
          400: res(
            'Zod issues for an invalid body, or `the draft is not valid` (with `issues`).',
            z.object({ error: z.unknown(), issues: z.array(z.unknown()).optional() }),
          ),
        },
      },
    },
    async (req, reply) => {
      const body = CompareBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      // Model comparison stays dev-only: it informs drafting, which never sees holdout.
      const inputs = await evaluationInputs(app, req.params.id, reply, 'dev');
      if (!inputs) return reply;
      const groupId = randomUUID();
      const records: IterationRecord[] = [];
      for (const model of EVALUATION_MODELS) {
        records.push(
          await startIteration(app, req, inputs, {
            set: 'dev',
            model,
            uncached: body.data.uncached ?? false,
            groupId,
          }),
        );
      }
      const view: ComparisonView = {
        groupId,
        iterations: await Promise.all(records.map((r) => iterationView(app, r))),
      };
      return reply.code(201).send(view);
    },
  );

  app.get<{ Params: { id: string; groupId: string } }>(
    '/workbench/projects/:id/comparisons/:groupId',
    {
      schema: {
        tags: ['Evaluation, iterations & comparisons'],
        operationId: 'getComparison',
        summary: 'Get a model comparison',
        description: md`
          The comparison group's iterations in the order \`default\`, \`fast\`, \`draft\`,
          each with its scorecard: the overall score and the accuracy of every field and table
          column.
        `,
        params: z.object({
          id: z.string().describe('The project id.'),
          groupId: z.string().uuid().describe('The comparison group id.'),
        }),
        response: {
          200: res('The comparison.', ComparisonViewSchema),
          404: error('`comparison not found`.'),
        },
      },
    },
    async (req, reply) => {
      const params = ComparisonParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'comparison not found' });
      const { id: projectId, groupId } = params.data;
      const records = await workbench.listGroup(projectId, groupId);
      if (!records.length) return reply.code(404).send({ error: 'comparison not found' });
      const rank = (r: IterationRecord) => (r.model ? EVALUATION_MODELS.indexOf(r.model) : -1);
      const sorted = [...records].sort((a, b) => rank(a) - rank(b));
      const view: ComparisonView = {
        groupId,
        iterations: await Promise.all(sorted.map((r) => iterationView(app, r))),
      };
      return view;
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/iterations',
    {
      schema: {
        tags: ['Evaluation, iterations & comparisons'],
        operationId: 'listIterations',
        summary: "List a project's iterations",
        description: md`
          Every evaluation, newest first, with its set, model override, comparison group,
          status and score (\`completed\` of \`total\` samples compared). A complete
          iteration's score is cached; a running one is computed from its jobs.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The iterations.', z.array(IterationSummarySchema)),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
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
    },
  );

  /** The iteration named by the route params, or null for an unknown or malformed id. */
  async function iterationOf(params: unknown) {
    const parsed = IterationParams.safeParse(params);
    return parsed.success ? workbench.getIteration(parsed.data.id, parsed.data.iid) : null;
  }

  app.get<{ Params: { id: string; iid: string } }>(
    '/workbench/projects/:id/iterations/:iid',
    {
      schema: {
        tags: ['Evaluation, iterations & comparisons'],
        operationId: 'getIteration',
        summary: 'Get an iteration',
        description: md`
          An iteration with its scorecard (overall score, then each field's and column's
          accuracy, worst first), how many step runs were served from the step cache, and per
          sample the job and its comparison with the reference. A job that failed, needs
          review, was cancelled or was deleted has no comparison.
        `,
        params: IterationIdParams,
        response: { 200: res('The iteration.', IterationViewSchema), 404: ITERATION_NOT_FOUND },
      },
    },
    async (req, reply) => {
      const iteration = await iterationOf(req.params);
      if (!iteration) return reply.code(404).send({ error: 'iteration not found' });
      return iterationView(app, iteration);
    },
  );

  app.post<{ Params: { id: string; iid: string } }>(
    '/workbench/projects/:id/iterations/:iid/restore',
    {
      schema: {
        tags: ['Evaluation, iterations & comparisons'],
        operationId: 'restoreIteration',
        summary: "Restore an iteration's definition",
        description: md`
          Writes the definition the iteration evaluated into the open draft, replacing it, to
          go back to a version that scored better.
        `,
        params: IterationIdParams,
        response: {
          200: res('The project.', ProjectViewSchema),
          404: ITERATION_NOT_FOUND,
          409: error(
            '`no open draft; start the next version on the Template tab`, or `the draft is no ' +
              'longer open`.',
          ),
        },
      },
    },
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
