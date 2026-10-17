import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline as pipeStreams, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  RestoreReportSchema,
  RestoreStatusSchema,
  type BackupManifest,
  type MaintenanceView,
  type RestoreMode,
  type RestoreReport,
  type RestoreStatus,
} from '@ih/shared';
import type { MaintenanceGate } from '../maintenance/repo.js';
import type { S3KeyIssuer } from '../s3keys/issuer.js';
import type { ObjectStore } from '../storage/object-store.js';
import { ArchiveError, readArchive, type ArchiveTail } from './archive.js';
import { BackupCorruptError, decryptStream } from './crypto.js';
import { checkDatabaseName } from './pg-tools.js';
import type { BackupDeps, LiveDatabase, SideDatabase } from './ports.js';

/**
 * A restore run (Administration > Backup > Restore…, after the check): the backup goes into a
 * side database next to the live one, which is migrated and adjusted (the copy rules, sessions,
 * maintenance, the paused queue); objects, identities and triples are replaced; only then is the
 * live database swapped for the side one, so a failure before the swap leaves it untouched.
 * Spec: docs/superpowers/specs/2026-10-17-backup-and-restore-design.md, "Restoring".
 */

/** The maintenance message while restoring, and in the restored database's row. */
export const RESTORE_MESSAGE = 'CT Studio is being restored from a backup.';
/** A restore left `restoring` by an API that stopped is saved as failed with this reason. */
export const RESTORE_INTERRUPTED = 'the API restarted during the restore';
/** Added to a failure's reason once anything outside the database was replaced. */
export const PARTLY_REPLACED = 'objects were partly replaced: restore again';
/** Why the running jobs were cancelled, and why the live queue is paused. */
const RESTORING = 'restoring a backup';
/** How long running jobs get to finish before they are cancelled. */
const JOB_WAIT_MS = 120_000;
const JOB_POLL_MS = 1000;

const STATUS_PREFIX = 'restores/';
export const restoreStatusKey = (id: string): string => `${STATUS_PREFIX}${id}.json`;

export async function saveRestoreStatus(
  store: ObjectStore,
  bucket: string,
  status: RestoreStatus,
): Promise<void> {
  await store.put(
    bucket,
    restoreStatusKey(status.id),
    Buffer.from(JSON.stringify(status), 'utf8'),
    'application/json',
  );
}

/** Every stored restore status (unreadable ones are left out). */
export async function readRestoreStatuses(
  store: ObjectStore,
  bucket: string,
): Promise<RestoreStatus[]> {
  const out: RestoreStatus[] = [];
  for await (const o of store.list(bucket, STATUS_PREFIX)) {
    const raw = await store.get(bucket, o.key);
    if (!raw) continue;
    try {
      const parsed = RestoreStatusSchema.safeParse(JSON.parse(raw.toString('utf8')));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // A damaged status file is not a restore anyone can follow.
    }
  }
  return out;
}

export interface RestoreDeps extends BackupDeps {
  /** The access hook's gate: forced on for the whole restore. */
  gate: Pick<MaintenanceGate, 'force' | 'release' | 'set' | 'current'>;
  /** The migrations this server has (`db/migrations`). */
  localMigrations(): Promise<string[]>;
  /** Runs this server's migrations on the database at `url`. */
  migrate(url: string): Promise<void>;
  /** A new password for the admin from the log, printed as on every start. */
  rotateAdminToken(): Promise<void>;
  /** Queues `embed` jobs for that model (on the live database, after the swap). */
  createEmbedJobs(model: string): Promise<number>;
  /** The live database's name (`DATABASE_URL`). */
  liveDatabaseName: string;
  live: LiveDatabase;
  /** Connects to the side database (the URL carries the password: never log or store it). */
  openSide(url: string): Promise<SideDatabase>;
  /** This server's data-lake IAM, to tell which restored keys it lacks; null without one. */
  lakeIssuer: Pick<S3KeyIssuer, 'listUsers'> | null;
  /** How long running jobs get to finish (tests: 0). */
  jobWaitMs?: number;
}

export interface RestoreRequest {
  id: string;
  mode: RestoreMode;
  /** The master key that opened the file in the check. */
  key: Buffer;
  /** The uploaded file in the backups bucket. */
  uploadKey: string;
  by: string;
  /** From the check: the manifest comes last in the file, the index after the objects. */
  manifest: BackupManifest;
  contentTypes: Map<string, string>;
}

