/**
 * Publishing targets against a real S3 server outside the stack: a throwaway SeaweedFS from
 * `deploy/scripts/external-s3.sh up` (or `.ps1`), its IH_TEST_EXTERNAL_S3_* variables exported
 * (`external-s3 env`). Skips without them. Also checks that a data-lake key granted on a target
 * with a prefix reads only under it (SeaweedFS embedded IAM: the container runs with
 * `-s3.iam.readOnly=false`, like compose).
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { normalisePrefix } from '@ih/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { encryptSecret, type SecretsKeys } from '../../src/llm/secrets.js';
import { probeTarget } from '../../src/publish-targets/probe.js';
import { MemoryPublishTargetRepo, type NewTarget } from '../../src/publish-targets/repo.js';
import { TargetStores } from '../../src/publish-targets/stores.js';
import { SeaweedIamIssuer } from '../../src/s3keys/seaweed-iam.js';
import { s3ClientConfig, type S3Options } from '../../src/storage/s3.js';

const endpoint = process.env.IH_TEST_EXTERNAL_S3_ENDPOINT;
const ext = {
  endpoint: endpoint ?? '',
  region: process.env.IH_TEST_EXTERNAL_S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.IH_TEST_EXTERNAL_S3_ACCESS_KEY ?? '',
  secretAccessKey: process.env.IH_TEST_EXTERNAL_S3_SECRET_KEY ?? '',
  bucket: process.env.IH_TEST_EXTERNAL_S3_BUCKET ?? 'ext-published',
};
const keys: SecretsKeys = { current: Buffer.alloc(32, 7), previous: null };
/** The internal store must never be used by these external targets: it points nowhere. */
const internal: S3Options = {
  endpoint: 'http://127.0.0.1:9',
  region: 'us-east-1',
  accessKeyId: 'unused',
  secretAccessKey: 'unused',
};
const run = randomUUID().slice(0, 8);

function target(over: Partial<NewTarget> = {}): NewTarget {
  return {
    id: 'ext-lake',
    label: 'External lake',
    kind: 'external',
    bucket: ext.bucket,
    prefix: '',
    endpoint: ext.endpoint,
    region: ext.region,
    accessKeyId: ext.accessKeyId,
    secretKeyEnc: encryptSecret(ext.secretAccessKey, keys),
    accessKeyEnv: null,
    secretKeyEnv: null,
    forcePathStyle: true,
    sse: 'none',
    kmsKeyId: null,
    storageClass: null,
    ...over,
  };
}

async function setup(over: Partial<NewTarget> = {}) {
  const repo = new MemoryPublishTargetRepo();
  const created = await repo.create(target(over), 'it');
  if (created === 'exists') throw new Error('target exists');
  const stores = new TargetStores({ repo, internal, secrets: keys, env: {} });
  return { repo, stores };
}

/** The server's own view, signed with its admin identity. */
const admin = new S3Client(s3ClientConfig({ ...ext, forcePathStyle: true }));
const adminKeys = (prefix: string) =>
  admin
    .send(new ListObjectsV2Command({ Bucket: ext.bucket, Prefix: prefix }))
    .then((r) => (r.Contents ?? []).map((o) => o.Key));

