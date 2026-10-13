import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { BriefBodySchema, stableJson } from '@ih/shared';
import type {
  Brief,
  BriefBody,
  DataPolicy,
  DraftStage,
  EvaluationSet,
  FeedbackItem,
  JobSummary,
  KeepableStage,
  ProposalDecision,
  Publication,
  SampleRole,
  StageConfirm,
  StageSkip,
  WorkbenchProject,
} from '@ih/shared';
import type { MemoryRepo } from '../repositories/memory.js';
import type { MemoryTemplateRepo } from '../templates/repo.js';
import type { NewDocument, RemovedJob, StoredObject } from '../repositories/types.js';

/** A workbench sample joined with its document row. */
export interface SampleRecord {
  id: string;
  projectId: string;
  documentId: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  bucket: string;
  objectKey: string;
  role: SampleRole;
  addedForVersion: number;
  createdAt: string;
}

export interface NewSample {
  projectId: string;
  /** The document row must exist already (IngestionRepo.createWorkbenchJob). */
  documentId: string;
  role: SampleRole;
  addedForVersion: number;
}

/** A drafting proposal; its id is the draft job that produced it. */
export interface ProposalRecord {
  id: string;
  projectId: string;
  stage: DraftStage;
  briefVersion: number | null;
  decision: ProposalDecision | null;
  /** Indexes of the changes taken from a partially accepted proposal. */
  acceptedChanges: number[] | null;
  /** The draft version and definition the proposal was made against (null for survey). */
  baseVersion: number | null;
  baseDefinition: Record<string, unknown> | null;
  /** The open feedback a revise proposal was made from (null for other stages). */
  feedbackIds: string[] | null;
  decidedAt: string | null;
  createdAt: string;
}

export type StageSkipRecord = StageSkip & { projectId: string };
export type StageConfirmRecord = StageConfirm & { projectId: string };

export interface NewProposal {
  id: string;
  projectId: string;
  stage: DraftStage;
  briefVersion: number | null;
  baseVersion?: number | null;
  baseDefinition?: Record<string, unknown> | null;
  feedbackIds?: string[] | null;
}

/** One evaluation run of the draft (migration 0013); the scorecard is derived from its jobs. */
export interface IterationRecord {
  id: string;
  projectId: string;
  templateVersion: number;
  definition: Record<string, unknown>;
  briefVersion: number | null;
  set: EvaluationSet;
  model: string | null;
  jobIds: string[];
  /**
   * sha256 of each sample the iteration evaluated (migration 0017), kept when its jobs are
   * deleted; null for iterations recorded before it (callers map `jobIds` to documents then).
   */
  sampleShas: string[] | null;
  /** Shared by the iterations of one model comparison. */
  groupId: string | null;
  /** The jobs were told not to read the step cache. */
  uncached: boolean;
  /** Cached summary once every job has finished; null while running. */
  scores: { score: number | null; completed: number; total: number } | null;
  /**
   * The publish gate's raw holdout score (migration 0020), valid while `fingerprint` (a hash of
   * the iteration's jobs) is unchanged; stored only once every job has finished.
   */
  gateCache: { fingerprint: string; score: number | null; completed: number; total: number } | null;
  createdAt: string;
}

export type NewIteration = Omit<
  IterationRecord,
  'id' | 'scores' | 'gateCache' | 'createdAt' | 'groupId' | 'uncached' | 'sampleShas'
> &
  Partial<Pick<IterationRecord, 'groupId' | 'uncached' | 'sampleShas'>>;

export class WorkbenchConflictError extends Error {}

export type NewPublication = Omit<Publication, 'id' | 'publishedAt'>;

export interface PublishDraftInput {
  projectId: string;
  version: number;
  /** The definition the gate was decided for; publishing refuses any other. */
  definition: Record<string, unknown>;
  publication: NewPublication;
}

export type PublishDraftResult =
  | { result: 'published'; publication: Publication }
  | { result: 'changed' }
  | { result: 'not-draft' };

/** What a deleted project leaves to clean up in the internal store. */
export interface RemovedProject {
  /** Every deleted job with its draft outputs (`inboxObject` is always null: see `documents`). */
  jobs: RemovedJob[];
  /** Inbox PDFs of the deleted documents that no remaining document row shares. */
  documents: StoredObject[];
}

/** Persistence for workbench projects, samples and briefs (ADR 0007; migration 0008). */
export interface WorkbenchRepo {
  listProjects(): Promise<WorkbenchProject[]>;
  getProject(id: string): Promise<WorkbenchProject | null>;
  /** Throws WorkbenchConflictError when the id is taken. */
  createProject(id: string, name: string): Promise<WorkbenchProject>;
  addSample(sample: NewSample): Promise<SampleRecord>;
  /** Oldest first. */
  listSamples(projectId: string): Promise<SampleRecord[]>;
  setSampleRole(
    projectId: string,
    sampleId: string,
    role: SampleRole,
  ): Promise<SampleRecord | null>;
  /** Unlinks the sample; its document and PDF stay (retention is a later phase). */
  removeSample(projectId: string, sampleId: string): Promise<boolean>;
  latestBrief(projectId: string): Promise<Brief | null>;
  /** Appends version n+1. */
  saveBrief(projectId: string, body: BriefBody): Promise<Brief>;
  /** Every version, oldest first. */
  listBriefs(projectId: string): Promise<Brief[]>;
  getBrief(projectId: string, version: number): Promise<Brief | null>;
  /** Null when the project is unknown. `by` is the actor who changed it. */
  setDataPolicy(
    id: string,
    policy: DataPolicy,
    by: string | null,
  ): Promise<WorkbenchProject | null>;
  /** Null when the project is unknown. `actor` is the label of the token that changed it. */
  setPublishThreshold(
    id: string,
    threshold: number,
    actor: string | null,
  ): Promise<WorkbenchProject | null>;
  recordPublication(p: NewPublication): Promise<Publication>;
  /**
   * Publishes the template draft `version` and records the publication in one transaction:
   * `not-draft` when the version is not an open draft, `changed` when its definition is no
   * longer `definition` (both write nothing).
   */
  publishDraft(input: PublishDraftInput): Promise<PublishDraftResult>;
  /** Newest first. */
  listPublications(projectId: string): Promise<Publication[]>;
  createProposal(p: NewProposal): Promise<ProposalRecord>;
  /** Newest first. */
  listProposals(projectId: string): Promise<ProposalRecord[]>;
  /** Null when the proposal is unknown, belongs to another project, or is already decided. */
  decideProposal(
    projectId: string,
    id: string,
    decision: ProposalDecision,
    acceptedChanges?: number[] | null,
  ): Promise<ProposalRecord | null>;
  createFeedback(
    input: Omit<FeedbackItem, 'id' | 'createdAt' | 'resolvedBy'>,
  ): Promise<FeedbackItem>;
  /** Newest first. */
  listFeedback(projectId: string): Promise<FeedbackItem[]>;
  /** Only open items are deleted; one a proposal already answered is kept. */
  deleteFeedback(projectId: string, id: string): Promise<'deleted' | 'resolved' | 'not-found'>;
  /** Marks the open items among `ids` as answered by the proposal. */
  resolveFeedback(projectId: string, ids: string[], proposalId: string): Promise<void>;
  addSkip(projectId: string, stage: DraftStage): Promise<StageSkipRecord>;
  /** Newest first. */
  listSkips(projectId: string): Promise<StageSkipRecord[]>;
  /** "Keep" on a stale stage (handoff SC1, migration 0026): its content stands up to `upTo`. */
  addConfirm(projectId: string, stage: KeepableStage, upTo: string): Promise<StageConfirmRecord>;
  /** Newest first. */
  listConfirms(projectId: string): Promise<StageConfirmRecord[]>;
  createIteration(input: NewIteration): Promise<IterationRecord>;
  /** Newest first. */
  listIterations(projectId: string): Promise<IterationRecord[]>;
  getIteration(projectId: string, id: string): Promise<IterationRecord | null>;
  /** The iterations of one model comparison, oldest first. */
  listGroup(projectId: string, groupId: string): Promise<IterationRecord[]>;
  setIterationScores(id: string, scores: NonNullable<IterationRecord['scores']>): Promise<void>;
  setGateCache(
    iterationId: string,
    cache: NonNullable<IterationRecord['gateCache']>,
  ): Promise<void>;
  /**
   * Deletes the project in one transaction: its jobs (with their history, queued and running
   * ones included), the type's project-less test jobs, feedback, iterations, publications,
   * proposals, stage skips, briefs, samples, the template's references, every document of the
   * type that nothing else uses and the template's draft rows. Files are the caller's.
   * `published` (nothing written) when any version of the template is published; null when the
   * project is unknown. Locks the template rows before the project row, as `publishDraft` does.
   */
  deleteProject(id: string): Promise<RemovedProject | 'published' | null>;
  /**
   * Per project, a hash of everything the project overview reads (the project row, its jobs,
   * samples, proposals, skips, confirmations, briefs, iterations, publications, feedback, template versions and
   * references), and the latest activity time. Equal fingerprints mean an unchanged list row.
   */
  projectFingerprints(): Promise<ProjectFingerprint[]>;
  /** The cached list rows by project id (migration 0022). */
  listCache(): Promise<Map<string, ListCacheEntry>>;
  /** Upserts a project's cached list row; a project that no longer exists is ignored. */
  putListCache(projectId: string, fingerprint: string, item: unknown): Promise<void>;
  /** The owner's pinned project ids, most recently pinned first. */
  listPins(owner: string): Promise<string[]>;
  /** False when the project is unknown. Pinning again keeps the first pin. */
  pin(owner: string, projectId: string): Promise<boolean>;
  /** Idempotent. */
  unpin(owner: string, projectId: string): Promise<void>;
}

