import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { BriefBodySchema } from '@ih/shared';
import type {
  Brief,
  BriefBody,
  DataPolicy,
  DraftStage,
  SampleRole,
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
  decision: 'accepted' | 'rejected' | null;
  decidedAt: string | null;
  createdAt: string;
}

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
  createProposal(p: {
    id: string;
    projectId: string;
    stage: DraftStage;
    briefVersion: number | null;
  }): Promise<ProposalRecord>;
  /** Newest first. */
  listProposals(projectId: string): Promise<ProposalRecord[]>;
  /** Null when the proposal is unknown, belongs to another project, or is already decided. */
  decideProposal(
    projectId: string,
    id: string,
    decision: 'accepted' | 'rejected',
  ): Promise<ProposalRecord | null>;
}

/** In-memory adapter: reads documents from, and pins them in, the MemoryRepo it's given. */
export class MemoryWorkbenchRepo implements WorkbenchRepo {
  readonly projects = new Map<string, WorkbenchProject>();
  readonly samples = new Map<string, NewSample & { id: string; createdAt: string }>();
  readonly briefs: Brief[] = [];
  readonly proposals: ProposalRecord[] = [];

  constructor(private readonly jobs: MemoryRepo) {}

  async listProjects() {
    return [...this.projects.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async getProject(id: string) {
    return this.projects.get(id) ?? null;
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

  async createProposal(p: {
    id: string;
    projectId: string;
    stage: DraftStage;
    briefVersion: number | null;
  }) {
    const record: ProposalRecord = {
      ...p,
      decision: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.proposals.push(record);
    return record;
  }

  async listProposals(projectId: string) {
    // Insertion order, newest first: timestamps can tie within a millisecond.
    return this.proposals.filter((p) => p.projectId === projectId).reverse();
  }

  async decideProposal(projectId: string, id: string, decision: 'accepted' | 'rejected') {
    const index = this.proposals.findIndex((p) => p.id === id);
    const current = this.proposals[index];
    if (current?.projectId !== projectId || current.decision !== null) return null;
    const decided: ProposalRecord = {
      ...current,
      decision,
      decidedAt: new Date().toISOString(),
    };
    this.proposals[index] = decided;
    return decided;
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
  decision: 'accepted' | 'rejected' | null;
  decided_at: Date | null;
  created_at: Date;
}

const toProposal = (r: ProposalRow): ProposalRecord => ({
  id: r.id,
  projectId: r.project_id,
  stage: r.stage,
  briefVersion: r.brief_version,
  decision: r.decision,
  decidedAt: r.decided_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
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

  async createProposal(p: {
    id: string;
    projectId: string;
    stage: DraftStage;
    briefVersion: number | null;
  }) {
    const { rows } = await this.pool.query<ProposalRow>(
      `INSERT INTO workbench_proposals (id, project_id, stage, brief_version)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [p.id, p.projectId, p.stage, p.briefVersion],
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

  async decideProposal(projectId: string, id: string, decision: 'accepted' | 'rejected') {
    const { rows } = await this.pool.query<ProposalRow>(
      `UPDATE workbench_proposals SET decision = $3, decided_at = now()
        WHERE project_id = $1 AND id = $2 AND decision IS NULL RETURNING *`,
      [projectId, id, decision],
    );
    return rows[0] ? toProposal(rows[0]) : null;
  }

  private async sample(id: string) {
    const { rows } = await this.pool.query<SampleRow>(`${SAMPLE_SELECT} WHERE s.id = $1`, [id]);
    return rows[0] ? toSample(rows[0]) : null;
  }
}
