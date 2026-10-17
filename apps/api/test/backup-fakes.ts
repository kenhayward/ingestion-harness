import { Readable } from 'node:stream';
import type {
  BackupDeps,
  DatabaseTools,
  LakeIdentities,
  TripleStoreDump,
} from '../src/backup/ports.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Databases as byte strings by name; `live` is the one the API runs on. */
export class FakeDatabaseTools implements DatabaseTools {
  readonly databases = new Map<string, Buffer>();
  readonly calls: string[] = [];

  constructor(
    public dumpBytes: Buffer = Buffer.from('PGDMP fake dump'),
    public applied: string[] = ['0001_init.sql', '202610171218_backup_restore.sql'],
    public readonly live = 'ingestion',
  ) {
    this.databases.set(live, dumpBytes);
  }

  async dump(): Promise<{ body: Readable; done: Promise<void> }> {
    this.calls.push('dump');
    return { body: Readable.from([this.dumpBytes]), done: Promise.resolve() };
  }

  async migrations(): Promise<string[]> {
    return [...this.applied].sort();
  }

  async createSideDatabase(name: string): Promise<string> {
    this.calls.push(`create ${name}`);
    this.databases.set(name, Buffer.alloc(0));
    return `postgres://fake/${name}`;
  }

  async restore(url: string, body: Readable): Promise<void> {
    const name = url.slice(url.lastIndexOf('/') + 1);
    this.calls.push(`restore ${name}`);
    this.databases.set(name, await readAll(body));
  }

  async swap(side: string, keepAs: string): Promise<void> {
    this.calls.push(`swap ${side} ${keepAs}`);
    const live = this.databases.get(this.live)!;
    this.databases.set(keepAs, live);
    this.databases.set(this.live, this.databases.get(side)!);
    this.databases.delete(side);
  }

  async dropDatabase(name: string): Promise<void> {
    this.calls.push(`drop ${name}`);
    this.databases.delete(name);
  }
}

/** A triple store holding one N-Quads string; `null` content = no triple store configured. */
export class FakeTripleStore implements TripleStoreDump {
  constructor(
    public content: string | null = '<http://ex/s> <http://ex/p> "o" <http://ex/g> .\n',
  ) {}

  async available(): Promise<boolean> {
    return this.content !== null;
  }

  async dump(): Promise<Readable> {
    if (this.content === null) throw new Error('no triple store');
    return Readable.from([Buffer.from(this.content)]);
  }

  async replace(body: Readable): Promise<void> {
    this.content = (await readAll(body)).toString('utf8');
  }
}

/** SeaweedFS identities: `replace` keeps every non-lake one, as the real adapter must. */
export class FakeLakeIdentities implements LakeIdentities {
  constructor(
    public identities: { name: string; [k: string]: unknown }[] = [
      { name: 'ingest-admin', actions: ['Admin'] },
      { name: 'lake-acme', credentials: [{ accessKey: 'AK', secretKey: 'SK' }] },
    ],
  ) {}

  async read(): Promise<unknown[]> {
    return this.identities.filter((i) => i.name.startsWith('lake-'));
  }

  async replace(entries: unknown[]): Promise<void> {
    const kept = this.identities.filter((i) => !i.name.startsWith('lake-'));
    this.identities = [...kept, ...(entries as { name: string }[])];
  }
}

export const TEST_MASTER = Buffer.alloc(32, 7);

export const BUCKETS = {
  inbox: 'inbox',
  outputs: 'outputs',
  runs: 'runs',
  backups: 'backups',
} as const;

/** A whole stack of fakes; override any part. */
export function fakeBackupDeps(over: Partial<BackupDeps> = {}): BackupDeps & {
  store: MemoryObjectStore;
} {
  let tick = Date.parse('2026-10-17T12:00:00.000Z');
  const store = (over.store as MemoryObjectStore | undefined) ?? new MemoryObjectStore();
  return {
    db: new FakeDatabaseTools(),
    buckets: { ...BUCKETS },
    internalTargetBuckets: async () => [],
    triples: new FakeTripleStore(),
    lake: new FakeLakeIdentities(),
    master: TEST_MASTER,
    version: { appVersion: '2026.10.17.4', commit: 'abc1234' },
    instanceName: async () => 'production',
    baseIri: async () => 'https://id.example.com/acme/',
    now: () => new Date((tick += 1000)),
    ...over,
    store,
  };
}
