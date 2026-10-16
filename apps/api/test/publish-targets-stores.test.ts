import { BucketAlreadyOwnedByYou, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret, type SecretsKeys } from '../src/llm/secrets.js';
import { MemoryPublishTargetRepo, type NewTarget } from '../src/publish-targets/repo.js';
import { probeTarget } from '../src/publish-targets/probe.js';
import {
  TargetMissingError,
  TargetStores,
  TargetUnavailableError,
} from '../src/publish-targets/stores.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import { S3ObjectStore, s3ClientConfig, type S3Options } from '../src/storage/s3.js';

const keys: SecretsKeys = { current: Buffer.alloc(32, 7), previous: null };
const internal: S3Options = {
  endpoint: 'http://seaweed:8333',
  region: 'us-east-1',
  accessKeyId: 'IA',
  secretAccessKey: 'IS',
};

function external(over: Partial<NewTarget> = {}): NewTarget {
  return {
    id: 'lake',
    label: 'Finance lake',
    kind: 'external',
    bucket: 'lake',
    prefix: 'ingest/',
    endpoint: 'https://s3.example.com',
    region: 'eu-west-2',
    accessKeyId: 'AK',
    secretKeyEnc: encryptSecret('SK', keys),
    accessKeyEnv: null,
    secretKeyEnv: null,
    forcePathStyle: true,
    sse: 'AES256',
    kmsKeyId: null,
    storageClass: 'STANDARD_IA',
    ...over,
  };
}

function setup(env: NodeJS.ProcessEnv = {}, secrets: SecretsKeys | null = keys) {
  const repo = new MemoryPublishTargetRepo();
  const made: S3Options[] = [];
  const stores = new TargetStores({
    repo,
    internal,
    secrets,
    env,
    make: (o) => {
      made.push(o);
      return new MemoryObjectStore();
    },
  });
  return { repo, made, stores };
}

