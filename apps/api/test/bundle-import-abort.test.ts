import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { BundleError, readBundle } from '../src/workbench/bundle-import.js';

// closeSync closes the descriptor, then fails: the abort path must not let that mask the refusal.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    closeSync: (fd: number) => {
      fs.closeSync(fd);
      throw new Error('close failed');
    },
  };
});

const tmpEntries = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith('ih-import-')).sort();

describe('readBundle abort', () => {
  it('keeps the BundleError when closing an open sample file fails', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 1)]);
    // The sample is the only entry, so its temp file is open when the limit trips.
    const zip = zipSync({ 'samples/a.pdf': pdf });
    const before = await tmpEntries();
    const err = await readBundle(Readable.from([Buffer.from(zip)]), {
      maxUploadBytes: 1024 * 1024,
      maxInflated: 1,
      maxEntries: 10,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleError);
    expect((err as Error).message).toBe('bundle is too large');
    expect(await tmpEntries()).toEqual(before);
  });
});
