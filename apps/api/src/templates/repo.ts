import type pg from 'pg';
import { z } from 'zod';
import {
  VersionLabelSchema,
  type Retirement,
  type TemplateChange,
  type TemplateChangeInput,
  type VersionLabelBody,
} from '@ih/shared';

export const TemplateStatusSchema = z.enum(['draft', 'published']);
export type TemplateStatus = z.infer<typeof TemplateStatusSchema>;

export const ImportedFromSchema = z
  .object({
    instance: z.string(),
    typeId: z.string(),
    version: z.number().int().positive(),
    commit: z.string().nullable(),
  })
  .strict();
export type ImportedFrom = z.infer<typeof ImportedFromSchema>;

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
  /** Who published it (migration 0048); null for older versions and unattributed publishes. */
  publishedBy: z.string().nullable(),
  ...VersionLabelSchema.shape,
  /** Where the definition was imported from (migration 0049); null when written here. */
  importedFrom: ImportedFromSchema.nullable(),
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
  publish(id: string, version: number, by?: string | null): Promise<TemplateRecord | null>;
  /**
   * Sets the version's label and note (#144; a field left out is kept, null clears it), draft or
   * published, leaving `updatedAt` alone. Null when the version does not exist.
   */
  setLabel(
    id: string,
    version: number,
    body: VersionLabelBody,
    by: string | null,
  ): Promise<TemplateRecord | null>;
  /**
   * Records where a draft's definition came from (migration 0049), leaving `updatedAt` alone.
   * Null unless the version exists and is a draft.
   */
  setImportedFrom(
    id: string,
    version: number,
    value: ImportedFrom | null,
  ): Promise<TemplateRecord | null>;
  /** Deletes the draft and its change log. */
  deleteDraft(id: string, version: number): Promise<boolean>;
  /** The version's change log, newest first (migration 0029). */
  listChanges(id: string, version: number): Promise<TemplateChange[]>;
  /** Retired document types by id (migration 0030); a type is a recipe or a legacy spec. */
  listRetirements(): Promise<Map<string, Retirement>>;
  retirement(id: string): Promise<Retirement | null>;
  /** Retires the type; one already retired keeps its first retirement (`created` false). */
  retire(id: string, by: string | null): Promise<{ retirement: Retirement; created: boolean }>;
  /** False when the type was not retired. */
  unretire(id: string): Promise<boolean>;
}

const byIdVersion = (a: TemplateRecord, b: TemplateRecord) =>
  a.id.localeCompare(b.id) || a.version - b.version;

export class MemoryTemplateRepo implements TemplateRepo {
  readonly records = new Map<string, TemplateRecord>();
  /** The change log (template_changes), oldest first. */
  readonly changes: (TemplateChange & { templateId: string })[] = [];
  /** document_type_retirements, by type id. */
  readonly retirements = new Map<string, Retirement>();
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
      publishedBy: null,
      label: null,
      note: null,
      labelSetBy: null,
      labelSetAt: null,
      importedFrom: null,
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

  async publish(id: string, version: number, by: string | null = null) {
    const record = await this.get(id, version);
    if (record?.status !== 'draft') return null;
    const now = this.now();
    const updated: TemplateRecord = {
      ...record,
      status: 'published',
      updatedAt: now,
      publishedAt: now,
      publishedBy: by,
    };
    this.records.set(this.key(id, version), updated);
    return updated;
  }

  async setLabel(id: string, version: number, body: VersionLabelBody, by: string | null) {
    const record = await this.get(id, version);
    if (!record) return null;
    const updated: TemplateRecord = {
      ...record,
      label: body.label === undefined ? record.label : body.label,
      note: body.note === undefined ? record.note : body.note,
      labelSetBy: by,
      labelSetAt: this.now(),
    };
    this.records.set(this.key(id, version), updated);
    return updated;
  }

