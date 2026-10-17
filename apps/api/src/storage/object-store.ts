/** Object storage port. `S3ObjectStore` (SeaweedFS) in production, `MemoryObjectStore` in tests. */
export interface ObjectStore {
  ping(bucket: string): Promise<void>;
  /** Create the bucket when it does not exist; already owned by us is success. */
  ensureBucket(bucket: string): Promise<void>;
  put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
  get(bucket: string, key: string): Promise<Buffer | null>;
  delete(bucket: string, key: string): Promise<void>;
  /** Delete every object whose key starts with `prefix`. Returns how many were deleted. */
  deletePrefix(bucket: string, prefix: string): Promise<number>;
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  readonly ensured: string[] = [];

  async ping(): Promise<void> {}

  async ensureBucket(bucket: string): Promise<void> {
    this.ensured.push(bucket);
  }

  async put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(`${bucket}/${key}`, { body, contentType });
  }

  async get(bucket: string, key: string): Promise<Buffer | null> {
    return this.objects.get(`${bucket}/${key}`)?.body ?? null;
  }

  async delete(bucket: string, key: string): Promise<void> {
    this.objects.delete(`${bucket}/${key}`);
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`));
    for (const k of keys) this.objects.delete(k);
    return keys.length;
  }
}
