/**
 * Opt-in end to end of watched folders (plan 3, docs/superpowers/specs/2026-10-29-watched-folders-design.md):
 * an admin creates a watch through the API; files dropped in the fake document sink's folder are
 * looked at and picked up by the worker's watch cycle, converted by its `decompose` jobs,
 * delivered through the bridge, and filed in `delivered/` or `failed/` once the bridge's events
 * settle them. Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database (it applies
 * db/migrations and deletes watches, batches, items, decompose jobs and the `docs` sink's register
 * entries). It needs `uv` and the worker's environment (`uv sync` in worker/). It shares those
 * tables with conversion-e2e-pg, so the integration config runs one file at a time:
 *
 *   docker run --rm -d --name ih-test-pg-w6 -e POSTGRES_PASSWORD=test -p 55496:5432 ih-postgres:pgvector
 *   IH_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55496/postgres \
 *     npx vitest run --config apps/api/vitest.integration.config.ts watch-e2e
 *
 * What is real and what is faked:
 * - real: the API (`buildApp` on PgRepo and PgWatchRepo, access control on, an admin signed in:
 *   the watch runs as them; the conversion routes and the signed `/api/bridge/events` route,
 *   listening on a port); the worker's `WatchRunner.tick` over its Pg watch store and HTTP bridge
 *   client, then its `run_once` claiming the `decompose` jobs (`worker/tests/conversion_e2e_worker.py`,
 *   one process per run, its clock moved on a minute each run so files settle at once); the
 *   bridge's routes (deliveries and the watched folder relay), runner and event dispatcher over
 *   HTTP, to the fake document sink's server with its watched location `inbox`
 *   (`apps/bridge/test/conversion-bridge.ts`, `/_drop` and `/_folder`);
 * - faked: object storage (the API's MemoryObjectStore, copied to the worker's for each run and
 *   back), the bridge's own stores (memory), the API's view of the bridge's catalog and its
 *   listing when the watch is saved (FakeBridgeApi) and the worker's target cache (a fixed
 *   lookup). The target has no instance, so its documents take one lane.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { SinkView, SourceFile, SourceFolder } from '@ih/bridge-contract';
import { BatchDetailSchema, WatchDetailSchema, WatchViewSchema, type Item } from '@ih/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { MemoryPublishTargetRepo } from '../../src/publish-targets/repo.js';
import { PgRepo } from '../../src/repositories/pg.js';
import { PgWatchRepo } from '../../src/watches/pg.js';
import { docx, para } from '../docx-fixtures.js';
import { FAKE_DOCUMENT_SINK } from '../fake-sink.js';
import { accessApp, signInNewUser, TEST_BRIDGE_KEY } from '../helpers.js';

const run = promisify(execFile);
const url = process.env.IH_TEST_DATABASE_URL;
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const migrations = join(root, 'db', 'migrations');
const workerDir = join(root, 'worker');
/** The bridge side of the harness (bridge package: typechecked there, loaded here at run time). */
const BRIDGE_HARNESS = pathToFileURL(join(root, 'apps', 'bridge', 'test', 'conversion-bridge.ts'));

/** What `startConversionBridge` (apps/bridge/test/conversion-bridge.ts) gives back, as used here. */
interface WatchBridge {
  url: string;
  drop(name: string, content: Buffer): Promise<void>;
  folder(folder: SourceFolder): Promise<SourceFile[]>;
  documents(): string[];
  settle(): Promise<void>;
  close(): Promise<void>;
}
type StartBridge = (opts: {
  key: string;
  eventsUrl: string;
  target: { id: string; label: string; sinkId: string; destination: Record<string, string> };
}) => Promise<WatchBridge>;

/** The fake document sink as its describe reads (contract version 4, the source field `folder`). */
const WATCHED_DOCUMENT_SINK: SinkView = {
  ...FAKE_DOCUMENT_SINK,
  contractVersion: 4,
  capabilities: {
    ...FAKE_DOCUMENT_SINK.capabilities,
    watchedFolders: {
      sourceFields: [
        {
          id: 'folder',
          label: 'Folder',
          kind: 'fixed',
          required: true,
          overridable: false,
          browse: true,
        },
      ],
    },
  },
};
const SINK = WATCHED_DOCUMENT_SINK.id;
/** The fake sink's watched location (`FAKE_SOURCE`). */
const SOURCE = { folder: 'inbox' };
const LABEL = 'Watched manuals';
const TARGET = 'watched-manuals';
const MAX_BYTES = 1024 * 1024;

