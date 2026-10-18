import type pg from 'pg';
import {
  answerKey,
  RememberedAnswerSchema,
  type MappingMemoryEntry,
  type MemoryListQuery,
  type MemoryStatus,
  type SignatureKind,
} from '@ih/shared';
import type {
  EntryInput,
  EntryPatch,
  MappingMemoryRepo,
  ReplaceResult,
  VoteInput,
} from './repo.js';

const PAGE_SIZE = 50;

interface EntryRow {
  id: string;
  kind: SignatureKind;
  signature_key: string;
  name: string;
  description: string;
  type: string;
  unit: string;
  answer: unknown;
  ontologies: string[];
  status: MemoryStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  note: string | null;
  updated_at: Date;
  votes: number;
  refusals: number;
  recipes: { id: string; path: string; version: number }[];
}

const ENTRY_SELECT = `
  SELECT m.id::text, m.kind, m.signature_key, m.name, m.description, m.type, m.unit, m.answer,
         m.ontologies, m.status, m.reviewed_by, m.reviewed_at, m.note, m.updated_at,
         (SELECT count(DISTINCT v.template_id)::int FROM mapping_memory_votes v
           WHERE v.entry_id = m.id) AS votes,
         (SELECT count(DISTINCT r.template_id)::int FROM mapping_memory_refusals r
           WHERE r.entry_id = m.id) AS refusals,
         COALESCE((SELECT json_agg(json_build_object('id', v.template_id, 'path', v.output_path,
                                                     'version', v.version)
                                   ORDER BY v.template_id, v.output_path)
                     FROM mapping_memory_votes v WHERE v.entry_id = m.id), '[]') AS recipes
    FROM mapping_memory m`;

function entryOf(r: EntryRow): MappingMemoryEntry {
  return {
    id: r.id,
    kind: r.kind,
    signatureKey: r.signature_key,
    name: r.name,
    description: r.description,
    type: r.type,
    unit: r.unit,
    answer: RememberedAnswerSchema.parse(r.answer),
    ontologies: r.ontologies,
    status: r.status,
    stale: null,
    votes: r.votes,
    refusals: r.refusals,
    recipes: r.recipes,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    note: r.note,
    updatedAt: r.updated_at.toISOString(),
  };
}

/** The mapping memory on Postgres (migration 202610181509_mapping_memory). */
export class PgMappingMemoryRepo implements MappingMemoryRepo {
  constructor(private readonly pool: pg.Pool) {}

