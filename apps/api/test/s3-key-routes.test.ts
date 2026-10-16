import { describe, expect, it } from 'vitest';
import { MemoryAccessRepo } from '../src/access/repo.js';
import { MemoryPublishTargetRepo, type NewTarget } from '../src/publish-targets/repo.js';
import { MemoryS3KeyIssuer } from '../src/s3keys/issuer.js';
import { MemoryS3KeyRepo } from '../src/s3keys/repo.js';
import { S3KeyService } from '../src/s3keys/service.js';
import { signIn, signInNewUser, testApp } from './helpers.js';

const MISSING = '00000000-0000-4000-8000-000000000000';

class DownIssuer extends MemoryS3KeyIssuer {
  down = false;
  override async createKey(userName: string) {
    if (this.down) throw new Error('connect ECONNREFUSED 172.18.0.3:8333');
    return super.createKey(userName);
  }
  override async deleteKey(userName: string, accessKeyId: string) {
    if (this.down) throw new Error('connect ECONNREFUSED 172.18.0.3:8333');
    return super.deleteKey(userName, accessKeyId);
  }
}

class NoTargets extends MemoryPublishTargetRepo {
  override async choices() {
    return [];
  }
}

const target = (over: Partial<NewTarget>): NewTarget => ({
  id: 'finance',
  label: 'Finance lake',
  kind: 'internal',
  bucket: 'finance-lake',
  prefix: 'out/',
  endpoint: null,
  region: null,
  accessKeyId: null,
  secretKeyEnc: null,
  accessKeyEnv: null,
  secretKeyEnv: null,
  forcePathStyle: false,
  sse: 'none',
  kmsKeyId: null,
  storageClass: null,
  ...over,
});

async function setup(targets: MemoryPublishTargetRepo = new MemoryPublishTargetRepo()) {
  const access = new MemoryAccessRepo();
  const issuer = new DownIssuer();
  await targets.create(target({}), null);
  await targets.create(
    target({
      id: 'ext',
      label: 'Partner',
      kind: 'external',
      bucket: 'partner',
      prefix: '',
      endpoint: 'https://s3.example.com',
      region: 'eu-west-2',
      accessKeyId: 'AK',
      secretKeyEnc: 'v1:x',
    }),
    null,
  );
  const s3Keys = new S3KeyService({
    repo: new MemoryS3KeyRepo(),
    issuer,
    targets,
    endpoint: 'https://lake-s3.example.com',
  });
  const { app } = await testApp({ access, s3Keys });
  const admin = await signIn(app, 'admin', await access.rotateAdminPassword());
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    cookie = admin,
  ) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  return { app, access, issuer, admin, call };
}

