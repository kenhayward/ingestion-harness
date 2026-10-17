import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { copyPlan, OPERATOR_REFUSED, type BackupView, type RestoreStatus } from '@ih/shared';
import { createBackup } from '../src/backup/create.js';
import { MemoryQueueControlRepo } from '../src/backup/queue-control.js';
import { BackupService } from '../src/backup/service.js';
import { BackupUploads } from '../src/backup/uploads.js';
import { MemoryMaintenanceRepo } from '../src/maintenance/repo.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import {
  FakeDatabaseTools,
  fakeBackupDeps,
  FakeLiveDatabase,
  FakeSideDatabase,
  TEST_MASTER,
} from './backup-fakes.js';
import { accessApp, signInNewUser } from './helpers.js';

/** A database whose dump waits until `release()`, so a backup can be caught running. */
class HeldDatabase extends FakeDatabaseTools {
  private open: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));

  release(): void {
    this.open();
  }

  override async dump() {
    await this.gate;
    return super.dump();
  }
}

async function setup(db = new FakeDatabaseTools()) {
  const deps = fakeBackupDeps({ db });
  const queue = new MemoryQueueControlRepo();
  const backup = new BackupService({ ...deps, queue, maintenance: new MemoryMaintenanceRepo() });
  const ctx = await accessApp({ backup });
  const as = (cookie: string) => ({
    status: () => ctx.app.inject({ url: '/api/backup', headers: { cookie } }),
    start: () =>
      ctx.app.inject({ method: 'POST', url: '/api/backup/backups', headers: { cookie } }),
    download: (id: string) =>
      ctx.app.inject({ url: `/api/backup/backups/${id}/file`, headers: { cookie } }),
    queue: (paused: boolean) =>
      ctx.app.inject({
        method: 'PUT',
        url: '/api/backup/queue',
        headers: { cookie },
        payload: { paused },
      }),
  });
  return { ...ctx, deps, queue, backup, admin: as(ctx.adminCookie), as };
}

