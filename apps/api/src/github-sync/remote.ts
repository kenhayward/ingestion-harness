import {
  ID_PATTERN,
  instanceFilePath,
  parseRecipePath,
  recipeFilePath,
  SyncNameSchema,
  type RecipeFile,
  type RemoteCompare,
  type RemoteListing,
  type RemoteVersion,
} from '@ih/shared';
import { parse as parseYaml } from 'yaml';
import type { AppDeps } from '../app.js';
import { NotFoundError, type GitHubRepoApi } from '../profile/github.js';
import type { TemplateRecord } from '../templates/repo.js';
import { definitionSha256, parseRecipeFile } from './file.js';
import { SyncConflict } from './push.js';

export const MISMATCH = 'the file does not match its path';
export const DRAFTS_SKIPPED = 'drafts are not imported yet';

interface Where {
  token: string;
  repo: string;
}

/** The branch's head; a missing branch or repository is a `SyncConflict` naming it. */
export async function branchHead(
  api: GitHubRepoApi,
  where: Where & { branch: string },
): Promise<string> {
  try {
    return await api.head(where.token, where.repo, where.branch);
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new SyncConflict(`branch ${where.branch} does not exist in ${where.repo}`);
    }
    throw err;
  }
}

/** Why a file read from GitHub is not a recipe file it can be used as, in listing words. */
function reasonOf(error: string): string {
  const version = /^formatVersion (.+) is not supported$/.exec(error);
  if (version) return `format version ${version[1]} is not supported`;
  if (error.startsWith('not valid YAML') || error === 'not a CT Studio recipe file') return error;
  return `not a CT Studio recipe file: ${error}`;
}

/** Reads a recipe file at a commit as the file its path says; `{ error }` says why not. */
export function readRecipe(
  text: string,
  at: { instance: string; typeId: string; version: number },
): RecipeFile | { error: string } {
  const file = parseRecipeFile(text);
  if ('error' in file) return { error: reasonOf(file.error) };
  const id = file.definition.id;
  if (
    file.instance !== at.instance ||
    file.version.number !== at.version ||
    (id !== undefined && id !== at.typeId)
  ) {
    return { error: MISMATCH };
  }
  return file;
}

/** The `instanceId` of an `instance.yaml`, or null when it has none (or is not YAML). */
export function instanceIdOf(text: string | null | undefined): string | null {
  if (!text) return null;
  try {
    const id = (parseYaml(text) as { instanceId?: unknown } | null)?.instanceId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/** Who set a label on GitHub, for `labelSetBy` here (the port has no commit-author lookup). */
export const githubAuthor = (file: RecipeFile) =>
  file.version.labelSetBy ? `GitHub: ${file.version.labelSetBy}` : 'GitHub';

/**
 * Every recipe version under `root` on the branch's head (only `<root>/<instance>/<typeId>/`
 * with `typeId`), each marked `mine` when its folder's `instance.yaml` names this deployment's
 * instance id. Anything that is not a usable version file (bad YAML, another format, a draft,
 * content that disagrees with its path) is listed in `skipped` with the reason.
 */
export async function listRemote(
  deps: Pick<AppDeps, 'githubRepos' | 'githubSync'>,
  args: Where & { branch: string; root: string; typeId?: string },
): Promise<RemoteListing> {
  const api = deps.githubRepos;
  if (!api) throw new SyncConflict('GitHub is not set up on this deployment');
  const { token, repo, root, typeId } = args;
  const head = await branchHead(api, args);
  const settings = await deps.githubSync.settings();
  const files = await api.listFiles(token, repo, head, root);

  const instanceIds = new Map<string, Promise<string | null>>();
  const instanceId = (instance: string) => {
    let found = instanceIds.get(instance);
    if (!found) {
      found = api
        .readFile(token, repo, head, instanceFilePath(root, instance))
        .then((f) => instanceIdOf(f?.content));
      instanceIds.set(instance, found);
    }
    return found;
  };

  const versions: RemoteVersion[] = [];
  const skipped: RemoteListing['skipped'] = [];
  await Promise.all(
    files.map(async ({ path }) => {
      const at = parseRecipePath(root, path);
      if (!at) return; // instance.yaml, READMEs and anything else
      if (typeId !== undefined && at.typeId !== typeId) return;
      if (!SyncNameSchema.safeParse(at.instance).success || !ID_PATTERN.test(at.typeId)) {
        skipped.push({ path, reason: MISMATCH });
        return;
      }
      if (at.draft) {
        skipped.push({ path, reason: DRAFTS_SKIPPED });
        return;
      }
      const read = await api.readFile(token, repo, head, path);
      if (!read) return; // listed but gone: nothing to show
      const file = readRecipe(read.content, at);
      if ('error' in file) {
        skipped.push({ path, reason: file.error });
        return;
      }
      versions.push({
        instance: at.instance,
        typeId: at.typeId,
        version: at.version,
        label: file.version.label,
        note: file.version.note,
        publishedBy: file.version.publishedBy,
        publishedAt: file.version.publishedAt,
        definitionSha256: definitionSha256(file.definition),
        commit: head,
        path,
        mine: (await instanceId(at.instance)) === settings.instanceId,
      });
    }),
  );
  versions.sort(
    (a, b) =>
      Number(b.mine) - Number(a.mine) ||
      a.instance.localeCompare(b.instance) ||
      a.typeId.localeCompare(b.typeId) ||
      b.version - a.version,
  );
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { versions, skipped };
}

/**
 * A version this deployment pushed against its version here. Label and note are compared,
 * not who set them or when: taking GitHub's label sets them here (`GitHub: …`, now).
 */
export function compareWith(
  remote: Pick<RemoteVersion, 'definitionSha256' | 'label' | 'note'>,
  here: TemplateRecord | undefined,
): RemoteCompare {
  if (!here) return 'missing-here';
  if (definitionSha256(here.definition) !== remote.definitionSha256) return 'differs';
  return here.label === remote.label && here.note === remote.note ? 'same' : 'label';
}

/** Reads one version file at a commit; a `SyncConflict` when it is missing or not usable. */
export async function readRemoteVersion(
  api: GitHubRepoApi,
  where: Where & { root: string; commit: string },
  at: { instance: string; typeId: string; version: number },
): Promise<{ file: RecipeFile; path: string; instanceId: string | null }> {
  const path = recipeFilePath(where.root, at.instance, at.typeId, at.version);
  const short = where.commit.slice(0, 7);
  let read: { content: string } | null;
  let instance: { content: string } | null;
  try {
    [read, instance] = await Promise.all([
      api.readFile(where.token, where.repo, where.commit, path),
      api.readFile(
        where.token,
        where.repo,
        where.commit,
        instanceFilePath(where.root, at.instance),
      ),
    ]);
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new SyncConflict(`commit ${short} was not found in ${where.repo}`);
    }
    throw err;
  }
  if (!read) throw new SyncConflict(`${path} is not on GitHub at ${short}`);
  const file = readRecipe(read.content, at);
  if ('error' in file) throw new SyncConflict(`${path}: ${file.error}`);
  return { file, path, instanceId: instanceIdOf(instance?.content) };
}
