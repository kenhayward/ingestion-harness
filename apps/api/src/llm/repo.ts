import type pg from 'pg';
import type { LlmEndpointView, LlmModelView, ProviderKind } from '@ih/shared';

/**
 * LLM endpoints and curated models (ADR 0010, migrations 0024-0025). The worker seeds the .env
 * defaults (`source = 'env'`) and reads these tables; every write here is an admin's, so it sets
 * `edited_at` (or `curated_edited_at`) and .env no longer changes the row.
 */
export interface NewEndpoint {
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  location: 'local' | 'external';
  /** Already encrypted (`v1:…`), or null. */
  apiKeyEnc: string | null;
  models: string[];
}

export interface EndpointPatch {
  kind?: ProviderKind;
  baseUrl?: string | null;
  location?: 'local' | 'external';
  enabled?: boolean;
  /** Encrypted key to store, null to remove it, undefined to keep it. */
  apiKeyEnc?: string | null;
}

export interface LlmConfigRepo {
  listEndpoints(): Promise<LlmEndpointView[]>;
  getEndpoint(name: string): Promise<LlmEndpointView | null>;
  /** 'exists' when the name is taken. */
  createEndpoint(input: NewEndpoint, by: string | null): Promise<LlmEndpointView | 'exists'>;
  updateEndpoint(
    name: string,
    patch: EndpointPatch,
    by: string | null,
  ): Promise<LlmEndpointView | null>;
  /** Only endpoints added in the UI are deleted; one from .env is 'env' (disable it instead). */
  deleteEndpoint(name: string): Promise<'deleted' | 'missing' | 'env'>;
  /** Exactly these models are curated (new ids are added); null if the endpoint is unknown. */
  setCuratedModels(
    name: string,
    modelIds: string[],
    by: string | null,
  ): Promise<LlmEndpointView | null>;
  listAliases(): Promise<Record<string, string>>;
}

interface StoredEndpoint {
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  location: 'local' | 'external';
  enabled: boolean;
  source: 'env' | 'ui';
  editedAt: string | null;
  updatedBy: string | null;
  apiKeyEnv: string | null;
  apiKeyEnc: string | null;
}

const byId = (a: LlmModelView, b: LlmModelView) => a.modelId.localeCompare(b.modelId);

export class MemoryLlmConfigRepo implements LlmConfigRepo {
  private endpoints = new Map<string, StoredEndpoint>();
  /** provider -> model id -> row */
  private models = new Map<string, Map<string, LlmModelView>>();
  aliases: Record<string, string> = {};

  /** What the worker's seeding writes (tests). */
  seedEnv(
    e: Pick<StoredEndpoint, 'name' | 'kind' | 'baseUrl' | 'location'> & { apiKeyEnv?: string },
    curated: string[],
  ): void {
    this.endpoints.set(e.name, {
      ...e,
      enabled: true,
      source: 'env',
      editedAt: null,
      updatedBy: null,
      apiKeyEnv: e.apiKeyEnv ?? null,
      apiKeyEnc: null,
    });
    for (const id of curated) this.row(e.name, id).curated = true;
  }

  /** What the worker's discovery writes (tests). */
  discovered(provider: string, modelId: string, displayName: string | null = null): void {
    this.row(provider, modelId).displayName = displayName;
  }

  storedKey(name: string): string | null {
    return this.endpoints.get(name)?.apiKeyEnc ?? null;
  }

  private row(provider: string, modelId: string): LlmModelView {
    const rows = this.models.get(provider) ?? new Map<string, LlmModelView>();
    this.models.set(provider, rows);
    const row = rows.get(modelId) ?? { modelId, displayName: null, curated: false, enabled: true };
    rows.set(modelId, row);
    return row;
  }

  private view(e: StoredEndpoint): LlmEndpointView {
    const { apiKeyEnc, ...rest } = e;
    const models = [...(this.models.get(e.name)?.values() ?? [])].map((m) => ({ ...m }));
    return { ...rest, keySet: apiKeyEnc !== null, models: models.sort(byId) };
  }

  async listEndpoints() {
    return [...this.endpoints.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => this.view(e));
  }

  async getEndpoint(name: string) {
    const e = this.endpoints.get(name);
    return e ? this.view(e) : null;
  }

  async createEndpoint(input: NewEndpoint, by: string | null) {
    if (this.endpoints.has(input.name)) return 'exists' as const;
    const { models, ...rest } = input;
    this.endpoints.set(input.name, {
      ...rest,
      enabled: true,
      source: 'ui',
      editedAt: new Date().toISOString(),
      updatedBy: by,
      apiKeyEnv: null,
    });
    for (const id of models) this.row(input.name, id).curated = true;
    return this.view(this.endpoints.get(input.name)!);
  }

  async updateEndpoint(name: string, patch: EndpointPatch, by: string | null) {
    const e = this.endpoints.get(name);
    if (!e) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    Object.assign(e, defined, { editedAt: new Date().toISOString(), updatedBy: by });
    return this.view(e);
  }

  async deleteEndpoint(name: string) {
    const e = this.endpoints.get(name);
    if (!e) return 'missing' as const;
    if (e.source === 'env') return 'env' as const;
    this.endpoints.delete(name);
    for (const row of this.models.get(name)?.values() ?? []) row.curated = false;
    return 'deleted' as const;
  }

  async setCuratedModels(name: string, modelIds: string[], by: string | null) {
    const e = this.endpoints.get(name);
    if (!e) return null;
    for (const id of modelIds) this.row(name, id);
    for (const row of this.models.get(name)?.values() ?? []) {
      row.curated = modelIds.includes(row.modelId);
    }
    e.updatedBy = by;
    return this.view(e);
  }

