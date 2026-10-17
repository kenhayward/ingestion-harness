import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  BackupViewSchema,
  copyPlan,
  RestoreStatusSchema,
  type BackupView,
  type QueueControlView,
  type RestoreMode,
  type RestoreStatus,
} from '@ih/shared';
import { z } from 'zod';
import type { MaintenanceRepo } from '../maintenance/repo.js';
import { checkBackup, type CheckedBackup } from './check.js';
import { backupFileKey, createBackup } from './create.js';
import type { BackupDeps } from './ports.js';
import type { QueueControlRepo } from './queue-control.js';
import {
  readRestoreStatuses,
  RESTORE_INTERRUPTED,
  RESTORE_MESSAGE,
  restoreStatusKey,
  runRestore,
  saveRestoreStatus,
  type RestoreDeps,
} from './restore.js';

/** The 409 for a second backup, or a restore, while one runs. */
export const BUSY = 'a backup or restore is already running';

/** A backup left `running` by an API that stopped is read as failed with this reason. */
export const INTERRUPTED = 'the API restarted during the backup';

/** Progress is written to the bucket at most this often (and when the backup ends). */
export const PROGRESS_WRITE_MS = 2000;

export class BackupBusyError extends Error {
  constructor() {
    super(BUSY);
    this.name = 'BackupBusyError';
  }
}

/** The 409 for confirming or cancelling a restore that is not checked and waiting. */
export const NOT_WAITING = 'the restore is not waiting to be confirmed';
/** A cancelled restore's reason (it is saved as failed: nothing was changed). */
export const RESTORE_CANCELLED = 'cancelled: nothing was changed';

/** A refused restore action, with the HTTP status the route answers. */
export class RestoreRefusal extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'RestoreRefusal';
  }
}

/** What a restore needs beyond a backup's deps (server.ts wires them once the app exists). */
export type RestoreSetup = Omit<RestoreDeps, keyof BackupDeps>;

/**
 * A restore's status file: the status and the sha256 of its token (never the token). `recover()`
 * rewrites a cut-off restore without it: then only an admin can read it.
 */
const RestoreRecordSchema = RestoreStatusSchema.extend({ tokenSha256: z.string().optional() });
type RestoreRecord = z.infer<typeof RestoreRecordSchema>;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const statusOf = ({ tokenSha256: _hash, ...status }: RestoreRecord): RestoreStatus => status;

/** A restore from its check to its end: the lock is held all along. */
interface RestoreRun {
  record: RestoreRecord;
  uploadKey: string;
  /** Set once the check passed; the opening key stays in memory only. */
  checked: CheckedBackup | null;
}

export interface BackupServiceDeps extends BackupDeps {
  queue: QueueControlRepo;
  /** The maintenance row, set on when an interrupted restore is found at start. */
  maintenance: Pick<MaintenanceRepo, 'set'>;
  /** `LLM_SECRETS_KEY_PREVIOUS`: a restore as this deployment tries it after `master`. */
  previousMaster?: Buffer | null;
  /** Where a failed backup's error is logged too (it is always in its record). */
  log?: { error(obj: object, msg: string): void };
}

/** A backup's record at `backups/<id>.json` in the backups bucket: its view and its file name. */
const RecordSchema = BackupViewSchema.extend({ fileName: z.string().nullable() });
type BackupRecord = z.infer<typeof RecordSchema>;

const RECORD_PREFIX = 'backups/';
const recordKey = (id: string) => `${RECORD_PREFIX}${id}.json`;

const pad = (n: number) => String(n).padStart(2, '0');

/** `ct-backup-<instance>-<yyyyMMdd-HHmm>.ctbak`, the time in UTC. */
export function backupFileName(instance: string, startedAt: Date): string {
  const safe = instance.replace(/[^A-Za-z0-9._-]+/g, '-') || 'ct';
  const d = startedAt;
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `ct-backup-${safe}-${stamp}.ctbak`;
}

const viewOf = ({ fileName: _fileName, ...view }: BackupRecord): BackupView => view;

/**
 * Backups (and, later, restores) as Administration > Backup sees them. One runs at a time in this
 * API process: `busy` is the lock both take. Nothing about a backup is kept in Postgres (a restore
 * replaces it): each backup's record lives at `backups/<id>.json` in the backups bucket beside its
 * file `<id>.ctbak`, and only the newest successful backup is kept.
 */
export class BackupService {
  /** The running operation; null when idle. A restore holds it from its check to its end. */
  private busy:
    { kind: 'backup'; record: BackupRecord } | { kind: 'restore'; run: RestoreRun } | null = null;
  /** Background work in flight (a backup, a check, a restore run); `settled()` waits for it. */
  private readonly work = new Set<Promise<void>>();
  /** Status file writes, one after another, so an older one never lands after a newer one. */
  private restoreWrites: Promise<void> = Promise.resolve();
  private restore: RestoreSetup | null = null;