describe('backup routes', () => {
  it('an admin starts a backup and sees it finish', async () => {
    const { admin, backup, deps } = await setup();
    const started = await admin.start();
    expect(started.statusCode).toBe(202);
    const view = started.json<BackupView>();
    expect(view).toMatchObject({ status: 'running', createdBy: 'Admin', error: null });
    await backup.settled();
    const status = (await admin.status()).json();
    expect(status.backup).toMatchObject({
      id: view.id,
      status: 'succeeded',
      createdBy: 'Admin',
      error: null,
      progress: { phase: 'finishing', done: 1, of: 1 },
    });
    expect(status.backup.bytes).toBeGreaterThan(0);
    expect(status.backup.finishedAt).toEqual(expect.any(String));
    expect(status.lastSucceeded).toEqual(status.backup);
    expect(status.restore).toBeNull();
    expect(status.queue).toEqual({ paused: false, pausedAt: null, pausedBy: null, reason: null });
    // The record lives in the backups bucket, beside the file.
    const record = await deps.store.get('backups', `backups/${view.id}.json`);
    expect(JSON.parse(record!.toString('utf8'))).toMatchObject({ status: 'succeeded' });
  });

  it('a second start while running is a 409', async () => {
    const db = new HeldDatabase();
    const { admin, backup } = await setup(db);
    expect((await admin.start()).statusCode).toBe(202);
    const second = await admin.start();
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'a backup or restore is already running' });
    expect((await admin.status()).json().backup.status).toBe('running');
    db.release();
    await backup.settled();
    expect((await admin.start()).statusCode).toBe(202);
    await backup.settled();
  });

  it('a new backup replaces the previous one once it succeeds', async () => {
    const { admin, backup, deps } = await setup();
    const first = (await admin.start()).json<BackupView>();
    await backup.settled();
    const second = (await admin.start()).json<BackupView>();
    await backup.settled();
    const keys = [...deps.store.objects.keys()].filter((k) => k.startsWith('backups/'));
    expect(keys.sort()).toEqual(
      [`backups/${second.id}.ctbak`, `backups/backups/${second.id}.json`].sort(),
    );
    expect((await admin.download(first.id)).statusCode).toBe(404);
  });

  it('a failed backup keeps the previous one and shows the reason', async () => {
    const db = new FakeDatabaseTools();
    const { admin, backup, deps } = await setup(db);
    const first = (await admin.start()).json<BackupView>();
    await backup.settled();
    db.applied = [];
    await admin.start();
    await backup.settled();
    const status = (await admin.status()).json();
    expect(status.backup).toMatchObject({
      status: 'failed',
      error: 'the database has no migrations applied',
    });
    expect(status.lastSucceeded).toMatchObject({ id: first.id, status: 'succeeded' });
    expect(await deps.store.get('backups', `${first.id}.ctbak`)).not.toBeNull();
    expect((await admin.download(first.id)).statusCode).toBe(200);
  });

  it('a success whose record cannot be saved fails and keeps the previous backup', async () => {
    const { admin, backup, deps } = await setup();
    const first = (await admin.start()).json<BackupView>();
    await backup.settled();
    const put = deps.store.put.bind(deps.store);
    let failSucceeded = true;
    deps.store.put = async (bucket, key, body, type) => {
      if (failSucceeded && key.endsWith('.json') && body.toString('utf8').includes('"succeeded"')) {
        throw new Error('S3 is down');
      }
      return put(bucket, key, body, type);
    };
    const second = (await admin.start()).json<BackupView>();
    await backup.settled();
    failSucceeded = false;
    const status = (await admin.status()).json();
    expect(status.backup).toMatchObject({ id: second.id, status: 'failed', error: 'S3 is down' });
    expect(status.lastSucceeded).toMatchObject({ id: first.id });
    expect(await deps.store.get('backups', `${second.id}.ctbak`)).toBeNull();
    expect((await admin.download(first.id)).statusCode).toBe(200);
  });

  it('a designer gets 403 and an operator OPERATOR_REFUSED', async () => {
    const { app, access, as, userCookie } = await setup();
    const designer = as(userCookie);
    for (const res of [
      await designer.status(),
      await designer.start(),
      await designer.download('00000000-0000-4000-8000-000000000000'),
      await designer.queue(true),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'admins only' });
    }
    const { cookie } = await signInNewUser(app, access, 'Olu', 'operator');
    const operator = as(cookie);
    for (const res of [await operator.status(), await operator.start()]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: OPERATOR_REFUSED });
    }
  });

  it('download streams the file as an attachment', async () => {
    const { admin, backup, deps } = await setup();
    const { id } = (await admin.start()).json<BackupView>();
    await backup.settled();
    const res = await admin.download(id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    // The fake clock starts at 12:00:00 UTC and ticks a second a call.
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="ct-backup-production-20261017-1200.ctbak"',
    );
    const stored = await deps.store.get('backups', `${id}.ctbak`);
    expect(res.headers['content-length']).toBe(String(stored!.length));
    expect(res.rawPayload.equals(stored!)).toBe(true);
  });

  it('download is a 404 for an unknown, running or malformed id', async () => {
    const db = new HeldDatabase();
    const { admin, backup } = await setup(db);
    expect((await admin.download('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await admin.download('not-an-id')).statusCode).toBe(404);
    const { id } = (await admin.start()).json<BackupView>();
    expect((await admin.download(id)).statusCode).toBe(404);
    db.release();
    await backup.settled();
  });

  it('pausing and resuming the queue records who', async () => {
    const { admin, queue } = await setup();
    const paused = await admin.queue(true);
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ paused: true, pausedBy: 'Admin', reason: null });
    expect(paused.json().pausedAt).toEqual(expect.any(String));
    expect((await admin.status()).json().queue).toMatchObject({ paused: true, pausedBy: 'Admin' });
    const resumed = await admin.queue(false);
    expect(resumed.json()).toEqual({ paused: false, pausedAt: null, pausedBy: null, reason: null });
    expect(queue.wakes).toBe(1);
    expect((await admin.queue('yes' as unknown as boolean)).statusCode).toBe(400);
  });

  it('has no last success before the first backup', async () => {
    const { admin } = await setup();
    expect((await admin.status()).json()).toMatchObject({ backup: null, lastSucceeded: null });
  });

  it('without a backup service every route is a 503', async () => {
    const ctx = await accessApp({ backup: null });
    const res = await ctx.app.inject({ url: '/api/backup', headers: { cookie: ctx.adminCookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/LLM_SECRETS_KEY/);
  });
});

describe('BackupService', () => {
  it('writes progress to the bucket at most every 2 seconds, and on finish', async () => {
    let clock = Date.parse('2026-10-17T12:00:00.000Z');
    const deps = fakeBackupDeps({ now: () => new Date(clock) });
    const puts: string[] = [];
    const put = deps.store.put.bind(deps.store);
    deps.store.put = async (bucket, key, body, type) => {
      if (key.endsWith('.json')) puts.push(JSON.parse(body.toString('utf8')).status);
      return put(bucket, key, body, type);
    };
    // 25 objects: one progress report each, a tenth of a second apart.
    for (let i = 0; i < 25; i++) await deps.store.put('inbox', `k${i}`, Buffer.from('x'), 'a/b');
    const getStream = deps.store.getStream.bind(deps.store);
    deps.store.getStream = async (bucket, key) => {
      clock += 100;
      return getStream(bucket, key);
    };
    puts.length = 0;
    const service = new BackupService({
      ...deps,
      queue: new MemoryQueueControlRepo(),
      maintenance: new MemoryMaintenanceRepo(),
    });
    service.startBackup('Ada');
    await service.settled();
    // The first write when it starts, one about two seconds in, and the final one.
    expect(puts).toEqual(['running', 'running', 'succeeded']);
  });

  it('reads a backup left running by a restarted API as failed', async () => {
    const deps = fakeBackupDeps();
    const view: BackupView = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'running',
      startedAt: '2026-10-17T11:00:00.000Z',
      finishedAt: null,
      createdBy: 'Ada',
      bytes: null,
      error: null,
      progress: null,
    };
    await deps.store.put(
      'backups',
      `backups/${view.id}.json`,
      Buffer.from(JSON.stringify({ ...view, fileName: null })),
      'application/json',
    );
    const service = new BackupService({
      ...deps,
      queue: new MemoryQueueControlRepo(),
      maintenance: new MemoryMaintenanceRepo(),
    });
    expect((await service.status()).backup).toMatchObject({
      status: 'failed',
      error: 'the API restarted during the backup',
    });
    expect(await service.download(view.id)).toBeNull();
  });

  it('download returns the stream, its size and the file name', async () => {
    const deps = fakeBackupDeps();
    const service = new BackupService({
      ...deps,
      queue: new MemoryQueueControlRepo(),
      maintenance: new MemoryMaintenanceRepo(),
    });
    const { id } = service.startBackup('Ada');
    await service.settled();
    const file = await service.download(id);
    expect(file?.fileName).toBe('ct-backup-production-20261017-1200.ctbak');
    expect(file?.body).toBeInstanceOf(Readable);
    file?.body.resume();
  });
});

