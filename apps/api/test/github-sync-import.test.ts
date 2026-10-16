import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { RecipeFile } from '@ih/shared';
import { definitionSha256, recipeFileYaml } from '../src/github-sync/file.js';
import { listRemote } from '../src/github-sync/remote.js';
import { MemoryGitHubSyncRepo } from '../src/github-sync/repo.js';
import { encryptSecret, type SecretsKeys } from '../src/llm/secrets.js';
import { MemoryProfileRepo } from '../src/profile/repo.js';
import { FakeGitHubRepos } from './fake-github-repos.js';
import { accessApp, signInNewUser } from './helpers.js';

const keys: SecretsKeys = { current: Buffer.alloc(32, 7), previous: null };
const REPO = 'acme/recipes';
const TOKEN = 'gho_ken';
const ROOT = 'ct-studio';

const invoice = (version = 1, id = 'invoice') => ({
  id,
  version,
  name: 'Invoice',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: 'total', type: 'decimal' }] },
  pipeline: [{ type: 'extract', id: 'head', fields: ['total'], sections: ['all'] }],
});

function file(instance: string, definition: Record<string, unknown>, label: string | null = null) {
  const f: RecipeFile = {
    format: 'ct-recipe',
    formatVersion: 1,
    instance,
    version: {
      number: definition.version as number,
      status: 'published',
      label,
      note: label ? 'a note' : null,
      labelSetBy: 'Pat Prod',
      labelSetAt: '2026-10-02T00:00:00.000Z',
      publishedBy: 'Pat Prod',
      publishedAt: '2026-10-01T00:00:00.000Z',
      basedOn: null,
      importedFrom: null,
      definitionSha256: definitionSha256(definition),
    },
    definition,
  };
  return recipeFileYaml(f);
}

async function setup() {
  const github = new FakeGitHubRepos();
  github.addRepo(REPO, { token: TOKEN, permission: 'push' });
  github.addRepo('acme/other', { token: 'someone-else', permission: 'push' });
  const githubSync = new MemoryGitHubSyncRepo();
  const profiles = new MemoryProfileRepo();
  const ctx = await accessApp({ githubRepos: github, githubSync, profiles, llmSecrets: keys });
  const ken = await signInNewUser(ctx.app, ctx.access, 'Ken Hayward');
  await profiles.linkGitHub(ken.user.id, {
    id: 1,
    login: 'ken',
    avatarUrl: 'https://avatars.example/1',
    tokenEnc: encryptSecret(TOKEN, keys),
  });
  const admin = await signInNewUser(ctx.app, ctx.access, 'Ada Admin', 'admin');
  await profiles.linkGitHub(admin.user.id, {
    id: 2,
    login: 'ada',
    avatarUrl: 'https://avatars.example/2',
    tokenEnc: encryptSecret(TOKEN, keys),
  });
  const head = github.seed(REPO, 'main', {
    [`${ROOT}/prod/invoice/v3.yaml`]: file('prod', invoice(3), 'Best'),
    [`${ROOT}/prod/memo/v1.yaml`]: file('prod', invoice(1, 'memo')),
  });
  const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    ctx.app.inject({ method, url, headers: { cookie }, payload });
  return { ...ctx, github, githubSync, ken, admin, head, call };
}

const body = (head: string, over: Record<string, unknown> = {}) => ({
  repo: REPO,
  branch: 'main',
  path: `${ROOT}/prod/invoice/v3.yaml`,
  commit: head,
  link: false,
  ...over,
});

describe('GET /api/github/repos and /browse', () => {
  it('lists the repositories the account can read, and a root', async () => {
    const c = await setup();
    const repos = await c.call(c.ken.cookie, 'GET', '/api/github/repos');
    expect(repos.statusCode).toBe(200);
    expect(repos.json().map((r: { fullName: string }) => r.fullName)).toEqual([REPO]);
    const browse = await c.call(
      c.ken.cookie,
      'GET',
      `/api/github/browse?repo=${REPO}&branch=main&root=${ROOT}`,
    );
    expect(browse.statusCode).toBe(200);
    expect(browse.json().versions.map((v: { typeId: string }) => v.typeId)).toEqual([
      'invoice',
      'memo',
    ]);
  });

  it('asks an unlinked user to link their account', async () => {
    const c = await setup();
    const other = await signInNewUser(c.app, c.access, 'No Link');
    const res = await c.call(other.cookie, 'GET', '/api/github/repos');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Link your GitHub account in Profile to pull.');
  });
});

