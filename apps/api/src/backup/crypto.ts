import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { parseMasterKey } from '../llm/secrets.js';

/**
 * The encrypted stream every backup file passes through: a plaintext header (magic, KDF salt,
 * chunk size), then AES-256-GCM frames `[u32 BE ciphertext length][ciphertext][16-byte tag]`.
 *
 * The key is `hkdf(sha256, master, salt, 'ct-backup v1')`, fresh per file (random salt), so the
 * nonce, `4 zero bytes ‖ u64 BE chunk index`, never repeats under one key. The associated data,
 * `u64 BE index ‖ last flag`, binds each chunk's place: reordered, dropped or appended chunks fail
 * their tag, and a file without a final-flagged chunk is truncated. The final chunk is always
 * written (possibly empty) on flush. Memory stays at about one chunk either way.
 */

export { parseMasterKey };

export const MAGIC = Buffer.from('CTBAK\x00\x01\n', 'latin1');
export const SALT_BYTES = 16;
export const CHUNK_SIZE = 1_048_576;
export const HEADER_BYTES = MAGIC.length + SALT_BYTES + 4;

const INFO = 'ct-backup v1';
const LENGTH_BYTES = 4;
const TAG_BYTES = 16;
/** A header naming a larger chunk is refused, so a hostile file cannot make us buffer more. */
const MAX_CHUNK_SIZE = 64 * 1_048_576;

/** None of the keys tried opens the backup. */
export class BackupKeyError extends Error {
  constructor(message = 'this key does not open the backup') {
    super(message);
    this.name = 'BackupKeyError';
  }
}

/** The file is not a backup, or was changed, reordered or cut short. */
export class BackupCorruptError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BackupCorruptError';
  }
}

export function backupKey(master: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, INFO, 32));
}

function nonce(index: bigint): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64BE(index, 4);
  return out;
}

function aad(index: bigint, last: boolean): Buffer {
  const out = Buffer.alloc(9);
  out.writeBigUInt64BE(index);
  out[8] = last ? 1 : 0;
  return out;
}

function sealChunk(key: Buffer, index: bigint, last: boolean, plain: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce(index));
  cipher.setAAD(aad(index, last));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const length = Buffer.alloc(LENGTH_BYTES);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body, cipher.getAuthTag()]);
}

/** The plaintext, or null when the tag does not verify under this key and flag. */
function openChunk(
  key: Buffer,
  index: bigint,
  last: boolean,
  body: Buffer,
  tag: Buffer,
): Buffer | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce(index));
    decipher.setAAD(aad(index, last));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

/** Bytes received but not yet consumed, kept as a list so appending never copies. */
class ByteQueue {
  private parts: Buffer[] = [];
  length = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.parts.push(chunk);
    this.length += chunk.length;
  }

  /** Removes and returns the first `n` bytes; the caller checks `length` first. */
  take(n: number): Buffer {
    const out: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const head = this.parts[0]!;
      if (head.length <= need) {
        out.push(head);
        this.parts.shift();
        need -= head.length;
      } else {
        out.push(head.subarray(0, need));
        this.parts[0] = head.subarray(need);
        need = 0;
      }
    }
    this.length -= n;
    return out.length === 1 ? out[0]! : Buffer.concat(out, n);
  }

  peekUInt32BE(): number {
    const bytes = this.take(LENGTH_BYTES);
    this.parts.unshift(bytes);
    this.length += LENGTH_BYTES;
    return bytes.readUInt32BE();
  }
}

export function encryptStream(master: Buffer): Transform {
  const salt = randomBytes(SALT_BYTES);
  const key = backupKey(master, salt);
  const pending = new ByteQueue();
  let index = 0n;
  let headerSent = false;

  const header = (stream: Transform): void => {
    if (headerSent) return;
    const size = Buffer.alloc(4);
    size.writeUInt32BE(CHUNK_SIZE);
    stream.push(Buffer.concat([MAGIC, salt, size]));
    headerSent = true;
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      header(this);
      pending.push(chunk);
      // Hold back at least one byte past a full chunk: only flush knows which chunk is last.
      while (pending.length > CHUNK_SIZE) {
        this.push(sealChunk(key, index, false, pending.take(CHUNK_SIZE)));
        index += 1n;
      }
      callback();
    },
    flush(callback: TransformCallback) {
      header(this);
      this.push(sealChunk(key, index, true, pending.take(pending.length)));
      callback();
    },
  });
}

/**
 * Tries each master key (current, then previous) on the first chunk and keeps the one that opens
 * it. A first chunk no key opens is a `BackupKeyError`; any later failure is corruption.
 */
export function decryptStream(masters: Buffer[]): Transform {
  const pending = new ByteQueue();
  let salt: Buffer | null = null;
  let chunkSize = 0;
  let key: Buffer | null = null;
  let index = 0n;
  let done = false;

  const readHeader = (): void => {
    const header = pending.take(HEADER_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupCorruptError('this is not a CT Studio backup');
    }
    salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
    chunkSize = header.readUInt32BE(MAGIC.length + SALT_BYTES);
    if (chunkSize === 0 || chunkSize > MAX_CHUNK_SIZE) {
      throw new BackupCorruptError(`the backup names an impossible chunk size (${chunkSize})`);
    }
  };

  /** Opens one frame, the last flag first tried as set: only that chunk's tag matches it. */
  const open = (body: Buffer, tag: Buffer): { plain: Buffer; last: boolean } | null => {
    const keys = key ? [key] : masters.map((m) => backupKey(m, salt!));
    for (const candidate of keys) {
      for (const last of [false, true]) {
        const plain = openChunk(candidate, index, last, body, tag);
        if (plain) {
          key = candidate;
          return { plain, last };
        }
      }
    }
    return null;
  };

  const drain = (stream: Transform): void => {
    if (!salt) {
      if (pending.length < HEADER_BYTES) return;
      readHeader();
    }
    while (pending.length >= LENGTH_BYTES) {
      if (done) throw new BackupCorruptError('the backup has data after its last chunk');
      const length = pending.peekUInt32BE();
      if (length > chunkSize) throw new BackupCorruptError('the backup has a damaged chunk');
      if (pending.length < LENGTH_BYTES + length + TAG_BYTES) return;
      pending.take(LENGTH_BYTES);
      const body = pending.take(length);
      const tag = pending.take(TAG_BYTES);
      const opened = open(body, tag);
      if (!opened) {
        if (index === 0n) throw new BackupKeyError();
        throw new BackupCorruptError('the backup has a damaged chunk');
      }
      if (!opened.last && length !== chunkSize) {
        throw new BackupCorruptError('the backup has a damaged chunk');
      }
      stream.push(opened.plain);
      index += 1n;
      done = opened.last;
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      pending.push(chunk);
      try {
        drain(this);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback: TransformCallback) {
      if (!salt) {
        // A short file: cut inside the header if what there is starts like one.
        const start = pending.take(Math.min(pending.length, MAGIC.length));
        callback(
          new BackupCorruptError(
            start.equals(MAGIC.subarray(0, start.length)) && start.length > 0
              ? 'the backup is truncated'
              : 'this is not a CT Studio backup',
          ),
        );
        return;
      }
      if (pending.length > 0 && done) {
        callback(new BackupCorruptError('the backup has data after its last chunk'));
        return;
      }
      callback(done ? null : new BackupCorruptError('the backup is truncated'));
    },
  });
}