const LOCAL = ['0001_init.sql', '202610171218_backup_restore.sql'];

/** Production's backup file, made with the fakes' key (TEST_MASTER). */
async function backupFile(): Promise<Buffer> {
  const source = fakeBackupDeps({ db: new FakeDatabaseTools(Buffer.from('PGDMP production')) });
  await source.store.put('inbox', 'docs/a.pdf', Buffer.from('%PDF-1 a'), 'application/pdf');
  const { key } = await createBackup(source, 'b1', 'Pat', () => {});
  return (await source.store.get('backups', key))!;
}

/** This server, with restores set up on fakes. */
async function restoreSetup(
  db: FakeDatabaseTools = new FakeDatabaseTools(),
  over: { checkExpiryMs?: number } = {},
) {
  const store = new MemoryObjectStore();
  const deps = fakeBackupDeps({ db, store });
  const backup = new BackupService({
    ...deps,
    previousMaster: null,
    ...over,
    queue: new MemoryQueueControlRepo(),
    maintenance: new MemoryMaintenanceRepo(),
  });
  const backupUploads = new BackupUploads({ store, bucket: 'backups' });
  const ctx = await accessApp({ backup, backupUploads, store });
  const rotated: string[] = [];
  backup.enableRestore({
    gate: ctx.app.maintenance,
    localMigrations: async () => LOCAL,
    migrate: async () => {},
    rotateAdminToken: async () => void rotated.push('rotated'),
    createEmbedJobs: async () => 0,
    liveDatabaseName: 'ingestion',
    live: new FakeLiveDatabase(),
    openSide: async () => new FakeSideDatabase(),
    lakeIssuer: null,
    jobWaitMs: 0,
  });
  const admin = { cookie: ctx.adminCookie };
  /** Uploads the file through the routes (one part) and returns the upload id. */
  const upload = async (file: Buffer, complete = true) => {
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/backup/uploads',
      headers: admin,
      payload: { size: file.length, fileName: 'prod.ctbak' },
    });
    const { id } = started.json<{ id: string }>();
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/backup/uploads/${id}/parts/0`,
      headers: { ...admin, 'content-type': 'application/octet-stream' },
      payload: file,
    });
    if (complete) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/backup/uploads/${id}/complete`,
        headers: admin,
      });
    }
    return id;
  };
  const start = (payload: object, headers: Record<string, string> = admin) =>
    ctx.app.inject({ method: 'POST', url: '/api/backup/restores', headers, payload });
  const read = (id: string, headers: Record<string, string> = {}) =>
    ctx.app.inject({ url: `/api/backup/restores/${id}`, headers });
  const confirm = (id: string, instanceName: string, headers: Record<string, string>) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/backup/restores/${id}/confirm`,
      headers,
      payload: { instanceName },
    });
  const cancel = (id: string, headers: Record<string, string>) =>
    ctx.app.inject({ method: 'DELETE', url: `/api/backup/restores/${id}`, headers });
  const overview = () => ctx.app.inject({ url: '/api/backup', headers: admin });
  return { ...ctx, backup, store, admin, rotated, upload, start, read, confirm, cancel, overview };
}

type Started = { status: RestoreStatus; token: string };

describe('restore routes', () => {
  it('copy mode without a key is a 400', async () => {
    const s = await restoreSetup();
    const uploadId = await s.upload(await backupFile());
    const res = await s.start({ uploadId, mode: 'copy' });
    expect(res.statusCode).toBe(400);
    const malformed = await s.start({ uploadId, mode: 'copy', key: 'not a key' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toMatch(/must be 32 bytes, base64/);
    expect(s.backup.isBusy()).toBe(false);
  });

  it('a wrong key ends the check as failed with "this key does not open the backup"', async () => {
    const s = await restoreSetup();
    const uploadId = await s.upload(await backupFile());
    const key = Buffer.alloc(32, 9).toString('base64');
    const res = await s.start({ uploadId, mode: 'copy', key });
    expect(res.statusCode).toBe(202);
    const { status, token } = res.json<Started>();
    expect(status).toMatchObject({ mode: 'copy', phase: 'checking', startedBy: 'Admin' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await s.backup.settled();
    const read = await s.read(status.id, { 'x-restore-token': token });
    expect(read.json()).toMatchObject({
      phase: 'failed',
      error: 'this key does not open the backup',
    });
    // A failed check lets go of the lock, and there is nothing to confirm.
    expect(s.backup.isBusy()).toBe(false);
    const confirm = await s.confirm(status.id, 'production', { 'x-restore-token': token });
    expect([confirm.statusCode, confirm.json()]).toEqual([
      409,
      { error: 'the restore is not waiting to be confirmed' },
    ]);
    // The status file keeps only the token's hash.
    const raw = (await s.store.get('backups', `restores/${status.id}.json`))!.toString('utf8');
    expect(raw).not.toContain(token);
  });

  it('a checked copy carries its plan and the manifest', async () => {
    const s = await restoreSetup();
    const uploadId = await s.upload(await backupFile());
    const key = TEST_MASTER.toString('base64');
    const { status, token } = (await s.start({ uploadId, mode: 'copy', key })).json<Started>();
    await s.backup.settled();
    const read = (await s.read(status.id, { 'x-restore-token': token })).json<RestoreStatus>();
    expect(read).toMatchObject({ phase: 'checked', error: null, plan: copyPlan() });
    expect(read.manifest?.instanceName).toBe('production');
    expect((await s.read(status.id, s.admin)).json()).toEqual(read);
    expect((await s.overview()).json().restore).toEqual(read);
  });

  it('confirm needs the instance name', async () => {
    const s = await restoreSetup();
    const uploadId = await s.upload(await backupFile());
    const { status, token } = (await s.start({ uploadId, mode: 'deployment' })).json<Started>();
    await s.backup.settled();
    const wrong = await s.confirm(status.id, 'staging', { 'x-restore-token': token });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: 'type production to confirm' });
    const ok = await s.confirm(status.id, 'production', { 'x-restore-token': token });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({ phase: 'restoring' });
    await s.backup.settled();
    const done = (await s.read(status.id, { 'x-restore-token': token })).json<RestoreStatus>();
    expect(done).toMatchObject({ phase: 'succeeded', error: null, plan: null });
    expect(done.report?.previousDatabase).toMatch(/^ingestion_before_restore_/);
    expect(s.rotated).toEqual(['rotated']);
    expect(s.backup.isBusy()).toBe(false);
    // Over: nothing more to confirm or cancel.
    expect((await s.confirm(status.id, 'production', s.admin)).statusCode).toBe(409);
    expect((await s.cancel(status.id, s.admin)).statusCode).toBe(409);
  });

  it('a successful restore removes the uploaded file; a failed check keeps it', async () => {
    const s = await restoreSetup();
    const uploadId = await s.upload(await backupFile());
    const fileKey = `uploads/${uploadId}.ctbak`;
    const wrong = Buffer.alloc(32, 9).toString('base64');
    await s.start({ uploadId, mode: 'copy', key: wrong });
    await s.backup.settled();
    expect(await s.store.get('backups', fileKey)).not.toBeNull();

    const { status, token } = (await s.start({ uploadId, mode: 'deployment' })).json<Started>();
    await s.backup.settled();
    await s.confirm(status.id, 'production', { 'x-restore-token': token });
    await s.backup.settled();
    expect((await s.read(status.id, s.admin)).json()).toMatchObject({ phase: 'succeeded' });
    expect(await s.store.get('backups', fileKey)).toBeNull();
    expect(await s.store.get('backups', `uploads/${uploadId}.json`)).toBeNull();
  });

  it('the token reads status after the session is gone', async () => {
    const s = await restoreSetup();
    const uploadId = await s.upload(await backupFile());
    const { status, token } = (await s.start({ uploadId, mode: 'deployment' })).json<Started>();
    await s.backup.settled();
    await s.app.inject({ method: 'POST', url: '/api/auth/logout', headers: s.admin });
    expect((await s.read(status.id, s.admin)).statusCode).toBe(404);
    const read = await s.read(status.id, { 'x-restore-token': token });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: status.id, phase: 'checked' });
  });

  it('without token or admin the status is a 404', async () => {
    const s = await restoreSetup();
    const uploadId = await s.upload(await backupFile());
    const { status } = (await s.start({ uploadId, mode: 'deployment' })).json<Started>();
    await s.backup.settled();
    const wrongToken = { 'x-restore-token': 'A'.repeat(43) };
    const designer = { cookie: s.userCookie };
    const operator = { cookie: (await signInNewUser(s.app, s.access, 'Olu', 'operator')).cookie };
    for (const headers of [{}, wrongToken, designer, operator]) {
      const res = await s.read(status.id, headers);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'restore not found' });
      expect((await s.confirm(status.id, 'production', headers)).statusCode).toBe(404);
      expect((await s.cancel(status.id, headers)).statusCode).toBe(404);
    }
    expect((await s.read('not-an-id', s.admin)).statusCode).toBe(404);
    expect((await s.start({ uploadId, mode: 'deployment' }, designer)).statusCode).toBe(403);
  });

  it('a restore while a backup runs is a 409', async () => {
    const db = new HeldDatabase();
    const s = await restoreSetup(db);
    const uploadId = await s.upload(await backupFile());
    const backup = await s.app.inject({
      method: 'POST',
      url: '/api/backup/backups',
      headers: s.admin,
    });
    expect(backup.statusCode).toBe(202);
    const res = await s.start({ uploadId, mode: 'deployment' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'a backup or restore is already running' });
    db.release();
    await s.backup.settled();
  });

  it('a checked restore holds the lock until it is cancelled', async () => {
    const s = await restoreSetup();
    const uploadId = await s.upload(await backupFile());
    const { status, token } = (await s.start({ uploadId, mode: 'deployment' })).json<Started>();
    await s.backup.settled();
    const busy = { error: 'a backup or restore is already running' };
    const backup = await s.app.inject({
      method: 'POST',
      url: '/api/backup/backups',
      headers: s.admin,
    });
    expect([backup.statusCode, backup.json()]).toEqual([409, busy]);
    const upload = await s.app.inject({
      method: 'POST',
      url: '/api/backup/uploads',
      headers: s.admin,
      payload: { size: 10, fileName: 'x.ctbak' },
    });
    expect([upload.statusCode, upload.json()]).toEqual([409, busy]);
    expect((await s.start({ uploadId, mode: 'deployment' })).statusCode).toBe(409);
    const cancelled = await s.cancel(status.id, { 'x-restore-token': token });
    expect(cancelled.statusCode).toBe(204);
    expect(s.backup.isBusy()).toBe(false);
    expect((await s.read(status.id, s.admin)).json()).toMatchObject({
      phase: 'failed',
      error: 'cancelled: nothing was changed',
    });
    // The upload is still there: the same file can be checked again.
    expect((await s.start({ uploadId, mode: 'deployment' })).statusCode).toBe(202);
    await s.backup.settled();
  });

  it('a confirm whose status cannot be saved fails the restore and lets go of the lock', async () => {
    const s = await restoreSetup();
    const uploadId = await s.upload(await backupFile());
    const { status } = (await s.start({ uploadId, mode: 'deployment' })).json<Started>();
    await s.backup.settled();
    // The write of `restoring` fails once; the failure is then saved.
    const put = s.store.put.bind(s.store);
    let fail = true;
    s.store.put = async (bucket, key, body, type) => {
      if (fail && key.startsWith('restores/')) {
        fail = false;
        throw new Error('S3 is down');
      }
      return put(bucket, key, body, type);
    };
    await expect(s.backup.confirmRestore(status.id, 'production', 'Admin')).rejects.toThrow(
      'S3 is down',
    );
    expect(s.backup.isBusy()).toBe(false);
    expect((await s.read(status.id, s.admin)).json()).toMatchObject({
      phase: 'failed',
      error: 'S3 is down',
    });
    const backup = await s.app.inject({
      method: 'POST',
      url: '/api/backup/backups',
      headers: s.admin,
    });
    expect(backup.statusCode).toBe(202);
    await s.backup.settled();
  });

  it('a checked restore left unconfirmed expires and drops its key', async () => {
    const s = await restoreSetup(new FakeDatabaseTools(), { checkExpiryMs: 20 });
    const uploadId = await s.upload(await backupFile());
    const { status, token } = (await s.start({ uploadId, mode: 'deployment' })).json<Started>();
    await s.backup.settled();
    expect((await s.read(status.id, s.admin)).json().phase).toBe('checked');
    await new Promise((resolve) => setTimeout(resolve, 60));
    await s.backup.settled();
    expect(s.backup.isBusy()).toBe(false);
    expect((await s.read(status.id, s.admin)).json()).toMatchObject({
      phase: 'failed',
      error: 'the check expired: start the restore again',
    });
    const confirm = await s.confirm(status.id, 'production', { 'x-restore-token': token });
    expect(confirm.statusCode).toBe(409);
  });

  it('a confirmed or cancelled restore does not expire', async () => {
    const s = await restoreSetup(new FakeDatabaseTools(), { checkExpiryMs: 20 });
    const uploadId = await s.upload(await backupFile());
    const first = (await s.start({ uploadId, mode: 'deployment' })).json<Started>();
    await s.backup.settled();
    expect((await s.cancel(first.status.id, s.admin)).statusCode).toBe(204);
    const second = (await s.start({ uploadId, mode: 'deployment' })).json<Started>();
    await s.backup.settled();
    expect((await s.confirm(second.status.id, 'production', s.admin)).statusCode).toBe(202);
    await s.backup.settled();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await s.backup.settled();
    expect((await s.read(first.status.id, s.admin)).json().error).toBe(
      'cancelled: nothing was changed',
    );
    expect((await s.read(second.status.id, s.admin)).json().phase).toBe('succeeded');
  });

  it('an upload that is not complete is a 409', async () => {
    const s = await restoreSetup();
    const uploadId = await s.upload(await backupFile(), false);
    const res = await s.start({ uploadId, mode: 'deployment' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'the upload is not complete' });
    expect(s.backup.isBusy()).toBe(false);
  });
});
