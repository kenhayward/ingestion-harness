import type { MetricsData } from '../metrics.js';
import type {
  JobDetail,
  Creator,
  JobStatus,
  JobSummary,
  ModelInfo,
  RerunRequest,
  Reference,
  ResultSummary,
  ReviewEdit,
  ReviewRecord,
  SegmentDocument,
  StepRun,
  SuggestParams,
  ResultShow,
  DeliveryOverrides,
  StatusGroup,
  JobPage,
  JobPageQuery,
  ItemOutcome,
} from '@ih/shared';
import type { BridgeError, DeliveryStatus, Receipt } from '@ih/bridge-contract';
import type { ConversionRepo } from '../conversions/repo.js';

/**
 * A reference to save. `templateVersion` pins it to a version (Workbench types) together with the
 * outputs definition its values were verified against; without it the reference is unpinned.
 */
export type NewReference = Omit<
  Reference,
  'id' | 'createdAt' | 'templateVersion' | 'copiedFrom' | 'verifiedOutputs' | 'supersededAt'
> & { templateVersion?: number | null; verifiedOutputs?: unknown };

/** One bridge delivery of a job (`job_deliveries`), as its events last reported it. */
export interface JobDelivery {
  deliveryId: string;
  jobId: string;
  targetId: string;
  status: DeliveryStatus;
  error: BridgeError | null;
  receipt: Receipt | null;
  /** The newest event applied: older or repeated events change nothing. */
  lastSequence: number;
  updatedAt: string;
}

/** How a delivering job ends once every delivery is final. */
export type JobFinish =
  | {
      status: 'succeeded';
      targets: string[];
      /** The finish event's message (default `delivered`): a `decompose` job names its
       * item's outcome. */
      message?: string;
    }
  | {
      status: 'awaiting_review';
      reasons: string[];
      /** A delivery needs a person's connection (none, or refused): the review says so. */
      connectionNeeded?: boolean;
    }
  | { status: 'failed'; error: string };

export interface DeliveryUpdate {
  status: DeliveryStatus;
  error: BridgeError | null;
  receipt: Receipt | null;
  sequence: number;
}

/**
 * The states of a decomposition register entry: `pending` while its delivery is on its way.
 * The row actions (migration 202610252220) leave `detached`, a tombstone the worker's checks
 * treat as absent, and `accepted`, the target's state accepted: the next run is an update.
 */
export type RegisterState =
  'pending' | 'delivered' | 'incomplete' | 'changed' | 'failed' | 'detached' | 'accepted';

/**
 * One delivered (or delivering) document in the decomposition register, scoped to a target's sink
 * and instance (one tenant). The worker writes it `pending` before delivering; the bridge's
 * events settle it.
 */
export interface RegisterEntry {
  id: string;
  sinkId: string;
  instanceId: string | null;
  sourceKey: string;
  contentSha256: string;
  persistentId: string | null;
  state: RegisterState;
  idempotencyKey: string;
  deliveryId: string | null;
  lastReceipt: Receipt | null;
  lastError: BridgeError | null;
  batchId: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  /**
   * The `register_actions` row that detached it (`detached`): the next create of its source
   * takes it into the idempotency key, so the target can't answer with the detached document.
   */
  detachActionId: string | null;
}

/** How a final delivery event settles a pending register entry. */
export interface RegisterSettlement {
  state: Exclude<RegisterState, 'pending' | 'detached' | 'accepted'>;
  /** The persistent id the sink reported; null keeps the entry's (a known id is never cleared). */
  persistentId: string | null;
  /** A receipt with a document; null keeps the entry's last one. */
  receipt: Receipt | null;
  error: BridgeError | null;
  /** The document was delivered: `delivered_at` becomes now. */
  delivered: boolean;
}

/**
 * How settling a register entry settles the conversion item that delivered it (phase 3): its
 * outcome once the bridge's event is final, the detail shown on its row and its link in the
 * target.
 */
