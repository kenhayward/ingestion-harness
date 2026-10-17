import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ArchiveWriter, readArchive } from '../src/backup/archive.js';

async function write(build: (w: ArchiveWriter) => Promise<void>): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const writer = new ArchiveWriter(out);
  await build(writer);
  await writer.end();
  return Buffer.concat(chunks);
}

async function readAll(bytes: Buffer, piece = 7): Promise<{ name: string; body: Buffer }[]> {
  const pieces: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += piece) pieces.push(bytes.subarray(i, i + piece));
  const entries: { name: string; body: Buffer }[] = [];
  for await (const entry of readArchive(Readable.from(pieces))) {
    const parts: Buffer[] = [];
    for await (const chunk of entry.body) parts.push(chunk as Buffer);
    const body = Buffer.concat(parts);
    expect(body.length).toBe(entry.size);
    entries.push({ name: entry.name, body });
  }
  return entries;
}

describe('backup archive framing', () => {
  it('writes and reads three entries in order', async () => {
    const big = Buffer.alloc(100_000, 'x');
    let sha = '';
    const bytes = await write(async (w) => {
      await w.entry('postgres.dump', Buffer.from('dump'), 4);
      sha = (
        await w.entry(
          'objects/index.jsonl',
          Readable.from([big.subarray(0, 40_000), big.subarray(40_000)]),
          big.length,
        )
      ).sha256;
      await w.entry('manifest.json', Buffer.from('{}'), 2);
    });
    expect(sha).toBe(createHash('sha256').update(big).digest('hex'));
    const entries = await readAll(bytes);
    expect(entries.map((e) => e.name)).toEqual([
      'postgres.dump',
      'objects/index.jsonl',
      'manifest.json',
    ]);
    expect(entries[0]!.body.toString()).toBe('dump');
    expect(entries[1]!.body.equals(big)).toBe(true);
    expect(entries[2]!.body.toString()).toBe('{}');
  });

  it('keeps keys with slashes, spaces and unicode', async () => {
    const name = 'objects/inbox/my bucket/dir/ünïcode ✓ file.pdf';
    const entries = await readAll(
      await write((w) => w.entry(name, Buffer.from('a'), 1).then(() => undefined)),
    );
    expect(entries).toEqual([{ name, body: Buffer.from('a') }]);
  });

  it('refuses a body shorter than its size', async () => {
    await expect(
      write((w) => w.entry('a', Buffer.from('abc'), 5).then(() => undefined)),
    ).rejects.toThrow(/size/);
    await expect(
      write((w) => w.entry('a', Readable.from([Buffer.from('abc')]), 5).then(() => undefined)),
    ).rejects.toThrow(/size/);
  });

  it('refuses a body longer than its size', async () => {
    await expect(
      write((w) => w.entry('a', Readable.from([Buffer.from('abcdef')]), 5).then(() => undefined)),
    ).rejects.toThrow(/size/);
  });

  it('reads an empty archive', async () => {
    expect(await readAll(await write(async () => undefined))).toEqual([]);
  });

  it('errors on a stream cut inside an entry', async () => {
    const bytes = await write((w) =>
      w.entry('a', Buffer.from('abcdefgh'), 8).then(() => undefined),
    );
    await expect(readAll(bytes.subarray(0, bytes.length - 6))).rejects.toThrow(/truncated/);
  });

  it('errors on a stream cut before the terminator or inside a header', async () => {
    const bytes = await write((w) =>
      w.entry('a', Buffer.from('abcdefgh'), 8).then(() => undefined),
    );
    await expect(readAll(bytes.subarray(0, bytes.length - 4))).rejects.toThrow(/truncated/);
    await expect(readAll(bytes.subarray(0, 6))).rejects.toThrow(/truncated/);
  });

  it('refuses a header larger than the cap', async () => {
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(10_000_000);
    await expect(readAll(bad)).rejects.toThrow(/header/);
  });
});
