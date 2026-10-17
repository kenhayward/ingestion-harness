import { createHash } from 'node:crypto';
import { Readable, type Writable } from 'node:stream';

/**
 * The container inside the encrypted stream: entries `[u32 BE header length][header JSON
 * {name,size}][size bytes]`, then a zero header length as the terminator. Bodies are streamed in
 * both directions, never held whole.
 */

/** A header larger than this is refused, so a hostile file cannot make the reader buffer more. */
const MAX_HEADER_BYTES = 64 * 1024;

export class ArchiveError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ArchiveError';
  }
}

export class ArchiveWriter {
  constructor(private readonly out: Writable) {}

  private put(chunk: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.out.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
  }

  async entry(name: string, body: Readable | Buffer, size: number): Promise<{ sha256: string }> {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new ArchiveError(`entry ${name}: bad size ${size}`);
    const header = Buffer.from(JSON.stringify({ name, size }), 'utf8');
    if (header.length > MAX_HEADER_BYTES)
      throw new ArchiveError(`entry name too long: ${name.slice(0, 40)}…`);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    await this.put(Buffer.concat([length, header]));

    const hash = createHash('sha256');
    let written = 0;
    const source: AsyncIterable<Buffer | string> | Iterable<Buffer> = Buffer.isBuffer(body)
      ? [body]
      : body;
    for await (const piece of source) {
      const chunk = typeof piece === 'string' ? Buffer.from(piece) : piece;
      written += chunk.length;
      if (written > size)
        throw new ArchiveError(`entry ${name}: body is longer than its size ${size}`);
      hash.update(chunk);
      await this.put(chunk);
    }
    if (written !== size) {
      throw new ArchiveError(`entry ${name}: body is ${written} bytes, its size says ${size}`);
    }
    return { sha256: hash.digest('hex') };
  }

  async end(): Promise<void> {
    await this.put(Buffer.alloc(4));
  }
}

/**
 * Reads entries in order. The consumer must drain each `body` before asking for the next entry
 * (an undrained one is an error). A stream that ends before the terminator, or inside a header or
 * body, is `ArchiveError` "truncated".
 */
export async function* readArchive(
  input: Readable,
): AsyncGenerator<{ name: string; size: number; body: Readable }> {
  const source = input[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let leftover: Buffer = Buffer.alloc(0);
  let ended = false;

  /** The next piece of input, or null at its end. */
  const next = async (): Promise<Buffer | null> => {
    if (leftover.length > 0) {
      const out = leftover;
      leftover = Buffer.alloc(0);
      return out;
    }
    while (!ended) {
      const r = await source.next();
      if (r.done) {
        ended = true;
        return null;
      }
      const chunk = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value as Uint8Array);
      if (chunk.length > 0) return chunk;
    }
    return null;
  };

  const exactly = async (n: number): Promise<Buffer> => {
    const parts: Buffer[] = [];
    let have = 0;
    while (have < n) {
      const chunk = await next();
      if (!chunk) throw new ArchiveError('the backup archive is truncated');
      const take = Math.min(chunk.length, n - have);
      parts.push(chunk.subarray(0, take));
      if (take < chunk.length) leftover = chunk.subarray(take);
      have += take;
    }
    return Buffer.concat(parts, n);
  };

  try {
    for (;;) {
      const headerLength = (await exactly(4)).readUInt32BE();
      if (headerLength === 0) return;
      if (headerLength > MAX_HEADER_BYTES) {
        throw new ArchiveError(
          `the backup archive has an impossible header (${headerLength} bytes)`,
        );
      }
      let header: { name?: unknown; size?: unknown };
      try {
        header = JSON.parse((await exactly(headerLength)).toString('utf8')) as typeof header;
      } catch (err) {
        if (err instanceof ArchiveError) throw err;
        throw new ArchiveError('the backup archive has a damaged header');
      }
      const { name, size } = header;
      if (
        typeof name !== 'string' ||
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size < 0
      ) {
        throw new ArchiveError('the backup archive has a damaged header');
      }

      let remaining = size;
      const body = new Readable({
        read() {
          if (remaining === 0) {
            this.push(null);
            return;
          }
          next().then(
            (chunk) => {
              if (!chunk) {
                this.destroy(new ArchiveError('the backup archive is truncated'));
                return;
              }
              const take = Math.min(chunk.length, remaining);
              if (take < chunk.length) leftover = chunk.subarray(take);
              remaining -= take;
              this.push(chunk.subarray(0, take));
              if (remaining === 0) this.push(null);
            },
            (err: Error) => this.destroy(err),
          );
        },
      });
      yield { name, size, body };
      if (body.errored) throw body.errored;
      if (remaining > 0) throw new ArchiveError(`entry ${name} was not read to its end`);
    }
  } finally {
    await source.return?.();
  }
}