export interface ItemSettlement {
  outcome: Extract<
    ItemOutcome,
    'created' | 'updated' | 'changed_in_target' | 'read_back_mismatch' | 'unresolved' | 'failed'
  >;
  detail: string | null;
  link: string | null;
}

/**
 * The item outcomes a register settlement may move: nothing final decided yet, or `failed`,
 * which the worker's last attempt may write after the bridge took the document. The entry is
 * pending for this very delivery, so the delivery's own outcome replaces that failure.
 * `waiting_to_deliver` too: a waited run hands its stored decomposition over while the item
 * still reads waiting, and the bridge's final event may come before it records `delivering`.
 */
export const SETTLEABLE_ITEM: readonly ItemOutcome[] = [
  'queued',
  'decomposing',
  'waiting_to_deliver',
  'delivering',
  'failed',
];

/** The job event a finished delivery writes. */
/**
 * How a job without a document (a background republish) finishes: it has nothing to review, so a
 * delivery that needs a person fails it, naming each target and its reason.
 */
export function backgroundFinish(f: JobFinish): JobFinish {
  return f.status === 'awaiting_review' ? { status: 'failed', error: f.reasons.join('; ') } : f;
}

export function finishEvent(f: JobFinish): { level: string; message: string; data: unknown } {
  if (f.status === 'succeeded') {
    return {
      level: 'info',
      message: f.message ?? DELIVERED_EVENT,
      data: { targets: f.targets },
    };
  }
  if (f.status === 'awaiting_review') {
    return { level: 'warn', message: 'delivery needs review', data: { reasons: f.reasons } };
  }
  return { level: 'error', message: 'delivery failed', data: { error: f.error } };
}

/** Final delivery statuses: the bridge changes them no more. */
export const FINAL_DELIVERY: ReadonlySet<string> = new Set([
  'succeeded',
  'skipped',
  'needs_user',
  'failed',
]);

/** The job event of a job whose deliveries all succeeded. */
export const DELIVERED_EVENT = 'delivered';

/** Segment previews run before other workbench work, still after production (ADR 0007). */
export const SEGMENT_PRIORITY = -5;

export interface SegmentJob {
  id: string;
  projectId: string;
  status: JobStatus;
  /** The last failure: on a queued job with `attempts`, the error it is retried after. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** Claims so far and the most allowed (drafting runs, `listDraftJobs`). */
  attempts?: number;
  maxAttempts?: number;
}

/** jobs.params of a graph preview (worker: graph_preview.GraphPreviewParams). */
export interface GraphJobParams {
  samples: {
    sampleId: string;
    /** The sample's newest succeeded or awaiting-review test run. */
    jobId: string;
    fileName: string;
    sha256: string;
    /** That run's draft `document.json` in the outputs bucket. */
    documentKey: string;
  }[];
  /** The open draft, whose `semantics` the preview renders. */
  definition: Record<string, unknown>;
}

/** jobs.params of a plugin step preview (worker: plugin_preview.PluginPreviewParams). */
export interface PluginJobParams {
  /** The plugin step to run. */
  stepId: string;
  /** The open draft. */
  definition: Record<string, unknown>;
  /** Ready dev samples, read from their prepared text. */
  samples: { sampleId: string; fileName: string; sha256: string }[];
}

/** A document-less project job (segment previews, drafting runs, bundle exports). */
export type ProjectJob = SegmentJob;

/** What the queue estimate reads (GET /api/queue/summary). Document jobs only. */
export interface QueueStats {
  queued: number;
  running: number;
  /** Median seconds of the 50 newest timed runs finished in the last 24 h; null if none. */
  medianSeconds: number | null;
}

/** A job_events row as the API reads it. */
export interface JobEventRecord {
  jobId: string;
  message: string;
  data: unknown;
  at: string;
}

/** jobs.params of a segment job (worker: workbench.SegmentParams). */
export interface SegmentJobParams {
  samples: { sampleId: string; sha256: string }[];
  document: SegmentDocument;
}

export interface NewDocument {
  id: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  specId: string;
  specVersion: number;
  bucket: string;
  objectKey: string;
}

