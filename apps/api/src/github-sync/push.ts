import {
  instanceFilePath,
  recipeFilePath,
  type GitHubLinkView,
  type PushOutcome,
} from '@ih/shared';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { AppDeps } from '../app.js';
import {
  GitHubError,
  NotFoundError,
  ProtectedBranchError,
  StaleRefError,
  type GitHubRepoApi,
} from '../profile/github.js';
import type { TemplateRecord } from '../templates/repo.js';
import {
  definitionSha256,
  gitBlobSha,
  labelSha,
  parseRecipeFile,
  recipeFileFor,
  recipeFileYaml,
} from './file.js';
import type { SyncSettings, VersionPush } from './repo.js';
import { userToken } from './token.js';

/** A push GitHub's side refuses for a reason the user must resolve (routes answer 409). */
export class SyncConflict extends Error {}

export const NOT_LINKED_TO_PUSH = 'Link your GitHub account in Profile to push.';
export const cannotPush = (repo: string) =>
  `Your GitHub account can read ${repo} but not push to it.`;

const commitUrl = (repo: string, sha: string) => `https://github.com/${repo}/commit/${sha}`;

/** The source version a draft was started from, read from its `started` change. */
async function basedOn(deps: AppDeps, typeId: string, version: number): Promise<number | null> {
  const started = (await deps.templates.listChanges(typeId, version)).find(
    (c) => c.source === 'started',
  );
  const m = started && /\bfrom (?:published )?v(\d+)\b/.exec(started.summary);
  return m ? Number(m[1]) : null;
}

const outcomeOf = (push: VersionPush): PushOutcome =>
  push.prNumber !== null && push.prUrl !== null && push.prState === 'open'
    ? { kind: 'pr', prNumber: push.prNumber, prUrl: push.prUrl }
    : { kind: 'pushed', commit: push.commit, commitUrl: commitUrl(push.repo, push.commit) };

interface Plan {
  head: string;
  /** Files to commit; empty: GitHub already has this version as it is here. */
  files: { path: string; content: string }[];
  /** With nothing to write: the push it already is (recorded, or found on GitHub). */
  existing: VersionPush | null;
}

interface Job {
  api: GitHubRepoApi;
  token: string;
  link: GitHubLinkView;
  settings: SyncSettings;
  record: TemplateRecord;
  previous: VersionPush | null;
  path: string;
  content: string;
  blobSha: string;
  labelSha: string;
  origin: string;
  user: { id: string; name: string };
}

async function headOf(job: Job, branch: string): Promise<string> {
  try {
    return await job.api.head(job.token, job.link.repo, branch);
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new SyncConflict(`branch ${branch} does not exist in ${job.link.repo}`);
    }
    throw err;
  }
}

const sameLabel = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  (['label', 'note', 'labelSetBy', 'labelSetAt'] as const).every((k) => a[k] === b[k]);

