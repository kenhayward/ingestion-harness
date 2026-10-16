import { describe, expect, it } from 'vitest';
import { stringify as toYaml } from 'yaml';
import type { RecipeFile } from '@ih/shared';
import { definitionSha256, recipeFileYaml } from '../src/github-sync/file.js';
import { MemoryGitHubSyncRepo } from '../src/github-sync/repo.js';
import { listRemote } from '../src/github-sync/remote.js';
import { encryptSecret, type SecretsKeys } from '../src/llm/secrets.js';
import { MemoryProfileRepo } from '../src/profile/repo.js';
import { FakeGitHubRepos, fakeBlobSha } from './fake-github-repos.js';
import { accessApp, signInNewUser } from './helpers.js';

const keys: SecretsKeys = { current: Buffer.alloc(32, 7), previous: null };
const REPO = 'acme/recipes';
const TOKEN = 'gho_ken';
const ROOT = 'ct-studio';
const STALE = 'the draft changed since you opened it; reload it to see the changes';

const invoice = (version = 1, total = 'decimal') => ({
  id: 'invoice',
  version,
  name: 'Invoice',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: 'total', type: total }] },
  pipeline: [{ type: 'extract', id: 'head', fields: ['total'], sections: ['all'] }],
});

/** A recipe file as another deployment (or this one) would have pushed it. */
function file(
  instance: string,
  definition: Record<string, unknown>,
  over: Partial<RecipeFile['version']> = {},
): string {
  const f: RecipeFile = {
    format: 'ct-recipe',
    formatVersion: 1,
    instance,
    version: {
      number: definition.version as number,
      status: 'published',
      label: null,
      note: null,
      labelSetBy: null,
      labelSetAt: null,
      publishedBy: 'Someone',
      publishedAt: '2026-10-01T00:00:00.000Z',
      basedOn: null,
      importedFrom: null,
      definitionSha256: definitionSha256(definition),
      ...over,
    },
    definition,
  };
  return recipeFileYaml(f);
}

const path = (instance: string, typeId: string, name: string) =>
  `${ROOT}/${instance}/${typeId}/${name}`;
const instanceYaml = (id: string, name: string) =>
  toYaml({ instanceId: id, name, url: 'https://x.example' });