describe('repository and branch names', () => {
  it.each([
    ['repo', '../..'],
    ['branch', '../..'],
    ['branch', '../tags/v1'],
  ])('browse refuses the %s %j', async (key, value) => {
    const c = await setup();
    const q = new URLSearchParams({ repo: REPO, branch: 'main', root: ROOT, [key]: value });
    const res = await c.call(c.ken.cookie, 'GET', `/api/github/browse?${q}`);
    expect(res.statusCode).toBe(400);
  });

  it.each([
    ['repo', '../..'],
    ['branch', '../tags/v1'],
  ])('import refuses the %s %j', async (key, value) => {
    const c = await setup();
    const res = await c.call(
      c.ken.cookie,
      'POST',
      '/api/github/import',
      body(c.head, { [key]: value }),
    );
    expect(res.statusCode).toBe(400);
    expect(await c.templates.list()).toEqual([]);
  });
});

describe('a GitHub that cannot be reached', () => {
  it('is a 502 for repositories, browsing and importing', async () => {
    const c = await setup();
    c.github.unreachable = true;
    for (const [method, url, payload] of [
      ['GET', '/api/github/repos', undefined],
      ['GET', `/api/github/browse?repo=${REPO}&branch=main&root=${ROOT}`, undefined],
      ['POST', '/api/github/import', body(c.head)],
    ] as const) {
      const res = await c.call(c.ken.cookie, method, url, payload);
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('GitHub could not be reached: fetch failed');
    }
    expect(await c.templates.list()).toEqual([]);
  });
});

