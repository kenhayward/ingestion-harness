import { describe, expect, it } from 'vitest';
import type { NewTarget, PublishTargetRepo } from '../src/publish-targets/repo.js';
import type { DefaultSeed, RdfSeed } from '../src/publish-targets/seed.js';

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
}

const lake = (id: string, over: Partial<NewTarget> = {}): NewTarget => ({
  id,
  label: `Lake ${id}`,
  kind: 'external',
  bucket: 'lake',
  prefix: 'out/',
  endpoint: 'https://s3.eu-west-2.amazonaws.com',
  region: 'eu-west-2',
  accessKeyId: 'AKIA',
  secretKeyEnc: 'v1:abc',
  accessKeyEnv: null,
  secretKeyEnv: null,
  forcePathStyle: false,
  sse: 'none',
  kmsKeyId: null,
  storageClass: null,
  ...over,
});

const SEED: DefaultSeed = {
  kind: 'internal',
  bucket: 'pub',
  prefix: '',
  endpoint: null,
  region: null,
  accessKeyEnv: null,
  secretKeyEnv: null,
  forcePathStyle: true,
};

const RDF: RdfSeed = { endpoint: 'http://fuseki:3030', dataset: 'ct', user: 'ct-writer' };

export function publishTargetsContract(
  name: string,
  make: () => Promise<{ repo: PublishTargetRepo; facts: TargetFacts }>,
): void {
  describe(`PublishTargetRepo (${name})`, () => {
    it('starts with the unseeded default target', async () => {
      const { repo } = await make();
      const list = await repo.list();
      expect(list.map((t) => t.id)).toEqual(['default']);
      expect(list[0]).toMatchObject({
        kind: 'internal',
        bucket: 'ingest-published',
        source: 'env',
      });
      expect((await repo.get('default'))?.seededAt).toBeNull();
    });

    it('creates, lists and gets, never exposing a credential', async () => {
      const { repo } = await make();
      const view = await repo.create(lake('finance', { connectionId: 'finance-account' }), 'Ann');
      expect(view).not.toBe('exists');
      expect(view).toMatchObject({
        id: 'finance',
        connectionId: 'finance-account',
        connection: null,
        source: 'ui',
        updatedBy: 'Ann',
      });
      expect(JSON.stringify(view)).not.toContain('v1:abc');
      expect(JSON.stringify(view)).not.toContain('AKIA');
      expect((await repo.get('finance'))?.accessKeyId).toBe('AKIA');
      expect((await repo.get('finance'))?.secretKeyEnc).toBe('v1:abc');
      expect((await repo.list()).map((t) => t.id)).toEqual(['default', 'finance']);
      expect(await repo.get('nope')).toBeNull();
    });

    it('refuses a duplicate id', async () => {
      const { repo } = await make();
      await repo.create(lake('finance'), null);
      expect(await repo.create(lake('finance'), null)).toBe('exists');
      expect(await repo.create(lake('default'), null)).toBe('exists');
    });

    it('keeps the names of keys read from the environment (for the move to the bridge)', async () => {
      const { repo } = await make();
      await repo.create(
        lake('envkeys', {
          accessKeyId: null,
          secretKeyEnc: null,
          accessKeyEnv: 'A_KEY',
          secretKeyEnv: 'A_SECRET',
        }),
        null,
      );
      expect(await repo.get('envkeys')).toMatchObject({
        secretKeyEnc: null,
        accessKeyEnv: 'A_KEY',
        secretKeyEnv: 'A_SECRET',
      });
    });

    it('update keeps unspecified fields and stamps who and when', async () => {
      const { repo } = await make();
      await repo.create(lake('finance'), 'Ann');
      const view = await repo.update('finance', { label: 'Finance lake', sse: 'AES256' }, 'Bob');
      expect(view).toMatchObject({
        label: 'Finance lake',
        sse: 'AES256',
        bucket: 'lake',
        prefix: 'out/',
        updatedBy: 'Bob',
      });
      expect(view?.editedAt).not.toBeNull();
      expect((await repo.get('finance'))?.secretKeyEnc).toBe('v1:abc');
      expect(await repo.update('nope', { label: 'x' }, null)).toBeNull();
    });

    it('update can replace and clear credentials', async () => {
      const { repo } = await make();
      await repo.create(lake('finance'), null);
      await repo.update('finance', { secretKeyEnc: 'v1:new' }, null);
      expect((await repo.get('finance'))?.secretKeyEnc).toBe('v1:new');
      await repo.update(
        'finance',
        { accessKeyId: null, secretKeyEnc: null, accessKeyEnv: 'K', secretKeyEnv: 'S' },
        null,
      );
      expect(await repo.get('finance')).toMatchObject({
        accessKeyId: null,
        secretKeyEnc: null,
        accessKeyEnv: 'K',
        secretKeyEnv: 'S',
      });
      await repo.update('finance', { connectionId: 'other' }, null);
      expect(await repo.connectionOf('finance')).toBe('other');
    });

    it('never removes the default target', async () => {
      const { repo } = await make();
      expect(await repo.remove('default')).toBe('default');
      expect(await repo.remove('nope')).toBe('missing');
    });

    it('removes an unused target', async () => {
      const { repo } = await make();
      await repo.create(lake('finance'), null);
      expect(await repo.remove('finance')).toBe('deleted');
      expect(await repo.get('finance')).toBeNull();
    });

    it('refuses to remove a target a published version names', async () => {
      const { repo, facts } = await make();
      await repo.create(lake('finance'), null);
      await facts.publish('invoice', 1, 'finance');
      expect(await repo.remove('finance')).toBe('in_use');
      expect(await repo.get('finance')).not.toBeNull();
    });

    it('counts usage from each source', async () => {
      const { repo, facts } = await make();
      await repo.create(lake('finance'), null);
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
      await repo.create(lake('finance'), null);
      await repo.create(lake('other'), null);
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
      await repo.create(lake('finance'), null);
      await repo.create(lake('archive'), null);
      await facts.publish('invoice', 1, ['archive', 'finance']);
      await facts.publish('memo', 1, ['finance']);
      expect((await repo.usage('finance')).documentTypes).toEqual(['invoice', 'memo']);
      expect((await repo.usage('archive')).publishedVersions).toBe(1);
      expect((await repo.usage('default')).publishedVersions).toBe(0);
      expect(await repo.remove('archive')).toBe('in_use');
    });

    it('stores the layout: files unless a target is made an archive', async () => {
      const { repo } = await make();
      await repo.create(lake('plain'), null);
      await repo.create(lake('archive', { layout: 'package' }), null);
      expect((await repo.get('plain'))?.layout).toBe('files');
      expect((await repo.get('archive'))?.layout).toBe('package');
      expect((await repo.list()).find((t) => t.id === 'archive')?.layout).toBe('package');
      await repo.update('plain', { layout: 'package' }, null);
      expect((await repo.get('plain'))?.layout).toBe('package');
      expect((await repo.get('default'))?.layout).toBe('files');
    });

    it('counts a recipe naming no target as using the default', async () => {
      const { repo, facts } = await make();
      await facts.publish('memo', 1, null);
      await facts.publish('invoice', 1, 'default');
      expect((await repo.usage('default')).documentTypes).toEqual(['invoice', 'memo']);
    });

    it('offers choices with the default first, then by label', async () => {
      const { repo } = await make();
      await repo.create(lake('z', { label: 'Zeta' }), null);
      await repo.create(lake('a', { label: 'Alpha' }), null);
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
          layout: 'files',
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
      await repo.create(lake('prod-lake'), null);
      await facts.inert('prod-lake');
      expect((await repo.list()).map((t) => t.id)).toEqual(['default']);
      expect((await repo.choices()).map((t) => t.id)).toEqual(['default']);
      expect(await repo.get('prod-lake')).toBeNull();
      expect(await repo.update('prod-lake', { label: 'P' }, null)).toBeNull();
      expect(await repo.remove('prod-lake')).toBe('missing');
      // The id stays taken: the row is still there for the delivery records naming it.
      expect(await repo.create(lake('prod-lake'), null)).toBe('exists');
    });

    it('moves the version on every write', async () => {
      const { repo } = await make();
      const v0 = await repo.version();
      await repo.create(lake('finance'), null);
      const v1 = await repo.version();
      await repo.update('finance', { label: 'F' }, null);
      const v2 = await repo.version();
      await repo.remove('finance');
      const v3 = await repo.version();
      expect(v1).toBeGreaterThan(v0);
      expect(v2).toBeGreaterThan(v1);
      expect(v3).toBeGreaterThan(v2);
    });

    it('seeds the default once, then keeps it', async () => {
      const { repo } = await make();
      expect(await repo.seedDefault(SEED)).toBe('seeded');
      const got = await repo.get('default');
      expect(got).toMatchObject({ bucket: 'pub', forcePathStyle: true, source: 'env' });
      expect(got?.seededAt).not.toBeNull();
      expect(await repo.seedDefault(SEED)).toBe('kept');
    });

    it('does not overwrite an edit, and says when the environment moved', async () => {
      const { repo } = await make();
      await repo.seedDefault(SEED);
      await repo.update('default', { label: 'Main lake' }, 'Ann');
      expect(await repo.seedDefault(SEED)).toBe('kept');
      expect((await repo.get('default'))?.label).toBe('Main lake');
      expect(await repo.seedDefault({ ...SEED, bucket: 'moved' })).toBe('differs');
      expect((await repo.get('default'))?.bucket).toBe('pub');
    });

    it('seeds an external default from the environment keys', async () => {
      const { repo } = await make();
      await repo.seedDefault({
        ...SEED,
        kind: 'external',
        endpoint: 'https://s3.example.com',
        region: 'eu-west-2',
        accessKeyEnv: 'TARGET_S3_ACCESS_KEY',
        secretKeyEnv: 'TARGET_S3_SECRET_KEY',
      });
      expect((await repo.list())[0]).toMatchObject({ kind: 'external', connectionId: null });
      expect(await repo.get('default')).toMatchObject({
        endpoint: 'https://s3.example.com',
        secretKeyEnc: null,
        accessKeyEnv: 'TARGET_S3_ACCESS_KEY',
        secretKeyEnv: 'TARGET_S3_SECRET_KEY',
      });
    });

    it('marks a target moved to the bridge: its connection kept, its ciphertext gone', async () => {
      const { repo } = await make();
      await repo.create(lake('finance'), 'Ann');
      expect(await repo.connectionOf('finance')).toBeNull();
      expect((await repo.get('finance'))?.movedToBridgeAt).toBeNull();
      const before = await repo.version();
      await repo.markMoved('finance', 'target-finance');
      const moved = await repo.get('finance');
      expect(moved?.secretKeyEnc).toBeNull();
      expect(moved?.movedToBridgeAt).not.toBeNull();
      expect(moved?.accessKeyId).toBe('AKIA');
      expect(await repo.connectionOf('finance')).toBe('target-finance');
      expect(await repo.version()).toBeGreaterThan(before);
      expect(await repo.connectionOf('nope')).toBeNull();
    });

    it('keeps the connection across other edits', async () => {
      const { repo } = await make();
      await repo.create(lake('finance'), null);
      await repo.markMoved('finance', 'target-finance');
      await repo.update('finance', { label: 'Renamed' }, null);
      expect(await repo.connectionOf('finance')).toBe('target-finance');
    });

    it('seeds the triple store target once, keeps it, and says when the environment moved', async () => {
      const { repo } = await make();
      expect(await repo.get('rdf-default')).toBeNull();
      expect(await repo.seedRdf(RDF)).toBe('seeded');
      expect(await repo.get('rdf-default')).toMatchObject({
        id: 'rdf-default',
        label: 'Triple store',
        kind: 'rdf',
        bucket: 'ct',
        prefix: '',
        endpoint: 'http://fuseki:3030',
        accessKeyId: 'ct-writer',
        source: 'env',
      });
      expect(await repo.seedRdf(RDF)).toBe('kept');
      await repo.update('rdf-default', { label: 'Knowledge graph' }, 'Ann');
      expect(await repo.seedRdf(RDF)).toBe('kept');
      expect((await repo.get('rdf-default'))?.label).toBe('Knowledge graph');
      expect(await repo.seedRdf({ ...RDF, dataset: 'kb' })).toBe('differs');
      expect((await repo.get('rdf-default'))?.bucket).toBe('ct');
    });

    it('lists the triple store with its endpoint, offers it as no choice, and never removes it', async () => {
      const { repo } = await make();
      await repo.seedRdf(RDF);
      const views = await repo.list();
      expect(views.find((t) => t.id === 'rdf-default')).toMatchObject({
        kind: 'rdf',
        bucket: 'ct',
        endpoint: 'http://fuseki:3030',
      });
      expect(views.find((t) => t.id === 'default')?.endpoint).toBeNull();
      expect((await repo.choices()).map((c) => c.id)).toEqual(['default']);
      expect(await repo.remove('rdf-default')).toBe('seeded');
      expect(await repo.get('rdf-default')).not.toBeNull();
    });
  });
}