async function setup() {
  const github = new FakeGitHubRepos();
  github.addRepo(REPO, { token: TOKEN, permission: 'push' });
  const githubSync = new MemoryGitHubSyncRepo();
  await githubSync.setSettings({ instanceName: 'ken-dev', defaultRoot: ROOT }, 'admin');
  const { instanceId } = await githubSync.settings();
  await githubSync.setLink(
    'invoice',
    { repo: REPO, branch: 'main', root: ROOT, alwaysPr: false, pushOnPublish: false },
    'admin',
  );
  const profiles = new MemoryProfileRepo();
  const ctx = await accessApp({ githubRepos: github, githubSync, profiles, llmSecrets: keys });
  const ken = await signInNewUser(ctx.app, ctx.access, 'Ken Hayward');
  await profiles.linkGitHub(ken.user.id, {
    id: 1,
    login: 'ken',
    avatarUrl: 'https://avatars.example/1',
    tokenEnc: encryptSecret(TOKEN, keys),
  });

  // Here: v1 and v2 published (v2 labelled), v3 published, v4 an open draft.
  for (const n of [1, 2, 3]) {
    await ctx.templates.create('invoice', n, invoice(n), 'draft');
    await ctx.templates.publish('invoice', n, 'Ken Hayward');
  }
  await ctx.templates.setLabel('invoice', 2, { label: 'Q3', note: 'third quarter' }, 'Ken');
  await ctx.templates.create('invoice', 4, invoice(4), 'draft');

  const head = github.seed(REPO, 'main', {
    [`${ROOT}/ken-dev/instance.yaml`]: instanceYaml(instanceId, 'ken-dev'),
    [`${ROOT}/prod/instance.yaml`]: instanceYaml('another-deployment', 'prod'),
    // Mine: v1 same, v2 label differs, v3 definition differs, v5 not here.
    [path('ken-dev', 'invoice', 'v1.yaml')]: file('ken-dev', invoice(1)),
    [path('ken-dev', 'invoice', 'v2.yaml')]: file('ken-dev', invoice(2), {
      label: 'Quarter 3',
      note: 'third quarter',
      labelSetBy: 'Ken Hayward',
      labelSetAt: '2026-10-02T00:00:00.000Z',
    }),
    [path('ken-dev', 'invoice', 'v3.yaml')]: file('ken-dev', invoice(3, 'string')),
    [path('ken-dev', 'invoice', 'v5.yaml')]: file('ken-dev', invoice(5)),
    // Another deployment's version of the same type.
    [path('prod', 'invoice', 'v7.yaml')]: file('prod', invoice(7, 'integer'), {
      label: 'Prod best',
      note: 'from production',
      labelSetBy: 'Pat Prod',
    }),
    // Another type: only listed without a type filter.
    [path('prod', 'receipt', 'v1.yaml')]: file('prod', { ...invoice(1), id: 'receipt' }),
    // Not recipes: skipped with a reason, never a 500.
    [path('ken-dev', 'invoice', 'v6.yaml')]: 'format: ct-recipe\n  bad: [indent\n',
    [path('ken-dev', 'invoice', 'v8.yaml')]: 'format: other\nformatVersion: 1\n',
    [path('ken-dev', 'invoice', 'v9.yaml')]:
      'format: ct-recipe\nformatVersion: 2\ninstance: ken-dev\nversion: {}\ndefinition: {}\n',
    [path('ken-dev', 'invoice', 'v4.draft.yaml')]: file('ken-dev', invoice(4)),
    // Says it is v11 of prod, stored as v10 of ken-dev.
    [path('ken-dev', 'invoice', 'v10.yaml')]: file('prod', invoice(11)),
    // Folder names that are not an instance name and a type id.
    [path('Bad_Name', 'invoice', 'v1.yaml')]: file('ken-dev', invoice(1)),
    // Neither a version file nor instance.yaml: ignored.
    [`${ROOT}/README.md`]: '# recipes\n',
  });

  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    ctx.app.inject({ method, url, headers: { cookie: ken.cookie }, payload });
  return { ...ctx, github, githubSync, ken, call, head, instanceId };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

interface Listed {
  instance: string;
  typeId: string;
  version: number;
  mine: boolean;
  commit: string | null;
  label: string | null;
  compare?: string | null;
}

const remote = async (c: Ctx) => {
  const res = await c.call('GET', '/api/templates/invoice/github/remote');
  expect(res.statusCode).toBe(200);
  return res.json() as { versions: Listed[]; skipped: { path: string; reason: string }[] };
};

describe('listRemote', () => {
  it('lists every version file under the root, or only one type', async () => {
    const c = await setup();
    const all = await listRemote(c.app.deps, {
      token: TOKEN,
      repo: REPO,
      branch: 'main',
      root: ROOT,
    });
    expect(all.versions.map((v) => `${v.instance}/${v.typeId}/v${v.version}`).sort()).toEqual([
      'ken-dev/invoice/v1',
      'ken-dev/invoice/v2',
      'ken-dev/invoice/v3',
      'ken-dev/invoice/v5',
      'prod/invoice/v7',
      'prod/receipt/v1',
    ]);
    const one = await listRemote(c.app.deps, {
      token: TOKEN,
      repo: REPO,
      branch: 'main',
      root: ROOT,
      typeId: 'receipt',
    });
    expect(one.versions.map((v) => v.version)).toEqual([1]);
    expect(one.skipped).toEqual([]);
  });
});

describe('GET /api/templates/:id/github/remote', () => {
  it('groups this deployment and others by mine, at the head commit', async () => {
    const c = await setup();
    const { versions } = await remote(c);
    const mine = versions.filter((v) => v.mine).map((v) => v.version);
    const others = versions.filter((v) => !v.mine).map((v) => `${v.instance} v${v.version}`);
    expect(mine.sort((a, b) => a - b)).toEqual([1, 2, 3, 5]);
    expect(others).toEqual(['prod v7']);
    expect(versions.every((v) => v.commit === c.head)).toBe(true);
    expect(versions.find((v) => v.version === 7)!.label).toBe('Prod best');
  });

  it('compares this deployment’s versions: same, label, differs, missing-here', async () => {
    const c = await setup();
    const { versions } = await remote(c);
    const compare = (n: number) => versions.find((v) => v.version === n)!.compare;
    expect(compare(1)).toBe('same');
    expect(compare(2)).toBe('label');
    expect(compare(3)).toBe('differs');
    expect(compare(5)).toBe('missing-here');
    expect(compare(7)).toBe(null);
  });

  it('skips malformed and foreign files with a reason', async () => {
    const c = await setup();
    const { skipped } = await remote(c);
    const reason = (name: string, instance = 'ken-dev') =>
      skipped.find((s) => s.path === path(instance, 'invoice', name))?.reason;
    expect(reason('v6.yaml')).toMatch(/^not valid YAML/);
    expect(reason('v8.yaml')).toBe('not a CT Studio recipe file');
    expect(reason('v9.yaml')).toBe('format version 2 is not supported');
    expect(reason('v4.draft.yaml')).toBe('drafts are not imported yet');
    expect(reason('v10.yaml')).toBe('the file does not match its path');
    expect(reason('v1.yaml', 'Bad_Name')).toBe('the file does not match its path');
    expect(skipped.some((s) => s.path.endsWith('README.md'))).toBe(false);
    expect(skipped.some((s) => s.path.endsWith('instance.yaml'))).toBe(false);
  });

  it('is a 409 without a linked account and a 404 for an unknown type', async () => {
    const c = await setup();
    const other = await signInNewUser(c.app, c.access, 'Una Linked');
    const res = await c.app.inject({
      method: 'GET',
      url: '/api/templates/invoice/github/remote',
      headers: { cookie: other.cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Link your GitHub account in Profile to pull.');
    expect((await c.call('GET', '/api/templates/nope/github/remote')).statusCode).toBe(404);
  });

  it('is a 502 when GitHub cannot be reached', async () => {
    const c = await setup();
    c.github.unreachable = true;
    const res = await c.call('GET', '/api/templates/invoice/github/remote');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('GitHub could not be reached: fetch failed');
  });

  it('says when GitHub no longer accepts the token', async () => {
    const c = await setup();
    c.github.revoked.add(TOKEN);
    const res = await c.call('GET', '/api/templates/invoice/github/remote');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/link the account again in Profile/);
  });
});

describe('take GitHub’s label', () => {
  const take = (c: Ctx, version: number, commit = c.head) =>
    c.call('POST', `/api/templates/invoice/versions/${version}/github/take-label`, { commit });

  it('sets the label and note, set by GitHub: <who set it there>', async () => {
    const c = await setup();
    const res = await take(c, 2);
    expect(res.statusCode).toBe(200);
    const v2 = await c.templates.get('invoice', 2);
    expect(v2).toMatchObject({
      label: 'Quarter 3',
      note: 'third quarter',
      labelSetBy: 'GitHub: Ken Hayward',
    });
    expect(res.json().record.label).toBe('Quarter 3');
    expect((await remote(c)).versions.find((v) => v.version === 2)!.compare).toBe('same');
  });

  it('is a 409 when the definition on GitHub differs', async () => {
    const c = await setup();
    const res = await take(c, 3);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      'v3 on GitHub is a different recipe: published versions never change',
    );
    expect((await c.templates.get('invoice', 3))!.labelSetBy).toBe(null);
  });

  it('records the push against the file it read, so pushing again is not a conflict', async () => {
    const c = await setup();
    const v2 = path('ken-dev', 'invoice', 'v2.yaml');
    // v2 was pushed from here, then its label was edited on GitHub.
    await c.githubSync.recordPush({
      typeId: 'invoice',
      version: 2,
      repo: REPO,
      branch: 'main',
      path: v2,
      commit: 'before-the-edit',
      blobSha: 'blob-before-the-edit',
      labelSha: 'label-before-the-edit',
      prNumber: null,
      prUrl: null,
      prState: null,
      pushedBy: 'Ken Hayward',
      pushedAt: '2026-10-01T00:00:00.000Z',
    });
    expect((await take(c, 2)).statusCode).toBe(200);
    const [record] = (await c.githubSync.pushes('invoice')).filter((p) => p.version === 2);
    expect(record).toMatchObject({
      commit: c.head,
      blobSha: fakeBlobSha(c.github.files(REPO, 'main')[v2]!),
    });
    const status = await c.call('GET', '/api/templates/invoice/github');
    expect(
      (status.json() as { versions: { version: number; state: string }[] }).versions.find(
        (v) => v.version === 2,
      )!.state,
    ).toBe('on');
    const pushed = await c.call('POST', '/api/templates/invoice/versions/2/github/push');
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json().kind).toBe('pushed');
  });

  it('is allowed for a retired type', async () => {
    const c = await setup();
    await c.templates.retire('invoice', 'admin');
    expect((await take(c, 2)).statusCode).toBe(200);
  });
});

describe('use a version as the draft', () => {
  const use = (c: Ctx, body: object) =>
    c.call('POST', '/api/templates/invoice/github/use-as-draft', {
      instance: 'prod',
      typeId: 'invoice',
      version: 7,
      commit: c.head,
      ...body,
    });

  it('replaces the open draft, logs the import and copies the label', async () => {
    const c = await setup();
    const draft = (await c.templates.get('invoice', 4))!;
    const res = await use(c, { baseUpdatedAt: draft.updatedAt });
    expect(res.statusCode).toBe(200);
    const now = (await c.templates.get('invoice', 4))!;
    expect(now.status).toBe('draft');
    expect(now.definition).toEqual(invoice(4, 'integer'));
    expect(now).toMatchObject({
      label: 'Prod best',
      note: 'from production',
      labelSetBy: 'GitHub: Pat Prod',
    });
    expect(now.importedFrom).toEqual({
      instance: 'prod',
      typeId: 'invoice',
      version: 7,
      commit: c.head,
    });
    const [change] = await c.templates.listChanges('invoice', 4);
    expect(change).toMatchObject({
      source: 'import',
      summary: `Imported from GitHub: prod/invoice v7 @ ${c.head.slice(0, 7)}`,
    });
  });

  it('starts the next draft when none is open', async () => {
    const c = await setup();
    await c.templates.deleteDraft('invoice', 4);
    const res = await use(c, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().record).toMatchObject({ version: 4, status: 'draft' });
    expect((await c.templates.get('invoice', 4))!.definition).toEqual(invoice(4, 'integer'));
    const sources = (await c.templates.listChanges('invoice', 4)).map((ch) => ch.source);
    expect(sources).toEqual(['import', 'started']);
  });

  it('is a 409 when the draft changed since it was opened', async () => {
    const c = await setup();
    const res = await use(c, { baseUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(STALE);
    expect((await c.templates.get('invoice', 4))!.definition).toEqual(invoice(4));
  });

  it('is a 409 for a retired type', async () => {
    const c = await setup();
    await c.templates.retire('invoice', 'admin');
    const res = await use(c, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Invoice is retired: unretire it to use it again');
  });

  it('is a 409 for a file that is not on GitHub at that commit', async () => {
    const c = await setup();
    const res = await use(c, { version: 99 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      `${path('prod', 'invoice', 'v99.yaml')} is not on GitHub at ${c.head.slice(0, 7)}`,
    );
  });
});
