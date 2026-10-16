import {
  DEFAULT_SYNC_ROOT,
  GitHubLinkBodySchema,
  GitHubLinkViewSchema,
  GitHubRepoSchema,
  ID_PATTERN,
  parseRecipePath,
  PushOutcomeSchema,
  RemoteListingSchema,
  RemoteListingViewSchema,
  SyncNameSchema,
  SyncRootSchema,
  VersionLabelBodySchema,
  describeDefinitionChange,
  type RecipeFile,
  type RemoteListingView,
  SyncSettingsBodySchema,
  SyncSettingsViewSchema,
  VersionSyncSchema,
  type VersionSync,
} from '@ih/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { definitionSha256, labelSha } from '../github-sync/file.js';
import {
  ImportConflict,
  ImportInvalid,
  importRecipeFile,
  originOf,
} from '../github-sync/import.js';
import { cannotPush, NOT_LINKED_TO_PUSH, pushVersion, SyncConflict } from '../github-sync/push.js';
import { compareWith, githubAuthor, listRemote, readRemoteVersion } from '../github-sync/remote.js';
import { userToken } from '../github-sync/token.js';
import { error, md, noContent, res } from '../openapi/zod.js';
import { GitHubError, UnauthorizedError } from '../profile/github.js';
import { createNextDraft, pinned } from '../templates/drafts.js';
import type { TemplateRecord } from '../templates/repo.js';
import { RETIRED_DOC, retiredProblem } from '../templates/retirement.js';
import { DRAFT_CHANGED, issuesOf, RecordView } from './templates.js';

const TAGS = ['GitHub'];
const ADMINS_ONLY = error('`admins only`.');
const TYPE_NOT_FOUND = error('`recipe not found`.');
const TypeParams = z.object({ id: z.string().describe('The document type id.') });
const VersionParams = z.object({
  id: z.string().describe('The document type id.'),
  version: z.string().describe('The version number.'),
});

const NOT_LINKED_TO_PULL = 'Link your GitHub account in Profile to pull.';
const PULL_409 =
  '`' +
  NOT_LINKED_TO_PULL +
  '`, the type is not linked to a repository, GitHub is not set up, the branch or repository ' +
  'is gone, or GitHub no longer accepts your link (link the account again in Profile).';
const Commit = z
  .string()
  .regex(/^[0-9a-f]{40,64}$/, 'a full commit sha')
  .describe('The head commit the listing read (`commit` of a listed version).');
const TakeLabelBody = z.object({ commit: Commit }).strict();
const UseAsDraftBody = z
  .object({
    instance: SyncNameSchema.describe('The deployment folder the version is in.'),
    typeId: z
      .string()
      .regex(ID_PATTERN, 'a document type id')
      .describe('The document type folder the version is in (another id may be used).'),
    version: z.number().int().positive().describe('The version number on GitHub.'),
    commit: Commit,
    baseUpdatedAt: z
      .string()
      .datetime()
      .optional()
      .describe('The open draft `updatedAt` the user saw: a draft written since is a 409.'),
  })
  .strict();

const BrowseQuery = z.object({
  repo: z.string().describe('`owner/name`.'),
  branch: z.string().min(1).describe('The branch to read.'),
  root: SyncRootSchema.default(DEFAULT_SYNC_ROOT).describe(
    'The folder recipes are stored under (default `ct-studio`).',
  ),
});
const ImportFromGitHubBody = z
  .object({
    repo: z.string().describe('`owner/name`.'),
    branch: z.string().min(1).describe('The branch the file was listed on.'),
    path: z
      .string()
      .min(1)
      .describe('A listed version `path`: `<root>/<instance>/<type-id>/v<N>.yaml`.'),
    commit: Commit,
    id: z
      .string()
      .regex(ID_PATTERN, 'a document type id')
      .optional()
      .describe("The new type id; default the file's."),
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("The new type name; default the definition's."),
    link: z.boolean().describe('Also link the new type to this repository (admins only).'),
  })
  .strict();

