import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/** The bridge's own advisory lock: CT Studio's runner holds 727274. */
const LOCK = 727275;

/**
 * Forward-only migrations into schema `bridge`: applies db/bridge-migrations/*.sql in filename
 * order, each in its own transaction with `bridge` first on the search path, recording applied
 * files in bridge.schema_migrations. The bridge shares no table with CT Studio.
 */
export async function migrateBridge(databaseUrl: string, dir: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
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
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`bridge migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    await client.end();
  }
  return applied;
}
