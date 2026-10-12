import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { BriefBodySchema } from '@ih/shared';
import type {
  Brief,
  BriefBody,
  DataPolicy,
  DraftStage,
  EvaluationModel,
  FeedbackItem,
  ProposalDecision,
  SampleRole,
  StageSkip,
  WorkbenchProject,
} from '@ih/shared';
import type { MemoryRepo } from '../repositories/memory.js';

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
  set: 'dev';
  model: EvaluationModel | null;
  jobIds: string[];
  /** Shared by the iterations of one model comparison. */
  groupId: string | null;
  /** The jobs were told not to read the step cache. */
  uncached: boolean;
  /** Cached summary once every job has finished; null while running. */
  scores: { score: number | null; completed: number; total: number } | null;
  createdAt: string;
}

export type NewIteration = Omit<
  IterationRecord,
  'id' | 'scores' | 'createdAt' | 'groupId' | 'uncached'
> &
  Partial<Pick<IterationRecord, 'groupId' | 'uncached'>>;

export class WorkbenchConflictError extends Error {}

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
  /** Null when the project is unknown. `by` is the actor who changed it. */
  setDataPolicy(
    id: string,
    policy: DataPolicy,
    by: string | null,
  ): Promise<WorkbenchProject | null>;
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
  createIteration(input: NewIteration): Promise<IterationRecord>;
  /** Newest first. */
  listIterations(projectId: string): Promise<IterationRecord[]>;
  getIteration(projectId: string, id: string): Promise<IterationRecord | null>;
  /** The iterations of one model comparison, oldest first. */
  listGroup(projectId: string, groupId: string): Promise<IterationRecord[]>;
  setIterationScores(id: string, scores: NonNullable<IterationRecord['scores']>): Promise<void>;
}

/** In-memory adapter: reads documents from, and pins them in, the MemoryRepo it's given. */
export class MemoryWorkbenchRepo implements WorkbenchRepo {
  readonly projects = new Map<string, WorkbenchProject>();
  readonly samples = new Map<string, NewSample & { id: string; createdAt: string }>();
  readonly briefs: Brief[] = [];
  readonly proposals: ProposalRecord[] = [];
  readonly skips: StageSkipRecord[] = [];
  readonly iterations: IterationRecord[] = [];
  readonly feedback: FeedbackItem[] = [];

  constructor(private readonly jobs: MemoryRepo) {}

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
      createdAt: new Date().toISOString(),
      dataPolicy: 'local',
      dataPolicyChangedAt: null,
      dataPolicyChangedBy: null,
    };
    this.projects.set(id, project);
    return project;
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
    const row = { ...sample, id: randomUUID(), createdAt: new Date().toISOString() };
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
    const brief = { projectId, version, body, createdAt: new Date().toISOString() };
    this.briefs.push(brief);
    return brief;
  }

  async setDataPolicy(id: string, policy: DataPolicy, by: string | null) {
    const project = this.projects.get(id);
    if (!project) return null;
    const updated: WorkbenchProject = {
      ...project,
      dataPolicy: policy,
      dataPolicyChangedAt: new Date().toISOString(),
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
      for (const job of this.jobs.draftJobs.values()) {
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

  async createIteration(input: NewIteration) {
    const record: IterationRecord = {
      ...input,
      groupId: input.groupId ?? null,
      uncached: input.uncached ?? false,
      id: randomUUID(),
      scores: null,
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

interface IterationRow {
  id: string;
  project_id: string;
  template_version: number;
  definition: Record<string, unknown>;
  brief_version: number | null;
  eval_set: 'dev';
  model: EvaluationModel | null;
  job_ids: string[];
  group_id: string | null;
  uncached: boolean;
  scores: IterationRecord['scores'];
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
  groupId: r.group_id,
  uncached: r.uncached,
  scores: r.scores,
  createdAt: r.created_at.toISOString(),
});

const toSkip = (r: SkipRow): StageSkipRecord => ({
  projectId: r.project_id,
  stage: r.stage,
  skippedAt: r.skipped_at.toISOString(),
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

const toProject = (r: ProjectRow): WorkbenchProject => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at.toISOString(),
  dataPolicy: r.data_policy,
  dataPolicyChangedAt: r.data_policy_changed_at?.toISOString() ?? null,
  dataPolicyChangedBy: r.data_policy_changed_by,
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
    const { rows } = await this.pool.query<{ resolved_by: string | null }>(
      'SELECT resolved_by FROM workbench_feedback WHERE project_id = $1 AND id = $2',
      [projectId, id],
    );
    if (!rows[0]) return 'not-found' as const;
    if (rows[0].resolved_by) return 'resolved' as const;
    await this.pool.query(
      'DELETE FROM workbench_feedback WHERE project_id = $1 AND id = $2 AND resolved_by IS NULL',
      [projectId, id],
    );
    return 'deleted' as const;
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

  async createIteration(i: NewIteration) {
    const { rows } = await this.pool.query<IterationRow>(
      `INSERT INTO workbench_iterations
         (project_id, template_version, definition, brief_version, eval_set, model, job_ids,
          group_id, uncached)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
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

  private async sample(id: string) {
    const { rows } = await this.pool.query<SampleRow>(`${SAMPLE_SELECT} WHERE s.id = $1`, [id]);
    return rows[0] ? toSample(rows[0]) : null;
  }
}
