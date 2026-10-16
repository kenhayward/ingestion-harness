import { describe, expect, it } from 'vitest';
import type { GitHubSyncRepo, VersionPush } from '../src/github-sync/repo.js';
import type { TemplateRepo } from '../src/templates/repo.js';

export type MakeGitHubSync = () => Promise<{ repo: GitHubSyncRepo; templates: TemplateRepo }>;

const link = {
  repo: 'acme/recipes',
  branch: 'main',
  root: 'ct-studio',
  alwaysPr: false,
  pushOnPublish: true,
};

const push = (over: Partial<VersionPush> = {}): VersionPush => ({
  typeId: 'invoice',
  version: 1,
  repo: 'acme/recipes',
  branch: 'main',
  path: 'ct-studio/default/invoice/v1.yaml',
  commit: 'c1',
  blobSha: 'b1',
  labelSha: 'l1',
  prNumber: null,
  prUrl: null,
  prState: null,
  pushedBy: 'Ken',
  pushedAt: '2026-10-16T10:00:00.000Z',
  ...over,
});

/** The GitHubSyncRepo contract (docs/superpowers/specs/2026-10-16-github-recipe-sync-design.md). */
export function githubSyncContract(name: string, make: MakeGitHubSync) {
  describe(`${name}: GitHub sync contract`, () => {
    it('creates the settings once, with an id and the default root', async () => {
      const { repo } = await make();
      const a = await repo.settings();
      const b = await repo.settings();
      expect(a.instanceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(b.instanceId).toBe(a.instanceId);
      expect(a.defaultRoot).toBe('ct-studio');
      expect(a.instanceName).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(a.firstPushedAt).toBeNull();
    });

    it('renames until something is pushed, then locks the name but not the root', async () => {
      const { repo } = await make();
      const first = await repo.setSettings(
        { instanceName: 'staging', defaultRoot: 'ct-studio' },
        'Ken',
      );
      expect(first).toEqual({
        instanceName: 'staging',
        instanceId: (await repo.settings()).instanceId,
        defaultRoot: 'ct-studio',
        locked: false,
      });
      await repo.markPushed();
      const stamp = (await repo.settings()).firstPushedAt;
      expect(stamp).not.toBeNull();
      await repo.markPushed();
      expect((await repo.settings()).firstPushedAt).toBe(stamp);
      expect(
        await repo.setSettings({ instanceName: 'prod', defaultRoot: 'ct-studio' }, 'Ken'),
      ).toBe('locked');
      const moved = await repo.setSettings(
        { instanceName: 'staging', defaultRoot: 'data/ct' },
        'Ken',
      );
      expect(moved).toMatchObject({
        instanceName: 'staging',
        defaultRoot: 'data/ct',
        locked: true,
      });
    });

    it('round-trips a link with who set it, and removes it once', async () => {
      const { repo } = await make();
      expect(await repo.link('invoice')).toBeNull();
      await repo.setLink('invoice', link, 'Ken');
      const got = await repo.link('invoice');
      expect(got).toMatchObject({ ...link, setBy: 'Ken' });
      expect(Number.isNaN(Date.parse(got!.setAt))).toBe(false);
      await repo.setLink('invoice', { ...link, branch: 'dev' }, 'Ada');
      expect(await repo.link('invoice')).toMatchObject({ branch: 'dev', setBy: 'Ada' });
      expect(await repo.removeLink('invoice')).toBe(true);
      expect(await repo.removeLink('invoice')).toBe(false);
    });

    it('keeps the newest push of a version and lists them by version', async () => {
      const { repo } = await make();
      await repo.recordPush(push({ version: 2, path: 'p2' }));
      await repo.recordPush(push({ version: 1 }));
      await repo.recordPush(
        push({ version: 1, commit: 'c2', prNumber: 7, prUrl: 'u', prState: 'open' }),
      );
      await repo.recordPush(push({ typeId: 'other', version: 1 }));
      const rows = await repo.pushes('invoice');
      expect(rows.map((r) => r.version)).toEqual([1, 2]);
      expect(rows[0]).toMatchObject({ commit: 'c2', prNumber: 7, prState: 'open' });
    });

    it('records who published a version', async () => {
      const { templates } = await make();
      await templates.create('invoice_gh', 1, { id: 'invoice_gh' }, 'draft');
      const rec = await templates.publish('invoice_gh', 1, 'Ken');
      expect(rec?.publishedBy).toBe('Ken');
      await templates.create('invoice_gh', 2, { id: 'invoice_gh' }, 'draft');
      expect((await templates.publish('invoice_gh', 2))?.publishedBy).toBeNull();
      expect((await templates.get('invoice_gh', 1))?.publishedBy).toBe('Ken');
    });
  });
}
