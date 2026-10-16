import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { definitionCanonical, type GitHubLinkBody } from '@ih/shared';
import {
  definitionSha256,
  gitBlobSha,
  labelSha,
  parseRecipeFile,
  recipeFileFor,
  recipeFileYaml,
} from '../src/github-sync/file.js';
import { pushVersion, SyncConflict } from '../src/github-sync/push.js';
import { userToken } from '../src/github-sync/token.js';
import { MemoryGitHubSyncRepo } from '../src/github-sync/repo.js';
import { encryptSecret, type SecretsKeys } from '../src/llm/secrets.js';
import { MemoryProfileRepo } from '../src/profile/repo.js';
import { createNextDraft } from '../src/templates/drafts.js';
import { FakeGitHubRepos, fakeBlobSha } from './fake-github-repos.js';
import { testApp } from './helpers.js';

const keys: SecretsKeys = { current: Buffer.alloc(32, 7), previous: null };
const REPO = 'acme/recipes';
const TOKEN = 'gho_ken';
const ken = { id: 'u-ken', name: 'Ken Hayward' };
const ORIGIN = 'https://ct.example';
const ROOT = 'ct-studio';

const invoice = (version = 1) => ({
  id: 'invoice',
  version,
  name: 'Invoice',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: 'total', type: 'decimal' }] },
  pipeline: [{ type: 'extract', id: 'head', fields: ['total'], sections: ['all'] }],
});

const linkBody = (over: Partial<GitHubLinkBody> = {}): GitHubLinkBody => ({
  repo: REPO,
  branch: 'main',
  root: ROOT,
  alwaysPr: false,
  pushOnPublish: true,
  ...over,
});

async function setup(
  opts: {
    link?: Partial<GitHubLinkBody> | null;
    permission?: 'push' | 'read' | 'none';
    linked?: boolean;
    defaultBranch?: string;
    publish?: boolean;
  } = {},
) {
  const github = new FakeGitHubRepos();
  github.addRepo(
    REPO,
    { token: TOKEN, permission: opts.permission ?? 'push' },
    { defaultBranch: opts.defaultBranch ?? 'main' },
  );
  const githubSync = new MemoryGitHubSyncRepo();
  await githubSync.setSettings({ instanceName: 'production', defaultRoot: ROOT }, 'admin');
  if (opts.link !== null) await githubSync.setLink('invoice', linkBody(opts.link ?? {}), 'admin');
  const profiles = new MemoryProfileRepo();
  if (opts.linked !== false) {
    await profiles.linkGitHub(ken.id, {
      id: 1,
      login: 'kenhayward',
      avatarUrl: 'https://avatars.example/1',
      tokenEnc: encryptSecret(TOKEN, keys),
    });
  }
  const ctx = await testApp({ githubRepos: github, githubSync, profiles, llmSecrets: keys });
  await ctx.templates.create('invoice', 1, invoice(1), 'draft');
  if (opts.publish !== false) await ctx.templates.publish('invoice', 1, 'Ken Hayward');
  const deps = ctx.app.deps;
  const push = (version = 1, user = ken) =>
    pushVersion(deps, { typeId: 'invoice', version, user, origin: ORIGIN });
  return { ...ctx, github, githubSync, profiles, deps, push };
}

const v = (n: number) => `${ROOT}/production/invoice/v${n}.yaml`;
const INSTANCE = `${ROOT}/production/instance.yaml`;

/** The paths a commit changed against its parent. */
function changedPaths(github: FakeGitHubRepos, index: number): string[] {
  const commit = github.commits[index]!;
  const before = github.commits.find((c) => c.sha === commit.parent)?.files;
  return [...commit.files]
    .filter(([path, content]) => before?.get(path) !== content)
    .map(([path]) => path)
    .sort();
}

