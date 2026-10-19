import {
  bridgeError,
  type BridgeError,
  type BrowseResult,
  type ConnectionTestRequest,
  type ConnectionTestResult,
  type SinkDeliverRequest,
  type SinkDeliverResult,
  type SinkDescribe,
  type SinkJobStatus,
  type TargetTestResult,
} from '@ih/bridge-contract';
import { S3ObjectStore, type ObjectStorePort, type S3StoreOptions } from '../s3/store.js';
import { SinkError, type SinkPort } from './port.js';
import { isDenied, isNetwork, probe } from './probe.js';

export const S3_SINK_ID = 's3';

const field = (id: string, label: string, required = false) => ({
  id,
  label,
  kind: 'fixed' as const,
  required,
  overridable: false,
  browse: false,
});

const DESCRIBE: SinkDescribe = {
  name: 'S3',
  contractVersion: 1,
  connectionKind: 'shared',
  // A shared S3 connection carries its own endpoint, so there are no named instances.
  instances: [],
  credentialFields: [
    { id: 'endpoint', label: 'Endpoint', secret: false },
    { id: 'region', label: 'Region', secret: false },
    { id: 'accessKeyId', label: 'Access key id', secret: false },
    { id: 'secretAccessKey', label: 'Secret access key', secret: true },
    { id: 'forcePathStyle', label: 'Path-style addressing', secret: false },
  ],
  destinationFields: [
    field('bucket', 'Bucket', true),
    field('prefix', 'Prefix'),
    field('sse', 'Encryption'),
    field('kmsKeyId', 'KMS key id'),
    field('storageClass', 'Storage class'),
  ],
  // Browsing S3 comes later; phase 2 takes the rendered files only.
  capabilities: {
    browse: false,
    replace: true,
    withdraw: true,
    readBack: true,
    accepts: ['files'],
  },
};

/** Where an S3 target writes: the connection's credential and the target's destination. */
export interface S3Place {
  credential: Record<string, string> | null;
  destination: Record<string, string>;
}

const SSE = new Set(['none', 'AES256', 'aws:kms']);

/** An S3 failure in contract terms; never the error's own text, which can echo request detail. */
export function s3Error(err: unknown, bucket: string): BridgeError {
  if (err instanceof SinkError) return err.error;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (isDenied(err)) return bridgeError('credential_rejected', 'the S3 endpoint refused the keys');
  if (e.name === 'NoSuchBucket') {
    return bridgeError('content_rejected', `no such bucket ${bucket}`, { bucket });
  }
  if (isNetwork(err) || (e.$metadata?.httpStatusCode ?? 0) >= 500) {
    return bridgeError('instance_unavailable', 'the S3 endpoint could not be reached');
  }
  return bridgeError('internal', `S3 answered ${e.name ?? 'an error'}`);
}

/**
 * The built-in `s3` sink: writes each file of a package at the target's prefix + its name, so
 * object keys stay exactly what CT Studio wrote before the bridge. A connection without keys
 * (the seeded `internal` one) uses the bridge's own S3 settings: the deployment's SeaweedFS.
 */
export class S3Sink implements SinkPort {
  private readonly stores = new Map<string, ObjectStorePort>();
  private readonly make: (o: S3StoreOptions) => ObjectStorePort;

  constructor(
    private readonly opts: {
      /** The deployment's own S3 (`S3_*`). */
      internal: Omit<S3StoreOptions, 'sse' | 'kmsKeyId' | 'storageClass'>;
      make?: (o: S3StoreOptions) => ObjectStorePort;
    },
  ) {
    this.make = opts.make ?? ((o) => new S3ObjectStore(o));
  }

  async describe(): Promise<SinkDescribe> {
    return structuredClone(DESCRIBE);
  }

  async testConnection(req: ConnectionTestRequest): Promise<ConnectionTestResult> {
    const options = this.options({ credential: req.credential, destination: {} });
    try {
      await this.storeFor(options).checkCredentials();
    } catch (err) {
      // Keys that may write to a bucket but not list buckets are still good keys.
      const name = (err as { name?: string }).name;
      if (name !== 'AccessDenied' && name !== 'Forbidden') {
        throw new SinkError(s3Error(err, ''));
      }
    }
    return { ok: true, identity: `${options.accessKeyId} at ${options.endpoint}` };
  }

  async browse(): Promise<BrowseResult> {
    return { nodes: [], nextCursor: null };
  }