export interface ProjectFingerprint {
  id: string;
  fingerprint: string;
  lastActivityAt: string;
}

export interface ListCacheEntry {
  fingerprint: string;
  item: unknown;
}

/**
 * In-memory adapter: reads documents from, and pins them in, the MemoryRepo it's given; the
 * template repo stands in for the `templates` table that the Pg transactions share.
 */
export class MemoryWorkbenchRepo implements WorkbenchRepo {
  readonly projects = new Map<string, WorkbenchProject>();
  readonly samples = new Map<string, NewSample & { id: string; createdAt: string }>();
  readonly briefs: Brief[] = [];
  readonly proposals: ProposalRecord[] = [];
  readonly skips: StageSkipRecord[] = [];
  readonly confirms: StageConfirmRecord[] = [];
  readonly iterations: IterationRecord[] = [];
  readonly publications: Publication[] = [];
  readonly feedback: FeedbackItem[] = [];
  readonly listCacheRows = new Map<string, ListCacheEntry>();
  /** owner → project id → pinned at. */
  readonly pins = new Map<string, Map<string, string>>();

  constructor(
    private readonly jobs: MemoryRepo,
    private readonly templates: MemoryTemplateRepo,
  ) {}

  async listProjects() {
    return [...this.projects.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async getProject(id: string) {
    return this.projects.get(id) ?? null;
  }

  /** Strictly increasing ISO times (the MemoryRepo's clock): stage states compare them. */
  private now(): string {
    return this.jobs.now();
  }

  async createProject(id: string, name: string) {
    if (this.projects.has(id)) throw new WorkbenchConflictError(`project ${id} already exists`);
    const project: WorkbenchProject = {
      id,
      name,
      createdAt: this.now(),
      dataPolicy: 'local',
      dataPolicyChangedAt: null,
      dataPolicyChangedBy: null,
      publishThreshold: 0.9,
      thresholdSetBy: null,
      thresholdSetAt: null,
    };
    this.projects.set(id, project);
    return project;
  }

  async setPublishThreshold(id: string, threshold: number, actor: string | null) {
    const project = this.projects.get(id);
    if (!project) return null;
    const updated = {
      ...project,
      publishThreshold: threshold,
      thresholdSetBy: actor,
      thresholdSetAt: this.now(),
    };
    this.projects.set(id, updated);
    return updated;
  }

  async recordPublication(p: NewPublication) {
    const row: Publication = { ...p, id: randomUUID(), publishedAt: this.now() };
    this.publications.push(row);
    return row;
  }

  async publishDraft(input: PublishDraftInput): Promise<PublishDraftResult> {
    const record = await this.templates.get(input.projectId, input.version);
    if (record?.status !== 'draft') return { result: 'not-draft' };
    if (stableJson(record.definition) !== stableJson(input.definition)) {
      return { result: 'changed' };
    }
    // The publication first: when it fails the draft stays open, as the Pg rollback leaves it.
    const publication = await this.recordPublication(input.publication);
    try {
      await this.templates.publish(input.projectId, input.version);
    } catch (err) {
      this.publications.splice(this.publications.indexOf(publication), 1);
      throw err;
    }
    return { result: 'published', publication };
  }

  async listPublications(projectId: string) {
    return this.publications.filter((p) => p.projectId === projectId).reverse();
  }

  async addSample(sample: NewSample) {
    // Mirror migration 0008: FKs on project and document, UNIQUE (project_id, document_id).
    if (!this.projects.has(sample.projectId)) {
      throw new Error(`unknown project ${sample.projectId}`);
    }
    if (!this.jobs.documents.has(sample.documentId)) {
      throw new Error(`unknown document ${sample.documentId}`);
    }
    const duplicate = [...this.samples.values()].some(
      (s) => s.projectId === sample.projectId && s.documentId === sample.documentId,
    );
    if (duplicate) {
      throw new WorkbenchConflictError(
        `document ${sample.documentId} is already a sample of ${sample.projectId}`,
      );
    }
    const row = { ...sample, id: randomUUID(), createdAt: this.now() };
    this.samples.set(row.id, row);
    this.jobs.sampleDocuments.add(sample.documentId);
    return this.record(row);
  }

  async listSamples(projectId: string) {
    return [...this.samples.values()]
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((s) => this.record(s));
  }

  async setSampleRole(projectId: string, sampleId: string, role: SampleRole) {
    const row = this.samples.get(sampleId);
    if (row?.projectId !== projectId) return null;
    const updated = { ...row, role };
    this.samples.set(sampleId, updated);
    return this.record(updated);
  }

  async removeSample(projectId: string, sampleId: string) {
    const row = this.samples.get(sampleId);
    if (row?.projectId !== projectId) return false;
    this.samples.delete(sampleId);
    const stillLinked = [...this.samples.values()].some((s) => s.documentId === row.documentId);
    if (!stillLinked) this.jobs.sampleDocuments.delete(row.documentId);
    return true;
  }

  async latestBrief(projectId: string) {
    return this.briefs.filter((b) => b.projectId === projectId).at(-1) ?? null;
  }

  async saveBrief(projectId: string, body: BriefBody) {
    const version = ((await this.latestBrief(projectId))?.version ?? 0) + 1;
    const brief = { projectId, version, body, createdAt: this.now() };
    this.briefs.push(brief);
    return brief;
  }

  async listBriefs(projectId: string) {
    return this.briefs.filter((b) => b.projectId === projectId);
  }

  async getBrief(projectId: string, version: number) {
    return this.briefs.find((b) => b.projectId === projectId && b.version === version) ?? null;
  }

  async setDataPolicy(id: string, policy: DataPolicy, by: string | null) {
    const project = this.projects.get(id);
    if (!project) return null;
    const updated: WorkbenchProject = {
      ...project,
      dataPolicy: policy,
      dataPolicyChangedAt: this.now(),
      dataPolicyChangedBy: by,
    };
    this.projects.set(id, updated);
    if (policy === 'local') {
      // Revocation reaches jobs already queued (retries and step re-runs reuse their row).
      for (const job of this.jobs.jobs.values()) {
        if (job.projectId !== id) continue;
        this.jobs.jobParams.set(job.id, {
          ...this.jobs.jobParams.get(job.id),
          dataPolicy: 'local',
        });
      }
      for (const job of [...this.jobs.draftJobs.values(), ...this.jobs.exportJobs.values()]) {
        if (job.projectId === id) job.params = { ...job.params, dataPolicy: 'local' };
      }
    }
    return updated;
  }

  async createProposal(p: NewProposal) {
    const record: ProposalRecord = {
      id: p.id,
      projectId: p.projectId,
      stage: p.stage,
      briefVersion: p.briefVersion,
      decision: null,
      acceptedChanges: null,
      baseVersion: p.baseVersion ?? null,
      baseDefinition: p.baseDefinition ?? null,
      feedbackIds: p.feedbackIds ?? null,
      decidedAt: null,
      createdAt: this.now(),
    };
    this.proposals.push(record);
    return record;
  }

  async listProposals(projectId: string) {
    // Insertion order, newest first: timestamps can tie within a millisecond.
    return this.proposals.filter((p) => p.projectId === projectId).reverse();
  }

  async decideProposal(
    projectId: string,
    id: string,
    decision: ProposalDecision,
    acceptedChanges?: number[] | null,
  ) {
    const index = this.proposals.findIndex((p) => p.id === id);
    const current = this.proposals[index];
    if (current?.projectId !== projectId || current.decision !== null) return null;
    const decided: ProposalRecord = {
      ...current,
      decision,
      acceptedChanges: acceptedChanges ?? null,
      decidedAt: this.now(),
    };
    this.proposals[index] = decided;
    return decided;
  }

  async createFeedback(input: Omit<FeedbackItem, 'id' | 'createdAt' | 'resolvedBy'>) {
    const record: FeedbackItem = {
      ...input,
      id: randomUUID(),
      createdAt: this.now(),
      resolvedBy: null,
    };
    this.feedback.push(record);
    return record;
  }

  async listFeedback(projectId: string) {
    // Insertion order, newest first: timestamps can tie within a millisecond.
    return this.feedback.filter((f) => f.projectId === projectId).reverse();
  }

  async deleteFeedback(projectId: string, id: string) {
    const index = this.feedback.findIndex((f) => f.projectId === projectId && f.id === id);
    const current = this.feedback[index];
    if (!current) return 'not-found' as const;
    if (current.resolvedBy) return 'resolved' as const;
    this.feedback.splice(index, 1);
    return 'deleted' as const;
  }

  async resolveFeedback(projectId: string, ids: string[], proposalId: string) {
    for (const f of this.feedback) {
      if (f.projectId === projectId && ids.includes(f.id) && !f.resolvedBy) {
        f.resolvedBy = proposalId;
      }
    }
  }

  async addSkip(projectId: string, stage: DraftStage) {
    const skip: StageSkipRecord = { projectId, stage, skippedAt: this.now() };
    this.skips.push(skip);
    return skip;
  }

  async listSkips(projectId: string) {
    return this.skips.filter((s) => s.projectId === projectId).reverse();
  }

  async addConfirm(projectId: string, stage: KeepableStage, upTo: string) {
    const confirm: StageConfirmRecord = { projectId, stage, upTo, confirmedAt: this.now() };
    this.confirms.push(confirm);
    return confirm;
  }

  async listConfirms(projectId: string) {
    return this.confirms.filter((c) => c.projectId === projectId).reverse();
  }

  async createIteration(input: NewIteration) {
    const record: IterationRecord = {
      ...input,
      sampleShas: input.sampleShas ?? null,
      groupId: input.groupId ?? null,
      uncached: input.uncached ?? false,
      id: randomUUID(),
      scores: null,
      gateCache: null,
      createdAt: this.now(),
    };
    this.iterations.push(record);
    return record;
  }

  async listIterations(projectId: string) {
    return this.iterations.filter((i) => i.projectId === projectId).reverse();
  }

  async getIteration(projectId: string, id: string) {
    return this.iterations.find((i) => i.projectId === projectId && i.id === id) ?? null;
  }

  async listGroup(projectId: string, groupId: string) {
    return this.iterations.filter((i) => i.projectId === projectId && i.groupId === groupId);
  }

  async setIterationScores(id: string, scores: NonNullable<IterationRecord['scores']>) {
    const at = this.iterations.findIndex((i) => i.id === id);
    if (at >= 0) this.iterations[at] = { ...this.iterations[at]!, scores };
  }

  async setGateCache(iterationId: string, gateCache: NonNullable<IterationRecord['gateCache']>) {
    const at = this.iterations.findIndex((i) => i.id === iterationId);
    if (at >= 0) this.iterations[at] = { ...this.iterations[at]!, gateCache };
  }

  async deleteProject(id: string): Promise<RemovedProject | 'published' | null> {
    if (!this.projects.has(id)) return null;
    const versions = (await this.templates.list()).filter((t) => t.id === id);
    if (versions.some((t) => t.status === 'published')) return 'published';
    const repo = this.jobs;
    const removed: RemovedJob[] = [];
    const draftsOf = (jobId: string) =>
      (repo.outputs.get(jobId) ?? [])
        .filter((o) => o.stage === 'draft')
        .map((o) => ({ bucket: o.bucket, key: o.key }));
    // The project's jobs, and the type's project-less test jobs (Templates-page test uploads
    // and regression runs of a type that was never published).
    const owned = (j: JobSummary) =>
      j.projectId === id || (j.projectId === null && j.test && j.specId === id);
    for (const job of [...repo.jobs.values()].filter(owned)) {
      removed.push({ jobId: job.id, draftObjects: draftsOf(job.id), inboxObject: null });
      repo.jobs.delete(job.id);
    }
    for (const map of [repo.draftJobs, repo.exportJobs, repo.segmentJobs]) {
      for (const job of [...map.values()].filter((j) => j.projectId === id)) {
        removed.push({ jobId: job.id, draftObjects: [], inboxObject: null });
        map.delete(job.id);
      }
    }
    for (const { jobId } of removed) {
      for (const map of [
        repo.outputs,
        repo.edits,
        repo.stepRuns,
        repo.events,
        repo.publishedAt,
        repo.jobParams,
        repo.priorities,
        repo.reruns,
      ]) {
        map.delete(jobId);
      }
      // ON DELETE SET NULL (migration 0005): other templates' references keep their row.
      for (const ref of repo.references.values()) {
        if (ref.sourceJobId === jobId) repo.references.set(ref.id, { ...ref, sourceJobId: null });
      }
    }
    const ofProject = (r: { projectId: string }) => r.projectId === id;
    for (const rows of [
      this.feedback,
      this.publications,
      this.iterations,
      this.proposals,
      this.skips,
      this.confirms,
      this.briefs,
    ] as { projectId: string }[][]) {
      for (let i = rows.length - 1; i >= 0; i--) if (ofProject(rows[i]!)) rows.splice(i, 1);
    }
    for (const [sampleId, sample] of this.samples) {
      if (sample.projectId === id) this.samples.delete(sampleId);
    }
    repo.sampleDocuments.clear();
    for (const sample of this.samples.values()) repo.sampleDocuments.add(sample.documentId);
    for (const [refId, ref] of repo.references) {
      if (ref.templateId !== id) continue;
      repo.references.delete(refId);
      // ON DELETE SET NULL (migrations 0005 and 0018).
      for (const job of repo.jobs.values()) {
        if (job.referenceId === refId) repo.jobs.set(job.id, { ...job, referenceId: null });
      }
      for (const other of repo.references.values()) {
        if (other.copiedFrom === refId)
          repo.references.set(other.id, { ...other, copiedFrom: null });
      }
    }
    const deleted: NewDocument[] = [];
    for (const doc of [...repo.documents.values()]) {
      if (doc.specId !== id) continue;
      const used =
        [...repo.jobs.values()].some((j) => j.documentId === doc.id) ||
        [...repo.references.values()].some((r) => r.documentId === doc.id) ||
        repo.sampleDocuments.has(doc.id);
      if (used) continue;
      repo.documents.delete(doc.id);
      deleted.push(doc);
    }
    const documents: StoredObject[] = [];
    for (const doc of deleted) {
      const shared = [...repo.documents.values()].some(
        (d) => d.bucket === doc.bucket && d.objectKey === doc.objectKey,
      );
      const listed = documents.some((o) => o.bucket === doc.bucket && o.key === doc.objectKey);
      if (!shared && !listed) documents.push({ bucket: doc.bucket, key: doc.objectKey });
    }
    this.projects.delete(id);
    // ON DELETE CASCADE (migration 0022).
    this.listCacheRows.delete(id);
    for (const pins of this.pins.values()) pins.delete(id);
    for (const t of versions) await this.templates.deleteDraft(id, t.version);
    return { jobs: removed, documents };
  }

  async projectFingerprints(): Promise<ProjectFingerprint[]> {
    const repo = this.jobs;
    const templates = await this.templates.list();
    const references = [...repo.references.values()];
    const projectJobs = [
      ...repo.jobs.values(),
      ...repo.draftJobs.values(),
      ...repo.exportJobs.values(),
      ...repo.segmentJobs.values(),
    ];
    return (await this.listProjects()).map((project) => {
      const id = project.id;
      const of = <T extends { projectId: string | null }>(rows: Iterable<T>) =>
        [...rows].filter((r) => r.projectId === id);
      const jobs = of(projectJobs).map((j) => [j.id, j.status, j.updatedAt]);
      const samples = of(this.samples.values()).map((s) => [s.id, s.role, s.createdAt]);
      const briefs = of(this.briefs).map((b) => [b.version, b.createdAt]);
      const proposals = of(this.proposals).map((p) => [p.id, p.decision, p.createdAt, p.decidedAt]);
      const skips = of(this.skips).map((s) => [s.stage, s.skippedAt]);
      const confirms = of(this.confirms).map((c) => [c.stage, c.upTo, c.confirmedAt]);
      const iterations = of(this.iterations).map((i) => [i.id, i.createdAt, i.scores, i.gateCache]);
      const publications = of(this.publications).map((p) => [p.id, p.publishedAt]);
      const feedback = of(this.feedback).map((f) => [f.id, f.resolvedBy, f.createdAt]);
      const versions = templates
        .filter((t) => t.id === id)
        .map((t) => [t.version, t.status, t.updatedAt, t.definition]);
      const refs = references
        .filter((r) => r.templateId === id)
        .map((r) => [r.id, r.templateVersion, r.createdAt, r.supersededAt]);
      const fingerprint = createHash('md5')
        .update(
          JSON.stringify([
            project,
            jobs,
            samples,
            briefs,
            proposals,
            skips,
            confirms,
            iterations,
            publications,
            feedback,
            versions,
            refs,
          ]),
        )
        .digest('hex');
      const times = [
        project.createdAt,
        ...jobs.map((j) => j[2] as string),
        ...samples.map((s) => s[2] as string),
        ...briefs.map((b) => b[1] as string),
        ...proposals.flatMap((p) => [p[2], p[3]]),
        ...skips.map((s) => s[1] as string),
        ...confirms.map((c) => c[2] as string),
        ...iterations.map((i) => i[1] as string),
        ...publications.map((p) => p[1] as string),
        ...feedback.map((f) => f[2] as string),
        ...versions.map((t) => t[2] as string),
        ...refs.flatMap((r) => [r[2], r[3]]),
      ].filter((t): t is string => typeof t === 'string');
      const lastActivityAt = times.reduce((a, b) => (b > a ? b : a));
      return { id, fingerprint, lastActivityAt };
    });
  }

  async listCache() {
    return new Map(this.listCacheRows);
  }

  async putListCache(projectId: string, fingerprint: string, item: unknown) {
    if (!this.projects.has(projectId)) return;
    this.listCacheRows.set(projectId, { fingerprint, item });
  }

  async listPins(owner: string) {
    const pins = [...(this.pins.get(owner)?.entries() ?? [])];
    return pins.sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id);
  }

  async pin(owner: string, projectId: string) {
    if (!this.projects.has(projectId)) return false;
    const pins = this.pins.get(owner) ?? new Map<string, string>();
    if (!pins.has(projectId)) pins.set(projectId, this.now());
    this.pins.set(owner, pins);
    return true;
  }

  async unpin(owner: string, projectId: string) {
    this.pins.get(owner)?.delete(projectId);
  }

  private record(row: NewSample & { id: string; createdAt: string }): SampleRecord {
    const doc = this.jobs.documents.get(row.documentId)!;
    return {
      id: row.id,
      projectId: row.projectId,
      documentId: row.documentId,
      filename: doc.filename,
      sha256: doc.sha256,
      sizeBytes: doc.sizeBytes,
      bucket: doc.bucket,
      objectKey: doc.objectKey,
      role: row.role,
      addedForVersion: row.addedForVersion,
      createdAt: row.createdAt,
    };
  }
}

interface ProjectRow {
  id: string;
  name: string;
  created_at: Date;
  data_policy: DataPolicy;
  data_policy_changed_at: Date | null;
  data_policy_changed_by: string | null;
  publish_threshold: string;
  threshold_set_by: string | null;
  threshold_set_at: Date | null;
}

interface SampleRow {
  id: string;
  project_id: string;
  document_id: string;
  filename: string;
  sha256: string;
  size_bytes: string;
  bucket: string;
  object_key: string;
  role: SampleRole;
  added_for_version: number;
  created_at: Date;
}

interface BriefRow {
  project_id: string;
  version: number;
  body: BriefBody;
  created_at: Date;
}

interface ProposalRow {
  id: string;
  project_id: string;
  stage: DraftStage;
  brief_version: number | null;
  decision: ProposalDecision | null;
  accepted_changes: number[] | null;
  base_version: number | null;
  base_definition: Record<string, unknown> | null;
  feedback_ids: string[] | null;
  decided_at: Date | null;
  created_at: Date;
}

interface FeedbackRow {
  id: string;
  project_id: string;
  target: FeedbackItem['target'];
  target_id: string;
  sample_id: string | null;
  iteration_id: string | null;
  body: string;
  resolved_by: string | null;
  created_at: Date;
}

interface SkipRow {
  project_id: string;
  stage: DraftStage;
  skipped_at: Date;
}

interface ConfirmRow {
  project_id: string;
  stage: KeepableStage;
  up_to: Date;
  confirmed_at: Date;
}

interface IterationRow {
  id: string;
  project_id: string;
  template_version: number;
  definition: Record<string, unknown>;
  brief_version: number | null;
  eval_set: EvaluationSet;
  model: string | null;
  job_ids: string[];
  sample_shas: string[] | null;
  group_id: string | null;
  uncached: boolean;
  scores: IterationRecord['scores'];
  gate_cache: IterationRecord['gateCache'];
  created_at: Date;
}

const toIteration = (r: IterationRow): IterationRecord => ({
  id: r.id,
  projectId: r.project_id,
  templateVersion: r.template_version,
  definition: r.definition,
  briefVersion: r.brief_version,
  set: r.eval_set,
  model: r.model,
  jobIds: r.job_ids,
  sampleShas: r.sample_shas,
  groupId: r.group_id,
  uncached: r.uncached,
  scores: r.scores,
  gateCache: r.gate_cache,
  createdAt: r.created_at.toISOString(),
});

const toSkip = (r: SkipRow): StageSkipRecord => ({
  projectId: r.project_id,
  stage: r.stage,
  skippedAt: r.skipped_at.toISOString(),
});

const toConfirm = (r: ConfirmRow): StageConfirmRecord => ({
  projectId: r.project_id,
  stage: r.stage,
  upTo: r.up_to.toISOString(),
  confirmedAt: r.confirmed_at.toISOString(),
});

const toProposal = (r: ProposalRow): ProposalRecord => ({
  id: r.id,
  projectId: r.project_id,
  stage: r.stage,
  briefVersion: r.brief_version,
  decision: r.decision,
  acceptedChanges: r.accepted_changes,
  baseVersion: r.base_version,
  baseDefinition: r.base_definition,
  feedbackIds: r.feedback_ids,
  decidedAt: r.decided_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

const toFeedback = (r: FeedbackRow): FeedbackItem => ({
  id: r.id,
  projectId: r.project_id,
  target: r.target,
  targetId: r.target_id,
  sampleId: r.sample_id,
  iterationId: r.iteration_id,
  body: r.body,
  createdAt: r.created_at.toISOString(),
  resolvedBy: r.resolved_by,
});

interface PublicationRow {
  id: string;
  project_id: string;
  version: number;
  iteration_id: string | null;
  score: string | null;
  threshold: string;
  override_reason: string | null;
  published_by: string | null;
  published_at: Date;
}

const toPublication = (r: PublicationRow): Publication => ({
  id: r.id,
  projectId: r.project_id,
  version: r.version,
  iterationId: r.iteration_id,
  score: r.score === null ? null : Number(r.score),
  threshold: Number(r.threshold),
  overrideReason: r.override_reason,
  publishedBy: r.published_by,
  publishedAt: r.published_at.toISOString(),
});

const toProject = (r: ProjectRow): WorkbenchProject => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at.toISOString(),
  dataPolicy: r.data_policy,
  dataPolicyChangedAt: r.data_policy_changed_at?.toISOString() ?? null,
  dataPolicyChangedBy: r.data_policy_changed_by,
  publishThreshold: Number(r.publish_threshold),
  thresholdSetBy: r.threshold_set_by,
  thresholdSetAt: r.threshold_set_at?.toISOString() ?? null,
});

const toSample = (r: SampleRow): SampleRecord => ({
  id: r.id,
  projectId: r.project_id,
  documentId: r.document_id,
  filename: r.filename,
  sha256: r.sha256,
  sizeBytes: Number(r.size_bytes),
  bucket: r.bucket,
  objectKey: r.object_key,
  role: r.role,
  addedForVersion: r.added_for_version,
  createdAt: r.created_at.toISOString(),
});

const toBrief = (r: BriefRow): Brief => ({
  projectId: r.project_id,
  version: r.version,
  body: BriefBodySchema.parse(r.body),
  createdAt: r.created_at.toISOString(),
});

const SAMPLE_SELECT = `
  SELECT s.id, s.project_id, s.document_id, d.filename, d.sha256, d.size_bytes, d.bucket,
         d.object_key, s.role, s.added_for_version, s.created_at
    FROM workbench_samples s JOIN documents d ON d.id = s.document_id`;

/**
 * One row per project: an md5 over cheap aggregates of every table the project overview reads,
 * and the latest activity time. Each value is coalesced so a NULL never shifts the others.
 * Jobs carry an order-free hash of (id, status) because some status writes leave `updated_at`
 * alone; samples list (id, role) so a role switch shows.
 */
const FINGERPRINT_SQL = `
  SELECT p.id,
         md5(concat_ws('|',
           p.name, p.data_policy, coalesce(p.data_policy_changed_at::text, ''),
           p.publish_threshold::text, coalesce(p.threshold_set_at::text, ''),
           coalesce(j.n, 0), coalesce(j.at::text, ''), coalesce(j.h, 0),
           coalesce(s.n, 0), coalesce(s.holdout, 0), coalesce(s.at::text, ''), coalesce(s.roles, ''),
           coalesce(pr.n, 0), coalesce(pr.at::text, ''), coalesce(pr.decided_at::text, ''),
           coalesce(pr.decided, 0),
           coalesce(sk.n, 0), coalesce(sk.at::text, ''),
           coalesce(sc.n, 0), coalesce(sc.at::text, ''),
           coalesce(b.version, 0),
           coalesce(i.n, 0), coalesce(i.at::text, ''), coalesce(i.scored, 0), coalesce(i.gated, 0),
           coalesce(pu.n, 0), coalesce(pu.at::text, ''),
           coalesce(f.n, 0), coalesce(f.resolved, 0), coalesce(f.at::text, ''),
           coalesce(t.n, 0), coalesce(t.at::text, ''), coalesce(t.versions, ''),
           coalesce(r.n, 0), coalesce(r.at::text, ''), coalesce(r.superseded, 0),
           coalesce(r.superseded_at::text, '')
         )) AS fingerprint,
         greatest(p.created_at, j.at, s.at, pr.at, pr.decided_at, sk.at, sc.at, b.at, i.at, pu.at, f.at,
                  t.at, r.at, r.superseded_at) AS last_activity_at
    FROM workbench_projects p
    LEFT JOIN (SELECT project_id, count(*) AS n, max(updated_at) AS at,
                      sum(hashtext(id::text || status::text)) AS h
                 FROM jobs WHERE project_id IS NOT NULL GROUP BY project_id) j
      ON j.project_id = p.id
    LEFT JOIN (SELECT project_id, count(*) AS n, count(*) FILTER (WHERE role = 'holdout') AS holdout,
                      max(created_at) AS at, string_agg(id::text || role, ',' ORDER BY id) AS roles
                 FROM workbench_samples GROUP BY project_id) s
      ON s.project_id = p.id
    LEFT JOIN (SELECT project_id, count(*) AS n, max(created_at) AS at,
                      max(decided_at) AS decided_at, count(decision) AS decided
                 FROM workbench_proposals GROUP BY project_id) pr
      ON pr.project_id = p.id
    LEFT JOIN (SELECT project_id, count(*) AS n, max(skipped_at) AS at
                 FROM workbench_stage_skips GROUP BY project_id) sk
      ON sk.project_id = p.id
    LEFT JOIN (SELECT project_id, count(*) AS n, max(confirmed_at) AS at
                 FROM workbench_stage_confirms GROUP BY project_id) sc
      ON sc.project_id = p.id
    LEFT JOIN (SELECT project_id, max(version) AS version, max(created_at) AS at
                 FROM workbench_briefs GROUP BY project_id) b
      ON b.project_id = p.id
    LEFT JOIN (SELECT project_id, count(*) AS n, max(created_at) AS at, count(scores) AS scored,
                      count(gate_cache) AS gated
                 FROM workbench_iterations GROUP BY project_id) i
      ON i.project_id = p.id
    LEFT JOIN (SELECT project_id, count(*) AS n, max(published_at) AS at
                 FROM workbench_publications GROUP BY project_id) pu
      ON pu.project_id = p.id
    LEFT JOIN (SELECT project_id, count(*) AS n, count(resolved_by) AS resolved,
                      max(created_at) AS at
                 FROM workbench_feedback GROUP BY project_id) f
      ON f.project_id = p.id
    LEFT JOIN (SELECT id, count(*) AS n, max(updated_at) AS at,
                      string_agg(version || status, ',' ORDER BY version) AS versions
                 FROM templates GROUP BY id) t
      ON t.id = p.id
    LEFT JOIN (SELECT template_id, count(*) AS n, max(created_at) AS at,
                      count(superseded_at) AS superseded, max(superseded_at) AS superseded_at
                 FROM template_references GROUP BY template_id) r
      ON r.template_id = p.id
   ORDER BY p.id`;

/** Postgres adapter (migration 0008). */
export class PgWorkbenchRepo implements WorkbenchRepo {
  constructor(private readonly pool: pg.Pool) {}

