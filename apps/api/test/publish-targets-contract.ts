import { readFileSync } from 'node:fs';
import type { TargetPutRequest } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { s3PlaceOf } from '../src/publish-targets/place.js';
import type { LegacyKeys, PublishTargetRepo } from '../src/publish-targets/repo.js';
import { cacheS3, rdfView, s3View } from './target-views.js';

/**
 * What the repo cannot see itself: published recipes, recorded outputs, consumer grants and
 * withdraw jobs (one object and one graph entry naming the target).
 */
export interface TargetFacts {
  publish(id: string, version: number, publishTo: string | string[] | null): Promise<void>;
  delivered(targetId: string): Promise<void>;
  grant(targetId: string): Promise<void>;
  withdrawal(targetId: string, status: 'queued' | 'running' | 'succeeded'): Promise<void>;
  /** A copy restore keeps a dropped external target as an inert row (`inert_at`). */
  inert(targetId: string): Promise<void>;
  /** Keys from before the bridge (`publish_target_legacy_keys`), as the migration leaves them. */
  legacyKeys(keys: LegacyKeys): Promise<void>;
}

/**
 * Target rows from before the merge with what the mirror sent the bridge for each (shared with
 * integration/targets-on-bridge-pg.test.ts, which checks the migration's backfill).
 */