export interface StoredObject {
  bucket: string;
  key: string;
}

/** What a deleted job leaves to clean up in the internal store. */
export interface RemovedJob {
  jobId: string;
  draftObjects: StoredObject[];
  /** The inbox PDF, when no remaining document row or reference needs it. */
  inboxObject: StoredObject | null;
  /**
   * The `withdraw` job queued for what the job delivered (ADR 0011 step 7), else null. Absent
   * for a Workbench project's jobs: test runs, never delivered.
   */
  withdrawJobId?: string | null;
}

/** Background jobs of the linked data (ADR 0011 step 7): withdrawals and republishes. */
export interface WithdrawalStatus {
  queued: number;
  running: number;
  /** Failed, or stopped for review: what they name may still be published. */
  failed: number;
}

/** `withdraw` and `republish` jobs: priority, attempts (a withdrawal retries until it succeeds). */
export const WITHDRAW_JOB = { priority: 0, maxAttempts: 100 } as const;
export const REPUBLISH_JOB = { priority: -10, maxAttempts: 10 } as const;
/** `rebuild`: a copy restore's re-mint of the graphs under this server's base (params `{mode}`). */
export const REBUILD_JOB = { priority: -10, maxAttempts: 10 } as const;

/** `decompose`: one conversion batch item (params `DecomposeParams`), at an upload's priority. */
export const DECOMPOSE_JOB = { priority: 0, maxAttempts: 3 } as const;

/** Document- and project-less jobs the API queues for the worker. */
export type BackgroundTask = 'withdraw' | 'republish' | 'rebuild' | 'decompose';
export const BACKGROUND_JOBS: Record<BackgroundTask, { priority: number; maxAttempts: number }> = {
  withdraw: WITHDRAW_JOB,
  republish: REPUBLISH_JOB,
  rebuild: REBUILD_JOB,
  decompose: DECOMPOSE_JOB,
};

/** One graph of a `withdraw` job's params: its version copies on one publishing target. */
export interface WithdrawnGraph {
  sha256: string;
  templateId: string;
  graphIri: string | null;
  target: string;
  versions: number[];
}

/**
 * A graph's withdrawal, one entry per publishing target its version copies were written to (each
 * is deleted through its own target, with that target's prefix). `current` is the graph's current
 * row when it goes too: its IRI rides on the entry of the target it was published to, so the
 * triple store graph is dropped once.
 */
export function graphWithdrawals(
  graph: { sha256: string; templateId: string },
  versions: { version: number; targetId: string }[],
  current: { graphIri: string; targetId: string } | null,
): WithdrawnGraph[] {
  const byTarget = new Map<string, number[]>();
  for (const v of [...versions].sort((a, b) => a.version - b.version)) {
    byTarget.set(v.targetId, [...(byTarget.get(v.targetId) ?? []), v.version]);
  }
  if (current && !byTarget.has(current.targetId)) byTarget.set(current.targetId, []);
  return [...byTarget.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, vs]) => ({
      sha256: graph.sha256,
      templateId: graph.templateId,
      graphIri: current?.targetId === target ? current.graphIri : null,
      target,
      versions: vs,
    }));
}

export type DeleteJobResult =
  | { result: 'deleted'; removed: RemovedJob }
  | { result: 'not_found' }
  | { result: 'conflict'; status: JobStatus };

export interface RetryOptions {
  model?: string | null;
  specVersion?: number;
  /** Set `params.outputs` (a draft test run's snapshot), keeping the other params. */
  outputs?: unknown;
}

/** Workbench jobs run after production work (jobs.priority; ADR 0007). */
export const WORKBENCH_PRIORITY = -10;

export interface WorkbenchJobOptions {
  projectId: string;
  /** prepare: sample text + OCR only; process: a test run of the project's draft. */
  task: 'prepare' | 'process';
  /** jobs.params, e.g. `{ dataPolicy }`; the worker enforces it (ADR 0007). */
  params?: Record<string, unknown>;
  /** Evaluation run: the reference it is scored against. Default null. */
  referenceId?: string | null;
  /** Every step runs on this alias, e.g. `draft` for reference runs. Default null. */
  modelOverride?: string | null;
  /** Who queued the job. Default null. */
  createdBy?: Creator | null;
}