  constructor(private readonly deps: BackupServiceDeps) {}

  /** Makes restores possible; their deps need the app (its maintenance gate). */
  enableRestore(setup: RestoreSetup): void {
    this.restore = setup;
  }

  async status(): Promise<{
    backup: BackupView | null;
    lastSucceeded: BackupView | null;
    restore: RestoreStatus | null;
    queue: QueueControlView;
  }> {
    const queue = await this.deps.queue.get();
    const running = this.busy?.kind === 'backup' ? this.busy.record : null;
    const stored = await this.records();
    const latest = running ?? stored[0] ?? null;
    const succeeded = stored.find((r) => r.status === 'succeeded') ?? null;
    return {
      backup: latest && viewOf(latest),
      lastSucceeded: succeeded && viewOf(succeeded),
      restore: await this.latestRestore(),
      queue,
    };
  }

  /** Starts a backup in the background; throws `BackupBusyError` while anything runs. */
  startBackup(by: string): BackupView {
    if (this.busy) throw new BackupBusyError();
    const record: BackupRecord = {
      id: randomUUID(),
      status: 'running',
      startedAt: this.deps.now().toISOString(),
      finishedAt: null,
      createdBy: by,
      bytes: null,
      error: null,
      progress: null,
      fileName: null,
    };
    this.busy = { kind: 'backup', record };
    this.track(
      this.runBackup(record).finally(() => {
        this.busy = null;
      }),
    );
    return viewOf(record);
  }

  /**
   * Starts a restore's check of the completed upload at `uploadKey` in the background and takes
   * the lock (`BackupBusyError` while anything runs). Deployment mode opens the file with this
   * server's key, then its previous one; copy mode with the pasted `key` only. The token, returned
   * once, lets whoever started it follow and confirm it after every session has ended.
   */
  startRestore(opts: { uploadKey: string; mode: RestoreMode; key: Buffer | null; by: string }): {
    status: RestoreStatus;
    token: string;
  } {
    const setup = this.restore;
    if (!setup) throw new Error('restores are not set up on this server');
    if (this.busy) throw new BackupBusyError();
    if (opts.mode === 'copy' && !opts.key) throw new Error('a copy needs the key of its backup');
    const masters =
      opts.mode === 'copy'
        ? [opts.key!]
        : [this.deps.master, ...(this.deps.previousMaster ? [this.deps.previousMaster] : [])];
    const token = randomBytes(32).toString('base64url');
    const run: RestoreRun = {
      record: {
        id: randomUUID(),
        mode: opts.mode,
        phase: 'checking',
        step: null,
        done: 0,
        of: 0,
        manifest: null,
        plan: null,
        error: null,
        report: null,
        startedBy: opts.by,
        updatedAt: this.deps.now().toISOString(),
        tokenSha256: sha256(token).toString('hex'),
      },
      uploadKey: opts.uploadKey,
      checked: null,
    };
    this.busy = { kind: 'restore', run };
    this.track(this.runCheck(run, masters, setup));
    return { status: statusOf(run.record), token };
  }

  /**
   * A restore's status for whoever may read it: an admin, or the holder of its token. Null for
   * an unknown restore and for anyone else alike.
   */
  async restoreStatus(
    id: string,
    who: { admin: boolean; token: string | null },
  ): Promise<RestoreStatus | null> {
    const record = await this.restoreRecord(id);
    if (!record) return null;
    if (who.admin) return statusOf(record);
    if (who.token === null || !record.tokenSha256) return null;
    const expected = Buffer.from(record.tokenSha256, 'hex');
    const given = sha256(who.token);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return statusOf(record);
  }

  /**
   * Runs a checked restore in the background once `instanceName` is the backup's instance
   * (`RestoreRefusal` otherwise, or when it is not checked and waiting).
   */
  async confirmRestore(id: string, instanceName: string, by: string): Promise<RestoreStatus> {
    const run = this.waiting(id);
    const checked = run.checked!;
    if (instanceName !== checked.manifest.instanceName) {
      throw new RestoreRefusal(400, `type ${checked.manifest.instanceName} to confirm`);
    }
    run.checked = null;
    const deps: RestoreDeps = { ...this.deps, ...this.restore! };
    const request = {
      id,
      mode: run.record.mode,
      key: checked.master,
      uploadKey: run.uploadKey,
      by,
      manifest: checked.manifest,
      contentTypes: checked.contentTypes,
    };
    await this.updateRestore(run, { phase: 'restoring', step: null, done: 0, of: 0 });
    this.track(
      runRestore(deps, request, (s) => this.updateRestore(run, s))
        .then(
          () => undefined,
          (err: unknown) => this.deps.log?.error({ err }, 'restore failed'),
        )
        .finally(() => this.release(run)),
    );
    return statusOf(run.record);
  }