  async setImportedFrom(id: string, version: number, value: ImportedFrom | null) {
    const record = await this.get(id, version);
    if (record?.status !== 'draft') return null;
    const updated = { ...record, importedFrom: value };
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

  async listRetirements() {
    return new Map(this.retirements);
  }

  async retirement(id: string) {
    return this.retirements.get(id) ?? null;
  }

  async retire(id: string, by: string | null) {
    const existing = this.retirements.get(id);
    if (existing) return { retirement: existing, created: false };
    const retirement: Retirement = { retiredAt: this.now(), retiredBy: by };
    this.retirements.set(id, retirement);
    return { retirement, created: true };
  }

  async unretire(id: string) {
    return this.retirements.delete(id);
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
  published_by: string | null;
  label: string | null;
  note: string | null;
  label_set_by: string | null;
  label_set_at: Date | null;
  imported_from: ImportedFrom | null;
}

const toRecord = (r: Row): TemplateRecord => ({
  id: r.id,
  version: r.version,
  status: r.status,
  definition: r.definition,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  publishedAt: r.published_at ? r.published_at.toISOString() : null,
  publishedBy: r.published_by,
  label: r.label,
  note: r.note,
  labelSetBy: r.label_set_by,
  labelSetAt: r.label_set_at ? r.label_set_at.toISOString() : null,
  importedFrom: r.imported_from,
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
interface RetirementRow {
  type_id: string;
  retired_at: Date;
  retired_by: string | null;
}

const toRetirement = (r: RetirementRow): Retirement => ({
  retiredAt: r.retired_at.toISOString(),
  retiredBy: r.retired_by,
});

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

  async listRetirements() {
    const { rows } = await this.pool.query<RetirementRow>(
      'SELECT type_id, retired_at, retired_by FROM document_type_retirements',
    );
    return new Map(rows.map((r) => [r.type_id, toRetirement(r)]));
  }

  async retirement(id: string) {
    const { rows } = await this.pool.query<RetirementRow>(
      'SELECT type_id, retired_at, retired_by FROM document_type_retirements WHERE type_id = $1',
      [id],
    );
    return rows[0] ? toRetirement(rows[0]) : null;
  }

  async retire(id: string, by: string | null) {
    // The outer SELECT sees the snapshot from before the insert: it answers the existing row
    // only when the insert did nothing.
    const { rows } = await this.pool.query<RetirementRow & { created: boolean }>(
      `WITH ins AS (
         INSERT INTO document_type_retirements (type_id, retired_by) VALUES ($1, $2)
         ON CONFLICT (type_id) DO NOTHING
         RETURNING type_id, retired_at, retired_by)
       SELECT type_id, retired_at, retired_by, true AS created FROM ins
       UNION ALL
       SELECT type_id, retired_at, retired_by, false AS created FROM document_type_retirements
        WHERE type_id = $1 AND NOT EXISTS (SELECT 1 FROM ins)`,
      [id, by],
    );
    const row = rows[0];
    if (row) return { retirement: toRetirement(row), created: row.created };
    // A concurrent retire committed after this statement's snapshot: read its row.
    return { retirement: (await this.retirement(id))!, created: false };
  }

  async unretire(id: string) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM document_type_retirements WHERE type_id = $1',
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async publish(id: string, version: number, by: string | null = null) {
    return this.one(
      `UPDATE templates SET status = 'published', published_at = now(), updated_at = now(),
              published_by = $3
        WHERE id = $1 AND version = $2 AND status = 'draft' RETURNING *`,
      [id, version, by],
    );
  }

  async setLabel(id: string, version: number, body: VersionLabelBody, by: string | null) {
    // $3/$5 say whether the label/note was sent; updated_at is left alone (migration 0045).
    return this.one(
      `UPDATE templates
          SET label = CASE WHEN $3 THEN $4 ELSE label END,
              note = CASE WHEN $5 THEN $6 ELSE note END,
              label_set_by = $7, label_set_at = now()
        WHERE id = $1 AND version = $2 RETURNING *`,
      [
        id,
        version,
        body.label !== undefined,
        body.label ?? null,
        body.note !== undefined,
        body.note ?? null,
        by,
      ],
    );
  }

  async setImportedFrom(id: string, version: number, value: ImportedFrom | null) {
    return this.one(
      `UPDATE templates SET imported_from = $3::jsonb
        WHERE id = $1 AND version = $2 AND status = 'draft' RETURNING *`,
      [id, version, value === null ? null : JSON.stringify(value)],
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
