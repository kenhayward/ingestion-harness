import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createBackup } from '../src/backup/create.js';
import { fakeBackupDeps } from './backup-fakes.js';

/**
 * The object index is written to a temporary file: a disk error there (a full disk) must fail
 * the backup, never crash the API or leave it waiting for a `drain` that never comes.
 */
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const createWriteStream = ((path: string, ...rest: unknown[]) => {
    if (!String(path).endsWith('index.jsonl')) {
      return (fs.createWriteStream as (...a: unknown[]) => unknown)(path, ...rest);
    }
    // Every write asks the writer to wait (tiny buffer), then fails like a full disk.
    return new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setImmediate(() => callback(new Error('ENOSPC: no space left on device, write')));
      },
    });
  }) as typeof fs.createWriteStream;
  return { ...fs, default: { ...fs, createWriteStream }, createWriteStream };
});

describe('createBackup with a failing disk', () => {
  it('fails the backup when the object index cannot be written', async () => {
    const deps = fakeBackupDeps();
    await deps.store.put('inbox', 'a/doc.pdf', Buffer.from('%PDF-1 one'), 'application/pdf');
    await deps.store.put('outputs', 'x/out.csv', Buffer.from('a,b\n'), 'text/csv');

    await expect(createBackup(deps, 'b1', 'Ken', () => {})).rejects.toThrow('ENOSPC');
    expect(await deps.store.get('backups', 'b1.ctbak')).toBeNull();
  }, 5000);
});
