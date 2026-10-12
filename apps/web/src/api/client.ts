import type {
  Brief,
  BriefBody,
  DataPolicy,
  DraftStage,
  EditRequest,
  EvaluationModel,
  IterationSummary,
  IterationView,
  JobDetail,
  JobSummary,
  ModelInfo,
  PreparedText,
  ProposalView,
  ProjectSummary,
  ProjectView,
  Reference,
  ReferenceRow,
  RerunRequest,
  ResultDetail,
  ResultSummary,
  ReviewEdit,
  SampleRole,
  SampleView,
  SegmentDocument,
  SegmentationView,
  SpecSummary,
  StageView,
  StepRun,
  Template,
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
export interface Api {
  /** Current session, or null when not signed in (401). */
  me(): Promise<Me | null>;
  /** Exchange an access token for a session cookie. Rejects with an ApiError (401/429). */
  login(token: string): Promise<Me>;
  logout(): Promise<void>;
  /** Called when any API call answers 401 (session ended). Returns an unsubscribe. */
  onUnauthorized(listener: () => void): () => void;
  listTokens(): Promise<AccessToken[]>;
  /** A new user token: the plaintext `token` is only ever returned here. */
  createToken(
    label: string,
    expiresInDays: number | null,
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
  listSpecs(): Promise<SpecSummary[]>;
  listModels(): Promise<ModelInfo[]>;
  listJobs(): Promise<JobSummary[]>;
  getJob(id: string): Promise<JobDetail>;
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
  listReferences(templateId: string): Promise<Reference[]>;
  createReference(templateId: string, jobId: string, name: string): Promise<Reference>;
  deleteReference(templateId: string, referenceId: string): Promise<void>;
  runRegression(templateId: string, version: number): Promise<{ jobs: JobSummary[] }>;
  getRegression(templateId: string, version: number): Promise<RegressionReport>;
  diffVersions(templateId: string, from: number, to: number): Promise<VersionDiff>;
  listTemplates(): Promise<TemplateListItem[]>;
  createTemplate(id: string, name: string): Promise<TemplateRecordView>;
  getTemplate(id: string, version: number): Promise<TemplateRecordView>;
  saveTemplate(
    id: string,
    version: number,
    definition: Record<string, unknown>,
  ): Promise<TemplateRecordView>;
  publishTemplate(id: string, version: number): Promise<TemplateRecordView>;
  newDraft(id: string, from: number): Promise<TemplateRecordView>;
  deleteDraft(id: string, version: number): Promise<void>;
  importTemplate(yaml: string, publish: boolean): Promise<TemplateRecordView>;
  exportUrl(id: string, version: number): string;
  /** Upload a sample against a (draft) version as a test run (never published). */
  testRun(file: File, id: string, version: number): Promise<JobSummary>;
  // --- workbench (ADR 0007) ---
  listProjects(): Promise<ProjectSummary[]>;
  /** New project; omit `name` to open an existing document type. */
  createProject(id: string, name?: string): Promise<ProjectView>;
  /** Rejects with an ApiError (404 when there is no project yet). */
  getProject(id: string): Promise<ProjectView>;
  setDataPolicy(projectId: string, dataPolicy: DataPolicy): Promise<ProjectView>;
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
  listReferenceRows(projectId: string): Promise<ReferenceRow[]>;
  /** Queue draft-model runs on unverified dev samples. */
  proposeReferences(projectId: string): Promise<JobSummary[]>;
  startEvaluation(projectId: string, model: EvaluationModel | null): Promise<IterationView>;
  listIterations(projectId: string): Promise<IterationSummary[]>;
  getIteration(projectId: string, iterationId: string): Promise<IterationView>;
  restoreIteration(projectId: string, iterationId: string): Promise<ProjectView>;
  listStages(projectId: string): Promise<StageView[]>;
  listSamples(projectId: string): Promise<SampleView[]>;
  uploadSample(projectId: string, file: File, role: SampleRole): Promise<SampleView>;
  setSampleRole(projectId: string, sampleId: string, role: SampleRole): Promise<SampleView>;
  removeSample(projectId: string, sampleId: string): Promise<void>;
  getSampleText(projectId: string, sampleId: string): Promise<PreparedText>;
  saveBrief(projectId: string, body: BriefBody): Promise<Brief>;
  /** Test-run the open draft on every prepared dev sample. */
  runDevTests(projectId: string): Promise<{ jobs: JobSummary[] }>;
  listTestRuns(projectId: string): Promise<JobSummary[]>;
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
    createToken: (label, expiresInDays) =>
      post<{ token: string; record: AccessToken }>(`${base}/auth/tokens`, {
        label,
        expiresInDays,
      }),
    revokeToken: async (id) => {
      await noContent(apiFetch(`${base}/auth/tokens/${id}/revoke`, { method: 'POST' }));
    },
    deleteToken: async (id) => {
      await noContent(apiFetch(`${base}/auth/tokens/${id}`, { method: 'DELETE' }));
    },
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
    listSpecs: () => apiFetch(`${base}/specs`).then(json<SpecSummary[]>),
    listModels: () => apiFetch(`${base}/models`).then(json<ModelInfo[]>),
    listJobs: () => apiFetch(`${base}/jobs`).then(json<JobSummary[]>),
    getJob: (id) => apiFetch(`${base}/jobs/${id}`).then(json<JobDetail>),
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
    listProjects: () => apiFetch(`${base}/workbench/projects`).then(json<ProjectSummary[]>),
    createProject: (id, name) =>
      post<ProjectView>(`${base}/workbench/projects`, name ? { id, name } : { id }),
    getProject: (id) => apiFetch(`${base}/workbench/projects/${id}`).then(json<ProjectView>),
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
    listReferenceRows: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/references`).then(json<ReferenceRow[]>),
    proposeReferences: (id) =>
      post<{ jobs: JobSummary[] }>(`${base}/workbench/projects/${id}/stages/references`, {}).then(
        (r) => r.jobs,
      ),
    startEvaluation: (id, model) =>
      post<IterationView>(`${base}/workbench/projects/${id}/evaluations`, model ? { model } : {}),
    listIterations: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/iterations`).then(json<IterationSummary[]>),
    getIteration: (id, iid) =>
      apiFetch(`${base}/workbench/projects/${id}/iterations/${iid}`).then(json<IterationView>),
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
    runDevTests: (id) =>
      post<{ jobs: JobSummary[] }>(`${base}/workbench/projects/${id}/test-runs`, {}),
    listTestRuns: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/test-runs`).then(json<JobSummary[]>),
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
    listReferences: (templateId) =>
      apiFetch(`${base}/templates/${templateId}/references`).then(json<Reference[]>),
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
    saveTemplate: (id, version, definition) =>
      post<TemplateRecordView>(
        `${base}/templates/${id}/versions/${version}`,
        { definition },
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
    testRun: (file, id, version) => {
      const form = new FormData();
      form.append('specId', id);
      form.append('specVersion', String(version));
      form.append('test', 'true');
      form.append('file', file);
      return apiFetch(`${base}/documents`, { method: 'POST', body: form }).then(json<JobSummary>);
    },
  };
}

export const httpApi = createHttpApi();
