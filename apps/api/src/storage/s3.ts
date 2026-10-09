import {
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStore } from './object-store.js';

export interface S3Options {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** S3-compatible store. SeaweedFS requires path-style addressing. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(opts: S3Options) {
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      forcePathStyle: true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
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
