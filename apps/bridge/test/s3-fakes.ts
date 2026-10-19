import { MemoryObjectStore } from '../src/s3/store.js';

/** An S3-style error as the AWS SDK throws it: identified by `name` (and `code` for sockets). */
export function s3Failure(name: string, extra: Record<string, unknown> = {}): Error {
  const err = new Error(`${name}: request detail that must never be echoed`);
  err.name = name;
  Object.assign(err, extra);
  return err;
}

/** Every operation throws `err`. */
export class ThrowingStore extends MemoryObjectStore {
  constructor(private readonly err: () => Error) {
    super();
  }
  override async put(): Promise<void> {
    throw this.err();
  }
  override async get(): Promise<Buffer | null> {
    throw this.err();
  }
  override async delete(): Promise<void> {
    throw this.err();
  }
  override async ping(): Promise<void> {
    throw this.err();
  }
  override async checkCredentials(): Promise<void> {
    throw this.err();
  }
}

/** HEAD bucket answers 404, as SeaweedFS and S3 do for a missing bucket. */
export class MissingBucketStore extends MemoryObjectStore {
  override async ping(): Promise<void> {
    throw s3Failure('NotFound', { $metadata: { httpStatusCode: 404 } });
  }
}

/** Reads back something other than what was written. */
export class GarblingStore extends MemoryObjectStore {
  override async get(): Promise<Buffer | null> {
    return Buffer.from('not what was written');
  }
}
