import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { OPERATOR_REFUSED, type BackupView } from '@ih/shared';
import { MemoryQueueControlRepo } from '../src/backup/queue-control.js';
import { BackupService } from '../src/backup/service.js';
import { FakeDatabaseTools, fakeBackupDeps } from './backup-fakes.js';
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
  const backup = new BackupService({ ...deps, queue });
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
    expect(await deps.store.get('backups', `${first.id}.ctbak`)).not.toBeNull();
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
    const service = new BackupService({ ...deps, queue: new MemoryQueueControlRepo() });
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
    const service = new BackupService({ ...deps, queue: new MemoryQueueControlRepo() });
    expect((await service.status()).backup).toMatchObject({
      status: 'failed',
      error: 'the API restarted during the backup',
    });
    expect(await service.download(view.id)).toBeNull();
  });

  it('download returns the stream, its size and the file name', async () => {
    const deps = fakeBackupDeps();
    const service = new BackupService({ ...deps, queue: new MemoryQueueControlRepo() });
    const { id } = service.startBackup('Ada');
    await service.settled();
    const file = await service.download(id);
    expect(file?.fileName).toBe('ct-backup-production-20261017-1200.ctbak');
    expect(file?.body).toBeInstanceOf(Readable);
    file?.body.resume();
  });
});
