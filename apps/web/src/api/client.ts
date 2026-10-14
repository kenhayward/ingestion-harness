import type {
  OntologyDetail,
  OntologyPatch,
  OntologySummary,
  OntologyVersionView,
  TermDetail,
  TermGroup,
  TermPage,
  Brief,
  BriefBody,
  ChoiceCreateInput,
  ChoicePatchBody,
  BriefVersionView,
  DataPolicy,
  DraftStage,
  EndpointCreateInput,
  EndpointPatchBody,
  EditRequest,
  EvaluationSet,
  FeedbackItem,
  FeedbackTarget,
  PublishGateView,
  ProjectOverview,
  IterationSummary,
  ComparisonView,
  IterationView,
  ExportView,
  JobDetail,
  JobLive,
  JobSummary,
  KeepableStage,
  LlmChoicesView,
  LlmChoiceView,
  LlmEndpointView,
  ModelChoice,
  PreparedText,
  ProjectListPage,
  ProjectListQuery,
  ProposalView,
  Publication,
  ProjectView,
  Reference,
  ReferenceDetail,
  ReferenceRow,
  RerunRequest,
  ResultDetail,
  ResultSummary,
  RevisePreview,
  ReviewEdit,
  Retirement,
  SampleRole,
  SampleView,
  SegmentDocument,
  SegmentationView,
  SpecSummary,
  StageView,
  StepRun,
  QueueSummary,
  TestRun,
  Template,
  TemplateChange,
  SettingsBody,
} from '@ih/shared';

/** document.json written by the worker for template documents. */
export interface ReviewDocument {
  document_id: string;
  page_count?: number;
  fields: Record<string, { value: unknown; evidence: string | null; page: number | null }>;
  tables: Record<string, Record<string, unknown>[]>;
  checks: Record<
    string,
    {
      rows: {
        value: string;
        status: 'match' | 'alias' | 'near' | 'unmatched' | 'unused';
        matched: string | null;
        distance: number | null;
        count: number;
      }[];
    }
  >;
  issues: {
    step: string;
    target: string;
    row: number | null;
    column: string | null;
    raw: unknown;
    message: string;
  }[];
  [key: string]: unknown;
}

export interface ReviewData {
  job: JobDetail;
  template: Template;
  document: ReviewDocument;
  edits: ReviewEdit[];
}

export interface TemplateListItem {
  id: string;
  name: string;
  description: string | null;
  published: number | null;
  draft: number | null;
  /** Set when the document type is retired (hidden from new work); null when it is not. */
  retired: Retirement | null;
  versions: { version: number; status: 'draft' | 'published'; updatedAt: string }[];
  /** Card summary of the version shown (draft first). */
  summary: TemplateSummary;
}

export interface TemplateSummary {
  sections: number;
  fields: number;
  tables: number;
  references: number;
  /** Validation issues of the draft; null when there is no draft. */
  draftIssues: number | null;
  /** Last finished regression of the version shown; matched = references scoring 1. */
  lastRegression: { version: number; matched: number; total: number; at: string } | null;
  /** A regression run of that version is still queued or running (no score yet). */
  regressionRunning: boolean;
}

export interface TemplateRecordView {
  record: {
    id: string;
    version: number;
    status: 'draft' | 'published';
    definition: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    publishedAt: string | null;
  };
  issues: { path: string; message: string }[];
}

export interface RegressionReport {
  items: {
    reference: { id: string; name: string };
    job: { id: string; status: string; error: string | null } | null;
    comparison: {
      score: number;
      fields: { id: string; expected: unknown; actual: unknown; match: boolean }[];
      tables: {
        id: string;
        expected: number;
        actual: number;
        matched: number;
        missing: Record<string, unknown>[];
        extra: Record<string, unknown>[];
        changed?: {
          expected: Record<string, unknown>;
          actual: Record<string, unknown>;
          columns: string[];
        }[];
        cells?: number;
        cellsTotal?: number;
      }[];
    } | null;
  }[];
  summary: { references: number; completed: number; averageScore: number | null };
}

/** GET /api/templates/:id/metrics (see apps/api/src/metrics.ts). */
export interface TemplateMetrics {
  templateId: string;
  versions: {
    version: number;
    jobs: number;
    testJobs: number;
    byStatus: Record<string, number>;
    reviewed: number;
    reviewRate: number | null;
    editsPerReviewed: number | null;
    avgProcessingSeconds: number | null;
  }[];
  steps: {
    stepId: string;
    runs: number;
    reruns: number;
    failures: number;
    avgAttempts: number;
    avgOutputTokens: number | null;
    avgSeconds: number | null;
  }[];
  topEdited: { target: string; edits: number }[];
}

export interface VersionDiff {
  from: number;
  to: number;
  changes: {
    kind: 'added' | 'removed' | 'changed';
    path: string;
    before?: unknown;
    after?: unknown;
  }[];
}

export interface UploadRequest {
  file: File;
  specId: string;
  specVersion?: number;
  model?: string;
}

export interface OutputUrlOptions {
  stage?: 'draft' | 'published';
  /** Serve with content-disposition inline (previews) instead of attachment. */
  inline?: boolean;
}

export function outputPath(
  base: string,
  jobId: string,
  outputId: string,
  opts: OutputUrlOptions = {},
): string {
  const params = new URLSearchParams();
  if (opts.stage) params.set('stage', opts.stage);
  if (opts.inline) params.set('inline', '1');
  const qs = params.toString();
  return `${base}/jobs/${jobId}/outputs/${outputId}${qs ? `?${qs}` : ''}`;
}

export interface CleanupRequest {
  olderThanDays: number;
  dryRun: boolean;
  /** Regression runs feed scores and metrics: kept unless included. */
  includeRegression: boolean;
  /** The preview's cutoff, so the delete matches what was previewed. */
  cutoff?: string;
}

