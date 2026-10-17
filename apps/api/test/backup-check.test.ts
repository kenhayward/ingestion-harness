import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ArchiveWriter, readArchive } from '../src/backup/archive.js';
import { checkBackup } from '../src/backup/check.js';
import { createBackup } from '../src/backup/create.js';
import {
  BackupCorruptError,
  BackupKeyError,
  decryptStream,
  encryptStream,
} from '../src/backup/crypto.js';
import { BackupTooNewError } from '../src/backup/check.js';
import type { MemoryObjectStore } from '../src/storage/object-store.js';
import { fakeBackupDeps, FakeDatabaseTools, TEST_MASTER } from './backup-fakes.js';

const LOCAL = ['0001_init.sql', '202610171218_backup_restore.sql'];

async function make(
  over: Parameters<typeof fakeBackupDeps>[0] = {},
): Promise<{ file: Buffer; store: MemoryObjectStore }> {
  const deps = fakeBackupDeps(over);
  await deps.store.put('inbox', 'a/doc.pdf', Buffer.from('%PDF-1 one'), 'application/pdf');
  await deps.store.put('outputs', 'x/out.csv', Buffer.from('a,b\n1,2\n'), 'text/csv');
  const { key } = await createBackup(deps, 'b1', 'Ken', () => {});
  return { file: (await deps.store.get('backups', key))!, store: deps.store };
}

const input = (file: Buffer) => async () => Readable.from([file]);
const noProgress = () => {};

describe('checkBackup', () => {
  it('returns the manifest for a good file', async () => {
    const { file } = await make();
    const seen: number[] = [];
    const result = await checkBackup(input(file), [TEST_MASTER], LOCAL, (p) => seen.push(p.bytes));
    expect(result.manifest.format).toBe('ct-backup');
    expect(result.manifest.lastMigration).toBe('202610171218_backup_restore.sql');
    expect(result.master).toEqual(TEST_MASTER);
    expect(seen.at(-1)).toBeGreaterThan(0);
  });

  it('refuses a wrong key', async () => {
    const { file } = await make();
    await expect(
      checkBackup(input(file), [Buffer.alloc(32, 9)], LOCAL, noProgress),
    ).rejects.toBeInstanceOf(BackupKeyError);
  });

  it('opens with the previous key and says which one worked', async () => {
    const { file } = await make();
    const other = Buffer.alloc(32, 9);
    const result = await checkBackup(input(file), [other, TEST_MASTER], LOCAL, noProgress);
    expect(result.master).toEqual(TEST_MASTER);
  });

  it('refuses a part whose hash differs', async () => {
    // The dump's bytes change after the manifest recorded them: build the archive by hand.
    const deps = fakeBackupDeps();
    const { key } = await createBackup(deps, 'b1', 'Ken', () => {});
    const good = (await deps.store.get('backups', key))!;
    const flipped = await rewrite(good, (name, body) =>
      name === 'postgres.dump' ? Buffer.from('PGDMP evil dump') : body,
    );
    await expect(
      checkBackup(input(flipped), [TEST_MASTER], LOCAL, noProgress),
    ).rejects.toBeInstanceOf(BackupCorruptError);
  });

  it('refuses an object whose hash differs from the index', async () => {
    const { file } = await make();
    const changed = await rewrite(file, (name, body) =>
      name === 'objects/inbox/a/doc.pdf' ? Buffer.from('%PDF-1 two') : body,
    );
    await expect(checkBackup(input(changed), [TEST_MASTER], LOCAL, noProgress)).rejects.toThrow(
      /objects\/inbox\/a\/doc\.pdf/,
    );
  });

  it('refuses a file with bytes after the archive ends', async () => {
    const { file } = await make();
    const longer = await rewrite(file, (_n, body) => body, Buffer.from('trailing'));
    await expect(
      checkBackup(input(longer), [TEST_MASTER], LOCAL, noProgress),
    ).rejects.toBeInstanceOf(BackupCorruptError);
  });

  it('refuses a truncated file', async () => {
    const { file } = await make();
    await expect(
      checkBackup(input(file.subarray(0, file.length - 40)), [TEST_MASTER], LOCAL, noProgress),
    ).rejects.toBeInstanceOf(BackupCorruptError);
  });

  it('refuses a backup from a newer CT Studio', async () => {
    const { file } = await make({
      db: new FakeDatabaseTools(Buffer.from('d'), [...LOCAL, '202701010000_future.sql']),
    });
    const err = await checkBackup(input(file), [TEST_MASTER], LOCAL, noProgress).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BackupTooNewError);
    expect((err as Error).message).toBe(
      'this backup was made by a newer CT Studio (migration 202701010000_future.sql): upgrade this server first',
    );
  });

  it('passes an older backup', async () => {
    const { file } = await make({ db: new FakeDatabaseTools(Buffer.from('d'), [LOCAL[0]!]) });
    const result = await checkBackup(input(file), [TEST_MASTER], LOCAL, noProgress);
    expect(result.manifest.migrations).toEqual([LOCAL[0]]);
  });
});

type Entry = { name: string; body: Buffer };