type Step =
  | 'maintenance'
  | 'database'
  | 'migrations'
  | 'adjusting'
  | 'objects'
  | 'identities'
  | 'triples'
  | 'swap'
  | 'finishing';
const STEPS = 9;

const pad = (n: number) => String(n).padStart(2, '0');
/**
 * `yyyyMMddHHmmss_xxxx` in UTC with four random hex digits, so two restores in one second still
 * name databases of their own (`<live>_before_restore_` + this stays within Postgres's 63).
 */
const stampOf = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}_${randomBytes(2).toString('hex')}`;

const OBJECT_PREFIX = 'objects/';
const INDEX = 'objects/index.jsonl';
const IDENTITIES = 'iam/lake-identities.json';
const TRIPLES = 'fuseki.nq';
const DUMP = 'postgres.dump';

/** Where each of the backup's buckets goes on this server: own buckets by role, targets by name. */
interface BucketPlan {
  /** Backup bucket name → this server's bucket name. */
  to: Map<string, string>;
  /** This server's buckets the restore replaces. */
  restored: string[];
}

function bucketPlan(deps: RestoreDeps, manifest: BackupManifest): BucketPlan {
  const own = {
    inbox: deps.buckets.inbox,
    outputs: deps.buckets.outputs,
    runs: deps.buckets.runs,
    backups: deps.buckets.backups,
  };
  const to = new Map<string, string>();
  for (const b of manifest.buckets) {
    if (b.role === 'target') {
      const clash = Object.entries(own).find(([, name]) => name === b.name);
      if (clash) {
        throw new Error(
          `the backup's publishing target bucket ${b.name} is this server's own ${clash[0]} bucket: rename one of them first`,
        );
      }
      to.set(b.name, b.name);
    } else {
      to.set(b.name, own[b.role]);
    }
  }
  return { to, restored: [...new Set(to.values())] };
}

const drain = (body: Readable) =>
  new Promise<void>((resolve, reject) => {
    body.once('error', reject);
    body.once('end', resolve);
    body.resume();
  });

interface Applied {
  /** Keys written, per this server's bucket. */
  written: Map<string, Set<string>>;
  objects: number;
  identities: unknown[];
  /** The N-Quads, spooled to a file; null when the backup has none. */
  nquads: string | null;
}

/**
 * The second pass over the file (the check verified it): the dump into the side database,
 * objects into their buckets as they come, identities kept, the triples spooled to `dir`.
 * Reads to the end so the final chunk's tag is checked again.
 */
async function applyArchive(
  deps: RestoreDeps,
  r: RestoreRequest,
  plan: BucketPlan,
  sideUrl: string,
  dir: string,
  onReplace: () => void,
): Promise<Applied> {
  const found = await deps.store.getStream(deps.buckets.backups, r.uploadKey);
  if (!found) throw new Error('the uploaded backup is gone: upload it again');
  const decrypt = decryptStream([r.key]);
  pipeStreams(found.body, decrypt, () => {});
  const it = decrypt[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const tail: ArchiveTail = { rest: Buffer.alloc(0) };

  const written = new Map(plan.restored.map((b) => [b, new Set<string>()]));
  const applied: Applied = { written, objects: 0, identities: [], nquads: null };
  try {
    for await (const entry of readArchive({ [Symbol.asyncIterator]: () => it }, tail)) {
      if (entry.name === DUMP) {
        await deps.db.restore(sideUrl, entry.body);
      } else if (entry.name.startsWith(OBJECT_PREFIX) && entry.name !== INDEX) {
        const rest = entry.name.slice(OBJECT_PREFIX.length);
        const slash = rest.indexOf('/');
        const bucket = plan.to.get(rest.slice(0, slash));
        if (slash < 1 || !bucket) {
          throw new BackupCorruptError(`${entry.name} is in no bucket of the manifest`);
        }
        const key = rest.slice(slash + 1);
        onReplace();
        await deps.store.putStream(
          bucket,
          key,
          entry.body,
          r.contentTypes.get(entry.name) ?? 'application/octet-stream',
        );
        written.get(bucket)!.add(key);
        applied.objects += 1;
      } else if (entry.name === IDENTITIES) {
        const chunks: Buffer[] = [];
        for await (const c of entry.body) chunks.push(c as Buffer);
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        applied.identities = Array.isArray(parsed) ? parsed : [];
      } else if (entry.name === TRIPLES) {
        const path = join(dir, TRIPLES);
        await pipeline(entry.body, createWriteStream(path));
        applied.nquads = path;
      } else {
        await drain(entry.body);
      }
    }
    for (;;) {
      const next = await it.next();
      if (next.done) break;
    }
  } catch (err) {
    decrypt.destroy();
    if (err instanceof ArchiveError) throw new BackupCorruptError(err.message);
    throw err;
  }
  return applied;
}

/** Deletes what each restored bucket holds that the backup did not write. */
async function removeStale(store: ObjectStore, written: Map<string, Set<string>>): Promise<void> {
  for (const [bucket, keys] of written) {
    const stale: string[] = [];
    for await (const o of store.list(bucket)) if (!keys.has(o.key)) stale.push(o.key);
    for (const key of stale) await store.delete(bucket, key);
  }
}

/** Consumers whose live keys this server's IAM does not hold (all of them without an IAM). */
async function lakeKeysMissing(deps: RestoreDeps, side: SideDatabase): Promise<string[]> {
  const keys = await side.lakeAccessKeys();
  if (keys.length === 0) return [];
  const users = deps.lakeIssuer ? await deps.lakeIssuer.listUsers('lake-').catch(() => []) : [];
  const held = new Map(users.map((u) => [u.userName, new Set(u.accessKeyIds)]));
  const missing = keys.filter((k) => !held.get(k.userName)?.has(k.accessKeyId));
  return [...new Set(missing.map((k) => k.consumer))].sort();
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Restores a checked backup (`r`), reporting each step through `status` (which the caller
 * persists outside Postgres). Returns the report; on failure reports `failed` and throws.
 */
export async function runRestore(
  deps: RestoreDeps,
  r: RestoreRequest,
  status: (s: Partial<RestoreStatus>) => Promise<void>,
): Promise<RestoreReport> {
  let done = 0;
  const step = async (name: Step) => {
    await status({ phase: 'restoring', step: name, done, of: STEPS });
    done += 1;
  };
  const failed = async (error: string) => {
    await status({ phase: 'failed', error }).catch(() => {});
  };
  /**
   * After a failure the maintenance row keeps everyone but admins out (after a restart too), and
   * the gate goes back to following it, so an admin can switch maintenance off on its tab. If
   * the row cannot be written, the gate stays forced: better locked out than half-restored.
   */
  const holdByRow = async () => {
    try {
      await deps.gate.set({ enabled: true, message: RESTORE_MESSAGE }, r.by);
      deps.gate.release();
    } catch {
      // Stays forced until the API restarts (recover() then sets the row).
    }
  };

  const stamp = stampOf(deps.now());
  const sideName = `${deps.liveDatabaseName}_restore_${stamp}`;
  const keepAs = `${deps.liveDatabaseName}_before_restore_${stamp}`;

  // Everything that can refuse without changing anything, before step 1 changes something.
  let plan: BucketPlan;
  try {
    plan = bucketPlan(deps, r.manifest);
    const local = new Set(await deps.localMigrations());
    const unknown = r.manifest.migrations.find((m) => !local.has(m));
    if (unknown)
      throw new Error(`this backup needs migration ${unknown}: upgrade this server first`);
    for (const name of [sideName, keepAs]) {
      checkDatabaseName(name);
      if (await deps.db.databaseExists(name)) {
        throw new Error(`a database named ${name} already exists: restore again`);
      }
    }
  } catch (err) {
    await failed(messageOf(err));
    throw err;
  }
  let sideCreated = false;
  let side: SideDatabase | null = null;
  let replaced = false;
  let swapped = false;
  const dir = await mkdtemp(join(tmpdir(), 'ct-restore-'));

  let report: Omit<RestoreReport, 'adminTokenRotated' | 'previousDatabase'>;
  let embedding: string | null = null;
  try {
    // 1. Nobody but admins from here on; no job is claimed, none still runs.
    const now = deps.now().toISOString();
    const forced: MaintenanceView = {
      enabled: true,
      message: RESTORE_MESSAGE,
      since: now,
      updatedBy: r.by,
      updatedAt: now,
    };
    deps.gate.force(forced);
    await step('maintenance');
    await deps.live.pauseQueue(r.by, RESTORING);
    const waitUntil = Date.now() + (deps.jobWaitMs ?? JOB_WAIT_MS);
    while ((await deps.live.runningJobs()) > 0 && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
    }
    if ((await deps.live.runningJobs()) > 0) await deps.live.cancelRunning(RESTORING);

    // 2. The database into the side one; objects, identities and triples as they come.
    await step('database');
    for (const bucket of plan.restored) await deps.store.ensureBucket(bucket);
    const sideUrl = await deps.db.createSideDatabase(sideName);
    sideCreated = true;
    const applied = await applyArchive(deps, r, plan, sideUrl, dir, () => {
      replaced = true;
    });

    // 3. A backup from older code is brought forward.
    await step('migrations');
    await deps.migrate(sideUrl);

    // 4. Copy rules (kept rows read from the live database), then what every restore sets.
    await step('adjusting');
    side = await deps.openSide(sideUrl);
    let copy: RestoreReport['copy'] = null;
    let droppedGraphs: string[] = [];
    if (r.mode === 'copy') {
      const result = await side.applyCopyRules(await deps.live.readKeptState());
      droppedGraphs = result.droppedGraphs;
      copy = RestoreReportSchema.shape.copy.parse(result);
    }
    await side.prepare({
      message: RESTORE_MESSAGE,
      by: r.by,
      buckets: [...plan.to].filter(([from, to]) => from !== to).map(([from, to]) => ({ from, to })),
    });

    // 5. The buckets equal the backup's; rows naming a file it lacked are reported.
    await step('objects');
    await removeStale(deps.store, applied.written);
    const missingObjects = (await side.referencedObjects())
      .filter((o) => !applied.written.get(o.bucket)?.has(o.key))
      .sort((a, b) => a.bucket.localeCompare(b.bucket) || a.key.localeCompare(b.key));

    // 6. Data-lake identities: a copy keeps this server's.
    await step('identities');
    let lakeKeysToReissue: string[] = [];
    if (r.mode === 'deployment') {
      await deps.lake.replace(applied.identities);
      lakeKeysToReissue = await lakeKeysMissing(deps, side);
    }

    // 7. The triple store, or a rebuild queued for when the worker resumes.
    await step('triples');
    let triples: RestoreReport['triples'];
    if (!(await deps.triples.available())) {
      triples = 'no-triple-store';
    } else if (r.manifest.fuseki && applied.nquads) {
      replaced = true;
      await deps.triples.replace(createReadStream(applied.nquads));
      if (r.mode === 'copy') {
        for (const iri of droppedGraphs) await deps.triples.deleteGraph(iri);
        await side.queueRebuild('remint', r.by);
        triples = 'reminting';
      } else {
        triples = 'restored';
      }
    } else {
      await side.queueRebuild('rebuild', r.by);
      triples = 'none-in-backup';
    }

    report = {
      restored: await side.tableCounts(),
      objects: applied.objects,
      missingObjects,
      copy,
      triples,
      lakeKeysToReissue,
    };
    if (r.mode === 'copy') embedding = await side.embeddingModel();
    await side.close();
    side = null;

    // 8. The swap: from here on the restored database is the live one.
    await step('swap');
    await deps.db.swap(sideName, keepAs);
    swapped = true;
  } catch (err) {
    await side?.close().catch(() => {});
    if (sideCreated && !swapped) await deps.db.dropDatabase(sideName).catch(() => {});
    await holdByRow();
    const message = messageOf(err);
    await failed(replaced ? `${message} (${PARTLY_REPLACED})` : message);
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 9. Everyone signs in again; the restored row keeps maintenance on until an admin ends it.
  let rotated = false;
  const finalReport = () =>
    RestoreReportSchema.parse({ ...report, previousDatabase: keepAs, adminTokenRotated: rotated });
  try {
    await step('finishing');
    await deps.rotateAdminToken();
    rotated = true;
    if (embedding) await deps.createEmbedJobs(embedding);
    deps.gate.release();
  } catch (err) {
    await holdByRow();
    await status({
      phase: 'failed',
      error: `the database WAS restored (the previous one is kept as ${keepAs}), but ${messageOf(err)}`,
      report: finalReport(),
    }).catch(() => {});
    throw err;
  }
  const final = finalReport();
  await status({ phase: 'succeeded', step: null, done: STEPS, of: STEPS, report: final });
  return final;
}
