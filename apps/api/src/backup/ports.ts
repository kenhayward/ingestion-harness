import type { Readable } from 'node:stream';
import type { ObjectStore } from '../storage/object-store.js';

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