describe('recipe file', () => {
  it('hashes like git and GitHub: sha1 of `blob <bytes>\\0<content>`', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    // Byte length, not string length.
    expect(gitBlobSha('é\n')).toBe(fakeBlobSha('é\n'));
    expect(fakeBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('hashes the definition without id and version', () => {
    expect(definitionSha256(invoice(1))).toBe(definitionSha256(invoice(7)));
    expect(definitionSha256(invoice(1))).toMatch(/^[0-9a-f]{64}$/);
    expect(definitionSha256({ ...invoice(1), name: 'Other' })).not.toBe(
      definitionSha256(invoice(1)),
    );
    expect(definitionCanonical(invoice(1))).not.toContain('"version"');
  });

  it('writes the wrapper keys in order and reads it back', async () => {
    const ctx = await setup();
    const record = (await ctx.templates.get('invoice', 1))!;
    const file = recipeFileFor(
      record,
      { instanceName: 'production' },
      { basedOn: null, importedFrom: null },
    );
    const text = recipeFileYaml(file);
    expect(Object.keys(parseYaml(text) as object)).toEqual([
      'format',
      'formatVersion',
      'instance',
      'version',
      'definition',
    ]);
    expect(Object.keys(file.version)).toEqual([
      'number',
      'status',
      'label',
      'note',
      'labelSetBy',
      'labelSetAt',
      'publishedBy',
      'publishedAt',
      'basedOn',
      'importedFrom',
      'definitionSha256',
    ]);
    expect(file.version).toMatchObject({
      number: 1,
      status: 'published',
      publishedBy: 'Ken Hayward',
      publishedAt: record.publishedAt,
      definitionSha256: definitionSha256(record.definition),
    });
    expect(file.definition).toEqual(record.definition);
    expect(parseRecipeFile(text)).toEqual(file);
  });

  it.each([
    ['not: [valid', /not valid YAML/],
    ['- a list', /not a CT Studio recipe file/],
    ['format: other\nformatVersion: 1\n', /not a CT Studio recipe file/],
    [
      'format: ct-recipe\nformatVersion: 2\ninstance: x\nversion: {}\ndefinition: {}\n',
      /formatVersion 2 is not supported/,
    ],
    ['format: ct-recipe\nformatVersion: 1\ninstance: x\n', /version/],
  ])('refuses %j', (text, error) => {
    const parsed = parseRecipeFile(text);
    expect(parsed).toHaveProperty('error');
    expect((parsed as { error: string }).error).toMatch(error);
  });

  it('labelSha changes with the label, note or who set them', () => {
    const base = { label: 'A', note: null, labelSetBy: 'Ken', labelSetAt: '2026-01-01T00:00:00Z' };
    expect(labelSha(base)).toBe(labelSha({ ...base }));
    for (const over of [{ label: 'B' }, { note: 'n' }, { labelSetBy: 'X' }, { labelSetAt: null }]) {
      expect(labelSha({ ...base, ...over })).not.toBe(labelSha(base));
    }
  });
});

describe('userToken', () => {
  it('decrypts the linked token, else not_linked', async () => {
    const ctx = await setup();
    expect(await userToken(ctx.deps, ken.id)).toBe(TOKEN);
    expect(await userToken(ctx.deps, 'someone-else')).toBe('not_linked');
    expect(await userToken({ ...ctx.deps, llmSecrets: null }, ken.id)).toBe('not_linked');
  });
});

describe('pushVersion', () => {
  it('first push writes instance.yaml and v1.yaml in one commit', async () => {
    const ctx = await setup();
    await ctx.templates.setLabel('invoice', 1, { label: 'Q3 supplier layout' }, 'Ken Hayward');
    const out = await ctx.push();
    expect(ctx.github.commits).toHaveLength(1);
    const commit = ctx.github.commits[0]!;
    expect(out).toEqual({
      kind: 'pushed',
      commit: commit.sha,
      commitUrl: `https://github.com/${REPO}/commit/${commit.sha}`,
    });
    expect(commit.message).toBe('invoice v1: Q3 supplier layout (CT Studio production)');
    expect(commit.token).toBe(TOKEN);
    expect(changedPaths(ctx.github, 0)).toEqual([INSTANCE, v(1)].sort());
    const files = ctx.github.files(REPO, 'main');
    const settings = await ctx.githubSync.settings();
    expect(parseYaml(files[INSTANCE]!)).toEqual({
      instanceId: settings.instanceId,
      name: 'production',
      url: ORIGIN,
    });
    const record = (await ctx.templates.get('invoice', 1))!;
    expect(files[v(1)]).toBe(
      recipeFileYaml(
        recipeFileFor(
          record,
          { instanceName: 'production' },
          { basedOn: null, importedFrom: null },
        ),
      ),
    );
    const [pushed] = await ctx.githubSync.pushes('invoice');
    expect(pushed).toMatchObject({
      typeId: 'invoice',
      version: 1,
      repo: REPO,
      branch: 'main',
      path: v(1),
      commit: commit.sha,
      blobSha: fakeBlobSha(files[v(1)]!),
      labelSha: labelSha(record),
      prNumber: null,
      prUrl: null,
      prState: null,
      pushedBy: 'Ken Hayward',
    });
    expect(settings.firstPushedAt).not.toBeNull();
  });

  it('names the version without a label in the commit message', async () => {
    const ctx = await setup();
    await ctx.push();
    expect(ctx.github.commits[0]!.message).toBe('invoice v1 (CT Studio production)');
  });

  it('a second push of v2 writes only v2.yaml, based on v1', async () => {
    const ctx = await setup();
    await ctx.push();
    await createNextDraft(ctx.templates, 'invoice', 1, 'Ken Hayward');
    await ctx.templates.publish('invoice', 2, 'Ken Hayward');
    const out = await ctx.push(2);
    expect(out.kind).toBe('pushed');
    expect(changedPaths(ctx.github, 1)).toEqual([v(2)]);
    const file = parseRecipeFile(ctx.github.files(REPO, 'main')[v(2)]!);
    expect(file).toMatchObject({ version: { number: 2, basedOn: 1 } });
  });

  it('refuses a folder that belongs to another deployment', async () => {
    const ctx = await setup();
    ctx.github.seed(REPO, 'main', {
      [INSTANCE]: 'instanceId: 00000000-0000-0000-0000-000000000000\nname: production\n',
    });
    const err = await ctx.push().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncConflict);
    expect((err as Error).message).toBe(
      '`production` in this repo belongs to another CT Studio deployment',
    );
    expect(ctx.github.commits).toHaveLength(0);
    expect(await ctx.githubSync.pushes('invoice')).toEqual([]);
  });

  it('a label change after the push re-pushes only the version block', async () => {
    const ctx = await setup();
    await ctx.push();
    const before = ctx.github.files(REPO, 'main')[v(1)]!;
    const labelled = (await ctx.templates.setLabel(
      'invoice',
      1,
      { label: 'Q3', note: 'Adds remittance' },
      'Ken Hayward',
    ))!;
    const out = await ctx.push();
    expect(out.kind).toBe('pushed');
    expect(ctx.github.commits).toHaveLength(2);
    expect(changedPaths(ctx.github, 1)).toEqual([v(1)]);
    expect(ctx.github.commits[1]!.message).toBe('invoice v1: Q3 (CT Studio production)');
    const after = ctx.github.files(REPO, 'main')[v(1)]!;
    const a = parseYaml(before) as Record<string, unknown>;
    const b = parseYaml(after) as Record<string, Record<string, unknown>>;
    expect({ ...b, version: undefined }).toEqual({ ...a, version: undefined });
    expect(b.version).toEqual({
      ...(a.version as object),
      label: 'Q3',
      note: 'Adds remittance',
      labelSetBy: 'Ken Hayward',
      labelSetAt: labelled.labelSetAt,
    });
    const [pushed] = await ctx.githubSync.pushes('invoice');
    // The state is `on` again: the recorded label and blob are the current ones.
    expect(pushed!.labelSha).toBe(labelSha(labelled));
    expect(pushed!.blobSha).toBe(fakeBlobSha(after));
    expect(pushed!.commit).toBe(ctx.github.commits[1]!.sha);
  });

  it('a repeat push with nothing changed writes nothing', async () => {
    const ctx = await setup();
    const first = await ctx.push();
    const again = await ctx.push();
    expect(again).toEqual(first);
    expect(ctx.github.commits).toHaveLength(1);
  });

  it('refuses a file edited on GitHub since the push', async () => {
    const ctx = await setup();
    await ctx.push();
    const text = ctx.github.files(REPO, 'main')[v(1)]!;
    ctx.github.seed(REPO, 'main', { [v(1)]: `${text}# edited on GitHub\n` });
    await ctx.templates.setLabel('invoice', 1, { label: 'New' }, 'Ken Hayward');
    const err = await ctx.push().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncConflict);
    expect((err as Error).message).toBe('changed on GitHub: pull first');
    expect(ctx.github.commits).toHaveLength(1);
  });

  it('refuses a different recipe under the same version on GitHub', async () => {
    const ctx = await setup();
    const other = recipeFileFor(
      { ...(await ctx.templates.get('invoice', 1))!, definition: { ...invoice(1), name: 'Other' } },
      { instanceName: 'production' },
      { basedOn: null, importedFrom: null },
    );
    ctx.github.seed(REPO, 'main', { [v(1)]: recipeFileYaml(other) });
    const err = await ctx.push().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncConflict);
    expect((err as Error).message).toBe('v1 on GitHub is a different recipe: see Pull');
  });

  it('records an identical file already on GitHub without writing', async () => {
    const ctx = await setup();
    const record = (await ctx.templates.get('invoice', 1))!;
    const text = recipeFileYaml(
      recipeFileFor(record, { instanceName: 'production' }, { basedOn: null, importedFrom: null }),
    );
    const settings = await ctx.githubSync.settings();
    const head = ctx.github.seed(REPO, 'main', {
      [INSTANCE]: `instanceId: ${settings.instanceId}\nname: production\n`,
      [v(1)]: text,
    });
    const out = await ctx.push();
    expect(out).toEqual({
      kind: 'pushed',
      commit: head,
      commitUrl: `https://github.com/${REPO}/commit/${head}`,
    });
    expect(ctx.github.commits).toHaveLength(0);
    expect((await ctx.githubSync.pushes('invoice'))[0]).toMatchObject({
      commit: head,
      blobSha: fakeBlobSha(text),
    });
  });

  it('opens a pull request when main is protected', async () => {
    const ctx = await setup();
    ctx.github.protect(REPO, 'main');
    const out = await ctx.push();
    const [pull] = ctx.github.pulls(REPO);
    expect(pull).toMatchObject({
      head: 'ct-studio/production/invoice-v1',
      base: 'main',
      title: 'invoice v1 (CT Studio production)',
    });
    expect(out).toEqual({ kind: 'pr', prNumber: pull!.number, prUrl: pull!.url });
    const files = ctx.github.files(REPO, 'ct-studio/production/invoice-v1');
    expect(Object.keys(files)).toEqual(expect.arrayContaining([INSTANCE, v(1)]));
    expect(ctx.github.files(REPO, 'main')[v(1)]).toBeUndefined();
    expect((await ctx.githubSync.pushes('invoice'))[0]).toMatchObject({
      branch: 'ct-studio/production/invoice-v1',
      prNumber: pull!.number,
      prUrl: pull!.url,
      prState: 'open',
    });
  });

  it('alwaysPr opens a pull request even when main is not protected', async () => {
    const ctx = await setup({ link: { alwaysPr: true } });
    const out = await ctx.push();
    expect(out.kind).toBe('pr');
    expect(ctx.github.branches(REPO)).toContain('ct-studio/production/invoice-v1');
    expect(ctx.github.files(REPO, 'main')[v(1)]).toBeUndefined();
  });

  it.each([
    ['a type with no link', { link: null }, '`invoice` is not linked to a GitHub repository'],
    [
      'a draft version',
      { publish: false },
      'v1 is not published: only published versions are pushed',
    ],
    ['no linked account', { linked: false }, 'Link your GitHub account in Profile to push.'],
    [
      'a read-only account',
      { permission: 'read' as const },
      `Your GitHub account can read ${REPO} but not push to it.`,
    ],
  ])('skips %s', async (_name, opts, reason) => {
    const ctx = await setup(opts);
    expect(await ctx.push()).toEqual({ kind: 'skipped', reason });
    expect(ctx.github.commits).toHaveLength(0);
    expect(await ctx.githubSync.pushes('invoice')).toEqual([]);
    expect((await ctx.githubSync.settings()).firstPushedAt).toBeNull();
  });

  it('skips when the deployment has no GitHub sync', async () => {
    const ctx = await setup();
    const out = await pushVersion(
      { ...ctx.deps, githubRepos: null },
      { typeId: 'invoice', version: 1, user: ken, origin: ORIGIN },
    );
    expect(out.kind).toBe('skipped');
  });

  it('a revoked token fails with the relink message and records nothing', async () => {
    const ctx = await setup();
    ctx.github.revoked.add(TOKEN);
    expect(await ctx.push()).toEqual({
      kind: 'failed',
      reason: 'GitHub no longer accepts this link: link the account again in Profile',
    });
    expect(await ctx.githubSync.pushes('invoice')).toEqual([]);
    expect((await ctx.githubSync.settings()).firstPushedAt).toBeNull();
  });

  it('a token revoked between reading and committing fails and records nothing', async () => {
    const ctx = await setup();
    // The branch moves and the token is revoked mid-push: the retry's reads get the 401.
    ctx.github.beforeRefUpdate = () => {
      ctx.github.revoked.add(TOKEN);
      ctx.github.seed(REPO, 'main', { 'README.md': 'moved' });
    };
    const out = await ctx.push();
    expect(out.kind).toBe('failed');
    expect(await ctx.githubSync.pushes('invoice')).toEqual([]);
  });

  it('retries once on a new head when the branch moved, keeping both files', async () => {
    const ctx = await setup();
    await createNextDraft(ctx.templates, 'invoice', 1, 'Ken Hayward');
    await ctx.templates.publish('invoice', 2, 'Ken Hayward');
    // Both pushes read the same head; the second's ref update is not a fast-forward.
    const [a, b] = await Promise.all([ctx.push(1), ctx.push(2)]);
    expect(a.kind).toBe('pushed');
    expect(b.kind).toBe('pushed');
    const files = ctx.github.files(REPO, 'main');
    expect(files[v(1)]).toBeDefined();
    expect(files[v(2)]).toBeDefined();
    expect(files[INSTANCE]).toBeDefined();
    expect(ctx.github.commits).toHaveLength(2);
    expect(await ctx.githubSync.pushes('invoice')).toHaveLength(2);
  });

  it('a head moved by another push between read and ref update is retried on top of it', async () => {
    const ctx = await setup();
    let raced = false;
    ctx.github.beforeRefUpdate = () => {
      if (raced) return;
      raced = true;
      ctx.github.seed(REPO, 'main', { [v(9)]: 'another push' });
    };
    const out = await ctx.push();
    expect(out.kind).toBe('pushed');
    const files = ctx.github.files(REPO, 'main');
    expect(files[v(9)]).toBe('another push');
    expect(files[v(1)]).toBeDefined();
  });

  it('gives up after one retry', async () => {
    const ctx = await setup();
    ctx.github.beforeRefUpdate = () => {
      ctx.github.seed(REPO, 'main', { [`moved-${Math.random()}`]: 'x' });
    };
    const out = await ctx.push();
    expect(out.kind).toBe('failed');
    expect(await ctx.githubSync.pushes('invoice')).toEqual([]);
  });

  it('a missing branch is a conflict naming it', async () => {
    const ctx = await setup({ defaultBranch: 'trunk' });
    const err = await ctx.push().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncConflict);
    expect((err as Error).message).toBe(`branch main does not exist in ${REPO}`);
  });

  it('a repository the account cannot see is a conflict naming it', async () => {
    const ctx = await setup({ link: { repo: 'acme/gone' } });
    const err = await ctx.push().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncConflict);
    expect((err as Error).message).toBe(
      'acme/gone does not exist on GitHub or your GitHub account cannot see it',
    );
  });
});