  async listProjects() {
    const { rows } = await this.pool.query<ProjectRow>(
      'SELECT * FROM workbench_projects ORDER BY id',
    );
    return rows.map(toProject);
  }

  async getProject(id: string) {
    const { rows } = await this.pool.query<ProjectRow>(
      'SELECT * FROM workbench_projects WHERE id = $1',
      [id],
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async setPublishThreshold(id: string, threshold: number, actor: string | null) {
    const { rows } = await this.pool.query<ProjectRow>(
      `UPDATE workbench_projects
          SET publish_threshold = $2, threshold_set_by = $3, threshold_set_at = now()
        WHERE id = $1 RETURNING *`,
      [id, threshold, actor],
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async recordPublication(p: NewPublication) {
    return this.insertPublication(this.pool, p);
  }

  async publishDraft(input: PublishDraftInput): Promise<PublishDraftResult> {
    const client = await this.pool.connect();
    let failed: unknown = undefined;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{
        definition: Record<string, unknown>;
        status: string;
      }>('SELECT definition, status FROM templates WHERE id = $1 AND version = $2 FOR UPDATE', [
        input.projectId,
        input.version,
      ]);
      const row = rows[0];
      const refused: PublishDraftResult | null =
        row?.status !== 'draft'
          ? { result: 'not-draft' }
          : stableJson(row.definition) !== stableJson(input.definition)
            ? { result: 'changed' }
            : null;
      if (refused) {
        await client.query('ROLLBACK');
        return refused;
      }
      // Twin of PgTemplateRepo.publish (apps/api/src/templates/repo.ts): keep the two in step.
      await client.query(
        `UPDATE templates SET status = 'published', published_at = now(), updated_at = now()
          WHERE id = $1 AND version = $2 AND status = 'draft'`,
        [input.projectId, input.version],
      );
      const publication = await this.insertPublication(client, input.publication);
      await client.query('COMMIT');
      return { result: 'published', publication };
    } catch (err) {
      failed = err;
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      // A client whose transaction failed is discarded rather than returned to the pool.
      client.release(failed instanceof Error ? failed : undefined);
    }
  }

  private async insertPublication(db: pg.Pool | pg.PoolClient, p: NewPublication) {
    const { rows } = await db.query<PublicationRow>(
      `INSERT INTO workbench_publications
         (project_id, version, iteration_id, score, threshold, override_reason, published_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        p.projectId,
        p.version,
        p.iterationId,
        p.score,
        p.threshold,
        p.overrideReason,
        p.publishedBy,
      ],
    );
    return toPublication(rows[0]!);
  }

  async listPublications(projectId: string) {
    const { rows } = await this.pool.query<PublicationRow>(
      `SELECT * FROM workbench_publications WHERE project_id = $1
        ORDER BY published_at DESC, id DESC`,
      [projectId],
    );
    return rows.map(toPublication);
  }

  async createProject(id: string, name: string) {
    const { rows } = await this.pool.query<ProjectRow>(
      `INSERT INTO workbench_projects (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [id, name],
    );
    if (!rows[0]) throw new WorkbenchConflictError(`project ${id} already exists`);
    return toProject(rows[0]);
  }

  async addSample(sample: NewSample) {
    try {
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO workbench_samples (project_id, document_id, role, added_for_version)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [sample.projectId, sample.documentId, sample.role, sample.addedForVersion],
      );
      return (await this.sample(rows[0]!.id))!;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new WorkbenchConflictError(
          `document ${sample.documentId} is already a sample of ${sample.projectId}`,
        );
      }
      throw err;
    }
  }

  async listSamples(projectId: string) {
    const { rows } = await this.pool.query<SampleRow>(
      `${SAMPLE_SELECT} WHERE s.project_id = $1 ORDER BY s.created_at, s.id`,
      [projectId],
    );
    return rows.map(toSample);
  }

  async setSampleRole(projectId: string, sampleId: string, role: SampleRole) {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE workbench_samples SET role = $3 WHERE project_id = $1 AND id = $2 RETURNING id`,
      [projectId, sampleId, role],
    );
    return rows[0] ? this.sample(rows[0].id) : null;
  }

  async removeSample(projectId: string, sampleId: string) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM workbench_samples WHERE project_id = $1 AND id = $2',
      [projectId, sampleId],
    );
    return (rowCount ?? 0) > 0;
  }

  async latestBrief(projectId: string) {
    const { rows } = await this.pool.query<BriefRow>(
      `SELECT * FROM workbench_briefs WHERE project_id = $1 ORDER BY version DESC LIMIT 1`,
      [projectId],
    );
    return rows[0] ? toBrief(rows[0]) : null;
  }

  async saveBrief(projectId: string, body: BriefBody) {
    const { rows } = await this.pool.query<BriefRow>(
      `INSERT INTO workbench_briefs (project_id, version, body)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2 FROM workbench_briefs WHERE project_id = $1
       RETURNING *`,
      [projectId, JSON.stringify(body)],
    );
    return toBrief(rows[0]!);
  }

  async listBriefs(projectId: string) {
    const { rows } = await this.pool.query<BriefRow>(
      `SELECT * FROM workbench_briefs WHERE project_id = $1 ORDER BY version`,
      [projectId],
    );
    return rows.map(toBrief);
  }

  async getBrief(projectId: string, version: number) {
    const { rows } = await this.pool.query<BriefRow>(
      `SELECT * FROM workbench_briefs WHERE project_id = $1 AND version = $2`,
      [projectId, version],
    );
    return rows[0] ? toBrief(rows[0]) : null;
  }

  async setDataPolicy(id: string, policy: DataPolicy, by: string | null) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ProjectRow>(
        `UPDATE workbench_projects SET data_policy = $2, data_policy_changed_at = now(),
                data_policy_changed_by = $3 WHERE id = $1 RETURNING *`,
        [id, policy, by],
      );
      if (rows[0] && policy === 'local') {
        // Revocation reaches jobs already created (retries and step re-runs reuse their row).
        // Never the reverse. Segment previews are skipped: no model call, and their params are
        // validated strictly by the worker (SegmentParams, extra="forbid").
        await client.query(
          `UPDATE jobs SET params = jsonb_set(COALESCE(params, '{}'::jsonb), '{dataPolicy}', '"local"')
            WHERE project_id = $1 AND task <> 'segment'`,
          [id],
        );
      }
      await client.query('COMMIT');
      return rows[0] ? toProject(rows[0]) : null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createProposal(p: NewProposal) {
    const { rows } = await this.pool.query<ProposalRow>(
      `INSERT INTO workbench_proposals (id, project_id, stage, brief_version, base_version, base_definition, feedback_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        p.id,
        p.projectId,
        p.stage,
        p.briefVersion,
        p.baseVersion ?? null,
        p.baseDefinition ? JSON.stringify(p.baseDefinition) : null,
        p.feedbackIds ?? null,
      ],
    );
    return toProposal(rows[0]!);
  }

  async listProposals(projectId: string) {
    const { rows } = await this.pool.query<ProposalRow>(
      `SELECT * FROM workbench_proposals WHERE project_id = $1 ORDER BY created_at DESC, id DESC`,
      [projectId],
    );
    return rows.map(toProposal);
  }

  async decideProposal(
    projectId: string,
    id: string,
    decision: ProposalDecision,
    acceptedChanges?: number[] | null,
  ) {
    const { rows } = await this.pool.query<ProposalRow>(
      `UPDATE workbench_proposals SET decision = $3, accepted_changes = $4, decided_at = now()
        WHERE project_id = $1 AND id = $2 AND decision IS NULL RETURNING *`,
      [projectId, id, decision, acceptedChanges ?? null],
    );
    return rows[0] ? toProposal(rows[0]) : null;
  }

  async createFeedback(f: Omit<FeedbackItem, 'id' | 'createdAt' | 'resolvedBy'>) {
    const { rows } = await this.pool.query<FeedbackRow>(
      `INSERT INTO workbench_feedback (project_id, target, target_id, sample_id, iteration_id, body)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [f.projectId, f.target, f.targetId, f.sampleId, f.iterationId, f.body],
    );
    return toFeedback(rows[0]!);
  }

  async listFeedback(projectId: string) {
    const { rows } = await this.pool.query<FeedbackRow>(
      'SELECT * FROM workbench_feedback WHERE project_id = $1 ORDER BY created_at DESC, id DESC',
      [projectId],
    );
    return rows.map(toFeedback);
  }

  async deleteFeedback(projectId: string, id: string) {
    // Delete first, then explain a miss: a revision accepted concurrently can resolve the item
    // between any read and the delete, and then nothing may be deleted.
    const { rowCount } = await this.pool.query(
      'DELETE FROM workbench_feedback WHERE project_id = $1 AND id = $2 AND resolved_by IS NULL',
      [projectId, id],
    );
    if (rowCount) return 'deleted' as const;
    const { rows } = await this.pool.query<{ resolved_by: string | null }>(
      'SELECT resolved_by FROM workbench_feedback WHERE project_id = $1 AND id = $2',
      [projectId, id],
    );
    return rows[0] ? ('resolved' as const) : ('not-found' as const);
  }

  async resolveFeedback(projectId: string, ids: string[], proposalId: string) {
    if (!ids.length) return;
    await this.pool.query(
      `UPDATE workbench_feedback SET resolved_by = $3
        WHERE project_id = $1 AND id = ANY($2::uuid[]) AND resolved_by IS NULL`,
      [projectId, ids, proposalId],
    );
  }

  async addSkip(projectId: string, stage: DraftStage) {
    const { rows } = await this.pool.query<SkipRow>(
      `INSERT INTO workbench_stage_skips (project_id, stage) VALUES ($1, $2)
       RETURNING project_id, stage, skipped_at`,
      [projectId, stage],
    );
    return toSkip(rows[0]!);
  }

  async listSkips(projectId: string) {
    const { rows } = await this.pool.query<SkipRow>(
      `SELECT project_id, stage, skipped_at FROM workbench_stage_skips
        WHERE project_id = $1 ORDER BY skipped_at DESC, id DESC`,
      [projectId],
    );
    return rows.map(toSkip);
  }

  async addConfirm(projectId: string, stage: KeepableStage, upTo: string) {
    const { rows } = await this.pool.query<ConfirmRow>(
      `INSERT INTO workbench_stage_confirms (project_id, stage, up_to) VALUES ($1, $2, $3)
       RETURNING project_id, stage, up_to, confirmed_at`,
      [projectId, stage, upTo],
    );
    return toConfirm(rows[0]!);
  }

  async listConfirms(projectId: string) {
    const { rows } = await this.pool.query<ConfirmRow>(
      `SELECT project_id, stage, up_to, confirmed_at FROM workbench_stage_confirms
        WHERE project_id = $1 ORDER BY confirmed_at DESC, id DESC`,
      [projectId],
    );
    return rows.map(toConfirm);
  }

  async createIteration(i: NewIteration) {
    const { rows } = await this.pool.query<IterationRow>(
      `INSERT INTO workbench_iterations
         (project_id, template_version, definition, brief_version, eval_set, model, job_ids,
          group_id, uncached, sample_shas)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        i.projectId,
        i.templateVersion,
        JSON.stringify(i.definition),
        i.briefVersion,
        i.set,
        i.model,
        i.jobIds,
        i.groupId ?? null,
        i.uncached ?? false,
        i.sampleShas ?? null,
      ],
    );
    return toIteration(rows[0]!);
  }

