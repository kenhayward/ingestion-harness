import type pg from 'pg';
import { effectiveBaseIri, type LinkedDataHistoryEntry, type LinkedDataSettings } from '@ih/shared';

/** Linked data settings (ADR 0011, migration 0034): one row, and the history of base changes. */

export interface LinkedDataInput {
  customerName: string;
  customerSlug: string;
  baseIri: string | null;
}

export interface LinkedDataRepo {
  get(): Promise<LinkedDataSettings>;
  /** Saves the settings; a change of the effective base is recorded in the history. */
  save(next: LinkedDataInput, by: string | null): Promise<LinkedDataSettings>;
  history(): Promise<LinkedDataHistoryEntry[]>;
  /** RDF outputs published so far (job_outputs, format rdf, stage published). */
  rdfPublishedCount(): Promise<number>;
  /** The .env defaults, written only when there is no row yet. */
  seed(defaults: LinkedDataInput): Promise<void>;
}

const EMPTY: LinkedDataSettings = {
  customerName: '',
  customerSlug: null,
  baseIri: null,
  updatedBy: null,
  updatedAt: null,
};

export class MemoryLinkedDataRepo implements LinkedDataRepo {
  private settings: LinkedDataSettings | null = null;
  private readonly entries: LinkedDataHistoryEntry[] = [];
  /** Tests set how many RDF outputs were published. */
  rdfPublished = 0;

  async get(): Promise<LinkedDataSettings> {
    return this.settings ?? EMPTY;
  }

  async save(next: LinkedDataInput, by: string | null): Promise<LinkedDataSettings> {
    const before = effectiveBaseIri(this.settings ?? EMPTY);
    const after = effectiveBaseIri(next);
    if (before !== after) {
      this.entries.unshift({
        fromBase: before,
        toBase: after,
        changedBy: by,
        changedAt: new Date().toISOString(),
        rdfPublished: this.rdfPublished,
      });
    }
    this.settings = { ...next, updatedBy: by, updatedAt: new Date().toISOString() };
    return this.settings;
  }

  async history(): Promise<LinkedDataHistoryEntry[]> {
    return [...this.entries];
  }

  async rdfPublishedCount(): Promise<number> {
    return this.rdfPublished;
  }

  async seed(defaults: LinkedDataInput): Promise<void> {
    if (!this.settings) await this.save(defaults, '.env');
  }
}

interface SettingsRow {
  customer_name: string;
  customer_slug: string | null;
  base_iri: string | null;
  updated_by: string | null;
  updated_at: Date;
}

const toSettings = (r: SettingsRow): LinkedDataSettings => ({
  customerName: r.customer_name,
  customerSlug: r.customer_slug,
  baseIri: r.base_iri,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at.toISOString(),
});

export class PgLinkedDataRepo implements LinkedDataRepo {
  constructor(private readonly pool: pg.Pool) {}

  async get(): Promise<LinkedDataSettings> {
    const { rows } = await this.pool.query<SettingsRow>('SELECT * FROM linked_data_settings');
    return rows[0] ? toSettings(rows[0]) : EMPTY;
  }

  async save(next: LinkedDataInput, by: string | null): Promise<LinkedDataSettings> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<SettingsRow>(
        'SELECT * FROM linked_data_settings FOR UPDATE',
      );
      const before = effectiveBaseIri(current.rows[0] ? toSettings(current.rows[0]) : EMPTY);
      const after = effectiveBaseIri(next);
      const { rows } = await client.query<SettingsRow>(
        `INSERT INTO linked_data_settings (id, customer_name, customer_slug, base_iri, updated_by, updated_at)
         VALUES (true, $1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET customer_name = $1, customer_slug = $2, base_iri = $3,
           updated_by = $4, updated_at = now()
         RETURNING *`,
        [next.customerName, next.customerSlug, next.baseIri, by],
      );
      if (before !== after) {
        await client.query(
          `INSERT INTO linked_data_base_history (from_base, to_base, changed_by, rdf_published)
           VALUES ($1, $2, $3,
             (SELECT count(*)::int FROM job_outputs WHERE format = 'rdf' AND stage = 'published'))`,
          [before, after, by],
        );
      }
      await client.query('COMMIT');
      return toSettings(rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async history(): Promise<LinkedDataHistoryEntry[]> {
    const { rows } = await this.pool.query<{
      from_base: string | null;
      to_base: string | null;
      changed_by: string | null;
      changed_at: Date;
      rdf_published: number;
    }>('SELECT * FROM linked_data_base_history ORDER BY changed_at DESC, id DESC');
    return rows.map((r) => ({
      fromBase: r.from_base,
      toBase: r.to_base,
      changedBy: r.changed_by,
      changedAt: r.changed_at.toISOString(),
      rdfPublished: r.rdf_published,
    }));
  }

  async rdfPublishedCount(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_outputs WHERE format = 'rdf' AND stage = 'published'`,
    );
    return rows[0]!.n;
  }

  async seed(defaults: LinkedDataInput): Promise<void> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM linked_data_settings');
    if (!rowCount) await this.save(defaults, '.env');
  }
}
