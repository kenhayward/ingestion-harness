import { describe, expect, it } from 'vitest';
import { encryptSecret, type SecretsKeys } from '../src/llm/secrets.js';
import { MemoryProfileRepo } from '../src/profile/repo.js';
import { FakeGitHubRepos } from './fake-github-repos.js';
import { accessApp, signInNewUser } from './helpers.js';

const keys: SecretsKeys = { current: Buffer.alloc(32, 7), previous: null };
const REPO = 'acme/recipes';
const ADMIN_TOKEN = 'gho_admin';
const USER_TOKEN = 'gho_user';

const invoice = (version = 1) => ({
  id: 'invoice',
  version,
  name: 'Invoice',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: 'total', type: 'decimal' }] },
  pipeline: [{ type: 'extract', id: 'head', fields: ['total'], sections: ['all'] }],
});

const link = {
  repo: REPO,
  branch: 'main',
  root: 'ct-studio',
  alwaysPr: false,
  pushOnPublish: false,
};

async function setup() {
  const github = new FakeGitHubRepos();
  github.addRepo(REPO, { token: ADMIN_TOKEN, permission: 'push' });
  github.addRepo(REPO, { token: USER_TOKEN, permission: 'push' });
  const profiles = new MemoryProfileRepo();
  const ctx = await accessApp({ githubRepos: github, profiles, llmSecrets: keys });
  const admin = await signInNewUser(ctx.app, ctx.access, 'Alice Admin', 'admin');
  const user = await signInNewUser(ctx.app, ctx.access, 'Ursula User');
  const linkAccount = (id: string, login: string, token: string, ghId: number) =>
    profiles.linkGitHub(id, {
      id: ghId,
      login,
      avatarUrl: 'https://avatars.example/1',
      tokenEnc: encryptSecret(token, keys),
    });
  await linkAccount(admin.user.id, 'alice', ADMIN_TOKEN, 1);
  await linkAccount(user.user.id, 'ursula', USER_TOKEN, 2);
  await ctx.templates.create('invoice', 1, invoice(1), 'draft');
  await ctx.templates.publish('invoice', 1, 'Alice Admin');
  await ctx.templates.create('invoice', 2, invoice(2), 'draft');
  const call = (
    method: 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'POST',
    url: string,
    cookie: string,
    payload?: object,
  ) => ctx.app.inject({ method, url, headers: { cookie }, payload });
  return { ...ctx, github, profiles, admin, user, call };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const STATUS = '/api/templates/invoice/github';
const linkIt = (c: Ctx, over: object = {}) =>
  c.call('PUT', STATUS, c.admin.cookie, { ...link, ...over });
const pushV1 = (c: Ctx, cookie = c.user.cookie) =>
  c.call('POST', '/api/templates/invoice/versions/1/github/push', cookie);
type Row = { version: number; state: string; pushedBy: string | null };
const statusOf = async (c: Ctx, cookie = c.user.cookie) =>
  (await c.call('GET', STATUS, cookie)).json() as {
    versions: Row[];
    canPush: boolean;
    reason: string | null;
    link: { repo: string } | null;
  };
const row = (s: { versions: Row[] }, v: number) => s.versions.find((r) => r.version === v)!;

describe('sync settings', () => {
  it('are admin only', async () => {
    const c = await setup();
    expect((await c.call('GET', '/api/github/settings', c.user.cookie)).statusCode).toBe(403);
    const res = await c.call('PUT', '/api/github/settings', c.user.cookie, {
      instanceName: 'x',
      defaultRoot: 'ct-studio',
    });
    expect(res.statusCode).toBe(403);
  });

  it('are read, renamed and locked after a push', async () => {
    const c = await setup();
    const read = await c.call('GET', '/api/github/settings', c.admin.cookie);
    expect(read.statusCode).toBe(200);
    expect(read.json().locked).toBe(false);
    const renamed = await c.call('PUT', '/api/github/settings', c.admin.cookie, {
      instanceName: 'production',
      defaultRoot: 'ct-studio',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().instanceName).toBe('production');
    await linkIt(c);
    expect((await pushV1(c)).statusCode).toBe(200);
    const locked = await c.call('PUT', '/api/github/settings', c.admin.cookie, {
      instanceName: 'other',
      defaultRoot: 'ct-studio',
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toBe(
      'the instance name is fixed once this deployment has pushed to GitHub',
    );
  });
});

describe('link', () => {
  it('is set and removed by an admin only', async () => {
    const c = await setup();
    expect((await c.call('PUT', STATUS, c.user.cookie, link)).statusCode).toBe(403);
    expect((await c.call('DELETE', STATUS, c.user.cookie)).statusCode).toBe(403);
  });

  it('is saved, read by any user and removed', async () => {
    const c = await setup();
    const saved = await linkIt(c);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().repo).toBe(REPO);
    expect((await statusOf(c)).link?.repo).toBe(REPO);
    expect((await c.call('DELETE', STATUS, c.admin.cookie)).statusCode).toBe(204);
    expect((await statusOf(c)).link).toBe(null);
  });

  it('refuses a repository the admin cannot read', async () => {
    const c = await setup();
    const res = await linkIt(c, { repo: 'acme/secret' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('acme/secret is not a repository your GitHub account can read');
  });

  it('is a 404 for an unknown document type', async () => {
    const c = await setup();
    const res = await c.call('PUT', '/api/templates/nope/github', c.admin.cookie, link);
    expect(res.statusCode).toBe(404);
  });
});

describe('push and status', () => {
  it('pushes with the pushing user own token', async () => {
    const c = await setup();
    await linkIt(c);
    const res = await pushV1(c);
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBeUndefined();
    expect(res.json()).toMatchObject({ kind: 'pushed' });
    expect(c.github.commits.at(-1)!.token).toBe(USER_TOKEN);
  });

  it('answers 404 for an unknown version', async () => {
    const c = await setup();
    await linkIt(c);
    const res = await c.call(
      'POST',
      '/api/templates/invoice/versions/9/github/push',
      c.user.cookie,
    );
    expect(res.statusCode).toBe(404);
  });

  it('answers 409 when the folder belongs to another deployment', async () => {
    const c = await setup();
    await linkIt(c);
    c.github.seed(REPO, 'main', {
      'ct-studio/default/instance.yaml': 'instanceId: someone-else\nname: default\n',
    });
    const res = await pushV1(c);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('belongs to another CT Studio deployment');
  });

  it('lists every version with its state', async () => {
    const c = await setup();
    await linkIt(c);
    let status = await statusOf(c);
    expect(status.versions.map((v) => [v.version, v.state])).toEqual([
      [2, 'absent'],
      [1, 'absent'],
    ]);
    expect(status.canPush).toBe(true);
    await pushV1(c);
    status = await statusOf(c);
    expect(row(status, 1).state).toBe('on');
    expect(row(status, 1).pushedBy).toBe('Ursula User');
    await c.call('PATCH', '/api/templates/invoice/versions/1', c.admin.cookie, { label: 'First' });
    expect(row(await statusOf(c), 1).state).toBe('label');
  });

  it('shows a pull request, then follows it once merged', async () => {
    const c = await setup();
    await linkIt(c, { alwaysPr: true });
    const pushed = (await pushV1(c)).json();
    expect(pushed.kind).toBe('pr');
    expect(row(await statusOf(c), 1).state).toBe('pr');
    c.github.setPullRequestState(REPO, pushed.prNumber, 'merged');
    expect(row(await statusOf(c), 1).state).toBe('on');
  });

  it('says why a user cannot push', async () => {
    const c = await setup();
    const bare = await signInNewUser(c.app, c.access, 'Nolink User');
    expect(await statusOf(c)).toMatchObject({
      canPush: false,
      reason: expect.stringContaining('not linked'),
    });
    await linkIt(c);
    c.github.grant(REPO, USER_TOKEN, 'read');
    expect((await statusOf(c)).reason).toBe(
      'Your GitHub account can read acme/recipes but not push to it.',
    );
    expect(await statusOf(c, bare.cookie)).toMatchObject({
      canPush: false,
      reason: 'Link your GitHub account in Profile to push.',
    });
  });
});
