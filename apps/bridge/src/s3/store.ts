import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type StorageClass,
} from '@aws-sdk/client-s3';

/** The object operations the S3 sink and the package store need. */
export interface ObjectStorePort {
  put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
  /** Null when there is no such object. */
  get(bucket: string, key: string): Promise<Buffer | null>;
  delete(bucket: string, key: string): Promise<void>;
  /** Throws when the bucket is missing or cannot be reached. */
  ping(bucket: string): Promise<void>;
  ensureBucket(bucket: string): Promise<void>;
  /** Throws when the endpoint refuses these keys (lists buckets). */
  checkCredentials(): Promise<void>;
}

export interface S3StoreOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing; true is what SeaweedFS needs. */
  forcePathStyle: boolean;
  /** Server-side encryption applied to every put. */
  sse?: 'none' | 'AES256' | 'aws:kms';
  kmsKeyId?: string | null;
  storageClass?: string | null;
}

/** Objects in memory, keyed `bucket/key`; for tests. */
export class MemoryObjectStore implements ObjectStorePort {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly ensured: string[] = [];

  async put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(`${bucket}/${key}`, { body: Buffer.from(body), contentType });
  }

  async get(bucket: string, key: string): Promise<Buffer | null> {
    const found = this.objects.get(`${bucket}/${key}`);
    return found ? Buffer.from(found.body) : null;
  }

  async delete(bucket: string, key: string): Promise<void> {
    this.objects.delete(`${bucket}/${key}`);
  }

  async ping(): Promise<void> {}

  async ensureBucket(bucket: string): Promise<void> {
    this.ensured.push(bucket);
  }

  async checkCredentials(): Promise<void> {}
}

/** An S3-compatible store, built the same way as CT Studio's API builds its own. */
export class S3ObjectStore implements ObjectStorePort {
  private readonly client: Pick<S3Client, 'send'>;

  /** `client` is for tests (a stub `send`); production builds one from `opts`. */
  constructor(
    private readonly opts: S3StoreOptions,
    client?: Pick<S3Client, 'send'>,
  ) {
    this.client =
      client ??
      new S3Client({
        endpoint: opts.endpoint,
        region: opts.region,
        forcePathStyle: opts.forcePathStyle,
        credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
        // Fail fast on an unresponsive endpoint rather than hold a delivery's lease.
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
      });
  }

  async put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    const { sse, kmsKeyId, storageClass } = this.opts;
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(sse && sse !== 'none' ? { ServerSideEncryption: sse } : {}),
        ...(sse === 'aws:kms' && kmsKeyId ? { SSEKMSKeyId: kmsKeyId } : {}),
        ...(storageClass ? { StorageClass: storageClass as StorageClass } : {}),
      }),
    );
  }

  async get(bucket: string, key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (err instanceof NoSuchKey || (err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async ping(bucket: string): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
  }

  async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (err) {
      if (err instanceof BucketAlreadyOwnedByYou) return;
      if ((err as { name?: string }).name === 'BucketAlreadyOwnedByYou') return;
      throw err;
    }
  }

  async checkCredentials(): Promise<void> {
    await this.client.send(new ListBucketsCommand({}));
  }
}
