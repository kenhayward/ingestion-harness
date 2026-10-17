import {
  AbortMultipartUploadCommand,
  BucketAlreadyOwnedByYou,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  type DeleteObjectsCommandOutput,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  type StorageClass,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';
import type { ListedObject, ObjectStore, StreamedObject } from './object-store.js';

/** Part size of a streamed upload; lib-storage allows 10,000 parts, so 16 MiB reaches 160 GB. */
const STREAM_PART_BYTES = 16 * 1024 * 1024;

export interface S3Options {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing; true (the default) is what SeaweedFS needs. */
  forcePathStyle?: boolean;
  /** Server-side encryption applied to every put. */
  sse?: 'none' | 'AES256' | 'aws:kms';
  kmsKeyId?: string | null;
  storageClass?: string | null;
}

/**
 * Client settings. Timeouts make an unresponsive endpoint (e.g. a firewalled publish target)
 * fail fast into the 404/502 paths instead of hanging requests.
 */
export function s3ClientConfig(opts: S3Options): S3ClientConfig {
  return {
    endpoint: opts.endpoint,
    region: opts.region,
    forcePathStyle: opts.forcePathStyle ?? true,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
  };
}

/** S3-compatible store. SeaweedFS requires path-style addressing. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: Pick<S3Client, 'send'>;
  private readonly opts: S3Options;

  /** `client` is for tests (a stub `send`); production builds one from `opts`. */
  constructor(opts: S3Options, client?: Pick<S3Client, 'send'>) {
    this.opts = opts;
    this.client = client ?? new S3Client(s3ClientConfig(opts));
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    let deleted = 0;
    let listed = 0;
    const failures: string[] = [];
    let token: string | undefined;
    do {
      const page: ListObjectsV2CommandOutput = await this.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length) {
        listed += keys.length;
        const res: DeleteObjectsCommandOutput = await this.client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
        );
        // Per-key failures come back in a 200 response; Quiet mode lists only those.
        const errors = res.Errors ?? [];
        failures.push(...errors.map((e) => `${e.Key} (${e.Code ?? e.Message ?? 'error'})`));
        deleted += keys.length - errors.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    if (failures.length) {
      throw new Error(
        `${failures.length} of ${listed} objects under ${bucket}/${prefix} not deleted: ` +
          failures.slice(0, 5).join(', '),
      );
    }
    return deleted;
  }

  async ping(bucket: string): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
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

  async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (err) {
      if (err instanceof BucketAlreadyOwnedByYou) return;
      if ((err as { name?: string }).name === 'BucketAlreadyOwnedByYou') return;
      throw err;
    }
  }

  async get(bucket: string, key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  /** Encryption and storage-class settings every write carries. */
  private writeSettings() {
    const { sse, kmsKeyId, storageClass } = this.opts;
    return {
      ...(sse && sse !== 'none' ? { ServerSideEncryption: sse } : {}),
      ...(sse === 'aws:kms' && kmsKeyId ? { SSEKMSKeyId: kmsKeyId } : {}),
      ...(storageClass ? { StorageClass: storageClass as StorageClass } : {}),
    };
  }

  async *list(bucket: string, prefix?: string): AsyncIterable<ListedObject> {
    let token: string | undefined;
    do {
      const page: ListObjectsV2CommandOutput = await this.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) {
        if (o.Key) yield { key: o.Key, size: o.Size ?? 0 };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async getStream(bucket: string, key: string): Promise<StreamedObject | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) return null;
      return {
        body: res.Body as Readable,
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? 'application/octet-stream',
      };
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  async putStream(bucket: string, key: string, body: Readable, contentType: string): Promise<void> {
    const upload = new Upload({
      // `Upload` only calls `send`; the Pick keeps the stub-friendly client type.
      client: this.client as S3Client,
      partSize: STREAM_PART_BYTES,
      queueSize: 4,
      params: {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...this.writeSettings(),
      },
    });
    await upload.done();
  }

  async createMultipart(bucket: string, key: string, contentType: string): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        ...this.writeSettings(),
      }),
    );
    if (!res.UploadId) throw new Error(`no upload id for ${bucket}/${key}`);
    return res.UploadId;
  }

  async uploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Readable,
    size: number,
  ): Promise<string> {
    const res = await this.client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: size,
      }),
    );
    if (!res.ETag) throw new Error(`no etag for part ${partNumber} of ${bucket}/${key}`);
    return res.ETag;
  }

  async completeMultipart(
    bucket: string,
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipart(bucket: string, key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
    );
  }
}
