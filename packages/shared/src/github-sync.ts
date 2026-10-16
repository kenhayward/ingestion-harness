import { z } from 'zod';
import { stableJson } from './drafting.js';
import { githubRepoProblem } from './profile.js';

/**
 * Syncing recipe versions with GitHub: the file a published version is stored as, where it lives
 * in the repository, and the shapes the sync routes speak. Pure and browser-safe: the API hashes
 * `definitionCanonical` with node:crypto.
 */
export const RECIPE_FILE_FORMAT = 'ct-recipe';
export const RECIPE_FILE_VERSION = 1;
export const DEFAULT_SYNC_ROOT = 'ct-studio';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** An instance name: one path segment of lower-case letters, digits and hyphens. */
export const SyncNameSchema = z
  .string()
  .regex(
    NAME_PATTERN,
    'use lower-case letters, digits and hyphens, starting with a letter or digit',
  )
  .describe('Lower-case letters, digits and hyphens, up to 63 characters.');

/** A folder in the repository: one or more name segments joined by `/`. */
export const SyncRootSchema = z
  .string()
  .refine((v) => v.split('/').every((s) => NAME_PATTERN.test(s)), {
    message: 'use lower-case names joined by /, with no leading or trailing slash',
  })
  .describe('A folder: lower-case names joined by `/`, for example `ct-studio` or `data/ct`.');

const RepoName = z
  .string()
  .refine((v) => githubRepoProblem(v) === null, 'name the repository as owner/name')
  .describe('`owner/name`.');

export const RecipeFileSchema = z
  .object({
    format: z.literal(RECIPE_FILE_FORMAT),
    formatVersion: z.literal(RECIPE_FILE_VERSION),
    instance: SyncNameSchema.describe('The CT Studio deployment that wrote the file.'),
    version: z
      .object({
        number: z.number().int().positive(),
        status: z.string(),
        label: z.string().nullable(),
        note: z.string().nullable(),
        labelSetBy: z.string().nullable(),
        labelSetAt: z.string().nullable(),
        publishedBy: z.string().nullable(),
        publishedAt: z.string().nullable(),
        basedOn: z.number().int().positive().nullable(),
        importedFrom: z
          .object({
            instance: z.string(),
            typeId: z.string(),
            version: z.number().int().positive(),
            commit: z.string().nullable(),
          })
          .strict()
          .nullable(),
        definitionSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    definition: z.record(z.string(), z.unknown()),
  })
  .strict();
export type RecipeFile = z.infer<typeof RecipeFileSchema>;

/** The text that is hashed: the definition without `id` and `version`, keys in a fixed order. */
export function definitionCanonical(definition: Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...definition };
  delete rest.id;
  delete rest.version;
  return stableJson(rest);
}

export const recipeFilePath = (root: string, instance: string, typeId: string, version: number) =>
  `${root}/${instance}/${typeId}/v${version}.yaml`;

export const instanceFilePath = (root: string, instance: string) =>
  `${root}/${instance}/instance.yaml`;

/** Reads a path under the root as a recipe file; null for anything else. */
export function parseRecipePath(
  root: string,
  path: string,
): { instance: string; typeId: string; version: number; draft: boolean } | null {
  if (!path.startsWith(`${root}/`)) return null;
  const parts = path.slice(root.length + 1).split('/');
  if (parts.length !== 3) return null;
  const [instance, typeId, file] = parts as [string, string, string];
  const m = /^v([1-9]\d*)(\.draft)?\.yaml$/.exec(file);
  if (!m) return null;
  return { instance, typeId, version: Number(m[1]), draft: m[2] !== undefined };
}

const Branch = z.string().trim().min(1).max(250);

export const GitHubLinkBodySchema = z
  .object({
    repo: RepoName,
    branch: Branch.describe('The branch recipes are stored on.'),
    root: SyncRootSchema,
    alwaysPr: z.boolean().describe('Push through a pull request every time.'),
    pushOnPublish: z.boolean().describe('Push each version when it is published.'),
  })
  .strict();
export type GitHubLinkBody = z.infer<typeof GitHubLinkBodySchema>;

export const GitHubLinkViewSchema = GitHubLinkBodySchema.extend({
  setBy: z.string().nullable(),
  setAt: z.string(),
}).strict();
export type GitHubLinkView = z.infer<typeof GitHubLinkViewSchema>;

export const SYNC_STATES = ['on', 'label', 'absent', 'pr', 'differs'] as const;
export const VersionSyncSchema = z.object({
  version: z.number().int().positive(),
  state: z.enum(SYNC_STATES),
  commit: z.string().nullable(),
  commitUrl: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  pushedBy: z.string().nullable(),
  pushedAt: z.string().nullable(),
});
export type VersionSync = z.infer<typeof VersionSyncSchema>;

export const PushOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pushed'), commit: z.string(), commitUrl: z.string() }),
  z.object({ kind: z.literal('pr'), prNumber: z.number().int(), prUrl: z.string() }),
  z.object({ kind: z.literal('skipped'), reason: z.string() }),
  z.object({ kind: z.literal('failed'), reason: z.string() }),
]);
export type PushOutcome = z.infer<typeof PushOutcomeSchema>;

export const SyncSettingsViewSchema = z.object({
  instanceName: SyncNameSchema,
  instanceId: z.string(),
  defaultRoot: SyncRootSchema,
  locked: z
    .boolean()
    .describe('True once anything has been pushed: the name can no longer change.'),
});
export type SyncSettingsView = z.infer<typeof SyncSettingsViewSchema>;

export const SyncSettingsBodySchema = z
  .object({ instanceName: SyncNameSchema, defaultRoot: SyncRootSchema })
  .strict();
export type SyncSettingsBody = z.infer<typeof SyncSettingsBodySchema>;

export const RemoteVersionSchema = z.object({
  instance: z.string(),
  typeId: z.string(),
  version: z.number().int().positive(),
  label: z.string().nullable(),
  note: z.string().nullable(),
  publishedBy: z.string().nullable(),
  publishedAt: z.string().nullable(),
  definitionSha256: z.string(),
  commit: z.string().nullable(),
  path: z.string(),
  mine: z.boolean().describe('Written by this deployment.'),
});
export type RemoteVersion = z.infer<typeof RemoteVersionSchema>;

export const RemoteListingSchema = z.object({
  versions: z.array(RemoteVersionSchema),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type RemoteListing = z.infer<typeof RemoteListingSchema>;

/**
 * How a version this deployment pushed compares with its version of the same number here:
 * `same` (definition, label and note), `label` (same definition, label or note differ),
 * `differs` (another definition: published versions never change) or `missing-here`.
 */
export const REMOTE_COMPARES = ['same', 'label', 'differs', 'missing-here'] as const;
export type RemoteCompare = (typeof REMOTE_COMPARES)[number];

export const RemoteVersionViewSchema = RemoteVersionSchema.extend({
  compare: z
    .enum(REMOTE_COMPARES)
    .nullable()
    .describe("Against this deployment's version of the same number; null for other deployments."),
});
export type RemoteVersionView = z.infer<typeof RemoteVersionViewSchema>;

export const RemoteListingViewSchema = RemoteListingSchema.extend({
  versions: z.array(RemoteVersionViewSchema),
});
export type RemoteListingView = z.infer<typeof RemoteListingViewSchema>;
