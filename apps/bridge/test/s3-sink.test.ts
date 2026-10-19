import { SinkDescribeSchema, type BridgePackage } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { S3PackageStore } from '../src/packages/s3.js';
import { MemoryObjectStore, type ObjectStorePort, type S3StoreOptions } from '../src/s3/store.js';
import { SinkError } from '../src/sinks/port.js';
import { INTERNAL_CREDENTIAL, S3Sink } from '../src/sinks/s3.js';
import { s3Failure, ThrowingStore } from './s3-fakes.js';
import { deliverRequest, documentPackage } from './sink-builders.js';

const INTERNAL: S3StoreOptions = {
  endpoint: 'http://seaweedfs:8333',
  region: 'us-east-1',
  accessKeyId: 'internal-key',
  secretAccessKey: 'internal-secret',
  forcePathStyle: true,
};

const CREDENTIAL = {
  endpoint: 'https://s3.example.com',
  region: 'eu-west-1',
  accessKeyId: 'AKIAFINANCE',
  secretAccessKey: 'finance-secret',
  forcePathStyle: 'false',
};

const pkg = (files: BridgePackage['files']): BridgePackage => ({ ...documentPackage, files });

const csv = {
  output: 'fields',
  format: 'csv',
  contentType: 'text/csv; charset=utf-8',
  name: 'demo/v1/fields/doc1.csv',
  content: Buffer.from('id,value\na,1\n').toString('base64'),
};

/** A sink whose stores are `store`, recording the options each was built with. */
function sinkOver(store: ObjectStorePort) {
  const built: S3StoreOptions[] = [];
  const sink = new S3Sink({
    internal: INTERNAL,
    reservedBuckets: ['ingest-bridge'],
    make: (o) => {
      built.push(o);
      return store;
    },
  });
  return { sink, built };
}

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof SinkError) return err.error;
    throw err;
  }
  throw new Error('expected a SinkError');
};

