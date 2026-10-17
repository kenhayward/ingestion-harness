import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { RestoreStatus } from '@ih/shared';
import { checkBackup } from '../src/backup/check.js';
import { createBackup } from '../src/backup/create.js';
import type { BackupDeps } from '../src/backup/ports.js';
import {
  PARTLY_REPLACED,
  RESTORE_INTERRUPTED,
  RESTORE_MESSAGE,
  restoreStatusKey,
  runRestore,
  saveRestoreStatus,
  type RestoreDeps,
  type RestoreRequest,
} from '../src/backup/restore.js';
import { MemoryQueueControlRepo } from '../src/backup/queue-control.js';
import { BackupService } from '../src/backup/service.js';
import { uploadFileKey } from '../src/backup/uploads.js';
import { MaintenanceGate, MemoryMaintenanceRepo } from '../src/maintenance/repo.js';
import { MemoryS3KeyIssuer } from '../src/s3keys/issuer.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import {
  BUCKETS,
  fakeBackupDeps,
  FakeDatabaseTools,
  FakeLakeIdentities,
  FakeLiveDatabase,
  FakeSideDatabase,
  FakeTripleStore,
  TEST_MASTER,
} from './backup-fakes.js';

const LOCAL = ['0001_init.sql', '202610171218_backup_restore.sql'];
const BACKUP_NQ = '<http://ex/s> <http://ex/p> "from the backup" <http://ex/g> .\n';
const UPLOAD = 'u1';

/** Production's stack, backed up: its file and the check's result. */
async function backupOf(over: Partial<BackupDeps> = {}) {
  const source = fakeBackupDeps({
    db: new FakeDatabaseTools(Buffer.from('PGDMP production')),
    triples: new FakeTripleStore(BACKUP_NQ),
    ...over,
  });
  const b = source.buckets;
  await source.store.put(b.inbox, 'docs/a.pdf', Buffer.from('%PDF-1 a'), 'application/pdf');
  await source.store.put(b.outputs, 'jobs/1/out.csv', Buffer.from('a,b\n'), 'text/csv');
  await source.store.put(b.runs, 'ocr-cache/x.json', Buffer.from('{}'), 'application/json');
  for (const bucket of await source.internalTargetBuckets()) {
    await source.store.put(bucket, 'ingest/out.json', Buffer.from('[]'), 'application/json');
  }
  const { key } = await createBackup(source, 'b1', 'Pat', () => {});
  const file = (await source.store.get(b.backups, key))!;
  const checked = await checkBackup(
    async () => Readable.from([file]),
    [TEST_MASTER],
    LOCAL,
    () => {},
  );
  return { file, checked };
}

/** This server: its own stack of fakes, the uploaded backup in its backups bucket. */
async function server(file: Buffer, over: Partial<RestoreDeps> = {}) {
  const store = new MemoryObjectStore();
  await store.put(BUCKETS.backups, uploadFileKey(UPLOAD), file, 'application/octet-stream');
  const maintenance = new MemoryMaintenanceRepo();
  const live = new FakeLiveDatabase();
  const side = new FakeSideDatabase();
  const log: string[] = [];
  const embedded: string[] = [];
  const db = new FakeDatabaseTools(Buffer.from('PGDMP staging'));
  const deps: RestoreDeps = {
    ...fakeBackupDeps({ store, db }),
    triples: new FakeTripleStore('<http://ex/s> <http://ex/p> "here" <http://ex/g> .\n'),
    lake: new FakeLakeIdentities([
      { name: 'ingest-admin', actions: ['Admin'] },
      { name: 'lake-staging', credentials: [] },
    ]),
    gate: new MaintenanceGate(maintenance),
    localMigrations: async () => LOCAL,
    migrate: async (url) => {
      log.push(`migrate ${url}`);
    },
    rotateAdminToken: async () => {
      log.push('rotate');
    },
    createEmbedJobs: async (model) => {
      embedded.push(model);
      return 1;
    },
    liveDatabaseName: 'ingestion',
    live,
    openSide: async (url) => {
      side.url = url;
      return side;
    },
    lakeIssuer: null,
    jobWaitMs: 0,
    ...over,
  };
  return { deps, store, maintenance, live, side, log, embedded, db };
}

function request(
  checked: Awaited<ReturnType<typeof backupOf>>['checked'],
  mode: RestoreRequest['mode'] = 'deployment',
): RestoreRequest {
  return {
    id: 'r1',
    mode,
    key: checked.master,
    uploadKey: uploadFileKey(UPLOAD),
    by: 'Admin',
    manifest: checked.manifest,
    contentTypes: checked.contentTypes,
  };
}

