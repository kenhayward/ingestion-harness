/**
 * The streaming and multipart ObjectStore methods against a real SeaweedFS S3 gateway. Run with
 * `npm run test:integration -- s3-stream` after `deploy/scripts/dev-infra.sh up`, with
 * S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY exported. Skips without them.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore } from '../../src/storage/s3.js';

const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY } = process.env;
const configured = Boolean(S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY);

async function drain(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe.skipIf(!configured)('S3ObjectStore streaming (SeaweedFS)', () => {
  const bucket = `stream-test-${randomUUID().slice(0, 8)}`;
  let store: S3ObjectStore;

  beforeAll(async () => {
    store = new S3ObjectStore({
      endpoint: S3_ENDPOINT!,
      region: process.env.S3_REGION ?? 'us-east-1',
      accessKeyId: S3_ACCESS_KEY!,
      secretAccessKey: S3_SECRET_KEY!,
    });
    await store.ensureBucket(bucket);
  });

  it('list pages through 2,500 keys under a prefix', async () => {
    for (let i = 0; i < 2500; i += 50) {
      await Promise.all(
        Array.from({ length: 50 }, (_, j) =>
          store.put(
            bucket,
            `many/${String(i + j).padStart(4, '0')}`,
            Buffer.alloc(3),
            'text/plain',
          ),
        ),
      );
    }
    await store.put(bucket, 'zzz-other', Buffer.from('x'), 'text/plain');
    const listed: { key: string; size: number }[] = [];
    for await (const o of store.list(bucket, 'many/')) listed.push(o);
    expect(listed).toHaveLength(2500);
    expect(listed[0]).toEqual({ key: 'many/0000', size: 3 });
    expect(listed.at(-1)?.key).toBe('many/2499');
    await store.deletePrefix(bucket, 'many/');
  }, 120_000);

  it('getStream returns null for a missing key', async () => {
    expect(await store.getStream(bucket, 'no-such-key')).toBeNull();
  });

  it('putStream stores the streamed bytes and content type (40 MiB)', async () => {
    const data = randomBytes(40 * 1024 * 1024);
    const pieces: Buffer[] = [];
    for (let at = 0; at < data.length; at += 1024 * 1024)
      pieces.push(data.subarray(at, at + 1024 * 1024));
    await store.putStream(bucket, 'big/stream.bin', Readable.from(pieces), 'application/x-test');
    const got = await store.getStream(bucket, 'big/stream.bin');
    expect(got?.size).toBe(data.length);
    expect(got?.contentType).toBe('application/x-test');
    expect((await drain(got!.body)).equals(data)).toBe(true);
  }, 120_000);

  it('multipart parts complete in part order whatever the upload order', async () => {
    const part1 = randomBytes(5 * 1024 * 1024);
    const part2 = Buffer.from('tail');
    const id = await store.createMultipart(bucket, 'multi/obj.bin', 'application/x-multi');
    const e2 = await store.uploadPart(
      bucket,
      'multi/obj.bin',
      id,
      2,
      Readable.from([part2]),
      part2.length,
    );
    const e1 = await store.uploadPart(
      bucket,
      'multi/obj.bin',
      id,
      1,
      Readable.from([part1]),
      part1.length,
    );
    await store.completeMultipart(bucket, 'multi/obj.bin', id, [
      { partNumber: 2, etag: e2 },
      { partNumber: 1, etag: e1 },
    ]);
    const got = await store.getStream(bucket, 'multi/obj.bin');
    expect(got?.contentType).toBe('application/x-multi');
    expect((await drain(got!.body)).equals(Buffer.concat([part1, part2]))).toBe(true);

    const aborted = await store.createMultipart(bucket, 'multi/aborted.bin', 'application/x-multi');
    await store.abortMultipart(bucket, 'multi/aborted.bin', aborted);
    expect(await store.getStream(bucket, 'multi/aborted.bin')).toBeNull();
  }, 120_000);
});