/** A Word file of one heading and a paragraph: `text` makes it this file and no other. */
const word = (text: string) =>
  docx({
    body:
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Scope</w:t></w:r></w:p>' +
      para(text),
  });

describe.skipIf(!url)('watched folders end to end', { timeout: 300_000 }, () => {
  let pool: pg.Pool;
  let repo: PgRepo;
  let watchPool: pg.Pool;
  let c: Awaited<ReturnType<typeof accessApp>>;
  let cookie: string;
  let bridge: WatchBridge;
  let objects: string;
  /** The worker's clock, ahead of the wall clock: each run moves it on a minute. */
  let ahead = 0;

  const clear = async () => {
    await pool.query('DELETE FROM watched_folders');
    await pool.query('DELETE FROM register_actions');
    await pool.query('DELETE FROM decomposition_register WHERE sink_id = $1', [SINK]);
    await pool.query('DELETE FROM decomposition_items');
    await pool.query('DELETE FROM decomposition_batches');
    const jobs = `SELECT id FROM jobs WHERE task = 'decompose'`;
    await pool.query(`DELETE FROM job_deliveries WHERE job_id IN (${jobs})`);
    await pool.query(`DELETE FROM job_events WHERE job_id IN (${jobs})`);
    await pool.query(`DELETE FROM jobs WHERE task = 'decompose'`);
  };

  beforeAll(async () => {
    await migrate(url!, migrations);
    const options = { connectionString: url, max: 4, connectionTimeoutMillis: 5_000 };
    pool = new pg.Pool(options);
    repo = new PgRepo(new pg.Pool(options));
    watchPool = new pg.Pool(options);
    await clear();
    // The watch names its target in Postgres (a foreign key): the API's cache row, as the
    // target sync writes it. The API side keeps its targets in memory.
    await pool.query(
      `INSERT INTO publish_targets (id, label, kind, sink_id, destination, synced_at)
       VALUES ($1, $2, 'sink', $3, '{"space": "lib"}', now()) ON CONFLICT (id) DO NOTHING`,
      [TARGET, LABEL, SINK],
    );
    c = await accessApp({
      repo,
      watches: new PgWatchRepo(watchPool),
      targets: new MemoryPublishTargetRepo(),
    });
    c.bridge.sinkViews = [WATCHED_DOCUMENT_SINK];
    ({ cookie } = await signInNewUser(c.app, c.access, 'Watch Keeper', 'admin'));
    const created = await c.app.inject({
      method: 'POST',
      url: '/api/publish-targets',
      headers: { cookie },
      payload: { kind: 'sink', label: LABEL, sinkId: SINK, destination: { space: 'lib' } },
    });
    if (created.statusCode !== 201) throw new Error(`target: ${created.body}`);
    expect((created.json() as { id: string }).id).toBe(TARGET);
    const api = await c.app.listen({ host: '127.0.0.1', port: 0 });
    const { startConversionBridge } = (await import(BRIDGE_HARNESS.href)) as {
      startConversionBridge: StartBridge;
    };
    bridge = await startConversionBridge({
      key: TEST_BRIDGE_KEY,
      eventsUrl: `${api}/api/bridge/events`,
      target: { id: TARGET, label: LABEL, sinkId: SINK, destination: { space: 'lib' } },
    });
    objects = mkdtempSync(join(tmpdir(), 'watch-e2e-'));
  });

  afterAll(async () => {
    await bridge?.close();
    await c?.app.close();
    if (pool) {
      await clear();
      await pool.query('DELETE FROM publish_targets WHERE id = $1', [TARGET]);
    }
    await pool?.end();
    await repo?.close();
    await watchPool?.end();
    if (objects) rmSync(objects, { recursive: true, force: true });
  });

  /**
   * One worker run: a look at the due watches as of the worker's clock (a minute later than the
   * last run's), then every queued `decompose` job. What the worker's store holds at the end
   * becomes the API's store. Then the bridge delivers and sends its events.
   */
  async function round(): Promise<void> {
    ahead += 60_000;
    const listed: Array<{ bucket: string; key: string; path: string }> = [];
    for (const [name, { body }] of c.store.objects) {
      const slash = name.indexOf('/');
      const path = join(objects, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      listed.push({ bucket: name.slice(0, slash), key: name.slice(slash + 1), path });
    }
    const manifest = join(objects, 'objects.json');
    writeFileSync(manifest, JSON.stringify(listed));
    const after = join(objects, 'objects-after.json');
    try {
      await run(
        'uv',
        ['run', '--directory', workerDir, 'python', '-m', 'tests.conversion_e2e_worker'],
        {
          timeout: 120_000,
          env: {
            ...process.env,
            E2E_DATABASE_URL: url!,
            E2E_BRIDGE_URL: bridge.url,
            E2E_BRIDGE_KEY: TEST_BRIDGE_KEY,
            E2E_OBJECTS: manifest,
            E2E_OBJECTS_AFTER: after,
            E2E_TARGET: JSON.stringify({ id: TARGET, sinkId: SINK }),
            E2E_WATCH_NOW: new Date(Date.now() + ahead).toISOString(),
            E2E_MAX_BYTES: String(MAX_BYTES),
          },
        },
      );
    } catch (err) {
      const { stderr = '' } = err as { stderr?: string };
      throw new Error(`the worker failed: ${String(err)}\n${stderr}`);
    }
    const stored = JSON.parse(readFileSync(after, 'utf8')) as Array<{
      bucket: string;
      key: string;
      contentType: string;
      body: string;
    }>;
    c.store.objects.clear();
    for (const o of stored) {
      await c.store.put(o.bucket, o.key, Buffer.from(o.body, 'base64'), o.contentType);
    }
    await bridge.settle();
  }

  /** What each folder of the watched location holds, by name. */
  type Folders = Record<'root' | 'processing' | 'delivered' | 'failed', string[]>;

  /** The names in one folder of the watched location. */
  const names = async (folder: SourceFolder) => (await bridge.folder(folder)).map((f) => f.name);

  /** Rounds until `done` holds (at most 8), then what the folders hold. */
  async function until(done: (folders: Folders) => boolean) {
    for (let i = 0; i < 8; i++) {
      await round();
      const folders: Folders = {
        root: await names(''),
        processing: await names('processing'),
        delivered: await names('delivered'),
        failed: await names('failed'),
      };
      if (done(folders)) return folders;
    }
    throw new Error(`the folders never settled: ${JSON.stringify(await watchNow())}`);
  }

  async function watchNow() {
    const res = await c.app.inject({ url: `/api/watches/${watchId}`, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    return WatchDetailSchema.parse(res.json());
  }

  let watchId = '';

  it('picks files up, delivers or refuses them, and files each one with its reason', async () => {
    const made = await c.app.inject({
      method: 'POST',
      url: '/api/watches',
      headers: { cookie },
      payload: { name: 'Manuals inbox', targetId: TARGET, source: SOURCE, sleepSeconds: 10 },
    });
    expect(made.statusCode, made.body).toBe(201);
    const watch = WatchViewSchema.parse(made.json());
    watchId = watch.id;
    expect(watch).toMatchObject({ state: 'running', sourcePath: 'inbox' });
    expect(watch.runAs.name).toBe('Watch Keeper');

    // 1. A Word file and a "PDF" of random bytes: one delivered, one refused with its reason.
    await bridge.drop('good.docx', word('Pumps'));
    await bridge.drop(
      'bad.pdf',
      Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 251)),
    );
    const first = await until((f) => f.delivered.includes('good.docx'));
    expect(first).toEqual({
      root: [],
      processing: [],
      delivered: ['good.docx'],
      failed: ['bad.pdf', 'bad.pdf.md'],
    });
    expect(bridge.documents()).toHaveLength(1);

    // 2. A changed good.docx: updates the same document, filed under the next free name.
    await bridge.drop('good.docx', word('Pumps, revised'));
    const second = await until((f) => f.delivered.length === 2);
    expect(second).toEqual({
      root: [],
      processing: [],
      delivered: ['good.docx', 'good_1.docx'],
      failed: ['bad.pdf', 'bad.pdf.md'],
    });
    expect(bridge.documents()).toHaveLength(1);

    // The watch's batch: the two Word files on one register entry, created then updated.
    const { watch: now, events } = await watchNow();
    expect(now.throughput.total).toEqual({ delivered: 2, failed: 1 });
    expect(now.health).toBe('running');
    expect(events.some((e) => e.message.includes('bad.pdf refused'))).toBe(true);
    const detail = BatchDetailSchema.parse(
      (
        await c.app.inject({
          url: `/api/conversions/batches/${now.batchId}`,
          headers: { cookie },
        })
      ).json(),
    );
    const words = detail.items
      .filter((i: Item) => i.sourceKey === 'inbox/good.docx')
      .sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!));
    expect(words.map((i) => i.outcome)).toEqual(['created', 'updated']);
    expect(words[0]!.registerEntryId).toBeTruthy();
    expect(words[1]!.registerEntryId).toBe(words[0]!.registerEntryId);
    const refused = detail.items.find((i) => i.sourceKey === 'inbox/bad.pdf');
    expect(refused?.outcome).toBe('failed');
  });
});
