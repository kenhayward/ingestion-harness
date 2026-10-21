import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { BackupManifestSchema, type BackupView } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { readArchive } from '../src/backup/archive.js';
import { createBackup, internalTargetBuckets } from '../src/backup/create.js';
import { decryptStream } from '../src/backup/crypto.js';
import { MemoryPublishTargetRepo } from '../src/publish-targets/repo.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import { cacheS3 } from './target-views.js';
import { FakeTripleStore, fakeBackupDeps, TEST_MASTER } from './backup-fakes.js';

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Decrypts a stored backup and returns its entries in order. */
async function entries(
  store: MemoryObjectStore,
  key: string,
): Promise<{ name: string; body: Buffer }[]> {
  const file = await store.get('backups', key);
  if (!file) throw new Error(`no backup at ${key}`);
  const plain = Readable.from([file]).pipe(decryptStream([TEST_MASTER]));
  const out: { name: string; body: Buffer }[] = [];
  for await (const entry of readArchive(plain)) {
    out.push({ name: entry.name, body: await readAll(entry.body) });
  }
  plain.resume();
  await finished(plain);
  return out;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function seed(store: MemoryObjectStore): void {
  void store.put('inbox', 'a/doc.pdf', Buffer.from('%PDF-1 one'), 'application/pdf');
  void store.put('inbox', 'b/doc.docx', Buffer.from('PK word'), 'application/octet-stream');
  void store.put('outputs', 'x/out.csv', Buffer.from('a,b\n1,2\n'), 'text/csv');
  void store.put('runs', 'ocr-cache/1.json', Buffer.from('{}'), 'application/json');
  void store.put(
    'backups',
    'old.ctbak',
    Buffer.from('previous backup'),
    'application/octet-stream',
  );
}

describe('createBackup', () => {
  it('writes an archive whose manifest counts every bucket', async () => {
    const deps = fakeBackupDeps();
    seed(deps.store);
    const result = await createBackup(deps, 'b1', 'Ken', () => {});

    expect(result.key).toBe('b1.ctbak');
    const file = await deps.store.get('backups', 'b1.ctbak');
    expect(result.bytes).toBe(file!.length);

    const manifest = BackupManifestSchema.parse(result.manifest);
    expect(manifest.buckets).toEqual([
      { role: 'inbox', name: 'inbox', objects: 2, bytes: 17 },
      { role: 'outputs', name: 'outputs', objects: 1, bytes: 8 },
      { role: 'runs', name: 'runs', objects: 1, bytes: 2 },
    ]);
    expect(manifest).toMatchObject({
      format: 'ct-backup',
      formatVersion: 1,
      appVersion: '2026.10.17.4',
      commit: 'abc1234',
      migrations: ['0001_init.sql', '202610171218_backup_restore.sql'],
      lastMigration: '202610171218_backup_restore.sql',
      instanceName: 'production',
      baseIri: 'https://id.example.com/acme/',
      createdBy: 'Ken',
      fuseki: true,
      lakeIdentities: 1,
    });
    expect(Date.parse(manifest.finishedAt)).toBeGreaterThan(Date.parse(manifest.startedAt));

    const all = await entries(deps.store, 'b1.ctbak');
    const stored = JSON.parse(all.at(-1)!.body.toString('utf8')) as unknown;
    expect(stored).toEqual(result.manifest);

    // Every part is listed with its size and hash.
    for (const part of manifest.parts) {
      const entry = all.find((e) => e.name === part.name)!;
      expect(part).toEqual({ name: part.name, bytes: entry.body.length, sha256: sha(entry.body) });
    }
    expect(manifest.parts.map((p) => p.name)).toEqual([
      'postgres.dump',
      'objects/index.jsonl',
      'iam/lake-identities.json',
      'fuseki.nq',
    ]);

    // The index lists every object with its hash and content type.
    const index = all
      .find((e) => e.name === 'objects/index.jsonl')!
      .body.toString('utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(index).toContainEqual({
      role: 'outputs',
      bucket: 'outputs',
      key: 'x/out.csv',
      size: 8,
      sha256: sha('a,b\n1,2\n'),
      contentType: 'text/csv',
    });
    expect(index).toHaveLength(4);
    expect(all.find((e) => e.name === 'objects/inbox/a/doc.pdf')!.body.toString()).toBe(
      '%PDF-1 one',
    );
    const lake = JSON.parse(
      all.find((e) => e.name === 'iam/lake-identities.json')!.body.toString('utf8'),
    ) as { name: string }[];
    expect(lake.map((i) => i.name)).toEqual(['lake-acme']);
  });

  it('the decrypted archive lists postgres.dump first and manifest.json last', async () => {
    const deps = fakeBackupDeps();
    seed(deps.store);
    await createBackup(deps, 'b1', 'Ken', () => {});
    const names = (await entries(deps.store, 'b1.ctbak')).map((e) => e.name);
    expect(names).toEqual([
      'postgres.dump',
      'objects/inbox/a/doc.pdf',
      'objects/inbox/b/doc.docx',
      'objects/outputs/x/out.csv',
      'objects/runs/ocr-cache/1.json',
      'objects/index.jsonl',
      'iam/lake-identities.json',
      'fuseki.nq',
      'manifest.json',
    ]);
    const all = await entries(deps.store, 'b1.ctbak');
    expect(all[0]!.body.toString()).toBe('PGDMP fake dump');
  });

  it('skips an object deleted during the backup', async () => {
    const store = new MemoryObjectStore();
    seed(store);
    const original = store.getStream.bind(store);
    store.getStream = async (bucket, key) => {
      if (bucket === 'inbox' && key === 'a/doc.pdf') return null;
      return original(bucket, key);
    };
    const deps = fakeBackupDeps({ store });
    const result = await createBackup(deps, 'b1', 'Ken', () => {});
    const names = (await entries(store, 'b1.ctbak')).map((e) => e.name);
    expect(names).not.toContain('objects/inbox/a/doc.pdf');
    expect(result.manifest.buckets[0]).toEqual({
      role: 'inbox',
      name: 'inbox',
      objects: 1,
      bytes: 7,
    });
  });

  it('omits fuseki.nq when no triple store', async () => {
    const deps = fakeBackupDeps({ triples: new FakeTripleStore(null) });
    seed(deps.store);
    const result = await createBackup(deps, 'b1', 'Ken', () => {});
    const names = (await entries(deps.store, 'b1.ctbak')).map((e) => e.name);
    expect(names).not.toContain('fuseki.nq');
    expect(result.manifest.fuseki).toBe(false);
    expect(result.manifest.parts.map((p) => p.name)).not.toContain('fuseki.nq');
  });

  it('includes internal target buckets but never the backups bucket', async () => {
    const deps = fakeBackupDeps({
      internalTargetBuckets: async () => ['published', 'backups', 'outputs', 'published'],
    });
    seed(deps.store);
    void deps.store.put('published', 'acme/x.csv', Buffer.from('1'), 'text/csv');
    const result = await createBackup(deps, 'b1', 'Ken', () => {});
    expect(result.manifest.buckets.map((b) => [b.role, b.name])).toEqual([
      ['inbox', 'inbox'],
      ['outputs', 'outputs'],
      ['runs', 'runs'],
      ['target', 'published'],
    ]);
    const names = (await entries(deps.store, 'b1.ctbak')).map((e) => e.name);
    expect(names).toContain('objects/published/acme/x.csv');
    expect(names.filter((n) => n.startsWith('objects/backups/'))).toEqual([]);
  });

  it('reports progress through each phase', async () => {
    const deps = fakeBackupDeps();
    seed(deps.store);
    const seen: NonNullable<BackupView['progress']>[] = [];
    await createBackup(deps, 'b1', 'Ken', (p) => {
      if (p) seen.push(p);
    });
    const phases = seen.map((p) => p.phase).filter((p, i, all) => all[i - 1] !== p);
    expect(phases).toEqual(['database', 'objects', 'identities', 'triples', 'finishing']);
    const objects = seen.filter((p) => p.phase === 'objects');
    expect(objects.at(-1)).toMatchObject({ done: 4, of: 4 });
    const bytes = seen.map((p) => p.bytes);
    expect([...bytes].sort((a, b) => a - b)).toEqual(bytes);
    expect(bytes.at(-1)).toBeGreaterThan(0);
  });

  it('leaves nothing behind when a part fails', async () => {
    const deps = fakeBackupDeps();
    seed(deps.store);
    deps.db.dump = async () => ({
      body: Readable.from([Buffer.from('PGDMP partial')]),
      done: Promise.reject(new Error('pg_dump exited with 1: connection lost')),
    });
    await expect(createBackup(deps, 'b2', 'Ken', () => {})).rejects.toThrow('connection lost');
    expect(await deps.store.get('backups', 'b2.ctbak')).toBeNull();
    expect(await deps.store.get('backups', 'old.ctbak')).not.toBeNull();
  });
});

