import { describe, expect, it } from 'vitest';
import type { NewTarget, PublishTargetRepo } from '../src/publish-targets/repo.js';
import type { DefaultSeed } from '../src/publish-targets/seed.js';

/** What the repo cannot see itself: published recipes, recorded outputs, consumer grants. */
export interface TargetFacts {
  publish(id: string, version: number, publishTo: string | null): Promise<void>;
  delivered(targetId: string): Promise<void>;
  grant(targetId: string): Promise<void>;
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

    it('creates, lists and gets, never exposing the secret', async () => {
      const { repo } = await make();
      const view = await repo.create(lake('finance'), 'Ann');
      expect(view).not.toBe('exists');
      expect(view).toMatchObject({
        id: 'finance',
        secretSet: true,
        accessKeyId: 'AKIA',
        source: 'ui',
        updatedBy: 'Ann',
        keysFromEnv: null,
      });
      expect(JSON.stringify(view)).not.toContain('v1:abc');
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

    it('reports keys read from the environment', async () => {
      const { repo } = await make();
      const view = await repo.create(
        lake('envkeys', {
          accessKeyId: null,
          secretKeyEnc: null,
          accessKeyEnv: 'A_KEY',
          secretKeyEnv: 'A_SECRET',
        }),
        null,
      );
      expect(view).toMatchObject({
        secretSet: false,
        keysFromEnv: { accessKey: 'A_KEY', secretKey: 'A_SECRET' },
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
        secretSet: true,
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
      const view = await repo.update(
        'finance',
        { accessKeyId: null, secretKeyEnc: null, accessKeyEnv: 'K', secretKeyEnv: 'S' },
        null,
      );
      expect(view).toMatchObject({
        accessKeyId: null,
        secretSet: false,
        keysFromEnv: { accessKey: 'K', secretKey: 'S' },
      });
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
      });
      const listed = (await repo.list()).find((t) => t.id === 'finance');
      expect(listed?.usage).toEqual(usage);
      expect(await repo.remove('finance')).toBe('in_use');
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
        { id: 'default', label: 'Default', kind: 'internal', bucket: 'ingest-published' },
        { id: 'a', label: 'Alpha', kind: 'external', bucket: 'lake' },
        { id: 'z', label: 'Zeta', kind: 'external', bucket: 'lake' },
      ]);
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
      expect((await repo.list())[0]).toMatchObject({
        kind: 'external',
        endpoint: 'https://s3.example.com',
        secretSet: false,
        keysFromEnv: { accessKey: 'TARGET_S3_ACCESS_KEY', secretKey: 'TARGET_S3_SECRET_KEY' },
      });
    });
  });
}