describe('pushVersion after the file changed on GitHub', () => {
  it('adopts a file whose label was taken from GitHub, then pushes only the label', async () => {
    const ctx = await setup();
    await ctx.push();
    // Someone labels v1 on GitHub; the label is taken here (who set it reads `GitHub: …`).
    const record = (await ctx.templates.get('invoice', 1))!;
    const edited = recipeFileYaml(
      recipeFileFor(
        { ...record, label: 'Q3', note: 'from GitHub', labelSetBy: 'Bob', labelSetAt: null },
        { instanceName: 'production' },
        { basedOn: null, importedFrom: null },
      ),
    );
    ctx.github.seed(REPO, 'main', { [v(1)]: edited });
    await ctx.templates.setLabel('invoice', 1, { label: 'Q3', note: 'from GitHub' }, 'GitHub: Bob');
    const out = await ctx.push();
    expect(out.kind).toBe('pushed');
    expect(ctx.github.commits).toHaveLength(2);
    expect(ctx.github.commits[1]!.message).toBe('invoice v1: Q3 (CT Studio production)');
    expect(parseRecipeFile(ctx.github.files(REPO, 'main')[v(1)]!)).toMatchObject({
      version: { label: 'Q3', note: 'from GitHub', labelSetBy: 'GitHub: Bob' },
    });
    const [pushed] = await ctx.githubSync.pushes('invoice');
    expect(pushed!.blobSha).toBe(fakeBlobSha(ctx.github.files(REPO, 'main')[v(1)]!));
  });

  it('adopts a commit that landed without its push record, writing nothing', async () => {
    const ctx = await setup();
    await ctx.push();
    const labelled = (await ctx.templates.setLabel('invoice', 1, { label: 'Q3' }, 'Ken'))!;
    // The label push's commit landed on GitHub but recording it failed.
    const text = recipeFileYaml(
      recipeFileFor(
        labelled,
        { instanceName: 'production' },
        { basedOn: null, importedFrom: null },
      ),
    );
    const head = ctx.github.seed(REPO, 'main', { [v(1)]: text });
    const out = await ctx.push();
    expect(out).toEqual({
      kind: 'pushed',
      commit: head,
      commitUrl: `https://github.com/${REPO}/commit/${head}`,
    });
    expect(ctx.github.commits).toHaveLength(1);
    expect((await ctx.githubSync.pushes('invoice'))[0]).toMatchObject({
      commit: head,
      blobSha: fakeBlobSha(text),
      labelSha: labelSha(labelled),
    });
  });

  it('a GitHub that cannot be reached is a failed outcome and records nothing', async () => {
    const ctx = await setup();
    ctx.github.unreachable = true;
    expect(await ctx.push()).toEqual({
      kind: 'failed',
      reason: 'GitHub could not be reached: fetch failed',
    });
    expect(await ctx.githubSync.pushes('invoice')).toEqual([]);
  });
});
