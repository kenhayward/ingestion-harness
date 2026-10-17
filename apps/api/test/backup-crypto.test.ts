import { randomBytes } from 'node:crypto';
import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import {
  BackupCorruptError,
  BackupKeyError,
  CHUNK_SIZE,
  HEADER_BYTES,
  backupKey,
  decryptStream,
  encryptStream,
  parseMasterKey,
} from '../src/backup/crypto.js';

const TAG = 16;
const LENGTH = 4;

/** Runs `input` through `transform` in pieces of `piece` bytes and collects the output. */
async function run(transform: Transform, input: Buffer, piece = 65_537): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for (let i = 0; i < input.length; i += piece) pieces.push(input.subarray(i, i + piece));
  const out: Buffer[] = [];
  await pipeline(Readable.from(pieces), transform, async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) out.push(chunk);
  });
  return Buffer.concat(out);
}

const encrypt = (master: Buffer, plain: Buffer): Promise<Buffer> =>
  run(encryptStream(master), plain);
const decrypt = (masters: Buffer[], file: Buffer): Promise<Buffer> =>
  run(decryptStream(masters), file);

/** The byte offsets of each frame `[length][ciphertext][tag]` after the header. */
function frames(file: Buffer): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let at = HEADER_BYTES;
  while (at < file.length) {
    const end = at + LENGTH + file.readUInt32BE(at) + TAG;
    out.push({ start: at, end });
    at = end;
  }
  return out;
}

describe('backup stream', () => {
  const master = randomBytes(32);
  const other = randomBytes(32);

  it('round-trips 3.5 chunks of random bytes', async () => {
    const plain = randomBytes(CHUNK_SIZE * 3.5);
    const file = await encrypt(master, plain);
    expect(file.subarray(0, 8)).toEqual(Buffer.from('CTBAK\x00\x01\n', 'latin1'));
    expect(file.readUInt32BE(24)).toBe(1_048_576);
    expect(frames(file)).toHaveLength(4);
    expect(file.includes(plain.subarray(0, 64))).toBe(false);
    expect((await decrypt([master], file)).equals(plain)).toBe(true);
  });

  it('round-trips an exact number of chunks, the last one full', async () => {
    const plain = randomBytes(CHUNK_SIZE * 2);
    const file = await encrypt(master, plain);
    expect(frames(file)).toHaveLength(2);
    expect((await decrypt([master], file)).equals(plain)).toBe(true);
  });

  it('round-trips an empty input', async () => {
    const file = await encrypt(master, Buffer.alloc(0));
    expect(frames(file)).toHaveLength(1);
    expect(await decrypt([master], file)).toEqual(Buffer.alloc(0));
  });

  it('round-trips when the file arrives a byte at a time', async () => {
    const plain = randomBytes(5000);
    const file = await encrypt(master, plain);
    expect((await run(decryptStream([master]), file, 1)).equals(plain)).toBe(true);
  });

  it('salts each file, so the same input never encrypts the same way', async () => {
    const plain = randomBytes(100);
    const [a, b] = await Promise.all([encrypt(master, plain), encrypt(master, plain)]);
    expect(a.subarray(8, 24).equals(b.subarray(8, 24))).toBe(false);
    expect(a.subarray(HEADER_BYTES).equals(b.subarray(HEADER_BYTES))).toBe(false);
  });

  it('refuses another key with BackupKeyError', async () => {
    const file = await encrypt(master, randomBytes(1000));
    const err = await decrypt([other], file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupKeyError);
    expect((err as Error).message).toBe('this key does not open the backup');
  });

  it('falls back to the previous key', async () => {
    const plain = randomBytes(CHUNK_SIZE + 10);
    const file = await encrypt(master, plain);
    expect((await decrypt([other, master], file)).equals(plain)).toBe(true);
  });

  it('detects a flipped byte', async () => {
    const file = await encrypt(master, randomBytes(CHUNK_SIZE * 2.5));
    const second = frames(file)[1]!;
    file[second.start + LENGTH + 100]! ^= 0x01;
    await expect(decrypt([master], file)).rejects.toBeInstanceOf(BackupCorruptError);
  });

  it('detects truncation', async () => {
    const file = await encrypt(master, randomBytes(CHUNK_SIZE * 2.5));
    const last = frames(file).at(-1)!;
    await expect(decrypt([master], file.subarray(0, last.start))).rejects.toThrow(
      new BackupCorruptError('the backup is truncated'),
    );
  });

  it('detects a file cut inside a frame', async () => {
    const file = await encrypt(master, randomBytes(CHUNK_SIZE * 1.5));
    await expect(decrypt([master], file.subarray(0, file.length - 5))).rejects.toThrow(
      new BackupCorruptError('the backup is truncated'),
    );
  });

  it('detects reordered chunks', async () => {
    const file = await encrypt(master, randomBytes(CHUNK_SIZE * 3.5));
    const [a, b, c, d] = frames(file).map((f) => file.subarray(f.start, f.end));
    const swapped = Buffer.concat([file.subarray(0, HEADER_BYTES), a!, c!, b!, d!]);
    await expect(decrypt([master], swapped)).rejects.toBeInstanceOf(BackupCorruptError);
  });

  it('detects bytes after the last chunk', async () => {
    const file = await encrypt(master, randomBytes(100));
    await expect(
      decrypt([master], Buffer.concat([file, file.subarray(HEADER_BYTES)])),
    ).rejects.toBeInstanceOf(BackupCorruptError);
  });

  it('refuses a frame longer than the chunk size', async () => {
    const file = await encrypt(master, randomBytes(100));
    file.writeUInt32BE(CHUNK_SIZE + 1, HEADER_BYTES);
    await expect(decrypt([master], file)).rejects.toBeInstanceOf(BackupCorruptError);
  });

  it('refuses a bad magic', async () => {
    const file = await encrypt(master, randomBytes(100));
    file[0] = 0x58;
    await expect(decrypt([master], file)).rejects.toThrow(
      new BackupCorruptError('this is not a CT Studio backup'),
    );
  });

  it('refuses a file shorter than its header', async () => {
    const file = await encrypt(master, randomBytes(100));
    await expect(decrypt([master], file.subarray(0, 10))).rejects.toThrow(
      new BackupCorruptError('the backup is truncated'),
    );
    await expect(decrypt([master], Buffer.from('hello'))).rejects.toThrow(
      new BackupCorruptError('this is not a CT Studio backup'),
    );
    await expect(decrypt([master], Buffer.alloc(0))).rejects.toThrow(
      new BackupCorruptError('this is not a CT Studio backup'),
    );
  });
});

describe('backupKey', () => {
  it('derives a 32-byte key per salt', () => {
    const master = randomBytes(32);
    const a = backupKey(master, Buffer.alloc(16, 1));
    expect(a).toHaveLength(32);
    expect(a.equals(backupKey(master, Buffer.alloc(16, 1)))).toBe(true);
    expect(a.equals(backupKey(master, Buffer.alloc(16, 2)))).toBe(false);
    expect(a.equals(master)).toBe(false);
  });
});

describe('parseMasterKey', () => {
  it('reads 32 bytes of base64', () => {
    const key = randomBytes(32);
    expect(parseMasterKey(key.toString('base64')).equals(key)).toBe(true);
  });

  it.each(['', 'not base64', randomBytes(16).toString('base64')])('refuses %j', (value) => {
    expect(() => parseMasterKey(value)).toThrow(/must be 32 bytes, base64/);
  });
});
