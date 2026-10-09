import { randomUUID } from 'node:crypto';
import type {
  JobDetail,
  JobOutput,
  JobSummary,
  ModelInfo,
  RerunRequest,
  Reference,
  ReviewEdit,
  StepRun,
} from '@ih/shared';
import {
  ReferenceConflictError,
  type IngestionRepo,
  type ListJobsQuery,
  type NewDocument,
  type NewEdit,
} from './types.js';

/** In-memory repo for unit tests and local UI work without Postgres. */
export class MemoryRepo implements IngestionRepo {
  readonly jobs = new Map<string, JobSummary>();
  readonly outputs = new Map<string, JobOutput[]>();
  readonly documents = new Map<string, NewDocument>();
  readonly edits = new Map<string, ReviewEdit[]>();
  readonly stepRuns = new Map<string, StepRun[]>();
  readonly references = new Map<string, Reference>();
  readonly reruns = new Map<string, { step: string } & RerunRequest>();
  models: ModelInfo[] = [];
  private editSeq = 0;

  async ping(): Promise<void> {}

  async createDocumentAndJob(
    doc: NewDocument,
    modelOverride: string | null,
    test = false,
    referenceId: string | null = null,
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
      referenceId,
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

  async createReference(input: Omit<Reference, 'id' | 'createdAt'>): Promise<Reference> {
    const taken = [...this.references.values()].some(
      (r) => r.templateId === input.templateId && r.name === input.name,
    );
    if (taken) throw new ReferenceConflictError(`reference "${input.name}" already exists`);
    const ref: Reference = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.references.set(ref.id, ref);
    return ref;
  }

  async listReferences(templateId: string): Promise<Reference[]> {
    return [...this.references.values()].filter((r) => r.templateId === templateId);
  }

  async deleteReference(templateId: string, id: string): Promise<boolean> {
    if (this.references.get(id)?.templateId !== templateId) return false;
    return this.references.delete(id);
  }

  async createRegressionJob(reference: Reference, version: number): Promise<JobSummary> {
    const source = this.documents.get(reference.documentId)!;
    const doc = { ...source, id: randomUUID(), specVersion: version };
    return this.createDocumentAndJob(doc, null, true, reference.id);
  }

  async listRegressionJobs(templateId: string, version: number): Promise<JobDetail[]> {
    const jobs = [...this.jobs.values()]
      .filter((j) => j.referenceId && j.specId === templateId && j.specVersion === version)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return jobs.map((j) => ({ ...j, outputs: this.outputs.get(j.id) ?? [] }));
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

  async listStepRuns(jobId: string): Promise<StepRun[]> {
    return this.stepRuns.get(jobId) ?? [];
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

  private update(id: string, changes: Partial<JobSummary>): JobSummary {
    const updated = { ...this.jobs.get(id)!, ...changes, updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);
    return updated;
  }
}
