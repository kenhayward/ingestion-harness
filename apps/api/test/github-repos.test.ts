import { describe, expect, it, vi } from 'vitest';
import {
  GitHubError,
  HttpGitHub,
  NotFoundError,
  ProtectedBranchError,
  RateLimitedError,
  StaleRefError,
  UnauthorizedError,
} from '../src/profile/github.js';
import { FakeGitHubRepos } from './fake-github-repos.js';

const config = { clientId: 'Iv1.client', clientSecret: 'shh' };
const TOKEN = 'gho_token';
const R = 'https://api.github.com/repos/ken/recipes';

function stubFetch(...responses: Response[]) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  });
}
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
const call = (fetch: ReturnType<typeof stubFetch>, n: number) => {
  const [url, init] = fetch.mock.calls[n]!;
  return {
    url: String(url),
    method: init?.method ?? 'GET',
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
};
const gh = (fetch: ReturnType<typeof stubFetch>) => new HttpGitHub(config, fetch);

describe('HttpGitHub repository calls', () => {
  it('maps the repository permission', async () => {
    const fetch = stubFetch(
      json({ permissions: { push: true, pull: true } }),
      json({ permissions: { push: false, pull: true } }),
      json({ message: 'Not Found' }, { status: 404 }),
    );
    const github = gh(fetch);
    expect(await github.permission(TOKEN, 'ken/recipes')).toBe('push');
    expect(await github.permission(TOKEN, 'ken/recipes')).toBe('read');
    expect(await github.permission(TOKEN, 'ken/recipes')).toBe('none');
    expect(call(fetch, 0)).toMatchObject({ url: R, method: 'GET' });
    expect(call(fetch, 0).headers.authorization).toBe('Bearer gho_token');
  });

  it('reads a branch head, and a missing branch is NotFound', async () => {
    const fetch = stubFetch(
      json({ object: { sha: 'abc' } }),
      json({ message: 'Not Found' }, { status: 404 }),
    );
    const github = gh(fetch);
    expect(await github.head(TOKEN, 'ken/recipes', 'feature/x y')).toBe('abc');
    expect(call(fetch, 0).url).toBe(`${R}/git/ref/heads/feature/x%20y`);
    await expect(github.head(TOKEN, 'ken/recipes', 'gone')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('commits through blobs, tree, commit and a non-forced ref update', async () => {
    const fetch = stubFetch(
      json({ sha: 'blob1' }, { status: 201 }),
      json({ sha: 'blob2' }, { status: 201 }),
      json({ sha: 'tree1' }, { status: 201 }),
      json({ sha: 'commit1' }, { status: 201 }),
      json({ ref: 'refs/heads/main' }),
    );
    const sha = await gh(fetch).commit(TOKEN, {
      repo: 'ken/recipes',
      branch: 'main',
      parent: 'parent0',
      files: [
        { path: 'a/b.yaml', content: 'one' },
        { path: 'c.yaml', content: 'two' },
      ],
      message: 'msg',
    });
    expect(sha).toBe('commit1');
    expect(call(fetch, 0)).toMatchObject({
      url: `${R}/git/blobs`,
      method: 'POST',
      body: { content: 'one', encoding: 'utf-8' },
    });
    expect(call(fetch, 1).body).toEqual({ content: 'two', encoding: 'utf-8' });
    expect(call(fetch, 2)).toMatchObject({
      url: `${R}/git/trees`,
      method: 'POST',
      body: {
        base_tree: 'parent0',
        tree: [
          { path: 'a/b.yaml', mode: '100644', type: 'blob', sha: 'blob1' },
          { path: 'c.yaml', mode: '100644', type: 'blob', sha: 'blob2' },
        ],
      },
    });
    expect(call(fetch, 3)).toMatchObject({
      url: `${R}/git/commits`,
      method: 'POST',
      body: { message: 'msg', tree: 'tree1', parents: ['parent0'] },
    });
    expect(call(fetch, 4)).toMatchObject({
      url: `${R}/git/refs/heads/main`,
      method: 'PATCH',
      body: { sha: 'commit1', force: false },
    });
  });

  const failingRef = (res: Response) =>
    stubFetch(
      json({ sha: 'b' }, { status: 201 }),
      json({ sha: 't' }, { status: 201 }),
      json({ sha: 'c' }, { status: 201 }),
      res,
    );
  const input = {
    repo: 'ken/recipes',
    branch: 'main',
    parent: 'p',
    files: [{ path: 'a.yaml', content: 'x' }],
    message: 'm',
  };

  it('reports a ref that moved as StaleRefError', async () => {
    const fetch = failingRef(json({ message: 'Update is not a fast forward' }, { status: 422 }));
    await expect(gh(fetch).commit(TOKEN, input)).rejects.toBeInstanceOf(StaleRefError);
  });

  it.each([
    [422, 'Cannot update this protected branch'],
    [403, 'Protected branch update failed for refs/heads/main'],
  ])('reports a protected branch (%s)', async (status, message) => {
    const fetch = failingRef(json({ message }, { status }));
    await expect(gh(fetch).commit(TOKEN, input)).rejects.toBeInstanceOf(ProtectedBranchError);
  });

  it('says when GitHub no longer accepts the token', async () => {
    const fetch = stubFetch(json({ message: 'Bad credentials' }, { status: 401 }));
    const err = await gh(fetch)
      .head(TOKEN, 'ken/recipes', 'main')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as Error).message).toBe(
      'GitHub no longer accepts this link: link the account again in Profile',
    );
  });

  it('reports the rate limit with when it resets', async () => {
    const fetch = stubFetch(
      json(
        { message: 'API rate limit exceeded' },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
        },
      ),
    );
    const err = await gh(fetch)
      .head(TOKEN, 'ken/recipes', 'main')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as Error).message).toBe(
      `GitHub's rate limit was reached: try again after ${new Date(1_800_000_000_000).toISOString()}`,
    );
  });

  it('lists a prefix from the recursive tree', async () => {
    const fetch = stubFetch(
      json({
        truncated: false,
        tree: [
          { path: 'ct-studio', type: 'tree', sha: 't0' },
          { path: 'ct-studio/i/x/v1.yaml', type: 'blob', sha: 'b1' },
          { path: 'ct-studio-other/y.yaml', type: 'blob', sha: 'b2' },
          { path: 'README.md', type: 'blob', sha: 'b3' },
        ],
      }),
    );
    expect(await gh(fetch).listFiles(TOKEN, 'ken/recipes', 'c1', 'ct-studio')).toEqual([
      { path: 'ct-studio/i/x/v1.yaml', blobSha: 'b1' },
    ]);
    expect(call(fetch, 0).url).toBe(`${R}/git/trees/c1?recursive=1`);
  });

  it('reads the prefix directory by directory when GitHub truncates the tree', async () => {
    const fetch = stubFetch(
      json({ truncated: true, tree: [] }),
      json({
        truncated: false,
        tree: [
          { path: 'ct-studio', type: 'tree', sha: 'T1' },
          { path: 'x', type: 'tree', sha: 'Tx' },
        ],
      }),
      json({
        truncated: false,
        tree: [
          { path: 'inst', type: 'tree', sha: 'T2' },
          { path: 'top.yaml', type: 'blob', sha: 'B0' },
        ],
      }),
      json({ truncated: false, tree: [{ path: 'v1.yaml', type: 'blob', sha: 'B1' }] }),
    );
    expect(await gh(fetch).listFiles(TOKEN, 'ken/recipes', 'c1', 'ct-studio')).toEqual([
      { path: 'ct-studio/inst/v1.yaml', blobSha: 'B1' },
      { path: 'ct-studio/top.yaml', blobSha: 'B0' },
    ]);
    expect(call(fetch, 1).url).toBe(`${R}/git/trees/c1`);
    expect(call(fetch, 2).url).toBe(`${R}/git/trees/T1`);
    expect(call(fetch, 3).url).toBe(`${R}/git/trees/T2`);
  });

  it('reads a file at a commit, and null when it is missing', async () => {
    const fetch = stubFetch(
      json({ sha: 'bs', encoding: 'base64', content: Buffer.from('héllo').toString('base64') }),
      json({ message: 'Not Found' }, { status: 404 }),
    );
    const github = gh(fetch);
    expect(await github.readFile(TOKEN, 'ken/recipes', 'c1', 'ct studio/v1.yaml')).toEqual({
      content: 'héllo',
      blobSha: 'bs',
    });
    expect(call(fetch, 0).url).toBe(`${R}/contents/ct%20studio/v1.yaml?ref=c1`);
    expect(await github.readFile(TOKEN, 'ken/recipes', 'c1', 'nope.yaml')).toBeNull();
  });

  it('creates a branch, and reuses one that exists', async () => {
    const fetch = stubFetch(
      json({}, { status: 201 }),
      json({ message: 'Reference already exists' }, { status: 422 }),
    );
    const github = gh(fetch);
    await github.createBranch(TOKEN, 'ken/recipes', 'ct-studio/i/t-v1', 'c1');
    await github.createBranch(TOKEN, 'ken/recipes', 'ct-studio/i/t-v1', 'c1');
    expect(call(fetch, 0)).toMatchObject({
      url: `${R}/git/refs`,
      method: 'POST',
      body: { ref: 'refs/heads/ct-studio/i/t-v1', sha: 'c1' },
    });
  });

  it('opens a pull request', async () => {
    const fetch = stubFetch(
      json({ number: 7, html_url: 'https://github.com/ken/recipes/pull/7' }, { status: 201 }),
    );
    expect(
      await gh(fetch).openPullRequest(TOKEN, {
        repo: 'ken/recipes',
        head: 'feat',
        base: 'main',
        title: 'T',
        body: 'B',
      }),
    ).toEqual({ number: 7, url: 'https://github.com/ken/recipes/pull/7' });
    expect(call(fetch, 0)).toMatchObject({
      url: `${R}/pulls`,
      method: 'POST',
      body: { title: 'T', head: 'feat', base: 'main', body: 'B' },
    });
  });

  it('returns the open pull request that already exists for the branch', async () => {
    const fetch = stubFetch(
      json(
        {
          message: 'Validation Failed',
          errors: [{ message: 'A pull request already exists for ken:feat.' }],
        },
        { status: 422 },
      ),
      json([{ number: 9, html_url: 'https://github.com/ken/recipes/pull/9' }]),
    );
    expect(
      await gh(fetch).openPullRequest(TOKEN, {
        repo: 'ken/recipes',
        head: 'feat',
        base: 'main',
        title: 'T',
        body: 'B',
      }),
    ).toEqual({ number: 9, url: 'https://github.com/ken/recipes/pull/9' });
    expect(call(fetch, 1)).toMatchObject({
      url: `${R}/pulls?head=ken%3Afeat&state=open`,
      method: 'GET',
    });
  });

  it('reads a pull request state', async () => {
    const fetch = stubFetch(
      json({ state: 'open', merged: false }),
      json({ state: 'closed', merged: true }),
      json({ state: 'closed', merged: false }),
    );
    const github = gh(fetch);
    expect(await github.pullRequestState(TOKEN, 'ken/recipes', 3)).toBe('open');
    expect(await github.pullRequestState(TOKEN, 'ken/recipes', 3)).toBe('merged');
    expect(await github.pullRequestState(TOKEN, 'ken/recipes', 3)).toBe('closed');
    expect(call(fetch, 0).url).toBe(`${R}/pulls/3`);
  });

  it('lists every repository the account can read, without a push filter', async () => {
    const page2 = 'https://api.github.com/user/repos?per_page=100&page=2';
    const fetch = stubFetch(
      json([{ full_name: 'ken/zeta', private: false, permissions: { push: false } }], {
        headers: { link: `<${page2}>; rel="next"` },
      }),
      json([{ full_name: 'Ken/Alpha', private: true }]),
    );
    expect(await gh(fetch).listRepos(TOKEN)).toEqual([
      { fullName: 'Ken/Alpha', private: true },
      { fullName: 'ken/zeta', private: false },
    ]);
    expect(call(fetch, 1).url).toBe(page2);
  });
});

