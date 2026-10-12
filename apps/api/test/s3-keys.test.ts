import { describe, expect, it } from 'vitest';
import { MemoryS3KeyIssuer, READ_ONLY_ACTIONS } from '../src/s3keys/issuer.js';
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

function setup() {
  let now = Date.parse('2026-10-12T00:00:00Z');
  const clock = () => now;
  const issuer = new FlakyIssuer();
  const repo = new MemoryS3KeyRepo(clock);
  const service = new S3KeyService({
    repo,
    issuer,
    bucket: 'ingest-published',
    endpoint: 'https://lake-s3.example.com',
  });
  return { issuer, repo, service, advance: (ms: number) => (now += ms) };
}

describe('S3 read keys (ADR 0008)', () => {
  it('issues a read-only SeaweedFS user and a key whose secret is returned once', async () => {
    const { issuer, service } = setup();
    const issued = await service.issue('Semantic index', 90);

    expect(issued.secretAccessKey.length).toBeGreaterThanOrEqual(32);
    const user = issuer.user(issued.consumer.userName)!;
    expect(issued.consumer.userName).toBe(`lake-${issued.consumer.id}`);
    expect(user.bucket).toBe('ingest-published');
    expect(user.actions).toEqual(READ_ONLY_ACTIONS);
    expect(issuer.secretOf(issued.key.accessKeyId)).toBe(issued.secretAccessKey);

    const listed = await service.list();
    expect(listed).toMatchObject({
      bucket: 'ingest-published',
      endpoint: 'https://lake-s3.example.com',
    });
    expect(listed.consumers).toHaveLength(1);
    expect(listed.consumers[0]).toMatchObject({
      label: 'Semantic index',
      keys: [{ accessKeyId: issued.key.accessKeyId, status: 'active' }],
    });
    expect(JSON.stringify(listed)).not.toContain(issued.secretAccessKey);
    expect(listed.consumers[0]!.keys[0]!.expiresAt).toBe('2027-01-10T00:00:00.000Z');
  });

  it('rotates with overlap: the old key works until the grace period ends', async () => {
    const { issuer, service, advance } = setup();
    const first = await service.issue('Semantic index', null);
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
    const { service } = setup();
    const first = await service.issue('Semantic index', 1);
    await service.rotate(first.consumer.id, 30, 7);
    const old = (await service.list()).consumers[0]!.keys.find(
      (k) => k.accessKeyId === first.key.accessKeyId,
    )!;
    expect(old.expiresAt).toBe('2026-10-13T00:00:00.000Z');
  });

  it('allows at most two active keys per consumer', async () => {
    const { service } = setup();
    const first = await service.issue('Semantic index', 30);
    expect(typeof (await service.rotate(first.consumer.id, 30, 7))).toBe('object');
    expect(await service.rotate(first.consumer.id, 30, 7)).toBe('limit');
    expect(await service.rotate('00000000-0000-4000-8000-000000000000', 30, 7)).toBe('not_found');
  });

  it('revokes a key in SeaweedFS immediately', async () => {
    const { issuer, service } = setup();
    const issued = await service.issue('Semantic index', 30);
    expect(await service.revoke(issued.key.id)).toBe('ok');
    expect(issuer.secretOf(issued.key.accessKeyId)).toBeUndefined();
    expect((await service.list()).consumers[0]!.keys[0]).toMatchObject({ status: 'revoked' });
    expect(await service.revoke('00000000-0000-4000-8000-000000000000')).toBe('not_found');
  });

  it('keeps a revocation when SeaweedFS is unreachable and finishes it on reconcile', async () => {
    const { issuer, service } = setup();
    const issued = await service.issue('Semantic index', 30);
    issuer.failing.add('deleteKey');
    await expect(service.revoke(issued.key.id)).rejects.toThrow(/ECONNREFUSED/);
    expect((await service.list()).consumers[0]!.keys[0]).toMatchObject({ status: 'revoked' });
    expect(issuer.secretOf(issued.key.accessKeyId)).toBeDefined();

    issuer.heal();
    expect(await service.reconcile()).toEqual({ deletedKeys: 1, deletedUsers: 0 });
    expect(issuer.secretOf(issued.key.accessKeyId)).toBeUndefined();
  });

  it('deletes expired keys on reconcile and keeps keys that never expire', async () => {
    const { issuer, service, advance } = setup();
    const short = await service.issue('Short', 1);
    const forever = await service.issue('Forever', null);
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
    const { issuer, service } = setup();
    const kept = await service.issue('Semantic index', 30);
    await issuer.createUser('lake-orphan', 'ingest-published');
    await issuer.createKey('lake-orphan');
    const stray = await issuer.createKey(kept.consumer.userName);
    await issuer.createUser('someone-else', 'ingest-published');

    expect(await service.reconcile()).toEqual({ deletedKeys: 1, deletedUsers: 1 });
    expect(issuer.user('lake-orphan')).toBeUndefined();
    expect(issuer.secretOf(stray.accessKeyId)).toBeUndefined();
    expect(issuer.secretOf(kept.key.accessKeyId)).toBeDefined();
    expect(issuer.user('someone-else')).toBeDefined();
  });

  it('leaves nothing behind when issuing fails halfway', async () => {
    const { issuer, service } = setup();
    issuer.failing.add('createKey');
    await expect(service.issue('Semantic index', 30)).rejects.toThrow(/ECONNREFUSED/);
    expect((await service.list()).consumers).toEqual([]);
    expect(issuer.userNames()).toEqual([]);
  });

  it('never lets a reconcile run delete a key that is being issued', async () => {
    const { issuer, service } = setup();
    const [issued] = await Promise.all([
      service.issue('Semantic index', 30),
      service.reconcile(),
      service.reconcile(),
    ]);
    expect(issuer.secretOf(issued.key.accessKeyId)).toBe(issued.secretAccessKey);
  });

  it('deletes a consumer: its keys and SeaweedFS user go too', async () => {
    const { issuer, service } = setup();
    const issued = await service.issue('Semantic index', 30);
    await service.rotate(issued.consumer.id, 30, 7);
    expect(await service.remove(issued.consumer.id)).toBe('ok');
    expect(issuer.user(issued.consumer.userName)).toBeUndefined();
    expect((await service.list()).consumers).toEqual([]);
    expect(await service.remove(issued.consumer.id)).toBe('not_found');
  });
});