export interface CleanupResult {
  /** dryRun: how many jobs match. */
  count?: number;
  /** delete: how many this request deleted, and how many still match. */
  deleted?: number;
  remaining?: number;
  cutoff: string;
}

/** API port — components take this as a prop so tests can pass a fake. */
export interface JobWatchHandlers {
  update(live: JobLive): void;
  gone(): void;
  error(): void;
}

/** Fields of an ontology import; a new ontology needs `label`. */
export interface OntologyImportFields {
  id: string;
  label?: string;
  description?: string;
  tags?: string[];
  localOnly?: boolean;
}

/** One page of an ontology version's terms (`root` or `parent` for the tree, `q` to search). */
export interface OntologyTermQuery {
  group?: TermGroup;
  q?: string;
  parent?: string;
  root?: boolean;
  offset?: number;
  limit?: number;
}

export interface Api {
  /** Current session, or null when not signed in (401). */
  me(): Promise<Me | null>;
  /** Exchange an access token for a session cookie. Rejects with an ApiError (401/429). */
  login(token: string): Promise<Me>;
  logout(): Promise<void>;
  /** Called when any API call answers 401 (session ended). Returns an unsubscribe. */
  onUnauthorized(listener: () => void): () => void;
  listTokens(): Promise<AccessToken[]>;
  /**
   * A new token: the plaintext `token` is only ever returned here. Admin tokens must expire
   * (the API refuses `null`).
   */
  createToken(
    label: string,
    expiresInDays: number | null,
    role: AccessToken['role'],
  ): Promise<{ token: string; record: AccessToken }>;
  revokeToken(id: string): Promise<void>;
  deleteToken(id: string): Promise<void>;
  /** Read-only S3 keys for the data lake (ADR 0008). Rejects with a 404 ApiError when off. */
  listS3Keys(): Promise<S3KeysOverview>;
  /** A new consumer and key: `secretAccessKey` is only ever returned here and by rotate. */
  createS3Key(label: string, expiresInDays: number | null): Promise<IssuedS3Key>;
  /** Another key for the consumer; its other active keys expire within `graceDays`. */
  rotateS3Key(
    consumerId: string,
    expiresInDays: number | null,
    graceDays: number,
  ): Promise<IssuedS3Key>;
  revokeS3Key(keyId: string): Promise<void>;
  deleteS3Consumer(consumerId: string): Promise<void>;
  /** LLM endpoints and their models (admins; ADR 0010). */
  listLlmEndpoints(): Promise<LlmEndpointView[]>;
  /** The ontology library (ADR 0011); retired ontologies only when asked. */
  listOntologies(opts?: { retired?: boolean }): Promise<OntologySummary[]>;
  /** One ontology with every version, newest first. */
  getOntology(id: string): Promise<OntologyDetail>;
  /** Admin: import a file as the next version of `fields.id`. */
  importOntology(file: File, fields: OntologyImportFields): Promise<OntologyVersionView>;
  /** Admin: name, description, tags, local only, retired. */
  updateOntology(id: string, patch: OntologyPatch): Promise<OntologySummary>;
  /** Admin: delete a version that is ready or failed. */
  deleteOntologyVersion(id: string, version: number): Promise<void>;
  /** Tree levels, search hits. */
  listOntologyTerms(id: string, version: number, query: OntologyTermQuery): Promise<TermPage>;
  /** One term with its neighbours. */
  getOntologyTerm(id: string, version: number, iri: string): Promise<TermDetail>;
  createLlmEndpoint(body: EndpointCreateInput): Promise<LlmEndpointView>;
  /** `apiKey`: a new key (stored encrypted), or null to remove the stored one. */
  updateLlmEndpoint(name: string, patch: EndpointPatchBody): Promise<LlmEndpointView>;
  /** Exactly these models are offered in the pickers. */
  setLlmEndpointModels(name: string, models: string[]): Promise<LlmEndpointView>;
  deleteLlmEndpoint(name: string): Promise<void>;
  /** Asks the workers to list every endpoint's models now (suggestions appear shortly). */
  discoverLlmEndpoint(name: string): Promise<void>;
  /** Model choices and pipeline settings (admins; ADR 0010 phase 4b). */
  listModelChoices(): Promise<LlmChoicesView>;
  createModelChoice(body: ChoiceCreateInput): Promise<LlmChoiceView>;
  updateModelChoice(id: string, patch: ChoicePatchBody): Promise<LlmChoiceView>;
  deleteModelChoice(id: string): Promise<void>;
  setLlmSettings(body: SettingsBody): Promise<LlmChoicesView>;
  /** Document types for upload; `retired: 'include'` lists retired ones too (old jobs' names). */
  listSpecs(options?: { retired?: 'include' }): Promise<SpecSummary[]>;
  /** Admins: retire a document type (all its versions). Unretiring is API-only (D14). */
  retireType(id: string): Promise<{ id: string; retired: Retirement }>;
  /** The model choices every picker offers, the default first (ADR 0010, phase 4c). */
  listPickerChoices(): Promise<ModelChoice[]>;
  /** mine: only the jobs the signed-in token queued (`?mine=1`, matched by its label). */
  listJobs(opts?: { mine?: boolean }): Promise<JobSummary[]>;
  getJob(id: string): Promise<JobDetail>;
  /**
   * Follow a job live (Server-Sent Events, `GET /api/jobs/:id/events`): `update` on every change
   * until it leaves queued and running, `gone` once deleted, `error` when the stream is not
   * available (the caller polls instead). Returns stop.
   */
  watchJob(id: string, on: JobWatchHandlers): () => void;
  /** model: a ref to retry with, or null for the spec default (clears the override). */
  retryJob(id: string, model?: string | null): Promise<JobSummary>;
  cancelJob(id: string): Promise<JobSummary>;
  deleteJob(id: string): Promise<void>;
  /** Bulk delete of finished jobs (see CleanupRequest); repeat while `remaining` > 0. */
  cleanupJobs(req: CleanupRequest): Promise<CleanupResult>;
  upload(req: UploadRequest): Promise<JobSummary>;
  outputUrl(jobId: string, outputId: string, opts?: OutputUrlOptions): string;
  /** Published or draft output body as text (Results previews). Rejects with the API error. */
  getOutputText(jobId: string, outputId: string, stage: 'draft' | 'published'): Promise<string>;
  listResults(query?: {
    templateId?: string;
    /** File name substring (case-insensitive). */
    q?: string;
    before?: string;
    beforeId?: string;
  }): Promise<ResultSummary[]>;
  getResult(jobId: string): Promise<ResultDetail>;
  getReview(jobId: string): Promise<ReviewData>;
  addEdit(jobId: string, edit: EditRequest): Promise<ReviewEdit>;
  approve(jobId: string, body: { reviewer?: string; note?: string }): Promise<JobSummary>;
  reject(jobId: string, body: { reviewer?: string; reason: string }): Promise<JobSummary>;
  pageUrl(jobId: string, page: number): string;
  /** The job's uploaded PDF, served inline (Open PDF). */
  documentUrl(jobId: string): string;
  /** Every published output of a result as one ZIP download. */
  archiveUrl(jobId: string): string;
  getStepRuns(jobId: string): Promise<StepRun[]>;
  rerunStep(jobId: string, stepId: string, body: RerunRequest): Promise<JobSummary>;
  getMetrics(templateId: string): Promise<TemplateMetrics>;
  listReferences(templateId: string, version?: number): Promise<Reference[]>;
  createReference(templateId: string, jobId: string, name: string): Promise<Reference>;
  deleteReference(templateId: string, referenceId: string): Promise<void>;
  runRegression(templateId: string, version: number): Promise<{ jobs: JobSummary[] }>;
  getRegression(templateId: string, version: number): Promise<RegressionReport>;
  diffVersions(templateId: string, from: number, to: number): Promise<VersionDiff>;
  listTemplates(): Promise<TemplateListItem[]>;
  createTemplate(id: string, name: string): Promise<TemplateRecordView>;
  getTemplate(id: string, version: number): Promise<TemplateRecordView>;
  /** `baseUpdatedAt`: the version's `updatedAt` the edit started from (409 when it moved). */
  saveTemplate(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    baseUpdatedAt?: string,
  ): Promise<TemplateRecordView>;
  publishTemplate(id: string, version: number): Promise<TemplateRecordView>;
  newDraft(id: string, from: number): Promise<TemplateRecordView>;
  deleteDraft(id: string, version: number): Promise<void>;
  importTemplate(yaml: string, publish: boolean): Promise<TemplateRecordView>;
  exportUrl(id: string, version: number): string;
  /** Upload a sample against a (draft) version as a test run (never published). */
  /** `model`: a model choice's id for every step; null or absent: the template's models. */
  testRun(file: File, id: string, version: number, model?: string | null): Promise<JobSummary>;
  // --- workbench (ADR 0007) ---
  /** One page of the project list; only the params that are set are sent. */
  listProjectPage(
    query: Partial<Omit<ProjectListQuery, 'ids'>> & { ids?: string[] },
  ): Promise<ProjectListPage>;
  /** Ids of the projects the caller pinned. */
  listPins(): Promise<string[]>;
  pin(projectId: string): Promise<void>;
  unpin(projectId: string): Promise<void>;
  /** New project; omit `name` to open an existing document type. */
  createProject(id: string, name?: string): Promise<ProjectView>;
  /** Rejects with an ApiError (404 when there is no project yet). */
  getProject(id: string): Promise<ProjectView>;
  /** Deletes a project whose type was never published (409 otherwise). */
  deleteProject(id: string): Promise<void>;
  setDataPolicy(projectId: string, dataPolicy: DataPolicy): Promise<ProjectView>;
  /** Queue the project's drafting bundle (replaces its previous export). */
  startExport(projectId: string): Promise<ExportView>;
  listExports(projectId: string): Promise<ExportView[]>;
  exportBundleUrl(projectId: string, jobId: string): string;
  /** Import a bundle as a new local project; `id`/`name` default to the manifest's. */
  importBundle(file: File, fields: { id?: string; name?: string }): Promise<ProjectView>;
  startStage(projectId: string, stage: DraftStage): Promise<ProposalView>;
  listProposals(projectId: string): Promise<ProposalView[]>;
  decideProposal(
    projectId: string,
    proposalId: string,
    decision: 'accepted' | 'rejected',
    /** Indexes of the changes to apply (outputs/sections/steps); omitted = all. */
    changes?: number[],
  ): Promise<ProposalView>;
  skipStage(projectId: string, stage: DraftStage): Promise<StageView[]>;
  /** Keep a stale stage as it is (handoff SC1): no new proposal, the draft is unchanged. */
  confirmStage(projectId: string, stage: KeepableStage): Promise<StageView[]>;
  /** Reference rows for the dev samples, or (set = 'holdout') the holdout samples. */
  listReferenceRows(projectId: string, set?: EvaluationSet): Promise<ReferenceRow[]>;
  /** One sample's reference with each output's provenance (handoff RF2). */
  getReferenceDetail(projectId: string, sampleId: string): Promise<ReferenceDetail>;
  /** Queue draft-model runs on unverified dev samples. */
  proposeReferences(projectId: string): Promise<JobSummary[]>;
  /** `uncached` makes every step call its model (the step cache is not read). */
  startEvaluation(
    projectId: string,
    /** A model choice's id; null: the recipe's own models. */
    model: string | null,
    options?: { uncached?: boolean; set?: EvaluationSet },
  ): Promise<IterationView>;
  /** Queue template runs on unverified holdout samples. */
  startHoldoutReferenceRuns(projectId: string): Promise<JobSummary[]>;
  /** One sample's reference run again, to re-verify it (dev: the drafting model; holdout: the template's). */
  runSampleReference(projectId: string, sampleId: string): Promise<JobSummary[]>;
  setPublishThreshold(projectId: string, threshold: number): Promise<ProjectView>;
  getPublishGate(projectId: string): Promise<PublishGateView>;
  /** Rail, header and Overview tab in one call (Workbench redesign W2). */
  getProjectOverview(projectId: string): Promise<ProjectOverview>;
  /** Rejects with an ApiError (409, the gate reason) below the threshold without an override. */
  publish(
    projectId: string,
    overrideReason?: string,
  ): Promise<{ publication: Publication; project: ProjectView }>;
  listPublications(projectId: string): Promise<Publication[]>;
  /** Evaluate the draft on every comparison model at once. */
  /** `models`: the choices to compare, in order (absent: every one the project may use). */
  startComparison(
    projectId: string,
    options?: { uncached?: boolean; models?: string[] },
  ): Promise<ComparisonView>;
  getComparison(projectId: string, groupId: string): Promise<ComparisonView>;
  listIterations(projectId: string): Promise<IterationSummary[]>;
  getIteration(projectId: string, iterationId: string): Promise<IterationView>;
  restoreIteration(projectId: string, iterationId: string): Promise<ProjectView>;
  listFeedback(projectId: string): Promise<FeedbackItem[]>;
  addFeedback(
    projectId: string,
    body: {
      target: FeedbackTarget;
      targetId: string;
      body: string;
      sampleId?: string;
      iterationId?: string;
    },
  ): Promise<FeedbackItem>;
  deleteFeedback(projectId: string, feedbackId: string): Promise<void>;
  /** RV1: exactly what the next revision would send, and what it never sends. */
  getRevisePreview(projectId: string): Promise<RevisePreview>;
  listStages(projectId: string): Promise<StageView[]>;
  listSamples(projectId: string): Promise<SampleView[]>;
  uploadSample(projectId: string, file: File, role: SampleRole): Promise<SampleView>;
  setSampleRole(projectId: string, sampleId: string, role: SampleRole): Promise<SampleView>;
  removeSample(projectId: string, sampleId: string): Promise<void>;
  getSampleText(projectId: string, sampleId: string): Promise<PreparedText>;
  saveBrief(projectId: string, body: BriefBody): Promise<Brief>;
  listBriefVersions(projectId: string): Promise<BriefVersionView[]>;
  /** TP1: the open draft's change log, newest first. */
  listDraftChanges(projectId: string): Promise<TemplateChange[]>;
  getBriefVersion(projectId: string, version: number): Promise<Brief>;
  /**
   * Test-run the open draft on the ready dev samples (handoff TR1): `sampleIds` picks some (all
   * when absent); `model` is a model choice's id for every step (null or absent: the template's).
   */
  runDevTests(
    projectId: string,
    opts?: { model?: string | null; sampleIds?: string[] },
  ): Promise<{ jobs: JobSummary[] }>;
  /** The project's jobs except preparation, with batches and live step progress (TR2, TR3). */
  listTestRuns(projectId: string): Promise<TestRun[]>;
  /** The queue a new run waits behind, with a rough wait (TR4). */
  getQueueSummary(): Promise<QueueSummary>;
  /** Preview anchors over the prepared samples; omit `document` to use the draft's. */
  startSegmentation(projectId: string, document?: SegmentDocument): Promise<SegmentationView>;
  getSegmentation(projectId: string, jobId: string): Promise<SegmentationView>;
}

