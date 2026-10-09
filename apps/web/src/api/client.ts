import type {
  EditRequest,
  JobDetail,
  JobSummary,
  ModelInfo,
  Reference,
  RerunRequest,
  ReviewEdit,
  SpecSummary,
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

/** API port — components take this as a prop so tests can pass a fake. */
export interface Api {
  listSpecs(): Promise<SpecSummary[]>;
  listModels(): Promise<ModelInfo[]>;
  listJobs(): Promise<JobSummary[]>;
  getJob(id: string): Promise<JobDetail>;
  retryJob(id: string): Promise<JobSummary>;
  upload(req: UploadRequest): Promise<JobSummary>;
  outputUrl(jobId: string, outputId: string): string;
  getReview(jobId: string): Promise<ReviewData>;
  addEdit(jobId: string, edit: EditRequest): Promise<ReviewEdit>;
  approve(jobId: string, body: { reviewer?: string; note?: string }): Promise<JobSummary>;
  reject(jobId: string, body: { reviewer?: string; reason: string }): Promise<JobSummary>;
  pageUrl(jobId: string, page: number): string;
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
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ? String(body.error) : `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function post<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
  return fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<T>);
}

export function createHttpApi(base = '/api'): Api {
  return {
    listSpecs: () => fetch(`${base}/specs`).then(json<SpecSummary[]>),
    listModels: () => fetch(`${base}/models`).then(json<ModelInfo[]>),
    listJobs: () => fetch(`${base}/jobs`).then(json<JobSummary[]>),
    getJob: (id) => fetch(`${base}/jobs/${id}`).then(json<JobDetail>),
    retryJob: (id) => fetch(`${base}/jobs/${id}/retry`, { method: 'POST' }).then(json<JobSummary>),
    upload: ({ file, specId, specVersion, model }) => {
      // Fields must precede the file part — the API reads them from the file's preamble.
      const form = new FormData();
      form.append('specId', specId);
      if (specVersion !== undefined) form.append('specVersion', String(specVersion));
      if (model) form.append('model', model);
      form.append('file', file);
      return fetch(`${base}/documents`, { method: 'POST', body: form }).then(json<JobSummary>);
    },
    outputUrl: (jobId, outputId) => `${base}/jobs/${jobId}/outputs/${outputId}`,
    getReview: (jobId) => fetch(`${base}/jobs/${jobId}/review`).then(json<ReviewData>),
    addEdit: (jobId, edit) => post<ReviewEdit>(`${base}/jobs/${jobId}/edits`, edit),
    approve: (jobId, body) => post<JobSummary>(`${base}/jobs/${jobId}/approve`, body),
    reject: (jobId, body) => post<JobSummary>(`${base}/jobs/${jobId}/reject`, body),
    pageUrl: (jobId, page) => `${base}/jobs/${jobId}/pages/${page}`,
    getStepRuns: (jobId) => fetch(`${base}/jobs/${jobId}/steps`).then(json<StepRun[]>),
    rerunStep: (jobId, stepId, body) =>
      post<JobSummary>(`${base}/jobs/${jobId}/steps/${stepId}/rerun`, body),
    getMetrics: (templateId) =>
      fetch(`${base}/templates/${templateId}/metrics`).then(json<TemplateMetrics>),
    listReferences: (templateId) =>
      fetch(`${base}/templates/${templateId}/references`).then(json<Reference[]>),
    createReference: (templateId, jobId, name) =>
      post<Reference>(`${base}/templates/${templateId}/references`, { jobId, name }),
    deleteReference: async (templateId, referenceId) => {
      const res = await fetch(`${base}/templates/${templateId}/references/${referenceId}`, {
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
      fetch(`${base}/templates/${templateId}/versions/${version}/regression`).then(
        json<RegressionReport>,
      ),
    diffVersions: (templateId, from, to) =>
      fetch(`${base}/templates/${templateId}/diff?from=${from}&to=${to}`).then(json<VersionDiff>),
    listTemplates: () => fetch(`${base}/templates`).then(json<TemplateListItem[]>),
    createTemplate: (id, name) => post<TemplateRecordView>(`${base}/templates`, { id, name }),
    getTemplate: (id, version) =>
      fetch(`${base}/templates/${id}/versions/${version}`).then(json<TemplateRecordView>),
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
      const res = await fetch(`${base}/templates/${id}/versions/${version}`, { method: 'DELETE' });
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
      return fetch(`${base}/documents`, { method: 'POST', body: form }).then(json<JobSummary>);
    },
  };
}

export const httpApi = createHttpApi();
