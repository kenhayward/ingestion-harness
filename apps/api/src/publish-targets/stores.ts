import type { ObjectStore } from '../storage/object-store.js';
import { S3ObjectStore, type S3Options } from '../storage/s3.js';
import type { TargetRecord } from './repo.js';

export interface TargetStoresOptions {
  /** The API's own object store settings (SeaweedFS), where internal targets' buckets live. */
  internal: S3Options;
  make?: (o: S3Options) => ObjectStore;
}

/**
 * What the API still does on a target's storage itself: create an internal target's bucket on
 * this deployment's SeaweedFS when the target is saved. Everything else (delivering, reading
 * back, withdrawing, Test connection) goes through the delivery bridge, which holds the
 * credentials.
 */
export class TargetStores {
  private store: ObjectStore | null = null;

  constructor(private readonly opts: TargetStoresOptions) {}

  /** Creates an internal target's bucket when it is missing; external targets are left alone. */
  async ensureBucket(target: Pick<TargetRecord, 'kind' | 'bucket'>): Promise<void> {
    if (target.kind !== 'internal') return;
    this.store ??= (this.opts.make ?? ((o: S3Options) => new S3ObjectStore(o)))(this.opts.internal);
    await this.store.ensureBucket(target.bucket);
  }
}
