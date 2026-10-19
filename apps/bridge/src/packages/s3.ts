import { PackageSchema, type BridgePackage } from '@ih/bridge-contract';
import type { ObjectStorePort } from '../s3/store.js';
import type { PackageStore } from './store.js';

/** Packages staged as JSON objects in the bridge's own bucket (`BRIDGE_STAGING_BUCKET`). */
export class S3PackageStore implements PackageStore {
  constructor(
    private readonly objects: ObjectStorePort,
    private readonly bucket: string,
  ) {}

  async put(key: string, pkg: BridgePackage): Promise<void> {
    await this.objects.put(this.bucket, key, Buffer.from(JSON.stringify(pkg)), 'application/json');
  }

  async get(key: string): Promise<BridgePackage | null> {
    const raw = await this.objects.get(this.bucket, key);
    return raw ? PackageSchema.parse(JSON.parse(raw.toString('utf8'))) : null;
  }

  async delete(key: string): Promise<void> {
    await this.objects.delete(this.bucket, key);
  }
}
