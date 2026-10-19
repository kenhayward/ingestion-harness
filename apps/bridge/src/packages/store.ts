import type { BridgePackage } from '@ih/bridge-contract';

/** Where accepted packages (with their bytes) wait until every delivery of them is done. */
export interface PackageStore {
  put(key: string, pkg: BridgePackage): Promise<void>;
  get(key: string): Promise<BridgePackage | null>;
  delete(key: string): Promise<void>;
}

export class MemoryPackageStore implements PackageStore {
  private readonly packages = new Map<string, BridgePackage>();

  async put(key: string, pkg: BridgePackage): Promise<void> {
    this.packages.set(key, structuredClone(pkg));
  }

  async get(key: string): Promise<BridgePackage | null> {
    const pkg = this.packages.get(key);
    return pkg ? structuredClone(pkg) : null;
  }

  async delete(key: string): Promise<void> {
    this.packages.delete(key);
  }
}
