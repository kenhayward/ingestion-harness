import { randomUUID } from 'node:crypto';
import type { MetricsData } from '../metrics.js';
import type {
  JobStatus,
  JobDetail,
  JobOutput,
  JobSummary,
  ModelInfo,
  RerunRequest,
  Reference,
  ResultSummary,
  ReviewEdit,
  StepRun,
  SuggestParams,
  DeliveryOverrides,
} from '@ih/shared';
import {
  DEFAULT_TARGET_ID,
  DELETABLE_STATUSES,
  decompositionBatchPrefix,
  isMine,
  sourceContentType,
  statusGroup,
  pageOfJobs,
  type Creator,
  type JobPage,
  type Batch,
  type BatchSummary,
  type Item,
} from '@ih/shared';
import { acceptedReceipt } from '../conversions/accept.js';
import {
  batchCreator,
  emptyCounts,
  type AcceptResult,
  type AddItemResult,
  type ApproveResult,
  type DetachResult,
  type DeleteBatchResult,
  type DiscardBatchResult,
  type NewBatch,
  type NewItem,
  type Accept,
  type Detach,
  type RegisterAction,
  type RejectResult,
  type ReviewInput,
  type Rerun,
  type RerunResult,
  type Retry,
  type RetryResult,
  RUNNING_OUTCOMES,
  isGone,
  errorLinksOf,
  LINKED_STATES,
  isReloadable,
  isPartWay,
  isUnconfirmed,
  isUnversioned,
  type StartBatchResult,
} from '../conversions/repo.js';
import {
  ReferenceConflictError,
  type DeleteJobResult,
  type IngestionRepo,
  type JobEventRecord,
  type QueueStats,
  type JobReview,
  type ListJobsQuery,
  type JobPageRequest,
  type ListPublishedQuery,
  type RetryOptions,
  type ProjectJob,
  type SegmentJob,
  type SegmentJobParams,
  type GraphJobParams,
  type PluginJobParams,
  SEGMENT_PRIORITY,
  type NewDocument,
  type NewReference,
  type NewEdit,
  type StoredObject,
  WORKBENCH_PRIORITY,
  type WorkbenchJobOptions,
  type WithdrawalStatus,
  BACKGROUND_JOBS,
  type BackgroundTask,
  graphWithdrawals,
  type WithdrawnGraph,
  type DeliveryUpdate,
  FINAL_DELIVERY,
  backgroundFinish,
  finishEvent,
  type JobDelivery,
  type JobFinish,
  type RegisterEntry,
  type ItemSettlement,
  type RegisterSettlement,
  SETTLEABLE_ITEM,
  type EventFilter,
} from './types.js';

/** A conversion item as stored: its resolution is read from its register entry. */
type StoredItem = Omit<
  Item,
  | 'resolution'
  | 'unversioned'
  | 'gone'
  | 'unconfirmed'
  | 'partWay'
  | 'links'
  | 'reloadable'
  | 'rerunIn'
  | 'rerunAt'
>;

/** A conversion item's review columns before any report, hold or decision. */
const NOT_REVIEWED = {
  flagCount: null,
  held: false,
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
} as const;

/** A new item's waits between decomposing and delivering: none yet. */
const NOT_WAITED = { waitingSince: null, waitedMs: 0 } as const;

/** Statuses Retry accepts; succeeded = re-run (re-process) a finished job. */
const RETRYABLE: JobSummary['status'][] = ['failed', 'needs_review', 'cancelled', 'succeeded'];
/** Tasks a test run moves through: listed as one run by listProjectRuns. */
const RUN_TASKS: JobSummary['task'][] = ['process', 'rerun', 'publish'];

/** In-memory repo for unit tests and local UI work without Postgres. */
/**
 * A job_outputs row: a published one recorded for a target other than the job's primary one
 * (an archive) has `isPrimary: false`, and only withdrawal and target usage see it.
 */
export type StoredOutput = JobOutput & { isPrimary?: boolean };

/** A job's outputs as readers see them: drafts, and what its primary target holds. */
const shown = (outputs: readonly StoredOutput[] = []): JobOutput[] =>
  outputs
    .filter((o) => o.stage !== 'published' || o.isPrimary !== false)
    .map(({ isPrimary: _primary, ...o }) => o);

export class MemoryRepo implements IngestionRepo {
  readonly jobs = new Map<string, JobSummary>();
  /** Segment jobs (document-less, ADR 0007): kept apart so no JobSummary path sees them. */
  readonly segmentJobs = new Map<string, SegmentJob & { params: SegmentJobParams }>();
  readonly graphJobs = new Map<string, ProjectJob & { params: GraphJobParams }>();
  readonly pluginJobs = new Map<string, ProjectJob & { params: PluginJobParams }>();
  /** Draft jobs (document-less, ADR 0007): kept apart so no JobSummary path sees them. */
  readonly draftJobs = new Map<string, ProjectJob & { params: Record<string, unknown> }>();
  /** `queuePaused()` (tests set it). */
  queuePausedNow = false;
  /** Ontology suggestion refreshes (document-less, one per project). */
  readonly suggestJobs = new Map<string, ProjectJob & { params: Record<string, unknown> }>();
  /** Export jobs (document-less, one per project): kept apart like draft jobs. */
  readonly exportJobs = new Map<string, ProjectJob & { params: Record<string, unknown> }>();
  /** jobs.params of workbench jobs. */
  readonly jobParams = new Map<string, Record<string, unknown>>();
  readonly outputs = new Map<string, StoredOutput[]>();
  /** Published outputs a retirement withdrew (Postgres: job_outputs.withdrawn_at). */
  readonly withdrawnOutputs = new Map<string, JobOutput[]>();
  /** Graph versions as the worker records them (published_graph_versions); tests add them. */
  readonly graphVersions: {
    sha256: string;
    templateId: string;
    graphIri: string;
    version: number;
    jobId: string;
    targetId: string;
  }[] = [];
  /** The current graph of each (sha256, type) (published_graphs). */
  private readonly graphs = new Map<
    string,
    { graphIri: string; version: number; jobId: string; targetId: string }
  >();
  /** Document-less withdraw/republish/rebuild/decompose jobs queued (ADR 0011 step 7). */
  readonly backgroundJobs: {
    id: string;
    task: BackgroundTask;
    priority: number;
    maxAttempts: number;
    params: unknown;
    status: JobStatus;
    createdBy: string | null;
    /** jobs.created_by_user: set by decompose jobs (tests pushing their own may leave it out). */
    createdByUser?: string | null;
  }[] = [];
  /** job_events: what the API writes itself (cancellations) and what tests add for the worker. */
  readonly events = new Map<
    string,
    { level: string; message: string; data: unknown; at: string }[]
  >();
  /** jobId -> ISO publish time (job_outputs.created_at in Postgres); defaults to updatedAt. */
  readonly publishedAt = new Map<string, string>();
  readonly documents = new Map<string, NewDocument>();
  readonly edits = new Map<string, ReviewEdit[]>();
  private lastTime = 0;

  /**
   * Strictly increasing ISO times, shared with MemoryWorkbenchRepo: stage states compare
   * reference times with skip and decision times, so ties or clock skew would hide staleness.
   */
  now(): string {
    this.lastTime = Math.max(Date.now(), this.lastTime + 1);
    return new Date(this.lastTime).toISOString();
  }
  /** Seeded by tests; `cached` defaults to false (runs written before phase 4b). */
  readonly stepRuns = new Map<string, (Omit<StepRun, 'cached'> & { cached?: boolean })[]>();
  readonly references = new Map<string, Reference>();
  readonly reruns = new Map<string, { step: string } & RerunRequest>();
  /** jobs.priority; absent = 0 (production). */
  readonly priorities = new Map<string, number>();
  /** Documents pinned by workbench samples (workbench_samples in Postgres). */
  readonly sampleDocuments = new Set<string>();
  models: ModelInfo[] = [];
  private editSeq = 0;

  async ping(): Promise<void> {}

