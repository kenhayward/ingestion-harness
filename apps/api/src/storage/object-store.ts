/** Object storage port. `S3ObjectStore` (SeaweedFS) in production, `MemoryObjectStore` in tests. */
export interface ObjectStore {
  ping(bucket: string): Promise<void>;
  put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
  get(bucket: string, key: string): Promise<Buffer | null>;
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async ping(): Promise<void> {}

  async put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(`${bucket}/${key}`, { body, contentType });
  }

  async get(bucket: string, key: string): Promise<Buffer | null> {
    return this.objects.get(`${bucket}/${key}`)?.body ?? null;
  }
}