/** An access token as listed to admins (never the token itself). */
export interface AccessToken {
  id: string;
  label: string;
  role: 'admin' | 'user';
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** The label of the session that issued it; null for the admin token from the log. */
  issuedBy: string | null;
  status: 'active' | 'expired' | 'revoked' | 'current-admin';
}

/** An S3 access key as listed to admins (never its secret). */
export interface S3Key {
  id: string;
  accessKeyId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

/** A data-lake consumer (one SeaweedFS user) and its keys, newest first. */
export interface S3Consumer {
  id: string;
  label: string;
  userName: string;
  createdAt: string;
  keys: S3Key[];
}

/** What the lake is configured with besides a key pair; `endpoint` null = not configured. */
export interface S3KeysOverview {
  bucket: string;
  endpoint: string | null;
  consumers: S3Consumer[];
}

export interface IssuedS3Key {
  consumer: S3Consumer;
  key: S3Key;
  secretAccessKey: string;
  bucket: string;
  endpoint: string | null;
}

/** Signed-in identity (GET /api/auth/me). */
export interface Me {
  role: 'admin' | 'user';
  label: string;
  expiresAt: string | null;
}

const unauthorizedListeners = new Set<() => void>();

/** 401s that mean "not signed in yet / wrong token", not "your session ended". */
const SIGN_IN_CALLS = ['/auth/login', '/auth/me'];

/**
 * fetch for API calls: a 401 from any other call (token management included) means the session
 * ended (expired, revoked, admin token rotated), so listeners can send the user back to sign-in.
 */
const apiFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = String(input);
  if (res.status === 401 && !SIGN_IN_CALLS.some((path) => url.endsWith(path))) {
    for (const listener of unauthorizedListeners) listener();
  }
  return res;
};