/** A pull's GitHub failure as an answer: what the user must resolve is a 409, the rest a 502. */
function pullFailure(reply: FastifyReply, err: unknown) {
  if (err instanceof SyncConflict || err instanceof UnauthorizedError) {
    return reply.code(409).send({ error: err.message });
  }
  if (err instanceof GitHubError) return reply.code(502).send({ error: err.message });
  throw err;
}

/** The label and note of a file on GitHub as a `setLabel` body; null when not valid here. */
function labelOf(file: RecipeFile) {
  const body = VersionLabelBodySchema.safeParse({
    label: file.version.label,
    note: file.version.note,
  });
  return body.success ? body.data : null;
}

const StatusSchema = z.object({
  link: GitHubLinkViewSchema.nullable().describe('The repository link; null without one.'),
  versions: z.array(VersionSyncSchema).describe('Every version, newest first.'),
  canPush: z.boolean().describe('Whether you can push versions of this type now.'),
  reason: z.string().nullable().describe('Why you cannot push; null when you can.'),
});

/**
 * Recipe sync with GitHub (settings, a type's link and status, pushing a published version).
 * Registered by `registerAccess` beside the profile routes: every GitHub call is the signed-in
 * user's own, so it exists only with access control on.
 */
export function registerGitHubSyncRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  const sync = deps.githubSync;

  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.auth?.role !== 'admin') return reply.code(403).send({ error: 'admins only' });
  };
  const origin = (req: FastifyRequest) => `${req.protocol}://${req.host}`;
  const versionsOf = async (id: string) =>
    (await deps.templates.list()).filter((r) => r.id === id).sort((a, b) => b.version - a.version);
  const withIssues = issuesOf(app);

  /** The GitHub side of a pull: the port, the type's link and the user's own token. */
  const pullFrom = async (req: FastifyRequest, id: string) => {
    const api = deps.githubRepos ?? null;
    if (!api) throw new SyncConflict('GitHub is not set up on this deployment');
    const link = await sync.link(id);
    if (!link) throw new SyncConflict(`\`${id}\` is not linked to a GitHub repository`);
    const token = await userToken(deps, req.auth!.userId);
    if (token === 'not_linked') throw new SyncConflict(NOT_LINKED_TO_PULL);
    return { api, link, token };
  };

  app.get(
    '/api/github/settings',
    {
      preHandler: adminOnly,
      schema: {
        tags: TAGS,
        'x-admin': true,
        operationId: 'getGitHubSyncSettings',
        summary: 'Get the GitHub sync settings',
        description: md`
          This deployment's instance name (the folder it writes under in a repository), its
          instance id, the default repository folder, and whether the name is locked (once
          anything has been pushed).
        `,
        response: { 200: res('The settings.', SyncSettingsViewSchema), 403: ADMINS_ONLY },
      },
    },
    async () => {
      const s = await sync.settings();
      return {
        instanceName: s.instanceName,
        instanceId: s.instanceId,
        defaultRoot: s.defaultRoot,
        locked: s.firstPushedAt !== null,
      };
    },
  );

  app.put(
    '/api/github/settings',
    {
      preHandler: adminOnly,
      schema: {
        tags: TAGS,
        'x-admin': true,
        operationId: 'updateGitHubSyncSettings',
        summary: 'Set the GitHub sync settings',
        description: md`
          Renames this deployment's instance and sets the default repository folder. The name
          is fixed once this deployment has pushed to GitHub; the folder may always change.
        `,
        body: SyncSettingsBodySchema,
        response: {
          200: res('The settings, saved.', SyncSettingsViewSchema),
          400: error('Why a value is refused.'),
          403: ADMINS_ONLY,
          409: error('`the instance name is fixed once this deployment has pushed to GitHub`.'),
        },
      },
    },
    async (req, reply) => {
      const body = SyncSettingsBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const saved = await sync.setSettings(body.data, req.auth?.label ?? 'admin');
      if (saved === 'locked') {
        return reply.code(409).send({
          error: 'the instance name is fixed once this deployment has pushed to GitHub',
        });
      }
      return saved;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/templates/:id/github',
    {
      schema: {
        tags: TAGS,
        operationId: 'getRecipeGitHubStatus',
        summary: "Get a document type's GitHub link and sync status",
        description: md`
          The type's repository link (null without one) and, for every version, newest first,
          whether GitHub has it: \`on\`, \`label\` (its label or note changed since the push),
          \`pr\` (waiting in an open pull request) or \`absent\` (never pushed, a closed pull
          request, and every draft: drafts stay in CT Studio). \`differs\` is reported by Pull
          only. When you have a linked GitHub account, open pull requests are checked and a
          merge shows as \`on\`; if GitHub cannot be reached the stored state is kept.
          \`canPush\` and \`reason\` say whether you can push now and, if not, why.
        `,
        params: TypeParams,
        response: { 200: res('The link and versions.', StatusSchema), 404: TYPE_NOT_FOUND },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const records = await versionsOf(id);
      if (!records.length) return reply.code(404).send({ error: 'recipe not found' });
      const link = await sync.link(id);
      const token = await userToken(deps, req.auth!.userId);
      const api = deps.githubRepos ?? null;

      let pushes = await sync.pushes(id);
      if (link && api && token !== 'not_linked') {
        pushes = await Promise.all(
          pushes.map(async (p) => {
            if (p.prState !== 'open' || p.prNumber === null) return p;
            try {
              const state = await api.pullRequestState(token, p.repo, p.prNumber);
              if (state === p.prState) return p;
              const next = { ...p, prState: state };
              await sync.recordPush(next);
              return next;
            } catch {
              return p; // GitHub unreachable or the token revoked: keep what was stored
            }
          }),
        );
      }

      const versions: VersionSync[] = records.map((r) => {
        const p = pushes.find((x) => x.version === r.version);
        const base = {
          version: r.version,
          commit: p?.commit ?? null,
          commitUrl: p ? `https://github.com/${p.repo}/commit/${p.commit}` : null,
          prNumber: p?.prNumber ?? null,
          prUrl: p?.prUrl ?? null,
          pushedBy: p?.pushedBy ?? null,
          pushedAt: p?.pushedAt ?? null,
        };
        if (!p || r.status !== 'published' || p.prState === 'closed') {
          return { ...base, state: 'absent' };
        }
        if (p.prState === 'open') return { ...base, state: 'pr' };
        return { ...base, state: p.labelSha === labelSha(r) ? 'on' : 'label' };
      });

      let canPush = false;
      let reason: string | null = null;
      if (token === 'not_linked') reason = NOT_LINKED_TO_PUSH;
      else if (!link) reason = `\`${id}\` is not linked to a GitHub repository`;
      else if (!api) reason = 'GitHub is not set up on this deployment';
      else {
        try {
          const permission = await api.permission(token, link.repo);
          if (permission === 'push') canPush = true;
          else if (permission === 'read') reason = cannotPush(link.repo);
          else
            reason = `${link.repo} does not exist on GitHub or your GitHub account cannot see it`;
        } catch (err) {
          if (!(err instanceof GitHubError)) throw err;
          reason = err.message;
        }
      }
      return { link, versions, canPush, reason };
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/templates/:id/github',
    {
      preHandler: adminOnly,
      schema: {
        tags: TAGS,
        'x-admin': true,
        operationId: 'setRecipeGitHubLink',
        summary: 'Link a document type to a GitHub repository',
        description: md`
          Links the type to a repository, branch and folder, and sets whether every push goes
          through a pull request and whether publishing pushes at once. The repository must be
          one your own linked GitHub account can read.
        `,
        params: TypeParams,
        body: GitHubLinkBodySchema,
        response: {
          200: res('The link, saved.', GitHubLinkViewSchema),
          400: error(
            'Why a value is refused, or `owner/name is not a repository your GitHub account can read`.',
          ),
          403: ADMINS_ONLY,
          404: TYPE_NOT_FOUND,
          409: error('`Link your GitHub account in Profile first`, or GitHub is not set up.'),
          502: error('GitHub could not be reached.'),
        },
      },
    },
    async (req, reply) => {
      const body = GitHubLinkBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (!(await versionsOf(req.params.id)).length) {
        return reply.code(404).send({ error: 'recipe not found' });
      }
      const api = deps.githubRepos ?? null;
      if (!api) return reply.code(409).send({ error: 'GitHub is not set up on this deployment' });
      const token = await userToken(deps, req.auth!.userId);
      if (token === 'not_linked') {
        return reply.code(409).send({ error: 'Link your GitHub account in Profile first' });
      }
      try {
        if ((await api.permission(token, body.data.repo)) === 'none') {
          return reply.code(400).send({
            error: `${body.data.repo} is not a repository your GitHub account can read`,
          });
        }
      } catch (err) {
        if (err instanceof GitHubError) return reply.code(502).send({ error: err.message });
        throw err;
      }
      return sync.setLink(req.params.id, body.data, req.auth?.label ?? 'admin');
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/templates/:id/github',
    {
      preHandler: adminOnly,
      schema: {
        tags: TAGS,
        'x-admin': true,
        operationId: 'removeRecipeGitHubLink',
        summary: "Remove a document type's GitHub link",
        description: md`
          Removes the link. Files already in the repository stay there; push records are
          kept, so linking again picks up where it left off.
        `,
        params: TypeParams,
        response: { 204: noContent('Removed (or there was none).'), 403: ADMINS_ONLY },
      },
    },
    async (req, reply) => {
      await sync.removeLink(req.params.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string; version: string } }>(
    '/api/templates/:id/versions/:version/github/push',
    {
      schema: {
        tags: TAGS,
        operationId: 'pushRecipeVersionToGitHub',
        summary: 'Push a published version to GitHub',
        description: md`
          Writes the published version as a YAML file in the type's repository with **your**
          linked GitHub account, as a commit or, when the branch is protected or the link says
          so, a pull request. The answer is a \`pushed\`, \`pr\`, \`skipped\` (nothing to push,
          with the reason, for example no linked account or a draft) or \`failed\` (GitHub
          refused, with the reason) outcome. Pushing again changes only the label and note.
        `,
        params: VersionParams,
        response: {
          200: res('What happened.', PushOutcomeSchema),
          404: TYPE_NOT_FOUND,
          409: error('`changed on GitHub: pull first`, or another conflict to resolve.'),
        },
      },
    },
    async (req, reply) => {
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || !(await deps.templates.get(req.params.id, version))) {
        return reply.code(404).send({ error: 'recipe not found' });
      }
      try {
        return await pushVersion(deps, {
          typeId: req.params.id,
          version,
          user: { id: req.auth!.userId, name: req.auth!.label },
          origin: origin(req),
        });
      } catch (err) {
        if (err instanceof SyncConflict) return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get(
    '/api/github/repos',
    {
      schema: {
        tags: TAGS,
        operationId: 'listReadableGitHubRepos',
        summary: 'List the repositories your GitHub account can read',
        description: md`
          Every repository **your** linked GitHub account can read (private ones too), for
          choosing where to import recipes from. Not admin-only.
        `,
        response: {
          200: res('The repositories, by name.', z.array(GitHubRepoSchema)),
          409: error(
            '`' +
              NOT_LINKED_TO_PULL +
              '`, GitHub is not set up, or GitHub no longer accepts your link.',
          ),
          502: error('GitHub could not be reached.'),
        },
      },
    },
    async (req, reply) => {
      try {
        const api = deps.githubRepos ?? null;
        if (!api) throw new SyncConflict('GitHub is not set up on this deployment');
        const token = await userToken(deps, req.auth!.userId);
        if (token === 'not_linked') throw new SyncConflict(NOT_LINKED_TO_PULL);
        return await api.listRepos(token);
      } catch (err) {
        return pullFailure(reply, err);
      }
    },
  );

  app.get(
    '/api/github/browse',
    {
      schema: {
        tags: TAGS,
        operationId: 'browseGitHubRecipes',
        summary: 'List the recipe versions under a folder of a repository',
        description: md`
          Reads the head of \`branch\` with **your** linked GitHub account and lists every
          recipe version under \`<root>/<instance>/<type-id>/\` there, from any deployment
          (\`mine\` marks this deployment's own). Files that cannot be used are listed in
          \`skipped\` with the reason. Each version's \`commit\` is the head read; send it, with
          its \`path\`, to \`POST /api/github/import\`.
        `,
        querystring: BrowseQuery,
        response: {
          200: res('The versions.', RemoteListingSchema),
          400: error('Zod issues.'),
          409: error(
            '`' +
              NOT_LINKED_TO_PULL +
              '`, the branch or repository is gone, or GitHub no longer accepts your link.',
          ),
          502: error('GitHub could not be reached.'),
        },
      },
    },
    async (req, reply) => {
      const q = BrowseQuery.safeParse(req.query ?? {});
      if (!q.success) return reply.code(400).send({ error: q.error.issues });
      try {
        const token = await userToken(deps, req.auth!.userId);
        if (token === 'not_linked') throw new SyncConflict(NOT_LINKED_TO_PULL);
        return await listRemote(deps, { token, ...q.data });
      } catch (err) {
        return pullFailure(reply, err);
      }
    },
  );

  app.post(
    '/api/github/import',
    {
      schema: {
        tags: TAGS,
        operationId: 'importRecipeFromGitHub',
        summary: 'Import a recipe version from GitHub as a new document type',
        description: md`
          Reads the file at \`path\` (\`<root>/<instance>/<type-id>/v<N>.yaml\`) at \`commit\`
          with **your** linked GitHub account and creates a new document type from it: a v1
          **draft**, never published. \`id\` defaults to the file's type id and \`name\` to the
          definition's name. The file's label and note are copied. An id that exists already is
          a 409 (pull into it from its Versions tab, or import under another id), and so is a
          retired one. With \`link: true\` an admin also links the new type to the repository
          (this repo, branch and root; it pushes each published version, without pull
          requests); for anyone else the type is created and \`linked\` is false.
        `,
        body: ImportFromGitHubBody,
        response: {
          201: res('The new draft.', RecordView.extend({ linked: z.boolean() })),
          400: error('Zod issues, or a path that is not `<root>/<instance>/<type-id>/v<N>.yaml`.'),
          409: error(
            '`<id> already exists: pull into it from its Versions tab, or import under another id`, ' +
              RETIRED_DOC +
              ', the file is missing or not usable at that commit, or ' +
              PULL_409,
          ),
          502: error('GitHub could not be reached.'),
        },
      },
    },
    async (req, reply) => {
      const body = ImportFromGitHubBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { repo, branch, path, commit } = body.data;
      const root = path.split('/').slice(0, -3).join('/');
      const at = SyncRootSchema.safeParse(root).success ? parseRecipePath(root, path) : null;
      if (
        !at ||
        at.draft ||
        !SyncNameSchema.safeParse(at.instance).success ||
        !ID_PATTERN.test(at.typeId)
      ) {
        return reply
          .code(400)
          .send({ error: 'path must be <root>/<instance>/<type-id>/v<N>.yaml' });
      }
      const id = body.data.id ?? at.typeId;
      const by = req.auth?.label ?? null;
      try {
        const retired = await retiredProblem(deps, id);
        if (retired) return reply.code(409).send({ error: retired });
        if ((await versionsOf(id)).length) {
          throw new SyncConflict(
            `${id} already exists: pull into it from its Versions tab, or import under another id`,
          );
        }
        const api = deps.githubRepos ?? null;
        if (!api) throw new SyncConflict('GitHub is not set up on this deployment');
        const token = await userToken(deps, req.auth!.userId);
        if (token === 'not_linked') throw new SyncConflict(NOT_LINKED_TO_PULL);
        const { file } = await readRemoteVersion(api, { token, repo, root, commit }, at);
        const record = await importRecipeFile(deps, file, { id, name: body.data.name, commit, by });
        let linked = false;
        if (body.data.link && req.auth?.role === 'admin') {
          try {
            await sync.setLink(
              id,
              { repo, branch, root, alwaysPr: false, pushOnPublish: true },
              by ?? 'admin',
            );
            linked = true;
          } catch (err) {
            // The draft exists: the import stands, the link can be made from the type's page.
            req.log.error({ err, templateId: id }, 'linking an imported recipe failed');
          }
        }
        req.log.info({ templateId: id, linked }, 'recipe imported from GitHub');
        return reply.code(201).send({ ...(await withIssues(record)), linked });
      } catch (err) {
        if (err instanceof ImportInvalid) return reply.code(400).send({ error: err.message });
        if (err instanceof ImportConflict) return reply.code(409).send({ error: err.message });
        return pullFailure(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/templates/:id/github/remote',
    {
      schema: {
        tags: TAGS,
        operationId: 'listRecipeVersionsOnGitHub',
        summary: "List a document type's versions on GitHub",
        description: md`
          Reads the head of the link's branch with **your** linked GitHub account and lists
          every version of this type there: this deployment's own folder (\`mine\`, found by
          its instance id in \`instance.yaml\`) and the same type id in other deployments'
          folders. Each of this deployment's versions is compared with the version of the
          same number here (\`compare\`): \`same\`, \`label\` (same recipe, the label or note
          differs), \`differs\` (another recipe: published versions never change) or
          \`missing-here\`. Label and note are compared, not who set them or when. Files that
          cannot be used are listed in \`skipped\` with the reason (\`not valid YAML\`, \`not a
CT Studio recipe file\`, \`format version N is not supported\`, \`drafts are not
imported yet\`, \`the file does not match its path\`, also for folder names that
          are not an instance name and a type id). \`commit\` is the head commit read.
        `,
        params: TypeParams,
        response: {
          200: res('The versions on GitHub.', RemoteListingViewSchema),
          404: TYPE_NOT_FOUND,
          409: error(PULL_409),
          502: error('GitHub could not be reached.'),
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const records = await versionsOf(id);
      if (!records.length) return reply.code(404).send({ error: 'recipe not found' });
      try {
        const { link, token } = await pullFrom(req, id);
        const listing = await listRemote(deps, {
          token,
          repo: link.repo,
          branch: link.branch,
          root: link.root,
          typeId: id,
        });
        const view: RemoteListingView = {
          ...listing,
          versions: listing.versions.map((v) => ({
            ...v,
            compare: v.mine
              ? compareWith(
                  v,
                  records.find((r) => r.version === v.version),
                )
              : null,
          })),
        };
        return view;
      } catch (err) {
        return pullFailure(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string; version: string } }>(
    '/api/templates/:id/versions/:version/github/take-label',
    {
      schema: {
        tags: TAGS,
        operationId: 'takeRecipeLabelFromGitHub',
        summary: "Take GitHub's label for a version",
        description: md`
          Sets the version's label and note to those of this deployment's file for it on
          GitHub at \`commit\`, when the recipe there is the same as here. \`labelSetBy\`
          becomes \`GitHub: <name>\`, the name being the file's own \`labelSetBy\` (who set the
          label where it was pushed from; GitHub's commit author is not looked up), or plain
          \`GitHub\` without one. Allowed for retired types.
        `,
        params: VersionParams,
        body: TakeLabelBody,
        response: {
          200: res('The version.', RecordView),
          400: error('Zod issues.'),
          404: TYPE_NOT_FOUND,
          409: error(
            '`vN on GitHub is a different recipe: published versions never change`, the file is ' +
              'missing or not usable at that commit, or ' +
              PULL_409,
          ),
          502: error('GitHub could not be reached.'),
        },
      },
    },
    async (req, reply) => {
      const body = TakeLabelBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { id } = req.params;
      const version = Number(req.params.version);
      const record = Number.isInteger(version) ? await deps.templates.get(id, version) : null;
      if (!record) return reply.code(404).send({ error: 'recipe not found' });
      try {
        const { api, link, token } = await pullFrom(req, id);
        const settings = await sync.settings();
        const { file, instanceId } = await readRemoteVersion(
          api,
          { token, repo: link.repo, root: link.root, commit: body.data.commit },
          { instance: settings.instanceName, typeId: id, version },
        );
        if (instanceId !== settings.instanceId) {
          throw new SyncConflict(
            `\`${settings.instanceName}\` in this repo belongs to another CT Studio deployment`,
          );
        }
        if (
          compareWith(
            { ...file.version, definitionSha256: definitionSha256(file.definition) },
            record,
          ) === 'differs'
        ) {
          throw new SyncConflict(
            `v${version} on GitHub is a different recipe: published versions never change`,
          );
        }
        const label = labelOf(file);
        if (!label) throw new SyncConflict(`the label of v${version} on GitHub is not valid here`);
        const updated = await deps.templates.setLabel(id, version, label, githubAuthor(file));
        if (!updated) return reply.code(404).send({ error: 'recipe not found' });
        req.log.info({ templateId: id, version }, 'label taken from GitHub');
        return await withIssues(updated);
      } catch (err) {
        return pullFailure(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/templates/:id/github/use-as-draft',
    {
      schema: {
        tags: TAGS,
        operationId: 'useGitHubVersionAsDraft',
        summary: 'Use a version on GitHub as the draft',
        description: md`
          Reads \`<root>/<instance>/<typeId>/v<version>.yaml\` at \`commit\` on the type's link
          (any deployment's folder, any type id) and writes its definition into the open draft,
          replacing it, or into the next draft started from the latest version when none is
          open. The definition takes this type's id and the draft's own version number. Logged
          in the draft's change log as an \`import\` change \`Imported from GitHub:
<instance>/<typeId> v<version> @ <short commit>\` (Restore undoes it); the file's
          label and note are copied to the draft (\`labelSetBy\` \`GitHub: <name>\`, as for
          taking a label). Refused for a retired type.
        `,
        params: TypeParams,
        body: UseAsDraftBody,
        response: {
          200: res('The draft.', RecordView),
          400: error('Zod issues.'),
          404: TYPE_NOT_FOUND,
          409: error(
            '`' +
              DRAFT_CHANGED +
              "` when `baseUpdatedAt` is not the open draft's `updatedAt`; " +
              RETIRED_DOC +
              '; the file is missing or not usable at that commit; or ' +
              PULL_409,
          ),
          502: error('GitHub could not be reached.'),
        },
      },
    },
    async (req, reply) => {
      const body = UseAsDraftBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { id } = req.params;
      const { instance, typeId, version, commit, baseUpdatedAt } = body.data;
      const records = await versionsOf(id);
      if (!records.length) return reply.code(404).send({ error: 'recipe not found' });
      const retired = await retiredProblem(deps, id);
      if (retired) return reply.code(409).send({ error: retired });
      const by = req.auth?.label ?? null;
      try {
        const { api, link, token } = await pullFrom(req, id);
        const { file } = await readRemoteVersion(
          api,
          { token, repo: link.repo, root: link.root, commit },
          { instance, typeId, version },
        );
        const label = labelOf(file);
        if (!label) throw new SyncConflict(`the label of v${version} on GitHub is not valid here`);

        let draft: TemplateRecord | undefined = records.find((r) => r.status === 'draft');
        if (draft) {
          if ((baseUpdatedAt ?? draft.updatedAt) !== draft.updatedAt) {
            return reply.code(409).send({ error: DRAFT_CHANGED });
          }
        } else {
          const created = await createNextDraft(deps.templates, id, undefined, by);
          if (created === 'draft-exists') return reply.code(409).send({ error: DRAFT_CHANGED });
          if (created === 'not-found') return reply.code(404).send({ error: 'recipe not found' });
          draft = created;
        }

        const definition = pinned(file.definition, id, draft.version);
        const text = describeDefinitionChange(draft.definition, definition);
        let record: TemplateRecord | null = draft;
        if (text.count > 0) {
          record = await deps.templates.updateDraft(id, draft.version, definition, {
            expectedUpdatedAt: draft.updatedAt,
            change: {
              source: 'import',
              stage: null,
              proposalId: null,
              summary: `Imported from GitHub: ${instance}/${typeId} v${version} @ ${commit.slice(0, 7)}`,
              diff: text.diff,
              by,
            },
          });
          if (!record) return reply.code(409).send({ error: DRAFT_CHANGED });
        }
        record =
          (await deps.templates.setImportedFrom(
            id,
            record.version,
            originOf(file, commit, typeId),
          )) ?? record;
        if (record.label !== (label.label ?? null) || record.note !== (label.note ?? null)) {
          record =
            (await deps.templates.setLabel(id, record.version, label, githubAuthor(file))) ??
            record;
        }
        req.log.info(
          { templateId: id, version: record.version, from: `${instance}/${typeId} v${version}` },
          'draft taken from GitHub',
        );
        return await withIssues(record);
      } catch (err) {
        return pullFailure(reply, err);
      }
    },
  );
}
