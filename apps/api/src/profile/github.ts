import type { GitHubRepo } from '@ih/shared';

/** A GitHub call that failed in a way worth telling the user (its message says what to do). */
export class GitHubError extends Error {}
/** GitHub no longer accepts the user's token (revoked or expired). */
export class UnauthorizedError extends GitHubError {
  constructor() {
    super('GitHub no longer accepts this link: link the account again in Profile');
  }
}
/** The repository, branch, file or pull request is not there (or the account cannot see it). */
export class NotFoundError extends GitHubError {}
/** The branch refuses direct commits (branch protection). */
export class ProtectedBranchError extends GitHubError {}
/** A ref update lost a race: the branch moved since its head was read. */
export class StaleRefError extends GitHubError {}
/** GitHub's rate limit was reached. */
export class RateLimitedError extends GitHubError {
  constructor(resetAt: string) {
    super(`GitHub's rate limit was reached: try again after ${resetAt}`);
  }
}

export interface GitHubUser {
  id: number;
  login: string;
  avatarUrl: string;
}

/**
 * GitHub, as the profile's account link needs it (docs/design/profile.md): the OAuth web flow,
 * the signed-in user and the repositories they can push to. `HttpGitHub`; tests use a fake.
 */
export interface GitHubOAuth {
  authorizeUrl(state: string, redirectUri: string): string;
  /** The access token for a callback's code. */
  exchange(code: string, redirectUri: string): Promise<string>;
  user(token: string): Promise<GitHubUser>;
  /** Repositories the account can push to, by name (case-insensitive). */
  repos(token: string): Promise<GitHubRepo[]>;
  /** Revokes the token (an unlink); best effort for callers. */
  revoke(token: string): Promise<void>;
}

export type RepoPermission = 'push' | 'read' | 'none';

/**
 * Repository access for recipe sync, through the Git Data API, with the signed-in user's own
 * token (first argument of every call). `HttpGitHub`; tests use `FakeGitHubRepos`. Calls throw
 * `GitHubError` or a subclass.
 */
