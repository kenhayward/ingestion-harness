import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Brief, BriefBody, SampleRole, WorkbenchProject } from '@ih/shared';
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
}

/** In-memory adapter: reads documents from, and pins them in, the MemoryRepo it's given. */
export class MemoryWorkbenchRepo implements WorkbenchRepo {
  readonly projects = new Map<string, WorkbenchProject>();
  readonly samples = new Map<string, NewSample & { id: string; createdAt: string }>();
  readonly briefs: Brief[] = [];

  constructor(private readonly jobs: MemoryRepo) {}

  async listProjects() {
    return [...this.projects.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async getProject(id: string) {
    return this.projects.get(id) ?? null;
  }

  async createProject(id: string, name: string) {
    if (this.projects.has(id)) throw new WorkbenchConflictError(`project ${id} already exists`);
    const project = { id, name, createdAt: new Date().toISOString() };
    this.projects.set(id, project);
    return project;
  }

  async addSample(sample: NewSample) {
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

const toProject = (r: ProjectRow): WorkbenchProject => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at.toISOString(),
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
  body: r.body,
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
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO workbench_samples (project_id, document_id, role, added_for_version)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [sample.projectId, sample.documentId, sample.role, sample.addedForVersion],
    );
    return (await this.sample(rows[0]!.id))!;
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

  private async sample(id: string) {
    const { rows } = await this.pool.query<SampleRow>(`${SAMPLE_SELECT} WHERE s.id = $1`, [id]);
    return rows[0] ? toSample(rows[0]) : null;
  }
}
