import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Minimal forward-only migration runner: applies db/migrations/*.sql in filename order,
 * each in its own transaction, recording applied files in schema_migrations.
 */
export async function migrate(databaseUrl: string, dir: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    // Serialise concurrent runners (e.g. two api replicas starting together).
    await client.query('SELECT pg_advisory_lock(727274)');
    const done = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    );
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    await client.end();
  }
  return applied;
}

/** The bridge's advisory lock (its own runner, apps/bridge/src/db/migrate.ts, holds the same). */
const BRIDGE_LOCK = 727275;

/**
 * The delivery bridge's migrations (db/bridge-migrations) into schema `bridge`, exactly as the
 * bridge's own runner applies them: same lock, `bridge.schema_migrations` bookkeeping and search
 * path, so the bridge sees them as applied. Only a restore uses this, to bring a backup from
 * before the bridge forward before its copy rules keep this server's connections.
 */
async function migrateBridgeSchema(databaseUrl: string, dir: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [BRIDGE_LOCK]);
    await client.query('CREATE SCHEMA IF NOT EXISTS bridge');
    await client.query(
      `CREATE TABLE IF NOT EXISTS bridge.schema_migrations (
         filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set(
      (
        await client.query<{ filename: string }>('SELECT filename FROM bridge.schema_migrations')
      ).rows.map((r) => r.filename),
    );
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL search_path TO bridge');
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO bridge.schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`bridge migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [BRIDGE_LOCK]).catch(() => {});
    await client.end();
  }
}

/**
 * A restored database brought forward to this code: CT Studio's migrations, then the bridge's
 * (a backup from before the bridge has no `bridge` schema, and the copy rules put this server's
 * connections there).
 */
export async function migrateRestored(
  databaseUrl: string,
  dirs: { migrations: string; bridgeMigrations: string },
): Promise<void> {
  await migrate(databaseUrl, dirs.migrations);
  await migrateBridgeSchema(databaseUrl, dirs.bridgeMigrations);
}