const statuses = () => {
  const seen: Partial<RestoreStatus>[] = [];
  return { seen, status: async (s: Partial<RestoreStatus>) => void seen.push(s) };
};

const text = async (store: MemoryObjectStore, bucket: string, key: string) =>
  (await store.get(bucket, key))?.toString('utf8') ?? null;

describe('runRestore', () => {
  it('deployment mode replaces database, objects, identities and triples, then swaps', async () => {
    const { file, checked } = await backupOf();
    const s = await server(file);
    await s.store.put('inbox', 'docs/a.pdf', Buffer.from('staging a'), 'application/pdf');
    const { seen, status } = statuses();

    const report = await runRestore(s.deps, request(checked), status);

    expect(s.db.databases.get('ingestion')!.toString()).toBe('PGDMP production');
    expect(report.previousDatabase).toMatch(/^ingestion_before_restore_\d{14}_[0-9a-f]{4}$/);
    expect(s.db.databases.get(report.previousDatabase)!.toString()).toBe('PGDMP staging');
    expect([...s.db.databases.keys()].some((n) => n.startsWith('ingestion_restore_'))).toBe(false);
    const created = s.db.calls.find((c) => c.startsWith('create '))!.slice(7);
    expect(created).toMatch(/^ingestion_restore_\d{14}_[0-9a-f]{4}$/);
    expect(s.db.calls.at(-1)).toBe(`swap ${created} ${report.previousDatabase}`);

    expect(await text(s.store, 'inbox', 'docs/a.pdf')).toBe('%PDF-1 a');
    expect(s.store.objects.get('outputs/jobs/1/out.csv')?.contentType).toBe('text/csv');
    expect(await text(s.store, 'runs', 'ocr-cache/x.json')).toBe('{}');
    expect(report.objects).toBe(3);

    const lake = s.deps.lake as FakeLakeIdentities;
    expect(lake.identities.map((i) => i.name)).toEqual(['ingest-admin', 'lake-acme']);
    expect((s.deps.triples as FakeTripleStore).content).toBe(BACKUP_NQ);
    expect(report.triples).toBe('restored');

    expect(s.log).toEqual([`migrate postgres://fake/${created}`, 'rotate']);
    expect(s.side.calls).toEqual(['prepare']);
    expect(s.side.prepared).toEqual({ message: RESTORE_MESSAGE, by: 'Admin', buckets: [] });
    expect(s.side.closed).toBe(true);
    expect(s.live.calls).toEqual(['pause']);
    expect(s.live.paused).toEqual({ by: 'Admin', reason: 'restoring a backup' });
    expect(report.copy).toBeNull();
    expect(report.lakeKeysToReissue).toEqual([]);
    expect(report.restored).toEqual([{ table: 'jobs', rows: 4 }]);
    expect(report.adminTokenRotated).toBe(true);

    const last = seen.at(-1)!;
    expect(last.phase).toBe('succeeded');
    expect(last.report).toEqual(report);
    expect(seen.map((x) => x.step).filter(Boolean)).toEqual([
      'maintenance',
      'database',
      'migrations',
      'adjusting',
      'objects',
      'identities',
      'triples',
      'swap',
      'finishing',
    ]);
    // Released after the swap: the restored row (on) decides from here.
    expect(await s.deps.gate.current()).toMatchObject({ enabled: false });
  });

  it('copy mode applies the copy rules and leaves identities alone', async () => {
    const { file, checked } = await backupOf();
    const s = await server(file);
    s.side.embedding = 'local/embed';
    const { status } = statuses();

    const report = await runRestore(s.deps, request(checked, 'copy'), status);

    expect(s.side.keptGiven).toBe(s.live.kept);
    expect(s.side.calls).toEqual(['copy rules', 'prepare', 'rebuild remint']);
    expect(report.copy).toEqual({
      cancelledJobs: 2,
      droppedTargets: ['prod-ext'],
      withdrawnOutputs: 3,
      recipesNeedingModel: ['invoice'],
      recipesNeedingTarget: [],
    });
    const lake = s.deps.lake as FakeLakeIdentities;
    expect(lake.identities.map((i) => i.name)).toEqual(['ingest-admin', 'lake-staging']);
    const triples = s.deps.triples as FakeTripleStore;
    expect(triples.content).toBe(BACKUP_NQ);
    expect(triples.deletedGraphs).toEqual(['https://id.example.com/acme/graph/1']);
    expect(report.triples).toBe('reminting');
    expect(s.embedded).toEqual(['local/embed']);
    expect(report.lakeKeysToReissue).toEqual([]);
  });

  it('maps role buckets by role', async () => {
    const { file, checked } = await backupOf({
      buckets: { inbox: 'p-inbox', outputs: 'p-outputs', runs: 'p-runs', backups: 'p-backups' },
      internalTargetBuckets: async () => ['published'],
    });
    const s = await server(file);
    const { status } = statuses();

    await runRestore(s.deps, request(checked), status);

    expect(await text(s.store, 'inbox', 'docs/a.pdf')).toBe('%PDF-1 a');
    expect(await text(s.store, 'outputs', 'jobs/1/out.csv')).toBe('a,b\n');
    expect(await text(s.store, 'runs', 'ocr-cache/x.json')).toBe('{}');
    expect(await text(s.store, 'published', 'ingest/out.json')).toBe('[]');
    expect(await text(s.store, 'p-inbox', 'docs/a.pdf')).toBeNull();
    expect(s.store.ensured).toEqual(
      expect.arrayContaining(['inbox', 'outputs', 'runs', 'published']),
    );
    expect(s.side.prepared!.buckets).toEqual([
      { from: 'p-inbox', to: 'inbox' },
      { from: 'p-outputs', to: 'outputs' },
      { from: 'p-runs', to: 'runs' },
    ]);
  });

  it("refuses a target bucket that is one of this server's own buckets, changing nothing", async () => {
    const { file, checked } = await backupOf({
      buckets: { ...BUCKETS, backups: 'p-backups' },
      internalTargetBuckets: async () => ['backups'],
    });
    const s = await server(file);
    const { seen, status } = statuses();

    await expect(runRestore(s.deps, request(checked), status)).rejects.toThrow(
      "the backup's publishing target bucket backups is this server's own backups bucket",
    );
    expect(s.db.calls).toEqual([]);
    expect(s.live.calls).toEqual([]);
    expect(seen.at(-1)!.phase).toBe('failed');
  });

  it('deletes objects the backup does not have', async () => {
    const { file, checked } = await backupOf({ internalTargetBuckets: async () => ['published'] });
    const s = await server(file);
    await s.store.put('inbox', 'stale.pdf', Buffer.from('x'), 'application/pdf');
    await s.store.put('runs', 'step-cache/old.json', Buffer.from('x'), 'application/json');
    await s.store.put('published', 'ingest/old.json', Buffer.from('x'), 'application/json');
    await s.store.put('unrelated', 'keep.txt', Buffer.from('x'), 'text/plain');
    const { status } = statuses();

    await runRestore(s.deps, request(checked), status);

    expect(await text(s.store, 'inbox', 'stale.pdf')).toBeNull();
    expect(await text(s.store, 'runs', 'step-cache/old.json')).toBeNull();
    expect(await text(s.store, 'published', 'ingest/old.json')).toBeNull();
    expect(await text(s.store, 'unrelated', 'keep.txt')).toBe('x');
    // The backups bucket is never a restored one.
    expect(await s.store.get('backups', uploadFileKey(UPLOAD))).not.toBeNull();
  });

  it('reports a document whose file was not in the backup', async () => {
    const { file, checked } = await backupOf();
    const s = await server(file);
    s.side.references = [
      { bucket: 'inbox', key: 'docs/a.pdf' },
      { bucket: 'inbox', key: 'docs/gone.pdf' },
      { bucket: 'published', key: 'ingest/gone.json' },
    ];
    const { status } = statuses();

    const report = await runRestore(s.deps, request(checked), status);

    expect(report.missingObjects).toEqual([
      { bucket: 'inbox', key: 'docs/gone.pdf' },
      { bucket: 'published', key: 'ingest/gone.json' },
    ]);
  });

  it('two restores in one second get databases of their own', async () => {
    const { file, checked } = await backupOf();
    const at = new Date('2026-10-17T12:00:00.000Z');
    const s = await server(file, { now: () => at });

    const first = await runRestore(s.deps, request(checked), statuses().status);
    const second = await runRestore(s.deps, request(checked), statuses().status);

    expect(first.previousDatabase).toMatch(/^ingestion_before_restore_20261017120000_[0-9a-f]{4}$/);
    expect(second.previousDatabase).not.toBe(first.previousDatabase);
    expect(s.db.databases.has(first.previousDatabase)).toBe(true);
    expect(s.db.databases.has(second.previousDatabase)).toBe(true);
  });

  it('refuses before changing anything when a database name is taken', async () => {
    const { file, checked } = await backupOf();
    const s = await server(file);
    s.db.databaseExists = async (name) => name.startsWith('ingestion_before_restore_');
    const { seen, status } = statuses();

    await expect(runRestore(s.deps, request(checked), status)).rejects.toThrow(
      /^a database named ingestion_before_restore_\d{14}_[0-9a-f]{4} already exists: restore again$/,
    );
    expect(s.db.calls).toEqual([]);
    expect(s.live.calls).toEqual([]);
    expect(seen.map((x) => x.phase)).toEqual(['failed']);
    expect((await s.deps.gate.current()).enabled).toBe(false);
    expect((await s.maintenance.get()).enabled).toBe(false);
  });

  it('a failure before the swap drops the side database and keeps the live one', async () => {
    const { file, checked } = await backupOf();
    const s = await server(file, {
      migrate: async () => {
        throw new Error('migration 0050_x.sql failed: boom');
      },
    });
    const { seen, status } = statuses();

    await expect(runRestore(s.deps, request(checked), status)).rejects.toThrow('boom');

    expect([...s.db.databases.keys()]).toEqual(['ingestion']);
    expect(s.db.databases.get('ingestion')!.toString()).toBe('PGDMP staging');
    expect(s.db.calls.some((c) => c.startsWith('drop ingestion_restore_'))).toBe(true);
    expect(s.db.calls.some((c) => c.startsWith('swap'))).toBe(false);
    const last = seen.at(-1)!;
    expect(last.phase).toBe('failed');
    expect(last.error).toBe(`migration 0050_x.sql failed: boom (${PARTLY_REPLACED})`);
    expect(s.live.paused).not.toBeNull();
    expect(await s.deps.gate.current()).toMatchObject({ enabled: true, message: RESTORE_MESSAGE });
    expect(await s.maintenance.get()).toMatchObject({ enabled: true, message: RESTORE_MESSAGE });
    // The row keeps everyone out; the admin keeps control: the gate follows the row again.
    await s.deps.gate.set({ enabled: false, message: '' }, 'Admin');
    expect((await s.deps.gate.current()).enabled).toBe(false);
  });

  it('keeps the report when a step after the swap fails', async () => {
    const { file, checked } = await backupOf();
    const s = await server(file, {
      rotateAdminToken: async () => {
        throw new Error('the access database is unreachable');
      },
    });
    const { seen, status } = statuses();

    await expect(runRestore(s.deps, request(checked), status)).rejects.toThrow('unreachable');

    const last = seen.at(-1)!;
    expect(last.phase).toBe('failed');
    expect(last.report!.previousDatabase).toMatch(/^ingestion_before_restore_\d{14}_[0-9a-f]{4}$/);
    expect(last.report!.adminTokenRotated).toBe(false);
    expect(last.error).toBe(
      `the database WAS restored (the previous one is kept as ${last.report!.previousDatabase}), but the access database is unreachable`,
    );
    expect(s.db.databases.get('ingestion')!.toString()).toBe('PGDMP production');
    expect(await s.deps.gate.current()).toEqual(await s.maintenance.get());
    expect((await s.maintenance.get()).enabled).toBe(true);
  });

  it('does not say objects were replaced when none were', async () => {
    const { file, checked } = await backupOf();
    const s = await server(file);
    s.db.restore = async () => {
      throw new Error('pg_restore exited with 1: bad');
    };
    const { seen, status } = statuses();

    await expect(runRestore(s.deps, request(checked), status)).rejects.toThrow('bad');
    expect(seen.at(-1)!.error).toBe('pg_restore exited with 1: bad');
    expect([...s.db.databases.keys()]).toEqual(['ingestion']);
  });

  it('reports when the backup has no triple store', async () => {
    const { file, checked } = await backupOf({ triples: new FakeTripleStore(null) });
    const s = await server(file);
    const { status } = statuses();

    const report = await runRestore(s.deps, request(checked), status);

    expect(report.triples).toBe('none-in-backup');
    expect(s.side.rebuilds).toEqual(['rebuild']);
  });

  it('a copy from a backup without triples reloads and re-mints in one job', async () => {
    const { file, checked } = await backupOf({ triples: new FakeTripleStore(null) });
    const s = await server(file);
    const { status } = statuses();

    const report = await runRestore(s.deps, request(checked, 'copy'), status);

    expect(report.triples).toBe('reminting');
    expect(s.side.rebuilds).toEqual(['rebuild-remint']);
  });

  it('reports when this server has no triple store', async () => {
    const { file, checked } = await backupOf();
    const s = await server(file, { triples: new FakeTripleStore(null) });
    const { status } = statuses();

    const report = await runRestore(s.deps, request(checked), status);

    expect(report.triples).toBe('no-triple-store');
    expect(s.side.rebuilds).toEqual([]);
  });

  it('cancels jobs still running after the wait, before writing anything', async () => {
    const { file, checked } = await backupOf();
    const s = await server(file);
    s.live.running = 2;
    const { status } = statuses();

    await runRestore(s.deps, request(checked), status);

    expect(s.live.calls).toEqual(['pause', 'cancel restoring a backup']);
  });

  it('lists data-lake consumers whose keys this server lacks', async () => {
    const { file, checked } = await backupOf();
    const issuer = new MemoryS3KeyIssuer();
    await issuer.createUser('lake-acme', []);
    const { accessKeyId } = await issuer.createKey('lake-acme');
    const s = await server(file, { lakeIssuer: issuer });
    s.side.accessKeys = [
      { consumer: 'Acme lake', userName: 'lake-acme', accessKeyId },
      { consumer: 'Beta lake', userName: 'lake-beta', accessKeyId: 'AKBETA' },
    ];
    const { status } = statuses();

    const report = await runRestore(s.deps, request(checked), status);

    expect(report.lakeKeysToReissue).toEqual(['Beta lake']);
  });

  it('forces maintenance for non-admins throughout', async () => {
    const { file, checked } = await backupOf();
    const s = await server(file);
    const during: boolean[] = [];
    const status = async (x: Partial<RestoreStatus>) => {
      if (x.phase === 'restoring') during.push((await s.deps.gate.current()).enabled);
    };

    await runRestore(s.deps, request(checked), status);

    expect(during).toHaveLength(9);
    expect(during.every(Boolean)).toBe(true);
  });
});

