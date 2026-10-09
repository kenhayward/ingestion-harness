import type { JobDetail, JobSummary, ModelInfo, SpecSummary } from '@ih/shared';

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
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ? String(body.error) : `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
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
  };
}

export const httpApi = createHttpApi();
