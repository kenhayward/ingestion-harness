import { describe, expect, it } from 'vitest';
import { decryptSecret, type SecretsKeys } from '../src/llm/secrets.js';
import { MemoryProfileRepo } from '../src/profile/repo.js';
import { FakeGitHub } from './fake-github.js';
import { accessApp, signInNewUser } from './helpers.js';

const keys: SecretsKeys = { current: Buffer.alloc(32, 7), previous: null };
const REDIRECT = 'https://ct.example/api/profile/github/callback';
const ken = { id: 101, login: 'kenhayward', avatarUrl: 'https://avatars.example/u/101' };

async function setup(opts: { github?: boolean; secrets?: boolean } = {}) {
  const github = new FakeGitHub();
  const profiles = new MemoryProfileRepo();
  const ctx = await accessApp({
    profiles,
    github: opts.github === false ? null : github,
    githubRedirectUrl: REDIRECT,
    llmSecrets: opts.secrets === false ? null : keys,
  });
  const me = await signInNewUser(ctx.app, ctx.access, 'Ken Hayward');
  return { ...ctx, github, profiles, cookie: me.cookie, userId: me.user.id };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const stateCookie = (res: { headers: Record<string, unknown> }) => {
  const raw = res.headers['set-cookie'];
  const header = (Array.isArray(raw) ? raw : [String(raw ?? '')]).find((c) =>
    c.startsWith('ih_github_state='),
  );
  return header ?? '';
};

/** Connect, then come back from GitHub with `code` (or GitHub's `error`). */
async function link(ctx: Ctx, code: string, opts: { cookie?: string; error?: string } = {}) {
  const start = await ctx.app.inject({
    method: 'GET',
    url: '/api/profile/github/connect',
    headers: { cookie: opts.cookie ?? ctx.cookie },
  });
  expect(start.statusCode).toBe(302);
  const state = new URL(String(start.headers.location)).searchParams.get('state')!;
  const query = opts.error ? `error=${opts.error}&state=${state}` : `code=${code}&state=${state}`;
  // From github.com: the SameSite=Strict session cookie is not sent, only the Lax state cookie.
  const back = await ctx.app.inject({
    method: 'GET',
    url: `/api/profile/github/callback?${query}`,
    headers: { cookie: stateCookie(start).split(';')[0]! },
  });
  return { start, back, state };
}

const get = (ctx: Ctx, url: string, cookie = ctx.cookie) =>
  ctx.app.inject({ method: 'GET', url, headers: { cookie } });
const put = (ctx: Ctx, url: string, payload: object, cookie = ctx.cookie) =>
  ctx.app.inject({ method: 'PUT', url, headers: { cookie }, payload });

describe('profile details', () => {
  it('starts with the name and email and nothing else', async () => {
    const ctx = await setup();
    const res = await get(ctx, '/api/profile');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'Ken Hayward',
      email: 'ken-hayward@example.test',
      jobTitle: null,
      company: null,
      linkedin: null,
      github: null,
      githubAvailable: true,
    });
  });

  it.each([
    ['no OAuth app', { github: false }],
    ['no secrets key to keep the token', { secrets: false }],
  ])('says GitHub linking is unavailable with %s', async (_why, opts) => {
    const ctx = await setup(opts);
    expect((await get(ctx, '/api/profile')).json().githubAvailable).toBe(false);
    const res = await get(ctx, '/api/profile/github/connect');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      'GitHub linking is not set up: an admin sets GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and LLM_SECRETS_KEY',
    );
  });

  it('saves the details and renames the user', async () => {
    const ctx = await setup();
    const res = await put(ctx, '/api/profile', {
      name: 'Ken H',
      jobTitle: 'Engineer',
      company: ' Acme ',
      linkedin: 'https://www.linkedin.com/in/ken-hayward/',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'Ken H',
      jobTitle: 'Engineer',
      company: 'Acme',
      linkedin: 'ken-hayward',
    });
    expect((await get(ctx, '/api/auth/me')).json().label).toBe('Ken H');
    expect((await get(ctx, '/api/profile')).json()).toMatchObject({ company: 'Acme' });
  });

  it('refuses a name another user has, and a LinkedIn name that is not one', async () => {
    const ctx = await setup();
    await signInNewUser(ctx.app, ctx.access, 'Ada');
    const body = { name: 'ada', jobTitle: null, company: null, linkedin: null };
    const taken = await put(ctx, '/api/profile', body);
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe('a user with this name already exists');
    const bad = await put(ctx, '/api/profile', { ...body, name: 'Ken', linkedin: 'not a name' });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json().error)).toContain('linkedin.com/in/<name>');
    expect((await get(ctx, '/api/profile')).json().name).toBe('Ken Hayward');
  });

  it('has no profile for the admin from the API log', async () => {
    const ctx = await setup();
    for (const res of [
      await get(ctx, '/api/profile', ctx.adminCookie),
      await put(
        ctx,
        '/api/profile',
        { name: 'X', jobTitle: null, company: null, linkedin: null },
        ctx.adminCookie,
      ),
      await get(ctx, '/api/profile/github/connect', ctx.adminCookie),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('the admin from the API log has no profile');
    }
  });
});