  private async tx<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await work(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async findOrMake(
    client: pg.PoolClient,
    input: Omit<EntryInput, 'note' | 'external'>,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO mapping_memory (kind, signature_key, name, description, type, unit, answer,
                                   answer_key, ontologies)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       ON CONFLICT (signature_key, answer_key) DO UPDATE
         SET ontologies = ARRAY(SELECT DISTINCT unnest(mapping_memory.ontologies || EXCLUDED.ontologies)
                                ORDER BY 1)
       RETURNING id::text`,
      [
        input.kind,
        input.signatureKey,
        input.name,
        input.description,
        input.type,
        input.unit,
        JSON.stringify(input.answer),
        answerKey(input.answer),
        [...new Set(input.ontologies)].sort(),
      ],
    );
    return rows[0]!.id;
  }

  async replaceVotes(
    templateId: string,
    votes: VoteInput[],
    by: string | null,
  ): Promise<ReplaceResult> {
    return this.tx(async (client) => {
      // One writer per recipe at a time: concurrent saves of the same recipe serialise here.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('mapping-memory:' || $1))`, [
        templateId,
      ]);
      const { rows: before } = await client.query<{ output_path: string; origin: string | null }>(
        `DELETE FROM mapping_memory_votes WHERE template_id = $1
         RETURNING output_path, origin_entry_id::text AS origin`,
        [templateId],
      );
      const origins = new Map(before.map((b) => [b.output_path, b.origin]));
      const after = new Map<string, string>();
      for (const v of votes) {
        const id = await this.findOrMake(client, v);
        after.set(v.path, id);
        const origin = origins.get(v.path) === id ? id : null;
        await client.query(
          `INSERT INTO mapping_memory_votes (template_id, output_path, entry_id, version, name,
                                             description, table_name, external, origin_entry_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [templateId, v.path, id, v.version, v.name, v.description, v.table, v.external, origin],
        );
      }
      let refused = 0;
      for (const [path, origin] of origins) {
        if (origin && after.get(path) !== origin) {
          await client.query(
            `INSERT INTO mapping_memory_refusals (entry_id, template_id, output_path, by)
             SELECT id, $2, $3, $4 FROM mapping_memory WHERE id = $1::uuid
             ON CONFLICT DO NOTHING`,
            [origin, templateId, path, by],
          );
          refused += 1;
        }
      }
      await client.query(
        `DELETE FROM mapping_memory m
          WHERE m.status = 'learned' AND m.reviewed_by IS NULL
            AND NOT EXISTS (SELECT 1 FROM mapping_memory_votes v WHERE v.entry_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM mapping_memory_refusals r WHERE r.entry_id = m.id)`,
      );
      return { refused };
    });
  }

  async setOrigins(templateId: string, origins: Record<string, string>) {
    for (const [path, entryId] of Object.entries(origins)) {
      await this.pool.query(
        `UPDATE mapping_memory_votes SET origin_entry_id = entry_id
          WHERE template_id = $1 AND output_path = $2 AND entry_id = $3::uuid`,
        [templateId, path, entryId],
      );
    }
  }

  async addRefusal(entryId: string, templateId: string, path: string, by: string | null) {
    await this.pool.query(
      `INSERT INTO mapping_memory_refusals (entry_id, template_id, output_path, by)
       SELECT id, $2, $3, $4 FROM mapping_memory WHERE id = $1::uuid
       ON CONFLICT DO NOTHING`,
      [entryId, templateId, path, by],
    );
  }

  async list(query: MemoryListQuery) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll('$?', `$${params.length}`));
    };
    if (query.status === 'review') where.push(`m.status = 'learned'`);
    else if (query.status && query.status !== 'all') add('m.status = $?', query.status);
    if (query.ontology) add('$? = ANY(m.ontologies)', query.ontology);
    if (query.term) add('m.answer::text LIKE $?', `%${JSON.stringify(query.term).slice(1, -1)}%`);
    if (query.q?.trim()) add('(m.name ILIKE $? OR m.description ILIKE $?)', `%${query.q.trim()}%`);
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = query.pageSize ?? PAGE_SIZE;
    const page = query.page ?? 1;
    const { rows } = await this.pool.query<EntryRow>(
      `SELECT * FROM (${ENTRY_SELECT} ${filter}) e
        ORDER BY e.votes DESC, e.name, e.id
        LIMIT ${size} OFFSET ${(page - 1) * size}`,
      params,
    );
    const { rows: count } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mapping_memory m ${filter}`,
      params,
    );
    // A term matched by text may be a longer IRI: keep exact uses only.
    const entries = rows
      .map(entryOf)
      .filter((e) => !query.term || JSON.stringify(e.answer).includes(JSON.stringify(query.term)));
    return { entries, total: count[0]!.n };
  }

  async get(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.pool.query<EntryRow>(`${ENTRY_SELECT} WHERE m.id = $1`, [id]);
    return rows[0] ? entryOf(rows[0]) : null;
  }

  async create(input: EntryInput, by: string | null) {
    const id = await this.tx(async (client) => {
      const made = await this.findOrMake(client, input);
      await client.query(
        `UPDATE mapping_memory SET status = 'confirmed', reviewed_by = $2, reviewed_at = now(),
                note = $3, reviewed_external = reviewed_external OR $4, updated_at = now()
          WHERE id = $1`,
        [made, by, input.note, input.external],
      );
      return made;
    });
    return (await this.get(id))!;
  }

  async patch(id: string, patch: EntryPatch, by: string | null) {
    const current = await this.get(id);
    if (!current) return null;
    const sets = ['reviewed_by = $2', 'reviewed_at = now()', 'updated_at = now()'];
    const params: unknown[] = [id, by];
    if (patch.answer) {
      params.push(JSON.stringify(patch.answer), answerKey(patch.answer));
      sets.push(`answer = $${params.length - 1}::jsonb`, `answer_key = $${params.length}`);
      sets.push(`status = 'confirmed'`);
    }
    if (patch.status) {
      params.push(patch.status);
      sets.push(`status = $${params.length}`);
    }
    if (patch.note !== undefined) {
      params.push(patch.note);
      sets.push(`note = $${params.length}`);
    }
    try {
      await this.pool.query(`UPDATE mapping_memory SET ${sets.join(', ')} WHERE id = $1`, params);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return 'conflict' as const;
      throw err;
    }
    return this.get(id);
  }

  async delete(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const { rowCount } = await this.pool.query('DELETE FROM mapping_memory WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async votedTemplates() {
    const { rows } = await this.pool.query<{ template_id: string }>(
      'SELECT DISTINCT template_id FROM mapping_memory_votes ORDER BY template_id',
    );
    return rows.map((r) => r.template_id);
  }
}