describe('S3 key routes (ADR 0008)', () => {
  it('issues a key once, lists it without the secret, rotates, revokes and deletes', async () => {
    const { issuer, call } = await setup();
    const created = await call('POST', '/api/access/s3-keys', {
      label: 'Semantic index',
      expiresInDays: 90,
      targets: ['default', 'finance'],
    });
    expect(created.statusCode).toBe(200);
    const issued = created.json();
    expect(issued).toMatchObject({
      consumer: { label: 'Semantic index' },
      key: { status: 'active' },
      endpoint: 'https://lake-s3.example.com',
    });
    expect(issued.consumer.targets).toEqual(['default', 'finance']);
    expect(issuer.secretOf(issued.key.accessKeyId)).toBe(issued.secretAccessKey);

    const list = await call('GET', '/api/access/s3-keys');
    expect(list.statusCode).toBe(200);
    expect(list.json().consumers).toHaveLength(1);
    expect(list.body).not.toContain(issued.secretAccessKey);

    const rotated = await call('POST', `/api/access/s3-keys/${issued.consumer.id}/rotate`, {
      expiresInDays: 365,
      graceDays: 7,
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().consumer.keys).toHaveLength(2);
    const again = await call('POST', `/api/access/s3-keys/${issued.consumer.id}/rotate`, {
      expiresInDays: 365,
      graceDays: 7,
    });
    expect(again.statusCode).toBe(409);

    const revoke = await call('POST', `/api/access/s3-keys/keys/${issued.key.id}/revoke`);
    expect(revoke.statusCode).toBe(204);
    expect(issuer.secretOf(issued.key.accessKeyId)).toBeUndefined();

    const del = await call('DELETE', `/api/access/s3-keys/${issued.consumer.id}`);
    expect(del.statusCode).toBe(204);
    expect((await call('GET', '/api/access/s3-keys')).json().consumers).toEqual([]);
  });

  it('answers 404 for unknown consumers and keys', async () => {
    const { call } = await setup();
    const body = { expiresInDays: 30, graceDays: 7 };
    expect((await call('POST', `/api/access/s3-keys/${MISSING}/rotate`, body)).statusCode).toBe(
      404,
    );
    expect((await call('POST', `/api/access/s3-keys/keys/${MISSING}/revoke`)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/access/s3-keys/${MISSING}`)).statusCode).toBe(404);
    expect((await call('DELETE', '/api/access/s3-keys/not-a-uuid')).statusCode).toBe(404);
  });

  it.each([
    { label: '', expiresInDays: 30, targets: ['default'] },
    { label: 'x', expiresInDays: 3, targets: ['default'] },
    { label: 'x', targets: ['default'] },
    { label: 'x'.repeat(101), expiresInDays: 30, targets: ['default'] },
    { label: 'x', expiresInDays: 30 },
    { label: 'x', expiresInDays: 30, targets: [] },
  ])('validates new keys: %j', async (payload) => {
    const { call } = await setup();
    expect((await call('POST', '/api/access/s3-keys', payload)).statusCode).toBe(400);
  });

  it.each([{ expiresInDays: 30 }, { expiresInDays: 30, graceDays: 2 }, { graceDays: 7 }])(
    'validates rotation: %j',
    async (payload) => {
      const { call } = await setup();
      const issued = (
        await call('POST', '/api/access/s3-keys', {
          label: 'x',
          expiresInDays: 30,
          targets: ['default'],
        })
      ).json();
      const res = await call('POST', `/api/access/s3-keys/${issued.consumer.id}/rotate`, payload);
      expect(res.statusCode).toBe(400);
    },
  );

  it('is for admins only', async () => {
    const { app, access, call } = await setup();
    const { cookie: user } = await signInNewUser(app, access, 'user');
    expect((await call('GET', '/api/access/s3-keys', undefined, user)).statusCode).toBe(403);
    const create = await call(
      'POST',
      '/api/access/s3-keys',
      { label: 'x', expiresInDays: 7, targets: ['default'] },
      user,
    );
    expect(create.statusCode).toBe(403);
  });

  it('reports an unreachable SeaweedFS as 502, and a revocation still sticks', async () => {
    const { issuer, call } = await setup();
    const issued = (
      await call('POST', '/api/access/s3-keys', {
        label: 'x',
        expiresInDays: 30,
        targets: ['default'],
      })
    ).json();
    issuer.down = true;

    const create = await call('POST', '/api/access/s3-keys', {
      label: 'y',
      expiresInDays: 30,
      targets: ['default'],
    });
    expect(create.statusCode).toBe(502);
    expect(create.json().error).toMatch(/SeaweedFS/);

    const revoke = await call('POST', `/api/access/s3-keys/keys/${issued.key.id}/revoke`);
    expect(revoke.statusCode).toBe(502);
    expect(revoke.json().error).toMatch(/revoked/i);
    const listed = (await call('GET', '/api/access/s3-keys')).json();
    expect(listed.consumers.find((c: { label: string }) => c.label === 'x').keys[0].status).toBe(
      'revoked',
    );
  });

  it('lists the internal targets, without the external one', async () => {
    const { call } = await setup();
    const list = (await call('GET', '/api/access/s3-keys')).json();
    expect(list.internalTargets.map((t: { id: string }) => t.id)).toEqual(['default', 'finance']);
    expect(list).not.toHaveProperty('bucket');
  });

  it('refuses an external target when issuing or changing grants', async () => {
    const { call } = await setup();
    const refused = await call('POST', '/api/access/s3-keys', {
      label: 'x',
      expiresInDays: 30,
      targets: ['ext'],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('ext is not an internal publishing target');
    const issued = (
      await call('POST', '/api/access/s3-keys', {
        label: 'x',
        expiresInDays: 30,
        targets: ['default'],
      })
    ).json();
    const put = await call('PUT', `/api/access/s3-keys/${issued.consumer.id}/targets`, {
      targets: ['ext'],
    });
    expect(put.statusCode).toBe(400);
  });

  it('changes the targets a consumer may read', async () => {
    const { call, issuer } = await setup();
    const issued = (
      await call('POST', '/api/access/s3-keys', {
        label: 'x',
        expiresInDays: 30,
        targets: ['default'],
      })
    ).json();
    const put = await call('PUT', `/api/access/s3-keys/${issued.consumer.id}/targets`, {
      targets: ['finance'],
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().targets).toEqual(['finance']);
    expect(issuer.user(issued.consumer.userName)!.grants).toEqual([
      { bucket: 'finance-lake', prefix: 'out/' },
    ]);
    const missing = await call('PUT', `/api/access/s3-keys/${MISSING}/targets`, {
      targets: ['finance'],
    });
    expect(missing.statusCode).toBe(404);
    const empty = await call('PUT', `/api/access/s3-keys/${issued.consumer.id}/targets`, {
      targets: [],
    });
    expect(empty.statusCode).toBe(400);
  });

  it('without an internal target: lists none and refuses to issue', async () => {
    const { call } = await setup(new NoTargets());
    expect((await call('GET', '/api/access/s3-keys')).json().internalTargets).toEqual([]);
    const res = await call('POST', '/api/access/s3-keys', {
      label: 'x',
      expiresInDays: 30,
      targets: ['default'],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('add an internal publishing target first');
  });

  it('says so when the API was built without the key service', async () => {
    const access = new MemoryAccessRepo();
    const { app } = await testApp({ access, s3Keys: null });
    const admin = await signIn(app, 'admin', await access.rotateAdminPassword());
    const res = await app.inject({ url: '/api/access/s3-keys', headers: { cookie: admin } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('S3 keys are not available on this deployment');
  });
});
