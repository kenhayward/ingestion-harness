import type { GitHubRepo } from '@ih/shared';

/** A GitHub call that failed in a way worth telling the user (its message says what to do). */
export class GitHubError extends Error {}

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

export class HttpGitHub implements GitHubOAuth {
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

  async repos(token: string): Promise<GitHubRepo[]> {
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
        if (item.permissions?.push) repos.push({ fullName: item.full_name, private: item.private });
      }
      url = nextPage(res.headers.get('link'));
    }
    return repos.sort((a, b) =>
      a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }),
    );
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