/** A page of the Jobs list: `JobPageQuery` with `mine` as the signed-in user (`isMine`). */
export type JobPageRequest = Omit<JobPageQuery, 'mine'> & { mine?: Creator };

export interface ListJobsQuery {
  limit: number;
  status?: JobStatus;
  /** Only jobs of this status group (`statusesIn`). */
  group?: StatusGroup;
  /** Only jobs this user queued (the Jobs page's "My jobs"; `isMine`). */
  mine?: Creator;
}

export interface ListPublishedQuery {
  limit: number;
  templateId?: string;
  /** ISO timestamp: only results published strictly before it (millisecond precision). */
  before?: string;
  /** Tie-breaker for `before`: results at exactly `before` with a job id lower than this. */
  beforeId?: string;
  /** Case-insensitive file name substring (matched literally). */
  q?: string;
  /** Reviewed by a person, published without review, or with at least one issue. */
  show?: ResultShow;
}

/** A job's review as references read it (handoff RF1): decision, reviewer and every edit. */
export interface JobReview extends ReviewRecord {
  jobId: string;
  modelOverride: string | null;
}

export interface NewEdit {
  field: string | null;
  table: string | null;
  row: number | null;
  column: string | null;
  oldValue: unknown;
  newValue: unknown;
  editor: string | null;
  reason: string | null;
}

/** Which of a job's events `IngestionRepo.listEvents` reads. */
export interface EventFilter {
  since?: string;
  messages?: { exact?: string[]; prefixes?: string[] };
}

