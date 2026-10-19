/**
 * Opt-in Postgres test of the copy rules (restore as a copy, production → staging): two
 * databases migrated from db/migrations, one standing for staging (this server, `live`) and one
 * for production's restored backup (`side`). Skipped unless IH_TEST_DATABASE_URL points at a
 * THROWAWAY server: it creates and drops databases named ih_cr_*. Example:
 *   docker run --rm -d --name ih-test-pg -e POSTGRES_PASSWORD=test -p 55433:5432 ih-postgres:pgvector
 *   IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres \
 *     npx vitest run --config apps/api/vitest.integration.config.ts backup-copy-rules
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyCopyRules, readKeptState, type CopyResult } from '../../src/backup/copy-rules.js';
import { databaseUrl } from '../../src/backup/pg-tools.js';
import { migrate } from '../../src/db/migrate.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
const bridgeMigrations = fileURLToPath(
  new URL('../../../../db/bridge-migrations', import.meta.url),
);

/** The bridge's schema as its migrations make it (the bridge runs them in its own process). */
async function migrateBridge(name: string): Promise<void> {
  await onDb(name, async (c) => {
    await c.query('CREATE SCHEMA IF NOT EXISTS bridge');
    for (const file of readdirSync(bridgeMigrations)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      await c.query('SET search_path TO bridge');
      await c.query(readFileSync(join(bridgeMigrations, file), 'utf8'));
      await c.query('RESET search_path');
    }
  });
}
const NAMES = ['ih_cr_live', 'ih_cr_side', 'ih_cr_atomic'];

const USER = '00000000-0000-4000-8000-000000000001';
const DOC = '00000000-0000-4000-8000-0000000000d1';
const J = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const CONSUMER_STAGING = '00000000-0000-4000-8000-0000000000c1';
const CONSUMER_PROD = '00000000-0000-4000-8000-0000000000c2';

async function onDb<T>(name: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: databaseUrl(url!, name) });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

const dropAll = () =>
  onDb('postgres', async (c) => {
    for (const n of NAMES) await c.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  });

/** Staging: its own models, GitHub instance, base IRI, targets and data-lake consumer. */
const STAGING = `
  INSERT INTO llm_endpoints (name, kind, base_url, location, source)
       VALUES ('staging-local', 'openai-chat', 'http://lmstudio.staging:1234/v1', 'local', 'ui');
  INSERT INTO llm_models (provider, provider_kind, model_id, curated)
       VALUES ('staging-local', 'openai-chat', 'qwen', true);
  INSERT INTO llm_choices (id, label, ref, source) VALUES ('main', 'Staging model', 'staging-local/qwen', 'ui');
  INSERT INTO llm_settings (name, value) VALUES ('default_choice', 'main');
  INSERT INTO github_sync_settings (instance_name) VALUES ('staging');
  INSERT INTO linked_data_settings (customer_name, base_iri) VALUES ('Staging', 'https://id.example/staging/');
  INSERT INTO linked_data_base_history (id, from_base, to_base) VALUES (7, NULL, 'https://id.example/staging/');
  UPDATE publish_targets SET bucket = 'staging-published', label = 'Staging default' WHERE id = 'default';
  INSERT INTO publish_targets (id, label, kind, bucket, endpoint, access_key_id, secret_key_enc)
       VALUES ('staging-ext', 'Staging lake', 'external', 'staging-lake', 'https://s3.staging.example', 'AKSTAGING', 'v1:staging-secret'),
              ('shared', 'Staging shared', 'internal', 'staging-shared', NULL, NULL, NULL);
  INSERT INTO s3_consumers (id, label, user_name) VALUES ('${CONSUMER_STAGING}', 'Staging lake', 'lake-staging');
  INSERT INTO s3_access_keys (consumer_id, access_key_id) VALUES ('${CONSUMER_STAGING}', 'AKLAKESTAGING');
  INSERT INTO s3_consumer_targets (consumer_id, target_id) VALUES ('${CONSUMER_STAGING}', 'default'), ('${CONSUMER_STAGING}', 'shared');
`;

