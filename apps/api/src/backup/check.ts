import { createHash } from 'node:crypto';
import { pipeline, type Readable } from 'node:stream';
import { BackupManifestSchema, type BackupManifest } from '@ih/shared';
import { z } from 'zod';
import { ArchiveError, readArchive, type ArchiveTail } from './archive.js';
import { BackupCorruptError, decryptStream } from './crypto.js';

export { BackupCorruptError, BackupKeyError } from './crypto.js';

/** The backup comes from a CT Studio with migrations this server does not have. */
export class BackupTooNewError extends Error {
  constructor(migration: string) {
    super(
      `this backup was made by a newer CT Studio (migration ${migration}): upgrade this server first`,
    );
    this.name = 'BackupTooNewError';
  }
}

/** What the check learnt that a restore needs: the manifest, the key, and objects' types. */
export interface CheckedBackup {
  manifest: BackupManifest;
  /** The master key that opened the file. */
  master: Buffer;
  /**
   * Content type of each object, by entry name (`objects/<bucket>/<key>`): the index comes after
   * the objects in the file, so a restore writing objects as they arrive needs them from here.
   */
  contentTypes: Map<string, string>;
}

const IndexLineSchema = z.object({
  role: z.string(),
  bucket: z.string(),
  key: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  contentType: z.string().optional(),
});

const OBJECT_PREFIX = 'objects/';
const INDEX = 'objects/index.jsonl';

export type CheckProgress = { entries: number; bytes: number };

/**
 * Decrypts the whole file and checks it end to end before a restore touches anything: every tag
 * verifies, the archive is complete with nothing after it, every part matches the manifest's
 * hash and size, every object matches the index, and the manifest's migrations are all known
 * here. Bodies are only hashed, never kept. `master` is the key that opened the file.
 */
export async function checkBackup(
  input: () => Promise<Readable>,
  masters: Buffer[],
  localMigrations: string[],
  onProgress: (p: CheckProgress) => void,
): Promise<CheckedBackup> {
  const source = await input();
  const decrypt = decryptStream(masters);
  pipeline(source, decrypt, () => {});

  const it = decrypt[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const tail: ArchiveTail = { rest: Buffer.alloc(0) };

  const hashes = new Map<string, { size: number; sha256: string }>();
  const index = new Map<string, IndexEntry>();
  let manifestBytes: Buffer | null = null;
  let bytes = 0;
  let count = 0;

  try {
    for await (const entry of readArchive({ [Symbol.asyncIterator]: () => it }, tail)) {
      if (manifestBytes) throw new BackupCorruptError('the backup has entries after its manifest');
      if (hashes.has(entry.name)) {
        throw new BackupCorruptError(`the backup has ${entry.name} twice`);
      }

      const hash = createHash('sha256');
      const isManifest = entry.name === 'manifest.json';
      const kept: Buffer[] = [];
      let size = 0;
      let tail = '';
      for await (const piece of entry.body) {
        const chunk = piece as Buffer;
        hash.update(chunk);
        size += chunk.length;
        bytes += chunk.length;
        if (isManifest) kept.push(chunk);
        if (entry.name === INDEX) {
          const lines = (tail + chunk.toString('utf8')).split('\n');
          tail = lines.pop() ?? '';
          for (const line of lines) addIndexLine(index, line);
        }
        onProgress({ entries: count, bytes });
      }
      if (entry.name === INDEX) {
        if (tail !== '') throw new BackupCorruptError('the object index does not end in a newline');
      }
      count += 1;
      if (isManifest) manifestBytes = Buffer.concat(kept);
      else hashes.set(entry.name, { size, sha256: hash.digest('hex') });
      onProgress({ entries: count, bytes });
    }

    // Nothing may follow the terminator; reading to the end also checks the final chunk's tag.
    let extra = tail.rest.length;
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      extra += r.value.length;
    }
    if (extra > 0) throw new BackupCorruptError('the backup has data after its archive ends');
  } catch (err) {
    decrypt.destroy();
    if (err instanceof ArchiveError) throw new BackupCorruptError(err.message);
    throw err;
  }

  if (!manifestBytes) throw new BackupCorruptError('the backup has no manifest');
  let manifest: BackupManifest;
  try {
    manifest = BackupManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  } catch {
    throw new BackupCorruptError('the backup manifest is damaged');
  }

  const listed = new Set<string>();
  for (const part of manifest.parts) {
    listed.add(part.name);
    const found = hashes.get(part.name);
    if (!found) throw new BackupCorruptError(`the backup is missing ${part.name}`);
    if (found.size !== part.bytes || found.sha256 !== part.sha256) {
      throw new BackupCorruptError(`${part.name} does not match its recorded hash`);
    }
  }
  const buckets = new Set(manifest.buckets.map((b) => b.name));
  for (const [name, found] of hashes) {
    if (!name.startsWith(OBJECT_PREFIX) || name === INDEX) {
      if (!listed.has(name))
        throw new BackupCorruptError(`the backup has an unknown entry ${name}`);
      continue;
    }
    // A restore writes each object into its bucket's place on this server: there must be one.
    const rest = name.slice(OBJECT_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash < 1 || !buckets.has(rest.slice(0, slash))) {
      throw new BackupCorruptError(`${name} is in no bucket of the manifest`);
    }
    const expected = index.get(name);
    if (!expected) throw new BackupCorruptError(`${name} is not in the object index`);
    if (expected.size !== found.size || expected.sha256 !== found.sha256) {
      throw new BackupCorruptError(`${name} does not match its recorded hash`);
    }
  }
  for (const name of index.keys()) {
    if (!hashes.has(name)) throw new BackupCorruptError(`the backup is missing ${name}`);
  }

  const local = new Set(localMigrations);
  const unknown = manifest.migrations.find((m) => !local.has(m));
  if (unknown) throw new BackupTooNewError(unknown);

  const master = decrypt.openedWith();
  if (!master) throw new BackupCorruptError('the backup has no content');
  const contentTypes = new Map<string, string>();
  for (const [name, entry] of index) {
    if (entry.contentType) contentTypes.set(name, entry.contentType);
  }
  return { manifest, master, contentTypes };
}

type IndexEntry = { size: number; sha256: string; contentType?: string | undefined };

function addIndexLine(index: Map<string, IndexEntry>, line: string): void {
  if (line === '') return;
  let parsed: z.infer<typeof IndexLineSchema>;
  try {
    parsed = IndexLineSchema.parse(JSON.parse(line));
  } catch {
    throw new BackupCorruptError('the object index is damaged');
  }
  const name = `${OBJECT_PREFIX}${parsed.bucket}/${parsed.key}`;
  if (index.has(name)) throw new BackupCorruptError(`the object index lists ${name} twice`);
  index.set(name, {
    size: parsed.size,
    sha256: parsed.sha256,
    contentType: parsed.contentType,
  });
}