describe('BackupService.recover', () => {
  it('recovers an interrupted restore as failed', async () => {
    const store = new MemoryObjectStore();
    const maintenance = new MemoryMaintenanceRepo();
    const base: RestoreStatus = {
      id: 'r1',
      mode: 'deployment',
      phase: 'restoring',
      step: 'objects',
      done: 4,
      of: 9,
      manifest: null,
      plan: null,
      error: null,
      report: null,
      startedBy: 'Admin',
      updatedAt: '2026-10-17T12:00:00.000Z',
    };
    await saveRestoreStatus(store, BUCKETS.backups, base);
    await saveRestoreStatus(store, BUCKETS.backups, { ...base, id: 'r0', phase: 'succeeded' });
    const service = new BackupService({
      ...fakeBackupDeps({ store }),
      queue: new MemoryQueueControlRepo(),
      maintenance,
    });

    await service.recover();

    const saved = JSON.parse((await text(store, BUCKETS.backups, restoreStatusKey('r1')))!);
    expect(saved).toMatchObject({ phase: 'failed', error: RESTORE_INTERRUPTED });
    const other = JSON.parse((await text(store, BUCKETS.backups, restoreStatusKey('r0')))!);
    expect(other.phase).toBe('succeeded');
    expect(await maintenance.get()).toMatchObject({ enabled: true, message: RESTORE_MESSAGE });
  });

  it('leaves maintenance alone when nothing was interrupted', async () => {
    const maintenance = new MemoryMaintenanceRepo();
    const service = new BackupService({
      ...fakeBackupDeps(),
      queue: new MemoryQueueControlRepo(),
      maintenance,
    });
    await service.recover();
    expect((await maintenance.get()).enabled).toBe(false);
  });
});

describe('MaintenanceGate', () => {
  it('force overrides the stored row until release', async () => {
    const repo = new MemoryMaintenanceRepo();
    const gate = new MaintenanceGate(repo);
    const forced = {
      enabled: true,
      message: RESTORE_MESSAGE,
      since: '2026-10-17T12:00:00.000Z',
      updatedBy: 'Admin',
      updatedAt: '2026-10-17T12:00:00.000Z',
    };
    gate.force(forced);
    expect(await gate.current()).toEqual(forced);
    await gate.set({ enabled: false, message: '' }, 'Admin');
    expect(await gate.current()).toEqual(forced);
    expect((await repo.get()).enabled).toBe(false);

    await repo.set({ enabled: true, message: 'restored row' }, null);
    gate.release();
    expect(await gate.current()).toMatchObject({ enabled: true, message: 'restored row' });
  });
});
