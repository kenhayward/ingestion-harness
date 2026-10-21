import { describe, expect, it } from 'vitest';
import { TargetStores } from '../src/publish-targets/stores.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import type { S3Options } from '../src/storage/s3.js';
import { s3View } from './target-views.js';

const at = (kind: 'internal' | 'external', bucket: string) => ({
  kind,
  ...s3View({ id: 'x', kind, bucket }),
});

const internal: S3Options = {
  endpoint: 'http://seaweed:8333',
  region: 'us-east-1',
  accessKeyId: 'k',
  secretAccessKey: 's',
};

describe('TargetStores', () => {
  it("creates an internal target's bucket on the deployment's own storage, once built", async () => {
    const store = new MemoryObjectStore();
    const made: S3Options[] = [];
    const stores = new TargetStores({
      internal,
      make: (o) => {
        made.push(o);
        return store;
      },
    });
    await stores.ensureBucket(at('internal', 'archive'));
    await stores.ensureBucket(at('internal', 'archive-2'));
    expect(store.ensured).toEqual(['archive', 'archive-2']);
    expect(made).toEqual([internal]);
  });

  it("leaves an external target's bucket alone (the bridge reaches it)", async () => {
    const store = new MemoryObjectStore();
    const stores = new TargetStores({ internal, make: () => store });
    await stores.ensureBucket(at('external', 'lake'));
    expect(store.ensured).toEqual([]);
  });
});