describe('internalTargetBuckets', () => {
  it("lists internal targets' buckets once, without inert ones or CT Studio's own", async () => {
    const repo = new MemoryPublishTargetRepo();
    await cacheS3(repo, { id: 'lake', kind: 'internal', bucket: 'lake-bucket' });
    await cacheS3(repo, { id: 'lake-2', kind: 'internal', bucket: 'lake-bucket' });
    await cacheS3(repo, { id: 'gone', kind: 'internal', bucket: 'gone-bucket' });
    await cacheS3(repo, { id: 'aws', kind: 'external', bucket: 'aws-bucket' });
    await repo.cache(
      {
        id: 'box',
        label: 'Box',
        sinkId: 'archive-sink',
        instanceId: null,
        connectionId: 'internal',
        destination: { bucket: 'box-bucket' },
      },
      {},
    );
    repo.makeInert('gone');
    expect(await internalTargetBuckets(repo, ['inbox', 'outputs', 'runs', 'backups'])).toEqual([
      'ingest-published',
      'lake-bucket',
    ]);
    expect(await internalTargetBuckets(repo, ['ingest-published'])).toEqual(['lake-bucket']);
  });

  it("the staging bucket is in the backup's bucket list (the bridge's packages)", async () => {
    const repo = new MemoryPublishTargetRepo();
    expect(await internalTargetBuckets(repo, ['inbox'], ['ingest-bridge'])).toEqual([
      'ingest-published',
      'ingest-bridge',
    ]);
    expect(await internalTargetBuckets(repo, ['inbox'], ['ingest-published', 'inbox'])).toEqual([
      'ingest-published',
    ]);
  });
});