  async createDocumentAndJob(
    doc: NewDocument,
    modelOverride: string | null,
    test = false,
    referenceId: string | null = null,
    params: Record<string, unknown> | null = null,
    createdBy: Creator | null = null,
  ): Promise<JobSummary> {
    this.documents.set(doc.id, doc);
    const now = new Date().toISOString();
    const job: JobSummary = {
      id: randomUUID(),
      documentId: doc.id,
      filename: doc.filename,
      contentType: sourceContentType(doc.objectKey),
      specId: doc.specId,
      specVersion: doc.specVersion,
      status: 'queued',
      modelOverride,
      modelsUsed: [],
      attempts: 0,
      error: null,
      task: 'process',
      test,
      referenceId,
      projectId: null,
      createdBy: createdBy?.name ?? null,
      createdByUser: createdBy?.userId ?? null,
      reviewReasons: null,
      reviewer: null,
      reviewNote: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
      batchId: typeof params?.batchId === 'string' ? params.batchId : null,
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    if (params) this.jobParams.set(job.id, params);
    return job;
  }

  async createWorkbenchJob(
    doc: NewDocument,
    { projectId, task, params, referenceId, modelOverride, createdBy }: WorkbenchJobOptions,
  ) {
    const job = await this.createDocumentAndJob(
      doc,
      modelOverride ?? null,
      true,
      referenceId ?? null,
      params ?? null,
      createdBy ?? null,
    );
    this.priorities.set(job.id, WORKBENCH_PRIORITY);
    return this.update(job.id, { projectId, task });
  }

  async createDraftJob(projectId: string, params: Record<string, unknown>) {
    const now = new Date().toISOString();
    const job: ProjectJob = {
      id: randomUUID(),
      projectId,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.draftJobs.set(job.id, { ...job, attempts: 0, maxAttempts: 3, params });
    return job;
  }

  async createFinishedDraftJob(projectId: string, params: Record<string, unknown>) {
    const job = await this.createDraftJob(projectId, params);
    const finished: ProjectJob = { ...job, status: 'succeeded' };
    this.draftJobs.set(job.id, { ...finished, params });
    return finished;
  }

  async listDraftJobs(projectId: string) {
    // Map iteration is insertion order, which is reliable where timestamps can tie.
    return [...this.draftJobs.values()]
      .filter((j) => j.projectId === projectId)
      .reverse()
      .map(({ id, projectId: p, status, error, createdAt, updatedAt, attempts, maxAttempts }) => ({
        id,
        projectId: p,
        status,
        error,
        createdAt,
        updatedAt,
        attempts: attempts ?? 0,
        maxAttempts: maxAttempts ?? 3,
      }));
  }

  async queuePaused() {
    return this.queuePausedNow;
  }

  async cancelDraftJob(projectId: string, jobId: string, error: string) {
    const job = this.draftJobs.get(jobId);
    if (!job || job.projectId !== projectId) return null;
    if (job.status !== 'queued' && job.status !== 'running') return null;
    const cancelled = { ...job, status: 'cancelled' as const, error, updatedAt: this.now() };
    this.draftJobs.set(jobId, cancelled);
    this.addEvent(jobId, 'warn', 'cancelled', {});
    const { id, status, createdAt, updatedAt, attempts, maxAttempts } = cancelled;
    return { id, projectId, status, error, createdAt, updatedAt, attempts, maxAttempts };
  }

  async createExportJob(projectId: string, params: Record<string, unknown>) {
    const removed = [...this.exportJobs.values()]
      .filter((j) => j.projectId === projectId)
      .map((j) => j.id);
    for (const id of removed) this.exportJobs.delete(id);
    const now = new Date().toISOString();
    const job: ProjectJob = {
      id: randomUUID(),
      projectId,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.exportJobs.set(job.id, { ...job, params });
    return { job, removed };
  }

  async listExportJobs(projectId: string) {
    return [...this.exportJobs.values()]
      .filter((j) => j.projectId === projectId)
      .reverse()
      .map(({ id, projectId: p, status, error, createdAt, updatedAt }) => ({
        id,
        projectId: p,
        status,
        error,
        createdAt,
        updatedAt,
      }));
  }

  async createSegmentJob(projectId: string, params: SegmentJobParams) {
    const removed = [...this.segmentJobs.values()]
      .filter((j) => j.projectId === projectId)
      .map((j) => j.id);
    for (const id of removed) this.segmentJobs.delete(id);
    const now = new Date().toISOString();
    const job: SegmentJob = {
      id: randomUUID(),
      projectId,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.segmentJobs.set(job.id, { ...job, params });
    return { job, removed };
  }

  async createGraphJob(projectId: string, params: GraphJobParams) {
    const removed = [...this.graphJobs.values()]
      .filter((j) => j.projectId === projectId)
      .map((j) => j.id);
    for (const id of removed) this.graphJobs.delete(id);
    const now = new Date().toISOString();
    const job: ProjectJob = {
      id: randomUUID(),
      projectId,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.graphJobs.set(job.id, { ...job, params });
    this.priorities.set(job.id, SEGMENT_PRIORITY);
    return { job, removed };
  }

  async createPluginJob(projectId: string, params: PluginJobParams) {
    const removed = [...this.pluginJobs.values()]
      .filter((j) => j.projectId === projectId)
      .map((j) => j.id);
    for (const id of removed) this.pluginJobs.delete(id);
    const now = new Date().toISOString();
    const job: ProjectJob = {
      id: randomUUID(),
      projectId,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.pluginJobs.set(job.id, { ...job, params });
    this.priorities.set(job.id, SEGMENT_PRIORITY);
    return { job, removed };
  }

  async getPluginJob(projectId: string, id: string): Promise<ProjectJob | null> {
    const stored = this.pluginJobs.get(id);
    if (stored?.projectId !== projectId) return null;
    const { id: jobId, status, error, createdAt, updatedAt } = stored;
    return { id: jobId, projectId, status, error, createdAt, updatedAt };
  }

  async getGraphJob(projectId: string, id: string): Promise<ProjectJob | null> {
    const stored = this.graphJobs.get(id);
    if (stored?.projectId !== projectId) return null;
    const { id: jobId, status, error, createdAt, updatedAt } = stored;
    return { id: jobId, projectId, status, error, createdAt, updatedAt };
  }
  async createSuggestJob(projectId: string, params: SuggestParams) {
    const removed = [...this.suggestJobs.values()]
      .filter((j) => j.projectId === projectId)
      .map((j) => j.id);
    for (const id of removed) this.suggestJobs.delete(id);
    const now = new Date().toISOString();
    const job: ProjectJob = {
      id: randomUUID(),
      projectId,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.suggestJobs.set(job.id, { ...job, params });
    this.priorities.set(job.id, SEGMENT_PRIORITY);
    return { job, removed };
  }

  async latestSuggestJob(projectId: string) {
    const stored = [...this.suggestJobs.values()].find((j) => j.projectId === projectId);
    if (!stored) return null;
    const { id, status, error, createdAt, updatedAt, params } = stored;
    return { id, projectId, status, error, createdAt, updatedAt, params: params as SuggestParams };
  }

  async getSegmentJob(projectId: string, id: string) {
    const stored = this.segmentJobs.get(id);
    if (stored?.projectId !== projectId) return null;
    return {
      id: stored.id,
      projectId: stored.projectId,
      status: stored.status,
      error: stored.error,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  async listProjectJobs(projectId: string): Promise<JobSummary[]> {
    return [...this.jobs.values()]
      .filter((j) => j.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((j) => this.withModels(j));
  }

  async countUnfinishedJobsWithModel(model: string): Promise<number> {
    const unfinished = ['queued', 'running', 'awaiting_review'];
    return [...this.jobs.values()].filter(
      (j) => j.modelOverride === model && unfinished.includes(j.status),
    ).length;
  }

  async listJobs({ limit, status, group, mine }: ListJobsQuery): Promise<JobSummary[]> {
    return [...this.jobs.values()]
      .filter((j) => j.task !== 'prepare' && (!status || j.status === status))
      .filter((j) => !group || statusGroup(j.status) === group)
      .filter((j) => mine === undefined || isMine(j, mine))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((j) => this.withModels(j));
  }

  async jobPage({ mine, ...query }: JobPageRequest): Promise<JobPage> {
    const listable = [...this.jobs.values()]
      .filter((j) => j.task !== 'prepare')
      .filter((j) => mine === undefined || isMine(j, mine))
      .map((j) => this.withModels(j));
    return pageOfJobs(listable, query);
  }

  /** modelsUsed derived from step runs, like PgRepo's subquery. */
  private withModels(job: JobSummary): JobSummary {
    const runs = [...(this.stepRuns.get(job.id) ?? [])].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    );
    const models = runs.flatMap((r) => (r.model ? [r.model] : []));
    return { ...job, modelsUsed: [...new Set(models)] };
  }

  async getJob(id: string): Promise<JobDetail | null> {
    const job = this.jobs.get(id);
    return job ? { ...this.withModels(job), outputs: shown(this.outputs.get(id)) } : null;
  }

  async getJobParams(id: string): Promise<Record<string, unknown> | null> {
    const background = this.backgroundJobs.find((j) => j.id === id)?.params;
    return (
      this.jobParams.get(id) ??
      this.exportJobs.get(id)?.params ??
      (background as Record<string, unknown> | undefined) ??
      null
    );
  }

  async getDocumentObject(jobId: string): Promise<(StoredObject & { filename: string }) | null> {
    const job = this.jobs.get(jobId);
    const doc = job && this.documents.get(job.documentId);
    return doc ? { bucket: doc.bucket, key: doc.objectKey, filename: doc.filename } : null;
  }

  async listPublished({
    limit,
    templateId,
    before,
    beforeId,
    q,
    show,
  }: ListPublishedQuery): Promise<ResultSummary[]> {
    // Compare as times (cursors may carry an offset); ties break on job id, like PgRepo.
    const cursor = before === undefined ? undefined : Date.parse(before);
    const isBefore = (at: string, jobId: string) => {
      if (cursor === undefined) return true;
      const t = Date.parse(at);
      return t < cursor || (t === cursor && beforeId !== undefined && jobId < beforeId);
    };
    return [...this.jobs.values()]
      .filter((j) => !j.test && (!templateId || j.specId === templateId))
      .filter((j) => !q || j.filename.toLowerCase().includes(q.toLowerCase()))
      .filter((j) => show !== 'reviewed' || j.reviewedAt !== null)
      .filter((j) => show !== 'auto' || j.reviewedAt === null)
      .flatMap((j): ResultSummary[] => {
        const published = shown(this.outputs.get(j.id)).filter((o) => o.stage === 'published');
        const at = this.publishedAt.get(j.id) ?? j.updatedAt;
        if (published.length === 0 || !isBefore(at, j.id)) return [];
        return [
          {
            jobId: j.id,
            documentId: j.documentId,
            filename: j.filename,
            contentType: j.contentType,
            specId: j.specId,
            specVersion: j.specVersion,
            publishedAt: at,
            reviewer: j.reviewer,
            reviewedAt: j.reviewedAt,
            outputCount: published.length,
            outputs: [...published]
              .sort((a, b) => a.outputId.localeCompare(b.outputId))
              .map((o) => ({
                outputId: o.outputId,
                format: o.format,
                name: o.key.split('/').pop() ?? o.outputId,
                rowCount: o.rowCount,
              })),
            issueCount: published.find((o) => o.outputId === 'issues')?.rowCount ?? null,
          },
        ];
      })
      .filter((r) => show !== 'issues' || (r.issueCount ?? 0) > 0)
      .sort(
        (a, b) =>
          Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
          (a.jobId < b.jobId ? 1 : a.jobId > b.jobId ? -1 : 0),
      )
      .slice(0, limit);
  }

  async getPublishedAt(jobId: string): Promise<string | null> {
    const job = this.jobs.get(jobId);
    const published = (this.outputs.get(jobId) ?? []).some((o) => o.stage === 'published');
    if (!job || !published) return null;
    return this.publishedAt.get(jobId) ?? job.updatedAt;
  }

  /** Test helper: an event as the worker's queue.event writes it. */
  addEvent(jobId: string, level: string, message: string, data: unknown = null): void {
    this.events.set(jobId, [
      ...(this.events.get(jobId) ?? []),
      { level, message, data, at: this.now() },
    ]);
  }

  async latestEvents(jobIds: string[], messages: readonly string[]): Promise<JobEventRecord[]> {
    return jobIds.flatMap((jobId) =>
      messages.flatMap((message) => {
        const event = (this.events.get(jobId) ?? []).filter((e) => e.message === message).at(-1);
        return event ? [{ jobId, message, data: event.data, at: event.at }] : [];
      }),
    );
  }

  async listEvents(
    jobId: string,
    opts: EventFilter = {},
  ): Promise<{ message: string; data: unknown; at: string }[]> {
    const since = opts.since === undefined ? null : Date.parse(opts.since);
    const { messages } = opts;
    const wanted = (message: string): boolean =>
      messages === undefined ||
      (messages.exact ?? []).includes(message) ||
      (messages.prefixes ?? []).some((p) => message.startsWith(p));
    const events = (this.events.get(jobId) ?? []).filter(
      (e) => (since === null || Date.parse(e.at) >= since) && wanted(e.message),
    );
    return events.map((e) => ({
      message: e.message,
      data: e.data,
      at: e.at,
    }));
  }

  async firstEventAt(
    jobId: string,
    message: string,
    since: string,
    match: Record<string, unknown>,
  ): Promise<string | null> {
    const contains = (data: unknown) =>
      typeof data === 'object' &&
      data !== null &&
      Object.entries(match).every(([k, v]) => (data as Record<string, unknown>)[k] === v);
    const event = (this.events.get(jobId) ?? []).find(
      (e) => e.message === message && Date.parse(e.at) >= Date.parse(since) && contains(e.data),
    );
    return event?.at ?? null;
  }

  async queueStats(): Promise<QueueStats> {
    const jobs = [...this.jobs.values()];
    const since = Date.now() - 24 * 3600_000;
    // A requeued job keeps its old times until reclaimed: only finished runs are timed.
    const secs = jobs
      .filter(
        (j) =>
          (j.status === 'succeeded' || j.status === 'awaiting_review') &&
          j.startedAt &&
          j.finishedAt &&
          Date.parse(j.finishedAt) > since,
      )
      .sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))
      .slice(0, 50)
      .map((j) => (Date.parse(j.finishedAt!) - Date.parse(j.startedAt!)) / 1000)
      .filter((s) => s >= 0)
      .sort((a, b) => a - b);
    const mid = secs.length / 2;
    const median = !secs.length
      ? null
      : secs.length % 2
        ? secs[Math.floor(mid)]!
        : (secs[mid - 1]! + secs[mid]!) / 2;
    return {
      queued: jobs.filter((j) => j.status === 'queued').length,
      running: jobs.filter((j) => j.status === 'running').length,
      medianSeconds: median,
    };
  }

  async cancelJob(id: string): Promise<JobSummary | null> {
    const job = this.jobs.get(id);
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return null;
    this.addEvent(id, 'warn', 'cancelled');
    return this.update(id, { status: 'cancelled' });
  }

  /** Tests: the worker published a graph version for `jobId` (to `targetId`, else `default`). */
  publishGraph(g: {
    sha256: string;
    templateId: string;
    graphIri: string;
    jobId: string;
    targetId?: string;
  }): number {
    const key = `${g.sha256}:${g.templateId}`;
    const version =
      Math.max(
        0,
        ...this.graphVersions
          .filter((v) => v.sha256 === g.sha256 && v.templateId === g.templateId)
          .map((v) => v.version),
      ) + 1;
    const targetId = g.targetId ?? DEFAULT_TARGET_ID;
    this.graphVersions.push({ ...g, version, targetId });
    this.graphs.set(key, { graphIri: g.graphIri, version, jobId: g.jobId, targetId });
    return version;
  }

  currentGraphs() {
    return [...this.graphs.entries()].map(([key, g]) => {
      const [sha256, templateId] = key.split(':') as [string, string];
      return { sha256, templateId, ...g };
    });
  }

  private queueBackground(
    task: BackgroundTask,
    params: unknown,
    by: string | null,
    byUser: string | null = null,
  ): string {
    const id = randomUUID();
    const { priority, maxAttempts } = BACKGROUND_JOBS[task];
    this.backgroundJobs.push({
      id,
      task,
      priority,
      maxAttempts,
      params,
      status: 'queued',
      createdBy: by,
      ...(byUser !== null ? { createdByUser: byUser } : {}),
    });
    return id;
  }

  async withdrawType(typeId: string, by: string | null): Promise<string | null> {
    const objects: { bucket: string; key: string; target: string }[] = [];
    for (const job of this.jobs.values()) {
      // The bridge may still write a delivering job's objects: retiring again withdraws them.
      if (job.specId !== typeId || job.status === 'delivering') continue;
      const outputs = this.outputs.get(job.id) ?? [];
      const delivered = outputs.filter((o) => o.stage === 'published');
      if (!delivered.length) continue;
      objects.push(
        ...delivered.map((o) => ({
          bucket: o.bucket,
          key: o.key,
          target: o.targetId ?? DEFAULT_TARGET_ID,
        })),
      );
      this.withdrawnOutputs.set(job.id, [
        ...(this.withdrawnOutputs.get(job.id) ?? []),
        ...delivered,
      ]);
      this.outputs.set(
        job.id,
        outputs.filter((o) => o.stage !== 'published'),
      );
    }
    const graphs = this.currentGraphs()
      .filter((g) => g.templateId === typeId)
      .flatMap((g) => {
        this.graphs.delete(`${g.sha256}:${g.templateId}`);
        const versions = this.graphVersions.filter(
          (v) => v.sha256 === g.sha256 && v.templateId === g.templateId,
        );
        return graphWithdrawals(g, versions, g);
      });
    objects.sort((a, b) => a.key.localeCompare(b.key));
    if (!objects.length && !graphs.length) return null;
    return this.queueBackground('withdraw', { objects, graphs }, by);
  }

  async republishType(typeId: string, by: string | null): Promise<string | null> {
    const withdrawn = [...this.withdrawnOutputs.keys()].some(
      (id) => this.jobs.get(id)?.specId === typeId,
    );
    return withdrawn ? this.queueBackground('republish', { templateId: typeId }, by) : null;
  }

  async withdrawalStatus(): Promise<WithdrawalStatus> {
    const count = (s: JobStatus) =>
      this.backgroundJobs.filter(
        (j) => (j.task === 'withdraw' || j.task === 'republish') && j.status === s,
      ).length;
    return {
      queued: count('queued'),
      running: count('running'),
      failed: count('failed') + count('needs_review'),
    };
  }

  async deleteJob(id: string): Promise<DeleteJobResult> {
    const job = this.jobs.get(id);
    if (!job) return { result: 'not_found' };
    if (!DELETABLE_STATUSES.includes(job.status)) return { result: 'conflict', status: job.status };
    const draftObjects = (this.outputs.get(id) ?? [])
      .filter((o) => o.stage === 'draft')
      .map((o) => ({ bucket: o.bucket, key: o.key }));
    const objects = (this.outputs.get(id) ?? [])
      .filter((o) => o.stage === 'published')
      .map((o) => ({ bucket: o.bucket, key: o.key, target: o.targetId ?? DEFAULT_TARGET_ID }));
    const graphs: WithdrawnGraph[] = [];
    const mine = this.graphVersions.filter((g) => g.jobId === id);
    for (const key of new Set(mine.map((v) => `${v.sha256}:${v.templateId}`))) {
      const versions = mine.filter((v) => `${v.sha256}:${v.templateId}` === key);
      const current = this.graphs.get(key);
      const drop = current?.jobId === id;
      if (drop) this.graphs.delete(key);
      graphs.push(...graphWithdrawals(versions[0]!, versions, drop ? current! : null));
    }
    for (let i = this.graphVersions.length - 1; i >= 0; i--) {
      if (this.graphVersions[i]!.jobId === id) this.graphVersions.splice(i, 1);
    }
    const withdrawJobId =
      objects.length || graphs.length
        ? this.queueBackground('withdraw', { objects, graphs }, null)
        : null;
    this.jobs.delete(id);
    this.outputs.delete(id);
    this.edits.delete(id);
    this.stepRuns.delete(id);
    this.events.delete(id);
    this.publishedAt.delete(id);
    const doc = this.documents.get(job.documentId);
    const stillUsed =
      [...this.jobs.values()].some((j) => j.documentId === job.documentId) ||
      [...this.references.values()].some((r) => r.documentId === job.documentId) ||
      this.sampleDocuments.has(job.documentId);
    let inboxObject: StoredObject | null = null;
    if (doc && !stillUsed) {
      this.documents.delete(job.documentId);
      const shared = [...this.documents.values()].some(
        (d) => d.bucket === doc.bucket && d.objectKey === doc.objectKey,
      );
      if (!shared) inboxObject = { bucket: doc.bucket, key: doc.objectKey };
    }
    return { result: 'deleted', removed: { jobId: id, draftObjects, inboxObject, withdrawJobId } };
  }

  async finishedJobIdsBefore(cutoffIso: string, includeRegression = false): Promise<string[]> {
    const cutoff = Date.parse(cutoffIso);
    return [...this.jobs.values()]
      .filter(
        (j) =>
          j.task !== 'prepare' &&
          DELETABLE_STATUSES.includes(j.status) &&
          Date.parse(j.updatedAt) < cutoff &&
          (includeRegression || !j.referenceId),
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((j) => j.id);
  }

  async retryJob(
    id: string,
    { model, specVersion, outputs }: RetryOptions = {},
  ): Promise<JobSummary | null> {
    const job = this.jobs.get(id);
    if (!job || !RETRYABLE.includes(job.status)) return null;
    if (outputs !== undefined) {
      this.jobParams.set(id, { ...(this.jobParams.get(id) ?? {}), outputs: outputs ?? null });
    }
    // A cancelled publish/rerun resumes as that task (keeps the approval / re-run request);
    // preparation stays a preparation; other failures re-run processing.
    const task = job.status === 'cancelled' || job.task === 'prepare' ? job.task : 'process';
    const override = model === undefined ? {} : { modelOverride: model };
    const doc = this.documents.get(job.documentId);
    if (specVersion !== undefined && doc) this.documents.set(doc.id, { ...doc, specVersion });
    const version = specVersion === undefined ? {} : { specVersion };
    // Re-running a succeeded job re-extracts: its review belonged to the old extraction.
    const review =
      job.status === 'succeeded'
        ? { reviewer: null, reviewNote: null, reviewedAt: null, reviewReasons: null }
        : {};
    if (job.status === 'succeeded') this.edits.delete(id);
    return this.update(id, {
      status: 'queued',
      task,
      attempts: 0,
      error: null,
      ...override,
      ...version,
      ...review,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  async listProjectRuns(projectId: string) {
    // Map iteration is insertion order, which is reliable where timestamps can tie.
    return [...this.jobs.values()]
      .filter((j) => j.projectId === projectId && RUN_TASKS.includes(j.task))
      .reverse()
      .map((job) => ({ job, sha256: this.documents.get(job.documentId)!.sha256 }));
  }

  async listReferencesWithSha(templateId: string) {
    return [...this.references.values()]
      .filter((r) => r.templateId === templateId)
      .reverse()
      .map((r) => ({ ...r, sha256: this.documents.get(r.documentId)!.sha256 }));
  }

  private liveReferences(templateId: string) {
    return [...this.references.values()].filter(
      (r) => r.templateId === templateId && r.supersededAt === null,
    );
  }

  async createReference(input: NewReference): Promise<Reference> {
    const version = input.templateVersion ?? null;
    const sha = this.documents.get(input.documentId)?.sha256;
    // Re-verifying a sample at a pinned version replaces its reference. Decide the name
    // conflict before superseding anything, so a refused save changes nothing.
    const replaced =
      version === null
        ? []
        : this.liveReferences(input.templateId).filter(
            (r) =>
              r.templateVersion === version && this.documents.get(r.documentId)?.sha256 === sha,
          );
    const taken = this.liveReferences(input.templateId).some(
      (r) => !replaced.includes(r) && r.templateVersion === version && r.name === input.name,
    );
    if (taken) throw new ReferenceConflictError(`reference "${input.name}" already exists`);
    for (const r of replaced) this.references.set(r.id, { ...r, supersededAt: this.now() });
    const ref: Reference = {
      ...input,
      templateVersion: version,
      verifiedOutputs: version === null ? null : (input.verifiedOutputs ?? null),
      copiedFrom: null,
      supersededAt: null,
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.references.set(ref.id, ref);
    return ref;
  }

  async listReferences(templateId: string, version?: number): Promise<Reference[]> {
    return this.liveReferences(templateId).filter(
      (r) => version === undefined || r.templateVersion === null || r.templateVersion === version,
    );
  }

  async carryReferencesForward(templateId: string, toVersion: number): Promise<number> {
    // A version with any row, live or superseded (deleted), already has its own set.
    const rows = [...this.references.values()].filter((r) => r.templateId === templateId);
    if (rows.some((r) => r.templateVersion === toVersion)) return 0;
    // The source is the newest earlier version with any row: an emptied version passes on
    // nothing rather than the set before it.
    const earlier = rows
      .map((r) => r.templateVersion)
      .filter((v): v is number => v !== null && v < toVersion);
    if (!earlier.length) return 0;
    const from = Math.max(...earlier);
    const sources = this.liveReferences(templateId).filter((r) => r.templateVersion === from);
    for (const s of sources) {
      const copy: Reference = {
        ...s,
        id: randomUUID(),
        templateVersion: toVersion,
        copiedFrom: s.id,
      };
      this.references.set(copy.id, copy);
    }
    return sources.length;
  }

  async deleteReference(templateId: string, id: string): Promise<boolean> {
    const ref = this.references.get(id);
    if (ref?.templateId !== templateId) return false;
    // A pinned reference is superseded, not removed: iterations keep their comparison and the
    // version keeps a row, so the next read does not carry the earlier set back.
    if (ref.templateVersion !== null) {
      if (ref.supersededAt !== null) return false;
      this.references.set(id, { ...ref, supersededAt: this.now() });
      return true;
    }
    // copied_from REFERENCES template_references ON DELETE SET NULL
    for (const r of this.references.values()) {
      if (r.copiedFrom === id) this.references.set(r.id, { ...r, copiedFrom: null });
    }
    return this.references.delete(id);
  }

  async createRegressionJob(
    reference: Reference,
    version: number,
    params: Record<string, unknown> | null = null,
    createdBy: Creator | null = null,
  ): Promise<JobSummary> {
    const source = this.documents.get(reference.documentId)!;
    const doc = { ...source, id: randomUUID(), specVersion: version };
    return this.createDocumentAndJob(doc, null, true, reference.id, params, createdBy);
  }

  async listLatestRegressionJobs(templateId: string, version: number): Promise<JobDetail[]> {
    const latest = new Map<string, JobSummary>();
    for (const j of [...this.jobs.values()]
      .filter((j) => j.referenceId && j.specId === templateId && j.specVersion === version)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))) {
      if (!latest.has(j.referenceId!)) latest.set(j.referenceId!, j);
    }
    return [...latest.values()].map((j) => ({ ...j, outputs: shown(this.outputs.get(j.id)) }));
  }

  async metricsData(templateId: string): Promise<MetricsData> {
    const jobs = [...this.jobs.values()].filter(
      (j) => j.specId === templateId && j.task !== 'prepare',
    );
    const ids = new Set(jobs.map((j) => j.id));
    return {
      jobs,
      edits: [...this.edits.entries()]
        .filter(([jobId]) => ids.has(jobId))
        .flatMap(([jobId, edits]) =>
          edits.map((e) => ({ jobId, field: e.field, table: e.table, column: e.column })),
        ),
      stepRuns: [...this.stepRuns.entries()]
        .filter(([jobId]) => ids.has(jobId))
        .flatMap(([jobId, runs]) => runs.map((r) => ({ ...r, cached: r.cached ?? false, jobId }))),
    };
  }

  async listEdits(jobId: string): Promise<ReviewEdit[]> {
    return this.edits.get(jobId) ?? [];
  }

  async listJobReviews(jobIds: readonly string[]): Promise<JobReview[]> {
    return [...new Set(jobIds)].flatMap((id) => {
      const job = this.jobs.get(id);
      if (!job) return [];
      return [
        {
          jobId: id,
          status: job.status,
          reviewer: job.reviewer,
          reviewedAt: job.reviewedAt,
          modelOverride: job.modelOverride,
          edits: this.edits.get(id) ?? [],
        },
      ];
    });
  }

  async addEdit(jobId: string, edit: NewEdit): Promise<ReviewEdit> {
    const saved: ReviewEdit = { id: ++this.editSeq, at: new Date().toISOString(), ...edit };
    this.edits.set(jobId, [...(this.edits.get(jobId) ?? []), saved]);
    return saved;
  }

  /** jobs.delivery_overrides, by job id. */
  readonly overrides = new Map<string, DeliveryOverrides>();
  /** jobs.reviewer_user_id, by job id. */
  readonly reviewerIds = new Map<string, string | null>();
  /** jobs.connection_needed: the jobs waiting in review for a person's connection. */
  readonly needingConnection = new Set<string>();

  async connectionNeeded(jobId: string): Promise<boolean> {
    return this.needingConnection.has(jobId);
  }

  async deliveryOverrides(jobId: string): Promise<DeliveryOverrides> {
    return structuredClone(this.overrides.get(jobId) ?? {});
  }

  async approve(
    jobId: string,
    reviewer: string | null,
    note: string | null,
    overrides: DeliveryOverrides = {},
    reviewerUserId: string | null = null,
  ) {
    if (this.jobs.get(jobId)?.status !== 'awaiting_review') return null;
    this.overrides.set(jobId, structuredClone(overrides));
    this.reviewerIds.set(jobId, reviewerUserId);
    this.needingConnection.delete(jobId);
    return this.update(jobId, {
      status: 'queued',
      task: 'publish',
      attempts: 0,
      reviewer,
      reviewNote: note,
      reviewedAt: new Date().toISOString(),
    });
  }

  async listStepRuns(jobId: string): Promise<StepRun[]> {
    return (this.stepRuns.get(jobId) ?? []).map((r) => ({ ...r, cached: r.cached ?? false }));
  }

  async requestRerun(jobId: string, step: string, params: RerunRequest) {
    if (this.jobs.get(jobId)?.status !== 'awaiting_review') return null;
    this.reruns.set(jobId, { step, ...params });
    return this.update(jobId, { status: 'queued', task: 'rerun', attempts: 0 });
  }

  async reject(jobId: string, reviewer: string | null, reason: string) {
    if (this.jobs.get(jobId)?.status !== 'awaiting_review') return null;
    return this.update(jobId, {
      status: 'rejected',
      reviewer,
      reviewNote: reason,
      reviewedAt: new Date().toISOString(),
    });
  }

  /** job_deliveries, by delivery id. */
  readonly deliveries = new Map<string, JobDelivery>();
  /** The hand-off (round) each delivery was recorded with: `recordDeliveries` calls, per job. */
  private readonly roundOf = new Map<string, number>();
  private readonly rounds = new Map<string, number>();

  async recordDeliveries(
    jobId: string,
    rows: { targetId: string; deliveryId: string }[],
  ): Promise<void> {
    const round = (this.rounds.get(jobId) ?? 0) + 1;
    this.rounds.set(jobId, round);
    for (const r of rows) {
      if (this.deliveries.has(r.deliveryId)) continue;
      this.roundOf.set(r.deliveryId, round);
      this.deliveries.set(r.deliveryId, {
        deliveryId: r.deliveryId,
        jobId,
        targetId: r.targetId,
        status: 'queued',
        error: null,
        receipt: null,
        lastSequence: 0,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /** Test helper: a delivery last updated at `at` (for the reconcile). */
  ageDelivery(deliveryId: string, at: Date): void {
    const d = this.deliveries.get(deliveryId);
    if (d) d.updatedAt = at.toISOString();
  }

  async applyDeliveryUpdate(
    deliveryId: string,
    update: DeliveryUpdate,
    finish: (deliveries: JobDelivery[], job: { task: string }) => JobFinish | null,
  ): Promise<{ outcome: 'applied' | 'stale' | 'unknown'; finished: JobFinish | null }> {
    const d = this.deliveries.get(deliveryId);
    if (!d) return { outcome: 'unknown', finished: null };
    if (update.sequence <= d.lastSequence || FINAL_DELIVERY.has(d.status)) {
      return { outcome: 'stale', finished: null };
    }
    Object.assign(d, {
      status: update.status,
      error: update.error,
      receipt: update.receipt,
      lastSequence: update.sequence,
      updatedAt: new Date().toISOString(),
    });
    const job = this.jobs.get(d.jobId);
    const background = this.backgroundJobs.find((j) => j.id === d.jobId);
    const task = background?.task ?? job?.task ?? 'process';
    const finishedAs = finish(await this.deliveriesOf(d.jobId), { task });
    if (!finishedAs) return { outcome: 'applied', finished: null };
    const outcome = background ? backgroundFinish(finishedAs) : finishedAs;
    const status = job?.status ?? background?.status;
    if (status !== 'delivering') return { outcome: 'applied', finished: null };
    if (job) {
      if (outcome.status === 'awaiting_review' && outcome.connectionNeeded) {
        this.needingConnection.add(d.jobId);
      } else this.needingConnection.delete(d.jobId);
      this.update(d.jobId, {
        status: outcome.status,
        error: outcome.status === 'failed' ? outcome.error : null,
        reviewReasons: outcome.status === 'awaiting_review' ? outcome.reasons : job.reviewReasons,
      });
    } else if (background) {
      background.status = outcome.status;
    }
    const e = finishEvent(outcome);
    this.addEvent(d.jobId, e.level, e.message, e.data);
    return { outcome: 'applied', finished: outcome };
  }

  /** The deliveries of the job's latest round (a re-approval's round replaces the one before). */
  async deliveriesOf(jobId: string): Promise<JobDelivery[]> {
    const mine = [...this.deliveries.values()].filter((d) => d.jobId === jobId);
    const latest = Math.max(0, ...mine.map((d) => this.roundOf.get(d.deliveryId) ?? 0));
    return mine
      .filter((d) => (this.roundOf.get(d.deliveryId) ?? 0) === latest)
      .map((d) => ({ ...d }));
  }

  async stragglers(olderThanMinutes: number, now: Date): Promise<JobDelivery[]> {
    const before = now.getTime() - olderThanMinutes * 60_000;
    return [...this.deliveries.values()]
      .filter((d) => {
        const status =
          this.jobs.get(d.jobId)?.status ??
          this.backgroundJobs.find((j) => j.id === d.jobId)?.status;
        return (
          status === 'delivering' &&
          !FINAL_DELIVERY.has(d.status) &&
          Date.parse(d.updatedAt) < before
        );
      })
      .map((d) => ({ ...d }));
  }

  /** The decomposition register, by entry id (the worker writes it; tests seed it). */
  readonly register = new Map<string, RegisterEntry>();
  /** What people did to register entries (register_actions), oldest first. */
  readonly registerActions: RegisterAction[] = [];

  /** Test helper: an entry as the worker writes it before delivering (`pending`). */
  putRegisterEntry(
    entry: Pick<
      RegisterEntry,
      | 'sinkId'
      | 'instanceId'
      | 'sourceKey'
      | 'contentSha256'
      | 'persistentId'
      | 'idempotencyKey'
      | 'deliveryId'
      | 'batchId'
    >,
  ): RegisterEntry {
    const now = new Date().toISOString();
    const row: RegisterEntry = {
      ...entry,
      id: randomUUID(),
      state: 'pending',
      lastReceipt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      deliveredAt: null,
      detachActionId: null,
    };
    this.register.set(row.id, row);
    return { ...row };
  }

  /** Test helper: a register entry last updated at `at` (for the reconcile). */
  ageRegisterEntry(id: string, at: Date): void {
    const e = this.register.get(id);
    if (e) e.updatedAt = at.toISOString();
  }

  async registerStragglers(olderThanMinutes: number, now: Date): Promise<RegisterEntry[]> {
    const before = now.getTime() - olderThanMinutes * 60_000;
    return [...this.register.values()]
      .filter(
        (e) => e.state === 'pending' && e.deliveryId !== null && Date.parse(e.updatedAt) < before,
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((e) => ({ ...e }));
  }

  async expireUnrecordedRegisterEntries(
    olderThanMinutes: number,
    now: Date,
    error: NonNullable<RegisterEntry['lastError']>,
  ): Promise<number> {
    const before = now.getTime() - olderThanMinutes * 60_000;
    let moved = 0;
    for (const e of this.register.values()) {
      if (e.state !== 'pending' || e.deliveryId !== null || Date.parse(e.updatedAt) >= before) {
        continue;
      }
      Object.assign(e, { state: 'failed', lastError: error, updatedAt: now.toISOString() });
      moved += 1;
    }
    return moved;
  }

  async registerEntryByDelivery(deliveryId: string): Promise<RegisterEntry | null> {
    const e = [...this.register.values()].find((r) => r.deliveryId === deliveryId);
    return e ? { ...e } : null;
  }

  async settleRegisterEntry(
    deliveryId: string,
    s: RegisterSettlement,
    item: (before: RegisterEntry) => ItemSettlement,
  ): Promise<'applied' | 'stale' | 'unknown'> {
    const e = [...this.register.values()].find((r) => r.deliveryId === deliveryId);
    if (!e) return 'unknown';
    if (e.state !== 'pending') return 'stale';
    const settled = item({ ...e });
    const mine = [...this.conversionItems.values()].find(
      (i) =>
        i.batchId === e.batchId &&
        i.sourceKey === e.sourceKey &&
        SETTLEABLE_ITEM.includes(i.outcome),
    );
    const now = new Date().toISOString();
    if (mine) Object.assign(mine, { ...settled, registerEntryId: e.id, finishedAt: now });
    Object.assign(e, {
      state: s.state,
      persistentId: s.persistentId ?? e.persistentId,
      lastReceipt: s.receipt ?? e.lastReceipt,
      lastError: s.error,
      updatedAt: now,
      deliveredAt: s.delivered ? now : e.deliveredAt,
    });
    return 'applied';
  }

  /** Conversion batches (decomposition_batches), in creation order. */
  readonly conversionBatches = new Map<string, Batch>();
  /**
   * Their items (decomposition_items), in upload order; tests set outcomes and reports. An item's
   * `resolution` is not stored: it is read from its register entry (`withResolution`).
   */
  readonly conversionItems = new Map<string, StoredItem>();

  /** The item as the API shows it: its resolution read from its register entry (PgRepo's too). */
  private withResolution(item: StoredItem): Item {
    let resolution: Item['resolution'] = null;
    let unversioned = false;
    let gone = false;
    let unconfirmed = false;
    let partWay = false;
    let links: Item['links'] = [];
    let detached = false;
    if (item.registerEntryId) {
      const entry = this.register.get(item.registerEntryId);
      unversioned = entry !== undefined && isUnversioned(entry);
      gone = entry !== undefined && isGone(entry);
      unconfirmed = entry !== undefined && isUnconfirmed(entry);
      partWay = entry !== undefined && isPartWay(entry);
      if (entry && LINKED_STATES.has(entry.state)) links = errorLinksOf(entry.lastError);
      const state = entry?.state;
      detached = state === 'detached';
      // Gone: a create replaced the detached tombstone (worker `register.put_pending`).
      if (state === undefined || state === 'detached') resolution = 'detached';
      else if (state === 'accepted') resolution = 'accepted';
      else if (item.outcome === 'changed_in_target' && entry) {
        // The refusal this item saw: its own delivery's (the entry names its batch), or one the
        // entry already held when its batch started (the register check refused it at once).
        const startedAt = this.conversionBatches.get(item.batchId)?.startedAt ?? null;
        const own =
          state === 'changed' &&
          (entry.batchId === item.batchId ||
            startedAt === null ||
            Date.parse(entry.updatedAt) <= Date.parse(startedAt));
        if (!own) resolution = 'superseded';
      }
    }
    const reloadable = isReloadable(gone, detached, resolution);
    // Its latest run again: items are kept in creation order.
    const rerun = [...this.conversionItems.values()].findLast((i) => i.redeliverOf === item.id);
    const rerunBatch = rerun && this.conversionBatches.get(rerun.batchId);
    return structuredClone({
      ...item,
      // Held files exist only while the item awaits review (pg's `held`).
      held: item.held && item.outcome === 'awaiting_review',
      resolution,
      unversioned,
      gone,
      unconfirmed,
      partWay,
      links,
      reloadable,
      rerunIn: rerun?.batchId ?? null,
      rerunAt: rerunBatch ? (rerunBatch.startedAt ?? rerunBatch.createdAt) : null,
    });
  }

  async createBatch({ targetId, force, autoApprove = false, createdBy }: NewBatch): Promise<Batch> {
    const batch: Batch = {
      id: randomUUID(),
      targetId,
      createdBy: { ...createdBy },
      state: 'open',
      force,
      autoApprove,
      createdAt: new Date().toISOString(),
      startedAt: null,
      watch: null,
    };
    this.conversionBatches.set(batch.id, batch);
    return structuredClone(batch);
  }

  /** Test hook: the watched folder that owns a batch (the worker makes such a batch in production). */
  markWatchBatch(batchId: string, watch: NonNullable<Batch['watch']>): void {
    this.conversionBatches.get(batchId)!.watch = { ...watch };
    this.watchBatches.set(watch.id, batchId);
  }
  /** Test hooks: the step of the pickup behind a watched item, and each watch's current batch. */
  readonly watchPickups = new Map<string, string>();
  /** Test hook: copies of watched files the worker stored but has not admitted (key → watch). */
  readonly watchHeldCopies = new Map<string, string>();
  private readonly watchBatches = new Map<string, string | null>();
  watchBatchOf(watchId: string): string | null {
    return this.watchBatches.get(watchId) ?? null;
  }

  async getBatch(id: string): Promise<Batch | null> {
    const batch = this.conversionBatches.get(id);
    return batch ? structuredClone(batch) : null;
  }

  async listBatches(limit: number): Promise<BatchSummary[]> {
    return [...this.conversionBatches.values()]
      .filter((b) => b.state !== 'discarded')
      .reverse()
      .slice(0, limit)
      .map((b) => {
        const items = [...this.conversionItems.values()].filter((i) => i.batchId === b.id);
        const counts = emptyCounts();
        for (const i of items) counts[i.outcome] += 1;
        return { ...structuredClone(b), itemCount: items.length, counts };
      });
  }

  async listItems(batchId: string): Promise<Item[]> {
    return [...this.conversionItems.values()]
      .filter((i) => i.batchId === batchId)
      .map((i) => this.withResolution(i));
  }

  async itemByDelivery(deliveryId: string): Promise<Item | null> {
    const jobId = this.deliveries.get(deliveryId)?.jobId;
    const item = jobId
      ? [...this.conversionItems.values()].find((i) => i.jobId === jobId)
      : undefined;
    return item ? this.withResolution(item) : null;
  }

  async getItem(id: string): Promise<Item | null> {
    const item = this.conversionItems.get(id);
    return item ? this.withResolution(item) : null;
  }

  async addItem(item: NewItem): Promise<AddItemResult> {
    const batch = this.conversionBatches.get(item.batchId);
    if (!batch) return { ok: false, reason: 'missing' };
    if (batch.state !== 'open') return { ok: false, reason: 'not_open' };
    const items = [...this.conversionItems.values()];
    if (items.some((i) => i.batchId === item.batchId && i.sourceKey === item.sourceKey)) {
      return { ok: false, reason: 'duplicate' };
    }
    const row: StoredItem = {
      ...item,
      jobId: null,
      outcome: 'queued',
      detail: null,
      registerEntryId: null,
      reportKey: null,
      link: null,
      redeliverOf: null,
      startedAt: null,
      finishedAt: null,
      ...NOT_REVIEWED,
      ...NOT_WAITED,
    };
    this.conversionItems.set(row.id, row);
    return { ok: true, item: this.withResolution(row) };
  }

  async startBatch(id: string, by: Creator | null): Promise<StartBatchResult> {
    const batch = this.conversionBatches.get(id);
    if (!batch) return { ok: false, reason: 'missing' };
    if (batch.state !== 'open') return { ok: false, reason: 'not_open' };
    const items = [...this.conversionItems.values()].filter((i) => i.batchId === id);
    if (!items.length) return { ok: false, reason: 'empty' };
    const jobIds = items.map((item) => {
      item.jobId = this.queueBackground(
        'decompose',
        {
          batchId: id,
          itemId: item.id,
          targetId: batch.targetId,
          sourceKey: item.sourceKey,
          force: batch.force,
          ...(batch.autoApprove ? { autoApprove: true } : {}),
        },
        by?.name ?? null,
        by?.userId ?? null,
      );
      return item.jobId;
    });
    Object.assign(batch, { state: 'started', startedAt: new Date().toISOString() });
    return { ok: true, batch: structuredClone(batch), jobIds };
  }

  async discardBatch(id: string): Promise<DiscardBatchResult> {
    const batch = this.conversionBatches.get(id);
    if (!batch) return { ok: false, reason: 'missing' };
    if (batch.state !== 'open') return { ok: false, reason: 'not_open' };
    batch.state = 'discarded';
    const objectKeys = [...this.conversionItems.values()]
      .filter((i) => i.batchId === id)
      .flatMap((i) => (i.objectKey ? [i.objectKey] : []));
    return { ok: true, objectKeys };
  }

  async deleteBatch(id: string): Promise<DeleteBatchResult> {
    const batch = this.conversionBatches.get(id);
    if (!batch) return { ok: false, reason: 'missing' };
    if (batch.state !== 'started') return { ok: false, reason: 'not_started' };
    const items = [...this.conversionItems.values()].filter((i) => i.batchId === id);
    // A watched document is not finished while the watch has not filed its file (its pickup).
    const unfinished = (i: StoredItem) =>
      RUNNING_OUTCOMES.includes(i.outcome) ||
      (batch.watch !== null &&
        this.watchPickups.has(i.id) &&
        !['finished', 'abandoned'].includes(this.watchPickups.get(i.id)!));
    const running = items.filter(unfinished).length;
    if (running > 0 && !batch.watch) return { ok: false, reason: 'running', running };
    if (running > 0) {
      const finished = items.filter((i) => !unfinished(i));
      // The next pickup starts a new batch.
      this.watchBatches.set(batch.watch!.id, null);
      for (const i of finished) this.conversionItems.delete(i.id);
      const named = new Set(
        [...this.conversionItems.values()].map((i) => i.objectKey).filter((k) => k !== null),
      );
      const keys = finished.flatMap((i) => [i.objectKey, i.reportKey]).filter((k) => k !== null);
      return { ok: true, kept: [], remove: [...new Set(keys)].filter((k) => !named.has(k)).sort() };
    }
    const prefix = decompositionBatchPrefix(id);
    const kept = [
      ...new Set(
        [...this.conversionItems.values()]
          .filter((i) => i.batchId !== id && i.objectKey?.startsWith(prefix))
          .map((i) => i.objectKey as string)
          // A watch's file stored under this batch but not admitted yet keeps its copy.
          .concat(
            batch.watch
              ? [...this.watchHeldCopies]
                  .filter(([key, watchId]) => watchId === batch.watch!.id && key.startsWith(prefix))
                  .map(([key]) => key)
              : [],
          ),
      ),
    ].sort();
    for (const i of items) this.conversionItems.delete(i.id);
    this.conversionBatches.delete(id);
    return { ok: true, kept };
  }

  async rerunItem({
    batchId,
    itemId,
    of,
    targetId,
    createdBy,
    by,
    source,
    force = true,
    whileDetached,
  }: Rerun): Promise<RerunResult> {
    const running = [...this.conversionItems.values()].some(
      (i) => (i.redeliverOf === of.id || i.id === of.id) && RUNNING_OUTCOMES.includes(i.outcome),
    );
    if (running) return { ok: false, reason: 'running' };
    if (whileDetached !== undefined && this.register.get(whileDetached)?.state !== 'detached') {
      return { ok: false, reason: 'not_detached' };
    }
    const batch: Batch = {
      id: batchId,
      targetId,
      createdBy: { ...createdBy },
      state: 'started',
      force,
      autoApprove: false,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      watch: null,
    };
    const item: StoredItem = {
      id: itemId,
      batchId,
      sourceKey: of.sourceKey,
      ...source,
      jobId: null,
      outcome: 'queued',
      detail: null,
      registerEntryId: null,
      reportKey: null,
      link: null,
      redeliverOf: of.id,
      startedAt: null,
      finishedAt: null,
      ...NOT_REVIEWED,
      ...NOT_WAITED,
    };
    item.jobId = this.queueBackground(
      'decompose',
      { batchId, itemId, targetId, sourceKey: of.sourceKey, force },
      by?.name ?? null,
      by?.userId ?? null,
    );
    this.conversionBatches.set(batchId, batch);
    this.conversionItems.set(itemId, item);
    return { ok: true, batch: structuredClone(batch), item: this.withResolution(item) };
  }

  async approveItem({ id, by, note }: ReviewInput): Promise<ApproveResult> {
    const item = this.conversionItems.get(id);
    if (!item) return { kind: 'not_found' };
    if (item.outcome !== 'awaiting_review') return { kind: 'not_awaiting' };
    const batch = this.conversionBatches.get(item.batchId)!;
    const jobId = this.queueBackground(
      'decompose',
      {
        batchId: item.batchId,
        itemId: id,
        targetId: batch.targetId,
        sourceKey: item.sourceKey,
        force: batch.force,
        approved: true,
      },
      by?.name ?? null,
      by?.userId ?? null,
    );
    Object.assign(item, {
      outcome: 'queued',
      jobId,
      reviewedBy: batchCreator(by),
      reviewedAt: new Date().toISOString(),
      reviewNote: note,
    });
    return { kind: 'approved', jobId };
  }

  async rejectItem({ id, by, note }: ReviewInput): Promise<RejectResult> {
    const item = this.conversionItems.get(id);
    if (!item) return { kind: 'not_found' };
    if (item.outcome !== 'awaiting_review') return { kind: 'not_awaiting' };
    const now = new Date().toISOString();
    Object.assign(item, {
      outcome: 'rejected',
      reviewedBy: batchCreator(by),
      reviewedAt: now,
      reviewNote: note,
      finishedAt: now,
    });
    return { kind: 'rejected', item: this.withResolution(item) };
  }

  async retryItems({
    items: asked,
    targetId,
    force,
    autoApprove = false,
    by,
  }: Retry): Promise<RetryResult> {
    const all = [...this.conversionItems.values()];
    for (const { id } of asked) {
      const outcome = this.conversionItems.get(id)?.outcome;
      const reruns = all.filter((i) => i.redeliverOf === id);
      const reason =
        outcome && RUNNING_OUTCOMES.includes(outcome)
          ? 'running'
          : outcome !== 'failed'
            ? 'not_failed'
            : reruns.some((i) => RUNNING_OUTCOMES.includes(i.outcome))
              ? 'running'
              : reruns.length
                ? 'already_rerun'
                : null;
      if (reason) return { ok: false, reason, itemId: id };
    }
    const made = asked.map(({ id }) => {
      const item = this.conversionItems.get(id)!;
      Object.assign(item, {
        outcome: 'queued',
        detail: null,
        reportKey: null,
        link: null,
        startedAt: null,
        finishedAt: null,
        ...NOT_REVIEWED,
        ...NOT_WAITED,
      });
      item.jobId = this.queueBackground(
        'decompose',
        {
          batchId: item.batchId,
          itemId: id,
          targetId,
          sourceKey: item.sourceKey,
          force,
          ...(autoApprove ? { autoApprove: true } : {}),
        },
        by?.name ?? null,
        by?.userId ?? null,
      );
      return this.withResolution(item);
    });
    return { ok: true, items: made };
  }

  async registerEntry(id: string): Promise<RegisterEntry | null> {
    const e = this.register.get(id);
    return e ? structuredClone(e) : null;
  }

  async detachRegisterEntry({
    itemId,
    entryId,
    targetIds,
    by,
    reason,
    detail,
  }: Detach): Promise<DetachResult> {
    const entry = this.register.get(entryId);
    if (!entry || entry.state === 'detached') return { ok: false, reason: 'missing' };
    const running = [...this.conversionItems.values()].some(
      (i) =>
        i.sourceKey === entry.sourceKey &&
        RUNNING_OUTCOMES.includes(i.outcome) &&
        targetIds.includes(this.conversionBatches.get(i.batchId)?.targetId ?? ''),
    );
    if (entry.state === 'pending' || running) return { ok: false, reason: 'pending' };
    // Only a document refused as changed in the target, one whose versions were never
    // recorded, one gone from the target, a create the target may have taken, or one refused
    // as part-way, is detached: never a live one.
    if (
      entry.state !== 'changed' &&
      !isUnversioned(entry) &&
      !isGone(entry) &&
      !isUnconfirmed(entry) &&
      !isPartWay(entry)
    ) {
      return { ok: false, reason: 'not_refused' };
    }
    const action: RegisterAction = {
      id: randomUUID(),
      entryId,
      action: 'detach',
      by: { ...by },
      at: new Date().toISOString(),
      details: {
        persistentId: entry.persistentId,
        sourceKey: entry.sourceKey,
        ...(reason ? { reason } : {}),
      },
    };
    this.registerActions.push(action);
    Object.assign(entry, {
      state: 'detached',
      detachActionId: action.id,
      updatedAt: laterThan(entry.updatedAt),
    });
    const item = this.conversionItems.get(itemId)!;
    item.detail = detail(entry);
    return { ok: true, entry: structuredClone(entry), item: this.withResolution(item) };
  }

  async acceptTargetState({
    itemId,
    entryId,
    seen,
    by,
    plan,
    detail,
  }: Accept): Promise<AcceptResult> {
    const entry = this.register.get(entryId);
    if (!entry) return { ok: false, reason: 'missing' };
    if (entry.updatedAt !== seen) return { ok: false, reason: 'stale' };
    const accepted = plan(structuredClone(entry));
    if (accepted.reason !== null) {
      return { ok: false, reason: 'not_acceptable', why: accepted.reason };
    }
    Object.assign(entry, {
      state: 'accepted',
      lastReceipt: acceptedReceipt(entry.lastReceipt!, accepted.components),
      lastError: null,
      updatedAt: laterThan(entry.updatedAt),
    });
    this.registerActions.push({
      id: randomUUID(),
      entryId,
      action: 'accept',
      by: { ...by },
      at: new Date().toISOString(),
      details: { changed: accepted.changed },
    });
    const item = this.conversionItems.get(itemId)!;
    item.detail = detail(entry);
    return { ok: true, item: this.withResolution(item), changed: accepted.changed };
  }

  private update(id: string, changes: Partial<JobSummary>): JobSummary {
    const updated = { ...this.jobs.get(id)!, ...changes, updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);
    return updated;
  }
}

/** A time after `previous` (an ISO time): now, or a millisecond later when now is no later. */
function laterThan(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}
