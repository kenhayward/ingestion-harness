import { Readable } from 'node:stream';

export interface ListedObject {
  key: string;
  size: number;
}

export interface StreamedObject {
  body: Readable;
  size: number;
  contentType: string;
}

/** Object storage port. `S3ObjectStore` (SeaweedFS) in production, `MemoryObjectStore` in tests. */
export interface ObjectStore {
  ping(bucket: string): Promise<void>;
  /** Create the bucket when it does not exist; already owned by us is success. */
  ensureBucket(bucket: string): Promise<void>;
  put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
  get(bucket: string, key: string): Promise<Buffer | null>;
  delete(bucket: string, key: string): Promise<void>;
  /** Delete every object whose key starts with `prefix`. Returns how many were deleted. */
  deletePrefix(bucket: string, prefix: string): Promise<number>;
  /** Every object whose key starts with `prefix` (all when absent), in key order, paged lazily. */
  list(bucket: string, prefix?: string): AsyncIterable<ListedObject>;
  /** The object as a stream, or null when it does not exist. */
  getStream(bucket: string, key: string): Promise<StreamedObject | null>;
  /** Store a stream of unknown length (S3: multipart upload, 16 MiB parts). */
  putStream(bucket: string, key: string, body: Readable, contentType: string): Promise<void>;
  /** Start a multipart upload; returns its upload id. */
  createMultipart(bucket: string, key: string, contentType: string): Promise<string>;
  /** Upload one part (1-based `partNumber`) of exactly `size` bytes; returns its etag. */
  uploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Readable,
    size: number,
  ): Promise<string>;
  /** Assemble the parts, in part order, into the object. */
  completeMultipart(
    bucket: string,
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  abortMultipart(bucket: string, key: string, uploadId: string): Promise<void>;
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  readonly ensured: string[] = [];

  async ping(): Promise<void> {}

  async ensureBucket(bucket: string): Promise<void> {
    this.ensured.push(bucket);
  }

  async put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(`${bucket}/${key}`, { body, contentType });
  }

  async get(bucket: string, key: string): Promise<Buffer | null> {
    return this.objects.get(`${bucket}/${key}`)?.body ?? null;
  }

  async delete(bucket: string, key: string): Promise<void> {
    this.objects.delete(`${bucket}/${key}`);
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`));
    for (const k of keys) this.objects.delete(k);
    return keys.length;
  }

  async *list(bucket: string, prefix = ''): AsyncIterable<ListedObject> {
    const head = `${bucket}/`;
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(head) && k.startsWith(`${head}${prefix}`))
      .map((k) => k.slice(head.length))
      .sort();
    for (const key of keys) yield { key, size: this.objects.get(`${head}${key}`)!.body.length };
  }

  async getStream(bucket: string, key: string): Promise<StreamedObject | null> {
    const found = this.objects.get(`${bucket}/${key}`);
    if (!found) return null;
    return {
      body: Readable.from([found.body]),
      size: found.body.length,
      contentType: found.contentType,
    };
  }

  async putStream(bucket: string, key: string, body: Readable, contentType: string): Promise<void> {
    await this.put(bucket, key, await readAll(body), contentType);
  }

  private readonly uploads = new Map<
    string,
    { bucket: string; key: string; contentType: string; parts: Map<number, Buffer> }
  >();

  async createMultipart(bucket: string, key: string, contentType: string): Promise<string> {
    const id = `upload-${this.uploads.size + 1}-${Math.random().toString(36).slice(2)}`;
    this.uploads.set(id, { bucket, key, contentType, parts: new Map() });
    return id;
  }

  async uploadPart(
    _bucket: string,
    _key: string,
    uploadId: string,
    partNumber: number,
    body: Readable,
    size: number,
  ): Promise<string> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`no such upload ${uploadId}`);
    const bytes = await readAll(body);
    if (bytes.length !== size)
      throw new Error(`part ${partNumber} is ${bytes.length} bytes, not ${size}`);
    upload.parts.set(partNumber, bytes);
    return `etag-${uploadId}-${partNumber}`;
  }

  async completeMultipart(
    bucket: string,
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`no such upload ${uploadId}`);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const bodies = ordered.map((p) => {
      const part = upload.parts.get(p.partNumber);
      if (!part || p.etag !== `etag-${uploadId}-${p.partNumber}`) {
        throw new Error(`part ${p.partNumber} was not uploaded`);
      }
      return part;
    });
    await this.put(bucket, key, Buffer.concat(bodies), upload.contentType);
    this.uploads.delete(uploadId);
  }

  async abortMultipart(_bucket: string, _key: string, uploadId: string): Promise<void> {
    this.uploads.delete(uploadId);
  }
}
