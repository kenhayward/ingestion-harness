import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { basicAuth, datasetUrl, FusekiTripleStore } from '../src/backup/fuseki.js';
import {
  checkDatabaseName,
  databaseName,
  databaseUrl,
  PgDatabaseTools,
  pgDumpCommand,
  pgRestoreCommand,
  swapStatements,
} from '../src/backup/pg-tools.js';
import { NoLakeIdentities } from '../src/backup/seaweed-iam-file.js';

const URL_ = 'postgres://ingest:s3cr%40t@postgres:5432/ingestion?sslmode=disable';

describe('pg tools', () => {
  it('dumps in custom format without owners or grants, the password in the environment', () => {
    const cmd = pgDumpCommand(URL_);
    expect(cmd.command).toBe('pg_dump');
    expect(cmd.args).toEqual([
      '-Fc',
      '--no-owner',
      '--no-acl',
      '--dbname=postgres://ingest@postgres:5432/ingestion?sslmode=disable',
    ]);
    expect(cmd.env).toEqual({ PGPASSWORD: 's3cr@t' });
    expect(cmd.args.join(' ')).not.toContain('s3cr');
  });

  it('restores into the given database', () => {
    const cmd = pgRestoreCommand('postgres://ingest:pw@postgres:5432/ih_restore_1');
    expect(cmd).toEqual({
      command: 'pg_restore',
      args: ['--no-owner', '--no-acl', '-d', 'postgres://ingest@postgres:5432/ih_restore_1'],
      env: { PGPASSWORD: 'pw' },
    });
    expect(pgRestoreCommand('postgres://ingest@postgres/x').env).toEqual({});
  });

  it('builds URLs of other databases on the same server', () => {
    expect(databaseName(URL_)).toBe('ingestion');
    expect(databaseUrl(URL_, 'ih_restore_1')).toBe(
      'postgres://ingest:s3cr%40t@postgres:5432/ih_restore_1?sslmode=disable',
    );
  });

  it('refuses database names it would have to quote oddly', () => {
    expect(checkDatabaseName('ih_restore_20261017')).toBe('ih_restore_20261017');
    for (const bad of ['', 'Has-Dash', 'x"; DROP DATABASE y; --', '1abc', 'a'.repeat(64)]) {
      expect(() => checkDatabaseName(bad)).toThrow('not a usable database name');
    }
  });

  it('swaps by closing both databases, then renaming both in one transaction', () => {
    expect(swapStatements('ingestion', 'ih_side', 'ih_previous')).toEqual({
      close: [
        'ALTER DATABASE "ingestion" WITH ALLOW_CONNECTIONS false',
        'ALTER DATABASE "ih_side" WITH ALLOW_CONNECTIONS false',
      ],
      rename: [
        'ALTER DATABASE "ingestion" RENAME TO "ih_previous"',
        'ALTER DATABASE "ih_side" RENAME TO "ingestion"',
        'ALTER DATABASE "ingestion" WITH ALLOW_CONNECTIONS true',
        'ALTER DATABASE "ih_previous" WITH ALLOW_CONNECTIONS true',
      ],
    });
  });

  /** A child process that writes `out`, then exits with `code` after writing `err`. */
  function fakeChild(out: string, code: number, err = ''): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, stdin: new PassThrough(), kill: () => true });
    setImmediate(() => {
      stdout.end(out);
      stderr.end(err);
      setImmediate(() => child.emit('close', code));
    });
    return child;
  }

  it('streams the dump and reports a failed pg_dump with its error output', async () => {
    const runs: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const ok = new PgDatabaseTools(URL_, (command, args, options) => {
      runs.push({ command, args, env: options.env });
      return fakeChild('PGDMP', 0);
    });
    const { body, done } = await ok.dump();
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    await done;
    expect(Buffer.concat(chunks).toString()).toBe('PGDMP');
    expect(runs[0]!.command).toBe('pg_dump');
    expect(runs[0]!.env!.PGPASSWORD).toBe('s3cr@t');

    const bad = new PgDatabaseTools(URL_, () => fakeChild('', 1, 'connection refused'));
    const failed = await bad.dump();
    failed.body.resume();
    await expect(failed.done).rejects.toThrow('pg_dump exited with 1: connection refused');
  });

  it('feeds the dump to pg_restore', async () => {
    let child: ChildProcess | null = null;
    const tools = new PgDatabaseTools(URL_, () => (child = fakeChild('', 0)));
    const fed: Buffer[] = [];
    const restoring = tools.restore(
      'postgres://ingest:pw@postgres/ih_side',
      Readable.from([Buffer.from('PGDMP')]),
    );
    (child as unknown as ChildProcess).stdin!.on('data', (c: Buffer) => fed.push(c));
    await restoring;
    expect(Buffer.concat(fed).toString()).toBe('PGDMP');
  });
});

