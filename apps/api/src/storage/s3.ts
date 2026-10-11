import {
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
} from '@aws-sdk/client-s3';
import type { ObjectStore } from './object-store.js';

export interface S3Options {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Client settings. Timeouts make an unresponsive endpoint (e.g. a firewalled publish target)
 * fail fast into the 404/502 paths instead of hanging requests.
 */
export function s3ClientConfig(opts: S3Options): S3ClientConfig {
  return {
    endpoint: opts.endpoint,
    region: opts.region,
    forcePathStyle: true,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
  };
}

/** S3-compatible store. SeaweedFS requires path-style addressing. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: Pick<S3Client, 'send'>;

  /** `client` is for tests (a stub `send`); production builds one from `opts`. */
  constructor(opts: S3Options, client?: Pick<S3Client, 'send'>) {
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
    await this.client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
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
}