  async deliver(req: SinkDeliverRequest): Promise<SinkDeliverResult> {
    const place = { credential: req.credential, destination: req.destination };
    const store = this.storeFor(this.options(place));
    const { bucket, prefix } = this.where(place);
    const written = [];
    for (const file of req.package.files) {
      const key = prefix + file.name;
      try {
        await store.put(bucket, key, Buffer.from(file.content, 'base64'), file.contentType);
      } catch (err) {
        throw new SinkError(s3Error(err, bucket));
      }
      written.push({ kind: 'object', id: key, label: file.output, url: null });
    }
    return { status: 'succeeded', receipt: { written } };
  }

  async deliveryStatus(sinkJobId: string): Promise<SinkJobStatus> {
    // Every S3 delivery completes at once; there is never a job to poll.
    throw new SinkError(bridgeError('not_found', `no S3 job ${sinkJobId}`));
  }

  /** Test connection for a target: the probe under its prefix. */
  async probeTarget(place: S3Place): Promise<TargetTestResult> {
    const { bucket, prefix } = this.where(place);
    const store = this.storeFor(this.options(place));
    // The internal store's buckets are created when a target is saved.
    return probe(store, bucket, prefix, { checkBucket: !this.isInternal(place) });
  }

  async readObject(place: S3Place, bucket: string, key: string): Promise<Buffer | null> {
    this.inside(place, bucket, key);
    try {
      return await this.storeFor(this.options(place)).get(bucket, key);
    } catch (err) {
      throw new SinkError(s3Error(err, bucket));
    }
  }

  async putObject(
    place: S3Place,
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    this.inside(place, bucket, key);
    try {
      await this.storeFor(this.options(place)).put(bucket, key, body, contentType);
    } catch (err) {
      throw new SinkError(s3Error(err, bucket));
    }
  }

  async deleteObject(place: S3Place, bucket: string, key: string): Promise<void> {
    this.inside(place, bucket, key);
    try {
      await this.storeFor(this.options(place)).delete(bucket, key);
    } catch (err) {
      throw new SinkError(s3Error(err, bucket));
    }
  }

  /** Creates the target's bucket when missing (internal targets, on save). */
  async ensureBucket(place: S3Place): Promise<void> {
    const { bucket } = this.where(place);
    await this.storeFor(this.options(place)).ensureBucket(bucket);
  }

  private where(place: S3Place): { bucket: string; prefix: string } {
    const bucket = place.destination.bucket;
    if (!bucket) throw new SinkError(bridgeError('content_rejected', 'the target has no bucket'));
    return { bucket, prefix: place.destination.prefix ?? '' };
  }

  /** Object operations stay inside the target: its bucket, under its prefix. */
  private inside(place: S3Place, bucket: string, key: string): void {
    const where = this.where(place);
    if (bucket !== where.bucket || !key.startsWith(where.prefix)) {
      throw new SinkError(
        bridgeError('content_rejected', 'the object is outside the target', { bucket, key }),
      );
    }
  }

  private isInternal(place: S3Place): boolean {
    return place.credential !== null && !place.credential.accessKeyId;
  }

  private options(place: S3Place): S3StoreOptions {
    const { credential, destination } = place;
    if (credential === null) {
      throw new SinkError(bridgeError('credential_missing', 'the target has no connection'));
    }
    const sse = destination.sse && SSE.has(destination.sse) ? destination.sse : 'none';
    const write = {
      sse: sse as S3StoreOptions['sse'],
      kmsKeyId: destination.kmsKeyId || null,
      storageClass: destination.storageClass || null,
    };
    if (this.isInternal(place)) return { ...this.opts.internal, ...write };
    if (!credential.secretAccessKey) {
      throw new SinkError(bridgeError('credential_missing', 'the connection has no secret key'));
    }
    const region = credential.region || this.opts.internal.region;
    return {
      endpoint: credential.endpoint || `https://s3.${region}.amazonaws.com`,
      region,
      accessKeyId: credential.accessKeyId!,
      secretAccessKey: credential.secretAccessKey,
      forcePathStyle: credential.forcePathStyle !== 'false',
      ...write,
    };
  }

  /** One store per distinct settings; a rotated key or a changed setting builds a new one. */
  private storeFor(options: S3StoreOptions): ObjectStorePort {
    const key = JSON.stringify(options);
    let store = this.stores.get(key);
    if (!store) {
      store = this.make(options);
      this.stores.set(key, store);
    }
    return store;
  }
}