interface DestinationCase {
  name: string;
  row: { id: string; bucket: string; prefix: string; layout: string; kind: string };
  mirror: TargetPutRequest;
}
const destinationCases = (
  JSON.parse(
    readFileSync(
      new URL('../../../packages/shared/test/fixtures/target-destinations.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: DestinationCase[] }
).cases;

const legacy = (id: string, over: Partial<LegacyKeys> = {}): LegacyKeys => ({
  id,
  endpoint: 'https://s3.eu-west-2.amazonaws.com',
  region: 'eu-west-2',
  accessKeyId: 'AKIA',
  secretKeyEnc: 'v1:abc',
  accessKeyEnv: null,
  secretKeyEnv: null,
  forcePathStyle: false,
  movedToBridgeAt: null,
  ...over,
});

export function publishTargetsContract(
  name: string,
  make: () => Promise<{ repo: PublishTargetRepo; facts: TargetFacts }>,
): void {
  describe(`PublishTargetRepo (${name})`, () => {
    it('starts with the unseeded default target, not synced yet', async () => {
      const { repo } = await make();
      const list = await repo.list();
      expect(list.map((t) => t.id)).toEqual(['default']);
      expect(list[0]).toMatchObject({
        kind: 'internal',
        sinkId: 's3',
        bucket: 'ingest-published',
        source: 'env',
      });
      expect(await repo.get('default')).toMatchObject({ seededAt: null, syncedAt: null });
    });

    it('caches a bridge target and derives its kind', async () => {
      const { repo } = await make();
      await repo.cache(s3View({ id: 'own', kind: 'internal', bucket: 'own-bucket' }), {});
      await repo.cache(s3View({ id: 'lake', connectionId: 'finance-account' }), {});
      await repo.cache(rdfView(), {});
      await repo.cache(
        {
          id: 'archive-box',
          label: 'Archive box',
          sinkId: 'archive-sink',
          instanceId: 'eu',
          connectionId: null,
          destination: { folder: 'ct' },
        },
        {},
      );
      const kinds = Object.fromEntries((await repo.list()).map((t) => [t.id, t.kind]));
      expect(kinds).toEqual({
        default: 'internal',
        own: 'internal',
        lake: 'external',
        'rdf-default': 'rdf',
        'archive-box': 'sink',
      });
      const lake = await repo.get('lake');
      expect(lake).toMatchObject({
        label: 'Lake lake',
        sinkId: 's3',
        instanceId: null,
        connectionId: 'finance-account',
        destination: { bucket: 'lake', prefix: 'out/', layout: 'files' },
        onBridge: true,
        source: 'ui',
        seededAt: null,
        editedAt: null,
      });
      expect(lake?.syncedAt).not.toBeNull();
      expect(await repo.get('archive-box')).toMatchObject({
        sinkId: 'archive-sink',
        instanceId: 'eu',
        destination: { folder: 'ct' },
      });
    });

    it('views an S3 target with its place and options, another sink with none', async () => {
      const { repo } = await make();
      await cacheS3(repo, {
        id: 'lake',
        connectionId: 'finance-account',
        sse: 'aws:kms',
        kmsKeyId: 'kms-1',
        layout: 'package',
      });
      await repo.cache(
        {
          id: 'box',
          label: 'Box',
          sinkId: 'archive-sink',
          instanceId: null,
          connectionId: null,
          destination: { folder: 'ct' },
        },
        {},
      );
      await repo.cache(rdfView('kb'), {});
      const views = Object.fromEntries((await repo.list()).map((t) => [t.id, t]));
      expect(views.lake).toMatchObject({
        sinkId: 's3',
        onBridge: true,
        bucket: 'lake',
        prefix: 'out/',
        layout: 'package',
        sse: 'aws:kms',
        kmsKeyId: 'kms-1',
        storageClass: null,
        connectionId: 'finance-account',
        connection: null,
        endpoint: null,
      });
      expect(views.box).toMatchObject({
        kind: 'sink',
        destination: { folder: 'ct' },
        bucket: null,
        prefix: null,
        layout: null,
        sse: null,
      });
      // The triple store's dataset shows where an S3 target's bucket does.
      expect(views['rdf-default']).toMatchObject({ kind: 'rdf', bucket: 'kb', prefix: null });
    });

    it('a cache write keeps CT Studio’s own facts unless it names them', async () => {
      const { repo } = await make();
      await cacheS3(repo, { id: 'lake' }, { source: 'ui', by: 'Ann' });
      const first = await repo.get('lake');
      expect(first).toMatchObject({ source: 'ui', updatedBy: 'Ann', editedAt: null });
      // A pull: no facts.
      await cacheS3(repo, { id: 'lake', label: 'Renamed on the bridge' }, {});
      expect(await repo.get('lake')).toMatchObject({
        label: 'Renamed on the bridge',
        source: 'ui',
        updatedBy: 'Ann',
        editedAt: null,
        createdAt: first?.createdAt,
      });
      // An edit: who and when.
      await cacheS3(repo, { id: 'lake', bucket: 'other' }, { by: 'Bob' });
      const edited = await repo.get('lake');
      expect(edited).toMatchObject({ updatedBy: 'Bob', destination: { bucket: 'other' } });
      expect(edited?.editedAt).not.toBeNull();
      // A seed: where from and when.
      const at = '2026-10-21T09:00:00.000Z';
      await cacheS3(
        repo,
        { id: 'default', kind: 'internal', bucket: 'pub' },
        {
          source: 'env',
          seededAt: at,
        },
      );
      expect(await repo.get('default')).toMatchObject({
        source: 'env',
        seededAt: at,
        connectionId: 'internal',
        destination: { bucket: 'pub' },
      });
    });

    it('a cache write rewrites what code from before it left in a row', async () => {
      const { repo } = await make();
      // Old code inserted the triple store row as an S3 one with an empty destination.
      await cacheS3(repo, { id: 'rdf-default', kind: 'internal', bucket: '' }, {});
      await repo.cache(rdfView('ct'), {});
      expect(await repo.get('rdf-default')).toMatchObject({
        kind: 'rdf',
        sinkId: 'rdf',
        connectionId: 'rdf-default',
        destination: { dataset: 'ct' },
      });
    });

    it('never makes an inert target live again', async () => {
      const { repo, facts } = await make();
      await cacheS3(repo, { id: 'prod-lake' });
      await facts.inert('prod-lake');
      await cacheS3(repo, { id: 'prod-lake', label: 'Still on the bridge' }, {});
      expect(await repo.get('prod-lake')).toBeNull();
      expect((await repo.list()).map((t) => t.id)).toEqual(['default']);
      expect(await repo.cachedIds()).toEqual(
        expect.arrayContaining([
          { id: 'default', live: true },
          { id: 'prod-lake', live: false },
        ]),
      );
    });

    it('a target marked missing stays, not on the bridge, until a cache write', async () => {
      const { repo } = await make();
      await cacheS3(repo, { id: 'lake' });
      const before = await repo.version();
      await repo.markMissing(['lake']);
      expect(await repo.version()).toBeGreaterThan(before);
      expect(await repo.get('lake')).toMatchObject({ onBridge: false });
      expect((await repo.list()).find((t) => t.id === 'lake')?.onBridge).toBe(false);
      await repo.markMissing([]);
      await cacheS3(repo, { id: 'lake' }, {});
      expect((await repo.get('lake'))?.onBridge).toBe(true);
    });

    it.each(destinationCases.map((c) => [c.name, c] as const))(
      'the cache keeps what the bridge holds, and s3PlaceOf reads it: %s',
      async (_name, c) => {
        const { repo } = await make();
        await repo.cache({ id: c.row.id, ...c.mirror }, {});
        const got = await repo.get(c.row.id);
        expect(got).toMatchObject({
          label: c.mirror.label,
          sinkId: c.mirror.sinkId,
          instanceId: c.mirror.instanceId,
          connectionId: c.mirror.connectionId,
          destination: c.mirror.destination,
          kind: c.row.kind,
        });
        expect(s3PlaceOf(got!)).toEqual(
          c.mirror.sinkId === 's3'
            ? { bucket: c.row.bucket, prefix: c.row.prefix, layout: c.row.layout }
            : null,
        );
      },
    );

    it('never removes the default target', async () => {
      const { repo } = await make();
      expect(await repo.remove('default')).toBe('default');
      expect(await repo.remove('nope')).toBe('missing');
    });

    it('removes an unused target', async () => {
      const { repo } = await make();
      await cacheS3(repo, { id: 'finance' });
      expect(await repo.remove('finance')).toBe('deleted');
      expect(await repo.get('finance')).toBeNull();
    });

    it('refuses to remove a target a published version names', async () => {
      const { repo, facts } = await make();
      await cacheS3(repo, { id: 'finance' });
      await facts.publish('invoice', 1, 'finance');
      expect(await repo.remove('finance')).toBe('in_use');
      expect(await repo.get('finance')).not.toBeNull();
    });

    it('counts usage from each source', async () => {
      const { repo, facts } = await make();
      await cacheS3(repo, { id: 'finance' });
      expect(await repo.usage('finance')).toEqual({
        publishedVersions: 0,
        documentTypes: [],
        deliveredOutputs: 0,
        consumers: 0,
        pendingJobs: 0,
      });
      await facts.publish('invoice', 1, 'finance');
      await facts.publish('invoice', 2, 'finance');
      await facts.publish('receipt', 1, 'finance');
      await facts.publish('memo', 1, null);
      await facts.delivered('finance');
      await facts.delivered('finance');
      await facts.grant('finance');
      const usage = await repo.usage('finance');
      expect(usage).toEqual({
        publishedVersions: 3,
        documentTypes: ['invoice', 'receipt'],
        deliveredOutputs: 2,
        consumers: 1,
        pendingJobs: 0,
      });
      const listed = (await repo.list()).find((t) => t.id === 'finance');
      expect(listed?.usage).toEqual(usage);
      expect(await repo.remove('finance')).toBe('in_use');
    });

    it('counts withdrawals still to run that name the target', async () => {
      const { repo, facts } = await make();
      await cacheS3(repo, { id: 'finance' });
      await cacheS3(repo, { id: 'other' });
      await facts.withdrawal('finance', 'succeeded');
      expect((await repo.usage('finance')).pendingJobs).toBe(0);
      expect(await repo.remove('other')).toBe('deleted');
      await facts.withdrawal('finance', 'queued');
      await facts.withdrawal('finance', 'running');
      const usage = await repo.usage('finance');
      expect(usage.pendingJobs).toBe(2);
      expect((await repo.list()).find((t) => t.id === 'finance')?.usage).toEqual(usage);
      expect(await repo.remove('finance')).toBe('in_use');
    });

    it('a target is in use when a list names it', async () => {
      const { repo, facts } = await make();
      await cacheS3(repo, { id: 'finance' });
      await cacheS3(repo, { id: 'archive' });
      await facts.publish('invoice', 1, ['archive', 'finance']);
      await facts.publish('memo', 1, ['finance']);
      expect((await repo.usage('finance')).documentTypes).toEqual(['invoice', 'memo']);
      expect((await repo.usage('archive')).publishedVersions).toBe(1);
      expect((await repo.usage('default')).publishedVersions).toBe(0);
      expect(await repo.remove('archive')).toBe('in_use');
    });

    it('counts a recipe naming no target as using the default', async () => {
      const { repo, facts } = await make();
      await facts.publish('memo', 1, null);
      await facts.publish('invoice', 1, 'default');
      expect((await repo.usage('default')).documentTypes).toEqual(['invoice', 'memo']);
    });

    it('offers S3 choices from their destinations, the default first, then by label', async () => {
      const { repo } = await make();
      await cacheS3(repo, { id: 'z', label: 'Zeta' });
      await cacheS3(repo, { id: 'a', label: 'Alpha', layout: 'package' });
      await repo.cache(rdfView(), {});
      await repo.cache(
        {
          id: 'box',
          label: 'Box',
          sinkId: 'archive-sink',
          instanceId: null,
          connectionId: null,
          destination: {},
        },
        {},
      );
      expect(await repo.choices()).toEqual([
        {
          id: 'default',
          label: 'Default',
          kind: 'internal',
          bucket: 'ingest-published',
          prefix: '',
          layout: 'files',
        },
        {
          id: 'a',
          label: 'Alpha',
          kind: 'external',
          bucket: 'lake',
          prefix: 'out/',
          layout: 'package',
        },
        {
          id: 'z',
          label: 'Zeta',
          kind: 'external',
          bucket: 'lake',
          prefix: 'out/',
          layout: 'files',
        },
      ]);
    });

    it('an inert target is not listed and is a 404', async () => {
      const { repo, facts } = await make();
      await cacheS3(repo, { id: 'prod-lake' });
      await facts.inert('prod-lake');
      expect((await repo.list()).map((t) => t.id)).toEqual(['default']);
      expect((await repo.choices()).map((t) => t.id)).toEqual(['default']);
      expect(await repo.get('prod-lake')).toBeNull();
      expect(await repo.remove('prod-lake')).toBe('missing');
    });

    it('moves the version on every write', async () => {
      const { repo } = await make();
      const v0 = await repo.version();
      await cacheS3(repo, { id: 'finance' });
      const v1 = await repo.version();
      await cacheS3(repo, { id: 'finance', label: 'F' }, { by: null });
      const v2 = await repo.version();
      await repo.remove('finance');
      const v3 = await repo.version();
      expect(v1).toBeGreaterThan(v0);
      expect(v2).toBeGreaterThan(v1);
      expect(v3).toBeGreaterThan(v2);
    });

    it('lists the keys from before the bridge, and drops a row once moved', async () => {
      const { repo, facts } = await make();
      await cacheS3(repo, { id: 'finance' });
      await cacheS3(repo, { id: 'archive' });
      expect(await repo.legacyKeys()).toEqual([]);
      await facts.legacyKeys(legacy('finance'));
      await facts.legacyKeys(
        legacy('archive', {
          accessKeyId: null,
          secretKeyEnc: null,
          accessKeyEnv: 'A_KEY',
          secretKeyEnv: 'A_SECRET',
          forcePathStyle: true,
        }),
      );
      const keys = await repo.legacyKeys();
      expect(keys.map((k) => k.id)).toEqual(['archive', 'finance']);
      expect(keys[0]).toEqual(
        legacy('archive', {
          accessKeyId: null,
          secretKeyEnc: null,
          accessKeyEnv: 'A_KEY',
          secretKeyEnv: 'A_SECRET',
          forcePathStyle: true,
        }),
      );
      await repo.dropLegacyKeys('finance');
      expect((await repo.legacyKeys()).map((k) => k.id)).toEqual(['archive']);
      // A removed target takes its legacy keys with it.
      expect(await repo.remove('archive')).toBe('deleted');
      expect(await repo.legacyKeys()).toEqual([]);
    });

    it('offers the triple store as no choice, and never removes it', async () => {
      const { repo } = await make();
      await repo.cache(rdfView(), { source: 'env', seededAt: new Date().toISOString() });
      const views = await repo.list();
      expect(views.find((t) => t.id === 'rdf-default')).toMatchObject({
        kind: 'rdf',
        bucket: 'ct',
        // Its endpoint is its bridge connection's: the route fills it from the summary.
        endpoint: null,
      });
      expect((await repo.choices()).map((c) => c.id)).toEqual(['default']);
      expect(await repo.remove('rdf-default')).toBe('seeded');
      expect(await repo.get('rdf-default')).not.toBeNull();
    });
  });
}