describe('FakeGitHubRepos', () => {
  const repo = 'ken/recipes';
  const seeded = () => {
    const fake = new FakeGitHubRepos();
    fake.addRepo(repo, { token: 'tok', permission: 'push' });
    fake.seed(repo, 'main', { 'a.yaml': 'A', 'dir/b.yaml': 'B' });
    return fake;
  };

  it('commits files on top of a parent and moves the branch', async () => {
    const fake = seeded();
    const parent = await fake.head('tok', repo, 'main');
    const sha = await fake.commit('tok', {
      repo,
      branch: 'main',
      parent,
      files: [{ path: 'dir/c.yaml', content: 'C' }],
      message: 'm',
    });
    expect(await fake.head('tok', repo, 'main')).toBe(sha);
    expect(fake.files(repo, 'main')).toEqual({
      'a.yaml': 'A',
      'dir/b.yaml': 'B',
      'dir/c.yaml': 'C',
    });
    expect(fake.commits.at(-1)).toMatchObject({ message: 'm', token: 'tok', parent });
    expect(await fake.listFiles('tok', repo, sha, 'dir')).toHaveLength(2);
    expect((await fake.readFile('tok', repo, sha, 'a.yaml'))?.content).toBe('A');
  });

  it('refuses a protected branch, a stale parent and a missing permission', async () => {
    const fake = seeded();
    const parent = await fake.head('tok', repo, 'main');
    const base = { repo, parent, files: [{ path: 'x', content: 'x' }], message: 'm' };
    fake.protect(repo, 'main');
    await expect(fake.commit('tok', { ...base, branch: 'main' })).rejects.toBeInstanceOf(
      ProtectedBranchError,
    );
    fake.protect(repo, 'main', false);
    fake.beforeRefUpdate = () => fake.seed(repo, 'main', { 'other.yaml': 'o' });
    await expect(fake.commit('tok', { ...base, branch: 'main' })).rejects.toBeInstanceOf(
      StaleRefError,
    );
    fake.beforeRefUpdate = null;
    await expect(fake.head('nobody', repo, 'main')).rejects.toBeInstanceOf(NotFoundError);
    await expect(fake.commit('tok', { ...base, branch: 'main' })).rejects.toBeInstanceOf(
      StaleRefError,
    );
  });

  it('opens one pull request per branch and follows its state', async () => {
    const fake = seeded();
    const from = await fake.head('tok', repo, 'main');
    await fake.createBranch('tok', repo, 'feat', from);
    const a = await fake.openPullRequest('tok', {
      repo,
      head: 'feat',
      base: 'main',
      title: 't',
      body: 'b',
    });
    const b = await fake.openPullRequest('tok', {
      repo,
      head: 'feat',
      base: 'main',
      title: 't',
      body: 'b',
    });
    expect(b).toEqual(a);
    expect(await fake.pullRequestState('tok', repo, a.number)).toBe('open');
    fake.setPullRequestState(repo, a.number, 'merged');
    expect(await fake.pullRequestState('tok', repo, a.number)).toBe('merged');
  });

  it('can truncate trees to force the per-directory path', async () => {
    const fake = seeded();
    fake.truncateTrees = true;
    const sha = await fake.head('tok', repo, 'main');
    expect((await fake.listFiles('tok', repo, sha, 'dir')).map((f) => f.path)).toEqual([
      'dir/b.yaml',
    ]);
    expect(fake.treeReads.some((r) => r === 'truncated')).toBe(true);
  });
});