export interface GitHubRepoApi {
  permission(token: string, repo: string): Promise<RepoPermission>;
  /** The branch's head commit sha; `NotFoundError` for a missing branch or repository. */
  head(token: string, repo: string, branch: string): Promise<string>;
  /** Files under `prefix` at a commit (reads the folder directly when GitHub truncates the tree). */
  listFiles(
    token: string,
    repo: string,
    commit: string,
    prefix: string,
  ): Promise<{ path: string; blobSha: string }[]>;
  readFile(
    token: string,
    repo: string,
    commit: string,
    path: string,
  ): Promise<{ content: string; blobSha: string } | null>;
  /** Commits files on top of `parent` and moves `branch` to it without force; returns the commit sha. */
  commit(
    token: string,
    input: {
      repo: string;
      branch: string;
      parent: string;
      files: { path: string; content: string }[];
      message: string;
    },
  ): Promise<string>;
  /** Creates the branch at `fromCommit`; one that exists is reused. */
  createBranch(token: string, repo: string, name: string, fromCommit: string): Promise<void>;
  /** Opens a pull request; an open one for `head` is returned instead. */
  openPullRequest(
    token: string,
    input: { repo: string; head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }>;
  pullRequestState(
    token: string,
    repo: string,
    number: number,
  ): Promise<'open' | 'merged' | 'closed'>;
  /** Every repository the account can read, by name (case-insensitive). */
  listRepos(token: string): Promise<GitHubRepo[]>;
}

/** `repo`: the recipe YAML feature will push to the chosen repository, private ones too. */
export const GITHUB_SCOPES = 'repo read:user';
const API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
/** At most this many pages of 100 repositories are read. */
const MAX_PAGES = 10;
const BASE_HEADERS = { 'user-agent': 'ct-studio' };
const API_HEADERS = {
  ...BASE_HEADERS,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
};

const nextPage = (link: string | null) => /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null;

const byName = (a: GitHubRepo, b: GitHubRepo) =>
  a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' });
/** A repository path with each segment encoded (`owner/name` stays two segments). */
const seg = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const repoUrl = (repo: string) => `${API}/repos/${seg(repo)}`;

interface TreeBody {
  tree: { path: string; type: string; sha: string }[];
  truncated?: boolean;
}

export class HttpGitHub implements GitHubOAuth, GitHubRepoApi {
  constructor(
    private readonly config: { clientId: string; clientSecret: string },
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      scope: GITHUB_SCOPES,
      state,
      allow_signup: 'false',
    }).toString();
    return url.toString();
  }

  async exchange(code: string, redirectUri: string): Promise<string> {
    const res = await this.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { ...BASE_HEADERS, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new GitHubError(`GitHub refused the sign-in: ${body.error ?? `HTTP ${res.status}`}`);
    }
    return body.access_token;
  }

  private async get(token: string, url: string): Promise<Response> {
    const res = await this.fetch(url, {
      headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      throw new GitHubError('GitHub no longer accepts this link: link the account again');
    }
    if (!res.ok) throw new GitHubError(`GitHub answered HTTP ${res.status}`);
    return res;
  }

  async user(token: string): Promise<GitHubUser> {
    const body = (await (await this.get(token, `${API}/user`)).json()) as {
      id: number;
      login: string;
      avatar_url: string;
    };
    return { id: body.id, login: body.login, avatarUrl: body.avatar_url };
  }

  repos(token: string): Promise<GitHubRepo[]> {
    return this.pagedRepos(token, (item) => item.permissions?.push === true);
  }

  listRepos(token: string): Promise<GitHubRepo[]> {
    return this.pagedRepos(token, () => true);
  }

  private async pagedRepos(
    token: string,
    keep: (item: { permissions?: { push?: boolean } }) => boolean,
  ): Promise<GitHubRepo[]> {
    const first = new URL(`${API}/user/repos`);
    first.search = new URLSearchParams({
      per_page: '100',
      sort: 'full_name',
      affiliation: 'owner,collaborator,organization_member',
    }).toString();
    const repos: GitHubRepo[] = [];
    let url: string | null = first.toString();
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await this.get(token, url);
      const items = (await res.json()) as {
        full_name: string;
        private: boolean;
        permissions?: { push?: boolean };
      }[];
      for (const item of items) {
        if (keep(item)) repos.push({ fullName: item.full_name, private: item.private });
      }
      url = nextPage(res.headers.get('link'));
    }
    return repos.sort(byName);
  }

  /** One API call; a status in `allow` is returned instead of raised. */
  private async call(
    token: string,
    method: string,
    url: string,
    body?: unknown,
    allow: number[] = [],
  ): Promise<{ res: Response; data: unknown }> {
    const res = await this.fetch(url, {
      method,
      headers: {
        ...API_HEADERS,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (res.ok || allow.includes(res.status)) return { res, data };
    const message = String((data as { message?: unknown } | null)?.message ?? '');
    if (res.status === 401) throw new UnauthorizedError();
    if (
      (res.status === 403 || res.status === 429) &&
      res.headers.get('x-ratelimit-remaining') === '0'
    ) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      throw new RateLimitedError(
        Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : 'a while',
      );
    }
    if (res.status === 404) throw new NotFoundError(`GitHub could not find it (${message})`);
    if (
      (res.status === 403 || res.status === 422) &&
      /protected branch|protected ref|changes must be made through a pull request|required status check/i.test(
        message,
      )
    ) {
      throw new ProtectedBranchError(`GitHub refused the change: ${message}`);
    }
    if (res.status === 422 && /not a fast.forward/i.test(message)) {
      throw new StaleRefError('the branch moved on GitHub while pushing');
    }
    throw new GitHubError(`GitHub answered HTTP ${res.status}${message ? `: ${message}` : ''}`);
  }

  async permission(token: string, repo: string): Promise<RepoPermission> {
    try {
      const { data } = await this.call(token, 'GET', repoUrl(repo));
      const p = (data as { permissions?: { push?: boolean; pull?: boolean } }).permissions;
      return p?.push ? 'push' : p?.pull ? 'read' : 'none';
    } catch (err) {
      if (err instanceof NotFoundError) return 'none';
      throw err;
    }
  }

  async head(token: string, repo: string, branch: string): Promise<string> {
    const { data } = await this.call(token, 'GET', `${repoUrl(repo)}/git/ref/heads/${seg(branch)}`);
    return (data as { object: { sha: string } }).object.sha;
  }

  private async tree(token: string, repo: string, sha: string, recursive: boolean) {
    const { data } = await this.call(
      token,
      'GET',
      `${repoUrl(repo)}/git/trees/${encodeURIComponent(sha)}${recursive ? '?recursive=1' : ''}`,
    );
    return data as TreeBody;
  }

  async listFiles(token: string, repo: string, commit: string, prefix: string) {
    const dir = prefix.replace(/^\/+|\/+$/g, '');
    const all = await this.tree(token, repo, commit, true);
    if (!all.truncated) {
      return all.tree
        .filter((e) => e.type === 'blob' && (!dir || e.path.startsWith(`${dir}/`)))
        .map((e) => ({ path: e.path, blobSha: e.sha }));
    }
    // GitHub cut the listing short: walk down to the folder and read it directory by directory.
    let sha = commit;
    for (const name of dir ? dir.split('/') : []) {
      const entry = (await this.tree(token, repo, sha, false)).tree.find(
        (e) => e.type === 'tree' && e.path === name,
      );
      if (!entry) return [];
      sha = entry.sha;
    }
    const files: { path: string; blobSha: string }[] = [];
    const walk = async (treeSha: string, base: string): Promise<void> => {
      for (const e of (await this.tree(token, repo, treeSha, false)).tree) {
        const path = base ? `${base}/${e.path}` : e.path;
        if (e.type === 'blob') files.push({ path, blobSha: e.sha });
        else if (e.type === 'tree') await walk(e.sha, path);
      }
    };
    await walk(sha, dir);
    return files;
  }

  async readFile(token: string, repo: string, commit: string, path: string) {
    try {
      const { data } = await this.call(
        token,
        'GET',
        `${repoUrl(repo)}/contents/${seg(path)}?ref=${encodeURIComponent(commit)}`,
      );
      const file = data as { sha: string; content?: string; encoding?: string };
      if (file.encoding === 'base64' && file.content) {
        return {
          content: Buffer.from(file.content, 'base64').toString('utf-8'),
          blobSha: file.sha,
        };
      }
      // Over the contents limit: read the blob itself.
      const blob = (await this.call(token, 'GET', `${repoUrl(repo)}/git/blobs/${file.sha}`))
        .data as { content: string; encoding: string };
      const encoding = blob.encoding === 'base64' ? 'base64' : 'utf-8';
      return {
        content: Buffer.from(blob.content, encoding).toString('utf-8'),
        blobSha: file.sha,
      };
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  async commit(
    token: string,
    input: {
      repo: string;
      branch: string;
      parent: string;
      files: { path: string; content: string }[];
      message: string;
    },
  ): Promise<string> {
    const base = repoUrl(input.repo);
    const tree: { path: string; mode: string; type: string; sha: string }[] = [];
    for (const file of input.files) {
      const { data } = await this.call(token, 'POST', `${base}/git/blobs`, {
        content: file.content,
        encoding: 'utf-8',
      });
      tree.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: (data as { sha: string }).sha,
      });
    }
    const made = await this.call(token, 'POST', `${base}/git/trees`, {
      base_tree: input.parent,
      tree,
    });
    const commit = await this.call(token, 'POST', `${base}/git/commits`, {
      message: input.message,
      tree: (made.data as { sha: string }).sha,
      parents: [input.parent],
    });
    const sha = (commit.data as { sha: string }).sha;
    await this.call(token, 'PATCH', `${base}/git/refs/heads/${seg(input.branch)}`, {
      sha,
      force: false,
    });
    return sha;
  }

  async createBranch(token: string, repo: string, name: string, fromCommit: string) {
    const { res, data } = await this.call(
      token,
      'POST',
      `${repoUrl(repo)}/git/refs`,
      { ref: `refs/heads/${name}`, sha: fromCommit },
      [422],
    );
    if (res.status === 422 && !/already exists/i.test(JSON.stringify(data))) {
      throw new GitHubError(`GitHub refused the branch: ${JSON.stringify(data)}`);
    }
  }

  async openPullRequest(
    token: string,
    input: { repo: string; head: string; base: string; title: string; body: string },
  ) {
    const base = repoUrl(input.repo);
    const { res, data } = await this.call(
      token,
      'POST',
      `${base}/pulls`,
      { title: input.title, head: input.head, base: input.base, body: input.body },
      [422],
    );
    if (res.status !== 422) {
      const pr = data as { number: number; html_url: string };
      return { number: pr.number, url: pr.html_url };
    }
    if (!/already exists/i.test(JSON.stringify(data))) {
      throw new GitHubError(`GitHub refused the pull request: ${JSON.stringify(data)}`);
    }
    const owner = input.repo.split('/')[0]!;
    const head = input.head.includes(':') ? input.head : `${owner}:${input.head}`;
    const found = await this.call(
      token,
      'GET',
      `${base}/pulls?head=${encodeURIComponent(head)}&state=open`,
    );
    const open = (found.data as { number: number; html_url: string }[])[0];
    if (!open) throw new GitHubError('GitHub says a pull request exists but did not list it');
    return { number: open.number, url: open.html_url };
  }

  async pullRequestState(token: string, repo: string, number: number) {
    const { data } = await this.call(token, 'GET', `${repoUrl(repo)}/pulls/${number}`);
    const pr = data as { state: string; merged?: boolean };
    return pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed';
  }

  async revoke(token: string): Promise<void> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`);
    const res = await this.fetch(
      `${API}/applications/${encodeURIComponent(this.config.clientId)}/token`,
      {
        method: 'DELETE',
        headers: {
          ...API_HEADERS,
          authorization: `Basic ${basic.toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ access_token: token }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok && res.status !== 404) throw new GitHubError(`GitHub answered HTTP ${res.status}`);
  }
}