  /** Cancels a checked restore: nothing was changed, and the lock is let go. */
  async cancelRestore(id: string): Promise<RestoreStatus> {
    const run = this.waiting(id);
    run.checked = null;
    try {
      await this.updateRestore(run, { phase: 'failed', step: null, error: RESTORE_CANCELLED });
    } finally {
      this.release(run);
    }
    return statusOf(run.record);
  }

  /** True while a backup or restore runs (an upload start is refused meanwhile). */
  isBusy(): boolean {
    return this.busy !== null;
  }

  /**
   * On API start: a restore still `restoring` was cut off by the restart. It is saved as failed
   * and maintenance is switched on in the row (the database may be the live one or the restored
   * one, depending on whether the swap happened), so non-admins stay out until an admin looks.
   */
  async recover(): Promise<void> {
    const { store, buckets } = this.deps;
    let interrupted = false;
    for (const status of await readRestoreStatuses(store, buckets.backups)) {
      if (status.phase !== 'restoring') continue;
      interrupted = true;
      await saveRestoreStatus(store, buckets.backups, {
        ...status,
        phase: 'failed',
        error: RESTORE_INTERRUPTED,
        updatedAt: this.deps.now().toISOString(),
      });
    }
    if (interrupted) {
      await this.deps.maintenance.set({ enabled: true, message: RESTORE_MESSAGE }, null);
    }
  }

  /** Resolves once no background work runs (tests wait on it); a checked restore still waits. */
  async settled(): Promise<void> {
    while (this.work.size > 0) await Promise.all([...this.work]);
  }

  private track(p: Promise<void>): void {
    this.work.add(p);
    void p.finally(() => this.work.delete(p));
  }

  private release(run: RestoreRun): void {
    if (this.busy?.kind === 'restore' && this.busy.run === run) this.busy = null;
  }

  /** The restore `id`, holding the lock, checked and waiting for its confirmation. */
  private waiting(id: string): RestoreRun {
    const run = this.busy?.kind === 'restore' ? this.busy.run : null;
    if (!run || run.record.id !== id || run.record.phase !== 'checked' || !run.checked) {
      throw new RestoreRefusal(409, NOT_WAITING);
    }
    return run;
  }

