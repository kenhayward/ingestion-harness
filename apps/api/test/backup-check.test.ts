import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ArchiveWriter } from '../src/backup/archive.js';
import { checkBackup } from '../src/backup/check.js';
import { createBackup } from '../src/backup/create.js';
import { BackupCorruptError, BackupKeyError, encryptStream } from '../src/backup/crypto.js';
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

/** Decrypts, maps each entry's body, and re-encrypts (optionally with bytes after the end). */
async function rewrite(
  file: Buffer,
  map: (name: string, body: Buffer) => Buffer,
  trailing?: Buffer,
): Promise<Buffer> {
  const { decryptStream } = await import('../src/backup/crypto.js');
  const { readArchive } = await import('../src/backup/archive.js');
  const plain = Readable.from([file]).pipe(decryptStream([TEST_MASTER]));
  const entries: { name: string; body: Buffer }[] = [];
  for await (const e of readArchive(plain)) {
    const chunks: Buffer[] = [];
    for await (const c of e.body) chunks.push(c as Buffer);
    entries.push({ name: e.name, body: map(e.name, Buffer.concat(chunks)) });
  }
  const enc = encryptStream(TEST_MASTER);
  const out: Buffer[] = [];
  enc.on('data', (c: Buffer) => out.push(c));
  const writer = new ArchiveWriter(enc);
  for (const e of entries) await writer.entry(e.name, e.body, e.body.length);
  await writer.end();
  if (trailing) enc.write(trailing);
  await new Promise<void>((resolve) => enc.end(resolve));
  return Buffer.concat(out);
}
