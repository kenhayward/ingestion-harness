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