/** Persistence port. `PgRepo` in production, `MemoryRepo` in unit tests. */
export interface IngestionRepo extends ConversionRepo {
  ping(): Promise<void>;
  createDocumentAndJob(
    doc: NewDocument,
    modelOverride: string | null,
    test?: boolean,
    referenceId?: string | null,
    /** jobs.params, e.g. a draft test run's `{ outputs }` snapshot. Default null. */
    params?: Record<string, unknown> | null,
    /** Who queued the job. Default null. */
    createdBy?: Creator | null,
  ): Promise<JobSummary>;
  /** A test job of a workbench project, queued behind production work. */
  createWorkbenchJob(doc: NewDocument, opts: WorkbenchJobOptions): Promise<JobSummary>;
  /** Jobs of a workbench project (prepare jobs and test runs), newest first. */
  listProjectJobs(projectId: string): Promise<JobSummary[]>;
  /**
   * The project's test runs (`process` jobs, still listed once review moves them to `rerun` or
   * `publish`), newest first, each with its document's sha256.
   */
  listProjectRuns(projectId: string): Promise<{ job: JobSummary; sha256: string }[]>;
  /**
   * Queue a segmentation preview for a project (no document). Earlier segment jobs of the project
   * are deleted first (only the latest preview matters); their ids are returned in `removed`.
   */
  createSegmentJob(
    projectId: string,
    params: SegmentJobParams,
  ): Promise<{ job: SegmentJob; removed: string[] }>;
  getSegmentJob(projectId: string, id: string): Promise<SegmentJob | null>;
  /**
   * Queue a graph preview (task 'graph', no document, priority SEGMENT_PRIORITY). Like segment
   * previews, earlier graph jobs of the project are deleted first and returned in `removed`.
   */
  createGraphJob(
    projectId: string,
    params: GraphJobParams,
  ): Promise<{ job: ProjectJob; removed: string[] }>;
  getGraphJob(projectId: string, id: string): Promise<ProjectJob | null>;
  /**
   * Queue a plugin step preview (task 'plugin', no document, priority SEGMENT_PRIORITY), one
   * per project like graph previews: earlier ones are deleted and returned in `removed`.
   */
  createPluginJob(
    projectId: string,
    params: PluginJobParams,
  ): Promise<{ job: ProjectJob; removed: string[] }>;
  getPluginJob(projectId: string, id: string): Promise<ProjectJob | null>;
  /**
   * Queue an ontology suggestion refresh (task 'suggest', no document, priority
   * SEGMENT_PRIORITY). One per project: earlier suggest jobs are deleted and returned in `removed`.
   */
  createSuggestJob(
    projectId: string,
    params: SuggestParams,
  ): Promise<{ job: ProjectJob; removed: string[] }>;
  /** The project's suggest job (there is at most one), with its params. */
  latestSuggestJob(projectId: string): Promise<(ProjectJob & { params: SuggestParams }) | null>;
  /**
   * Queue a drafting run (document-less, task 'draft'). Unlike segment previews, earlier draft
   * jobs are kept: each one backs a proposal.
   */
  createDraftJob(projectId: string, params: Record<string, unknown>): Promise<ProjectJob>;
  /**
   * A document-less `draft` job that is already `succeeded` and so never claimed: the record
   * behind a proposal whose body came from elsewhere (an imported bundle's survey).
   */
  createFinishedDraftJob(projectId: string, params: Record<string, unknown>): Promise<ProjectJob>;
  /** Draft jobs of a project, newest first. */
  listDraftJobs(projectId: string): Promise<ProjectJob[]>;
  /**
   * A queued or running drafting run -> cancelled with `error` as its reason (+ a `cancelled`
   * event). A running worker stops at its next check (before its next model call or turn) and
   * writes nothing more. Null when the project has no such draft job, or it already finished.
   */
  cancelDraftJob(projectId: string, jobId: string, error: string): Promise<ProjectJob | null>;
  /**
   * Queue a bundle export (document-less, task 'export'). One per project: earlier export jobs
   * of the project are deleted first; their ids are returned in `removed` (their zips are the
   * caller's to delete).
   */
  createExportJob(
    projectId: string,
    params: Record<string, unknown>,
  ): Promise<{ job: ProjectJob; removed: string[] }>;
  /** Export jobs of a project, newest first. */
  listExportJobs(projectId: string): Promise<ProjectJob[]>;
  /** Jobs not finished yet (queued, running, awaiting review) whose override is this model. */
  countUnfinishedJobsWithModel(model: string): Promise<number>;
  /** Jobs page listing; prepare jobs are excluded (they belong to the Workbench). */
  listJobs(query: ListJobsQuery): Promise<JobSummary[]>;
  /** One page of the Jobs list, as `pageOfJobs` pages it (`GET /api/jobs/page`). */
  jobPage(query: JobPageRequest): Promise<JobPage>;
  getJob(id: string): Promise<JobDetail | null>;
  /** jobs.params (free-form; null when unset or the job is unknown). */
  getJobParams(id: string): Promise<Record<string, unknown> | null>;
  /** The newest event with each of `messages` for each job (job_events); none: left out. */
  latestEvents(jobIds: string[], messages: readonly string[]): Promise<JobEventRecord[]>;
  /**
   * A job's events, oldest first (job_events): every one, or those at or after `since` whose
   * message is one of `messages.exact` or starts with one of `messages.prefixes`.
   */
  listEvents(
    jobId: string,
    opts?: EventFilter,
  ): Promise<{ message: string; data: unknown; at: string }[]>;
  /** When the job's first `message` event at or after `since` whose data contains `match` came. */
  firstEventAt(
    jobId: string,
    message: string,
    since: string,
    match: Record<string, unknown>,
  ): Promise<string | null>;
  /** Queued and running document jobs, and the median duration of recent timed runs. */
  queueStats(): Promise<QueueStats>;
  /** The job queue is paused (`queue_control`, a restore): no worker claims anything. */
  queuePaused(): Promise<boolean>;
  /** The job's uploaded PDF in the inbox bucket (Jobs "Open PDF"). */
  getDocumentObject(jobId: string): Promise<(StoredObject & { filename: string }) | null>;
  /** Non-test jobs with at least one published output, newest publish first. */
  listPublished(query: ListPublishedQuery): Promise<ResultSummary[]>;
  /** Latest publish time of a job's published outputs (ISO, ms precision); null if none. */
  getPublishedAt(jobId: string): Promise<string | null>;
  /** Re-queue a job in a terminal failure state. Returns null if not found or not retryable. */
  /**
   * Re-queue a job in a terminal failure state. `model`: a ref sets the override, null clears
   * it (spec default), undefined keeps it. `specVersion`: move the job's document to that
   * version (undefined keeps it). Returns null if not found or not retryable.
   */
  retryJob(id: string, opts?: RetryOptions): Promise<JobSummary | null>;
  /** queued/running -> cancelled (+ event). Null if unknown or not cancellable. */
  cancelJob(id: string): Promise<JobSummary | null>;
  /**
   * Delete a finished job (+ its document unless still needed). Storage is the caller's job,
   * except what the job delivered: a `withdraw` job is queued for its published target objects
   * and graph versions, in the same transaction (ADR 0011 step 7).
   */
  deleteJob(id: string): Promise<DeleteJobResult>;
  /**
   * Retiring a type withdraws what it delivered: its jobs' published outputs are marked
   * withdrawn, its current graphs are forgotten, and one `withdraw` job is queued (null when
   * nothing was left to withdraw).
   */
  withdrawType(typeId: string, by: string | null): Promise<string | null>;
  /** Unretiring re-delivers the type's withdrawn outputs: a `republish` job, or null. */
  republishType(typeId: string, by: string | null): Promise<string | null>;
  withdrawalStatus(): Promise<WithdrawalStatus>;
  /**
   * Ids of finished jobs whose updated_at is before `cutoffIso`, oldest first. Regression runs
   * (reference_id set) feed regression scores and metrics, so they're left out unless asked.
   * Prepare jobs and document-less (segment) jobs are never returned (they belong to the Workbench).
   */
  finishedJobIdsBefore(cutoffIso: string, includeRegression?: boolean): Promise<string[]>;
  listModels(): Promise<ModelInfo[]>;