/** Decrypts a backup into its entries, lets `change` reshape them, and re-encrypts. */
async function reshape(
  file: Buffer,
  change: (entries: Entry[]) => Entry[],
  trailing?: Buffer,
): Promise<Buffer> {
  const plain = Readable.from([file]).pipe(decryptStream([TEST_MASTER]));
  const entries: Entry[] = [];
  for await (const e of readArchive(plain)) {
    const chunks: Buffer[] = [];
    for await (const c of e.body) chunks.push(c as Buffer);
    entries.push({ name: e.name, body: Buffer.concat(chunks) });
  }
  const enc = encryptStream(TEST_MASTER);
  const out: Buffer[] = [];
  enc.on('data', (c: Buffer) => out.push(c));
  const writer = new ArchiveWriter(enc);
  for (const e of change(entries)) await writer.entry(e.name, e.body, e.body.length);
  await writer.end();
  if (trailing) enc.write(trailing);
  await new Promise<void>((resolve) => enc.end(resolve));
  return Buffer.concat(out);
}

const rewrite = (file: Buffer, map: (name: string, body: Buffer) => Buffer, trailing?: Buffer) =>
  reshape(file, (es) => es.map((e) => ({ name: e.name, body: map(e.name, e.body) })), trailing);

const find = (es: Entry[], name: string): Entry => es.find((e) => e.name === name)!;

const NL = String.fromCharCode(10);

describe('checkBackup refusals', () => {
  const refused = async (change: (es: Entry[]) => Entry[], message: RegExp) => {
    const { file } = await make();
    const changed = await reshape(file, change);
    const err = await checkBackup(input(changed), [TEST_MASTER], LOCAL, noProgress).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BackupCorruptError);
    expect((err as Error).message).toMatch(message);
  };
  const indexLines = (es: Entry[]) =>
    find(es, 'objects/index.jsonl').body.toString('utf8').split(NL).filter(Boolean);
  /** Replaces the index and keeps the manifest's record of it true, so only the index is wrong. */
  const withIndex = (es: Entry[], body: string): Entry[] => {
    const buf = Buffer.from(body);
    return es.map((e) => {
      if (e.name === 'objects/index.jsonl') return { name: e.name, body: buf };
      if (e.name !== 'manifest.json') return e;
      const manifest = JSON.parse(e.body.toString('utf8')) as {
        parts: { name: string; bytes: number; sha256: string }[];
      };
      for (const part of manifest.parts) {
        if (part.name === 'objects/index.jsonl') {
          part.bytes = buf.length;
          part.sha256 = createHash('sha256').update(buf).digest('hex');
        }
      }
      return { name: e.name, body: Buffer.from(JSON.stringify(manifest)) };
    });
  };

  it('an entry after the manifest', () =>
    refused((es) => [...es, { name: 'extra', body: Buffer.from('x') }], /after its manifest/));
  it('a duplicate entry', () => refused((es) => [es[0]!, ...es], /twice/));
  it('no manifest', () =>
    refused((es) => es.filter((e) => e.name !== 'manifest.json'), /no manifest/));
  it('a damaged manifest', () =>
    refused(
      (es) =>
        es.map((e) => (e.name === 'manifest.json' ? { name: e.name, body: Buffer.from('{}') } : e)),
      /manifest is damaged/,
    ));
  it('an unknown entry that is not an object', () =>
    refused(
      (es) => [{ name: 'surprise.bin', body: Buffer.from('x') }, ...es],
      /unknown entry surprise\.bin/,
    ));
  it('an object missing from the index', () =>
    refused(
      (es) => withIndex(es, indexLines(es).slice(1).join(NL) + NL),
      /not in the object index/,
    ));
  it('an index line with no entry', () =>
    refused(
      (es) => es.filter((e) => e.name !== 'objects/inbox/a/doc.pdf'),
      /missing objects\/inbox\/a\/doc\.pdf/,
    ));
  it('a damaged index line', () =>
    refused((es) => withIndex(es, 'not json' + NL), /index is damaged/));
  it('an index without its final newline', () =>
    refused((es) => withIndex(es, indexLines(es).join(NL)), /newline/));
  /** An object entry at `name`, listed in the index, so only its bucket is wrong. */
  const withObject = (es: Entry[], bucket: string, key: string): Entry[] => {
    const body = Buffer.from('stray');
    const line = JSON.stringify({
      role: 'target',
      bucket,
      key,
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    const withEntry = [{ name: `objects/${bucket}/${key}`, body }, ...es];
    return withIndex(withEntry, indexLines(es).concat(line).join(NL) + NL);
  };
  it('an object in a bucket the manifest does not list', () =>
    refused(
      (es) => withObject(es, 'elsewhere', 'x.json'),
      /objects\/elsewhere\/x\.json is in no bucket/,
    ));
  it('an object outside any bucket', () =>
    refused((es) => withObject(es, '', 'flat.json'), /is in no bucket of the manifest/));
  it('a duplicate index key', () =>
    refused(
      (es) => withIndex(es, indexLines(es).concat(indexLines(es)[0]!).join(NL) + NL),
      /twice/,
    ));
});