  async listIterations(projectId: string) {
    const { rows } = await this.pool.query<IterationRow>(
      'SELECT * FROM workbench_iterations WHERE project_id = $1 ORDER BY created_at DESC, id DESC',
      [projectId],
    );
    return rows.map(toIteration);
  }

  async getIteration(projectId: string, id: string) {
    const { rows } = await this.pool.query<IterationRow>(
      'SELECT * FROM workbench_iterations WHERE project_id = $1 AND id = $2',
      [projectId, id],
    );
    return rows[0] ? toIteration(rows[0]) : null;
  }

  async listGroup(projectId: string, groupId: string) {
    const { rows } = await this.pool.query<IterationRow>(
      `SELECT * FROM workbench_iterations WHERE project_id = $1 AND group_id = $2
        ORDER BY created_at, id`,
      [projectId, groupId],
    );
    return rows.map(toIteration);
  }

  async setIterationScores(id: string, scores: NonNullable<IterationRecord['scores']>) {
    await this.pool.query('UPDATE workbench_iterations SET scores = $2 WHERE id = $1', [
      id,
      JSON.stringify(scores),
    ]);
  }

  async setGateCache(iterationId: string, cache: NonNullable<IterationRecord['gateCache']>) {
    await this.pool.query('UPDATE workbench_iterations SET gate_cache = $2 WHERE id = $1', [
      iterationId,
      JSON.stringify(cache),
    ]);
  }

