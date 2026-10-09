import { randomUUID } from 'node:crypto';
import type { JobDetail, JobOutput, JobSummary, ModelInfo } from '@ih/shared';
import type { IngestionRepo, ListJobsQuery, NewDocument } from './types.js';

/** In-memory repo for unit tests and local UI work without Postgres. */
export class MemoryRepo implements IngestionRepo {
  readonly jobs = new Map<string, JobSummary>();
  readonly outputs = new Map<string, JobOutput[]>();
  readonly documents = new Map<string, NewDocument>();
  models: ModelInfo[] = [];

  async ping(): Promise<void> {}

  async createDocumentAndJob(doc: NewDocument, modelOverride: string | null): Promise<JobSummary> {
    this.documents.set(doc.id, doc);
    const now = new Date().toISOString();
    const job: JobSummary = {
      id: randomUUID(),
      documentId: doc.id,
      filename: doc.filename,
      specId: doc.specId,
      specVersion: doc.specVersion,
      status: 'queued',
      modelOverride,
      attempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async listJobs({ limit, status }: ListJobsQuery): Promise<JobSummary[]> {
    return [...this.jobs.values()]
      .filter((j) => !status || j.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async getJob(id: string): Promise<JobDetail | null> {
    const job = this.jobs.get(id);
    return job ? { ...job, outputs: this.outputs.get(id) ?? [] } : null;
  }

  async retryJob(id: string): Promise<JobSummary | null> {
    const job = this.jobs.get(id);
    if (!job || (job.status !== 'failed' && job.status !== 'needs_review')) return null;
    const updated: JobSummary = {
      ...job,
      status: 'queued',
      attempts: 0,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(id, updated);
    return updated;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }
}
