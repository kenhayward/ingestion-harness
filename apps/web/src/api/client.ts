import type {
  EditRequest,
  JobDetail,
  JobSummary,
  ModelInfo,
  ReviewEdit,
  SpecSummary,
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
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ? String(body.error) : `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, {
    method: 'POST',
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
  };
}

export const httpApi = createHttpApi();