  async deleteProject(id: string): Promise<RemovedProject | 'published' | null> {
    const client = await this.pool.connect();
    let failed: unknown = undefined;
    try {
      await client.query('BEGIN');
      // The template rows first, then the project: publishDraft takes the same order (its
      // template row, then the project through the publication's FK), so the two cannot
      // deadlock. A publish that commits first is seen here; one that waits finds no row.
      const versions = await client.query<{ version: number; status: string }>(
        'SELECT version, status FROM templates WHERE id = $1 ORDER BY version FOR UPDATE',
        [id],
      );
      const found = await client.query(
        'SELECT 1 FROM workbench_projects WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      if (versions.rows.some((v) => v.status === 'published')) {
        await client.query('ROLLBACK');
        return 'published';
      }
      // The project's jobs, and the type's project-less test jobs (Templates-page test uploads
      // and regression runs of a type that was never published).
      const owned = `j.project_id = $1
         OR (j.project_id IS NULL AND j.test
             AND EXISTS (SELECT 1 FROM documents d WHERE d.id = j.document_id AND d.spec_id = $1))`;
      const outputs = await client.query<{
        id: string;
        bucket: string | null;
        object_key: string | null;
      }>(
        `SELECT j.id, o.bucket, o.object_key
           FROM jobs j LEFT JOIN job_outputs o ON o.job_id = j.id AND o.stage = 'draft'
          WHERE ${owned}
          ORDER BY j.created_at, j.id`,
        [id],
      );
      const jobs = new Map<string, RemovedJob>();
      for (const r of outputs.rows) {
        const job = jobs.get(r.id) ?? { jobId: r.id, draftObjects: [], inboxObject: null };
        if (r.bucket !== null && r.object_key !== null) {
          job.draftObjects.push({ bucket: r.bucket, key: r.object_key });
        }
        jobs.set(r.id, job);
      }
      // Children first (FKs from migrations 0008-0016). Feedback points at proposals and
      // iterations, publications at iterations, proposals at jobs.
      for (const table of [
        'workbench_feedback',
        'workbench_publications',
        'workbench_iterations',
        'workbench_proposals',
        'workbench_stage_skips',
        'workbench_stage_confirms',
        'workbench_briefs',
        'workbench_samples',
      ]) {
        await client.query(`DELETE FROM ${table} WHERE project_id = $1`, [id]);
      }
      // job_events, job_outputs, review_edits and step_runs cascade (0001, 0002, 0004); other
      // jobs' reference_id and references' source_job_id are set null (0005).
      await client.query(`DELETE FROM jobs j WHERE ${owned}`, [id]);
      // Other jobs' reference_id and copies' copied_from are set null (0005, 0018).
      await client.query('DELETE FROM template_references WHERE template_id = $1', [id]);
      const docs = await client.query<{ bucket: string; object_key: string }>(
        `DELETE FROM documents d WHERE d.spec_id = $1
            AND NOT EXISTS (SELECT 1 FROM jobs WHERE document_id = d.id)
            AND NOT EXISTS (SELECT 1 FROM template_references WHERE document_id = d.id)
            AND NOT EXISTS (SELECT 1 FROM workbench_samples WHERE document_id = d.id)
          RETURNING d.bucket, d.object_key`,
        [id],
      );
      const documents: StoredObject[] = [];
      for (const d of docs.rows) {
        if (documents.some((o) => o.bucket === d.bucket && o.key === d.object_key)) continue;
        const shared = await client.query(
          'SELECT 1 FROM documents WHERE bucket = $1 AND object_key = $2 LIMIT 1',
          [d.bucket, d.object_key],
        );
        if (!shared.rowCount) documents.push({ bucket: d.bucket, key: d.object_key });
      }
      await client.query('DELETE FROM workbench_projects WHERE id = $1', [id]);
      await client.query(`DELETE FROM templates WHERE id = $1 AND status = 'draft'`, [id]);
      await client.query('COMMIT');
      return { jobs: [...jobs.values()], documents };
    } catch (err) {
      failed = err;
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release(failed instanceof Error ? failed : undefined);
    }
  }