describe('linking GitHub', () => {
  it('sends the user to GitHub with a state kept in a Lax cookie for 10 minutes', async () => {
    const ctx = await setup();
    const res = await get(ctx, '/api/profile/github/connect');
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.searchParams.get('redirect_uri')).toBe(REDIRECT);
    const state = location.searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = stateCookie(res);
    expect(cookie).toContain(`ih_github_state=${state}`);
    expect(cookie).toContain('Path=/api/profile/github');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
  });

  it('defaults the callback address to the one the request came to', async () => {
    const { app, access } = await accessApp({
      github: new FakeGitHub(),
      llmSecrets: keys,
      profiles: new MemoryProfileRepo(),
    });
    const { cookie } = await signInNewUser(app, access, 'Other');
    const res = await app.inject({
      method: 'GET',
      url: '/api/profile/github/connect',
      headers: { cookie, host: 'ct.lan:8080', 'x-forwarded-proto': 'https' },
    });
    expect(new URL(String(res.headers.location)).searchParams.get('redirect_uri')).toBe(
      'https://ct.lan:8080/api/profile/github/callback',
    );
  });

  it('links the account from the callback and shows its picture as the user', async () => {
    const ctx = await setup();
    const token = ctx.github.account('c0de', ken);
    const { back } = await link(ctx, 'c0de');
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/#/account/profile/github?github=linked');
    expect(stateCookie(back)).toMatch(/^ih_github_state=;/);
    expect(ctx.github.exchanges).toEqual([{ code: 'c0de', redirectUri: REDIRECT }]);
    expect((await get(ctx, '/api/profile')).json().github).toEqual({
      login: 'kenhayward',
      avatarUrl: ken.avatarUrl,
      linkedAt: expect.any(String),
      repo: null,
    });
    expect((await get(ctx, '/api/auth/me')).json().avatarUrl).toBe(ken.avatarUrl);
    // The token is kept encrypted.
    const stored = (await ctx.profiles.get(ctx.userId)).github!.tokenEnc;
    expect(stored).toMatch(/^v1:/);
    expect(decryptSecret(stored, keys)).toBe(token);
  });

  it.each<[string, { code?: string; error?: string }, string]>([
    ['GitHub said no', { error: 'access_denied' }, 'denied'],
    ['GitHub refused the code', { code: 'unknown' }, 'failed'],
  ])('comes back without linking when %s', async (_why, opts, result) => {
    const ctx = await setup();
    const { back } = await link(ctx, opts.code ?? '', { error: opts.error });
    expect(back.headers.location).toBe(`/#/account/profile/github?github=${result}`);
    expect((await get(ctx, '/api/profile')).json().github).toBeNull();
  });

  it('refuses a callback whose state is not this browser’s, or used already', async () => {
    const ctx = await setup();
    ctx.github.account('c0de', ken);
    const start = await get(ctx, '/api/profile/github/connect');
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const callback = (cookie: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/profile/github/callback?code=c0de&state=${state}`,
        headers: { cookie },
      });
    // Another browser (no state cookie, or another one) cannot finish this link.
    for (const cookie of ['', 'ih_github_state=someone-else']) {
      expect((await callback(cookie)).headers.location).toBe(
        '/#/account/profile/github?github=expired',
      );
    }
    expect(ctx.github.exchanges).toEqual([]);
    const ours = `ih_github_state=${state}`;
    expect((await callback(ours)).headers.location).toBe('/#/account/profile/github?github=linked');
    expect((await callback(ours)).headers.location).toBe(
      '/#/account/profile/github?github=expired',
    );
  });

  it('gives one GitHub account to one user', async () => {
    const ctx = await setup();
    ctx.github.account('first', ken);
    await link(ctx, 'first');
    const ada = await signInNewUser(ctx.app, ctx.access, 'Ada');
    ctx.github.account('second', ken);
    const { back } = await link(ctx, 'second', { cookie: ada.cookie });
    expect(back.headers.location).toBe('/#/account/profile/github?github=taken');
    expect((await get(ctx, '/api/profile', ada.cookie)).json().github).toBeNull();
    // Not revoked: GitHub may have handed back the token Ken's link still uses.
    expect(ctx.github.revoked).toEqual([]);
  });

  it('unlinks: the token is revoked and the picture goes', async () => {
    const ctx = await setup();
    const token = ctx.github.account('c0de', ken);
    await link(ctx, 'c0de');
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/profile/github',
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(ctx.github.revoked).toEqual([token]);
    expect((await get(ctx, '/api/profile')).json().github).toBeNull();
    expect((await get(ctx, '/api/auth/me')).json().avatarUrl).toBeNull();
  });

  it('unlinks even when GitHub cannot revoke the token', async () => {
    const ctx = await setup();
    ctx.github.account('c0de', ken);
    await link(ctx, 'c0de');
    ctx.github.failRevoke = true;
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/profile/github',
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(204);
    expect((await get(ctx, '/api/profile')).json().github).toBeNull();
  });
});

describe('the YAML repository', () => {
  const repos = [
    { fullName: 'kenhayward/CT-Recipes', private: true },
    { fullName: 'acme/shared', private: false },
  ];

  it('lists the repositories the account can push to', async () => {
    const ctx = await setup();
    ctx.github.account('c0de', ken, repos);
    await link(ctx, 'c0de');
    const res = await get(ctx, '/api/profile/github/repos');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(repos);
  });

  it('keeps a repository the account can push to, spelled as GitHub spells it', async () => {
    const ctx = await setup();
    ctx.github.account('c0de', ken, repos);
    await link(ctx, 'c0de');
    const res = await put(ctx, '/api/profile/github/repo', { repo: 'kenhayward/ct-recipes' });
    expect(res.statusCode).toBe(200);
    expect(res.json().github.repo).toBe('kenhayward/CT-Recipes');
    const cleared = await put(ctx, '/api/profile/github/repo', { repo: null });
    expect(cleared.json().github.repo).toBeNull();
  });

  it('refuses a repository the account cannot push to', async () => {
    const ctx = await setup();
    ctx.github.account('c0de', ken, repos);
    await link(ctx, 'c0de');
    const res = await put(ctx, '/api/profile/github/repo', { repo: 'other/thing' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('kenhayward cannot push to other/thing on GitHub');
  });

  it('needs a linked account', async () => {
    const ctx = await setup();
    for (const res of [
      await get(ctx, '/api/profile/github/repos'),
      await put(ctx, '/api/profile/github/repo', { repo: 'kenhayward/recipes' }),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('link a GitHub account first');
    }
  });

  it('passes on what GitHub said when it no longer accepts the link', async () => {
    const ctx = await setup();
    const token = ctx.github.account('c0de', ken, repos);
    await link(ctx, 'c0de');
    ctx.github.repoLists.delete(token);
    const res = await get(ctx, '/api/profile/github/repos');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe(
      'GitHub no longer accepts this link: link the account again in Profile',
    );
  });
});
