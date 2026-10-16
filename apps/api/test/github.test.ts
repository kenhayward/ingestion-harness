import { describe, expect, it, vi } from 'vitest';
import { GitHubError, HttpGitHub } from '../src/profile/github.js';

const config = { clientId: 'Iv1.client', clientSecret: 'shh' };
const API_HEADERS = {
  accept: 'application/vnd.github+json',
  authorization: 'Bearer gho_token',
  'user-agent': 'ct-studio',
  'x-github-api-version': '2022-11-28',
};

/** A fetch answering each call with the next response, recording the requests. */
function stubFetch(...responses: Response[]) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  });
  return fetch;
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

describe('HttpGitHub', () => {
  it('builds the authorize address with the repo scope', () => {
    const url = new URL(
      new HttpGitHub(config).authorizeUrl(
        'st4te',
        'https://ct.example/api/profile/github/callback',
      ),
    );
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'Iv1.client',
      redirect_uri: 'https://ct.example/api/profile/github/callback',
      scope: 'repo read:user',
      state: 'st4te',
      allow_signup: 'false',
    });
  });

  it('exchanges the code for a token', async () => {
    const fetch = stubFetch(json({ access_token: 'gho_token', scope: 'repo,read:user' }));
    const github = new HttpGitHub(config, fetch);
    expect(await github.exchange('c0de', 'https://ct.example/cb')).toBe('gho_token');
    expect(call(fetch, 0)).toEqual({
      url: 'https://github.com/login/oauth/access_token',
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'ct-studio',
      },
      body: {
        client_id: 'Iv1.client',
        client_secret: 'shh',
        code: 'c0de',
        redirect_uri: 'https://ct.example/cb',
      },
    });
  });

  it('refuses an exchange GitHub answers with an error', async () => {
    const github = new HttpGitHub(config, stubFetch(json({ error: 'bad_verification_code' })));
    await expect(github.exchange('old', 'https://ct.example/cb')).rejects.toThrow(
      new GitHubError('GitHub refused the sign-in: bad_verification_code'),
    );
  });

  it('reads the signed-in GitHub user', async () => {
    const fetch = stubFetch(
      json({ id: 101, login: 'kenhayward', avatar_url: 'https://avatars.example/u/101' }),
    );
    expect(await new HttpGitHub(config, fetch).user('gho_token')).toEqual({
      id: 101,
      login: 'kenhayward',
      avatarUrl: 'https://avatars.example/u/101',
    });
    expect(call(fetch, 0)).toMatchObject({
      url: 'https://api.github.com/user',
      method: 'GET',
      headers: API_HEADERS,
    });
  });

  it('lists the repositories the account can push to, every page, by name', async () => {
    const page2 = 'https://api.github.com/user/repos?per_page=100&page=2';
    const fetch = stubFetch(
      json(
        [
          { full_name: 'ken/zeta', private: false, permissions: { push: true } },
          { full_name: 'other/read-only', private: false, permissions: { push: false } },
        ],
        { headers: { link: `<${page2}>; rel="next", <${page2}>; rel="last"` } },
      ),
      json([{ full_name: 'Ken/Alpha', private: true, permissions: { push: true } }]),
    );
    expect(await new HttpGitHub(config, fetch).repos('gho_token')).toEqual([
      { fullName: 'Ken/Alpha', private: true },
      { fullName: 'ken/zeta', private: false },
    ]);
    expect(call(fetch, 0)).toMatchObject({
      url: 'https://api.github.com/user/repos?per_page=100&sort=full_name&affiliation=owner%2Ccollaborator%2Corganization_member',
      headers: API_HEADERS,
    });
    expect(call(fetch, 1).url).toBe(page2);
  });

  it('says when GitHub no longer accepts the token', async () => {
    const github = new HttpGitHub(
      config,
      stubFetch(json({ message: 'Bad credentials' }, { status: 401 })),
    );
    await expect(github.user('gho_token')).rejects.toThrow(
      new GitHubError('GitHub no longer accepts this link: link the account again'),
    );
  });

  it('revokes a token with the app credentials', async () => {
    const fetch = stubFetch(new Response(null, { status: 204 }));
    await new HttpGitHub(config, fetch).revoke('gho_token');
    expect(call(fetch, 0)).toEqual({
      url: 'https://api.github.com/applications/Iv1.client/token',
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Basic ${Buffer.from('Iv1.client:shh').toString('base64')}`,
        'content-type': 'application/json',
        'user-agent': 'ct-studio',
        'x-github-api-version': '2022-11-28',
      },
      body: { access_token: 'gho_token' },
    });
  });
});