/** Production's backup: its own of everything above, plus jobs, outputs, graphs and recipes. */
const PRODUCTION = `
  INSERT INTO llm_endpoints (name, kind, location, api_key_enc, source)
       VALUES ('prod-anthropic', 'anthropic', 'external', 'v1:prod-key', 'ui');
  INSERT INTO llm_models (provider, provider_kind, model_id, curated)
       VALUES ('prod-anthropic', 'anthropic', 'claude', true);
  INSERT INTO llm_choices (id, label, ref, source)
       VALUES ('main', 'Production model', 'prod-anthropic/claude', 'ui'),
              ('prod-only', 'Production only', 'prod-anthropic/claude', 'ui');
  INSERT INTO llm_settings (name, value) VALUES ('default_choice', 'main'), ('drafting_model', 'prod-anthropic/claude');
  INSERT INTO github_sync_settings (instance_name, first_pushed_at) VALUES ('production', now());
  INSERT INTO linked_data_settings (customer_name, base_iri) VALUES ('Production', 'https://id.example/prod/');
  INSERT INTO linked_data_base_history (id, from_base, to_base) VALUES (1, NULL, 'https://id.example/prod/'),
                                                                       (2, NULL, 'https://id.example/prod2/');

  INSERT INTO users (id, name, email, role, password_hash, must_change_password)
       VALUES ('${USER}', 'Pat', 'pat@example.com', 'admin', 'x', false);
  INSERT INTO user_profiles (user_id, job_title, github_id, github_login, github_avatar_url,
                             github_token_enc, github_linked_at, github_repo)
       VALUES ('${USER}', 'Editor', 42, 'pat', 'https://avatars.example/pat', 'v1:gh-token', now(), 'acme/recipes');
  INSERT INTO github_link_states (state_hash, user_id) VALUES ('hash', '${USER}');
  INSERT INTO template_github_links (type_id, repo, branch, root) VALUES ('invoice', 'acme/recipes', 'main', 'ct');
  INSERT INTO template_github_pushes (type_id, version, repo, branch, path, commit_sha, blob_sha,
                                      label_sha, pushed_by, pushed_at)
       VALUES ('invoice', 1, 'acme/recipes', 'main', 'ct/production/invoice/v1.yaml', 'c', 'b', 'l', 'Pat', now());

  UPDATE publish_targets SET bucket = 'ingest-published' WHERE id = 'default';
  INSERT INTO publish_targets (id, label, kind, bucket, endpoint, region, access_key_id, secret_key_enc)
       VALUES ('prod-ext', 'Production lake', 'external', 'prod-lake', 'https://s3.prod.example', 'eu-west-1', 'AKPROD', 'v1:prod-secret'),
              ('shared', 'Production shared', 'external', 'prod-shared', 'https://s3.shared.example', NULL, 'AKSHARED', 'v1:shared-secret'),
              ('prod-int', 'Production archive', 'internal', 'prod-archive', NULL, NULL, NULL, NULL);
  INSERT INTO s3_consumers (id, label, user_name) VALUES ('${CONSUMER_PROD}', 'Production lake', 'lake-prod');
  INSERT INTO s3_access_keys (consumer_id, access_key_id) VALUES ('${CONSUMER_PROD}', 'AKLAKEPROD');
  INSERT INTO s3_consumer_targets (consumer_id, target_id) VALUES ('${CONSUMER_PROD}', 'default'), ('${CONSUMER_PROD}', 'prod-int'), ('${CONSUMER_PROD}', 'prod-ext');

  INSERT INTO documents (id, filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
       VALUES ('${DOC}', 'a.pdf', 'sha-a', 1, 'invoice', 1, 'ingest-inbox', 'a.pdf');
  INSERT INTO jobs (id, document_id, task, status) VALUES
    ('${J(1)}', '${DOC}', 'process', 'queued'),
    ('${J(2)}', '${DOC}', 'process', 'running'),
    ('${J(3)}', '${DOC}', 'process', 'awaiting_review'),
    ('${J(4)}', '${DOC}', 'process', 'succeeded'),
    ('${J(5)}', '${DOC}', 'process', 'succeeded'),
    ('${J(6)}', '${DOC}', 'process', 'succeeded'),
    ('${J(7)}', '${DOC}', 'process', 'succeeded');
  INSERT INTO jobs (id, document_id, task, status, params) VALUES
    ('${J(8)}', NULL, 'ontology', 'queued', '{}'),
    ('${J(9)}', NULL, 'withdraw', 'running', '{"objects": [], "graphs": []}');
  INSERT INTO jobs (id, document_id, task, status) VALUES ('${J(10)}', '${DOC}', 'publish', 'delivering');
  INSERT INTO job_outputs (job_id, output_id, stage, format, bucket, object_key, target_id) VALUES
    ('${J(4)}', 'fields', 'published', 'csv', 'ingest-published', 'invoice/4.csv', 'default'),
    ('${J(4)}', 'fields', 'draft', 'csv', 'ingest-outputs', 'invoice/4.csv', NULL),
    ('${J(5)}', 'fields', 'published', 'csv', 'prod-lake', 'invoice/5.csv', 'prod-ext'),
    ('${J(5)}', 'lines', 'published', 'json', 'prod-lake', 'invoice/5.json', 'prod-ext'),
    ('${J(6)}', 'fields', 'published', 'csv', 'prod-shared', 'invoice/6.csv', 'shared'),
    ('${J(7)}', 'fields', 'published', 'csv', 'prod-archive', 'invoice/7.csv', 'prod-int');
  INSERT INTO published_graphs (sha256, template_id, graph_iri, version, job_id, document_id,
                                template_version, base_iri, triples, target_id) VALUES
    ('sha-a', 'invoice', 'https://id.example/prod/graph/a', 1, '${J(4)}', '${DOC}', 1, 'https://id.example/prod/', 3, 'default'),
    ('sha-b', 'invoice', 'https://id.example/prod/graph/b', 2, '${J(5)}', '${DOC}', 1, 'https://id.example/prod/', 3, 'prod-ext'),
    ('sha-c', 'invoice', 'https://id.example/prod/graph/c', 1, '${J(6)}', '${DOC}', 1, 'https://id.example/prod/', 3, 'shared');
  INSERT INTO published_graph_versions (sha256, template_id, version, graph_iri, job_id, document_id,
                                        template_version, base_iri, triples, target_id) VALUES
    ('sha-a', 'invoice', 1, 'https://id.example/prod/graph/a', '${J(4)}', '${DOC}', 1, 'https://id.example/prod/', 3, 'default'),
    ('sha-b', 'invoice', 1, 'https://id.example/prod/graph/b', '${J(5)}', '${DOC}', 1, 'https://id.example/prod/', 3, 'prod-ext'),
    ('sha-b', 'invoice', 2, 'https://id.example/prod/graph/b', '${J(5)}', '${DOC}', 1, 'https://id.example/prod/', 3, 'prod-ext'),
    ('sha-c', 'invoice', 1, 'https://id.example/prod/graph/c', '${J(6)}', '${DOC}', 1, 'https://id.example/prod/', 3, 'shared');

  INSERT INTO templates (id, version, status, definition) VALUES
    ('fine', 1, 'published', '{"id": "fine", "version": 1, "model": "main", "pipeline": [{"type": "extract", "id": "a", "model": "default"}]}'),
    ('needs-step-model', 1, 'published', '{"id": "needs-step-model", "version": 1, "pipeline": [{"type": "extract", "id": "a", "model": "prod-only"}]}'),
    ('needs-type-model', 1, 'draft', '{"id": "needs-type-model", "version": 1, "model": "prod-only", "pipeline": [{"type": "extract", "id": "a"}]}'),
    ('needs-ref', 1, 'published', '{"id": "needs-ref", "version": 1, "pipeline": [{"type": "extract", "id": "a", "model": "prod-anthropic/claude"}]}'),
    ('runs-on-staging-ref', 1, 'published', '{"id": "runs-on-staging-ref", "version": 1, "pipeline": [{"type": "extract", "id": "a", "model": "staging-local/qwen"}]}'),
    ('to-prod-ext', 1, 'published', '{"id": "to-prod-ext", "version": 1, "pipeline": [], "delivery": {"publishTo": "prod-ext"}}'),
    ('to-gone', 1, 'draft', '{"id": "to-gone", "version": 1, "pipeline": [], "delivery": {"publishTo": "gone"}}'),
    ('to-shared', 1, 'published', '{"id": "to-shared", "version": 1, "pipeline": [], "delivery": {"publishTo": "shared"}}'),
    ('to-prod-int', 1, 'published', '{"id": "to-prod-int", "version": 1, "pipeline": [], "delivery": {"publishTo": "prod-int"}}');
`;