  // --- references and regression runs ---
  /**
   * Throws ReferenceConflictError when the name is taken among live references of the template
   * and version (unpinned references share one namespace). With `templateVersion`, live
   * references of that version for the same PDF (sha256) are superseded first: re-verifying.
   */
  createReference(input: NewReference): Promise<Reference>;
  /** Live references, oldest first; with `version`, those pinned to it or unpinned. */
  listReferences(templateId: string, version?: number): Promise<Reference[]>;
  /** Every reference (superseded and of every version) with its PDF's sha256, newest first. */
  listReferencesWithSha(templateId: string): Promise<(Reference & { sha256: string })[]>;
  /**
   * Copies the live references of the newest earlier version that has any reference row (live or
   * superseded) to `toVersion`, unless `toVersion` already has rows of its own. An emptied
   * version therefore passes on nothing. Idempotent; returns the number of copies.
   */
  carryReferencesForward(templateId: string, toVersion: number): Promise<number>;
  deleteReference(templateId: string, id: string): Promise<boolean>;
  /** Test job of `version` re-running the reference's PDF (new document row, same object). */
  createRegressionJob(
    reference: Reference,
    version: number,
    /** jobs.params, e.g. a draft version's `{ outputs }` snapshot. Default null. */
    params?: Record<string, unknown> | null,
    /** Who queued the run. Default null. */
    createdBy?: Creator | null,
  ): Promise<JobSummary>;
  /** Regression jobs of a template version, newest first. */
  /** The newest regression job per reference for a version (older runs are history). */
  listLatestRegressionJobs(templateId: string, version: number): Promise<JobDetail[]>;

  /** Raw rows behind GET /api/templates/:id/metrics. */
  metricsData(templateId: string): Promise<MetricsData>;

