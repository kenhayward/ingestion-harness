import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BACKUP_FORMAT_VERSION,
  BackupManifestSchema,
  type BackupManifest,
  type BackupView,
  type BucketRole,
} from '@ih/shared';
import type { PublishTargetRepo } from '../publish-targets/repo.js';
import type { ListedObject } from '../storage/object-store.js';
import { ArchiveWriter } from './archive.js';
import { encryptStream } from './crypto.js';
import type { BackupDeps } from './ports.js';

type Progress = NonNullable<BackupView['progress']>;
type Part = BackupManifest['parts'][number];

/** The backup's object key in the backups bucket. */
export const backupFileKey = (id: string): string => `${id}.ctbak`;

/**
 * Buckets of the internal publishing targets (inert ones are not listed by the repo), each once,
 * leaving out CT Studio's own buckets.
 */
export async function internalTargetBuckets(
  targets: Pick<PublishTargetRepo, 'list'>,
  own: string[],
  /** More buckets of this deployment's storage to keep (the bridge's package staging bucket). */
  extra: string[] = [],
): Promise<string[]> {
  const out: string[] = [];
  const internal = (await targets.list()).filter((t) => t.kind === 'internal').map((t) => t.bucket);
  for (const bucket of [...internal, ...extra]) {
    if (!own.includes(bucket) && !out.includes(bucket)) out.push(bucket);
  }
  return out;
}

/** Writes a stream to a file in `dir`, so its size is known before it goes into the archive. */
async function spool(
  dir: string,
  name: string,
  body: Readable,
): Promise<{ path: string; size: number }> {
  const path = join(dir, name);
  await pipeline(body, createWriteStream(path));
  return { path, size: (await stat(path)).size };
}

/**
 * A file written line by line whose error (a full disk) fails the next write or the end, never
 * the process: the listener is there from the start, and a wait for `drain` ends on an error.
 */
function lineFile(path: string) {
  const out = createWriteStream(path);
  let error: Error | null = null;
  const failed = new Promise<never>((_resolve, reject) => {
    out.on('error', (err) => {
      error ??= err;
      reject(err);
    });
  });
  failed.catch(() => {});
  return {
    async write(line: string): Promise<void> {
      if (error) throw error;
      if (!out.write(line)) {
        await Promise.race([new Promise<void>((resolve) => out.once('drain', resolve)), failed]);
      }
    },
    async end(): Promise<void> {
      if (error) throw error;
      await Promise.race([new Promise<void>((resolve) => out.end(resolve)), failed]);
    },
    destroy(): void {
      out.destroy();
    },
  };
}

/**
 * Streams the whole stack into `backups/<id>.ctbak`: the database dump, every object of CT
 * Studio's buckets and of internal targets' buckets with an index, the `lake-*` identities, the
 * triple store when there is one, and the manifest last. Nothing is held whole in memory except
 * object listings; dumps of unknown length are spooled to a temporary directory first.
 */
