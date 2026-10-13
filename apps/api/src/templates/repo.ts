import type pg from 'pg';
import { z } from 'zod';

export const TemplateStatusSchema = z.enum(['draft', 'published']);
export type TemplateStatus = z.infer<typeof TemplateStatusSchema>;

export const TemplateRecordSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  status: TemplateStatusSchema,
  /** Stored as authored — drafts may be invalid while being edited. */
  definition: z
    .record(z.string(), z.unknown())
    .describe('The definition as authored: a draft may not be valid yet.'),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type TemplateRecord = z.infer<typeof TemplateRecordSchema>;

export class TemplateConflictError extends Error {}

/** Persistence for document templates (source of truth; files are only seed/import input). */
export interface TemplateRepo {
  list(): Promise<TemplateRecord[]>;
  get(id: string, version: number): Promise<TemplateRecord | null>;
  latestPublished(id: string): Promise<TemplateRecord | null>;
  /** Throws TemplateConflictError when the version exists. */
  create(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    status: TemplateStatus,
  ): Promise<TemplateRecord>;
  /** Null unless the version exists and is a draft. */
  updateDraft(
    id: string,
    version: number,
    definition: Record<string, unknown>,
  ): Promise<TemplateRecord | null>;
  publish(id: string, version: number): Promise<TemplateRecord | null>;
  deleteDraft(id: string, version: number): Promise<boolean>;
}

const byIdVersion = (a: TemplateRecord, b: TemplateRecord) =>
  a.id.localeCompare(b.id) || a.version - b.version;

export class MemoryTemplateRepo implements TemplateRepo {
  readonly records = new Map<string, TemplateRecord>();
  private key = (id: string, version: number) => `${id}@${version}`;

  async list() {
    return [...this.records.values()].sort(byIdVersion);
  }

  async get(id: string, version: number) {
    return this.records.get(this.key(id, version)) ?? null;
  }

  async latestPublished(id: string) {
    const published = (await this.list()).filter((r) => r.id === id && r.status === 'published');
    return published.at(-1) ?? null;
  }

  async create(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    status: TemplateStatus,
  ) {
    if (this.records.has(this.key(id, version))) {
      throw new TemplateConflictError(`${id} v${version} already exists`);
    }
    const now = new Date().toISOString();
    const record: TemplateRecord = {
      id,
      version,
      status,
      definition,
      createdAt: now,
      updatedAt: now,
      publishedAt: status === 'published' ? now : null,
    };
    this.records.set(this.key(id, version), record);
    return record;
  }

  async updateDraft(id: string, version: number, definition: Record<string, unknown>) {
    const record = await this.get(id, version);
    if (record?.status !== 'draft') return null;
    const updated = { ...record, definition, updatedAt: new Date().toISOString() };
    this.records.set(this.key(id, version), updated);
    return updated;
  }

  async publish(id: string, version: number) {
    const record = await this.get(id, version);
    if (record?.status !== 'draft') return null;
    const now = new Date().toISOString();
    const updated: TemplateRecord = {
      ...record,
      status: 'published',
      updatedAt: now,
      publishedAt: now,
    };
    this.records.set(this.key(id, version), updated);
    return updated;
  }

  async deleteDraft(id: string, version: number) {
    const record = await this.get(id, version);
    if (record?.status !== 'draft') return false;
    return this.records.delete(this.key(id, version));
  }
}

interface Row {
  id: string;
  version: number;
  status: TemplateStatus;
  definition: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
}

const toRecord = (r: Row): TemplateRecord => ({
  id: r.id,
  version: r.version,
  status: r.status,
  definition: r.definition,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  publishedAt: r.published_at ? r.published_at.toISOString() : null,
});

/** Postgres-backed (migration 0003; published rows are also protected by triggers). */
export class PgTemplateRepo implements TemplateRepo {
  constructor(private readonly pool: pg.Pool) {}

  private async one(sql: string, params: unknown[]) {
    const { rows } = await this.pool.query<Row>(sql, params);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list() {
    const { rows } = await this.pool.query<Row>('SELECT * FROM templates ORDER BY id, version');
    return rows.map(toRecord);
  }

  async get(id: string, version: number) {
    return this.one('SELECT * FROM templates WHERE id = $1 AND version = $2', [id, version]);
  }

  async latestPublished(id: string) {
    return this.one(
      `SELECT * FROM templates WHERE id = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`,
      [id],
    );
  }

  async create(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    status: TemplateStatus,
  ) {
    const record = await this.one(
      `INSERT INTO templates (id, version, status, definition, published_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'published' THEN now() END)
       ON CONFLICT (id, version) DO NOTHING RETURNING *`,
      [id, version, status, JSON.stringify(definition)],
    );
    if (!record) throw new TemplateConflictError(`${id} v${version} already exists`);
    return record;
  }

  async updateDraft(id: string, version: number, definition: Record<string, unknown>) {
    return this.one(
      `UPDATE templates SET definition = $3, updated_at = now()
        WHERE id = $1 AND version = $2 AND status = 'draft' RETURNING *`,
      [id, version, JSON.stringify(definition)],
    );
  }

  async publish(id: string, version: number) {
    return this.one(
      `UPDATE templates SET status = 'published', published_at = now(), updated_at = now()
        WHERE id = $1 AND version = $2 AND status = 'draft' RETURNING *`,
      [id, version],
    );
  }

  async deleteDraft(id: string, version: number) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM templates WHERE id = $1 AND version = $2 AND status = 'draft'`,
      [id, version],
    );
    return (rowCount ?? 0) > 0;
  }
}