describe('POST /api/github/import', () => {
  it('creates a v1 draft with the label and a change entry naming the commit', async () => {
    const c = await setup();
    const res = await c.call(c.ken.cookie, 'POST', '/api/github/import', body(c.head));
    expect(res.statusCode).toBe(201);
    expect(res.json().record).toMatchObject({
      id: 'invoice',
      version: 1,
      status: 'draft',
      label: 'Best',
      note: 'a note',
    });
    expect(res.json().record.definition).toMatchObject({ id: 'invoice', version: 1 });
    expect(res.json().linked).toBe(false);
    const [change] = await c.templates.listChanges('invoice', 1);
    expect(change).toMatchObject({
      source: 'import',
      summary: `Imported from GitHub: prod/invoice v3 @ ${c.head.slice(0, 7)}`,
    });
  });

  it('takes the new id and name from the body', async () => {
    const c = await setup();
    const res = await c.call(
      c.ken.cookie,
      'POST',
      '/api/github/import',
      body(c.head, { id: 'bill', name: 'Bill' }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().record.id).toBe('bill');
    expect(res.json().record.definition).toMatchObject({ id: 'bill', version: 1, name: 'Bill' });
  });

  it('refuses an id that already exists, naming the way out', async () => {
    const c = await setup();
    await c.templates.create('invoice', 1, invoice(1), 'published');
    const res = await c.call(c.ken.cookie, 'POST', '/api/github/import', body(c.head));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      'invoice already exists: pull into it from its Versions tab, or import under another id',
    );
  });

  it('refuses a retired id', async () => {
    const c = await setup();
    await c.templates.create('invoice', 1, invoice(1), 'published');
    await c.templates.retire('invoice', 'Admin');
    const res = await c.call(c.ken.cookie, 'POST', '/api/github/import', body(c.head));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/retired/);
  });

  it('links the type for an admin who asks, with the repo, branch and root of the file', async () => {
    const c = await setup();
    const res = await c.call(
      c.admin.cookie,
      'POST',
      '/api/github/import',
      body(c.head, { link: true }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().linked).toBe(true);
    expect(await c.githubSync.link('invoice')).toMatchObject({
      repo: REPO,
      branch: 'main',
      root: ROOT,
      alwaysPr: false,
      pushOnPublish: true,
    });
  });

  it('creates but does not link for a user who is not an admin', async () => {
    const c = await setup();
    const res = await c.call(
      c.ken.cookie,
      'POST',
      '/api/github/import',
      body(c.head, { link: true }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().linked).toBe(false);
    expect(await c.githubSync.link('invoice')).toBeNull();
  });

  it('answers 409 for a file that is not there, and for a revoked token', async () => {
    const c = await setup();
    const missing = await c.call(
      c.ken.cookie,
      'POST',
      '/api/github/import',
      body(c.head, { path: `${ROOT}/prod/invoice/v9.yaml` }),
    );
    expect(missing.statusCode).toBe(409);
    c.github.revoked.add(TOKEN);
    const revoked = await c.call(c.ken.cookie, 'POST', '/api/github/import', body(c.head));
    expect(revoked.statusCode).toBe(409);
    expect(await c.templates.list()).toEqual([]);
  });

  it.each([`${ROOT}/prod/Bad Id/v1.yaml`, `${ROOT}/Bad_Inst/invoice/v1.yaml`])(
    'refuses a path with an invalid folder name: %s',
    async (path) => {
      const c = await setup();
      const res = await c.call(c.ken.cookie, 'POST', '/api/github/import', body(c.head, { path }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('path must be <root>/<instance>/<type-id>/v<N>.yaml');
      expect(await c.templates.list()).toEqual([]);
    },
  );

  it('refuses a path that is not <root>/<instance>/<type>/v<N>.yaml', async () => {
    const c = await setup();
    const res = await c.call(
      c.ken.cookie,
      'POST',
      '/api/github/import',
      body(c.head, { path: 'invoice/v3.yaml' }),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('provenance and linking', () => {
  it('records the origin, and a published push carries it into the file', async () => {
    const c = await setup();
    const res = await c.call(
      c.admin.cookie,
      'POST',
      '/api/github/import',
      body(c.head, { link: true }),
    );
    expect(res.json().record.importedFrom).toEqual({
      instance: 'prod',
      typeId: 'invoice',
      version: 3,
      commit: c.head,
    });
    const published = await c.call(
      c.admin.cookie,
      'POST',
      '/api/templates/invoice/versions/1/publish',
      {},
    );
    expect(published.statusCode).toBe(200);
    expect(published.json().github).toMatchObject({ kind: 'pushed' });
    const pushed = Object.entries(c.github.files(REPO, 'main')).find(([p]) =>
      p.endsWith('/invoice/v1.yaml'),
    )![1];
    expect(parseYaml(pushed).version.importedFrom).toEqual({
      instance: 'prod',
      typeId: 'invoice',
      version: 3,
      commit: c.head,
    });
  });

  it('still answers 201, not linked, when storing the link fails', async () => {
    const c = await setup();
    c.githubSync.setLink = async () => {
      throw new Error('database is down');
    };
    const res = await c.call(
      c.admin.cookie,
      'POST',
      '/api/github/import',
      body(c.head, { link: true }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().linked).toBe(false);
    expect((await c.templates.get('invoice', 1))?.status).toBe('draft');
  });
});

describe('listRemote reads', () => {
  it('never has more than 8 reads in flight', async () => {
    const github = new FakeGitHubRepos();
    github.addRepo(REPO, { token: TOKEN, permission: 'push' });
    const files: Record<string, string> = {};
    for (let n = 1; n <= 30; n++) {
      files[`${ROOT}/prod/invoice/v${n}.yaml`] = file('prod', invoice(n));
    }
    github.seed(REPO, 'main', files);
    let live = 0;
    let peak = 0;
    const read = github.readFile.bind(github);
    github.readFile = async (...args: Parameters<typeof read>) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      try {
        return await read(...args);
      } finally {
        live--;
      }
    };
    const githubSync = new MemoryGitHubSyncRepo();
    const listing = await listRemote(
      { githubRepos: github, githubSync },
      { token: TOKEN, repo: REPO, branch: 'main', root: ROOT },
    );
    expect(listing.versions).toHaveLength(30);
    expect(peak).toBeLessThanOrEqual(8);
    expect(listing.versions.map((v) => v.version)).toEqual(
      Array.from({ length: 30 }, (_, i) => 30 - i),
    );
  });
});
