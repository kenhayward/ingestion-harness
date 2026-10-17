import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';
import pg from 'pg';
import type { DatabaseTools } from './ports.js';

/**
 * The database side of backup and restore through Postgres's own tools: `pg_dump`/`pg_restore`
 * (custom format, same major version as the server, in the API image), and plain SQL on the
 * `postgres` maintenance database for creating, swapping and dropping databases.
 */

/** Names this code creates or renames to: plain lower-case identifiers only. */
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Error output kept from a failed tool, so a reason can be shown without flooding the log. */
const MAX_STDERR = 4096;

export interface ToolCommand {
  command: string;
  args: string[];
  /** Added to the environment: the password travels here, never on the command line. */
  env: Record<string, string>;
}

/** The URL without its password, and the password (empty when it has none). */
export function splitPassword(url: string): { url: string; password: string } {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { url: u.toString(), password };
}

const passwordEnv = (password: string): Record<string, string> =>
  password ? { PGPASSWORD: password } : {};

export function pgDumpCommand(url: string): ToolCommand {
  const { url: bare, password } = splitPassword(url);
  return {
    command: 'pg_dump',
    args: ['-Fc', '--no-owner', '--no-acl', `--dbname=${bare}`],
    env: passwordEnv(password),
  };
}

/** Reads the dump from stdin. */
export function pgRestoreCommand(url: string): ToolCommand {
  const { url: bare, password } = splitPassword(url);
  return {
    command: 'pg_restore',
    args: ['--no-owner', '--no-acl', '-d', bare],
    env: passwordEnv(password),
  };
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** The same server and credentials, another database. */
export function databaseUrl(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

export function checkDatabaseName(name: string): string {
  if (!DATABASE_NAME.test(name)) throw new Error(`not a usable database name: ${name}`);
  return name;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * The swap, in order: stop new connections to both, end the ones there are, then (one
 * transaction, so a failure renames nothing) rename live → keepAs and side → live and let
 * connections in again.
 */
export function swapStatements(
  live: string,
  side: string,
  keepAs: string,
): { close: string[]; rename: string[] } {
  return {
    close: [
      `ALTER DATABASE ${ident(live)} WITH ALLOW_CONNECTIONS false`,
      `ALTER DATABASE ${ident(side)} WITH ALLOW_CONNECTIONS false`,
    ],
    rename: [
      `ALTER DATABASE ${ident(live)} RENAME TO ${ident(keepAs)}`,
      `ALTER DATABASE ${ident(side)} RENAME TO ${ident(live)}`,
      `ALTER DATABASE ${ident(live)} WITH ALLOW_CONNECTIONS true`,
      `ALTER DATABASE ${ident(keepAs)} WITH ALLOW_CONNECTIONS true`,
    ],
  };
}

const TERMINATE = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid()`;
const CONNECTED = `SELECT count(*)::int AS n FROM pg_stat_activity
  WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid()`;

type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Settles when the child exits: resolves on 0, rejects with its error output otherwise. */
function exited(child: ChildProcess, command: string): Promise<void> {
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += c.toString('utf8');
  });
  return new Promise((resolve, reject) => {
    child.once('error', (err) => reject(new Error(`${command} could not run: ${err.message}`)));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} exited with ${code}: ${stderr.trim().slice(0, MAX_STDERR)}`));
    });
  });
}

export class PgDatabaseTools implements DatabaseTools {
  private readonly live: string;

  /** `run` is for tests; production spawns the real tools. */
  constructor(
    private readonly url: string,
    private readonly run: Spawn = spawn,
  ) {
    this.live = databaseName(url);
  }

  private start(cmd: ToolCommand, stdin: 'pipe' | 'ignore'): ChildProcess {
    return this.run(cmd.command, cmd.args, {
      env: { ...process.env, ...cmd.env },
      stdio: [stdin, 'pipe', 'pipe'],
    });
  }

  private async withClient<T>(database: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: databaseUrl(this.url, database) });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  async dump(): Promise<{ body: Readable; done: Promise<void> }> {
    const child = this.start(pgDumpCommand(this.url), 'ignore');
    return { body: child.stdout!, done: exited(child, 'pg_dump') };
  }

  async migrations(): Promise<string[]> {
    return this.withClient(this.live, async (c) => {
      const rows = await c.query<{ filename: string }>('SELECT filename FROM schema_migrations');
      return rows.rows.map((r) => r.filename).sort();
    });
  }

  async createSideDatabase(name: string): Promise<string> {
    checkDatabaseName(name);
    await this.withClient('postgres', (c) => c.query(`CREATE DATABASE ${ident(name)}`));
    return databaseUrl(this.url, name);
  }

  async restore(url: string, body: Readable): Promise<void> {
    const child = this.start(pgRestoreCommand(url), 'pipe');
    const done = exited(child, 'pg_restore');
    const stdin = child.stdin!;
    // pg_restore stopping early closes stdin: the reason is in its exit, not in EPIPE.
    stdin.on('error', () => {});
    let failed: Error | null = null;
    body.on('error', (err) => {
      failed = err;
      child.kill();
    });
    body.pipe(stdin);
    try {
      await done;
    } catch (err) {
      throw failed ?? err;
    }
    if (failed) throw failed;
  }

  async swap(side: string, keepAs: string): Promise<void> {
    checkDatabaseName(side);
    checkDatabaseName(keepAs);
    const { close, rename } = swapStatements(this.live, side, keepAs);
    const names = [this.live, side];
    await this.withClient('postgres', async (c) => {
      try {
        // Inside the try: if closing the side fails, the live database must open again.
        for (const sql of close) await c.query(sql);
        await c.query(TERMINATE, [names]);
        for (let i = 0; i < 100; i += 1) {
          const { rows } = await c.query<{ n: number }>(CONNECTED, [names]);
          if (rows[0]!.n === 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        await c.query('BEGIN');
        try {
          for (const sql of rename) await c.query(sql);
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
      } catch (err) {
        // Nothing was renamed: let connections back in (harmless for one never closed).
        for (const name of names) {
          await c
            .query(`ALTER DATABASE ${ident(name)} WITH ALLOW_CONNECTIONS true`)
            .catch(() => {});
        }
        throw err;
      }
    });
  }

  async dropDatabase(name: string): Promise<void> {
    checkDatabaseName(name);
    await this.withClient('postgres', (c) =>
      c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`),
    );
  }
}