/** Staging's bridge: its own shared connections (keys under staging's BRIDGE_SECRETS_KEY). */
const BRIDGE_STAGING = `
  INSERT INTO bridge.connections (id, kind, sink_id, name, fields, secret_enc)
       VALUES ('internal', 'shared', 's3', 'This deployment', '{}', NULL),
              ('staging-keys', 'shared', 's3', 'Staging keys', '{"accessKeyId": "AKST"}', 'v1:staging-bridge-secret');
`;

/** Production's bridge in its backup: its connections, targets, deliveries and unsent events. */
const BRIDGE_PRODUCTION = `
  INSERT INTO bridge.connections (id, kind, sink_id, name, fields, secret_enc)
       VALUES ('internal', 'shared', 's3', 'This deployment', '{}', NULL),
              ('staging-keys', 'shared', 's3', 'Same id, production keys', '{}', 'v1:prod-same-id'),
              ('target-prod-ext', 'shared', 's3', 'Production lake', '{"accessKeyId": "AKPROD"}', 'v1:prod-bridge-secret');
  INSERT INTO bridge.targets (id, label, sink_id, connection_id, destination)
       VALUES ('default', 'Default', 's3', 'internal', '{"bucket": "ingest-published"}'),
              ('prod-ext', 'Production lake', 's3', 'target-prod-ext', '{"bucket": "prod-lake"}'),
              ('shared', 'Production shared', 's3', 'staging-keys', '{"bucket": "prod-shared"}');
  INSERT INTO bridge.packages (id, kind, idempotency_key, manifest, staged_key)
       VALUES ('00000000-0000-4000-8000-0000000000a1', 'document', 'k', '{}', 'packages/a1.json');
  INSERT INTO bridge.deliveries (id, package_id, target_id, idempotency_key, status)
       VALUES ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'prod-ext', 'k', 'queued'),
              ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a1', 'default', 'k', 'succeeded');
  INSERT INTO bridge.events (id, delivery_id, sequence, body)
       VALUES ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1', 1, '{}');
`;