  async projectFingerprints(): Promise<ProjectFingerprint[]> {
    const { rows } = await this.pool.query<{
      id: string;
      fingerprint: string;
      last_activity_at: Date;
    }>(FINGERPRINT_SQL);
    return rows.map((r) => ({
      id: r.id,
      fingerprint: r.fingerprint,
      lastActivityAt: r.last_activity_at.toISOString(),
    }));
  }

  async listCache() {
    const { rows } = await this.pool.query<{
      project_id: string;
      fingerprint: string;
      item: unknown;
    }>('SELECT project_id, fingerprint, item FROM workbench_list_cache');
    return new Map(rows.map((r) => [r.project_id, { fingerprint: r.fingerprint, item: r.item }]));
  }

  async putListCache(projectId: string, fingerprint: string, item: unknown) {
    try {
      await this.pool.query(
        `INSERT INTO workbench_list_cache (project_id, fingerprint, item)
         SELECT id, $2, $3 FROM workbench_projects WHERE id = $1
         ON CONFLICT (project_id) DO UPDATE
           SET fingerprint = EXCLUDED.fingerprint, item = EXCLUDED.item, computed_at = now()`,
        [projectId, fingerprint, JSON.stringify(item)],
      );
    } catch (err) {
      // The project was deleted between the read and the insert: nothing to cache.
      if ((err as { code?: string }).code !== '23503') throw err;
    }
  }

