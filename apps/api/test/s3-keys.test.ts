import { describe, expect, it } from 'vitest';
import { MemoryS3KeyIssuer, READ_ONLY_ACTIONS } from '../src/s3keys/issuer.js';
import { MemoryPublishTargetRepo, type NewTarget } from '../src/publish-targets/repo.js';
import { MemoryS3KeyRepo } from '../src/s3keys/repo.js';
import { S3KeyService } from '../src/s3keys/service.js';

const DAY = 86_400_000;

/** Fails the named issuer calls (SeaweedFS unreachable) until `heal()`. */
class FlakyIssuer extends MemoryS3KeyIssuer {
  failing = new Set<string>();
  heal() {
    this.failing.clear();
  }
  private check(op: string) {
    if (this.failing.has(op)) throw new Error(`${op}: connect ECONNREFUSED`);
  }
  override async createKey(userName: string) {
    this.check('createKey');
    return super.createKey(userName);
  }
  override async deleteKey(userName: string, accessKeyId: string) {
    this.check('deleteKey');
    return super.deleteKey(userName, accessKeyId);
  }
}

const newTarget = (over: Partial<NewTarget>): NewTarget => ({
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

async function setup() {
  let now = Date.parse('2026-10-12T00:00:00Z');
  const clock = () => now;
  const issuer = new FlakyIssuer();
  const repo = new MemoryS3KeyRepo(clock);
  const targets = new MemoryPublishTargetRepo({
    publishedDefinitions: async () => [],
    deliveredCount: async () => 0,
    consumerCount: async (id) => repo.grantCount(id),
  });
  await targets.create(newTarget({}), null);
  await targets.create(
    newTarget({
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
  const service = new S3KeyService({
    repo,
    issuer,
    targets,
    endpoint: 'https://lake-s3.example.com',
  });
  const issue = async (label: string, days: number | null, ids = ['default']) => {
    const r = await service.issue(label, days, ids);
    if ('problem' in r) throw new Error(r.problem);
    return r;
  };
  return { issuer, repo, service, targets, issue, advance: (ms: number) => (now += ms) };
}

describe('S3 read keys (ADR 0008)', () => {
  it('issues a read-only SeaweedFS user and a key whose secret is returned once', async () => {
    const { issuer, service, issue } = await setup();
    const issued = await issue('Semantic index', 90);

    expect(issued.secretAccessKey.length).toBeGreaterThanOrEqual(32);
    const user = issuer.user(issued.consumer.userName)!;
    expect(issued.consumer.userName).toBe(`lake-${issued.consumer.id}`);
    expect(user.grants).toEqual([{ bucket: 'ingest-published', prefix: '' }]);
    expect(user.actions).toEqual(READ_ONLY_ACTIONS);
    expect(issuer.secretOf(issued.key.accessKeyId)).toBe(issued.secretAccessKey);

    const listed = await service.list();
    expect(listed).toMatchObject({ endpoint: 'https://lake-s3.example.com' });
    expect(listed.internalTargets.map((t) => t.id)).toEqual(['default', 'finance']);
    expect(listed.consumers).toHaveLength(1);
    expect(listed.consumers[0]).toMatchObject({
      label: 'Semantic index',
      targets: ['default'],
      keys: [{ accessKeyId: issued.key.accessKeyId, status: 'active' }],
    });
    expect(JSON.stringify(listed)).not.toContain(issued.secretAccessKey);
    expect(listed.consumers[0]!.keys[0]!.expiresAt).toBe('2027-01-10T00:00:00.000Z');
  });

  it('rotates with overlap: the old key works until the grace period ends', async () => {
    const { issuer, service, advance, issue } = await setup();
    const first = await issue('Semantic index', null);
    const rotated = await service.rotate(first.consumer.id, 365, 7);
    if (typeof rotated === 'string') throw new Error(rotated);

    expect(rotated.key.accessKeyId).not.toBe(first.key.accessKeyId);
    expect(issuer.secretOf(first.key.accessKeyId)).toBeDefined();
    expect(issuer.secretOf(rotated.key.accessKeyId)).toBe(rotated.secretAccessKey);
    const keys = (await service.list()).consumers[0]!.keys;
    const old = keys.find((k) => k.accessKeyId === first.key.accessKeyId)!;
    expect(old.expiresAt).toBe('2026-10-19T00:00:00.000Z');

    advance(7 * DAY + 1);
    await service.reconcile();
    expect(issuer.secretOf(first.key.accessKeyId)).toBeUndefined();
    expect(issuer.secretOf(rotated.key.accessKeyId)).toBeDefined();
  });

  it('never extends an old key that already expires before the grace period ends', async () => {
    const { service, issue } = await setup();
    const first = await issue('Semantic index', 1);
    await service.rotate(first.consumer.id, 30, 7);
    const old = (await service.list()).consumers[0]!.keys.find(
      (k) => k.accessKeyId === first.key.accessKeyId,
    )!;
    expect(old.expiresAt).toBe('2026-10-13T00:00:00.000Z');
  });

  it('allows at most two active keys per consumer', async () => {
    const { service, issue } = await setup();
    const first = await issue('Semantic index', 30);
    expect(typeof (await service.rotate(first.consumer.id, 30, 7))).toBe('object');
    expect(await service.rotate(first.consumer.id, 30, 7)).toBe('limit');
    expect(await service.rotate('00000000-0000-4000-8000-000000000000', 30, 7)).toBe('not_found');
  });

  it('revokes a key in SeaweedFS immediately', async () => {
    const { issuer, service, issue } = await setup();
    const issued = await issue('Semantic index', 30);
    expect(await service.revoke(issued.key.id)).toBe('ok');
    expect(issuer.secretOf(issued.key.accessKeyId)).toBeUndefined();
    expect((await service.list()).consumers[0]!.keys[0]).toMatchObject({ status: 'revoked' });
    expect(await service.revoke('00000000-0000-4000-8000-000000000000')).toBe('not_found');
  });

  it('keeps a revocation when SeaweedFS is unreachable and finishes it on reconcile', async () => {
    const { issuer, service, issue } = await setup();
    const issued = await issue('Semantic index', 30);
    issuer.failing.add('deleteKey');
    await expect(service.revoke(issued.key.id)).rejects.toThrow(/ECONNREFUSED/);
    expect((await service.list()).consumers[0]!.keys[0]).toMatchObject({ status: 'revoked' });
    expect(issuer.secretOf(issued.key.accessKeyId)).toBeDefined();

    issuer.heal();
    expect(await service.reconcile()).toEqual({ deletedKeys: 1, deletedUsers: 0 });
    expect(issuer.secretOf(issued.key.accessKeyId)).toBeUndefined();
  });

  it('deletes expired keys on reconcile and keeps keys that never expire', async () => {
    const { issuer, service, advance, issue } = await setup();
    const short = await issue('Short', 1);
    const forever = await issue('Forever', null);
    advance(DAY + 1);
    expect(
      (await service.list()).consumers.find((c) => c.label === 'Short')!.keys[0],
    ).toMatchObject({ status: 'expired' });
    expect(await service.reconcile()).toEqual({ deletedKeys: 1, deletedUsers: 0 });
    expect(issuer.secretOf(short.key.accessKeyId)).toBeUndefined();
    expect(issuer.secretOf(forever.key.accessKeyId)).toBeDefined();
    expect(await service.reconcile()).toEqual({ deletedKeys: 0, deletedUsers: 0 });
  });

  it('removes lake-* users and keys it has no record of, and nothing else', async () => {
    const { issuer, service, issue } = await setup();
    const kept = await issue('Semantic index', 30);
    await issuer.createUser('lake-orphan', []);
    await issuer.createKey('lake-orphan');
    const stray = await issuer.createKey(kept.consumer.userName);
    await issuer.createUser('someone-else', []);

    expect(await service.reconcile()).toEqual({ deletedKeys: 1, deletedUsers: 1 });
    expect(issuer.user('lake-orphan')).toBeUndefined();
    expect(issuer.secretOf(stray.accessKeyId)).toBeUndefined();
    expect(issuer.secretOf(kept.key.accessKeyId)).toBeDefined();
    expect(issuer.user('someone-else')).toBeDefined();
  });

  it('leaves nothing behind when issuing fails halfway', async () => {
    const { issuer, service, issue } = await setup();
    issuer.failing.add('createKey');
    await expect(issue('Semantic index', 30)).rejects.toThrow(/ECONNREFUSED/);
    expect((await service.list()).consumers).toEqual([]);
    expect(issuer.userNames()).toEqual([]);
  });

  it('never lets a reconcile run delete a key that is being issued', async () => {
    const { issuer, service, issue } = await setup();
    const [issued] = await Promise.all([
      issue('Semantic index', 30),
      service.reconcile(),
      service.reconcile(),
    ]);
    expect(issuer.secretOf(issued.key.accessKeyId)).toBe(issued.secretAccessKey);
  });

  it('deletes a consumer: its keys and SeaweedFS user go too', async () => {
    const { issuer, service, issue } = await setup();
    const issued = await issue('Semantic index', 30);
    await service.rotate(issued.consumer.id, 30, 7);
    expect(await service.remove(issued.consumer.id)).toBe('ok');
    expect(issuer.user(issued.consumer.userName)).toBeUndefined();
    expect((await service.list()).consumers).toEqual([]);
    expect(await service.remove(issued.consumer.id)).toBe('not_found');
  });
});

describe('grants per publishing target', () => {
  it('issues over two targets: the policy covers both buckets and prefixes', async () => {
    const { issuer, issue } = await setup();
    const issued = await issue('Lake', 30, ['finance', 'default']);
    expect(issued.consumer.targets).toEqual(['default', 'finance']);
    expect(issuer.user(issued.consumer.userName)!.grants).toEqual([
      { bucket: 'ingest-published', prefix: '' },
      { bucket: 'finance-lake', prefix: 'out/' },
    ]);
  });

  it('changing the grants rewrites the policy and the consumer view', async () => {
    const { issuer, service, issue } = await setup();
    const issued = await issue('Lake', 30);
    expect(await service.setTargets(issued.consumer.id, ['finance'])).toBe('ok');
    expect(issuer.user(issued.consumer.userName)!.grants).toEqual([
      { bucket: 'finance-lake', prefix: 'out/' },
    ]);
    expect((await service.list()).consumers[0]!.targets).toEqual(['finance']);
    expect(await service.setTargets('00000000-0000-4000-8000-000000000000', ['finance'])).toBe(
      'not_found',
    );
  });

  it('counts a grant as the target being in use', async () => {
    const { targets, issue } = await setup();
    await issue('Lake', 30, ['finance']);
    expect(await targets.remove('finance')).toBe('in_use');
  });

  it('refuses an external or unknown target, and an empty list, changing nothing', async () => {
    const { issuer, service, issue } = await setup();
    const issued = await issue('Lake', 30);
    expect(await service.issue('X', 30, ['ext'])).toEqual({
      problem: 'ext is not an internal publishing target',
      status: 400,
    });
    expect(await service.issue('X', 30, ['nope'])).toMatchObject({ status: 400 });
    expect(await service.issue('X', 30, [])).toEqual({
      problem: 'grant at least one publishing target',
      status: 400,
    });
    expect(await service.setTargets(issued.consumer.id, ['ext'])).toEqual({
      problem: 'ext is not an internal publishing target',
      status: 400,
    });
    expect(issuer.userNames()).toEqual([issued.consumer.userName]);
    expect((await service.list()).consumers[0]!.targets).toEqual(['default']);
  });

  it('reconcile restores a policy changed behind its back', async () => {
    const { issuer, service, issue } = await setup();
    const issued = await issue('Lake', 30, ['finance']);
    await issuer.setGrants(issued.consumer.userName, [{ bucket: 'elsewhere', prefix: '' }]);
    await service.reconcile();
    expect(issuer.user(issued.consumer.userName)!.grants).toEqual([
      { bucket: 'finance-lake', prefix: 'out/' },
    ]);
  });
});