/** Reads the branch and decides what to write. */
async function plan(job: Job): Promise<Plan> {
  const { api, token, link, settings, record, previous } = job;
  const head = await headOf(job, link.branch);
  const files: Plan['files'] = [];

  const instancePath = instanceFilePath(link.root, settings.instanceName);
  const instance = await api.readFile(token, link.repo, head, instancePath);
  if (instance) {
    let id: unknown;
    try {
      id = (parseYaml(instance.content) as { instanceId?: unknown } | null)?.instanceId;
    } catch {
      id = undefined;
    }
    if (id !== settings.instanceId) {
      throw new SyncConflict(
        `\`${settings.instanceName}\` in this repo belongs to another CT Studio deployment`,
      );
    }
  } else {
    files.push({
      path: instancePath,
      content: toYaml(
        { instanceId: settings.instanceId, name: settings.instanceName, url: job.origin },
        { lineWidth: 100 },
      ),
    });
  }

  const tracked = previous?.repo === link.repo && previous.path === job.path ? previous : null;
  let current = await api.readFile(token, link.repo, head, job.path);
  let currentCommit = head;
  if (!current && tracked && tracked.branch !== link.branch && tracked.prState === 'open') {
    // Not merged yet: the version lives on its pull request's branch.
    try {
      currentCommit = await api.head(token, link.repo, tracked.branch);
      current = await api.readFile(token, link.repo, currentCommit, job.path);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }
  if (!current) {
    files.push({ path: job.path, content: job.content });
    return { head, files, existing: null };
  }
  if (tracked && current.blobSha !== tracked.blobSha) {
    throw new SyncConflict('changed on GitHub: pull first');
  }
  const remote = parseRecipeFile(current.content);
  if (
    'error' in remote ||
    definitionSha256(remote.definition) !== definitionSha256(record.definition)
  ) {
    throw new SyncConflict(`v${record.version} on GitHub is a different recipe: see Pull`);
  }
  if (!sameLabel(remote.version, record)) {
    files.push({ path: job.path, content: job.content });
    return { head, files, existing: null };
  }
  if (files.length) {
    // Only instance.yaml is missing (the folder was cleaned up): put it back.
    return { head, files, existing: null };
  }
  return {
    head,
    files,
    existing: tracked ?? {
      typeId: record.id,
      version: record.version,
      repo: link.repo,
      branch: link.branch,
      path: job.path,
      commit: currentCommit,
      blobSha: current.blobSha,
      labelSha: job.labelSha,
      prNumber: null,
      prUrl: null,
      prState: null,
      pushedBy: job.user.name,
      pushedAt: new Date().toISOString(),
    },
  };
}

function commitMessage(record: TemplateRecord, instance: string) {
  const label = record.label ? `: ${record.label}` : '';
  return `${record.id} v${record.version}${label} (CT Studio ${instance})`;
}

/** Writes the plan directly, or through a branch and pull request. */
async function write(job: Job, p: Plan): Promise<VersionPush> {
  const { api, token, link, settings, record } = job;
  const message = commitMessage(record, settings.instanceName);
  const base = {
    typeId: record.id,
    version: record.version,
    repo: link.repo,
    path: job.path,
    blobSha: job.blobSha,
    labelSha: job.labelSha,
    pushedBy: job.user.name,
  };
  if (!link.alwaysPr) {
    try {
      const commit = await api.commit(token, {
        repo: link.repo,
        branch: link.branch,
        parent: p.head,
        files: p.files,
        message,
      });
      return {
        ...base,
        branch: link.branch,
        commit,
        prNumber: null,
        prUrl: null,
        prState: null,
        pushedAt: new Date().toISOString(),
      };
    } catch (err) {
      if (!(err instanceof ProtectedBranchError)) throw err;
    }
  }
  const branch = `ct-studio/${settings.instanceName}/${record.id}-v${record.version}`;
  await api.createBranch(token, link.repo, branch, p.head);
  const parent = await api.head(token, link.repo, branch);
  const commit = await api.commit(token, {
    repo: link.repo,
    branch,
    parent,
    files: p.files,
    message,
  });
  const pr = await api.openPullRequest(token, {
    repo: link.repo,
    head: branch,
    base: link.branch,
    title: message,
    body:
      `Pushed from CT Studio \`${settings.instanceName}\` (${job.origin}) by ${job.user.name}: ` +
      `\`${record.id}\` v${record.version}${record.label ? ` (${record.label})` : ''}.`,
  });
  return {
    ...base,
    branch,
    commit,
    prNumber: pr.number,
    prUrl: pr.url,
    prState: 'open',
    pushedAt: new Date().toISOString(),
  };
}

/**
 * Pushes a published version to its type's GitHub link with the user's own token: one commit
 * (the version file and, the first time, `instance.yaml`), direct or through a pull request.
 * Throws `SyncConflict` for what the user must resolve; GitHub failures are `failed` outcomes,
 * and nothing is recorded for them.
 */
export async function pushVersion(
  deps: AppDeps,
  args: { typeId: string; version: number; user: { id: string; name: string }; origin: string },
): Promise<PushOutcome> {
  const { typeId, version, user, origin } = args;
  const api = deps.githubRepos;
  if (!api) return { kind: 'skipped', reason: 'GitHub is not set up on this deployment' };
  const link = await deps.githubSync.link(typeId);
  if (!link) {
    return { kind: 'skipped', reason: `\`${typeId}\` is not linked to a GitHub repository` };
  }
  const record = await deps.templates.get(typeId, version);
  if (!record) return { kind: 'skipped', reason: `${typeId} v${version} does not exist` };
  if (record.status !== 'published') {
    return {
      kind: 'skipped',
      reason: `v${version} is not published: only published versions are pushed`,
    };
  }
  const token = await userToken(deps, user.id);
  if (token === 'not_linked') return { kind: 'skipped', reason: NOT_LINKED_TO_PUSH };

  try {
    const permission = await api.permission(token, link.repo);
    if (permission === 'none') {
      throw new SyncConflict(
        `${link.repo} does not exist on GitHub or your GitHub account cannot see it`,
      );
    }
    if (permission === 'read') return { kind: 'skipped', reason: cannotPush(link.repo) };

    const settings = await deps.githubSync.settings();
    const file = recipeFileFor(record, settings, {
      basedOn: await basedOn(deps, typeId, version),
      importedFrom: null,
    });
    const content = recipeFileYaml(file);
    const previous =
      (await deps.githubSync.pushes(typeId)).find((p) => p.version === version) ?? null;
    const job: Job = {
      api,
      token,
      link,
      settings,
      record,
      previous,
      path: recipeFilePath(link.root, settings.instanceName, typeId, version),
      content,
      blobSha: gitBlobSha(content),
      labelSha: labelSha(record),
      origin,
      user,
    };

    for (let attempt = 0; ; attempt++) {
      const p = await plan(job);
      if (p.files.length === 0) {
        const existing = p.existing!;
        if (existing !== previous) await deps.githubSync.recordPush(existing);
        return outcomeOf(existing);
      }
      try {
        const pushed = await write(job, p);
        await deps.githubSync.recordPush(pushed);
        await deps.githubSync.markPushed();
        return outcomeOf(pushed);
      } catch (err) {
        // Another push moved the branch: read it again and retry once on top of it.
        if (err instanceof StaleRefError && attempt === 0) continue;
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof GitHubError) return { kind: 'failed', reason: err.message };
    throw err;
  }
}
