/**
 * ADR 0008 against real infrastructure: PgS3KeyRepo on Postgres and SeaweedIamIssuer on a
 * SeaweedFS S3 gateway started with `-s3.iam.readOnly=false`. Run with
 * `npm run test:integration` after `deploy/scripts/dev-infra.sh up`, with DATABASE_URL,
 * S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY exported (the admin identity).
 */
import { CreateUserCommand, IAMClient } from '@aws-sdk/client-iam';
import {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.js';
import { USER_PREFIX } from '../../src/s3keys/issuer.js';
import { PgPublishTargetRepo } from '../../src/publish-targets/pg.js';
import { PgS3KeyRepo } from '../../src/s3keys/pg.js';
import { iamClientConfig, SeaweedIamIssuer } from '../../src/s3keys/seaweed-iam.js';
import { S3KeyService } from '../../src/s3keys/service.js';
import { s3ClientConfig } from '../../src/storage/s3.js';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for integration tests`);
  return value;
};

const BUCKET = 'ingest-published-it';
const OTHER = 'ingest-runs-it';
const admin = {
  endpoint: env('S3_ENDPOINT'),
  region: 'us-east-1',
  accessKeyId: env('S3_ACCESS_KEY'),
  secretAccessKey: env('S3_SECRET_KEY'),
};
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

/** The data lake's view: only the URL, the bucket and its key pair (default region). */
const lake = (accessKeyId: string, secretAccessKey: string) =>
  new S3Client(s3ClientConfig({ ...admin, accessKeyId, secretAccessKey }));

/** Gateways pick up identity changes within moments; poll instead of sleeping blindly. */
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

const denied = async (call: Promise<unknown>) => {
  const err = await call.then(
    () => null,
    (e: unknown) => e as { $metadata?: { httpStatusCode?: number } },
  );
  expect(err, 'the call should have been denied').not.toBeNull();
  expect([401, 403]).toContain(err!.$metadata?.httpStatusCode);
};

let pool: pg.Pool;
let service: S3KeyService;
let issuer: SeaweedIamIssuer;
const issue = async (label: string, days: number | null) => {
  const r = await service.issue(label, days, ['default']);
  if ('problem' in r) throw new Error(r.problem);
  return r;
};

beforeAll(async () => {
  await migrate(env('DATABASE_URL'), migrations);
  pool = new pg.Pool({ connectionString: env('DATABASE_URL'), max: 2 });
  await pool.query('DELETE FROM s3_consumers');
  issuer = new SeaweedIamIssuer(admin);
  for (const u of await issuer.listUsers(USER_PREFIX)) await issuer.deleteUser(u.userName);
  const s3 = new S3Client(s3ClientConfig(admin));
  for (const bucket of [BUCKET, OTHER]) {
    await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch(() => undefined);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'a/b.json', Body: '{"ok":true}' }));
  }
  const targets = new PgPublishTargetRepo(pool);
  await targets.update('default', { bucket: BUCKET, prefix: '' }, null);
  service = new S3KeyService({ repo: new PgS3KeyRepo(pool), issuer, targets, endpoint: null });
});

afterAll(async () => {
  for (const u of (await issuer?.listUsers(USER_PREFIX)) ?? []) await issuer.deleteUser(u.userName);
  await pool?.query('DELETE FROM s3_consumers');
  await pool?.end();
});

describe('S3 read keys on SeaweedFS + Postgres', () => {
  it('issues a key that can list and read the publish bucket and nothing else', async () => {
    const issued = await issue('Integration lake', 1);
    const client = lake(issued.key.accessKeyId, issued.secretAccessKey);

    await eventually(async () => {
      const list = await client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
      expect(list.Contents?.map((o) => o.Key)).toContain('a/b.json');
    });
    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'a/b.json' }));
    expect(await got.Body!.transformToString()).toBe('{"ok":true}');

    await denied(client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'x', Body: 'x' })));
    await denied(client.send(new ListObjectsV2Command({ Bucket: OTHER })));
    await denied(client.send(new GetObjectCommand({ Bucket: OTHER, Key: 'a/b.json' })));
    const iam = new IAMClient(
      iamClientConfig({
        ...admin,
        accessKeyId: issued.key.accessKeyId,
        secretAccessKey: issued.secretAccessKey,
      }),
    );
    await denied(iam.send(new CreateUserCommand({ UserName: `${USER_PREFIX}escalate` })));

    expect(await service.revoke(issued.key.id)).toBe('ok');
    await eventually(() => denied(client.send(new ListObjectsV2Command({ Bucket: BUCKET }))));
  });

  it('rotates: both keys work, then reconcile removes the old one once its grace ends', async () => {
    const issued = await issue('Rotating lake', null);
    const rotated = await service.rotate(issued.consumer.id, 30, 1);
    if (typeof rotated === 'string') throw new Error(rotated);
    const oldClient = lake(issued.key.accessKeyId, issued.secretAccessKey);
    const newClient = lake(rotated.key.accessKeyId, rotated.secretAccessKey);
    await eventually(async () => {
      await oldClient.send(new ListObjectsV2Command({ Bucket: BUCKET }));
      await newClient.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    });

    // Fast-forward the grace period in the database rather than waiting a day.
    await pool.query(
      `UPDATE s3_access_keys SET expires_at = now() - interval '1 second'
                       WHERE id = $1`,
      [issued.key.id],
    );
    expect(await service.reconcile()).toEqual({ deletedKeys: 1, deletedUsers: 0 });
    await eventually(() => denied(oldClient.send(new ListObjectsV2Command({ Bucket: BUCKET }))));
    await newClient.send(new ListObjectsV2Command({ Bucket: BUCKET }));

    const listed = (await service.list()).consumers.find((c) => c.id === issued.consumer.id)!;
    expect(listed.keys.map((k) => k.status)).toEqual(['active', 'expired']);
  });

  it('removes orphaned lake users and deletes consumers with their users', async () => {
    await issuer.createUser(`${USER_PREFIX}orphan`, [{ bucket: BUCKET, prefix: '' }]);
    await issuer.createKey(`${USER_PREFIX}orphan`);
    const before = await service.reconcile();
    expect(before.deletedUsers).toBe(1);
    const names = (await issuer.listUsers(USER_PREFIX)).map((u) => u.userName);
    expect(names).not.toContain(`${USER_PREFIX}orphan`);

    const issued = await issue('Short-lived', 1);
    expect(await service.remove(issued.consumer.id)).toBe('ok');
    const after = (await issuer.listUsers(USER_PREFIX)).map((u) => u.userName);
    expect(after).not.toContain(issued.consumer.userName);
    expect((await service.list()).consumers.map((c) => c.id)).not.toContain(issued.consumer.id);
  });
});
