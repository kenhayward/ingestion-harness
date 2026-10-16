/**
 * Opt-in Postgres test for PgLlmConfigRepo (ADR 0010). Skipped unless IH_TEST_DATABASE_URL
 * points at a THROWAWAY database: it applies db/migrations and writes llm_* rows (random names).
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgLlmConfigRepo } from '../../src/llm/repo.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('LLM endpoints SQL against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let repo: PgLlmConfigRepo;
  const name = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
  const version = async () =>
    Number((await pool.query('SELECT version FROM llm_config_state')).rows[0].version);

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 3 });
    repo = new PgLlmConfigRepo(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('adds an endpoint as an admin choice, with its models and stored key', async () => {
    const gpu = name('gpu');
    const before = await version();
    const created = await repo.createEndpoint(
      {
        name: gpu,
        kind: 'openai-chat',
        baseUrl: 'http://x/v1',
        location: 'local',
        apiKeyEnc: 'v1:abc',
        models: ['b', 'a'],
      },
      'ken',
    );
    expect(created).toMatchObject({
      name: gpu,
      source: 'ui',
      updatedBy: 'ken',
      keySet: true,
      models: [
        { modelId: 'a', curated: true, enabled: true, displayName: null },
        { modelId: 'b', curated: true, enabled: true, displayName: null },
      ],
    });
    expect(created !== 'exists' && created.editedAt).toBeTruthy();
    expect(await version()).toBeGreaterThan(before); // workers rebuild
    const again = await repo.createEndpoint(
      {
        name: gpu,
        kind: 'openai-chat',
        baseUrl: null,
        location: 'local',
        apiKeyEnc: null,
        models: [],
      },
      'ken',
    );
    expect(again).toBe('exists');
    const { rows } = await pool.query(
      'SELECT curated_edited_at IS NOT NULL AS pinned FROM llm_models WHERE provider = $1',
      [gpu],
    );
    expect(rows.every((r) => r.pinned)).toBe(true);
  });

  it('edits only the fields given, and clears a key', async () => {
    const gpu = name('gpu');
    await repo.createEndpoint(
      {
        name: gpu,
        kind: 'openai-chat',
        baseUrl: 'http://x/v1',
        location: 'local',
        apiKeyEnc: 'v1:k',
        models: [],
      },
      null,
    );
    const moved = await repo.updateEndpoint(gpu, { location: 'external', apiKeyEnc: null }, 'ann');
    expect(moved).toMatchObject({
      baseUrl: 'http://x/v1',
      location: 'external',
      keySet: false,
      updatedBy: 'ann',
    });
    expect(await repo.updateEndpoint(name('nope'), { enabled: false }, null)).toBeNull();
  });

  it('sets the curated models exactly, keeping the withdrawn ones as suggestions', async () => {
    const gpu = name('gpu');
    await repo.createEndpoint(
      {
        name: gpu,
        kind: 'openai-chat',
        baseUrl: 'http://x/v1',
        location: 'local',
        apiKeyEnc: null,
        models: ['a', 'b'],
      },
      null,
    );
    await pool.query(
      `INSERT INTO llm_models (provider, provider_kind, model_id, display_name)
       VALUES ($1, 'openai-chat', 'found', 'Found')`,
      [gpu],
    );
    const set = await repo.setCuratedModels(gpu, ['b', 'found', 'new'], 'ken');
    expect(set!.models.map((m) => [m.modelId, m.curated])).toEqual([
      ['a', false],
      ['b', true],
      ['found', true],
      ['new', true],
    ]);
    expect(await repo.setCuratedModels(name('nope'), [], null)).toBeNull();
  });

  it("sets a model's output limit, which workers reload", async () => {
    const gpu = name('gpu');
    await repo.createEndpoint(
      {
        name: gpu,
        kind: 'openai-chat',
        baseUrl: 'http://x/v1',
        location: 'local',
        apiKeyEnc: null,
        models: ['a', 'org/b'],
      },
      null,
    );
    const before = await version();
    const set = await repo.setModelOutputLimit(gpu, 'org/b', 32000, 'ken');
    expect(set!.models.map((m) => [m.modelId, m.maxOutputTokens])).toEqual([
      ['a', null],
      ['org/b', 32000],
    ]);
    expect(set!.updatedBy).toBe('ken');
    expect(await version()).toBeGreaterThan(before); // workers rebuild
    const cleared = await repo.setModelOutputLimit(gpu, 'org/b', null, null);
    expect(cleared!.models.find((m) => m.modelId === 'org/b')!.maxOutputTokens).toBeNull();
    expect(await repo.setModelOutputLimit(gpu, 'missing', 8192, null)).toBeNull();
    expect(await repo.setModelOutputLimit(name('nope'), 'a', 8192, null)).toBeNull();
    await expect(
      pool.query(`UPDATE llm_models SET max_output_tokens = 10 WHERE provider = $1`, [gpu]),
    ).rejects.toThrow(/max_output_tokens/);
  });

  it('deletes an endpoint added in the UI, never one from .env', async () => {
    const ui = name('ui');
    const env = name('env');
    await repo.createEndpoint(
      {
        name: ui,
        kind: 'openai-chat',
        baseUrl: 'http://x/v1',
        location: 'local',
        apiKeyEnc: null,
        models: ['m'],
      },
      null,
    );
    await pool.query(
      `INSERT INTO llm_endpoints (name, kind, base_url, location, source) VALUES ($1, 'openai-chat', 'http://y/v1', 'local', 'env')`,
      [env],
    );
    expect(await repo.deleteEndpoint(env)).toBe('env');
    expect(await repo.deleteEndpoint(ui)).toBe('deleted');
    expect(await repo.deleteEndpoint(ui)).toBe('missing');
    const { rows } = await pool.query('SELECT curated FROM llm_models WHERE provider = $1', [ui]);
    expect(rows).toEqual([{ curated: false }]);
  });

  it('adds, edits and removes model choices; sets and reads the settings', async () => {
    const id = name('choice');
    const before = await version();
    const created = await repo.createChoice(
      { id, label: 'Main Production Model', description: '', ref: 'local/qwen' },
      'ken',
    );
    expect(created).toMatchObject({ id, source: 'ui', updatedBy: 'ken' });
    expect(created !== 'exists' && created.editedAt).toBeTruthy();
    expect(await version()).toBeGreaterThan(before); // workers rebuild
    expect(
      await repo.createChoice({ id, label: 'Again', description: '', ref: 'local/qwen' }, null),
    ).toBe('exists');
    const renamed = await repo.updateChoice(id, { label: 'Renamed', ref: 'local/other' }, 'ann');
    expect(renamed).toMatchObject({ label: 'Renamed', ref: 'local/other', updatedBy: 'ann' });
    expect((await repo.listChoices()).some((c) => c.id === id)).toBe(true);
    expect(await repo.updateChoice(name('nope'), { label: 'x' }, null)).toBeNull();

    const settings = await repo.setSettings({ defaultChoice: id, ocrModel: 'local/olmocr' }, 'ken');
    expect(settings).toMatchObject({ defaultChoice: id, ocrModel: 'local/olmocr' });
    const { rows } = await pool.query(
      "SELECT edited_at IS NOT NULL AS edited, updated_by FROM llm_settings WHERE name = 'default_choice'",
    );
    expect(rows[0]).toEqual({ edited: true, updated_by: 'ken' });

    expect(await repo.deleteChoice(id)).toBe(true);
    expect(await repo.deleteChoice(id)).toBe(false);
  });

  it('marks an endpoint for discovery now', async () => {
    const gpu = name('gpu');
    await repo.createEndpoint(
      {
        name: gpu,
        kind: 'openai-chat',
        baseUrl: 'http://x/v1',
        location: 'local',
        apiKeyEnc: null,
        models: [],
      },
      null,
    );
    const before = await version();
    expect(await repo.requestDiscover(gpu)).toBe(true);
    expect(await version()).toBeGreaterThan(before);
    expect(await repo.requestDiscover(name('nope'))).toBe(false);
  });
});