  private async runCheck(run: RestoreRun, masters: Buffer[], setup: RestoreSetup): Promise<void> {
    const { store, buckets } = this.deps;
    let lastWrite = this.deps.now().getTime();
    try {
      await this.updateRestore(run, { step: 'checking' });
      const checked = await checkBackup(
        async () => {
          const found = await store.getStream(buckets.backups, run.uploadKey);
          if (!found) throw new Error('the uploaded backup is gone: upload it again');
          run.record.of = found.size;
          return found.body;
        },
        masters,
        await setup.localMigrations(),
        ({ bytes }) => {
          run.record.done = Math.min(bytes, run.record.of);
          const now = this.deps.now().getTime();
          if (now - lastWrite >= PROGRESS_WRITE_MS) {
            lastWrite = now;
            this.updateRestore(run, {}).catch(() => {});
          }
        },
      );
      run.checked = checked;
      await this.updateRestore(run, {
        phase: 'checked',
        step: null,
        done: run.record.of,
        manifest: checked.manifest,
        plan: run.record.mode === 'copy' ? copyPlan() : null,
      });
    } catch (err) {
      run.checked = null;
      this.deps.log?.error({ err }, 'restore check failed');
      await this.updateRestore(run, {
        phase: 'failed',
        step: null,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
      this.release(run);
    }
  }

  /** Merges `change` into the restore's status and saves it to its file. */
  private updateRestore(run: RestoreRun, change: Partial<RestoreStatus>): Promise<void> {
    Object.assign(run.record, change, { updatedAt: this.deps.now().toISOString() });
    const snapshot = { ...run.record };
    const { store, buckets } = this.deps;
    const write = this.restoreWrites.then(() =>
      store.put(
        buckets.backups,
        restoreStatusKey(snapshot.id),
        Buffer.from(JSON.stringify(snapshot), 'utf8'),
        'application/json',
      ),
    );
    this.restoreWrites = write.catch(() => undefined);
    return write;
  }

  /** The restore in memory, else its status file. */
  private async restoreRecord(id: string): Promise<RestoreRecord | null> {
    if (this.busy?.kind === 'restore' && this.busy.run.record.id === id)
      return this.busy.run.record;
    const raw = await this.deps.store.get(this.deps.buckets.backups, restoreStatusKey(id));
    if (!raw) return null;
    try {
      const parsed = RestoreRecordSchema.safeParse(JSON.parse(raw.toString('utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** The restore holding the lock, else the newest one stored. */
  private async latestRestore(): Promise<RestoreStatus | null> {
    if (this.busy?.kind === 'restore') return statusOf(this.busy.run.record);
    const stored = await readRestoreStatuses(this.deps.store, this.deps.buckets.backups);
    return stored.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }

  /** A finished backup's file, or null when there is none by that id. */
  async download(id: string): Promise<{ body: Readable; size: number; fileName: string } | null> {
    const record = await this.record(id);
    if (!record || record.status !== 'succeeded' || !record.fileName) return null;
    const found = await this.deps.store.getStream(this.deps.buckets.backups, backupFileKey(id));
    if (!found) return null;
    return { body: found.body, size: found.size, fileName: record.fileName };
  }

  async setQueuePaused(paused: boolean, by: string | null): Promise<QueueControlView> {
    return this.deps.queue.set(paused, by);
  }

  private async runBackup(record: BackupRecord): Promise<void> {
    const { deps } = this;
    let writes = Promise.resolve();
    // Writes go one after another, so an older progress write never lands after a newer one.
    const write = (snapshot: BackupRecord) => {
      writes = writes
        .then(() => this.save(snapshot))
        .catch((err: unknown) => deps.log?.error({ err }, 'backup progress could not be saved'));
      return writes;
    };
    let lastWrite = deps.now().getTime();
    await write({ ...record });
    let written = false;
    try {
      const startedAt = new Date(record.startedAt);
      const fileName = backupFileName(await deps.instanceName(), startedAt);
      const result = await createBackup(deps, record.id, record.createdBy, (progress) => {
        record.progress = progress;
        const now = deps.now().getTime();
        if (now - lastWrite >= PROGRESS_WRITE_MS) {
          lastWrite = now;
          void write({ ...record });
        }
      });
      written = true;
      // The success is saved for sure before anything older goes: a lost record would leave
      // a file nobody can download, and the previous backup deleted.
      await writes;
      await this.save({
        ...record,
        status: 'succeeded',
        finishedAt: deps.now().toISOString(),
        bytes: result.bytes,
        fileName,
      });
      Object.assign(record, {
        status: 'succeeded',
        finishedAt: deps.now().toISOString(),
        bytes: result.bytes,
        fileName,
      });
      // The new backup is safe; a failure to tidy the old one leaves an extra file, no more.
      await this.removeOlder(record.id).catch((err: unknown) =>
        deps.log?.error({ err }, 'the previous backup could not be removed'),
      );
    } catch (err) {
      deps.log?.error({ err }, 'backup failed');
      // createBackup removes its own partial file; a finished one without its record goes here.
      if (written) {
        await deps.store
          .delete(deps.buckets.backups, backupFileKey(record.id))
          .catch((e: unknown) => deps.log?.error({ err: e }, 'the failed backup was not removed'));
      }
      Object.assign(record, {
        status: 'failed',
        finishedAt: deps.now().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
      await write({ ...record });
    }
  }

  private async save(record: BackupRecord): Promise<void> {
    await this.deps.store.put(
      this.deps.buckets.backups,
      recordKey(record.id),
      Buffer.from(JSON.stringify(record), 'utf8'),
      'application/json',
    );
  }

  private async record(id: string): Promise<BackupRecord | null> {
    const raw = await this.deps.store.get(this.deps.buckets.backups, recordKey(id));
    return raw ? this.parse(raw) : null;
  }

  private parse(raw: Buffer): BackupRecord | null {
    try {
      const parsed = RecordSchema.safeParse(JSON.parse(raw.toString('utf8')));
      if (!parsed.success) return null;
      const record = parsed.data;
      // Running, but not in this process: the API that ran it stopped.
      const running = this.busy?.kind === 'backup' ? this.busy.record.id : null;
      if (record.status === 'running' && running !== record.id) {
        return { ...record, status: 'failed', error: INTERRUPTED };
      }
      return record;
    } catch {
      return null;
    }
  }

  /** Every stored record, newest first. */
  private async records(): Promise<BackupRecord[]> {
    const out: BackupRecord[] = [];
    for await (const o of this.deps.store.list(this.deps.buckets.backups, RECORD_PREFIX)) {
      const raw = await this.deps.store.get(this.deps.buckets.backups, o.key);
      const record = raw && this.parse(raw);
      if (record) out.push(record);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** After a success: every other backup's file and record go (only the newest is kept). */
  private async removeOlder(keep: string): Promise<void> {
    const { store, buckets } = this.deps;
    for (const record of await this.records()) {
      if (record.id === keep) continue;
      await store.delete(buckets.backups, backupFileKey(record.id));
      await store.delete(buckets.backups, recordKey(record.id));
    }
  }
}
