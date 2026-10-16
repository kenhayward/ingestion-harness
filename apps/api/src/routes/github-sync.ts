import {
  GitHubLinkBodySchema,
  GitHubLinkViewSchema,
  PushOutcomeSchema,
  SyncSettingsBodySchema,
  SyncSettingsViewSchema,
  VersionSyncSchema,
  type VersionSync,
} from '@ih/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { labelSha } from '../github-sync/file.js';
import { cannotPush, NOT_LINKED_TO_PUSH, pushVersion, SyncConflict } from '../github-sync/push.js';
import { userToken } from '../github-sync/token.js';
import { error, md, noContent, res } from '../openapi/zod.js';
import { GitHubError } from '../profile/github.js';

const TAGS = ['GitHub'];
const ADMINS_ONLY = error('`admins only`.');
const TYPE_NOT_FOUND = error('`recipe not found`.');
const TypeParams = z.object({ id: z.string().describe('The document type id.') });
const VersionParams = z.object({
  id: z.string().describe('The document type id.'),
  version: z.string().describe('The version number.'),
});

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
}