  async listAliases() {
    return { ...this.aliases };
  }
}

interface EndpointRow {
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  location: 'local' | 'external';
  enabled: boolean;
  source: 'env' | 'ui';
  edited_at: Date | null;
  updated_by: string | null;
  api_key_env: string | null;
  key_set: boolean;
  models: LlmModelView[];
}

const ENDPOINT_SELECT = `
  SELECT e.name, e.kind, e.base_url, e.location, e.enabled, e.source, e.edited_at, e.updated_by,
         e.api_key_env, e.api_key_enc IS NOT NULL AS key_set,
         COALESCE((SELECT json_agg(json_build_object(
                      'modelId', m.model_id, 'displayName', m.display_name,
                      'curated', m.curated, 'enabled', m.enabled) ORDER BY m.model_id)
                     FROM llm_models m WHERE m.provider = e.name), '[]') AS models
    FROM llm_endpoints e`;

const toView = (r: EndpointRow): LlmEndpointView => ({
  name: r.name,
  kind: r.kind,
  baseUrl: r.base_url,
  location: r.location,
  enabled: r.enabled,
  source: r.source,
  editedAt: r.edited_at ? r.edited_at.toISOString() : null,
  updatedBy: r.updated_by,
  apiKeyEnv: r.api_key_env,
  keySet: r.key_set,
  models: r.models,
});

export class PgLlmConfigRepo implements LlmConfigRepo {
  constructor(private readonly pool: pg.Pool) {}

  async listEndpoints() {
    const { rows } = await this.pool.query<EndpointRow>(`${ENDPOINT_SELECT} ORDER BY e.name`);
    return rows.map(toView);
  }

  async getEndpoint(name: string) {
    const { rows } = await this.pool.query<EndpointRow>(`${ENDPOINT_SELECT} WHERE e.name = $1`, [
      name,
    ]);
    return rows[0] ? toView(rows[0]) : null;
  }

  async createEndpoint(input: NewEndpoint, by: string | null) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `INSERT INTO llm_endpoints (name, kind, base_url, location, api_key_enc, api_key_required,
                                    source, edited_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, false, 'ui', now(), $6)
         ON CONFLICT (name) DO NOTHING`,
        [input.name, input.kind, input.baseUrl, input.location, input.apiKeyEnc, by],
      );
      if (!rowCount) {
        await client.query('ROLLBACK');
        return 'exists' as const;
      }
      await this.curate(client, input.name, input.kind, input.models);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return (await this.getEndpoint(input.name))!;
  }

  async updateEndpoint(name: string, patch: EndpointPatch, by: string | null) {
    const sets: string[] = ['edited_at = now()', 'updated_at = now()', 'updated_by = $2'];
    const values: unknown[] = [name, by];
    const column = {
      kind: 'kind',
      baseUrl: 'base_url',
      location: 'location',
      enabled: 'enabled',
      apiKeyEnc: 'api_key_enc',
    } as const;
    for (const [key, col] of Object.entries(column)) {
      const value = patch[key as keyof EndpointPatch];
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${col} = $${values.length}`);
    }
    const { rowCount } = await this.pool.query(
      `UPDATE llm_endpoints SET ${sets.join(', ')} WHERE name = $1`,
      values,
    );
    return rowCount ? this.getEndpoint(name) : null;
  }

  async deleteEndpoint(name: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ source: 'env' | 'ui' }>(
        'SELECT source FROM llm_endpoints WHERE name = $1 FOR UPDATE',
        [name],
      );
      if (!rows[0] || rows[0].source === 'env') {
        await client.query('ROLLBACK');
        return rows[0] ? ('env' as const) : ('missing' as const);
      }
      await client.query(
        `UPDATE llm_models SET curated = false, curated_edited_at = now()
          WHERE provider = $1 AND curated`,
        [name],
      );
      await client.query('DELETE FROM llm_endpoints WHERE name = $1', [name]);
      await client.query('COMMIT');
      return 'deleted' as const;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async setCuratedModels(name: string, modelIds: string[], by: string | null) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ kind: ProviderKind }>(
        'UPDATE llm_endpoints SET updated_by = $2, updated_at = now() WHERE name = $1 RETURNING kind',
        [name, by],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await this.curate(client, name, rows[0].kind, modelIds);
      await client.query(
        `UPDATE llm_models SET curated = false, curated_edited_at = now()
          WHERE provider = $1 AND curated AND NOT (model_id = ANY($2))`,
        [name, modelIds],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return this.getEndpoint(name);
  }

  /** Curate these models as an admin's choice (`curated_edited_at`): .env no longer changes them. */
  private async curate(
    client: pg.PoolClient,
    name: string,
    kind: ProviderKind,
    modelIds: string[],
  ): Promise<void> {
    for (const id of modelIds) {
      await client.query(
        `INSERT INTO llm_models (provider, provider_kind, model_id, curated, curated_edited_at)
         VALUES ($1, $2, $3, true, now())
         ON CONFLICT (provider, model_id)
           DO UPDATE SET curated = true, curated_edited_at = now()`,
        [name, kind, id],
      );
    }
  }

  async listAliases() {
    const { rows } = await this.pool.query<{ name: string; ref: string }>(
      'SELECT name, ref FROM llm_aliases ORDER BY name',
    );
    return Object.fromEntries(rows.map((r) => [r.name, r.ref]));
  }
}