/** An API error carrying its HTTP status (e.g. 401, 429 on sign-in). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      body.error ? String(body.error) : `${res.status} ${res.statusText}`,
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

/** For 204 responses: throws the API error like json() does. */
async function noContent(response: Promise<Response>): Promise<void> {
  const res = await response;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      body.error ? String(body.error) : `${res.status} ${res.statusText}`,
      res.status,
    );
  }
}

function post<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
  return apiFetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<T>);
}

export function createHttpApi(base = '/api'): Api {
  return {
    me: async () => {
      const res = await apiFetch(`${base}/auth/me`);
      return res.status === 401 ? null : json<Me>(res);
    },
    login: (token) => post<Me>(`${base}/auth/login`, { token }),
    logout: async () => {
      await apiFetch(`${base}/auth/logout`, { method: 'POST' });
    },
    listTokens: () => apiFetch(`${base}/auth/tokens`).then(json<AccessToken[]>),
    createToken: (label, expiresInDays, role) =>
      post<{ token: string; record: AccessToken }>(`${base}/auth/tokens`, {
        label,
        expiresInDays,
        role,
      }),
    revokeToken: async (id) => {
      await noContent(apiFetch(`${base}/auth/tokens/${id}/revoke`, { method: 'POST' }));
    },
    deleteToken: async (id) => {
      await noContent(apiFetch(`${base}/auth/tokens/${id}`, { method: 'DELETE' }));
    },
    listLlmEndpoints: () => apiFetch(`${base}/llm/endpoints`).then(json<LlmEndpointView[]>),
    listOntologies: (opts = {}) =>
      apiFetch(`${base}/ontologies${opts.retired ? '?retired=include' : ''}`).then(
        json<OntologySummary[]>,
      ),
    getOntology: (id) =>
      apiFetch(`${base}/ontologies/${encodeURIComponent(id)}`).then(json<OntologyDetail>),
    importOntology: (file, fields) => {
      const form = new FormData();
      // Fields precede the file part: the API reads them from the file's preamble.
      form.append('id', fields.id);
      if (fields.label) form.append('label', fields.label);
      if (fields.description) form.append('description', fields.description);
      if (fields.tags?.length) form.append('tags', fields.tags.join(','));
      if (fields.localOnly) form.append('localOnly', 'true');
      form.append('file', file);
      return apiFetch(`${base}/ontologies`, { method: 'POST', body: form }).then(
        json<OntologyVersionView>,
      );
    },
    updateOntology: (id, patch) =>
      post<OntologySummary>(`${base}/ontologies/${encodeURIComponent(id)}`, patch, 'PATCH'),
    deleteOntologyVersion: (id, version) =>
      noContent(
        apiFetch(`${base}/ontologies/${encodeURIComponent(id)}/versions/${version}`, {
          method: 'DELETE',
        }),
      ),
    listOntologyTerms: (id, version, query) => {
      const params = new URLSearchParams();
      if (query.group) params.set('group', query.group);
      if (query.q) params.set('q', query.q);
      if (query.parent) params.set('parent', query.parent);
      if (query.root) params.set('root', '1');
      if (query.offset) params.set('offset', String(query.offset));
      if (query.limit) params.set('limit', String(query.limit));
      const qs = params.toString();
      return apiFetch(
        `${base}/ontologies/${encodeURIComponent(id)}/versions/${version}/terms${qs ? `?${qs}` : ''}`,
      ).then(json<TermPage>);
    },
    getOntologyTerm: (id, version, iri) =>
      apiFetch(
        `${base}/ontologies/${encodeURIComponent(id)}/versions/${version}/term?iri=${encodeURIComponent(iri)}`,
      ).then(json<TermDetail>),
    createLlmEndpoint: (body) => post<LlmEndpointView>(`${base}/llm/endpoints`, body),
    updateLlmEndpoint: (name, patch) =>
      post<LlmEndpointView>(`${base}/llm/endpoints/${encodeURIComponent(name)}`, patch, 'PATCH'),
    setLlmEndpointModels: (name, models) =>
      post<LlmEndpointView>(
        `${base}/llm/endpoints/${encodeURIComponent(name)}/models`,
        { models },
        'PUT',
      ),
    deleteLlmEndpoint: (name) =>
      noContent(
        apiFetch(`${base}/llm/endpoints/${encodeURIComponent(name)}`, { method: 'DELETE' }),
      ),
    discoverLlmEndpoint: (name) =>
      noContent(
        apiFetch(`${base}/llm/endpoints/${encodeURIComponent(name)}/discover`, { method: 'POST' }),
      ),
    listModelChoices: () => apiFetch(`${base}/llm/choices`).then(json<LlmChoicesView>),
    createModelChoice: (body) => post<LlmChoiceView>(`${base}/llm/choices`, body),
    updateModelChoice: (id, patch) =>
      post<LlmChoiceView>(`${base}/llm/choices/${encodeURIComponent(id)}`, patch, 'PATCH'),
    deleteModelChoice: (id) =>
      noContent(apiFetch(`${base}/llm/choices/${encodeURIComponent(id)}`, { method: 'DELETE' })),
    setLlmSettings: (body) => post<LlmChoicesView>(`${base}/llm/settings`, body, 'PUT'),
    listS3Keys: () => apiFetch(`${base}/access/s3-keys`).then(json<S3KeysOverview>),
    createS3Key: (label, expiresInDays) =>
      post<IssuedS3Key>(`${base}/access/s3-keys`, { label, expiresInDays }),
    rotateS3Key: (consumerId, expiresInDays, graceDays) =>
      post<IssuedS3Key>(`${base}/access/s3-keys/${consumerId}/rotate`, {
        expiresInDays,
        graceDays,
      }),
    revokeS3Key: async (keyId) => {
      await noContent(apiFetch(`${base}/access/s3-keys/keys/${keyId}/revoke`, { method: 'POST' }));
    },
    deleteS3Consumer: async (consumerId) => {
      await noContent(apiFetch(`${base}/access/s3-keys/${consumerId}`, { method: 'DELETE' }));
    },
    onUnauthorized: (listener) => {
      unauthorizedListeners.add(listener);
      return () => unauthorizedListeners.delete(listener);
    },
    listSpecs: (options) =>
      apiFetch(`${base}/specs${options?.retired ? `?retired=${options.retired}` : ''}`).then(
        json<SpecSummary[]>,
      ),
    retireType: (id) =>
      post<{ id: string; retired: Retirement }>(
        `${base}/specs/${encodeURIComponent(id)}/retirement`,
        {},
        'PUT',
      ),
    listPickerChoices: () =>
      apiFetch(`${base}/models/choices`)
        .then(json<{ choices: ModelChoice[] }>)
        .then((r) => r.choices),
    listJobs: (opts) =>
      apiFetch(`${base}/jobs${opts?.mine ? '?mine=1' : ''}`).then(json<JobSummary[]>),
    getJob: (id) => apiFetch(`${base}/jobs/${id}`).then(json<JobDetail>),
    watchJob: (id, on) => watchJobEvents(`${base}/jobs/${id}/events`, on),
    retryJob: (id, model) =>
      post<JobSummary>(`${base}/jobs/${id}/retry`, model === undefined ? {} : { model }),
    cancelJob: (id) => post<JobSummary>(`${base}/jobs/${id}/cancel`, {}),
    deleteJob: async (id) => {
      const res = await apiFetch(`${base}/jobs/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ? String(body.error) : `${res.status} ${res.statusText}`);
      }
    },
    cleanupJobs: (req) => post<CleanupResult>(`${base}/jobs/cleanup`, req),
    upload: ({ file, specId, specVersion, model }) => {
      // Fields must precede the file part — the API reads them from the file's preamble.
      const form = new FormData();
      form.append('specId', specId);
      if (specVersion !== undefined) form.append('specVersion', String(specVersion));
      if (model) form.append('model', model);
      form.append('file', file);
      return apiFetch(`${base}/documents`, { method: 'POST', body: form }).then(json<JobSummary>);
    },
    createProject: (id, name) =>
      post<ProjectView>(`${base}/workbench/projects`, name ? { id, name } : { id }),
    getProject: (id) => apiFetch(`${base}/workbench/projects/${id}`).then(json<ProjectView>),
    listProjectPage: (query) => {
      const params = new URLSearchParams();
      if (query.q) params.set('q', query.q);
      if (query.filter) params.set('filter', query.filter);
      if (query.phase) params.set('phase', query.phase);
      if (query.policy) params.set('policy', query.policy);
      if (query.retired) params.set('retired', query.retired);
      if (query.sort) params.set('sort', query.sort);
      if (query.ids?.length) params.set('ids', query.ids.join(','));
      if (query.page) params.set('page', String(query.page));
      if (query.size) params.set('size', String(query.size));
      const qs = params.toString();
      return apiFetch(`${base}/workbench/projects${qs ? `?${qs}` : ''}`).then(
        json<ProjectListPage>,
      );
    },
    listPins: () => apiFetch(`${base}/workbench/pins`).then(json<string[]>),
    pin: (id) =>
      noContent(apiFetch(`${base}/workbench/pins/${encodeURIComponent(id)}`, { method: 'PUT' })),
    unpin: (id) =>
      noContent(apiFetch(`${base}/workbench/pins/${encodeURIComponent(id)}`, { method: 'DELETE' })),
    deleteProject: (id) =>
      noContent(apiFetch(`${base}/workbench/projects/${id}`, { method: 'DELETE' })),
    startExport: (id) => post<ExportView>(`${base}/workbench/projects/${id}/export`, {}),
    listExports: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/exports`).then(json<ExportView[]>),
    exportBundleUrl: (id, jobId) => `${base}/workbench/projects/${id}/exports/${jobId}/bundle`,
    importBundle: (file, fields) => {
      // Fields must precede the file part — the API reads them from the file's preamble.
      const form = new FormData();
      if (fields.id) form.append('id', fields.id);
      if (fields.name) form.append('name', fields.name);
      form.append('bundle', file);
      return apiFetch(`${base}/workbench/projects/import`, { method: 'POST', body: form }).then(
        async (res) => {
          // A proxy in front of the API (nginx, NGINX Proxy Manager) refuses with its own page.
          if (res.status === 413) {
            const body: unknown = await res
              .clone()
              .json()
              .catch(() => null);
            if (body === null || typeof body !== 'object') {
              throw new ApiError('bundle too large for the proxy', 413);
            }
          }
          return json<ProjectView>(res);
        },
      );
    },
    setDataPolicy: (id, dataPolicy) =>
      post<ProjectView>(`${base}/workbench/projects/${id}/data-policy`, { dataPolicy }, 'PUT'),
    startStage: (id, stage) =>
      post<ProposalView>(`${base}/workbench/projects/${id}/stages/${stage}`, {}),
    listProposals: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/proposals`).then(json<ProposalView[]>),
    decideProposal: (id, proposalId, decision, changes) =>
      post<ProposalView>(
        `${base}/workbench/projects/${id}/proposals/${proposalId}/decision`,
        changes ? { decision, changes } : { decision },
      ),
    skipStage: (id, stage) =>
      post<StageView[]>(`${base}/workbench/projects/${id}/stages/${stage}/skip`, {}),
    confirmStage: (id, stage) =>
      post<StageView[]>(`${base}/workbench/projects/${id}/stages/${stage}/confirm`, {}),
    listReferenceRows: (id, set) =>
      apiFetch(
        `${base}/workbench/projects/${id}/references${set === 'holdout' ? '?set=holdout' : ''}`,
      ).then(json<ReferenceRow[]>),
    getReferenceDetail: (id, sid) =>
      apiFetch(`${base}/workbench/projects/${id}/references/${sid}`).then(json<ReferenceDetail>),
    proposeReferences: (id) =>
      post<{ jobs: JobSummary[] }>(`${base}/workbench/projects/${id}/stages/references`, {}).then(
        (r) => r.jobs,
      ),
    startEvaluation: (id, model, options) =>
      post<IterationView>(`${base}/workbench/projects/${id}/evaluations`, {
        ...(model ? { model } : {}),
        ...(options?.uncached ? { uncached: true } : {}),
        ...(options?.set === 'holdout' ? { set: 'holdout' } : {}),
      }),
    startHoldoutReferenceRuns: (id) =>
      post<{ jobs: JobSummary[] }>(
        `${base}/workbench/projects/${id}/holdout/reference-runs`,
        {},
      ).then((r) => r.jobs),
    runSampleReference: (id, sampleId) =>
      post<{ jobs: JobSummary[] }>(
        `${base}/workbench/projects/${id}/references/${sampleId}/run`,
        {},
      ).then((r) => r.jobs),
    setPublishThreshold: (id, publishThreshold) =>
      post<ProjectView>(`${base}/workbench/projects/${id}`, { publishThreshold }, 'PATCH'),
    getPublishGate: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/publish-gate`).then(json<PublishGateView>),
    getProjectOverview: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/overview`).then(json<ProjectOverview>),
    publish: (id, overrideReason) =>
      post<{ publication: Publication; project: ProjectView }>(
        `${base}/workbench/projects/${id}/publish`,
        overrideReason ? { overrideReason } : {},
      ),
    listPublications: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/publications`).then(json<Publication[]>),
    startComparison: (id, options) =>
      post<ComparisonView>(`${base}/workbench/projects/${id}/evaluations/compare`, {
        ...(options?.models ? { models: options.models } : {}),
        ...(options?.uncached ? { uncached: true } : {}),
      }),
    getComparison: (id, groupId) =>
      apiFetch(`${base}/workbench/projects/${id}/comparisons/${groupId}`).then(
        json<ComparisonView>,
      ),
    listIterations: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/iterations`).then(json<IterationSummary[]>),
    getIteration: (id, iid) =>
      apiFetch(`${base}/workbench/projects/${id}/iterations/${iid}`).then(json<IterationView>),
    listFeedback: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/feedback`).then(json<FeedbackItem[]>),
    addFeedback: (id, body) =>
      post<FeedbackItem>(`${base}/workbench/projects/${id}/feedback`, body),
    deleteFeedback: (id, fid) =>
      noContent(apiFetch(`${base}/workbench/projects/${id}/feedback/${fid}`, { method: 'DELETE' })),
    getRevisePreview: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/stages/revise/preview`).then(json<RevisePreview>),
    restoreIteration: (id, iid) =>
      post<ProjectView>(`${base}/workbench/projects/${id}/iterations/${iid}/restore`, {}),
    listStages: (id) => apiFetch(`${base}/workbench/projects/${id}/stages`).then(json<StageView[]>),
    listSamples: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/samples`).then(json<SampleView[]>),
    uploadSample: (id, file, role) => {
      const form = new FormData();
      form.append('role', role); // fields before the file part
      form.append('file', file);
      return apiFetch(`${base}/workbench/projects/${id}/samples`, {
        method: 'POST',
        body: form,
      }).then(json<SampleView>);
    },
    setSampleRole: (id, sampleId, role) =>
      post<SampleView>(`${base}/workbench/projects/${id}/samples/${sampleId}`, { role }, 'PATCH'),
    removeSample: (id, sampleId) =>
      noContent(
        apiFetch(`${base}/workbench/projects/${id}/samples/${sampleId}`, { method: 'DELETE' }),
      ),
    getSampleText: (id, sampleId) =>
      apiFetch(`${base}/workbench/projects/${id}/samples/${sampleId}/text`).then(
        json<PreparedText>,
      ),
    saveBrief: (id, body) => post<Brief>(`${base}/workbench/projects/${id}/brief`, body, 'PUT'),
    listDraftChanges: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/draft/changes`).then(json<TemplateChange[]>),
    listBriefVersions: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/briefs`).then(json<BriefVersionView[]>),
    getBriefVersion: (id, version) =>
      apiFetch(`${base}/workbench/projects/${id}/briefs/${version}`).then(json<Brief>),
    runDevTests: (id, opts) =>
      post<{ jobs: JobSummary[] }>(`${base}/workbench/projects/${id}/test-runs`, {
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.sampleIds ? { sampleIds: opts.sampleIds } : {}),
      }),
    listTestRuns: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/test-runs`).then(json<TestRun[]>),
    getQueueSummary: () => apiFetch(`${base}/queue/summary`).then(json<QueueSummary>),
    startSegmentation: (id, document) =>
      post<SegmentationView>(
        `${base}/workbench/projects/${id}/segmentations`,
        document ? { document } : {},
      ),
    getSegmentation: (id, jobId) =>
      apiFetch(`${base}/workbench/projects/${id}/segmentations/${jobId}`).then(
        json<SegmentationView>,
      ),
    outputUrl: (jobId, outputId, opts) => outputPath(base, jobId, outputId, opts),
    getOutputText: async (jobId, outputId, stage) => {
      const res = await apiFetch(outputPath(base, jobId, outputId, { stage, inline: true }));
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ? String(body.error) : `${res.status} ${res.statusText}`);
      }
      return res.text();
    },
    listResults: (query = {}) => {
      const params = new URLSearchParams();
      if (query.templateId) params.set('templateId', query.templateId);
      // The API accepts up to 100 characters: a longer filter is clamped, not refused.
      if (query.q?.trim()) params.set('q', query.q.trim().slice(0, 100));
      if (query.before) params.set('before', query.before);
      if (query.beforeId) params.set('beforeId', query.beforeId);
      const qs = params.toString();
      return apiFetch(`${base}/results${qs ? `?${qs}` : ''}`).then(json<ResultSummary[]>);
    },
    getResult: (jobId) => apiFetch(`${base}/results/${jobId}`).then(json<ResultDetail>),
    getReview: (jobId) => apiFetch(`${base}/jobs/${jobId}/review`).then(json<ReviewData>),
    addEdit: (jobId, edit) => post<ReviewEdit>(`${base}/jobs/${jobId}/edits`, edit),
    approve: (jobId, body) => post<JobSummary>(`${base}/jobs/${jobId}/approve`, body),
    reject: (jobId, body) => post<JobSummary>(`${base}/jobs/${jobId}/reject`, body),
    pageUrl: (jobId, page) => `${base}/jobs/${jobId}/pages/${page}`,
    documentUrl: (jobId) => `${base}/jobs/${jobId}/document`,
    archiveUrl: (jobId) => `${base}/results/${jobId}/archive`,
    getStepRuns: (jobId) => apiFetch(`${base}/jobs/${jobId}/steps`).then(json<StepRun[]>),
    rerunStep: (jobId, stepId, body) =>
      post<JobSummary>(`${base}/jobs/${jobId}/steps/${stepId}/rerun`, body),
    getMetrics: (templateId) =>
      apiFetch(`${base}/templates/${templateId}/metrics`).then(json<TemplateMetrics>),
    listReferences: (templateId, version) =>
      apiFetch(
        `${base}/templates/${templateId}/references${version === undefined ? '' : `?version=${version}`}`,
      ).then(json<Reference[]>),
    createReference: (templateId, jobId, name) =>
      post<Reference>(`${base}/templates/${templateId}/references`, { jobId, name }),
    deleteReference: async (templateId, referenceId) => {
      const res = await apiFetch(`${base}/templates/${templateId}/references/${referenceId}`, {
        method: 'DELETE',
      });
      if (!res.ok) await json(res);
    },
    runRegression: (templateId, version) =>
      post<{ jobs: JobSummary[] }>(
        `${base}/templates/${templateId}/versions/${version}/regression`,
        {},
      ),
    getRegression: (templateId, version) =>
      apiFetch(`${base}/templates/${templateId}/versions/${version}/regression`).then(
        json<RegressionReport>,
      ),
    diffVersions: (templateId, from, to) =>
      apiFetch(`${base}/templates/${templateId}/diff?from=${from}&to=${to}`).then(
        json<VersionDiff>,
      ),
    listTemplates: () => apiFetch(`${base}/templates`).then(json<TemplateListItem[]>),
    createTemplate: (id, name) => post<TemplateRecordView>(`${base}/templates`, { id, name }),
    getTemplate: (id, version) =>
      apiFetch(`${base}/templates/${id}/versions/${version}`).then(json<TemplateRecordView>),
    saveTemplate: (id, version, definition, baseUpdatedAt) =>
      post<TemplateRecordView>(
        `${base}/templates/${id}/versions/${version}`,
        { definition, ...(baseUpdatedAt ? { baseUpdatedAt } : {}) },
        'PUT',
      ),
    publishTemplate: (id, version) =>
      post<TemplateRecordView>(`${base}/templates/${id}/versions/${version}/publish`, {}),
    newDraft: (id, from) => post<TemplateRecordView>(`${base}/templates/${id}/drafts`, { from }),
    deleteDraft: async (id, version) => {
      const res = await apiFetch(`${base}/templates/${id}/versions/${version}`, {
        method: 'DELETE',
      });
      if (!res.ok) await json(res);
    },
    importTemplate: (yaml, publish) =>
      post<TemplateRecordView>(`${base}/templates/import`, { yaml, publish }),
    exportUrl: (id, version) => `${base}/templates/${id}/versions/${version}/export`,
    testRun: (file, id, version, model) => {
      const form = new FormData();
      form.append('specId', id);
      form.append('specVersion', String(version));
      form.append('test', 'true');
      if (model) form.append('model', model); // fields precede the file
      form.append('file', file);
      return apiFetch(`${base}/documents`, { method: 'POST', body: form }).then(json<JobSummary>);
    },
  };
}

export const httpApi = createHttpApi();

/** The imported file of an ontology version (a plain link: the browser downloads it). */
export function ontologySourceUrl(id: string, version: number): string {
  return `/api/ontologies/${encodeURIComponent(id)}/versions/${version}/source`;
}

/**
 * A job's live stream. The browser reconnects a dropped stream by itself (the server says after
 * 3 s), so `error` is only reported once it gives up (a refused request: signed out, not found)
 * or when there is no EventSource at all. A finished job's stream is closed here: the server
 * ends it, and the browser would otherwise reconnect.
 */
function watchJobEvents(url: string, on: JobWatchHandlers): () => void {
  if (typeof EventSource === 'undefined') {
    let stopped = false;
    queueMicrotask(() => {
      if (!stopped) on.error();
    });
    return () => {
      stopped = true;
    };
  }
  const source = new EventSource(url);
  source.addEventListener('job', (e) => {
    const live = JSON.parse((e as MessageEvent<string>).data) as JobLive;
    if (live.job.status !== 'queued' && live.job.status !== 'running') source.close();
    on.update(live);
  });
  source.addEventListener('gone', () => {
    source.close();
    on.gone();
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) on.error();
  };
  return () => source.close();
}
