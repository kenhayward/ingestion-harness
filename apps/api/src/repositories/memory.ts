import { randomUUID } from 'node:crypto';
import type { JobDetail, JobOutput, JobSummary, ModelInfo, ReviewEdit } from '@ih/shared';
import type { IngestionRepo, ListJobsQuery, NewDocument, NewEdit } from './types.js';

/** In-memory repo for unit tests and local UI work without Postgres. */
export class MemoryRepo implements IngestionRepo {
  readonly jobs = new Map<string, JobSummary>();
  readonly outputs = new Map<string, JobOutput[]>();
  readonly documents = new Map<string, NewDocument>();
  readonly edits = new Map<string, ReviewEdit[]>();
  models: ModelInfo[] = [];
  private editSeq = 0;

  async ping(): Promise<void> {}

  async createDocumentAndJob(
    doc: NewDocument,
    modelOverride: string | null,
    test = false,
  ): Promise<JobSummary> {
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
      task: 'process',
      test,
      reviewReasons: null,
      reviewer: null,
      reviewNote: null,
      reviewedAt: null,
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
    return this.update(id, { status: 'queued', task: 'process', attempts: 0, error: null });
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  async listEdits(jobId: string): Promise<ReviewEdit[]> {
    return this.edits.get(jobId) ?? [];
  }

  async addEdit(jobId: string, edit: NewEdit): Promise<ReviewEdit> {
    const saved: ReviewEdit = { id: ++this.editSeq, at: new Date().toISOString(), ...edit };
    this.edits.set(jobId, [...(this.edits.get(jobId) ?? []), saved]);
    return saved;
  }

  async approve(jobId: string, reviewer: string | null, note: string | null) {
    if (this.jobs.get(jobId)?.status !== 'awaiting_review') return null;
    return this.update(jobId, {
      status: 'queued',
      task: 'publish',
      attempts: 0,
      reviewer,
      reviewNote: note,
      reviewedAt: new Date().toISOString(),
    });
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

  private update(id: string, changes: Partial<JobSummary>): JobSummary {
    const updated = { ...this.jobs.get(id)!, ...changes, updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);
    return updated;
  }
}
