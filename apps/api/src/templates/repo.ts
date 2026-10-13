import type pg from 'pg';
import { z } from 'zod';
import type { TemplateChange, TemplateChangeInput } from '@ih/shared';

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

/** What a draft write records besides the definition (TP1). */
export interface DraftWrite {
  /** The change log entry; nothing is logged without one. */
  change?: TemplateChangeInput;
  /** The `updatedAt` the edit started from: a draft written since is not overwritten (null). */
  expectedUpdatedAt?: string;
}

/** Persistence for document templates (source of truth; files are only seed/import input). */
export interface TemplateRepo {
  list(): Promise<TemplateRecord[]>;
  get(id: string, version: number): Promise<TemplateRecord | null>;
  latestPublished(id: string): Promise<TemplateRecord | null>;
  /** Throws TemplateConflictError when the version exists. `change` is logged for drafts only. */
  create(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    status: TemplateStatus,
    change?: TemplateChangeInput,
  ): Promise<TemplateRecord>;
  /**
   * Null unless the version exists, is a draft and (with `expectedUpdatedAt`) was not written
   * since; then nothing is written. The change is logged in the same write.
   */
  updateDraft(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    write?: DraftWrite,
  ): Promise<TemplateRecord | null>;
  publish(id: string, version: number): Promise<TemplateRecord | null>;
  /** Deletes the draft and its change log. */
  deleteDraft(id: string, version: number): Promise<boolean>;
  /** The version's change log, newest first (migration 0029). */
  listChanges(id: string, version: number): Promise<TemplateChange[]>;
}

const byIdVersion = (a: TemplateRecord, b: TemplateRecord) =>
  a.id.localeCompare(b.id) || a.version - b.version;

export class MemoryTemplateRepo implements TemplateRepo {
  readonly records = new Map<string, TemplateRecord>();
  /** The change log (template_changes), oldest first. */
  readonly changes: (TemplateChange & { templateId: string })[] = [];
  private changeSeq = 0;
  private lastTime = 0;
  private key = (id: string, version: number) => `${id}@${version}`;

  /** Strictly increasing, so a stale `expectedUpdatedAt` is always detected. */
  private now(): string {
    this.lastTime = Math.max(Date.now(), this.lastTime + 1);
    return new Date(this.lastTime).toISOString();
  }

  private log(id: string, version: number, at: string, change?: TemplateChangeInput) {
    if (change) {
      this.changes.push({ ...change, templateId: id, version, at, id: String(++this.changeSeq) });
    }
  }

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
    change?: TemplateChangeInput,
  ) {
    if (this.records.has(this.key(id, version))) {
      throw new TemplateConflictError(`${id} v${version} already exists`);
    }
    const now = this.now();
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
    if (status === 'draft') this.log(id, version, now, change);
    return record;
  }

  async updateDraft(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    write: DraftWrite = {},
  ) {
    const record = await this.get(id, version);
    if (record?.status !== 'draft') return null;
    if (write.expectedUpdatedAt !== undefined && write.expectedUpdatedAt !== record.updatedAt) {
      return null;
    }
    const updated = { ...record, definition, updatedAt: this.now() };
    this.records.set(this.key(id, version), updated);
    this.log(id, version, updated.updatedAt, write.change);
    return updated;
  }

  async publish(id: string, version: number) {
    const record = await this.get(id, version);
    if (record?.status !== 'draft') return null;
    const now = this.now();
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
    // ON DELETE CASCADE (migration 0029).
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const c = this.changes[i]!;
      if (c.templateId === id && c.version === version) this.changes.splice(i, 1);
    }
    return this.records.delete(this.key(id, version));
  }

  async listChanges(id: string, version: number): Promise<TemplateChange[]> {
    return this.changes
      .filter((c) => c.templateId === id && c.version === version)
      .sort((a, b) => Number(b.id) - Number(a.id))
      .map((c) => {
        const change: Partial<typeof c> = { ...c };
        delete change.templateId;
        return change as TemplateChange;
      });
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

interface ChangeRow {
  id: string; // bigint
  version: number;
  at: Date;
  source: TemplateChange['source'];
  stage: TemplateChange['stage'];
  proposal_id: string | null;
  summary: string;
  diff: string[];
  created_by: string | null;
}

const toChange = (r: ChangeRow): TemplateChange => ({
  id: String(r.id),
  version: r.version,
  at: r.at.toISOString(),
  source: r.source,
  stage: r.stage,
  proposalId: r.proposal_id,
  summary: r.summary,
  diff: r.diff,
  by: r.created_by,
});

/**
 * Logs `$5…$10` (source, stage, proposal id, summary, diff, by) for the row the CTE `from` wrote,
 * in the same statement; nothing when `$5` is null or the write matched no row.
 */
const LOG_CHANGE = (from: string) => `INSERT INTO template_changes
    (template_id, version, source, stage, proposal_id, summary, diff, created_by)
  SELECT ${from}.id, ${from}.version, $5, $6, $7::uuid, $8, $9::jsonb, $10
    FROM ${from} WHERE $5::text IS NOT NULL`;

const changeParams = (c: TemplateChangeInput | undefined) => [
  c?.source ?? null,
  c?.stage ?? null,
  c?.proposalId ?? null,
  c?.summary ?? null,
  JSON.stringify(c?.diff ?? []),
  c?.by ?? null,
];

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
    change?: TemplateChangeInput,
  ) {
    const record = await this.one(
      `WITH t AS (
         INSERT INTO templates (id, version, status, definition, published_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'published' THEN now() END)
         ON CONFLICT (id, version) DO NOTHING RETURNING *),
       c AS (${LOG_CHANGE('t')})
       SELECT * FROM t`,
      [
        id,
        version,
        status,
        JSON.stringify(definition),
        ...changeParams(status === 'draft' ? change : undefined),
      ],
    );
    if (!record) throw new TemplateConflictError(`${id} v${version} already exists`);
    return record;
  }

  async updateDraft(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    write: DraftWrite = {},
  ) {
    // updated_at keeps microseconds; the ISO strings the API hands out keep milliseconds
    // (node-postgres truncates), so the base is compared truncated to the millisecond.
    return this.one(
      `WITH u AS (
         UPDATE templates SET definition = $3, updated_at = now()
          WHERE id = $1 AND version = $2 AND status = 'draft'
            AND ($4::timestamptz IS NULL
                 OR date_trunc('milliseconds', updated_at) = $4::timestamptz)
         RETURNING *),
       c AS (${LOG_CHANGE('u')})
       SELECT * FROM u`,
      [
        id,
        version,
        JSON.stringify(definition),
        write.expectedUpdatedAt ?? null,
        ...changeParams(write.change),
      ],
    );
  }

  async listChanges(id: string, version: number) {
    const { rows } = await this.pool.query<ChangeRow>(
      `SELECT id, version, at, source, stage, proposal_id, summary, diff, created_by
         FROM template_changes WHERE template_id = $1 AND version = $2 ORDER BY id DESC`,
      [id, version],
    );
    return rows.map(toChange);
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