export async function createBackup(
  deps: BackupDeps,
  id: string,
  by: string,
  onProgress: (p: BackupView['progress']) => void,
): Promise<{ key: string; bytes: number; manifest: BackupManifest }> {
  const startedAt = deps.now();
  const key = backupFileKey(id);
  const { buckets, store } = deps;
  // Made before the upload starts, so a failure here leaves no upload waiting.
  const dir = await mkdtemp(join(tmpdir(), 'ct-backup-'));

  const encrypt = encryptStream(deps.master);
  let bytes = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  encrypt.on('error', (err) => counted.destroy(err));
  encrypt.pipe(counted);
  const upload = store.putStream(buckets.backups, key, counted, 'application/octet-stream');
  // A failed upload stops the writer (its pending writes then fail instead of waiting).
  upload.catch((err: unknown) => encrypt.destroy(err as Error));

  const report = (phase: Progress['phase'], done: number, of: number) =>
    onProgress({ phase, done, of, bytes });

  const writer = new ArchiveWriter(encrypt);
  const parts: Part[] = [];
  const part = async (name: string, body: Readable | Buffer, size: number) => {
    const { sha256 } = await writer.entry(name, body, size);
    parts.push({ name, bytes: size, sha256 });
  };

  let index: ReturnType<typeof lineFile> | null = null;
  try {
    const migrations = await deps.db.migrations();
    const lastMigration = migrations.at(-1);
    if (!lastMigration) throw new Error('the database has no migrations applied');

    // 1. The database.
    report('database', 0, 1);
    const dump = await deps.db.dump();
    // Both settle before going on, so a failed dump leaves no write into `dir` running.
    const [spooled, exited] = await Promise.allSettled([
      spool(dir, 'postgres.dump', dump.body),
      dump.done,
    ]);
    if (exited.status === 'rejected') throw exited.reason;
    if (spooled.status === 'rejected') throw spooled.reason;
    await part('postgres.dump', createReadStream(spooled.value.path), spooled.value.size);
    report('database', 1, 1);

    // 2. Objects, bucket by bucket, then their index.
    const own: { role: BucketRole; name: string }[] = [
      { role: 'inbox', name: buckets.inbox },
      { role: 'outputs', name: buckets.outputs },
      { role: 'runs', name: buckets.runs },
    ];
    const ownNames = [...own.map((b) => b.name), buckets.backups];
    const targetBuckets = (await deps.internalTargetBuckets()).filter(
      (b, i, all) => !ownNames.includes(b) && all.indexOf(b) === i,
    );
    const sources = [...own, ...targetBuckets.map((name) => ({ role: 'target' as const, name }))];
    const listed: ListedObject[][] = [];
    for (const source of sources) {
      const keys: ListedObject[] = [];
      for await (const o of store.list(source.name)) keys.push(o);
      listed.push(keys);
    }
    const total = listed.reduce((n, keys) => n + keys.length, 0);
    const indexPath = join(dir, 'index.jsonl');
    index = lineFile(indexPath);
    const manifestBuckets: BackupManifest['buckets'] = [];
    let done = 0;
    report('objects', 0, total);
    for (const [i, source] of sources.entries()) {
      let objects = 0;
      let bucketBytes = 0;
      for (const listing of listed[i]!) {
        const found = await store.getStream(source.name, listing.key);
        if (found) {
          const { sha256 } = await writer.entry(
            `objects/${source.name}/${listing.key}`,
            found.body,
            found.size,
          );
          const line = {
            role: source.role,
            bucket: source.name,
            key: listing.key,
            size: found.size,
            sha256,
            contentType: found.contentType,
          };
          await index.write(`${JSON.stringify(line)}\n`);
          objects += 1;
          bucketBytes += found.size;
        }
        done += 1;
        report('objects', done, total);
      }
      manifestBuckets.push({ role: source.role, name: source.name, objects, bytes: bucketBytes });
    }
    await index.end();
    const indexSize = (await stat(indexPath)).size;
    await part('objects/index.jsonl', createReadStream(indexPath), indexSize);

    // 3. The data lake's identities (their secrets live only in SeaweedFS).
    report('identities', 0, 1);
    const identities = await deps.lake.read();
    const identitiesJson = Buffer.from(JSON.stringify(identities), 'utf8');
    await part('iam/lake-identities.json', identitiesJson, identitiesJson.length);
    report('identities', 1, 1);

    // 4. The triple store, when there is one.
    const fuseki = await deps.triples.available();
    if (fuseki) {
      report('triples', 0, 1);
      const nq = await spool(dir, 'fuseki.nq', await deps.triples.dump());
      await part('fuseki.nq', createReadStream(nq.path), nq.size);
      report('triples', 1, 1);
    }

    // 5. The manifest, last.
    report('finishing', 0, 1);
    const manifest = BackupManifestSchema.parse({
      format: 'ct-backup',
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: deps.version.appVersion,
      commit: deps.version.commit,
      lastMigration,
      migrations,
      instanceName: await deps.instanceName(),
      baseIri: await deps.baseIri(),
      startedAt: startedAt.toISOString(),
      finishedAt: deps.now().toISOString(),
      createdBy: by,
      buckets: manifestBuckets,
      parts,
      fuseki,
      lakeIdentities: identities.length,
    } satisfies BackupManifest);
    const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');
    await writer.entry('manifest.json', manifestJson, manifestJson.length);
    await writer.end();
    encrypt.end();
    await upload;
    report('finishing', 1, 1);
    return { key, bytes, manifest };
  } catch (err) {
    index?.destroy();
    encrypt.destroy(err as Error);
    await upload.catch(() => {});
    await store.delete(buckets.backups, key).catch(() => {});
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
