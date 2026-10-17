import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  BackupViewSchema,
  type BackupView,
  type QueueControlView,
  type RestoreStatus,
} from '@ih/shared';
import { z } from 'zod';
import type { MaintenanceRepo } from '../maintenance/repo.js';
import { backupFileKey, createBackup } from './create.js';
import type { BackupDeps } from './ports.js';
import type { QueueControlRepo } from './queue-control.js';
import {
  readRestoreStatuses,
  RESTORE_INTERRUPTED,
  RESTORE_MESSAGE,
  saveRestoreStatus,
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

export interface BackupServiceDeps extends BackupDeps {
  queue: QueueControlRepo;
  /** The maintenance row, set on when an interrupted restore is found at start. */
  maintenance: Pick<MaintenanceRepo, 'set'>;
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
  /** The running operation; null when idle. */
  private busy: { kind: 'backup'; record: BackupRecord; done: Promise<void> } | null = null;

  constructor(private readonly deps: BackupServiceDeps) {}

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
      restore: null,
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
    const busy = { kind: 'backup' as const, record, done: Promise.resolve() };
    this.busy = busy;
    busy.done = this.runBackup(record).finally(() => {
      this.busy = null;
    });
    return viewOf(record);
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

  /** Resolves once nothing runs (tests wait on it). */
  async settled(): Promise<void> {
    while (this.busy) await this.busy.done;
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
      if (record.status === 'running' && this.busy?.record.id !== record.id) {
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
