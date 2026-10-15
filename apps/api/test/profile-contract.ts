import { describe, expect, it } from 'vitest';
import { LINK_STATE_MS, type ProfileRepo } from '../src/profile/repo.js';

export type Clock = { now: () => number; advance: (ms: number) => void };
/** A repo plus two users it may hold profiles for. */
export type MakeProfiles = (
  clock?: Clock,
) => Promise<{ repo: ProfileRepo; ken: string; ada: string }>;

export const fakeClock = (): Clock => {
  let t = Date.parse('2026-10-15T09:00:00Z');
  return { now: () => t, advance: (ms) => (t += ms) };
};

const github = {
  id: 101,
  login: 'kenhayward',
  avatarUrl: 'https://avatars.githubusercontent.com/u/101?v=4',
  tokenEnc: 'v1:token',
};
const empty = { jobTitle: null, company: null, linkedin: null, github: null };

/**
 * The ProfileRepo contract (docs/design/profile.md), run on MemoryProfileRepo (fake clock) and
 * PgProfileRepo (real clock: the expiry case is skipped there).
 */
export function profileContract(name: string, make: MakeProfiles, opts: { clock: boolean }) {
  describe(`${name}: profile contract`, () => {
    it('starts empty and keeps the details saved', async () => {
      const { repo, ken, ada } = await make();
      expect(await repo.get(ken)).toEqual(empty);
      const details = { jobTitle: 'Engineer', company: 'Acme', linkedin: 'ken-hayward' };
      expect(await repo.update(ken, details)).toEqual({ ...empty, ...details });
      expect(await repo.get(ken)).toEqual({ ...empty, ...details });
      expect(await repo.update(ken, { jobTitle: null, company: 'Acme', linkedin: null })).toEqual({
        ...empty,
        company: 'Acme',
      });
      expect(await repo.get(ada)).toEqual(empty);
    });

    it('links a GitHub account, keeps the details, and chooses a repository', async () => {
      const { repo, ken } = await make();
      await repo.update(ken, { jobTitle: 'Engineer', company: null, linkedin: null });
      const linked = await repo.linkGitHub(ken, github);
      if (linked === 'taken') throw new Error('taken');
      expect(linked.jobTitle).toBe('Engineer');
      expect(linked.github).toEqual({
        id: 101,
        login: 'kenhayward',
        avatarUrl: github.avatarUrl,
        tokenEnc: 'v1:token',
        linkedAt: expect.any(String),
        repo: null,
      });
      expect((await repo.setGitHubRepo(ken, 'kenhayward/recipes')) as object).toMatchObject({
        github: { repo: 'kenhayward/recipes' },
      });
      expect((await repo.get(ken)).github?.repo).toBe('kenhayward/recipes');
      expect((await repo.setGitHubRepo(ken, null)) as object).toMatchObject({
        github: { repo: null },
      });
    });

    it('refuses a repository without a linked account', async () => {
      const { repo, ken } = await make();
      expect(await repo.setGitHubRepo(ken, 'kenhayward/recipes')).toBe('not_linked');
    });

    it('relinking the same account refreshes it and keeps the repository; another clears it', async () => {
      const { repo, ken } = await make();
      await repo.linkGitHub(ken, github);
      await repo.setGitHubRepo(ken, 'kenhayward/recipes');
      const again = await repo.linkGitHub(ken, {
        ...github,
        login: 'ken-renamed',
        tokenEnc: 'v1:new',
      });
      expect(again).toMatchObject({
        github: { login: 'ken-renamed', tokenEnc: 'v1:new', repo: 'kenhayward/recipes' },
      });
      const other = await repo.linkGitHub(ken, { ...github, id: 202, login: 'second' });
      expect(other).toMatchObject({ github: { id: 202, login: 'second', repo: null } });
    });

    it('gives one GitHub account to one user only', async () => {
      const { repo, ken, ada } = await make();
      await repo.linkGitHub(ken, github);
      expect(await repo.linkGitHub(ada, { ...github, tokenEnc: 'v1:ada' })).toBe('taken');
      expect((await repo.get(ada)).github).toBeNull();
      expect(await repo.unlinkGitHub(ken)).toBe('v1:token');
      expect(await repo.linkGitHub(ada, github)).toMatchObject({ github: { id: 101 } });
    });

    it('unlinks: the token is handed back once, the details stay', async () => {
      const { repo, ken } = await make();
      await repo.update(ken, { jobTitle: null, company: 'Acme', linkedin: null });
      await repo.linkGitHub(ken, github);
      await repo.setGitHubRepo(ken, 'kenhayward/recipes');
      expect(await repo.unlinkGitHub(ken)).toBe('v1:token');
      expect(await repo.get(ken)).toEqual({ ...empty, company: 'Acme' });
      expect(await repo.unlinkGitHub(ken)).toBeNull();
    });

    it('takes a link state once, for the user who started it', async () => {
      const { repo, ken, ada } = await make();
      await repo.startLink(ken, 'hash-ken');
      await repo.startLink(ada, 'hash-ada');
      expect(await repo.takeLink('hash-ken')).toBe(ken);
      expect(await repo.takeLink('hash-ken')).toBeNull();
      expect(await repo.takeLink('unknown')).toBeNull();
      expect(await repo.takeLink('hash-ada')).toBe(ada);
    });

    it.skipIf(!opts.clock)('expires a link state after 10 minutes', async () => {
      const clock = fakeClock();
      const { repo, ken } = await make(clock);
      await repo.startLink(ken, 'old');
      clock.advance(LINK_STATE_MS + 1);
      await repo.startLink(ken, 'new');
      expect(await repo.takeLink('old')).toBeNull();
      expect(await repo.takeLink('new')).toBe(ken);
    });
  });
}