describe('TargetStores', () => {
  it('builds the internal store for the default target', async () => {
    const { stores, made } = setup();
    const { target } = await stores.storeFor('default');
    expect(target.id).toBe('default');
    expect(made).toEqual([internal]);
  });

  it('builds an external store from its endpoint, region and credentials', async () => {
    const { stores, made, repo } = setup();
    await repo.create(external(), 'ken');
    await stores.storeFor('lake');
    expect(made[0]).toMatchObject({
      endpoint: 'https://s3.example.com',
      region: 'eu-west-2',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      forcePathStyle: true,
      sse: 'AES256',
      storageClass: 'STANDARD_IA',
    });
  });

  it('uses the AWS endpoint of the region when none is set', async () => {
    const { stores, made, repo } = setup();
    await repo.create(external({ endpoint: null }), null);
    await stores.storeFor('lake');
    expect(made[0]!.endpoint).toBe('https://s3.eu-west-2.amazonaws.com');
  });

  it('reads each credential half from the environment when none is stored', async () => {
    const { stores, made, repo } = setup({ TARGET_S3_ACCESS_KEY: 'EA', S3_SECRET_KEY: 'ES' });
    await repo.create(
      external({
        accessKeyId: null,
        secretKeyEnc: null,
        accessKeyEnv: 'TARGET_S3_ACCESS_KEY',
        secretKeyEnv: 'S3_SECRET_KEY',
      }),
      null,
    );
    await stores.storeFor('lake');
    expect(made[0]).toMatchObject({ accessKeyId: 'EA', secretAccessKey: 'ES' });
  });

  it.each([
    ['accessKeyEnv', { accessKeyEnv: 'DATABASE_URL', accessKeyId: null }],
    ['secretKeyEnv', { secretKeyEnv: 'LLM_SECRETS_KEY', secretKeyEnc: null }],
  ])('refuses a credential %s outside the allowlist', async (_name, over) => {
    const { stores, repo, made } = setup({
      DATABASE_URL: 'postgres://x',
      LLM_SECRETS_KEY: 'k',
      TARGET_S3_ACCESS_KEY: 'EA',
      TARGET_S3_SECRET_KEY: 'ES',
    });
    await repo.create(
      external({
        accessKeyId: null,
        secretKeyEnc: null,
        accessKeyEnv: 'TARGET_S3_ACCESS_KEY',
        secretKeyEnv: 'TARGET_S3_SECRET_KEY',
        ...over,
      }),
      null,
    );
    await expect(stores.storeFor('lake')).rejects.toThrow(
      new TargetUnavailableError('Finance lake names an unsupported credential variable'),
    );
    expect(made).toEqual([]);
  });

  it('caches a store until the repo version moves', async () => {
    vi.useFakeTimers();
    try {
      const { stores, made, repo } = setup();
      await repo.create(external(), null);
      await stores.storeFor('lake');
      await stores.storeFor('lake');
      expect(made).toHaveLength(1);
      await repo.update('lake', { accessKeyId: 'AK2' }, null);
      await stores.storeFor('lake');
      expect(made).toHaveLength(1); // the version is checked at most once a second
      vi.advanceTimersByTime(1_100);
      await stores.storeFor('lake');
      expect(made).toHaveLength(2);
      expect(made[1]!.accessKeyId).toBe('AK2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws TargetMissingError for an unknown id', async () => {
    const { stores } = setup();
    await expect(stores.storeFor('nope')).rejects.toBeInstanceOf(TargetMissingError);
  });

  it('throws TargetUnavailableError when the secret cannot be decrypted', async () => {
    const { stores, repo } = setup({}, { current: Buffer.alloc(32, 9), previous: null });
    await repo.create(external(), null);
    await expect(stores.storeFor('lake')).rejects.toThrow(
      new TargetUnavailableError('cannot decrypt the secret of Finance lake'),
    );
  });

  it('throws TargetUnavailableError when a stored secret has no master key', async () => {
    const { stores, repo } = setup({}, null);
    await repo.create(external(), null);
    await expect(stores.storeFor('lake')).rejects.toBeInstanceOf(TargetUnavailableError);
  });

  it('ensures the bucket through the target store', async () => {
    const mem = new MemoryObjectStore();
    const stores = new TargetStores({
      repo: new MemoryPublishTargetRepo(),
      internal,
      secrets: keys,
      env: {},
      make: () => mem,
    });
    const { target } = await stores.storeFor('default');
    await stores.ensureBucket(target);
    expect(mem.ensured).toEqual([target.bucket]);
  });
});

class Failing extends MemoryObjectStore {
  constructor(
    private readonly at: 'put' | 'get' | 'delete' | 'wrong',
    private readonly err: Error,
  ) {
    super();
  }
  override async put(b: string, k: string, body: Buffer, ct: string): Promise<void> {
    if (this.at === 'put') throw this.err;
    return super.put(b, k, body, ct);
  }
  override async get(b: string, k: string): Promise<Buffer | null> {
    if (this.at === 'get') throw this.err;
    if (this.at === 'wrong') return Buffer.from('other');
    return super.get(b, k);
  }
  override async delete(b: string, k: string): Promise<void> {
    if (this.at === 'delete') throw this.err;
    return super.delete(b, k);
  }
}
const named = (name: string): Error => Object.assign(new Error('secret-ish detail'), { name });

describe('probeTarget', () => {
  it('passes and leaves nothing behind', async () => {
    const store = new MemoryObjectStore();
    const r = await probeTarget(store, 'b', 'ingest/');
    expect(r).toMatchObject({ ok: true, step: null });
    expect(store.objects.size).toBe(0);
  });

  it.each([
    ['AccessDenied', 'write', 'access denied'],
    ['NoSuchBucket', 'write', 'no such bucket'],
    ['PermanentRedirect', 'write', 'wrong region for this bucket'],
    ['TimeoutError', 'connect', 'could not reach the endpoint'],
    ['WeirdThing', 'write', 'WeirdThing'],
  ])('maps a %s on write to %s / %s', async (name, step, message) => {
    const r = await probeTarget(new Failing('put', named(name)), 'b', '');
    expect(r).toEqual({ ok: false, step, message });
    expect(JSON.stringify(r)).not.toContain('secret-ish');
  });

  it('reports a network failure code as connect', async () => {
    const err = Object.assign(new Error('x'), { name: 'Error', code: 'ENOTFOUND' });
    expect(await probeTarget(new Failing('put', err), 'b', '')).toEqual({
      ok: false,
      step: 'connect',
      message: 'could not reach the endpoint',
    });
  });

  it('fails the read step on a failing get', async () => {
    expect(await probeTarget(new Failing('get', named('AccessDenied')), 'b', '')).toEqual({
      ok: false,
      step: 'read',
      message: 'access denied',
    });
  });

  it('fails the read step when the bytes differ', async () => {
    expect(await probeTarget(new Failing('wrong', named('x')), 'b', '')).toMatchObject({
      ok: false,
      step: 'read',
    });
  });

  it.each(['get', 'wrong'] as const)(
    'still deletes the test file when the read fails (%s)',
    async (at) => {
      const store = new Failing(at, named('AccessDenied'));
      const r = await probeTarget(store, 'b', 'ingest/');
      expect(r).toMatchObject({ ok: false, step: 'read' });
      expect(store.objects.size).toBe(0);
    },
  );

  it('fails the delete step', async () => {
    expect(await probeTarget(new Failing('delete', named('AccessDenied')), 'b', '')).toEqual({
      ok: false,
      step: 'delete',
      message: 'access denied',
    });
  });

  it('writes under the prefix', async () => {
    const store = new MemoryObjectStore();
    const put = vi.spyOn(store, 'put');
    await probeTarget(store, 'b', 'ingest/');
    expect(put.mock.calls[0]![1]).toMatch(/^ingest\/\.ct-studio-check-[0-9a-f-]{36}$/);
  });
});

describe('S3ObjectStore options', () => {
  const base = { endpoint: 'https://e', region: 'r', accessKeyId: 'a', secretAccessKey: 's' };

  it('defaults to path-style and honours forcePathStyle: false', () => {
    expect(s3ClientConfig(base).forcePathStyle).toBe(true);
    expect(s3ClientConfig({ ...base, forcePathStyle: false }).forcePathStyle).toBe(false);
  });

  it('applies encryption and storage class on put', async () => {
    const send = vi.fn(async (_c: unknown) => ({}));
    await new S3ObjectStore(
      { ...base, sse: 'aws:kms', kmsKeyId: 'kid', storageClass: 'STANDARD_IA' },
      { send } as never,
    ).put('b', 'k', Buffer.from('x'), 'text/csv');
    const cmd = send.mock.calls[0]![0] as PutObjectCommand;
    expect(cmd.input).toMatchObject({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'kid',
      StorageClass: 'STANDARD_IA',
    });
  });

  it('sends none of them by default', async () => {
    const send = vi.fn(async (_c: unknown) => ({}));
    await new S3ObjectStore(base, { send } as never).put('b', 'k', Buffer.from('x'), 'text/csv');
    const input = (send.mock.calls[0]![0] as PutObjectCommand).input;
    expect(input.ServerSideEncryption).toBeUndefined();
    expect(input.StorageClass).toBeUndefined();
  });

  it('creates a bucket and treats one we already own as success', async () => {
    const send = vi.fn(async (_c: unknown) => {
      throw new BucketAlreadyOwnedByYou({ message: 'x', $metadata: {} });
    });
    await new S3ObjectStore(base, { send } as never).ensureBucket('b');
    expect(send.mock.calls[0]![0]).toBeInstanceOf(CreateBucketCommand);
  });

  it('rethrows other bucket errors', async () => {
    const send = vi.fn(async (_c: unknown) => {
      throw Object.assign(new Error('no'), { name: 'AccessDenied' });
    });
    await expect(new S3ObjectStore(base, { send } as never).ensureBucket('b')).rejects.toThrow(
      'no',
    );
  });
});