  async listPins(owner: string) {
    const { rows } = await this.pool.query<{ project_id: string }>(
      `SELECT project_id FROM workbench_pins WHERE owner = $1
        ORDER BY pinned_at DESC, project_id`,
      [owner],
    );
    return rows.map((r) => r.project_id);
  }

  async pin(owner: string, projectId: string) {
    try {
      const { rows } = await this.pool.query<{ found: boolean }>(
        `WITH project AS (SELECT id FROM workbench_projects WHERE id = $2),
              pinned AS (
                INSERT INTO workbench_pins (owner, project_id) SELECT $1, id FROM project
                ON CONFLICT (owner, project_id) DO NOTHING)
         SELECT EXISTS (SELECT 1 FROM project) AS found`,
        [owner, projectId],
      );
      return rows[0]!.found;
    } catch (err) {
      if ((err as { code?: string }).code === '23503') return false; // deleted meanwhile
      throw err;
    }
  }

  async unpin(owner: string, projectId: string) {
    await this.pool.query('DELETE FROM workbench_pins WHERE owner = $1 AND project_id = $2', [
      owner,
      projectId,
    ]);
  }

  private async sample(id: string) {
    const { rows } = await this.pool.query<SampleRow>(`${SAMPLE_SELECT} WHERE s.id = $1`, [id]);
    return rows[0] ? toSample(rows[0]) : null;
  }
}