describe('S3Sink', () => {
  it('describes a shared-connection sink that takes files and can read back and withdraw', async () => {
    const { sink } = sinkOver(new MemoryObjectStore());
    const d = SinkDescribeSchema.parse(await sink.describe());
    expect(d.connectionKind).toBe('shared');
    expect(d.capabilities).toEqual({
      browse: false,
      replace: true,
      withdraw: true,
      readBack: true,
      accepts: ['files'],
    });
    expect(d.credentialFields.map((f) => [f.id, f.secret])).toEqual([
      ['endpoint', false],
      ['region', false],
      ['accessKeyId', false],
      ['secretAccessKey', true],
      ['forcePathStyle', false],
    ]);
    expect(d.destinationFields.map((f) => f.id)).toEqual([
      'bucket',
      'prefix',
      'sse',
      'kmsKeyId',
      'storageClass',
    ]);
  });

  it('delivers every file at prefix + name with its content type', async () => {
    const objects = new MemoryObjectStore();
    const { sink, built } = sinkOver(objects);
    const result = await sink.deliver(
      deliverRequest({
        credential: CREDENTIAL,
        destination: { bucket: 'pub', prefix: 'out/', sse: 'AES256', storageClass: 'GLACIER' },
        package: pkg([csv]),
      }),
    );
    expect(await objects.get('pub', 'out/demo/v1/fields/doc1.csv')).toEqual(
      Buffer.from('id,value\na,1\n'),
    );
    expect(objects.objects.get('pub/out/demo/v1/fields/doc1.csv')?.contentType).toBe(
      'text/csv; charset=utf-8',
    );
    expect(result).toEqual({
      status: 'succeeded',
      receipt: {
        written: [
          { kind: 'object', id: 'out/demo/v1/fields/doc1.csv', label: 'fields', url: null },
        ],
      },
    });
    expect(built[0]).toEqual({
      endpoint: 'https://s3.example.com',
      region: 'eu-west-1',
      accessKeyId: 'AKIAFINANCE',
      secretAccessKey: 'finance-secret',
      forcePathStyle: false,
      sse: 'AES256',
      kmsKeyId: null,
      storageClass: 'GLACIER',
    });
  });

  it('uses the bridge’s own S3 for a connection without keys (the internal one)', async () => {
    const { sink, built } = sinkOver(new MemoryObjectStore());
    await sink.deliver(
      deliverRequest({
        credential: INTERNAL_CREDENTIAL,
        destination: { bucket: 'pub', prefix: '' },
      }),
    );
    expect(built[0]).toMatchObject({ ...INTERNAL, sse: 'none' });
  });

  it('never falls back to the bridge’s own keys for a connection that merely lacks keys', async () => {
    const { sink, built } = sinkOver(new MemoryObjectStore());
    for (const credential of [{}, { endpoint: 'https://s3.example.com', secretAccessKey: 's' }]) {
      const error = await errorOf(
        sink.deliver(deliverRequest({ credential, destination: { bucket: 'pub' } })),
      );
      expect(error.code).toBe('credential_missing');
    }
    expect(built).toEqual([]);
  });

  it('refuses the internal store’s reserved buckets (package staging)', async () => {
    const { sink } = sinkOver(new MemoryObjectStore());
    const place = { credential: INTERNAL_CREDENTIAL, destination: { bucket: 'ingest-bridge' } };
    expect((await errorOf(sink.deliver(deliverRequest(place)))).code).toBe('content_rejected');
    expect((await errorOf(sink.readObject(place, 'ingest-bridge', 'packages/p.json'))).code).toBe(
      'content_rejected',
    );
  });

  it('refuses a delivery with no credential at all', async () => {
    const { sink } = sinkOver(new MemoryObjectStore());
    const error = await errorOf(
      sink.deliver(deliverRequest({ credential: null, destination: { bucket: 'pub' } })),
    );
    expect(error.code).toBe('credential_missing');
  });

  it('builds one store per settings, not per delivery', async () => {
    const { sink, built } = sinkOver(new MemoryObjectStore());
    const req = deliverRequest({ credential: CREDENTIAL, destination: { bucket: 'pub' } });
    await sink.deliver(req);
    await sink.deliver(req);
    expect(built).toHaveLength(1);
    await sink.deliver({ ...req, credential: { ...CREDENTIAL, secretAccessKey: 'rotated' } });
    expect(built).toHaveLength(2);
  });

  it('maps AccessDenied to credential_rejected, NoSuchBucket to content_rejected, ECONNREFUSED to instance_unavailable', async () => {
    const cases: [Error, string, string][] = [
      [s3Failure('AccessDenied'), 'credential_rejected', 'needs_user'],
      [s3Failure('InvalidAccessKeyId'), 'credential_rejected', 'needs_user'],
      [s3Failure('NoSuchBucket'), 'content_rejected', 'needs_user'],
      [s3Failure('Error', { code: 'ECONNREFUSED' }), 'instance_unavailable', 'retryable'],
      [
        s3Failure('InternalError', { $metadata: { httpStatusCode: 503 } }),
        'instance_unavailable',
        'retryable',
      ],
    ];
    for (const [err, code, cls] of cases) {
      const { sink } = sinkOver(new ThrowingStore(() => err));
      const error = await errorOf(
        sink.deliver(
          deliverRequest({
            credential: CREDENTIAL,
            destination: { bucket: 'pub' },
            package: pkg([csv]),
          }),
        ),
      );
      expect(error).toMatchObject({ code, class: cls });
      expect(error.message).not.toContain('request detail');
      if (code === 'content_rejected') expect(error.details).toEqual({ bucket: 'pub' });
    }
  });

  it('reads, writes and deletes objects inside the target only', async () => {
    const objects = new MemoryObjectStore();
    const { sink } = sinkOver(objects);
    const target = { credential: CREDENTIAL, destination: { bucket: 'pub', prefix: 'out/' } };
    await sink.putObject(target, 'pub', 'out/g/v1.ttl', Buffer.from('ttl'), 'text/turtle');
    expect(await sink.readObject(target, 'pub', 'out/g/v1.ttl')).toEqual(Buffer.from('ttl'));
    expect(await sink.readObject(target, 'pub', 'out/missing')).toBeNull();
    await sink.deleteObject(target, 'pub', 'out/g/v1.ttl');
    expect(objects.objects.size).toBe(0);
  });

  it('refuses object operations outside the target’s bucket or prefix', async () => {
    const { sink } = sinkOver(new MemoryObjectStore());
    const target = { credential: CREDENTIAL, destination: { bucket: 'pub', prefix: 'out/' } };
    for (const op of [
      sink.readObject(target, 'other', 'out/x'),
      sink.readObject(target, 'pub', 'elsewhere/x'),
      sink.putObject(target, 'pub', 'x', Buffer.from(''), 'text/plain'),
      sink.deleteObject(target, 'other', 'out/x'),
    ]) {
      expect((await errorOf(op)).code).toBe('content_rejected');
    }
  });

  it('tests a target with the probe, skipping the bucket check for the internal store', async () => {
    const { sink } = sinkOver(new MemoryObjectStore());
    expect(
      await sink.probeTarget({
        credential: CREDENTIAL,
        destination: { bucket: 'pub', prefix: '' },
      }),
    ).toMatchObject({ ok: true });
    const denied = sinkOver(new ThrowingStore(() => s3Failure('AccessDenied'))).sink;
    expect(
      await denied.probeTarget({
        credential: INTERNAL_CREDENTIAL,
        destination: { bucket: 'pub', prefix: '' },
      }),
    ).toEqual({ ok: false, step: 'write', message: 'access denied' });
  });

  it('tests a connection: rejected keys are refused, keys that may not list buckets pass', async () => {
    const ok = sinkOver(new MemoryObjectStore()).sink;
    expect(await ok.testConnection({ instanceId: '', credential: CREDENTIAL })).toEqual({
      ok: true,
      identity: 'AKIAFINANCE at https://s3.example.com',
    });
    const limited = sinkOver(new ThrowingStore(() => s3Failure('AccessDenied'))).sink;
    expect(await limited.testConnection({ instanceId: '', credential: CREDENTIAL })).toMatchObject({
      ok: true,
    });
    const wrong = sinkOver(new ThrowingStore(() => s3Failure('SignatureDoesNotMatch'))).sink;
    expect(
      (await errorOf(wrong.testConnection({ instanceId: '', credential: CREDENTIAL }))).code,
    ).toBe('credential_rejected');
    const offline = sinkOver(new ThrowingStore(() => s3Failure('E', { code: 'ENOTFOUND' }))).sink;
    expect(
      (await errorOf(offline.testConnection({ instanceId: '', credential: CREDENTIAL }))).code,
    ).toBe('instance_unavailable');
  });
});

describe('S3PackageStore', () => {
  it('round-trips a package as JSON in its bucket', async () => {
    const objects = new MemoryObjectStore();
    const store = new S3PackageStore(objects, 'ingest-bridge');
    await store.put('packages/p1.json', documentPackage);
    expect(objects.objects.get('ingest-bridge/packages/p1.json')?.contentType).toBe(
      'application/json',
    );
    expect(await store.get('packages/p1.json')).toEqual(documentPackage);
    expect(await store.get('packages/missing.json')).toBeNull();
    await store.delete('packages/p1.json');
    expect(await store.get('packages/p1.json')).toBeNull();
  });
});
