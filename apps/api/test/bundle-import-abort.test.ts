import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('readBundle abort', () => {
  it('keeps the BundleError when closing an open sample file fails', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 1)]);
    // The sample is the only entry, so its temp file is open when the limit trips.
    const zip = zipSync({ 'samples/a.pdf': pdf });
    // Its own temp root: other test files create ih-import- dirs in the OS tmpdir in parallel.
    const root = await mkdtemp(join(tmpdir(), 'ih-abort-test-'));
    try {
      const err = await readBundle(Readable.from([Buffer.from(zip)]), {
        maxUploadBytes: 1024 * 1024,
        maxInflated: 1,
        maxEntries: 10,
        tmpRoot: root,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BundleError);
      expect((err as Error).message).toBe('bundle is too large');
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
