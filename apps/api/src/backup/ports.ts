import type { Readable } from 'node:stream';
import type { ObjectStore } from '../storage/object-store.js';
import type { CopyResult, KeptState } from './copy-rules.js';

/**
 * What a backup and a restore need from the stack, as ports: the real adapters are `pg-tools.ts`
 * (pg_dump/pg_restore), `fuseki.ts` (Graph Store Protocol) and `seaweed-iam-file.ts`; tests use
 * the fakes in `test/backup-fakes.ts`.
 */

export interface DatabaseTools {
  /** A consistent snapshot of the live database in pg_dump's custom format. `done` settles when
   * the dump has exited (rejects with its error output on failure). */
  dump(): Promise<{ body: Readable; done: Promise<void> }>;
  /** `schema_migrations.filename` of the live database, sorted. */
  migrations(): Promise<string[]>;
  /** Whether a database of that name exists on the server. */
  databaseExists(name: string): Promise<boolean>;
  /** Creates an empty database next to the live one; returns its connection URL. */
  createSideDatabase(name: string): Promise<string>;
  /** Loads a dump into the database at `url`. */
  restore(url: string, body: Readable): Promise<void>;
  /** Renames the live database to `keepAs` and `side` to the live name. */
  swap(side: string, keepAs: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
}

export interface TripleStoreDump {
  /** False when no triple store is configured. */
  available(): Promise<boolean>;
  /** The whole dataset as N-Quads. */
  dump(): Promise<Readable>;
  /** Replaces the whole dataset with these N-Quads. */
  replace(body: Readable): Promise<void>;
  /** Removes one named graph (absent already is success). */
  deleteGraph(iri: string): Promise<void>;
}

export interface LakeIdentities {
  /** The `lake-*` identities, as SeaweedFS stores them. */
  read(): Promise<unknown[]>;
  /** Replaces the `lake-*` identities, keeping every other identity. */
  replace(entries: unknown[]): Promise<void>;
}

export interface BackupBuckets {
  inbox: string;
  outputs: string;
  runs: string;
  /** Where backups and uploads live; never itself backed up. */
  backups: string;
}

export interface BackupDeps {
  db: DatabaseTools;
  store: ObjectStore;
  buckets: BackupBuckets;
  /** Distinct buckets of internal, non-inert publishing targets, excluding CT Studio's own. */
  internalTargetBuckets(): Promise<string[]>;
  triples: TripleStoreDump;
  lake: LakeIdentities;
  /** `LLM_SECRETS_KEY`, from which the file's key is derived. */
  master: Buffer;
  version: { appVersion: string; commit: string | null };
  instanceName(): Promise<string>;
  baseIri(): Promise<string>;
  now(): Date;
}

/**
 * What a restore does in the live database, the one it is about to replace: stop the queue and
 * the jobs running, and read what a copy keeps from this server. `restore-pg.ts` is the adapter.
 */
export interface LiveDatabase {
  /** Pauses the job queue (`queue_control`): no worker claims a job until an admin resumes it. */
  pauseQueue(by: string, reason: string): Promise<void>;
  /** How many jobs are running. */
  runningJobs(): Promise<number>;
  /** Cancels every running job with that reason; returns how many. */
  cancelRunning(reason: string): Promise<number>;
  readKeptState(): Promise<KeptState>;
}

/**
 * A `rebuild` job's mode (the worker's `RebuildParams`): `rebuild` reloads the triple store from
 * the published copies, `remint` re-renders the graphs under this server's base, and
 * `rebuild-remint` does both in one job (a copy from a backup without triples).
 */
export type RebuildMode = 'rebuild' | 'remint' | 'rebuild-remint';

/** An object a row of the restored database names. */
export interface ObjectRef {
  bucket: string;
  key: string;
}

/** What a restore does in the side database, the restored backup, before it is swapped in. */
export interface SideDatabase {
  /** The copy rules (restore as a copy), in their own transaction. */
  applyCopyRules(kept: KeptState): Promise<CopyResult>;
  /**
   * Every restore: ends every session, pauses the queue, turns maintenance on with `message`,
   * and renames the buckets rows record (`documents`, `job_outputs`) from the backup's own
   * buckets to this server's (`from` → `to`).
   */
  prepare(opts: {
    message: string;
    by: string;
    buckets: { from: string; to: string }[];
  }): Promise<void>;
  /** Every document's file and every published, live output of an internal target. */
  referencedObjects(): Promise<ObjectRef[]>;
  /** The data-lake consumers' access keys not revoked (label, IAM user, key id). */
  lakeAccessKeys(): Promise<{ consumer: string; userName: string; accessKeyId: string }[]>;
  /** Queues a `rebuild` job (it runs once the queue is resumed). */
  queueRebuild(mode: RebuildMode, by: string): Promise<void>;
  /** The `embedding_model` pipeline setting, if any. */
  embeddingModel(): Promise<string | null>;
  /** Row counts of the main tables, for the report. */
  tableCounts(): Promise<{ table: string; rows: number }[]>;
  close(): Promise<void>;
}