  // --- review (jobs in awaiting_review) ---
  listEdits(jobId: string): Promise<ReviewEdit[]>;
  /**
   * Reviews of several jobs in one call (the References tab's corrections): one entry per
   * existing job, in no particular order; unknown ids are left out, duplicates collapse.
   */
  listJobReviews(jobIds: readonly string[]): Promise<JobReview[]>;
  addEdit(jobId: string, edit: NewEdit): Promise<ReviewEdit>;
  /**
   * awaiting_review -> queued publish task, with the reviewer's name overrides (replacing any
   * from an earlier approval). Null if the job is not awaiting review.
   */
  approve(
    jobId: string,
    reviewer: string | null,
    note: string | null,
    overrides?: DeliveryOverrides,
    /** The signed-in user who approved (null: none, e.g. tests without access). */
    reviewerUserId?: string | null,
  ): Promise<JobSummary | null>;
  /** The name overrides the job's last approval stored (none: `{}`). */
  deliveryOverrides(jobId: string): Promise<DeliveryOverrides>;
  /** Whether the job waits in review for a person's connection (jobs.connection_needed). */
  connectionNeeded(jobId: string): Promise<boolean>;
  listStepRuns(jobId: string): Promise<StepRun[]>;
  /** awaiting_review -> queued rerun task for one step. Null if not awaiting review. */
  requestRerun(jobId: string, step: string, params: RerunRequest): Promise<JobSummary | null>;
  /** awaiting_review -> rejected (final). Null if the job is not awaiting review. */
  reject(jobId: string, reviewer: string | null, reason: string): Promise<JobSummary | null>;
  /** The bridge deliveries a job waits on (the worker writes them; tests and the reconcile too). */
  recordDeliveries(jobId: string, rows: { targetId: string; deliveryId: string }[]): Promise<void>;
  /**
   * One transaction, holding the job's row: records `update` when its sequence is newer than the
   * delivery's last one and the delivery is not final yet (else `stale`: the bridge never moves a
   * final delivery, so a later event is a delayed one the reconcile overtook; `unknown` when
   * there is no such delivery), then asks
   * `finish` about all the job's deliveries; a finish it answers ends the job, only while it is
   * still `delivering` (so it happens once), with a job event.
   */
  applyDeliveryUpdate(
    deliveryId: string,
    update: DeliveryUpdate,
    finish: (deliveries: JobDelivery[], job: { task: string }) => JobFinish | null,
  ): Promise<{ outcome: 'applied' | 'stale' | 'unknown'; finished: JobFinish | null }>;
  deliveriesOf(jobId: string): Promise<JobDelivery[]>;
  /** Deliveries not final and not updated for `olderThanMinutes`, of jobs still delivering. */
  stragglers(olderThanMinutes: number, now: Date): Promise<JobDelivery[]>;
  /**
   * Register entries still `pending` with a delivery, not updated for `olderThanMinutes`: their
   * delivery's final event may have been lost.
   */
  registerStragglers(olderThanMinutes: number, now: Date): Promise<RegisterEntry[]>;
  /**
   * Fails register entries still `pending` without a delivery and not updated for
   * `olderThanMinutes`, with `error`: the worker wrote them and never recorded a delivery (it
   * stopped, or lost the bridge's answer). Returns how many moved.
   */
  expireUnrecordedRegisterEntries(
    olderThanMinutes: number,
    now: Date,
    error: NonNullable<RegisterEntry['lastError']>,
  ): Promise<number>;
  /** The register entry a delivery was made for, if any. */
  registerEntryByDelivery(deliveryId: string): Promise<RegisterEntry | null>;
  /**
   * Settles the register entry of this delivery while it is `pending` (else `stale`: a settled
   * entry is moved only by the worker's next delivery; `unknown` when no entry has this delivery).
   * In the same transaction, the conversion item that made the delivery (the entry's batch and
   * source key) takes `item(entry as it was)` and is linked to the entry, while its outcome is
   * in `SETTLEABLE_ITEM`: whether or not the worker recorded it delivering yet.
   */
  settleRegisterEntry(
    deliveryId: string,
    settlement: RegisterSettlement,
    item: (before: RegisterEntry) => ItemSettlement,
  ): Promise<'applied' | 'stale' | 'unknown'>;
}

export class ReferenceConflictError extends Error {}
