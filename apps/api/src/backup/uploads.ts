import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { BACKUP_PART_BYTES, type UploadStartBody, type UploadView } from '@ih/shared';
import { z } from 'zod';
import type { ObjectStore } from '../storage/object-store.js';

/** A refusal with the HTTP status the route answers. */
export class UploadError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

const PREFIX = 'uploads/';
const stateKey = (id: string) => `${PREFIX}${id}.json`;
/** The assembled file; a restore reads it from here. */
export const uploadFileKey = (id: string) => `${PREFIX}${id}.ctbak`;

/** `uploads/<id>.json`: the S3 upload and the etag of each part received (key = 0-based n). */
const StateSchema = z.object({
  id: z.string(),
  size: z.number(),
  fileName: z.string(),
  createdBy: z.string(),
  s3UploadId: z.string(),
  etags: z.record(z.string(), z.string()),
  completed: z.boolean().default(false),
});
type State = z.infer<typeof StateSchema>;

export interface BackupUploadsDeps {
  store: ObjectStore;
  /** The backups bucket. */
  bucket: string;
  /** Tests use small parts. */
  partBytes?: number;
}

/**
 * A backup of ten gigabytes or more arrives in 64 MiB parts, each its own request, so a dropped
 * connection costs one part. The parts are an S3 multipart upload in the backups bucket; which
 * parts have arrived is kept in `uploads/<id>.json`, so the upload resumes after an API restart
 * too. One upload at a time: starting another discards the previous one.
 */
export class BackupUploads {
  private readonly partBytes: number;
  /** State writes go one at a time, so parts arriving together do not overwrite each other. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BackupUploadsDeps) {
    this.partBytes = deps.partBytes ?? BACKUP_PART_BYTES;
  }

  async start(body: UploadStartBody, by: string): Promise<UploadView> {
    return this.exclusive(async () => {
      await this.discardAll();
      const id = randomUUID();
      const s3UploadId = await this.deps.store.createMultipart(
        this.deps.bucket,
        uploadFileKey(id),
        'application/octet-stream',
      );
      const state: State = {
        id,
        size: body.size,
        fileName: body.fileName,
        createdBy: by,
        s3UploadId,
        etags: {},
        completed: false,
      };
      await this.save(state);
      return this.view(state);
    });
  }

  async get(id: string): Promise<UploadView | null> {
    const state = await this.load(id);
    return state && this.view(state);
  }

  /** The assembled file of a completed upload; null when there is none or it is not complete. */
  async completedKey(id: string): Promise<string | null> {
    const state = await this.load(id);
    return state?.completed ? uploadFileKey(id) : null;
  }

  /** Stores part `n` (0-based), replacing one sent before. */
  async part(id: string, n: number, body: Readable, size: number): Promise<UploadView> {
    const state = await this.require(id);
    if (state.completed) throw new UploadError(409, 'the upload is already complete');
    const expected = this.partSize(state, n);
    if (expected === null || size !== expected) {
      throw new UploadError(400, `part ${n} must be ${expected ?? 0} bytes`);
    }
    const etag = await this.deps.store.uploadPart(
      this.deps.bucket,
      uploadFileKey(id),
      state.s3UploadId,
      n + 1,
      body,
      size,
    );
    return this.exclusive(async () => {
      const current = await this.require(id);
      current.etags[String(n)] = etag;
      await this.save(current);
      return this.view(current);
    });
  }

  /** Joins the parts into `uploads/<id>.ctbak`. Asking again after it succeeded answers the same. */
  async complete(id: string): Promise<{ key: string }> {
    return this.exclusive(async () => {
      const state = await this.require(id);
      if (state.completed) return { key: uploadFileKey(id) };
      const missing = this.missing(state);
      if (missing.length > 0) throw new UploadError(409, `parts missing: ${missing.join(', ')}`);
      const parts = Object.entries(state.etags).map(([n, etag]) => ({
        partNumber: Number(n) + 1,
        etag,
      }));
      await this.deps.store.completeMultipart(
        this.deps.bucket,
        uploadFileKey(id),
        state.s3UploadId,
        parts,
      );
      await this.save({ ...state, completed: true });
      return { key: uploadFileKey(id) };
    });
  }

  async abort(id: string): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load(id);
      if (state) await this.discard(state);
    });
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.lock.then(run, run);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private async discardAll(): Promise<void> {
    const keys: string[] = [];
    for await (const { key } of this.deps.store.list(this.deps.bucket, PREFIX)) keys.push(key);
    for (const key of keys) {
      if (!key.endsWith('.json')) continue;
      const id = key.slice(PREFIX.length, -'.json'.length);
      const state = await this.load(id);
      if (state) await this.discard(state);
      else {
        // A damaged state file: its upload cannot be aborted, but its files can go.
        await this.deps.store.delete(this.deps.bucket, uploadFileKey(id));
        await this.deps.store.delete(this.deps.bucket, key);
      }
    }
  }

  private async discard(state: State): Promise<void> {
    const { store, bucket } = this.deps;
    if (state.completed) await store.delete(bucket, uploadFileKey(state.id));
    else {
      await store
        .abortMultipart(bucket, uploadFileKey(state.id), state.s3UploadId)
        .catch(() => undefined);
    }
    await store.delete(bucket, stateKey(state.id));
  }

  /** The upload's state; null when it has none or its file is damaged. */
  private async load(id: string): Promise<State | null> {
    const raw = await this.deps.store.get(this.deps.bucket, stateKey(id));
    if (!raw) return null;
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
    const parsed = StateSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  private async require(id: string): Promise<State> {
    const state = await this.load(id);
    if (!state) throw new UploadError(404, 'upload not found');
    return state;
  }

  private save(state: State): Promise<void> {
    return this.deps.store.put(
      this.deps.bucket,
      stateKey(state.id),
      Buffer.from(JSON.stringify(state)),
      'application/json',
    );
  }

  private count(state: State): number {
    return Math.ceil(state.size / this.partBytes);
  }

  /** Part `n` is a full part except the last, which is what remains; null when there is no such part. */
  private partSize(state: State, n: number): number | null {
    if (!Number.isInteger(n) || n < 0 || n >= this.count(state)) return null;
    return Math.min(this.partBytes, state.size - n * this.partBytes);
  }

  private missing(state: State): number[] {
    const out: number[] = [];
    for (let n = 0; n < this.count(state); n++) if (!(String(n) in state.etags)) out.push(n);
    return out;
  }

  private view(state: State): UploadView {
    return {
      id: state.id,
      size: state.size,
      partBytes: this.partBytes,
      parts: this.count(state),
      received: Object.keys(state.etags)
        .map(Number)
        .sort((a, b) => a - b),
    };
  }
}