/** IAM changes reach the gateway within moments; poll instead of sleeping blindly. */
async function eventually(check: () => Promise<void>, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

const status = (call: Promise<unknown>) =>
  call.then(
    () => 200,
    (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode,
  );

/** Past TargetStores' one-second version check. */
const pastVersionCheck = () => new Promise((r) => setTimeout(r, 1_100));

describe.skipIf(!endpoint)('external publishing target on a real S3 server', () => {
  it('passes Test connection with the right keys', async () => {
    const { stores } = await setup();
    const { store, target: t } = await stores.storeFor('ext-lake');
    expect(await probeTarget(store, t.bucket, t.prefix)).toEqual({
      ok: true,
      step: null,
      message: 'Connected: wrote, read and deleted a test file',
    });
  });

  it('says access denied for a wrong secret, and never echoes it', async () => {
    const { stores } = await setup({ secretKeyEnc: encryptSecret('not-the-secret', keys) });
    const { store, target: t } = await stores.storeFor('ext-lake');
    const result = await probeTarget(store, t.bucket, t.prefix);
    expect(result.ok).toBe(false);
    expect(['connect', 'write']).toContain(result.step);
    expect(result.message).toBe('access denied');
    expect(JSON.stringify(result)).not.toContain('not-the-secret');
  });

  // SeaweedFS creates a missing bucket on the first put, so Test connection checks it first.
  it('says no such bucket for a bucket the server does not have, and creates none', async () => {
    const { stores } = await setup({ bucket: 'no-such-bucket-xyz' });
    const { store, target: t } = await stores.storeFor('ext-lake');
    expect(await probeTarget(store, t.bucket, t.prefix)).toEqual({
      ok: false,
      step: 'connect',
      message: 'no such bucket',
    });
    expect(await status(admin.send(new HeadBucketCommand({ Bucket: 'no-such-bucket-xyz' })))).toBe(
      404,
    );
  });

  it('puts with a storage class and reads the bytes back', async () => {
    const { stores } = await setup({ storageClass: 'STANDARD' });
    const { store, target: t } = await stores.storeFor('ext-lake');
    const key = `it-${run}/class.json`;
    const body = Buffer.from(`{"run":"${run}"}`);
    await store.put(t.bucket, key, body, 'application/json');
    expect(await store.get(t.bucket, key)).toEqual(body);
    await store.delete(t.bucket, key);
    expect(await store.get(t.bucket, key)).toBeNull();
  });

  it('lands a key under the prefix at <prefix><key>', async () => {
    const { stores } = await setup({ prefix: normalisePrefix('ingest') });
    const { store, target: t } = await stores.storeFor('ext-lake');
    expect(t.prefix).toBe('ingest/');
    const key = `it-${run}/doc.csv`;
    await store.put(t.bucket, `${t.prefix}${key}`, Buffer.from('a,b\n'), 'text/csv');
    expect(await adminKeys(`ingest/it-${run}/`)).toEqual([`ingest/${key}`]);
    expect(await adminKeys(`it-${run}/`)).toEqual([]);
    // Test connection writes its check file under the prefix too, and removes it.
    expect((await probeTarget(store, t.bucket, t.prefix)).ok).toBe(true);
    expect(await adminKeys('ingest/.ct-studio-check-')).toEqual([]);
    await store.delete(t.bucket, `${t.prefix}${key}`);
  });

  it('takes a rotated secret without a new TargetStores', async () => {
    const { repo, stores } = await setup();
    const key = `it-${run}/rotate.json`;
    await admin.send(new PutObjectCommand({ Bucket: ext.bucket, Key: key, Body: 'rotated' }));
    const read = async () => {
      const { store, target: t } = await stores.storeFor('ext-lake');
      return store.get(t.bucket, key);
    };
    expect((await read())?.toString()).toBe('rotated');

    await repo.update('ext-lake', { secretKeyEnc: encryptSecret('revoked', keys) }, 'it');
    await pastVersionCheck();
    await expect(read()).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });

    await repo.update('ext-lake', { secretKeyEnc: encryptSecret(ext.secretAccessKey, keys) }, 'it');
    await pastVersionCheck();
    expect((await read())?.toString()).toBe('rotated');
    await admin.send(new DeleteObjectCommand({ Bucket: ext.bucket, Key: key }));
  });

  describe('a data-lake key granted on a target with a prefix', () => {
    const issuer = new SeaweedIamIssuer({ ...ext });
    const user = `lake-it-${run}`;

    afterAll(async () => {
      await issuer.deleteUser(user);
    });

    it('reads and lists under the prefix and is refused outside it', async () => {
      const inside = `ingest/it-${run}/in.json`;
      const outside = `other/it-${run}/out.json`;
      for (const Key of [inside, outside]) {
        await admin.send(new PutObjectCommand({ Bucket: ext.bucket, Key, Body: Key }));
      }
      await issuer.createUser(user, [{ bucket: ext.bucket, prefix: 'ingest/' }]);
      const secret = await issuer.createKey(user);
      const lake = new S3Client(s3ClientConfig({ ...ext, ...secret }));

      await eventually(async () => {
        const got = await lake.send(new GetObjectCommand({ Bucket: ext.bucket, Key: inside }));
        expect(await got.Body!.transformToString()).toBe(inside);
      });
      const listed = await lake.send(
        new ListObjectsV2Command({ Bucket: ext.bucket, Prefix: `ingest/it-${run}/` }),
      );
      expect(listed.Contents?.map((o) => o.Key)).toEqual([inside]);

      expect(
        await status(lake.send(new GetObjectCommand({ Bucket: ext.bucket, Key: outside }))),
      ).toBe(403);
      expect(
        await status(
          lake.send(new ListObjectsV2Command({ Bucket: ext.bucket, Prefix: `other/it-${run}/` })),
        ),
      ).toBe(403);
      expect(await status(lake.send(new ListObjectsV2Command({ Bucket: ext.bucket })))).toBe(403);
      expect(
        await status(
          lake.send(
            new PutObjectCommand({ Bucket: ext.bucket, Key: `ingest/x-${run}`, Body: 'x' }),
          ),
        ),
      ).toBe(403);

      for (const Key of [inside, outside]) {
        await admin.send(new DeleteObjectCommand({ Bucket: ext.bucket, Key }));
      }
    });
  });
});