describe('Fuseki triple store', () => {
  const opts = {
    endpoint: 'http://fuseki:3030/',
    dataset: 'ct',
    user: 'ct-writer',
    password: 'pw',
  };

  it('is the dataset-wide Graph Store Protocol URL', () => {
    expect(datasetUrl(opts)).toBe('http://fuseki:3030/ct/data');
    expect(basicAuth('ct-writer', 'pw')).toBe(
      `Basic ${Buffer.from('ct-writer:pw').toString('base64')}`,
    );
  });

  it('is unavailable without an endpoint', async () => {
    expect(await new FusekiTripleStore({ ...opts, endpoint: ' ' }).available()).toBe(false);
    expect(await new FusekiTripleStore(opts).available()).toBe(true);
  });

  it('dumps the whole dataset as N-Quads', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const store = new FusekiTripleStore(opts, async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response('<s> <p> <o> <g> .\n', { status: 200 });
    });
    const chunks: Buffer[] = [];
    for await (const c of await store.dump()) chunks.push(Buffer.from(c as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('<s> <p> <o> <g> .\n');
    expect(calls[0]!.url).toBe('http://fuseki:3030/ct/data');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers).toEqual({
      accept: 'application/n-quads',
      authorization: basicAuth('ct-writer', 'pw'),
    });
  });

  it('replaces the whole dataset with a PUT of N-Quads', async () => {
    let sent = '';
    let init: RequestInit | undefined;
    const store = new FusekiTripleStore(opts, async (_url, i) => {
      init = i;
      sent = await new Response(i!.body).text();
      return new Response(null, { status: 200 });
    });
    await store.replace(Readable.from([Buffer.from('<s> <p> <o> <g> .\n')]));
    expect(init!.method).toBe('PUT');
    expect(init!.headers).toEqual({
      'content-type': 'application/n-quads',
      authorization: basicAuth('ct-writer', 'pw'),
    });
    expect(sent).toBe('<s> <p> <o> <g> .\n');
  });

  it('deletes one named graph, a missing one included', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const store = new FusekiTripleStore(opts, async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status: calls.length === 1 ? 204 : 404 });
    });
    await store.deleteGraph('https://id.example.com/g?x=1');
    await store.deleteGraph('https://id.example.com/gone');
    expect(calls[0]!.url).toBe(
      'http://fuseki:3030/ct/data?graph=https%3A%2F%2Fid.example.com%2Fg%3Fx%3D1',
    );
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.init.headers).toEqual({ authorization: basicAuth('ct-writer', 'pw') });
  });

  it('reports a refusal with its status', async () => {
    const store = new FusekiTripleStore(
      opts,
      async () => new Response('Forbidden', { status: 403 }),
    );
    await expect(store.dump()).rejects.toThrow(
      'the triple store refused to dump its dataset: 403 Forbidden',
    );
  });
});

describe('data-lake identities', () => {
  it('are never carried, and a restore of some is refused', async () => {
    const lake = new NoLakeIdentities();
    expect(await lake.read()).toEqual([]);
    await expect(lake.replace([])).resolves.toBeUndefined();
    await expect(lake.replace([{ name: 'lake-x' }])).rejects.toThrow('re-issue the keys');
  });
});
