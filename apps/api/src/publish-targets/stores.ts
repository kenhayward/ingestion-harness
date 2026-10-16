import type { SecretsKeys } from '../llm/secrets.js';
import { decryptSecret } from '../llm/secrets.js';
import type { ObjectStore } from '../storage/object-store.js';
import { S3ObjectStore, type S3Options } from '../storage/s3.js';
import type { PublishTargetRepo, TargetRecord } from './repo.js';

export class TargetMissingError extends Error {
  constructor(readonly targetId: string) {
    super(`no publishing target ${targetId}`);
    this.name = 'TargetMissingError';
  }
}

/** The target exists but cannot be used now (for example its secret cannot be decrypted). */
export class TargetUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetUnavailableError';
  }
}

const VERSION_CHECK_MS = 1_000;

export interface TargetStoresOptions {
  repo: PublishTargetRepo;
  /** The API's own object store settings (SeaweedFS), used by internal targets. */
  internal: S3Options;
  secrets: SecretsKeys | null;
  env: NodeJS.ProcessEnv;
  make?: (o: S3Options) => ObjectStore;
}

/** One object store per publishing target, rebuilt when a target was written. */
export class TargetStores {
  private readonly cache = new Map<string, { store: ObjectStore; target: TargetRecord }>();
  private seenVersion: number | null = null;
  private checkedAt = 0;

  constructor(private readonly opts: TargetStoresOptions) {}

  async storeFor(targetId: string): Promise<{ store: ObjectStore; target: TargetRecord }> {
    await this.refresh();
    const hit = this.cache.get(targetId);
    if (hit) return hit;
    const target = await this.opts.repo.get(targetId);
    if (!target) throw new TargetMissingError(targetId);
    const make = this.opts.make ?? ((o: S3Options) => new S3ObjectStore(o));
    const entry = { store: make(this.options(target)), target };
    this.cache.set(targetId, entry);
    return entry;
  }

  async ensureBucket(target: TargetRecord): Promise<void> {
    const { store } = await this.storeFor(target.id);
    await store.ensureBucket(target.bucket);
  }

  private async refresh(): Promise<void> {
    const now = Date.now();
    if (this.seenVersion !== null && now - this.checkedAt < VERSION_CHECK_MS) return;
    const version = await this.opts.repo.version();
    this.checkedAt = now;
    if (version !== this.seenVersion) {
      this.cache.clear();
      this.seenVersion = version;
    }
  }

  private options(t: TargetRecord): S3Options {
    if (t.kind === 'internal') return this.opts.internal;
    const { env, secrets } = this.opts;
    const region = t.region ?? this.opts.internal.region;
    const accessKeyId = t.accessKeyId ?? (t.accessKeyEnv ? env[t.accessKeyEnv] : undefined);
    let secretAccessKey: string | undefined;
    if (t.secretKeyEnc) {
      try {
        if (!secrets) throw new Error('no master key');
        secretAccessKey = decryptSecret(t.secretKeyEnc, secrets);
      } catch {
        throw new TargetUnavailableError(`cannot decrypt the secret of ${t.label}`);
      }
    } else if (t.secretKeyEnv) {
      secretAccessKey = env[t.secretKeyEnv];
    }
    if (!accessKeyId || !secretAccessKey) {
      throw new TargetUnavailableError(`${t.label} has no credentials`);
    }
    return {
      endpoint: t.endpoint || `https://s3.${region}.amazonaws.com`,
      region,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: t.forcePathStyle,
      sse: t.sse,
      kmsKeyId: t.kmsKeyId,
      storageClass: t.storageClass,
    };
  }
}