describe.skipIf(!url)('copy rules (Postgres)', () => {
  let result: CopyResult;
  const side = <T extends pg.QueryResultRow>(sql: string) =>
    onDb('ih_cr_side', async (c) => (await c.query<T>(sql)).rows);

  beforeAll(async () => {
    await dropAll();
    for (const n of NAMES) {
      await onDb('postgres', (c) => c.query(`CREATE DATABASE ${n}`));
      await migrate(databaseUrl(url!, n), migrations);
      await migrateBridge(n);
    }
    await onDb('ih_cr_live', (c) => c.query(STAGING + BRIDGE_STAGING));
    await onDb('ih_cr_side', (c) => c.query(PRODUCTION + BRIDGE_PRODUCTION));
    const kept = await onDb('ih_cr_live', (c) => readKeptState(c));
    result = await onDb('ih_cr_side', (c) => applyCopyRules(c, kept));
  }, 120_000);
  afterAll(dropAll);

  it("keeps staging's LLM config and drops production's", async () => {
    expect(await side('SELECT name, base_url, api_key_enc FROM llm_endpoints')).toEqual([
      { name: 'staging-local', base_url: 'http://lmstudio.staging:1234/v1', api_key_enc: null },
    ]);
    expect(await side('SELECT provider, model_id, curated FROM llm_models')).toEqual([
      { provider: 'staging-local', model_id: 'qwen', curated: true },
    ]);
    expect(await side('SELECT id, label, ref FROM llm_choices')).toEqual([
      { id: 'main', label: 'Staging model', ref: 'staging-local/qwen' },
    ]);
    expect(await side('SELECT name, value FROM llm_settings')).toEqual([
      { name: 'default_choice', value: 'main' },
    ]);
    expect(await side('SELECT customer_name, base_iri FROM linked_data_settings')).toEqual([
      { customer_name: 'Staging', base_iri: 'https://id.example/staging/' },
    ]);
    expect(await side('SELECT id::int, to_base FROM linked_data_base_history')).toEqual([
      { id: 7, to_base: 'https://id.example/staging/' },
    ]);
    // The serial carries on after the kept ids.
    const [next] = await side<{ id: number }>(
      "INSERT INTO linked_data_base_history (to_base) VALUES ('x') RETURNING id::int",
    );
    expect(next!.id).toBe(8);
    expect(await side('SELECT label, user_name FROM s3_consumers')).toEqual([
      { label: 'Staging lake', user_name: 'lake-staging' },
    ]);
    expect(await side('SELECT access_key_id FROM s3_access_keys')).toEqual([
      { access_key_id: 'AKLAKESTAGING' },
    ]);
    expect(await side('SELECT target_id FROM s3_consumer_targets ORDER BY target_id')).toEqual([
      { target_id: 'default' },
      { target_id: 'shared' },
    ]);
  });

  it("drops GitHub links and users' GitHub tokens", async () => {
    expect(await side('SELECT instance_name, first_pushed_at FROM github_sync_settings')).toEqual([
      { instance_name: 'staging', first_pushed_at: null },
    ]);
    expect(await side('SELECT * FROM template_github_links')).toEqual([]);
    expect(await side('SELECT * FROM template_github_pushes')).toEqual([]);
    expect(await side('SELECT * FROM github_link_states')).toEqual([]);
    expect(
      await side(
        `SELECT job_title, github_id, github_login, github_avatar_url, github_token_enc,
                github_linked_at, github_repo FROM user_profiles`,
      ),
    ).toEqual([
      {
        job_title: 'Editor',
        github_id: null,
        github_login: null,
        github_avatar_url: null,
        github_token_enc: null,
        github_linked_at: null,
        github_repo: null,
      },
    ]);
    // Users and their passwords come from the backup.
    expect(await side('SELECT name FROM users')).toEqual([{ name: 'Pat' }]);
  });

  it("makes production's external targets inert and withdraws their outputs", async () => {
    const [prodExt] = await side<Record<string, unknown>>(
      `SELECT kind, endpoint, region, access_key_id, secret_key_enc, access_key_env,
              secret_key_env, inert_at IS NOT NULL AS inert FROM publish_targets WHERE id = 'prod-ext'`,
    );
    expect(prodExt).toEqual({
      kind: 'external',
      endpoint: null,
      region: null,
      access_key_id: null,
      secret_key_enc: null,
      access_key_env: null,
      secret_key_env: null,
      inert: true,
    });
    expect(result.droppedTargets).toEqual(['prod-ext']);
    // prod-ext (dropped) and shared (production external, staging internal): withdrawn;
    // default and prod-int (internal on both or production's only): still live; drafts untouched.
    expect(
      await side(
        `SELECT job_id::text AS job, output_id, stage, withdrawn_at IS NOT NULL AS withdrawn
           FROM job_outputs ORDER BY job_id, output_id, stage`,
      ),
    ).toEqual([
      { job: J(4), output_id: 'fields', stage: 'draft', withdrawn: false },
      { job: J(4), output_id: 'fields', stage: 'published', withdrawn: false },
      { job: J(5), output_id: 'fields', stage: 'published', withdrawn: true },
      { job: J(5), output_id: 'lines', stage: 'published', withdrawn: true },
      { job: J(6), output_id: 'fields', stage: 'published', withdrawn: true },
      { job: J(7), output_id: 'fields', stage: 'published', withdrawn: false },
    ]);
    expect(result.withdrawnOutputs).toBe(3);
    // Graph records of withdrawn targets go, so a re-mint or a deletion never reaches for them.
    expect(await side('SELECT sha256, target_id FROM published_graphs')).toEqual([
      { sha256: 'sha-a', target_id: 'default' },
    ]);
    expect(await side('SELECT sha256, version FROM published_graph_versions')).toEqual([
      { sha256: 'sha-a', version: 1 },
    ]);
    expect(result.droppedGraphs).toEqual([
      'https://id.example/prod/graph/b',
      'https://id.example/prod/graph/c',
    ]);
    // Production's internal-only target comes across as it is.
    expect(
      await side("SELECT kind, bucket, inert_at FROM publish_targets WHERE id = 'prod-int'"),
    ).toEqual([{ kind: 'internal', bucket: 'prod-archive', inert_at: null }]);
  });

  it("staging's row wins on a shared id", async () => {
    expect(
      await side(
        `SELECT id, label, kind, bucket, endpoint, access_key_id, secret_key_enc, inert_at
           FROM publish_targets WHERE id IN ('default', 'shared', 'staging-ext') ORDER BY id`,
      ),
    ).toEqual([
      {
        id: 'default',
        label: 'Staging default',
        kind: 'internal',
        bucket: 'staging-published',
        endpoint: null,
        access_key_id: null,
        secret_key_enc: null,
        inert_at: null,
      },
      {
        id: 'shared',
        label: 'Staging shared',
        kind: 'internal',
        bucket: 'staging-shared',
        endpoint: null,
        access_key_id: null,
        secret_key_enc: null,
        inert_at: null,
      },
      {
        id: 'staging-ext',
        label: 'Staging lake',
        kind: 'external',
        bucket: 'staging-lake',
        endpoint: 'https://s3.staging.example',
        access_key_id: 'AKSTAGING',
        secret_key_enc: 'v1:staging-secret',
        inert_at: null,
      },
    ]);
    // The delivery record keeps its recorded bucket and key.
    expect(
      await side(
        `SELECT bucket, object_key FROM job_outputs WHERE job_id = '${J(4)}' AND stage = 'published'`,
      ),
    ).toEqual([{ bucket: 'ingest-published', object_key: 'invoice/4.csv' }]);
  });

  it('cancels queued jobs of every task', async () => {
    expect(await side('SELECT id::text, task, status::text FROM jobs ORDER BY id')).toEqual([
      { id: J(1), task: 'process', status: 'cancelled' },
      { id: J(2), task: 'process', status: 'cancelled' },
      { id: J(3), task: 'process', status: 'awaiting_review' },
      { id: J(4), task: 'process', status: 'succeeded' },
      { id: J(5), task: 'process', status: 'succeeded' },
      { id: J(6), task: 'process', status: 'succeeded' },
      { id: J(7), task: 'process', status: 'succeeded' },
      { id: J(8), task: 'ontology', status: 'cancelled' },
      { id: J(9), task: 'withdraw', status: 'cancelled' },
      // Production's delivering job waits on production's bridge, never this one.
      { id: J(10), task: 'publish', status: 'cancelled' },
    ]);
    expect(result.cancelledJobs).toBe(5);
    expect(
      await side(
        "SELECT job_id::text AS job, level, data FROM job_events WHERE message = 'cancelled' ORDER BY job_id",
      ),
    ).toEqual(
      [J(1), J(2), J(8), J(9), J(10)].map((job) => ({
        job,
        level: 'warn',
        data: { reason: 'restored as a copy' },
      })),
    );
  });

  it("a restore keeps the live bridge connections, not the backup's", async () => {
    expect(await side('SELECT id, name, secret_enc FROM bridge.connections ORDER BY id')).toEqual([
      { id: 'internal', name: 'This deployment', secret_enc: null },
      { id: 'staging-keys', name: 'Staging keys', secret_enc: 'v1:staging-bridge-secret' },
    ]);
  });

  it('a restored target naming a connection the live deployment lacks loses its connection', async () => {
    expect(await side('SELECT id, connection_id FROM bridge.targets ORDER BY id')).toEqual([
      { id: 'default', connection_id: 'internal' },
      { id: 'prod-ext', connection_id: null },
      { id: 'shared', connection_id: 'staging-keys' },
    ]);
  });

  it("never delivers production's unfinished deliveries nor sends its events here", async () => {
    expect(
      await side(
        `SELECT id::text, status, error->>'message' AS message FROM bridge.deliveries ORDER BY id`,
      ),
    ).toEqual([
      {
        id: '00000000-0000-4000-8000-0000000000b1',
        status: 'failed',
        message: 'restored as a copy',
      },
      { id: '00000000-0000-4000-8000-0000000000b2', status: 'succeeded', message: null },
    ]);
    expect(
      await side('SELECT count(*)::int AS n FROM bridge.events WHERE sent_at IS NULL'),
    ).toEqual([{ n: 0 }]);
  });

  it('lists recipes naming a missing model choice', () => {
    expect(result.recipesNeedingModel).toEqual([
      'needs-ref',
      'needs-step-model',
      'needs-type-model',
    ]);
    expect(result.recipesNeedingTarget).toEqual(['to-gone', 'to-prod-ext']);
  });

  it('changes nothing when a rule fails', async () => {
    const kept = await onDb('ih_cr_live', (c) => readKeptState(c));
    kept.llm_settings = [{ name: 'not_a_setting', value: 'x' }];
    await onDb('ih_cr_atomic', (c) =>
      c.query(`INSERT INTO jobs (id, document_id, task, status, params)
               VALUES ('${J(1)}', NULL, 'ontology', 'queued', '{}')`),
    );
    await expect(onDb('ih_cr_atomic', (c) => applyCopyRules(c, kept))).rejects.toThrow(
      /llm_settings/,
    );
    expect(
      await onDb(
        'ih_cr_atomic',
        async (c) => (await c.query('SELECT status::text FROM jobs')).rows,
      ),
    ).toEqual([{ status: 'queued' }]);
  });
});
